import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorCode, PERMISSIONS, SEED_CURRENCIES, SYSTEM_ACCOUNTS } from '@airdesk/domain';
import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  createUlidGenerator,
  migrationChecksum,
  openDatabase,
  planMigrations,
  runMigrations,
  schemaVersion,
  seedSystemData,
  validateBackupFile,
  type Migration,
} from '../src';
import { makeBackend, setupCompany, tempDir } from './helpers';

const now = () => '2026-09-28T09:00:00.000Z';
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
  return 'NO_ERROR';
};
const fresh = () => {
  const db = openDatabase({ path: join(tempDir(), 'm.db') });
  return db;
};

describe('migration runner', () => {
  it('builds the full schema from an empty file and records version + checksum', () => {
    const db = fresh();
    const plan = runMigrations(db, MIGRATIONS, { appVersion: 't', now });
    expect(plan.pending.map((m) => m.version)).toEqual([1]);
    expect(schemaVersion(db)).toBe(1);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    const row = db.prepare('SELECT checksum FROM schema_migration WHERE version = 1').get() as { checksum: string };
    expect(row.checksum).toBe(migrationChecksum(MIGRATIONS[0]!.sql));
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`).all() as { name: string }[]).map((t) => t.name);
    for (const t of ['fin_document', 'journal_entry', 'journal_line', 'audit_log', 'app_user', 'role_permission', 'booking', 'flight_segment',
      'ticket', 'schedule_change', 'notification', 'command_log', 'tax_code', 'v_booking_financials', 'search_index']) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('is idempotent: a second run applies nothing', () => {
    const db = fresh();
    runMigrations(db, MIGRATIONS, { appVersion: 't', now });
    expect(runMigrations(db, MIGRATIONS, { appVersion: 't', now }).pending).toHaveLength(0);
    db.close();
  });

  it('refuses to start when an applied migration was modified (checksum mismatch)', () => {
    const db = fresh();
    runMigrations(db, MIGRATIONS, { appVersion: 't', now });
    const tampered: Migration[] = [{ ...MIGRATIONS[0]!, sql: `${MIGRATIONS[0]!.sql}\n-- edited` }];
    expect(codeOf(() => planMigrations(db, tampered))).toBe(ErrorCode.MIGRATION_CHECKSUM_MISMATCH);
    db.close();
  });

  it('refuses to open a database created by a newer version (downgrade protection)', () => {
    const db = fresh();
    const v2: Migration[] = [...MIGRATIONS, { version: 2, name: 'future', sql: 'CREATE TABLE future_thing (id TEXT PRIMARY KEY) STRICT;' }];
    runMigrations(db, v2, { appVersion: 't', now });
    expect(codeOf(() => planMigrations(db, MIGRATIONS))).toBe(ErrorCode.DATABASE_TOO_NEW);
    db.close();
  });

  it('is transaction-safe: a failing migration leaves the database exactly as it was', () => {
    const db = fresh();
    runMigrations(db, MIGRATIONS, { appVersion: 't', now });
    const broken: Migration[] = [
      ...MIGRATIONS,
      { version: 2, name: 'half', sql: 'CREATE TABLE new_table (id TEXT PRIMARY KEY) STRICT; INSERT INTO no_such_table VALUES (1);' },
    ];
    expect(() => runMigrations(db, broken, { appVersion: 't', now })).toThrow();
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'new_table'`).get()).toBeUndefined();
    db.close();
  });

  it('rejects gaps in migration numbering', () => {
    const db = fresh();
    expect(() => planMigrations(db, [{ version: 2, name: 'x', sql: '' }])).toThrow(/numbered/);
    db.close();
  });

  it('uses the durability settings required for financial data', () => {
    const db = fresh();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(2); // FULL
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('refuses network (UNC) database paths', async () => {
    await expect(makeBackend({ dataDir: '\\\\server\\share\\airdesk' })).rejects.toThrow(/local disk/);
  });
});

describe('system seed', () => {
  it('seeds accounts, currencies, permissions, roles and categories idempotently', () => {
    const db = fresh();
    runMigrations(db, MIGRATIONS, { appVersion: 't', now });
    const newId = createUlidGenerator();
    seedSystemData(db, { newId, now: now(), appVersion: 't' });
    const counts = () =>
      ['ledger_account', 'currency', 'permission', 'role', 'role_permission', 'expense_category', 'installation'].map(
        (t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      );
    const first = counts();
    seedSystemData(db, { newId, now: now(), appVersion: 't' });
    expect(counts()).toEqual(first);
    expect(first[0]).toBe(SYSTEM_ACCOUNTS.length);
    expect(first[1]).toBe(SEED_CURRENCIES.length);
    expect(first[2]).toBe(PERMISSIONS.length);
    expect(first[3]).toBe(4);
    const adminPerms = (db.prepare(`SELECT COUNT(*) AS n FROM role_permission rp JOIN role r ON r.id = rp.role_id WHERE r.code = 'ADMIN'`).get() as { n: number }).n;
    expect(adminPerms).toBe(PERMISSIONS.length);
    db.close();
  });

  it('detects drift of a system account instead of silently "fixing" it', () => {
    const db = fresh();
    runMigrations(db, MIGRATIONS, { appVersion: 't', now });
    const newId = createUlidGenerator();
    seedSystemData(db, { newId, now: now(), appVersion: 't' });
    db.prepare(`UPDATE ledger_account SET account_class = 'EXPENSE' WHERE code = '1110'`).run();
    expect(codeOf(() => seedSystemData(db, { newId, now: now(), appVersion: 't' }))).toBe(ErrorCode.INTEGRITY_FAILURE);
    db.close();
  });
});

describe('startup upgrade path', () => {
  it('takes a verified PRE_MIGRATION backup before applying a new migration', async () => {
    const dataDir = tempDir();
    const v1 = await makeBackend({ dataDir });
    await setupCompany(v1);
    v1.backend.close();

    const v2: Migration[] = [...MIGRATIONS, { version: 2, name: 'add_note', sql: 'ALTER TABLE customer ADD COLUMN loyalty_tier TEXT;' }];
    const upgraded = await makeBackend({ dataDir, migrations: v2 });
    expect(upgraded.backend.schemaVersionNow).toBe(2);
    const backups = readdirSync(join(dataDir, 'backups')).filter((f) => f.endsWith('.adbk'));
    expect(backups.some((f) => f.includes('pre_migration'))).toBe(true);
    const validated = validateBackupFile(join(dataDir, 'backups', backups[0]!), { maxSchemaVersion: 2, tempDir: dataDir });
    expect(validated.manifest.schemaVersion).toBe(1);
    expect(existsSync(join(dataDir, 'backup-history.jsonl'))).toBe(true);
  });
});
