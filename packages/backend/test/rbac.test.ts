import { COMMAND_NAMES } from '@airdesk/contracts';
import { ErrorCode } from '@airdesk/domain';
import { describe, expect, it } from 'vitest';
import { HANDLERS, accessOf } from '../src';
import { auditActions, ready, userWithRoles } from './helpers';

describe('command registry', () => {
  it('declares an access rule for every contract command, and only the pre-login ones are public', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual([...COMMAND_NAMES].sort());
    const publicOnes = COMMAND_NAMES.filter((c) => accessOf(c).kind === 'public').sort();
    // vault.* exist only for the launcher (before the data is open); once open they are refused (see encryption tests).
    expect(publicOnes).toEqual(['auth.login', 'system.setup', 'system.status', 'vault.inspectBackup', 'vault.restoreBackup', 'vault.unlock']);
  });

  it('launcher-only commands are refused once the company data is open', async () => {
    const { env } = await ready();
    for (const [command, payload] of [
      ['vault.unlock', { passphrase: 'anything at all' }],
      ['vault.inspectBackup', { filePath: '/tmp/x.adbk' }],
      ['vault.restoreBackup', { filePath: '/tmp/x.adbk', passphrase: 'x', confirmation: 'RESTORE' }],
    ] as const) {
      const r = await env.call(command, payload, null);
      expect(!r.ok && r.error.code, command).toBe('CONFLICT');
    }
  });

  it('does not expose generic ledger posting over the transport', () => {
    expect(COMMAND_NAMES.some((c) => /post|reverse/i.test(c))).toBe(false);
  });

  it('rejects unknown commands and malformed payloads before any handler runs', async () => {
    const { env, adminSession } = await ready();
    const unknown = await env.call('ledger.deleteEverything', {}, adminSession);
    expect(!unknown.ok && unknown.error.code).toBe(ErrorCode.VALIDATION);
    const extra = await env.call('users.create', { username: 'x1x', displayName: 'x', password: 'p', roleCodes: ['ADMIN'], isAdmin: true }, adminSession);
    expect(!extra.ok && extra.error.code).toBe(ErrorCode.VALIDATION);
    const sqlish = await env.call('users.create', { username: "a'; DROP TABLE app_user;--", displayName: 'x', password: 'p', roleCodes: ['ADMIN'] }, adminSession);
    expect(!sqlish.ok && sqlish.error.code).toBe(ErrorCode.VALIDATION);
  });

  it('requires a session for every non-public command', async () => {
    const { env } = await ready();
    for (const c of COMMAND_NAMES.filter((n) => accessOf(n).kind !== 'public')) {
      const r = await env.call(c, {}, null);
      expect(!r.ok && [ErrorCode.UNAUTHENTICATED, ErrorCode.VALIDATION]).toContain(r.ok ? 'OK' : r.error.code);
    }
  });
});

describe('authorization is enforced in the backend (Case M)', () => {
  it('a sales agent is refused admin/financial commands, and every refusal is audited', async () => {
    const { env, adminSession } = await ready();
    const agent = await userWithRoles(env, adminSession, 'agent', ['SALES_AGENT']);
    const attempts: [string, unknown][] = [
      ['company.update', { profile: {}, rowVersion: 1 }],
      ['users.create', { username: 'evil', displayName: 'e', password: 'p', roleCodes: ['ADMIN'] }],
      ['roles.setPermissions', { roleId: '01J0000000000000000000000A', permissions: [] }],
      ['ledger.summary', { from: '2026-09-01', to: '2026-09-30' }],
      ['ledger.trialBalance', { asOf: '2026-09-30' }],
      ['backup.restore', { filePath: 'x.adbk', password: 'p', confirmation: 'RESTORE' }],
      ['company.setLockDate', { lockDate: '2026-09-30' }],
      ['audit.list', {}],
      ['currency.setRate', { currencyCode: 'USD', rateDate: '2026-09-28', rate: '50' }],
    ];
    const before = auditActions(env).filter((a) => a === 'auth.permission_denied').length;
    for (const [command, payload] of attempts) {
      const r = await env.call(command, payload, agent);
      // Either schema validation or authorization stops it — never success.
      expect(r.ok).toBe(false);
    }
    const valid: [string, unknown][] = [
      ['ledger.summary', { from: '2026-09-01', to: '2026-09-30' }],
      ['users.list', {}],
      ['audit.list', {}],
      ['company.setLockDate', { lockDate: '2026-09-30' }],
    ];
    for (const [command, payload] of valid) {
      const r = await env.call(command, payload, agent);
      expect(!r.ok && r.error.code).toBe(ErrorCode.FORBIDDEN);
    }
    const after = auditActions(env).filter((a) => a === 'auth.permission_denied').length;
    expect(after - before).toBeGreaterThanOrEqual(valid.length);
  });

  it('Q5: a sales agent session does not carry cost/profit permissions', async () => {
    const { env, adminSession } = await ready();
    const agent = await userWithRoles(env, adminSession, 'agent', ['SALES_AGENT']);
    const me = await env.call<{ permissions: string[] }>('auth.me', {}, agent);
    expect(me.data!.permissions).toContain('booking.enter_cost');
    expect(me.data!.permissions).not.toContain('booking.view_cost');
    expect(me.data!.permissions).not.toContain('booking.view_profit');
  });

  it('role changes take effect on the very next request', async () => {
    const { env, adminSession } = await ready();
    const agent = await userWithRoles(env, adminSession, 'agent', ['SALES_AGENT']);
    expect((await env.call('ledger.summary', { from: '2026-09-01', to: '2026-09-30' }, agent)).ok).toBe(false);
    const users = await env.call<{ id: string; username: string }[]>('users.list', {}, adminSession);
    const id = users.data!.find((u) => u.username === 'agent')!.id;
    await env.call('users.setRoles', { userId: id, roleCodes: ['SALES_AGENT', 'ACCOUNTANT'] }, adminSession);
    expect((await env.call('ledger.summary', { from: '2026-09-01', to: '2026-09-30' }, agent)).ok).toBe(true);
  });

  it('custom roles are configurable (not hard-coded to four)', async () => {
    const { env, adminSession } = await ready();
    const created = await env.call<{ id: string }>('roles.create', { code: 'AUDITOR', nameAr: 'مراجع', nameEn: 'Auditor', permissions: ['audit.view'] }, adminSession);
    expect(created.ok).toBe(true);
    const auditor = await userWithRoles(env, adminSession, 'aud', ['AUDITOR']);
    expect((await env.call('audit.list', {}, auditor)).ok).toBe(true);
    expect((await env.call('users.list', {}, auditor)).ok).toBe(false);
    const bogus = await env.call('roles.create', { code: 'BAD', nameAr: 'x', nameEn: 'x', permissions: ['booking.delete_everything'] }, adminSession);
    expect(!bogus.ok && bogus.error.code).toBe(ErrorCode.VALIDATION);
  });

  it('the Administrator role cannot be stripped; admins cannot lock themselves out; the last active admin is protected', async () => {
    const { env, adminSession, admin } = await ready();
    const roles = await env.call<{ id: string; code: string }[]>('roles.list', {}, adminSession);
    const adminRole = roles.data!.find((r) => r.code === 'ADMIN')!;
    const strip = await env.call('roles.setPermissions', { roleId: adminRole.id, permissions: [] }, adminSession);
    expect(!strip.ok && strip.error.code).toBe(ErrorCode.VALIDATION);
    // Self-protection (Phase 2 §6): nobody disables themselves or removes their own ADMIN role.
    const disableSelf = await env.call('users.setActive', { userId: admin.userId, active: false }, adminSession);
    expect(!disableSelf.ok && disableSelf.error.details?.reason).toBe('SELF_LOCKOUT');
    const demoteSelf = await env.call('users.setRoles', { userId: admin.userId, roleCodes: ['MANAGER'] }, adminSession);
    expect(!demoteSelf.ok && demoteSelf.error.details?.reason).toBe('SELF_LOCKOUT');
    // Last-admin rule: a non-admin user manager cannot disable the only active admin.
    await env.call('roles.create', { code: 'USER_ADMIN', nameAr: 'مسؤول مستخدمين', nameEn: 'User admin', permissions: ['user.view', 'user.disable'] }, adminSession);
    const userAdmin = await userWithRoles(env, adminSession, 'useradmin', ['USER_ADMIN']);
    const lastAdmin = await env.call('users.setActive', { userId: admin.userId, active: false }, userAdmin);
    expect(!lastAdmin.ok && lastAdmin.error.code).toBe(ErrorCode.LAST_ADMIN);
    expect((await env.call('company.get', {}, adminSession)).ok).toBe(true);
  });
});
