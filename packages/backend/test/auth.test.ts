import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorCode } from '@airdesk/domain';
import { describe, expect, it } from 'vitest';
import { ADMIN, COMPANY, USER_PASSWORD, auditActions, login, makeBackend, ready, setupCompany, userWithRoles } from './helpers';

describe('first-run setup', () => {
  it('reports setup required, then creates company + admin exactly once', async () => {
    const env = await makeBackend();
    const status = await env.call<{ setupRequired: boolean }>('system.status');
    expect(status.ok && status.data!.setupRequired).toBe(true);
    await setupCompany(env);
    const after = await env.call<{ setupRequired: boolean; companyName: string }>('system.status');
    expect(after.ok && after.data).toMatchObject({ setupRequired: false, companyName: COMPANY.legalNameAr });
    const again = await env.call('system.setup', {
      company: COMPANY,
      admin: { username: 'intruder', displayName: 'x', password: 'another long password', locale: 'en' },
    });
    expect(!again.ok && again.error.code).toBe(ErrorCode.SETUP_ALREADY_DONE);
  });

  it('enforces the password policy on the first admin', async () => {
    const env = await makeBackend();
    const r = await env.call('system.setup', { company: COMPANY, admin: { username: 'owner', displayName: 'o', password: 'short', locale: 'ar' } });
    expect(!r.ok && r.error.code).toBe(ErrorCode.PASSWORD_POLICY);
  });
});

describe('authentication', () => {
  it('stores Argon2id hashes only — the password never appears in the database file', async () => {
    const env = await makeBackend();
    await setupCompany(env);
    const row = env.backend.svc.deps.db.prepare('SELECT password_hash FROM app_user').get() as { password_hash: string };
    expect(row.password_hash.startsWith('$argon2id$')).toBe(true);
    env.backend.svc.deps.db.pragma('wal_checkpoint(TRUNCATE)');
    const bytes = readFileSync(join(env.dataDir, 'airdesk.db'));
    expect(bytes.includes(Buffer.from(ADMIN.password))).toBe(false);
    const audit = env.backend.svc.deps.db.prepare(`SELECT group_concat(coalesce(after_json, '') || coalesce(metadata_json, '')) AS t FROM audit_log`).get() as { t: string };
    expect(audit.t.includes(ADMIN.password)).toBe(false);
  });

  it('logs in, returns permissions, and audits the login', async () => {
    const env = await makeBackend();
    await setupCompany(env);
    const r = await env.call<{ user: { permissions: string[]; roles: string[] } }>('auth.login', ADMIN);
    expect(r.ok).toBe(true);
    expect(r.session && 'set' in r.session).toBe(true);
    expect(r.data!.user.roles).toEqual(['ADMIN']);
    expect(r.data!.user.permissions).toContain('backup.restore');
    expect(auditActions(env)).toContain('auth.login');
  });

  it('rejects wrong passwords and unknown users with the same error, and audits both', async () => {
    const env = await makeBackend();
    await setupCompany(env);
    const bad = await env.call('auth.login', { username: ADMIN.username, password: 'wrong password here' });
    const unknown = await env.call('auth.login', { username: 'nobody', password: 'whatever password' });
    expect(!bad.ok && bad.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(!unknown.ok && unknown.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(!bad.ok && bad.error.message).toBe(!unknown.ok && unknown.error.message);
    expect(auditActions(env).filter((a) => a === 'auth.login_failed')).toHaveLength(2);
  });

  it('locks the account after 5 failures (even for the right password) and unlocks after 15 minutes', async () => {
    const env = await makeBackend();
    await setupCompany(env);
    for (let i = 0; i < 4; i++) {
      const r = await env.call('auth.login', { username: ADMIN.username, password: `wrong ${i} password` });
      expect(!r.ok && r.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    }
    const fifth = await env.call('auth.login', { username: ADMIN.username, password: 'wrong 5 password' });
    expect(!fifth.ok && fifth.error.code).toBe(ErrorCode.ACCOUNT_LOCKED);
    const right = await env.call('auth.login', ADMIN);
    expect(!right.ok && right.error.code).toBe(ErrorCode.ACCOUNT_LOCKED);
    expect(auditActions(env)).toContain('auth.locked');
    env.clock.advance(16 * 60_000);
    expect((await env.call('auth.login', ADMIN)).ok).toBe(true);
  });

  it('expires idle sessions and ends them in the database', async () => {
    const env = await makeBackend();
    await setupCompany(env);
    const s = await login(env);
    expect((await env.call('company.get', {}, s)).ok).toBe(true);
    env.clock.advance(16 * 60_000);
    const r = await env.call('company.get', {}, s);
    expect(!r.ok && r.error.code).toBe(ErrorCode.SESSION_EXPIRED);
    expect(r.session).toEqual({ clear: true });
    const row = env.backend.svc.deps.db.prepare('SELECT end_reason FROM user_session WHERE id = ?').get(s) as { end_reason: string };
    expect(row.end_reason).toBe('IDLE_TIMEOUT');
  });

  it('logout ends the session', async () => {
    const env = await makeBackend();
    await setupCompany(env);
    const s = await login(env);
    const out = await env.call('auth.logout', {}, s);
    expect(out.session).toEqual({ clear: true });
    const r = await env.call('company.get', {}, s);
    expect(!r.ok && r.error.code).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it('forces a new user to change the temporary password before doing anything else', async () => {
    const { env, adminSession } = await ready();
    await env.call('users.create', { username: 'agent1', displayName: 'Agent', password: 'temporary pass 12345', roleCodes: ['SALES_AGENT'] }, adminSession);
    const s = await login(env, 'agent1', 'temporary pass 12345');
    const blocked = await env.call('company.get', {}, s);
    expect(!blocked.ok && blocked.error.code).toBe(ErrorCode.PASSWORD_CHANGE_REQUIRED);
    const weak = await env.call('auth.changePassword', { currentPassword: 'temporary pass 12345', newPassword: 'agent1agent1' }, s);
    expect(!weak.ok && weak.error.code).toBe(ErrorCode.PASSWORD_POLICY);
    const ok = await env.call('auth.changePassword', { currentPassword: 'temporary pass 12345', newPassword: 'a much better secret' }, s);
    expect(ok.ok).toBe(true);
    expect((await env.call('company.get', {}, s)).ok).toBe(true);
  });

  it('disabling a user kicks their live session immediately; disabled users cannot log in', async () => {
    const { env, adminSession } = await ready();
    const agent = await userWithRoles(env, adminSession, 'agent2', ['SALES_AGENT']);
    const users = await env.call<{ id: string; username: string }[]>('users.list', {}, adminSession);
    const id = users.data!.find((u) => u.username === 'agent2')!.id;
    expect((await env.call('users.setActive', { userId: id, active: false }, adminSession)).ok).toBe(true);
    const r = await env.call('company.get', {}, agent);
    expect(!r.ok && r.error.code).toBe(ErrorCode.UNAUTHENTICATED);
    const again = await env.call('auth.login', { username: 'agent2', password: USER_PASSWORD });
    expect(!again.ok && again.error.code).toBe(ErrorCode.ACCOUNT_DISABLED);
  });
});
