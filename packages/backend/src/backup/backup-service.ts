import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { inflateSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import { DomainError, ErrorCode } from '@airdesk/domain';
import { AuditLog } from '../audit/audit-log';
import { openDatabase, rekeyDatabase } from '../db/connection';
import type { Db } from '../db/driver';
import { runMigrations, schemaVersion, type Migration } from '../db/migrator';
import { runIntegrityChecks, type AuditAnchor } from '../integrity/integrity-service';
import { deriveSubKey, matchesKeyCheck, recoveryWrapSchema, seal, unseal, unwrapDataKeySync, type RecoveryWrap } from '../security/keyring';
import { databaseFileKind } from '../security/vault';
import { canonicalJson } from '../util/json';
import type { Clock } from '../util/clock';

export const BACKUP_EXTENSION = '.adbk';
export type BackupKind = 'MANUAL' | 'SCHEDULED' | 'ON_EXIT' | 'PRE_MIGRATION' | 'PRE_RESTORE';
const KINDS = ['MANUAL', 'SCHEDULED', 'ON_EXIT', 'PRE_MIGRATION', 'PRE_RESTORE'] as const;

/**
 * What a backup says about the data inside it. For encrypted backups these
 * details are sealed (AES-256-GCM under a key derived from the data key), so
 * the file reveals nothing about the company without the key.
 */
const factsSchema = z.object({
  companyName: z.string().nullable(),
  createdBy: z.string().nullable(),
  counts: z.object({ documents: z.number().int(), users: z.number().int(), auditRecords: z.number().int() }),
  auditHeadHash: z.string(),
  auditSeq: z.number().int().min(0).optional(),
  trialBalance: z.object({ debit: z.number().int(), credit: z.number().int() }),
});
type Facts = z.infer<typeof factsSchema>;

const publicFields = {
  product: z.literal('AirDesk'),
  appVersion: z.string(),
  schemaVersion: z.number().int().min(1),
  installationId: z.string().nullable(),
  createdAt: z.string(),
  kind: z.enum(KINDS),
  dbSha256: z.string().regex(/^[0-9a-f]{64}$/),
  dbSizeBytes: z.number().int().positive(),
};

/** Format 1: plain database (1.0.0-rc.1 and installations that have not enabled encryption). */
const manifestV1Schema = z.object({ format: z.literal(1), ...publicFields, encrypted: z.literal(false), ...factsSchema.shape });
/** Format 2: encrypted database + the recovery wrap of its key + sealed facts. */
const manifestV2Schema = z.object({
  format: z.literal(2),
  ...publicFields,
  encrypted: z.literal(true),
  keyWrap: recoveryWrapSchema,
  sealed: z.object({ iv: z.string(), ciphertext: z.string(), tag: z.string() }),
});
const manifestSchema = z.discriminatedUnion('format', [manifestV1Schema, manifestV2Schema]);
type ManifestV2 = z.infer<typeof manifestV2Schema>;

/** Everything known about a backup once it has been opened (public fields + facts). */
export type BackupManifest = z.infer<typeof manifestV1Schema> extends infer V1
  ? Omit<V1, 'format' | 'encrypted'> & { format: 1 | 2; encrypted: boolean; keyId: string | null }
  : never;

/** What can be read from a backup without any key (shown before asking for a passphrase). */
export interface BackupHeader {
  format: 1 | 2;
  encrypted: boolean;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  kind: BackupKind;
  keyId: string | null;
  keyCreatedAt: string | null;
  keyWrap?: RecoveryWrap | null;
}

export interface BackupResult {
  id: string;
  filePath: string;
  sha256: string;
  sizeBytes: number;
  manifest: BackupManifest;
}

export interface ValidatedBackup {
  manifest: BackupManifest;
  /** Integrity-checked copy ready to be swapped in (caller owns it), in the target key. */
  tempDbPath: string;
  /** Present for an encrypted backup opened with its passphrase: its own key and wrap (hex). */
  backupKeyHex: string | null;
  backupWrap: RecoveryWrap | null;
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const hexKey = (hex: string | null | undefined): Buffer | null => (hex ? Buffer.from(hex, 'hex') : null);

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

function describe(db: Db): { schemaVersion: number; installationId: string | null } & Omit<Facts, 'createdBy'> {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const inst = db.prepare('SELECT id FROM installation LIMIT 1').get() as { id: string } | undefined;
  const company = db.prepare('SELECT legal_name_ar FROM company_profile WHERE id = 1').get() as { legal_name_ar: string } | undefined;
  const head = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined;
  const tb = db.prepare('SELECT COALESCE(SUM(debit_base_minor),0) AS d, COALESCE(SUM(credit_base_minor),0) AS c FROM journal_line').get() as { d: number; c: number };
  return {
    schemaVersion: schemaVersion(db),
    installationId: inst?.id ?? null,
    companyName: company?.legal_name_ar ?? null,
    counts: { documents: n('SELECT COUNT(*) AS n FROM fin_document'), users: n('SELECT COUNT(*) AS n FROM app_user'), auditRecords: n('SELECT COUNT(*) AS n FROM audit_log') },
    auditHeadHash: head?.hash ?? '0'.repeat(64),
    auditSeq: head?.seq ?? 0,
    trialBalance: { debit: tb.d, credit: tb.c },
  };
}

// ───────────────────────── snapshot (main thread) ─────────────────────────

/**
 * Consistent copy of the live database while the app keeps running.
 * WAL mode: after a TRUNCATE checkpoint the main file holds every committed
 * transaction and, with automatic checkpoints paused, nothing writes to it
 * until the copy is done (new commits only append to the WAL). The copy runs
 * on the libuv thread pool, so the app stays responsive. Works identically
 * for encrypted databases: the copy stays encrypted with the same key.
 */
export async function snapshotDatabase(db: Db, livePath: string, snapshotPath: string): Promise<void> {
  const mode = String(db.pragma('journal_mode', { simple: true }));
  if (mode !== 'wal') {
    db.pragma('wal_checkpoint(TRUNCATE)');
    copyFileSync(livePath, snapshotPath);
    return;
  }
  db.pragma('wal_autocheckpoint = 0');
  try {
    let busy = 1;
    for (let attempt = 0; attempt < 20 && busy; attempt++) {
      busy = (db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[])[0]?.busy ?? 1;
      if (busy) await new Promise((r) => setTimeout(r, 50));
    }
    if (busy) throw new DomainError(ErrorCode.BACKUP_INVALID, 'The database is busy; the backup could not take a consistent copy');
    await copyFile(livePath, snapshotPath);
  } finally {
    db.pragma('wal_autocheckpoint = 1000');
  }
}

// ───────────────────────── jobs (worker thread or in-process) ─────────────────────────

export interface PackageJob {
  type: 'package';
  snapshotPath: string;
  finalPath: string;
  tempDir: string;
  kind: BackupKind;
  appVersion: string;
  createdBy: string | null;
  createdAt: string;
  keyHex: string | null;
  keyWrap: RecoveryWrap | null;
  maxSchemaVersion: number;
}

export interface ValidateJob {
  type: 'validate';
  filePath: string;
  tempDir: string;
  maxSchemaVersion: number;
  /** The installation's current key (null for a plain installation). */
  currentKeyHex: string | null;
  /** Recovery passphrase of the backup when it was made with another key. */
  passphrase?: string | null;
  /**
   * What the restored copy must be encrypted with: 'KEEP' (the backup's own
   * key / plain), or a key to re-encrypt to. Ignored when keepTemp is false.
   */
  target: 'KEEP' | { rekeyToHex: string };
  keepTemp: boolean;
}

export interface InspectJob {
  type: 'inspect';
  filePath: string;
  /** Launcher only: return the (passphrase-protected) key wrap too, to unlock a database whose key file is lost. */
  includeKeyWrap?: boolean;
}

export interface EncryptCopyJob {
  type: 'encrypt-copy';
  path: string;
  keyHex: string;
}

export interface IntegrityJob {
  type: 'integrity';
  dbPath: string;
  keyHex: string | null;
  anchors: AuditAnchor[];
  ranAt: string;
}

export type BackendJob = PackageJob | ValidateJob | InspectJob | EncryptCopyJob | IntegrityJob;

export interface PackageJobResult {
  sha256: string;
  sizeBytes: number;
  manifest: BackupManifest;
}

/** Runs one heavy job synchronously. Called inside the worker thread (or in-process in tests). */
export function runBackendJob(job: BackendJob): unknown {
  switch (job.type) {
    case 'package':
      return packageBackup(job);
    case 'validate':
      return validateBackup(job);
    case 'inspect':
      return inspectBackup(job.filePath, job.includeKeyWrap ?? false);
    case 'encrypt-copy':
      return encryptCopy(job);
    case 'integrity': {
      const db = openDatabase({ path: job.dbPath, readonly: true, fileMustExist: true, encryptionKey: hexKey(job.keyHex) });
      try {
        // One read transaction: every check sees the same committed state.
        return db.transaction(() => runIntegrityChecks(db, new AuditLog(db, { now: () => new Date(job.ranAt) }, () => 'unused'), { now: () => new Date(job.ranAt) }, { anchors: job.anchors }))();
      } finally {
        db.close();
      }
    }
  }
}

function packageBackup(job: PackageJob): PackageJobResult {
  const key = hexKey(job.keyHex);
  if (key && !job.keyWrap) throw new DomainError(ErrorCode.BACKUP_INVALID, 'Backup failed: the recovery key of this installation is missing');
  const partPath = `${job.finalPath}.part`;
  try {
    // Describe the snapshot for the manifest. Its full integrity check happens once, below,
    // on the finished file (the same bytes), before the backup is reported successful.
    const snap = openDatabase({ path: job.snapshotPath, fileMustExist: true, wal: false, encryptionKey: key });
    let facts: ReturnType<typeof describe>;
    try {
      const quick = (snap.pragma('quick_check') as { quick_check: string }[]).map((r) => r.quick_check).join('; ');
      if (quick !== 'ok') throw new DomainError(ErrorCode.BACKUP_INVALID, `Snapshot failed integrity check: ${quick}`);
      facts = describe(snap);
    } finally {
      snap.close();
    }
    const bytes = readFileSync(job.snapshotPath);
    if (key && databaseFileKind(job.snapshotPath) !== 'ENCRYPTED') throw new DomainError(ErrorCode.BACKUP_INVALID, 'Backup refused: the snapshot is not encrypted');
    const pub = {
      product: 'AirDesk' as const, appVersion: job.appVersion, schemaVersion: facts.schemaVersion, installationId: facts.installationId,
      createdAt: job.createdAt, kind: job.kind, dbSha256: sha256(bytes), dbSizeBytes: bytes.length,
    };
    const detail: Facts = { companyName: facts.companyName, createdBy: job.createdBy, counts: facts.counts, auditHeadHash: facts.auditHeadHash, auditSeq: facts.auditSeq, trialBalance: facts.trialBalance };
    const manifestJson = key
      ? { format: 2, ...pub, encrypted: true, keyWrap: job.keyWrap!, sealed: seal(deriveSubKey(key, 'backup manifest'), Buffer.from(canonicalJson(detail)), sealAad(job.keyWrap!, pub)) }
      : { format: 1, ...pub, encrypted: false, ...detail };
    // Encrypted pages do not compress: store them (level 0) instead of wasting CPU.
    const zipped = zipSync(
      { 'manifest.json': strToU8(JSON.stringify(manifestJson, null, 2)), 'database.sqlite': new Uint8Array(bytes) },
      { level: key ? 0 : 6 },
    );
    // Durable write + atomic rename: a crash never leaves a half file with the final name.
    mkdirSync(dirname(job.finalPath), { recursive: true });
    writeFileDurably(partPath, zipped);
    renameSync(partPath, job.finalPath);
    // Prove it restores: full validation from the file on disk.
    const validated = validateBackup({
      type: 'validate', filePath: job.finalPath, tempDir: job.tempDir, maxSchemaVersion: job.maxSchemaVersion, currentKeyHex: job.keyHex, target: 'KEEP', keepTemp: false,
    });
    return { sha256: sha256(zipped), sizeBytes: zipped.length, manifest: validated.manifest };
  } catch (e) {
    rmSync(partPath, { force: true });
    rmSync(job.finalPath, { force: true });
    throw e instanceof DomainError ? e : new DomainError(ErrorCode.BACKUP_INVALID, `Backup failed: ${(e as Error).message}`);
  }
}

/** Binds the sealed facts to every public field AND the key wrap: altering any of them makes the backup unreadable. */
const sealAad = (wrap: RecoveryWrap, pub: Record<string, unknown>) => Buffer.from(`AirDesk backup v2|${canonicalJson(wrap)}|${canonicalJson(pub)}`, 'utf8');

const bad = (msg: string, details?: Record<string, unknown>): never => {
  throw new DomainError(ErrorCode.BACKUP_INVALID, msg, details);
};

function readContainer(filePath: string): { manifest: z.infer<typeof manifestSchema>; dbBytes: Uint8Array } {
  if (!existsSync(filePath)) bad('Backup file not found');
  let files: ReturnType<typeof unzipSync> | null = null;
  try {
    files = unzipSync(new Uint8Array(readFileSync(filePath)));
  } catch {
    files = null;
  }
  if (!files) return bad('The file is not a valid AirDesk backup (damaged or wrong format)');
  const rawManifest = files['manifest.json'];
  const dbBytes = files['database.sqlite'];
  if (!rawManifest || !dbBytes) bad('Backup is missing its manifest or database');
  try {
    return { manifest: manifestSchema.parse(JSON.parse(strFromU8(rawManifest!))), dbBytes: dbBytes! };
  } catch {
    return bad('Backup manifest is invalid');
  }
}

/**
 * Reads only the manifest (the first entry AirDesk writes) from the start of a
 * backup file, without loading the database part. Returns null when the file
 * is not laid out that way (then callers treat it as unknown).
 */
export function quickBackupIsEncrypted(filePath: string): boolean | null {
  const fd = openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(256 * 1024);
    const n = readSync(fd, head, 0, head.length, 0);
    if (n < 30 || head.readUInt32LE(0) !== 0x04034b50) return null;
    const method = head.readUInt16LE(8);
    const size = head.readUInt32LE(18);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const name = head.subarray(30, 30 + nameLen).toString('utf8');
    const start = 30 + nameLen + extraLen;
    if (name !== 'manifest.json' || start + size > n) return null;
    const raw = head.subarray(start, start + size);
    const json = method === 0 ? raw : method === 8 ? Buffer.from(inflateSync(raw)) : null;
    if (!json) return null;
    const m = JSON.parse(json.toString('utf8')) as { encrypted?: unknown };
    return typeof m.encrypted === 'boolean' ? m.encrypted : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function inspectBackup(filePath: string, includeKeyWrap = false): BackupHeader {
  const { manifest: m } = readContainer(filePath);
  return {
    format: m.format, encrypted: m.encrypted, appVersion: m.appVersion, schemaVersion: m.schemaVersion, createdAt: m.createdAt, kind: m.kind,
    keyId: m.format === 2 ? m.keyWrap.keyId : null, keyCreatedAt: m.format === 2 ? m.keyWrap.createdAt : null,
    ...(includeKeyWrap ? { keyWrap: m.format === 2 ? m.keyWrap : null } : {}),
  };
}

function unsealFacts(m: ManifestV2, key: Buffer): Facts {
  const pub = {
    product: m.product, appVersion: m.appVersion, schemaVersion: m.schemaVersion, installationId: m.installationId, createdAt: m.createdAt,
    kind: m.kind, dbSha256: m.dbSha256, dbSizeBytes: m.dbSizeBytes,
  };
  try {
    return factsSchema.parse(JSON.parse(unseal(deriveSubKey(key, 'backup manifest'), m.sealed, sealAad(m.keyWrap, pub)).toString('utf8')));
  } catch {
    return bad('Backup manifest has been altered or does not belong to this key');
  }
}

/**
 * Validates a backup file end to end: container, manifest (authenticated for
 * encrypted backups), SHA-256 of the database, SQLite integrity and foreign
 * keys, schema version (refuses newer), audit hash chain and trial balance.
 * With keepTemp it leaves a checked copy, encrypted with the target key.
 */
export function validateBackup(job: ValidateJob): ValidatedBackup {
  const { manifest: m, dbBytes } = readContainer(job.filePath);
  if (sha256(dbBytes) !== m.dbSha256 || dbBytes.length !== m.dbSizeBytes) bad('Backup content does not match its checksum (corrupted)');
  if (m.schemaVersion > job.maxSchemaVersion) {
    bad('This backup was made by a newer version of AirDesk', { backupSchema: m.schemaVersion, appSchema: job.maxSchemaVersion });
  }

  let backupKey: Buffer | null = null;
  let facts: Facts;
  let passphraseUsed = false;
  if (m.format === 2) {
    const current = hexKey(job.currentKeyHex);
    if (current && matchesKeyCheck(current, m.keyWrap.keyCheck)) backupKey = current;
    else if (job.passphrase) {
      backupKey = unwrapDataKeySync(m.keyWrap, job.passphrase);
      passphraseUsed = true;
    } else {
      throw new DomainError(ErrorCode.PASSPHRASE_REQUIRED, 'This backup was protected with another recovery passphrase', { keyCreatedAt: m.keyWrap.createdAt });
    }
    facts = unsealFacts(m, backupKey);
  } else {
    facts = { companyName: m.companyName, createdBy: m.createdBy, counts: m.counts, auditHeadHash: m.auditHeadHash, trialBalance: m.trialBalance, ...(m.auditSeq !== undefined ? { auditSeq: m.auditSeq } : {}) };
  }

  mkdirSync(job.tempDir, { recursive: true });
  const tempDbPath = join(job.tempDir, `.restore-check-${basename(job.filePath).replace(/[^A-Za-z0-9.-]/g, '_')}-${Date.now()}-${process.pid}.sqlite`);
  writeFileDurably(tempDbPath, dbBytes);
  try {
    if (backupKey && databaseFileKind(tempDbPath) !== 'ENCRYPTED') bad('Encrypted backup contains an unencrypted database');
    let db: Db;
    try {
      db = openDatabase({ path: tempDbPath, fileMustExist: true, wal: false, encryptionKey: backupKey });
    } catch {
      return bad('Backup database cannot be opened (damaged)');
    }
    try {
      let report;
      try {
        report = runIntegrityChecks(db, new AuditLog(db, { now: () => new Date() }, () => 'unused'), { now: () => new Date() });
      } catch (e) {
        return bad(`Backup database failed integrity checks (${(e as Error).message})`);
      }
      const failed = report.checks.filter((c) => !c.ok);
      if (failed.length) bad('Backup database failed integrity checks', { failed: failed.map((f) => `${f.id}: ${f.details ?? ''}`) });
      if (schemaVersion(db) !== m.schemaVersion) bad('Backup schema version does not match its manifest');
      const actual = describe(db);
      if (actual.auditHeadHash !== facts.auditHeadHash || actual.trialBalance.debit !== facts.trialBalance.debit || actual.counts.documents !== facts.counts.documents) {
        bad('Backup database does not match its manifest');
      }
      if (job.keepTemp && job.target !== 'KEEP') {
        const target = Buffer.from(job.target.rekeyToHex, 'hex');
        if (!backupKey || !backupKey.equals(target)) {
          db.pragma('journal_mode = DELETE');
          rekeyDatabase(db, target);
        }
      }
    } finally {
      db.close();
    }
    if (job.keepTemp && job.target !== 'KEEP') {
      // Prove the converted copy opens with the target key only.
      const check = openDatabase({ path: tempDbPath, fileMustExist: true, wal: false, encryptionKey: Buffer.from(job.target.rekeyToHex, 'hex') });
      try {
        if (String(check.pragma('quick_check', { simple: true })) !== 'ok') bad('Restored copy failed its check after re-encryption');
      } finally {
        check.close();
      }
      if (databaseFileKind(tempDbPath) !== 'ENCRYPTED') bad('Restored copy is not encrypted');
    }
  } catch (e) {
    rmSync(tempDbPath, { force: true });
    rmSync(`${tempDbPath}-journal`, { force: true });
    throw e;
  }
  if (!job.keepTemp) rmSync(tempDbPath, { force: true });
  const manifest: BackupManifest = {
    product: m.product, appVersion: m.appVersion, schemaVersion: m.schemaVersion, installationId: m.installationId, createdAt: m.createdAt, kind: m.kind,
    dbSha256: m.dbSha256, dbSizeBytes: m.dbSizeBytes, format: m.format, encrypted: m.encrypted, keyId: m.format === 2 ? m.keyWrap.keyId : null, ...facts,
  };
  return {
    manifest,
    tempDbPath,
    backupKeyHex: passphraseUsed && backupKey ? backupKey.toString('hex') : null,
    backupWrap: m.format === 2 ? m.keyWrap : null,
  };
}

/**
 * Turns a plain working copy into an encrypted one and proves nothing was
 * lost: same schema, document count, trial balance and audit chain head
 * before and after, full integrity check with the key, and the file no
 * longer opens without it.
 */
function encryptCopy(job: EncryptCopyJob): { before: ReturnType<typeof describe>; after: ReturnType<typeof describe> } {
  const key = Buffer.from(job.keyHex, 'hex');
  const plain = openDatabase({ path: job.path, fileMustExist: true, wal: false });
  let before: ReturnType<typeof describe>;
  try {
    before = describe(plain);
    rekeyDatabase(plain, key);
  } finally {
    plain.close();
  }
  if (databaseFileKind(job.path) !== 'ENCRYPTED') throw new DomainError(ErrorCode.INTEGRITY_FAILURE, 'Encryption did not produce an encrypted file');
  const db = openDatabase({ path: job.path, fileMustExist: true, wal: false, encryptionKey: key });
  try {
    const report = runIntegrityChecks(db, new AuditLog(db, { now: () => new Date() }, () => 'unused'), { now: () => new Date() });
    const failed = report.checks.filter((c) => !c.ok);
    if (failed.length) throw new DomainError(ErrorCode.INTEGRITY_FAILURE, 'Encrypted copy failed integrity checks', { failed: failed.map((f) => f.id) });
    const after = describe(db);
    if (canonicalJson(before) !== canonicalJson(after)) throw new DomainError(ErrorCode.INTEGRITY_FAILURE, 'Encrypted copy does not match the original');
    return { before, after };
  } finally {
    db.close();
  }
}

// ───────────────────────── swap (crash-safe) ─────────────────────────

interface SwapMarker {
  livePath: string;
  /** Where the previous live database was moved to. */
  preRestorePath: string;
  incomingPath: string;
  step: 'SWAPPING' | 'VERIFYING';
  /** RESTORE keeps the previous database file; ENCRYPT deletes the plain previous file once verified. */
  kind?: 'RESTORE' | 'ENCRYPT';
  /** keyId of the key the incoming database opens with (null: plain). */
  incomingKeyId?: string | null;
}

const markerPath = (livePath: string) => join(dirname(livePath), 'restore-pending.json');
const sidecars = ['', '-wal', '-shm', '-journal'];

function moveDbFiles(from: string, to: string): void {
  for (const s of sidecars) if (existsSync(from + s)) renameSync(from + s, to + s);
}

function removeDbFiles(path: string): void {
  for (const s of sidecars) rmSync(path + s, { force: true });
}

/** Brings an older backup up to the current schema on the working copy, never on the live file. */
export function migrateWorkingCopy(path: string, key: Buffer | null, migrations: readonly Migration[], appVersion: string, clock: Clock): void {
  const incoming = openDatabase({ path, fileMustExist: true, encryptionKey: key });
  try {
    runMigrations(incoming, migrations, { appVersion, now: () => clock.now().toISOString() });
    incoming.pragma('wal_checkpoint(TRUNCATE)');
    incoming.pragma('journal_mode = DELETE');
  } finally {
    incoming.close();
  }
}

/**
 * Puts a prepared database in place of the live one. The caller must have
 * closed every connection to livePath. Crash-safe: a marker file records the
 * step so recoverPendingRestore() can finish or roll back on next start.
 */
export function swapInDatabase(opts: {
  livePath: string;
  incomingPath: string;
  incomingKey: Buffer | null;
  incomingKeyId: string | null;
  kind: 'RESTORE' | 'ENCRYPT';
  clock: Clock;
}): { preRestorePath: string } {
  const { livePath } = opts;
  const stamp = opts.clock.now().toISOString().replace(/[-:.]/g, '');
  const preRestorePath = `${livePath}.pre-${opts.kind === 'ENCRYPT' ? 'encryption' : 'restore'}-${stamp}`;
  const marker: SwapMarker = { livePath, preRestorePath, incomingPath: opts.incomingPath, step: 'SWAPPING', kind: opts.kind, incomingKeyId: opts.incomingKeyId };
  writeFileDurably(markerPath(livePath), Buffer.from(JSON.stringify(marker)));
  try {
    moveDbFiles(livePath, preRestorePath);
    moveDbFiles(opts.incomingPath, livePath);
    writeFileDurably(markerPath(livePath), Buffer.from(JSON.stringify({ ...marker, step: 'VERIFYING' })));
    const check = openDatabase({ path: livePath, fileMustExist: true, encryptionKey: opts.incomingKey });
    try {
      const qc = (check.pragma('quick_check') as { quick_check: string }[])[0]?.quick_check;
      if (qc !== 'ok') throw new DomainError(ErrorCode.BACKUP_INVALID, 'Swapped-in database failed quick_check');
    } finally {
      check.close();
    }
    finish(marker);
    return { preRestorePath };
  } catch (e) {
    rollback(marker);
    throw e;
  }
}

/** Kept for existing callers/tests: restore of a validated backup (plain or already in the live key). */
export function swapInRestoredDatabase(opts: {
  livePath: string;
  validated: ValidatedBackup;
  migrations: readonly Migration[];
  appVersion: string;
  clock: Clock;
  key?: Buffer | null;
  keyId?: string | null;
}): { preRestorePath: string } {
  migrateWorkingCopy(opts.validated.tempDbPath, opts.key ?? null, opts.migrations, opts.appVersion, opts.clock);
  return swapInDatabase({ livePath: opts.livePath, incomingPath: opts.validated.tempDbPath, incomingKey: opts.key ?? null, incomingKeyId: opts.keyId ?? null, kind: 'RESTORE', clock: opts.clock });
}

function finish(m: SwapMarker): void {
  // The plain database that was just encrypted must not stay on disk.
  if (m.kind === 'ENCRYPT') removeDbFiles(m.preRestorePath);
  rmSync(markerPath(m.livePath), { force: true });
}

function rollback(m: SwapMarker): void {
  if (existsSync(m.preRestorePath)) {
    removeDbFiles(m.livePath);
    moveDbFiles(m.preRestorePath, m.livePath);
  }
  removeDbFiles(m.incomingPath);
  rmSync(markerPath(m.livePath), { force: true });
}

export function pendingSwap(livePath: string): SwapMarker | null {
  const mp = markerPath(livePath);
  if (!existsSync(mp)) return null;
  try {
    return JSON.parse(readFileSync(mp, 'utf8')) as SwapMarker;
  } catch {
    return { livePath, preRestorePath: `${livePath}.pre-restore-unknown`, incomingPath: `${livePath}.incoming-unknown`, step: 'SWAPPING' };
  }
}

/**
 * Startup recovery for a restore/encryption interrupted by a crash or power
 * loss (EC-X07): if the live database verifies, the operation is finished;
 * otherwise the previous database is put back. When the incoming database is
 * encrypted its key is needed to verify it; without it the marker is left in
 * place ('NEEDS_KEY') and recovery runs again once the key is unlocked.
 */
export function recoverPendingRestore(livePath: string, keyFor: (keyId: string) => Buffer | null = () => null): 'NONE' | 'COMPLETED' | 'ROLLED_BACK' | 'NEEDS_KEY' {
  const m = pendingSwap(livePath);
  if (!m) return 'NONE';
  if (m.step === 'VERIFYING' && existsSync(livePath)) {
    const key = m.incomingKeyId ? keyFor(m.incomingKeyId) : null;
    if (m.incomingKeyId && !key) return 'NEEDS_KEY';
    try {
      const db = openDatabase({ path: livePath, fileMustExist: true, encryptionKey: key });
      const ok = (db.pragma('quick_check') as { quick_check: string }[])[0]?.quick_check === 'ok';
      db.close();
      if (ok) {
        finish(m);
        return 'COMPLETED';
      }
    } catch {
      /* fall through to rollback */
    }
  }
  rollback(m);
  return 'ROLLED_BACK';
}

// ───────────────────────── history & anchors ─────────────────────────

const HISTORY_FILE = 'backup-history.jsonl';

/** Append-only history outside the database, so it survives a restore. */
export function appendBackupHistory(dataDir: string, entry: Record<string, unknown>): void {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(join(dataDir, HISTORY_FILE), `${JSON.stringify(entry)}\n`);
}

/**
 * Audit-chain anchors recorded outside the database since the last restore
 * (successful backups and the restore itself record the chain head). The
 * integrity check proves the chain still contains them: history cannot be cut
 * off or rewritten before an anchor without also editing this file.
 */
export function auditAnchors(dataDir: string): AuditAnchor[] {
  const path = join(dataDir, HISTORY_FILE);
  if (!existsSync(path)) return [];
  let anchors: AuditAnchor[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e: { kind?: string; status?: string; auditSeq?: unknown; auditHeadHash?: unknown; at?: string };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.kind === 'RESTORE' || e.kind === 'NEW_INSTALLATION_RESTORE') anchors = [];
    if (e.status === 'SUCCEEDED' && typeof e.auditSeq === 'number' && typeof e.auditHeadHash === 'string') {
      anchors.push({ seq: e.auditSeq, hash: e.auditHeadHash, at: e.at ?? null });
    }
  }
  return anchors;
}

export function fileSize(path: string): number {
  return statSync(path).size;
}

/** Test/compat helper: synchronous validation of a backup that needs no passphrase. */
export function validateBackupFile(filePath: string, opts: { maxSchemaVersion: number; tempDir: string; keyHex?: string | null }): ValidatedBackup {
  return validateBackup({ type: 'validate', filePath, tempDir: opts.tempDir, maxSchemaVersion: opts.maxSchemaVersion, currentKeyHex: opts.keyHex ?? null, target: 'KEEP', keepTemp: true });
}

/** Writes a small file durably (used for markers and key files by callers). */
export function writeSmallFileDurably(path: string, text: string): void {
  writeFileDurably(path, Buffer.from(text, 'utf8'));
}

