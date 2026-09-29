import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, openSync, writeSync, closeSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { BookingDto } from '@airdesk/contracts';
import {
  AppLauncher,
  KEY_FILE_NAME,
  MIGRATIONS,
  ManualClock,
  TEST_ARGON2,
  TEST_KDF,
  createArgon2Hasher,
  createMemoryLogger,
  databaseFileKind,
  type DeviceKeyStore,
  type Migration,
} from '../src';
import { ADMIN, COMPANY, login, makeBackend, setupCompany, tempDir, type TestEnv } from './helpers';
import { book, ok, receive, paySupplier, summary, world } from './flow';

const PASSPHRASE = 'KQ7M2-XWPRT-9HDFA-B3CEN-ZY4GV';
const OTHER_PASSPHRASE = 'a completely different recovery phrase';
const SECRET_MARKERS = ['Test Travel Co.', 'Ahmed Ali', 'Company ABC', '0779991234567', 'ABC123'];

/** In-memory stand-in for Windows DPAPI (one Windows user on one PC). */
class MemoryDeviceKeys implements DeviceKeyStore {
  readonly kind = 'test-device';
  private readonly keys = new Map<string, Buffer>();
  isAvailable() { return true; }
  load(id: string) { return this.keys.get(id) ?? null; }
  save(id: string, dk: Buffer) { this.keys.set(id, Buffer.from(dk)); }
  forget(id: string) { this.keys.delete(id); }
  list() { return [...this.keys.keys()]; }
}
const NO_DEVICE: DeviceKeyStore = { kind: 'none', isAvailable: () => false, load: () => null, save: () => undefined, forget: () => undefined, list: () => [] };

interface LEnv extends Omit<TestEnv, 'call'> {
  launcher: AppLauncher;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call(command: string, payload?: unknown, sessionId?: string | null): Promise<any>;
  status(): Promise<{ vault: string; lockReason?: string; encrypted: boolean | null; setupRequired: boolean; retryAfterSeconds?: number }>;
}

const launchers: AppLauncher[] = [];
async function launch(dataDir: string, deviceKeys: DeviceKeyStore, opts: { migrations?: readonly Migration[]; clock?: ManualClock } = {}): Promise<LEnv> {
  const clock = opts.clock ?? new ManualClock('2026-09-28T09:00:00.000Z');
  const logger = createMemoryLogger();
  const launcher = await AppLauncher.start({
    dataDir, appVersion: '1.0.0-test', clock, logger, hasher: createArgon2Hasher(TEST_ARGON2), deviceKeys, kdf: TEST_KDF,
    ...(opts.migrations ? { migrations: opts.migrations } : {}),
  });
  launchers.push(launcher);
  const env: LEnv = {
    launcher,
    get backend() { return launcher.backend!; },
    clock,
    dataDir,
    logger,
    call: (command, payload = {}, sessionId = null) => launcher.dispatch({ command, payload, sessionId, workstation: 'TEST-PC' }) as never,
    status: async () => ((await launcher.dispatch({ command: 'system.status', payload: {}, workstation: 'TEST-PC' })) as unknown as { data: never }).data,
  };
  return env;
}
function closeAll() {
  for (const l of launchers.splice(0)) l.close();
}

async function setupNew(env: LEnv, recovery: { passphrase: string; confirmation: string } | null = { passphrase: PASSPHRASE, confirmation: PASSPHRASE }) {
  return env.call('system.setup', {
    company: COMPANY,
    admin: { username: ADMIN.username, displayName: 'Owner', password: ADMIN.password, locale: 'ar' },
    ...(recovery ? { recovery } : {}),
  });
}

/** A realistic little office: customer, supplier, externally issued ticket, part payments both sides. */
async function officeActivity(env: TestEnv, s: string): Promise<{ booking: BookingDto }> {
  const w = await world(env, s);
  const booking = await book(env, s, w, { ticketNumbers: ['0779991234567'] });
  await receive(env, s, w, booking.id, 400_000);
  await paySupplier(env, s, w, booking.id, 300_000);
  return { booking };
}

function financialSnapshot(env: TestEnv) {
  const db = env.backend.internals.db;
  const tb = db.prepare('SELECT SUM(debit_base_minor) d, SUM(credit_base_minor) c, COUNT(*) n FROM journal_line').get();
  const docs = db.prepare('SELECT doc_no, total_minor, total_base_minor FROM fin_document ORDER BY doc_no').all();
  const balances = db.prepare(`SELECT account_code, customer_id, supplier_id, money_account_id, SUM(debit_base_minor - credit_base_minor) b FROM journal_line GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`).all();
  const audit = db.prepare('SELECT COUNT(*) n, MAX(seq) s FROM audit_log').get();
  return { tb, docs, balances, summary: summary(env), audit };
}

function filesContain(dir: string, markers: string[]): string[] {
  const hits: string[] = [];
  for (const f of readdirSync(dir, { recursive: true }) as string[]) {
    const p = join(dir, f);
    let buf: Buffer;
    try {
      buf = readFileSync(p);
    } catch {
      continue;
    }
    for (const m of markers) if (buf.includes(Buffer.from(m, 'utf8'))) hits.push(`${f}: ${m}`);
  }
  return hits;
}

describe('encryption at rest — new installation', () => {
  it('a new company is created encrypted; restart, login, ticket record, payment, backup and nothing readable on disk', async () => {
    const dir = tempDir();
    const device = new MemoryDeviceKeys();
    try {
      let env = await launch(dir, device);
      expect((await env.status()).vault).toBe('NEW');
      // No passphrase → refused; weak or mismatched → refused; nothing created.
      expect((await setupNew(env, null)).error?.code).toBe('PASSPHRASE_POLICY');
      expect((await setupNew(env, { passphrase: 'short', confirmation: 'short' })).error?.code).toBe('PASSPHRASE_POLICY');
      expect((await setupNew(env, { passphrase: PASSPHRASE, confirmation: 'KQ7M2-XWPRT-9HDFA-B3CEN-ZY4GX' })).error?.details).toEqual({ reason: 'MISMATCH' });
      expect(existsSync(join(dir, 'airdesk.db'))).toBe(false);
      // Other commands are refused before setup/unlock.
      expect((await env.call('customers.list', {})).error?.code).toBe('DATABASE_LOCKED');

      // Generated passphrases are accepted in lower case / without dashes when typed again.
      const setup = await setupNew(env, { passphrase: PASSPHRASE, confirmation: PASSPHRASE.toLowerCase().replace(/-/g, ' ') });
      expect(setup.ok, JSON.stringify(setup.error)).toBe(true);
      expect(await env.status()).toMatchObject({ vault: 'READY', encrypted: true, setupRequired: false });
      expect(databaseFileKind(join(dir, 'airdesk.db'))).toBe('ENCRYPTED');
      expect(existsSync(join(dir, KEY_FILE_NAME))).toBe(true);

      let s = await login(env);
      const { booking } = await officeActivity(env, s);
      const before = financialSnapshot(env);
      const bk = await ok<{ filePath: string }>(env, 'backup.create', {}, s);
      closeAll();

      // Restart on the same PC/Windows user: opens without the passphrase.
      env = await launch(dir, device);
      expect(await env.status()).toMatchObject({ vault: 'READY', encrypted: true });
      s = await login(env);
      const { audit: _a, ...moneyAfter } = financialSnapshot(env);
      const { audit: _b, ...moneyBefore } = before;
      expect(moneyAfter).toEqual(moneyBefore);
      const reread = await ok<BookingDto>(env, 'bookings.get', { id: booking.id }, s);
      expect(reread.customer[0]).toMatchObject({ chargedMinor: 1_050_000, paidMinor: 400_000, balanceMinor: 650_000 });
      const integrity = await ok<{ ok: boolean; checks: { id: string; ok: boolean }[] }>(env, 'integrity.run', {}, s);
      expect(integrity.checks.filter((c) => !c.ok)).toEqual([]);
      expect(integrity.checks.map((c) => c.id)).toContain('INV-9.audit_anchors');
      closeAll();

      // Nothing identifying is readable in the data folder: database, WAL, key file, backups.
      expect(filesContain(dir, SECRET_MARKERS)).toEqual([]);
      const zip = unzipSync(new Uint8Array(readFileSync(bk.filePath)));
      const manifest = JSON.parse(strFromU8(zip['manifest.json']!));
      expect(manifest).toMatchObject({ format: 2, encrypted: true });
      expect(manifest.companyName).toBeUndefined();
      expect(manifest.counts).toBeUndefined();
      expect(JSON.stringify(manifest)).not.toContain(COMPANY.legalNameAr);
      // The key itself is nowhere in clear: not in the key file, backup or database.
      const dk = device.load(device.list()[0]!)!;
      for (const f of [join(dir, KEY_FILE_NAME), bk.filePath, join(dir, 'airdesk.db')]) {
        const buf = readFileSync(f);
        expect(buf.includes(dk), f).toBe(false);
        expect(buf.includes(Buffer.from(dk.toString('hex'))), f).toBe(false);
        expect(buf.includes(Buffer.from(dk.toString('base64'))), f).toBe(false);
      }
    } finally {
      closeAll();
    }
  });

  it('without the saved device key the data stays locked until the recovery passphrase is given; wrong passphrases are slowed down', async () => {
    const dir = tempDir();
    try {
      let env = await launch(dir, new MemoryDeviceKeys());
      expect((await setupNew(env)).ok).toBe(true);
      const s = await login(env);
      await officeActivity(env, s);
      closeAll();

      // e.g. Windows reinstalled / another Windows user: no device key.
      const device2 = new MemoryDeviceKeys();
      env = await launch(dir, device2);
      expect(await env.status()).toMatchObject({ vault: 'LOCKED', lockReason: 'PASSPHRASE_REQUIRED', encrypted: true });
      expect((await env.call('auth.login', { username: ADMIN.username, password: ADMIN.password })).error?.code).toBe('DATABASE_LOCKED');
      const wrong = await env.call('vault.unlock', { passphrase: OTHER_PASSPHRASE });
      expect(wrong.error?.code).toBe('WRONG_PASSPHRASE');
      const tooSoon = await env.call('vault.unlock', { passphrase: PASSPHRASE });
      expect(tooSoon.error?.code).toBe('WRONG_PASSPHRASE');
      expect(tooSoon.error?.details?.retryAfterSeconds).toBeGreaterThan(0);
      expect((await env.status()).retryAfterSeconds).toBeGreaterThan(0);
      // After the wait the right passphrase opens it and is remembered for this user.
      await new Promise((r) => setTimeout(r, 2100));
      const unlocked = await env.call('vault.unlock', { passphrase: PASSPHRASE });
      expect(unlocked.ok, JSON.stringify(unlocked.error)).toBe(true);
      const s2 = await login(env);
      const actions = (env.backend.internals.db.prepare('SELECT action FROM audit_log').all() as { action: string }[]).map((r) => r.action);
      expect(actions).toContain('security.unlocked_with_recovery_passphrase');
      expect((await env.call('vault.unlock', { passphrase: PASSPHRASE }, s2)).error?.code).toBe('CONFLICT');
      expect(device2.list()).toHaveLength(1);
      closeAll();
      env = await launch(dir, device2);
      expect((await env.status()).vault).toBe('READY');

      // Linux without a keyring: passphrase at every start, never stored.
      closeAll();
      env = await launch(dir, NO_DEVICE);
      expect((await env.status()).vault).toBe('LOCKED');
      expect((await env.call('vault.unlock', { passphrase: PASSPHRASE })).ok).toBe(true);
      closeAll();
      env = await launch(dir, NO_DEVICE);
      expect((await env.status()).vault).toBe('LOCKED');
    } finally {
      closeAll();
    }
  });

  it('secrets never reach logs or the audit trail', async () => {
    const dir = tempDir();
    const device = new MemoryDeviceKeys();
    try {
      const env = await launch(dir, device);
      await setupNew(env);
      const s = await login(env);
      await ok(env, 'backup.create', {}, s);
      await env.call('security.changeRecoveryPassphrase', { password: ADMIN.password, passphrase: OTHER_PASSPHRASE, confirmation: OTHER_PASSPHRASE }, s);
      await env.call('security.changeRecoveryPassphrase', { password: 'wrong password!!', passphrase: 'another wrong one 123', confirmation: 'another wrong one 123' }, s);
      const dk = device.load(device.list()[0]!)!;
      const logs = JSON.stringify(env.logger.records);
      const audit = JSON.stringify(env.backend.internals.db.prepare('SELECT * FROM audit_log').all());
      for (const secret of [PASSPHRASE, OTHER_PASSPHRASE, 'another wrong one 123', ADMIN.password, 'wrong password!!', dk.toString('hex'), dk.toString('base64')]) {
        expect(logs.includes(secret), `log contains ${secret.slice(0, 6)}…`).toBe(false);
        expect(audit.includes(secret), `audit contains ${secret.slice(0, 6)}…`).toBe(false);
      }
    } finally {
      closeAll();
    }
  });
});

describe('encrypted backups and recovery', () => {
  it('clean-PC recovery: an encrypted off-site backup + its recovery passphrase restores everything on a new installation', async () => {
    const office = tempDir();
    const offsite = join(tempDir(), 'offsite.adbk');
    try {
      let env = await launch(office, new MemoryDeviceKeys());
      await setupNew(env);
      let s = await login(env);
      const { booking } = await officeActivity(env, s);
      await ok(env, 'users.create', { username: 'agent1', displayName: 'Agent', password: 'temporary pass 12345', roleCodes: ['SALES_AGENT'] }, s);
      const before = financialSnapshot(env);
      const sales = await ok<{ totals: Record<string, number> }>(env, 'reports.run', { report: 'sales', from: '2026-01-01', to: '2026-12-31' }, s);
      const bk = await ok<{ filePath: string }>(env, 'backup.create', {}, s);
      copyFileSync(bk.filePath, offsite);
      closeAll();

      // New PC: empty data folder, new Windows user.
      const pc2 = tempDir();
      const device2 = new MemoryDeviceKeys();
      env = await launch(pc2, device2);
      expect((await env.status()).vault).toBe('NEW');
      const header = await ok<{ encrypted: boolean; createdAt: string; sameKey: boolean }>(env, 'vault.inspectBackup', { filePath: offsite }, null as never);
      expect(header).toMatchObject({ encrypted: true, sameKey: false });
      expect((await env.call('vault.restoreBackup', { filePath: offsite, confirmation: 'RESTORE' })).error?.code).toBe('PASSPHRASE_REQUIRED');
      expect((await env.call('vault.restoreBackup', { filePath: offsite, passphrase: OTHER_PASSPHRASE, confirmation: 'RESTORE' })).error?.code).toBe('WRONG_PASSPHRASE');
      expect(existsSync(join(pc2, 'airdesk.db'))).toBe(false);
      const restored = await env.call('vault.restoreBackup', { filePath: offsite, passphrase: PASSPHRASE, confirmation: 'RESTORE' });
      expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
      expect(await env.status()).toMatchObject({ vault: 'READY', encrypted: true, setupRequired: false });

      // Original users log in; ledger, customers, suppliers, ticket records, payments, reports are identical.
      s = await login(env);
      expect(financialSnapshot(env).tb).toEqual(before.tb);
      expect(financialSnapshot(env).docs).toEqual(before.docs);
      expect(financialSnapshot(env).balances).toEqual(before.balances);
      expect(financialSnapshot(env).summary).toEqual(before.summary);
      expect((await ok<{ total: number }>(env, 'customers.list', { query: 'Ahmed Ali' }, s)).total).toBe(1);
      expect((await ok<{ total: number }>(env, 'suppliers.list', { query: 'Company ABC' }, s)).total).toBe(1);
      const rec = await ok<BookingDto>(env, 'bookings.get', { id: booking.id }, s);
      expect(rec.customer[0]).toMatchObject({ chargedMinor: 1_050_000, paidMinor: 400_000, balanceMinor: 650_000 });
      expect(rec.tickets.map((t) => t.ticketNumber)).toContain('0779991234567');
      expect((await ok<{ totals: Record<string, number> }>(env, 'reports.run', { report: 'sales', from: '2026-01-01', to: '2026-12-31' }, s)).totals).toEqual(sales.totals);
      const integrity = await ok<{ ok: boolean; checks: { id: string; ok: boolean }[] }>(env, 'integrity.run', {}, s);
      expect(integrity.checks.filter((c) => !c.ok)).toEqual([]);
      expect((await login(env, 'agent1', 'temporary pass 12345')).length).toBeGreaterThan(10);
      // Future backups on the new PC work and use the same recovery passphrase.
      const next = await ok<{ filePath: string }>(env, 'backup.create', {}, s);
      closeAll();
      // The recovered key is remembered for this user.
      env = await launch(pc2, device2);
      expect((await env.status()).vault).toBe('READY');
      closeAll();
      const pc3 = tempDir();
      env = await launch(pc3, new MemoryDeviceKeys());
      expect((await env.call('vault.restoreBackup', { filePath: next.filePath, passphrase: PASSPHRASE, confirmation: 'RESTORE' })).ok).toBe(true);
    } finally {
      closeAll();
    }
  });

  it('corrupted or altered encrypted backups are refused and nothing changes', async () => {
    const dir = tempDir();
    try {
      const env = await launch(dir, new MemoryDeviceKeys());
      await setupNew(env);
      const s = await login(env);
      await officeActivity(env, s);
      const bk = await ok<{ filePath: string }>(env, 'backup.create', {}, s);
      const files = unzipSync(new Uint8Array(readFileSync(bk.filePath)));
      const write = (name: string, manifest: unknown, db: Uint8Array) => {
        const p = join(tempDir(), name);
        writeFileSync(p, zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'database.sqlite': db }, { level: 0 }));
        return p;
      };
      const manifest = JSON.parse(strFromU8(files['manifest.json']!));
      const restore = (filePath: string) => env.call('backup.restore', { filePath, password: ADMIN.password, confirmation: 'RESTORE', backupPassphrase: PASSPHRASE }, s);

      // 1. One flipped byte in the database part → checksum mismatch.
      const flipped = new Uint8Array(files['database.sqlite']!);
      flipped[9000] = flipped[9000]! ^ 0xff;
      expect((await restore(write('flip.adbk', manifest, flipped))).error?.code).toBe('BACKUP_INVALID');
      // 2. Same flip with a recomputed checksum → the page authentication (HMAC) inside SQLCipher refuses it.
      const { createHash } = await import('node:crypto');
      const forged = { ...manifest, dbSha256: createHash('sha256').update(flipped).digest('hex') };
      const r2 = await restore(write('forged.adbk', forged, flipped));
      expect(r2.error?.code).toBe('BACKUP_INVALID');
      // 3. Altered public manifest field → the sealed part no longer authenticates.
      expect((await restore(write('manifest.adbk', { ...manifest, createdAt: '2020-01-01T00:00:00.000Z' }, files['database.sqlite']!))).error?.code).toBe('BACKUP_INVALID');
      // 4. Tampered key wrap → wrong passphrase / refused.
      const badWrap = { ...manifest, keyWrap: { ...manifest.keyWrap, ciphertext: Buffer.alloc(32, 1).toString('base64') } };
      const r4 = await env.call('backup.restore', { filePath: write('wrap.adbk', badWrap, files['database.sqlite']!), password: ADMIN.password, confirmation: 'RESTORE', backupPassphrase: PASSPHRASE }, s);
      expect(r4.error?.code).toBe('BACKUP_INVALID');
      // 5. Truncated file.
      const truncated = join(tempDir(), 'trunc.adbk');
      writeFileSync(truncated, readFileSync(bk.filePath).subarray(0, 5000));
      expect((await restore(truncated)).error?.code).toBe('BACKUP_INVALID');
      // Still signed in, data untouched.
      expect((await env.call('company.get', {}, s)).ok).toBe(true);
    } finally {
      closeAll();
    }
  });

  it('a damaged encrypted database is detected at start and recovered from a backup (the damaged file is kept aside)', async () => {
    const dir = tempDir();
    const device = new MemoryDeviceKeys();
    try {
      let env = await launch(dir, device);
      await setupNew(env);
      const s = await login(env);
      await officeActivity(env, s);
      const bk = await ok<{ filePath: string }>(env, 'backup.create', {}, s);
      closeAll();
      // Damage the first page (header) of the encrypted file.
      const fd = openSync(join(dir, 'airdesk.db'), 'r+');
      writeSync(fd, Buffer.alloc(64, 0x5a), 0, 64, 16);
      closeSync(fd);
      env = await launch(dir, device);
      expect(await env.status()).toMatchObject({ vault: 'LOCKED', lockReason: 'DATABASE_DAMAGED' });
      // The passphrase alone cannot fix damage.
      const u = await env.call('vault.unlock', { passphrase: PASSPHRASE });
      expect(u.ok).toBe(false);
      const r = await env.call('vault.restoreBackup', { filePath: bk.filePath, passphrase: PASSPHRASE, confirmation: 'RESTORE' });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      expect((await env.status()).vault).toBe('READY');
      expect(readdirSync(dir).some((f) => f.startsWith('airdesk.db.pre-restore-'))).toBe(true);
      await login(env);
    } finally {
      closeAll();
    }
  });

  it('a deleted key file is rebuilt from the database (device key) or read from a backup (passphrase)', async () => {
    const dir = tempDir();
    const device = new MemoryDeviceKeys();
    try {
      let env = await launch(dir, device);
      await setupNew(env);
      const s = await login(env);
      const bk = await ok<{ filePath: string }>(env, 'backup.create', {}, s);
      closeAll();
      rmSync(join(dir, KEY_FILE_NAME));
      env = await launch(dir, device);
      expect((await env.status()).vault).toBe('READY');
      expect(existsSync(join(dir, KEY_FILE_NAME))).toBe(true);
      closeAll();

      rmSync(join(dir, KEY_FILE_NAME));
      env = await launch(dir, new MemoryDeviceKeys());
      expect(await env.status()).toMatchObject({ vault: 'LOCKED', lockReason: 'KEY_FILE_MISSING' });
      expect((await env.call('vault.unlock', { passphrase: PASSPHRASE })).error?.code).toBe('KEY_FILE_DAMAGED');
      const r = await env.call('vault.unlock', { passphrase: PASSPHRASE, keySourceBackupPath: bk.filePath });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      expect(existsSync(join(dir, KEY_FILE_NAME))).toBe(true);
      closeAll();
      writeFileSync(join(dir, KEY_FILE_NAME), '{ not json');
      env = await launch(dir, new MemoryDeviceKeys());
      expect(await env.status()).toMatchObject({ vault: 'LOCKED', lockReason: 'KEY_FILE_DAMAGED' });
    } finally {
      closeAll();
    }
  });

  it('changing the recovery passphrase: the new one opens the data, the old one only opens older backups', async () => {
    const dir = tempDir();
    const device = new MemoryDeviceKeys();
    try {
      let env = await launch(dir, device);
      await setupNew(env);
      const s = await login(env);
      const old = await ok<{ filePath: string }>(env, 'backup.create', {}, s);
      expect((await env.call('security.changeRecoveryPassphrase', { password: 'wrong password!!', passphrase: OTHER_PASSPHRASE, confirmation: OTHER_PASSPHRASE }, s)).error?.code).toBe('INVALID_CREDENTIALS');
      const changed = await ok<{ backupFilePath: string }>(env, 'security.changeRecoveryPassphrase', { password: ADMIN.password, passphrase: OTHER_PASSPHRASE, confirmation: OTHER_PASSPHRASE }, s);
      expect(existsSync(changed.backupFilePath)).toBe(true);
      closeAll();
      env = await launch(dir, NO_DEVICE);
      expect((await env.call('vault.unlock', { passphrase: PASSPHRASE })).error?.code).toBe('WRONG_PASSPHRASE');
      await new Promise((r) => setTimeout(r, 2100));
      expect((await env.call('vault.unlock', { passphrase: OTHER_PASSPHRASE })).ok).toBe(true);
      closeAll();
      const pc = tempDir();
      env = await launch(pc, new MemoryDeviceKeys());
      expect((await env.call('vault.restoreBackup', { filePath: old.filePath, passphrase: OTHER_PASSPHRASE, confirmation: 'RESTORE' })).error?.code).toBe('WRONG_PASSPHRASE');
      expect((await env.call('vault.restoreBackup', { filePath: changed.backupFilePath, passphrase: OTHER_PASSPHRASE, confirmation: 'RESTORE' })).ok).toBe(true);
    } finally {
      closeAll();
    }
  });

  it('restoring a backup from another installation re-encrypts it with this installation key; plain backups are encrypted on the way in', async () => {
    const a = tempDir();
    const b = tempDir();
    const deviceB = new MemoryDeviceKeys();
    try {
      // Installation A (other passphrase) and a plain rc.1 installation.
      let envA = await launch(a, new MemoryDeviceKeys());
      await setupNew(envA, { passphrase: OTHER_PASSPHRASE, confirmation: OTHER_PASSPHRASE });
      const sa = await login(envA);
      await officeActivity(envA, sa);
      const fromA = await ok<{ filePath: string }>(envA, 'backup.create', {}, sa);
      closeAll();
      const plain = await makeBackend();
      await setupCompany(plain);
      const sp = await login(plain);
      await officeActivity(plain, sp);
      const plainBk = await ok<{ filePath: string }>(plain, 'backup.create', {}, sp);
      plain.backend.close();

      let envB = await launch(b, deviceB);
      await setupNew(envB);
      let sb = await login(envB);
      const keyIdBefore = JSON.parse(readFileSync(join(b, KEY_FILE_NAME), 'utf8')).keyId;
      const header = await ok<{ sameKey: boolean; encrypted: boolean }>(envB, 'backup.inspect', { filePath: fromA.filePath }, sb);
      expect(header).toMatchObject({ sameKey: false, encrypted: true });
      expect((await envB.call('backup.restore', { filePath: fromA.filePath, password: ADMIN.password, confirmation: 'RESTORE' }, sb)).error?.code).toBe('PASSPHRASE_REQUIRED');
      const r = await envB.call('backup.restore', { filePath: fromA.filePath, password: ADMIN.password, confirmation: 'RESTORE', backupPassphrase: OTHER_PASSPHRASE }, sb);
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      expect(JSON.parse(readFileSync(join(b, KEY_FILE_NAME), 'utf8')).keyId).toBe(keyIdBefore);
      sb = await login(envB);
      expect((await ok<{ total: number }>(envB, 'customers.list', { query: 'Ahmed Ali' }, sb)).total).toBe(1);
      // Plain rc.1 backup into the encrypted installation.
      const r2 = await envB.call('backup.restore', { filePath: plainBk.filePath, password: ADMIN.password, confirmation: 'RESTORE' }, sb);
      expect(r2.ok, JSON.stringify(r2.error)).toBe(true);
      expect(databaseFileKind(join(b, 'airdesk.db'))).toBe('ENCRYPTED');
      closeAll();
      // B's own passphrase still opens B after both restores.
      envB = await launch(b, NO_DEVICE);
      expect((await envB.call('vault.unlock', { passphrase: PASSPHRASE })).ok).toBe(true);
      closeAll();

      // A clean PC restoring a PLAIN backup must choose a recovery passphrase; the result is encrypted.
      const pc = tempDir();
      envA = await launch(pc, new MemoryDeviceKeys());
      expect((await envA.call('vault.restoreBackup', { filePath: plainBk.filePath, confirmation: 'RESTORE' })).error?.code).toBe('PASSPHRASE_POLICY');
      const r3 = await envA.call('vault.restoreBackup', { filePath: plainBk.filePath, newRecovery: { passphrase: OTHER_PASSPHRASE, confirmation: OTHER_PASSPHRASE }, confirmation: 'RESTORE' });
      expect(r3.ok, JSON.stringify(r3.error)).toBe(true);
      expect(databaseFileKind(join(pc, 'airdesk.db'))).toBe('ENCRYPTED');
    } finally {
      closeAll();
    }
  });
});

describe('upgrading a 1.0.0-rc.1 (unencrypted) installation', () => {
  it('enables encryption without changing any amount, audit history or migration record', async () => {
    const dir = tempDir();
    const device = new MemoryDeviceKeys();
    try {
      const rc = await makeBackend({ dataDir: dir });
      await setupCompany(rc);
      let s = await login(rc);
      await officeActivity(rc, s);
      const plainBackup = await ok<{ filePath: string }>(rc, 'backup.create', {}, s);
      const before = financialSnapshot(rc);
      const migrationsBefore = rc.backend.internals.db.prepare('SELECT version, name, checksum, applied_at FROM schema_migration ORDER BY version').all();
      const auditBefore = rc.backend.internals.db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq').all();
      rc.backend.close();

      let env = await launch(dir, device);
      expect(await env.status()).toMatchObject({ vault: 'READY', encrypted: false });
      s = await login(env);
      expect(await ok(env, 'security.encryptionStatus', {}, s)).toMatchObject({ encrypted: false, unencryptedBackupFiles: 1 });
      expect((await env.call('security.enableEncryption', { password: 'wrong password!!', passphrase: PASSPHRASE, confirmation: PASSPHRASE }, s)).error?.code).toBe('INVALID_CREDENTIALS');
      expect((await env.call('security.enableEncryption', { password: ADMIN.password, passphrase: 'aaaaaaaaaaaaaaaa', confirmation: 'aaaaaaaaaaaaaaaa' }, s)).error?.code).toBe('PASSPHRASE_POLICY');
      expect(databaseFileKind(join(dir, 'airdesk.db'))).toBe('PLAIN');
      const enabled = await env.call('security.enableEncryption', { password: ADMIN.password, passphrase: PASSPHRASE, confirmation: PASSPHRASE }, s);
      expect(enabled.ok, JSON.stringify(enabled.error)).toBe(true);
      expect(enabled.session).toEqual({ clear: true });
      expect(enabled.data!.unencryptedBackupFiles).toBe(1);
      expect(databaseFileKind(join(dir, 'airdesk.db'))).toBe('ENCRYPTED');
      expect(readdirSync(dir).filter((f) => f.startsWith('airdesk.db.pre-encryption') || f.startsWith('.encrypting'))).toEqual([]);
      expect((await env.call('company.get', {}, s)).error?.code).toBe('UNAUTHENTICATED');
      s = await login(env);

      const after = financialSnapshot(env);
      expect(after.tb).toEqual(before.tb);
      expect(after.docs).toEqual(before.docs);
      expect(after.balances).toEqual(before.balances);
      expect(after.summary).toEqual(before.summary);
      expect(env.backend.internals.db.prepare('SELECT version, name, checksum, applied_at FROM schema_migration ORDER BY version').all()).toEqual(migrationsBefore);
      const auditAfter = env.backend.internals.db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq').all() as { seq: number; hash: string }[];
      expect(auditAfter.slice(0, auditBefore.length + 1).slice(0, auditBefore.length)).toEqual(auditBefore);
      expect((env.backend.internals.db.prepare('SELECT action FROM audit_log ORDER BY seq').all() as { action: string }[]).map((r) => r.action))
        .toEqual(expect.arrayContaining(['security.encryption_started', 'security.encryption_enabled']));
      const integrity = await ok<{ checks: { id: string; ok: boolean }[] }>(env, 'integrity.run', {}, s);
      expect(integrity.checks.filter((c) => !c.ok)).toEqual([]);
      expect(await ok(env, 'security.encryptionStatus', {}, s)).toMatchObject({ encrypted: true, unencryptedBackupFiles: 1 });
      expect((await env.call('security.enableEncryption', { password: ADMIN.password, passphrase: PASSPHRASE, confirmation: PASSPHRASE }, s)).error?.code).toBe('CONFLICT');

      // Old unencrypted backups can be deleted once the data is encrypted.
      expect((await env.call('security.purgeUnencryptedBackups', { password: ADMIN.password, confirmation: 'DELETE' }, s)).data).toEqual({ removed: 1 });
      expect(existsSync(plainBackup.filePath)).toBe(false);
      expect(existsSync(enabled.data!.backupFilePath)).toBe(true);
      closeAll();
      expect(filesContain(dir, SECRET_MARKERS)).toEqual([]);
      env = await launch(dir, device);
      expect(await env.status()).toMatchObject({ vault: 'READY', encrypted: true });
    } finally {
      closeAll();
    }
  });

  it('an encryption interrupted by a crash finishes (or rolls back) at the next start', async () => {
    for (const step of ['SWAPPING', 'VERIFYING'] as const) {
      const dir = tempDir();
      const device = new MemoryDeviceKeys();
      try {
        const rc = await makeBackend({ dataDir: dir });
        await setupCompany(rc);
        const s = await login(rc);
        await officeActivity(rc, s);
        const before = financialSnapshot(rc);
        rc.backend.close();
        // Prepare exactly what enableEncryption() has on disk just before the crash.
        let env = await launch(dir, device);
        const b = env.backend;
        const { dk, wrap } = await b.vault.createKey(PASSPHRASE, new Date().toISOString());
        const work = join(dir, '.encrypting-test.sqlite');
        b.internals.db.pragma('wal_checkpoint(TRUNCATE)');
        copyFileSync(join(dir, 'airdesk.db'), work);
        await b.jobs.run({ type: 'encrypt-copy', path: work, keyHex: dk.toString('hex') });
        b.vault.stage(dk, wrap);
        closeAll();
        const live = join(dir, 'airdesk.db');
        const pre = `${live}.pre-encryption-crash`;
        renameSync(live, pre);
        if (step === 'VERIFYING') renameSync(work, live);
        writeFileSync(join(dir, 'restore-pending.json'), JSON.stringify({ livePath: live, preRestorePath: pre, incomingPath: work, step, kind: 'ENCRYPT', incomingKeyId: wrap.keyId }));

        env = await launch(dir, device);
        expect((await env.status()).vault).toBe('READY');
        expect(existsSync(join(dir, 'restore-pending.json'))).toBe(false);
        expect(databaseFileKind(live)).toBe(step === 'VERIFYING' ? 'ENCRYPTED' : 'PLAIN');
        expect(existsSync(pre)).toBe(false);
        expect(existsSync(join(dir, KEY_FILE_NAME))).toBe(step === 'VERIFYING');
        expect(existsSync(join(dir, 'airdesk.key.incoming'))).toBe(false);
        expect(financialSnapshot(env).tb).toEqual(before.tb);
        await login(env);
        closeAll();
      } finally {
        closeAll();
      }
    }
  });

  it('an interrupted restore of an encrypted installation waits for the passphrase when the device key is unavailable, then completes', async () => {
    const dir = tempDir();
    try {
      let env = await launch(dir, new MemoryDeviceKeys());
      await setupNew(env);
      const s = await login(env);
      await officeActivity(env, s);
      const bk = await ok<{ filePath: string }>(env, 'backup.create', {}, s);
      const keyId = JSON.parse(readFileSync(join(dir, KEY_FILE_NAME), 'utf8')).keyId;
      const validated = await env.backend.jobs.run<{ tempDbPath: string }>({
        type: 'validate', filePath: bk.filePath, tempDir: dir, maxSchemaVersion: MIGRATIONS.length, currentKeyHex: env.backend.vault.dataKey!.toString('hex'), target: 'KEEP', keepTemp: true,
      });
      closeAll();
      const live = join(dir, 'airdesk.db');
      const pre = `${live}.pre-restore-crash`;
      renameSync(live, pre);
      renameSync(validated.tempDbPath, live);
      writeFileSync(join(dir, 'restore-pending.json'), JSON.stringify({ livePath: live, preRestorePath: pre, incomingPath: validated.tempDbPath, step: 'VERIFYING', kind: 'RESTORE', incomingKeyId: keyId }));
      env = await launch(dir, NO_DEVICE);
      expect(await env.status()).toMatchObject({ vault: 'LOCKED', lockReason: 'PASSPHRASE_REQUIRED' });
      expect(existsSync(join(dir, 'restore-pending.json'))).toBe(true);
      expect((await env.call('vault.unlock', { passphrase: PASSPHRASE })).ok).toBe(true);
      expect(existsSync(join(dir, 'restore-pending.json'))).toBe(false);
      expect(existsSync(pre)).toBe(true); // a restore keeps the previous database aside
      await login(env);
    } finally {
      closeAll();
    }
  });

  it('migration of an encrypted database: encrypted pre-migration backup, data kept, backup and restore after the migration', async () => {
    const dir = tempDir();
    const device = new MemoryDeviceKeys();
    try {
      let env = await launch(dir, device);
      await setupNew(env);
      let s = await login(env);
      await officeActivity(env, s);
      const before = financialSnapshot(env);
      closeAll();
      const next = MIGRATIONS.length + 1;
      const vNext: Migration[] = [...MIGRATIONS, { version: next, name: 'add_note', sql: 'ALTER TABLE customer ADD COLUMN loyalty_tier TEXT;' }];
      env = await launch(dir, device, { migrations: vNext });
      expect((await env.status()).vault).toBe('READY');
      expect(env.backend.schemaVersionNow).toBe(next);
      const pre = readdirSync(join(dir, 'backups')).filter((f) => f.includes('pre_migration'));
      expect(pre).toHaveLength(1);
      const manifest = JSON.parse(strFromU8(unzipSync(new Uint8Array(readFileSync(join(dir, 'backups', pre[0]!))))['manifest.json']!));
      expect(manifest).toMatchObject({ format: 2, encrypted: true, schemaVersion: MIGRATIONS.length });
      s = await login(env);
      expect(financialSnapshot(env).tb).toEqual(before.tb);
      const bk = await ok<{ filePath: string }>(env, 'backup.create', {}, s);
      const r = await env.call('backup.restore', { filePath: join(dir, 'backups', pre[0]!), password: ADMIN.password, confirmation: 'RESTORE' }, s);
      expect(r.ok, JSON.stringify(r.error)).toBe(true); // older schema backup is migrated on the way in
      s = await login(env);
      expect(env.backend.schemaVersionNow).toBe(next);
      expect((await env.call('backup.restore', { filePath: bk.filePath, password: ADMIN.password, confirmation: 'RESTORE' }, s)).ok).toBe(true);
      s = await login(env);
      expect(financialSnapshot(env).tb).toEqual(before.tb);
    } finally {
      closeAll();
    }
  });
});
