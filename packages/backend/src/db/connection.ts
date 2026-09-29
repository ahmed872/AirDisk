import { Database, type Db } from './driver';

export interface OpenDatabaseOptions {
  /** File path, or ':memory:' for tests. Must be on a local disk (see assertLocalPath). */
  path: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  /**
   * 32-byte data key for encryption at rest (SQLCipher v4 format via SQLite3
   * Multiple Ciphers). Key management: security/vault.ts and
   * docs/product/encryption-plan.md.
   */
  encryptionKey?: Buffer | null;
  /** Default true. Backup snapshots use rollback-journal mode so they are a single self-contained file. */
  wal?: boolean;
}

/**
 * Opens a connection with the durability settings required for financial data
 * (Phase 0 §03-1): WAL, synchronous=FULL, foreign keys ON.
 */
export function openDatabase(opts: OpenDatabaseOptions): Db {
  const db = new Database(opts.path, { readonly: opts.readonly ?? false, fileMustExist: opts.fileMustExist ?? false });
  try {
    if (opts.encryptionKey) {
      selectCipher(db);
      // Hex digits only — no user text is ever interpolated into this pragma.
      db.pragma(`hexkey='${keyHex(opts.encryptionKey)}'`);
    }
    // Forces the key to be checked (throws SQLITE_NOTADB on a wrong key).
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    if (!opts.readonly && opts.path !== ':memory:') db.pragma(opts.wal === false ? 'journal_mode = DELETE' : 'journal_mode = WAL');
    if (!opts.readonly) db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

function keyHex(key: Buffer): string {
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes');
  return key.toString('hex');
}

/** SQLCipher v4 page format (AES-256-CBC + HMAC-SHA512 per page, PBKDF2 skipped for raw keys). */
function selectCipher(db: Db): void {
  db.pragma(`cipher='sqlcipher'`);
  db.pragma('legacy=4');
}

/**
 * Re-encrypts an open database in place with a new key (also turns a plain
 * database into an encrypted one). Only ever used on private working copies
 * (snapshot/restore/encryption temp files), never on the live database.
 */
export function rekeyDatabase(db: Db, newKey: Buffer): void {
  selectCipher(db);
  db.pragma(`hexrekey='${keyHex(newKey)}'`);
}

/**
 * SQLite on a network share corrupts data (Phase 0 R2, owner decision Q1).
 * Multi-PC offices use the primary/client model instead. This rejects UNC
 * paths; mapped network drives are detected on Windows by the desktop shell.
 */
export function assertLocalPath(path: string): void {
  if (/^(\\\\|\/\/)/.test(path)) {
    throw new Error(`The database must be on a local disk, not a network path: ${path}`);
  }
}

export function inTransaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)();
}
