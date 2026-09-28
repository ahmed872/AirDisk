import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, appendFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import { DomainError, ErrorCode } from '@airdesk/domain';
import { AuditLog } from '../audit/audit-log';
import { openDatabase } from '../db/connection';
import type { Db } from '../db/driver';
import { runMigrations, schemaVersion, type Migration } from '../db/migrator';
import { runIntegrityChecks } from '../integrity/integrity-service';
import type { Clock } from '../util/clock';
import type { IdGenerator } from '../util/ids';

export const BACKUP_EXTENSION = '.adbk';
export type BackupKind = 'MANUAL' | 'SCHEDULED' | 'ON_EXIT' | 'PRE_MIGRATION' | 'PRE_RESTORE';

const manifestSchema = z.object({
  format: z.literal(1),
  product: z.literal('AirDesk'),
  appVersion: z.string(),
  schemaVersion: z.number().int().min(1),
  installationId: z.string().nullable(),
  companyName: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  kind: z.enum(['MANUAL', 'SCHEDULED', 'ON_EXIT', 'PRE_MIGRATION', 'PRE_RESTORE']),
  dbSha256: z.string().regex(/^[0-9a-f]{64}$/),
  dbSizeBytes: z.number().int().positive(),
  encrypted: z.boolean(),
  counts: z.object({ documents: z.number().int(), users: z.number().int(), auditRecords: z.number().int() }),
  auditHeadHash: z.string(),
  trialBalance: z.object({ debit: z.number().int(), credit: z.number().int() }),
});
export type BackupManifest = z.infer<typeof manifestSchema>;

export interface BackupResult {
  id: string;
  filePath: string;
  sha256: string;
  sizeBytes: number;
  manifest: BackupManifest;
}

export interface ValidatedBackup {
  manifest: BackupManifest;
  /** Decompressed, integrity-checked copy ready to be swapped in (caller owns it). */
  tempDbPath: string;
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

function writeFileDurably(path: string, data: Uint8Array): void {
  const fd = openSync(path, 'w');
  try {
    let offset = 0;
    while (offset < data.length) {
      const n = writeSync(fd, data, offset, data.length - offset);
      if (n <= 0) throw new Error('write made no progress (disk full or device error)');
      offset += n;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function describe(db: Db): Omit<BackupManifest, 'format' | 'product' | 'appVersion' | 'createdAt' | 'createdBy' | 'kind' | 'dbSha256' | 'dbSizeBytes' | 'encrypted'> {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const inst = db.prepare('SELECT id FROM installation LIMIT 1').get() as { id: string } | undefined;
  const company = db.prepare('SELECT legal_name_ar FROM company_profile WHERE id = 1').get() as { legal_name_ar: string } | undefined;
  const head = db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
  const tb = db.prepare('SELECT COALESCE(SUM(debit_base_minor),0) AS d, COALESCE(SUM(credit_base_minor),0) AS c FROM journal_line').get() as { d: number; c: number };
  return {
    schemaVersion: schemaVersion(db),
    installationId: inst?.id ?? null,
    companyName: company?.legal_name_ar ?? null,
    counts: { documents: n('SELECT COUNT(*) AS n FROM fin_document'), users: n('SELECT COUNT(*) AS n FROM app_user'), auditRecords: n('SELECT COUNT(*) AS n FROM audit_log') },
    auditHeadHash: head?.hash ?? '0'.repeat(64),
    trialBalance: { debit: tb.d, credit: tb.c },
  };
}

/**
 * Creates a consistent, verified backup file. Owner decision Q12: a backup is
 * only reported as successful after it has been re-read, hash-checked,
 * decompressed and integrity-checked — i.e. after it has proven restorable.
 */
export async function createBackupFile(opts: {
  db: Db;
  destinationDir: string;
  /** Local directory for the working snapshot (never a network path — see assertLocalPath). */
  workDir: string;
  kind: BackupKind;
  appVersion: string;
  createdBy: string | null;
  clock: Clock;
  newId: IdGenerator;
  maxSchemaVersion: number;
}): Promise<BackupResult> {
  mkdirSync(opts.destinationDir, { recursive: true });
  mkdirSync(opts.workDir, { recursive: true });
  const id = opts.newId();
  const snapshotPath = join(opts.workDir, `.snapshot-${id}.sqlite`);
  const stamp = opts.clock.now().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const finalPath = join(opts.destinationDir, `AirDesk-${stamp}-${opts.kind.toLowerCase()}-${id.slice(-6)}${BACKUP_EXTENSION}`);
  const partPath = `${finalPath}.part`;
  try {
    // 1. Consistent snapshot while the app keeps running (SQLite online backup API).
    await opts.db.backup(snapshotPath);
    // 2. Verify the snapshot itself before packaging it.
    const snap = openDatabase({ path: snapshotPath, fileMustExist: true, wal: false });
    let facts: ReturnType<typeof describe>;
    try {
      const check = (snap.pragma('integrity_check') as { integrity_check: string }[]).map((r) => r.integrity_check).join('; ');
      if (check !== 'ok') throw new DomainError(ErrorCode.BACKUP_INVALID, `Snapshot failed integrity check: ${check}`);
      facts = describe(snap);
    } finally {
      snap.close();
    }
    const bytes = readFileSync(snapshotPath);
    const manifest: BackupManifest = {
      format: 1,
      product: 'AirDesk',
      appVersion: opts.appVersion,
      createdAt: opts.clock.now().toISOString(),
      createdBy: opts.createdBy,
      kind: opts.kind,
      dbSha256: sha256(bytes),
      dbSizeBytes: bytes.length,
      encrypted: false,
      ...facts,
    };
    const zipped = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)), 'database.sqlite': new Uint8Array(bytes) }, { level: 6 });
    // 3. Durable write + atomic rename: a crash never leaves a half file with the final name.
    writeFileDurably(partPath, zipped);
    renameSync(partPath, finalPath);
    // 4. Prove it restores: full validation from the file on disk.
    const validated = validateBackupFile(finalPath, { maxSchemaVersion: opts.maxSchemaVersion, tempDir: opts.workDir });
    rmSync(validated.tempDbPath, { force: true });
    return { id, filePath: finalPath, sha256: sha256(zipped), sizeBytes: zipped.length, manifest };
  } catch (e) {
    rmSync(partPath, { force: true });
    rmSync(finalPath, { force: true });
    throw e instanceof DomainError ? e : new DomainError(ErrorCode.BACKUP_INVALID, `Backup failed: ${(e as Error).message}`);
  } finally {
    rmSync(snapshotPath, { force: true });
    rmSync(`${snapshotPath}-wal`, { force: true });
    rmSync(`${snapshotPath}-shm`, { force: true });
  }
}

/**
 * Validates a backup file end to end: container, manifest, SHA-256 of the
 * database, SQLite integrity and foreign keys, schema version (refuses newer),
 * audit hash chain and trial balance. Leaves a checked temp copy for restore.
 */
export function validateBackupFile(filePath: string, opts: { maxSchemaVersion: number; tempDir: string }): ValidatedBackup {
  const bad = (msg: string, details?: Record<string, unknown>): never => {
    throw new DomainError(ErrorCode.BACKUP_INVALID, msg, details);
  };
  if (!existsSync(filePath)) bad('Backup file not found');
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(readFileSync(filePath)));
  } catch {
    return bad('The file is not a valid AirDesk backup (damaged or wrong format)');
  }
  const rawManifest = files['manifest.json'];
  const dbBytes = files['database.sqlite'];
  if (!rawManifest || !dbBytes) bad('Backup is missing its manifest or database');
  let manifest: BackupManifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(strFromU8(rawManifest!)));
  } catch {
    return bad('Backup manifest is invalid');
  }
  if (manifest.encrypted) bad('Encrypted backups are not supported by this version');
  if (sha256(dbBytes!) !== manifest.dbSha256 || dbBytes!.length !== manifest.dbSizeBytes) bad('Backup content does not match its checksum (corrupted)');
  if (manifest.schemaVersion > opts.maxSchemaVersion) {
    bad('This backup was made by a newer version of AirDesk', { backupSchema: manifest.schemaVersion, appSchema: opts.maxSchemaVersion });
  }

  mkdirSync(opts.tempDir, { recursive: true });
  const tempDbPath = join(opts.tempDir, `.restore-check-${basename(filePath).replace(/[^A-Za-z0-9.-]/g, '_')}-${Date.now()}.sqlite`);
  writeFileDurably(tempDbPath, dbBytes!);
  try {
    const db = openDatabase({ path: tempDbPath, fileMustExist: true, wal: false });
    try {
      const report = runIntegrityChecks(db, new AuditLog(db, { now: () => new Date() }, () => 'unused'), { now: () => new Date() });
      const failed = report.checks.filter((c) => !c.ok);
      if (failed.length) bad('Backup database failed integrity checks', { failed: failed.map((f) => `${f.id}: ${f.details ?? ''}`) });
      if (schemaVersion(db) !== manifest.schemaVersion) bad('Backup schema version does not match its manifest');
    } finally {
      db.close();
    }
  } catch (e) {
    rmSync(tempDbPath, { force: true });
    throw e;
  }
  return { manifest, tempDbPath };
}

interface RestoreMarker {
  livePath: string;
  preRestorePath: string;
  incomingPath: string;
  step: 'SWAPPING' | 'VERIFYING';
}

const markerPath = (livePath: string) => join(dirname(livePath), 'restore-pending.json');
const sidecars = ['', '-wal', '-shm'];

function moveDbFiles(from: string, to: string): void {
  for (const s of sidecars) if (existsSync(from + s)) renameSync(from + s, to + s);
}

/**
 * Swaps a validated database in place of the live one. The caller must have
 * closed every connection to livePath. Crash-safe: a marker file records the
 * step so recoverPendingRestore() can finish or roll back on next start.
 */
export function swapInRestoredDatabase(opts: {
  livePath: string;
  validated: ValidatedBackup;
  migrations: readonly Migration[];
  appVersion: string;
  clock: Clock;
}): { preRestorePath: string } {
  const { livePath } = opts;
  // Bring an older backup up to the current schema on the temp copy, never on the live file.
  const incoming = openDatabase({ path: opts.validated.tempDbPath, fileMustExist: true });
  try {
    runMigrations(incoming, opts.migrations, { appVersion: opts.appVersion, now: () => opts.clock.now().toISOString() });
    incoming.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    incoming.close();
  }
  const stamp = opts.clock.now().toISOString().replace(/[-:.]/g, '');
  const preRestorePath = `${livePath}.pre-restore-${stamp}`;
  const marker: RestoreMarker = { livePath, preRestorePath, incomingPath: opts.validated.tempDbPath, step: 'SWAPPING' };
  writeFileSync(markerPath(livePath), JSON.stringify(marker));
  try {
    moveDbFiles(livePath, preRestorePath);
    moveDbFiles(opts.validated.tempDbPath, livePath);
    writeFileSync(markerPath(livePath), JSON.stringify({ ...marker, step: 'VERIFYING' }));
    const check = openDatabase({ path: livePath, fileMustExist: true });
    try {
      const qc = (check.pragma('quick_check') as { quick_check: string }[])[0]?.quick_check;
      if (qc !== 'ok') throw new DomainError(ErrorCode.BACKUP_INVALID, 'Restored database failed quick_check');
    } finally {
      check.close();
    }
    rmSync(markerPath(livePath), { force: true });
    return { preRestorePath };
  } catch (e) {
    rollback(marker);
    throw e;
  }
}

function rollback(m: RestoreMarker): void {
  if (existsSync(m.preRestorePath)) {
    for (const s of sidecars) rmSync(m.livePath + s, { force: true });
    moveDbFiles(m.preRestorePath, m.livePath);
  }
  rmSync(m.incomingPath, { force: true });
  rmSync(markerPath(m.livePath), { force: true });
}

/**
 * Startup recovery for a restore interrupted by a crash/power loss (EC-X07):
 * if the live database verifies, the restore is finished; otherwise the
 * pre-restore database is put back.
 */
export function recoverPendingRestore(livePath: string): 'NONE' | 'COMPLETED' | 'ROLLED_BACK' {
  const mp = markerPath(livePath);
  if (!existsSync(mp)) return 'NONE';
  const m = JSON.parse(readFileSync(mp, 'utf8')) as RestoreMarker;
  if (m.step === 'VERIFYING' && existsSync(livePath)) {
    try {
      const db = openDatabase({ path: livePath, fileMustExist: true });
      const ok = (db.pragma('quick_check') as { quick_check: string }[])[0]?.quick_check === 'ok';
      db.close();
      if (ok) {
        rmSync(mp, { force: true });
        return 'COMPLETED';
      }
    } catch {
      /* fall through to rollback */
    }
  }
  rollback(m);
  return 'ROLLED_BACK';
}

/** Append-only history outside the database, so it survives a restore. */
export function appendBackupHistory(dataDir: string, entry: Record<string, unknown>): void {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(join(dataDir, 'backup-history.jsonl'), `${JSON.stringify(entry)}\n`);
}

export function fileSize(path: string): number {
  return statSync(path).size;
}
