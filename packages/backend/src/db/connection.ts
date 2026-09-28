import { Database, type Db } from './driver';

export interface OpenDatabaseOptions {
  /** File path, or ':memory:' for tests. Must be on a local disk (see assertLocalPath). */
  path: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  /**
   * 32-byte data key for encryption at rest (SQLCipher v4 format). Key
   * management (DPAPI + recovery passphrase) is specified in
   * docs/phase-1/encryption-and-keys.md and enabled in Phase 10.
   */
  encryptionKey?: Buffer;
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
      if (opts.encryptionKey.length !== 32) throw new Error('encryption key must be 32 bytes');
      db.pragma(`cipher='sqlcipher'`);
      db.pragma('legacy=4');
      // Hex digits only — no user text is ever interpolated into this pragma.
      db.pragma(`hexkey='${opts.encryptionKey.toString('hex')}'`);
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
