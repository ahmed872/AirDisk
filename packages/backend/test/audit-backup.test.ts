import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync, strFromU8 } from 'fflate';
import { ErrorCode } from '@airdesk/domain';
import { describe, expect, it } from 'vitest';
import { openDatabase, recoverPendingRestore } from '../src';
import { ADMIN, auditActions, count, doc, fixtures, login, ready, tempDir, userWithRoles } from './helpers';

describe('audit log', () => {
  it('records sensitive actions in a hash chain that verifies', async () => {
    const { env, adminSession } = await ready();
    await userWithRoles(env, adminSession, 'agent', ['SALES_AGENT']);
    const actions = auditActions(env);
    for (const a of ['setup.completed', 'user.created', 'auth.login', 'auth.password_changed']) expect(actions).toContain(a);
    const chain = env.backend.svc.deps.audit.verifyChain();
    expect(chain.ok).toBe(true);
    expect(chain.checked).toBe(actions.length);
  });

  it('is append-only, and external tampering is detected by the hash chain', async () => {
    const { env } = await ready();
    const db = env.backend.svc.deps.db;
    expect(() => db.prepare(`UPDATE audit_log SET action = 'x'`).run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    // Simulate an attacker with a SQLite tool who drops the trigger first.
    db.exec('DROP TRIGGER trg_audit_no_update');
    db.prepare(`UPDATE audit_log SET entity_id = 'forged' WHERE seq = 2`).run();
    const chain = env.backend.svc.deps.audit.verifyChain();
    expect(chain).toMatchObject({ ok: false, brokenAtSeq: 2 });
    const report = await env.call<{ ok: boolean; checks: { id: string; ok: boolean }[] }>('integrity.run', {}, await login(env));
    expect(report.data!.ok).toBe(false);
    expect(report.data!.checks.find((c) => c.id === 'INV-9.audit_chain')!.ok).toBe(false);
  });
});

describe('backup & restore (Q12: a backup counts only once restore is proven)', () => {
  it('creates a validated backup and records it', async () => {
    const { env, adminSession } = await ready();
    const r = await env.call<{ filePath: string; sha256: string }>('backup.create', {}, adminSession);
    expect(r.ok).toBe(true);
    expect(existsSync(r.data!.filePath)).toBe(true);
    const list = await env.call<{ status: string; verifiedAt: string | null }[]>('backup.list', {}, adminSession);
    expect(list.data![0]).toMatchObject({ status: 'SUCCEEDED' });
    expect(list.data![0]!.verifiedAt).not.toBeNull();
    expect(auditActions(env)).toContain('backup.created');
  });

  it('round-trips: data after the backup disappears on restore, data before it remains', async () => {
    const { env, adminSession, admin } = await ready();
    const f = fixtures(env, admin.userId);
    const cash = f.moneyAccount();
    const c = f.customer(), b = f.booking(c);
    const before = env.backend.svc.posting.post(admin, doc.receipt(c, b, cash, 111_100));
    const backup = await env.call<{ filePath: string }>('backup.create', {}, adminSession);
    env.backend.svc.posting.post(admin, doc.receipt(c, b, cash, 222_200));
    expect(count(env, 'fin_document')).toBe(2);

    const wrongPw = await env.call('backup.restore', { filePath: backup.data!.filePath, password: 'not my password', confirmation: 'RESTORE' }, adminSession);
    expect(!wrongPw.ok && wrongPw.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);

    const restored = await env.call<{ preRestoreBackup: string }>('backup.restore', { filePath: backup.data!.filePath, password: ADMIN.password, confirmation: 'RESTORE' }, adminSession);
    expect(restored.ok).toBe(true);
    expect(restored.session).toEqual({ clear: true });
    expect(existsSync(restored.data!.preRestoreBackup)).toBe(true);
    // Old session is gone; sign in again against the restored database.
    expect((await env.call('company.get', {}, adminSession)).ok).toBe(false);
    const s2 = await login(env);
    expect(count(env, 'fin_document')).toBe(1);
    expect(env.backend.svc.posting.get(before.id).totalMinor).toBe(111_100);
    expect(auditActions(env)).toContain('backup.restored');
    const integrity = await env.call<{ ok: boolean }>('integrity.run', {}, s2);
    expect(integrity.data!.ok).toBe(true);
  });

  it('rejects a corrupted backup and leaves the current data untouched', async () => {
    const { env, adminSession, admin } = await ready();
    const backup = await env.call<{ filePath: string }>('backup.create', {}, adminSession);
    const files = unzipSync(new Uint8Array(readFileSync(backup.data!.filePath)));
    const dbBytes = files['database.sqlite']!;
    dbBytes[5000] = dbBytes[5000]! ^ 0xff; // flip one byte inside the database
    const corrupted = join(tempDir(), 'corrupted.adbk');
    writeFileSync(corrupted, zipSync({ 'manifest.json': files['manifest.json']!, 'database.sqlite': dbBytes }));
    const r = await env.call('backup.restore', { filePath: corrupted, password: ADMIN.password, confirmation: 'RESTORE' }, adminSession);
    expect(!r.ok && r.error.code).toBe(ErrorCode.BACKUP_INVALID);
    expect((await env.call('company.get', {}, adminSession)).ok).toBe(true); // still logged in, nothing swapped
    expect(env.backend.svc.sessions.resolve(adminSession).userId).toBe(admin.userId);
  });

  it('rejects garbage files and backups from a newer AirDesk', async () => {
    const { env, adminSession } = await ready();
    const junk = join(tempDir(), 'junk.adbk');
    writeFileSync(junk, 'this is not a zip');
    const r1 = await env.call('backup.restore', { filePath: junk, password: ADMIN.password, confirmation: 'RESTORE' }, adminSession);
    expect(!r1.ok && r1.error.code).toBe(ErrorCode.BACKUP_INVALID);

    const backup = await env.call<{ filePath: string }>('backup.create', {}, adminSession);
    const files = unzipSync(new Uint8Array(readFileSync(backup.data!.filePath)));
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    manifest.schemaVersion = 99;
    const future = join(tempDir(), 'future.adbk');
    writeFileSync(future, zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'database.sqlite': files['database.sqlite']! }));
    const r2 = await env.call('backup.restore', { filePath: future, password: ADMIN.password, confirmation: 'RESTORE' }, adminSession);
    expect(!r2.ok && r2.error.code).toBe(ErrorCode.BACKUP_INVALID);
    expect(!r2.ok && r2.error.message).toMatch(/newer version/);
  });

  it('restore requires the explicit confirmation word', async () => {
    const { env, adminSession } = await ready();
    const r = await env.call('backup.restore', { filePath: 'x.adbk', password: ADMIN.password, confirmation: 'yes' }, adminSession);
    expect(!r.ok && r.error.code).toBe(ErrorCode.VALIDATION);
  });

  it('recovers from a crash in the middle of a restore (EC-X07)', async () => {
    const dir = tempDir();
    const live = join(dir, 'airdesk.db');
    const pre = `${live}.pre-restore-x`;
    const incoming = join(dir, 'incoming.sqlite');
    const make = (p: string, marker: string) => {
      const db = openDatabase({ path: p });
      db.exec(`CREATE TABLE t (v TEXT) STRICT; INSERT INTO t VALUES ('${marker}');`);
      db.close();
    };
    // Crash after the old DB was moved away but before the new one arrived → roll back.
    make(pre, 'old');
    writeFileSync(join(dir, 'restore-pending.json'), JSON.stringify({ livePath: live, preRestorePath: pre, incomingPath: incoming, step: 'SWAPPING' }));
    expect(recoverPendingRestore(live)).toBe('ROLLED_BACK');
    const db1 = openDatabase({ path: live });
    expect((db1.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('old');
    db1.close();
    // Crash after the swap during verification with a healthy new DB → completed.
    writeFileSync(join(dir, 'restore-pending.json'), JSON.stringify({ livePath: live, preRestorePath: pre, incomingPath: incoming, step: 'VERIFYING' }));
    expect(recoverPendingRestore(live)).toBe('COMPLETED');
    expect(readdirSync(dir)).not.toContain('restore-pending.json');
  });
});
