import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorCode } from '@airdesk/domain';
import { describe, expect, it } from 'vitest';
import { readSetting, writeSetting } from '../src/services/settings';
import { ADMIN, USER_PASSWORD, auditActions, login, ready, tempDir, userWithRoles } from './helpers';

describe('typed settings', () => {
  it('returns defaults, validates writes, and falls back when a stored value is corrupt', async () => {
    const { env, admin } = await ready();
    const db = env.backend.svc.deps.db;
    expect(readSetting(db, 'session.idle_minutes')).toBe(15);
    writeSetting(db, 'session.idle_minutes', 30, admin.userId, 'now');
    expect(readSetting(db, 'session.idle_minutes')).toBe(30);
    expect(() => writeSetting(db, 'session.idle_minutes', 0, admin.userId, 'now')).toThrow();
    expect(() => writeSetting(db, 'aging.buckets', [0, 30, 7], admin.userId, 'now')).toThrow();
    db.prepare(`UPDATE app_setting SET value_json = '"not a number"' WHERE key = 'session.idle_minutes'`).run();
    expect(readSetting(db, 'session.idle_minutes')).toBe(15);
  });

  it('a longer idle timeout setting keeps sessions alive longer', async () => {
    const { env, admin, adminSession } = await ready();
    writeSetting(env.backend.svc.deps.db, 'session.idle_minutes', 60, admin.userId, 'now');
    env.clock.advance(30 * 60_000);
    expect((await env.call('company.get', {}, adminSession)).ok).toBe(true);
  });
});

describe('user administration', () => {
  it('rejects duplicate usernames and unknown roles', async () => {
    const { env, adminSession } = await ready();
    const dup = await env.call('users.create', { username: ADMIN.username.toUpperCase(), displayName: 'x', password: 'temporary pass 12345', roleCodes: ['MANAGER'] }, adminSession);
    expect(!dup.ok && dup.error.code).toBe(ErrorCode.CONFLICT);
    const role = await env.call('users.create', { username: 'someone', displayName: 'x', password: 'temporary pass 12345', roleCodes: ['PILOT'] }, adminSession);
    expect(!role.ok && role.error.code).toBe(ErrorCode.VALIDATION);
  });

  it('admin password reset forces a change, clears lockout and ends live sessions', async () => {
    const { env, adminSession } = await ready();
    const agentSession = await userWithRoles(env, adminSession, 'agent', ['SALES_AGENT']);
    const id = (await env.call<{ id: string; username: string }[]>('users.list', {}, adminSession)).data!.find((u) => u.username === 'agent')!.id;
    for (let i = 0; i < 5; i++) await env.call('auth.login', { username: 'agent', password: `bad guess ${i} xx` });
    const reset = await env.call('users.resetPassword', { userId: id, newPassword: 'fresh temporary 555' }, adminSession);
    expect(reset.ok).toBe(true);
    expect((await env.call('company.get', {}, agentSession)).ok).toBe(false);
    const s = await login(env, 'agent', 'fresh temporary 555');
    const blocked = await env.call('company.get', {}, s);
    expect(!blocked.ok && blocked.error.code).toBe(ErrorCode.PASSWORD_CHANGE_REQUIRED);
    expect(auditActions(env)).toContain('user.password_reset');
    const weakReset = await env.call('users.resetPassword', { userId: id, newPassword: 'short' }, adminSession);
    expect(!weakReset.ok && weakReset.error.code).toBe(ErrorCode.PASSWORD_POLICY);
  });

  it('roles can be edited (except ADMIN) and edits apply immediately', async () => {
    const { env, adminSession } = await ready();
    const agent = await userWithRoles(env, adminSession, 'agent', ['SALES_AGENT']);
    const roles = await env.call<{ id: string; code: string; permissions: string[] }[]>('roles.list', {}, adminSession);
    const sales = roles.data!.find((r) => r.code === 'SALES_AGENT')!;
    expect((await env.call('audit.list', {}, agent)).ok).toBe(false);
    const edit = await env.call('roles.setPermissions', { roleId: sales.id, permissions: [...sales.permissions, 'audit.view'] }, adminSession);
    expect(edit.ok).toBe(true);
    expect((await env.call('audit.list', {}, agent)).ok).toBe(true);
    const perms = await env.call<{ code: string }[]>('permissions.list', {}, adminSession);
    expect(perms.data!.length).toBeGreaterThan(70);
    const missing = await env.call('roles.setPermissions', { roleId: '01J0000000000000000000000A', permissions: [] }, adminSession);
    expect(!missing.ok && missing.error.code).toBe(ErrorCode.NOT_FOUND);
    const dupRole = await env.call('roles.create', { code: 'MANAGER', nameAr: 'x', nameEn: 'x', permissions: [] }, adminSession);
    expect(!dupRole.ok && dupRole.error.code).toBe(ErrorCode.CONFLICT);
  });

  it('a second admin can be disabled while one active admin remains', async () => {
    const { env, adminSession } = await ready();
    await userWithRoles(env, adminSession, 'admin2', ['ADMIN']);
    const id = (await env.call<{ id: string; username: string }[]>('users.list', {}, adminSession)).data!.find((u) => u.username === 'admin2')!.id;
    expect((await env.call('users.setActive', { userId: id, active: false }, adminSession)).ok).toBe(true);
    expect((await env.call('users.setActive', { userId: id, active: true }, adminSession)).ok).toBe(true);
    expect((await env.call('auth.login', { username: 'admin2', password: USER_PASSWORD })).ok).toBe(true);
  });
});

describe('currency & rates', () => {
  it('sets and edits dated rates with audit; base currency cannot get a rate', async () => {
    const { env, adminSession } = await ready();
    expect((await env.call('currency.setRate', { currencyCode: 'USD', rateDate: '2026-09-01', rate: '50.10' }, adminSession)).ok).toBe(true);
    expect((await env.call('currency.setRate', { currencyCode: 'USD', rateDate: '2026-09-01', rate: '50.20' }, adminSession)).ok).toBe(true);
    const base = await env.call('currency.setRate', { currencyCode: 'EGP', rateDate: '2026-09-01', rate: '1' }, adminSession);
    expect(!base.ok && base.error.code).toBe(ErrorCode.VALIDATION);
    const bad = await env.call('currency.setRate', { currencyCode: 'USD', rateDate: '2026-09-02', rate: '-3' }, adminSession);
    expect(!bad.ok && bad.error.code).toBe(ErrorCode.INVALID_RATE);
    const svc = env.backend.svc.currencies;
    expect(svc.rateOn('USD', '2026-09-15')).toBe('50.2');
    expect(svc.rateOn('USD', '2026-08-01')).toBeNull();
    expect(svc.rateOn('EGP', '2026-08-01')).toBe('1');
    expect(auditActions(env)).toEqual(expect.arrayContaining(['rate.created', 'rate.updated']));
    const list = await env.call<{ code: string }[]>('currency.list', {}, adminSession);
    expect(list.data!.map((c) => c.code)).toEqual(expect.arrayContaining(['EGP', 'SAR', 'USD', 'EUR']));
  });
});

describe('failure handling', () => {
  it('a failed backup is recorded as FAILED and audited, never reported as success', async () => {
    const { env, adminSession } = await ready();
    const notADir = join(tempDir(), 'a-file');
    writeFileSync(notADir, 'x');
    const r = await env.call('backup.create', { destinationDir: join(notADir, 'backups') }, adminSession);
    expect(r.ok).toBe(false);
    const list = await env.call<{ status: string }[]>('backup.list', {}, adminSession);
    expect(list.data![0]!.status).toBe('FAILED');
    expect(auditActions(env)).toContain('backup.failed');
  });

  it('unexpected internal errors are logged locally and masked for the client', async () => {
    const { env, adminSession } = await ready();
    env.backend.svc.deps.db.exec('DROP VIEW v_journal');
    const r = await env.call('ledger.summary', { from: '2026-09-01', to: '2026-09-30' }, adminSession);
    expect(!r.ok && r.error.code).toBe(ErrorCode.INTERNAL);
    expect(!r.ok && r.error.message).not.toMatch(/v_journal/);
    expect(env.logger.records.some((x) => x.level === 'error' && /v_journal/.test(String(x.meta?.error)))).toBe(true);
  });

  it('validates date ranges in ledger queries', async () => {
    const { env, adminSession } = await ready();
    const r = await env.call('ledger.summary', { from: '2026-10-01', to: '2026-09-01' }, adminSession);
    expect(!r.ok && r.error.code).toBe(ErrorCode.VALIDATION);
    const tb = await env.call<unknown[]>('ledger.trialBalance', { asOf: '2026-09-30' }, adminSession);
    expect(tb.ok && tb.data!.length).toBe(23);
  });
});
