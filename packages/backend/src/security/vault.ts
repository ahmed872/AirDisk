import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError, ErrorCode } from '@airdesk/domain';
import type { Db } from '../db/driver';
import type { Logger } from '../util/logger';
import {
  PRODUCTION_KDF,
  generateDataKey,
  matchesKeyCheck,
  newKeyId,
  parseRecoveryWrap,
  unwrapDataKey,
  wrapDataKey,
  type KdfParams,
  type RecoveryWrap,
} from './keyring';

export const KEY_FILE_NAME = 'airdesk.key';
/** A key waiting for a database swap to finish (see stage()/promote()). */
export const STAGED_KEY_FILE_NAME = 'airdesk.key.incoming';
const SQLITE_HEADER = 'SQLite format 3\u0000';

/**
 * Operating-system protection of the data key for the current OS user
 * (Windows DPAPI through Electron safeStorage). Implementations must never
 * write the key unprotected. `isAvailable() === false` means every start-up
 * needs the recovery passphrase (e.g. Linux without a keyring).
 */
export interface DeviceKeyStore {
  readonly kind: string;
  isAvailable(): boolean;
  load(keyId: string): Buffer | null;
  save(keyId: string, dk: Buffer): void;
  forget(keyId: string): void;
  /** keyIds this OS user has saved (used when the key file next to the database is missing). */
  list(): string[];
}

/** No OS key protection: the passphrase is asked at every start. */
export const NO_DEVICE_KEYS: DeviceKeyStore = {
  kind: 'none',
  isAvailable: () => false,
  load: () => null,
  save: () => undefined,
  forget: () => undefined,
  list: () => [],
};

export type DatabaseFileKind = 'MISSING' | 'EMPTY' | 'PLAIN' | 'ENCRYPTED';

/** A plain SQLite file starts with a fixed header; an encrypted one looks like random bytes. */
export function databaseFileKind(path: string): DatabaseFileKind {
  if (!existsSync(path)) return 'MISSING';
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    if (n === 0) return 'EMPTY';
    return buf.subarray(0, n).toString('latin1') === SQLITE_HEADER ? 'PLAIN' : 'ENCRYPTED';
  } finally {
    closeSync(fd);
  }
}

function writeJsonDurably(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    writeSync(fd, data, 0, data.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Holds the unlocked data key for one data directory and keeps the three
 * copies of its recovery wrap in step (key file, database, backups). The key
 * never leaves the process except to the backup worker thread, is never
 * logged, and is never sent to the renderer.
 */
export class Vault {
  private dk: Buffer | null = null;
  private wrap: RecoveryWrap | null = null;

  constructor(
    readonly dataDir: string,
    readonly deviceKeys: DeviceKeyStore,
    readonly kdf: KdfParams = PRODUCTION_KDF,
    private readonly logger?: Logger,
  ) {}

  get keyFilePath(): string {
    return join(this.dataDir, KEY_FILE_NAME);
  }

  /** The unlocked data key, or null for a plain (not yet encrypted) database. */
  get dataKey(): Buffer | null {
    return this.dk;
  }

  get recoveryWrap(): RecoveryWrap | null {
    return this.wrap;
  }

  get isUnlocked(): boolean {
    return this.dk !== null;
  }

  get stagedKeyFilePath(): string {
    return join(this.dataDir, STAGED_KEY_FILE_NAME);
  }

  readKeyFile(path = this.keyFilePath): RecoveryWrap | null {
    if (!existsSync(path)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new DomainError(ErrorCode.KEY_FILE_DAMAGED, 'The encryption key file is damaged');
    }
    return parseRecoveryWrap(raw);
  }

  readStagedKeyFile(): RecoveryWrap | null {
    try {
      return this.readKeyFile(this.stagedKeyFilePath);
    } catch {
      return null;
    }
  }

  /**
   * Crash-safe key change around a database swap: the new wrap is written as
   * airdesk.key.incoming (and protected for this OS user) BEFORE the swap, and
   * promoted to airdesk.key only after the swapped-in database verified. Start-up
   * recovery promotes or discards it together with the database (AppLauncher).
   */
  stage(dk: Buffer, wrap: RecoveryWrap): void {
    if (!matchesKeyCheck(dk, wrap.keyCheck)) throw new Error('refusing to stage a wrap that does not match its key');
    writeJsonDurably(this.stagedKeyFilePath, wrap);
    this.saveDeviceKey(dk, wrap.keyId);
  }

  promoteStaged(dk: Buffer): void {
    const wrap = this.readStagedKeyFile();
    if (!wrap || !matchesKeyCheck(dk, wrap.keyCheck)) throw new Error('staged key does not match');
    this.keepReplacedKeyFile(wrap.keyId);
    renameSync(this.stagedKeyFilePath, this.keyFilePath);
    if (this.wrap && this.wrap.keyId !== wrap.keyId) this.forgetDeviceKey(this.wrap.keyId);
    this.dk = dk;
    this.wrap = wrap;
  }

  /**
   * A key file for ANOTHER key is never destroyed by a restore: the database it
   * opens was moved aside (airdesk.db.pre-restore-*), so its key is kept next to it.
   */
  private keepReplacedKeyFile(newKeyId: string): void {
    let existing: RecoveryWrap | null = null;
    try {
      existing = this.readKeyFile();
    } catch {
      existing = null;
    }
    if (existsSync(this.keyFilePath) && existing?.keyId !== newKeyId) {
      renameSync(this.keyFilePath, `${this.keyFilePath}.replaced-${new Date().toISOString().replace(/[-:.]/g, '')}`);
    }
  }

  discardStaged(): void {
    const wrap = this.readStagedKeyFile();
    rmSync(this.stagedKeyFilePath, { force: true });
    if (wrap && wrap.keyId !== this.wrap?.keyId) this.forgetDeviceKey(wrap.keyId);
  }

  /** Loads a key from this OS user's protected store and checks it against a wrap. */
  loadDeviceKey(keyId: string, wrap: RecoveryWrap | null): Buffer | null {
    if (this.dk && this.wrap?.keyId === keyId) return this.dk;
    if (!this.deviceKeys.isAvailable()) return null;
    try {
      const dk = this.deviceKeys.load(keyId);
      if (!dk || dk.length !== 32) return null;
      if (wrap && !matchesKeyCheck(dk, wrap.keyCheck)) return null;
      return dk;
    } catch {
      return null;
    }
  }

  /** Tries the OS-protected copy for this user. Returns false when the passphrase is needed. */
  tryDeviceUnlock(wrap: RecoveryWrap | null, verify: (dk: Buffer) => boolean = () => true): boolean {
    if (!this.deviceKeys.isAvailable()) return false;
    const ids = wrap ? [wrap.keyId] : this.deviceKeys.list();
    for (const id of ids) {
      let dk: Buffer | null = null;
      try {
        dk = this.deviceKeys.load(id);
      } catch (e) {
        this.logger?.warn('Device key could not be read', { keyId: id, error: (e as Error).message });
      }
      if (!dk || dk.length !== 32) continue;
      if (wrap && !matchesKeyCheck(dk, wrap.keyCheck)) continue;
      // Without a wrap to check against (key file lost), prove the key on the database itself.
      if (!wrap && !verify(dk)) continue;
      this.dk = dk;
      this.wrap = wrap;
      return true;
    }
    return false;
  }

  async unlockWithPassphrase(wrap: RecoveryWrap, passphrase: string): Promise<void> {
    const dk = await unwrapDataKey(wrap, passphrase);
    this.dk = dk;
    this.wrap = wrap;
  }

  /** Adopts a key proven by other means (e.g. a DK found through the device store; its wrap read from the database). */
  adopt(dk: Buffer, wrap: RecoveryWrap | null): void {
    if (wrap && !matchesKeyCheck(dk, wrap.keyCheck)) throw new DomainError(ErrorCode.KEY_FILE_DAMAGED, 'The key does not match its recovery wrap');
    this.dk = dk;
    this.wrap = wrap;
  }

  /** A new DK wrapped with the passphrase. Nothing is persisted until persist(). */
  async createKey(passphrase: string, now: string): Promise<{ dk: Buffer; wrap: RecoveryWrap }> {
    const dk = generateDataKey();
    const wrap = await wrapDataKey(dk, passphrase, newKeyId(), this.kdf, now);
    return { dk, wrap };
  }

  /** Same DK, new passphrase (old backups keep the passphrase they were made with). */
  async rewrap(passphrase: string, now: string): Promise<RecoveryWrap> {
    if (!this.dk || !this.wrap) throw new DomainError(ErrorCode.CONFLICT, 'Encryption is not enabled');
    return wrapDataKey(this.dk, passphrase, this.wrap.keyId, this.kdf, now);
  }

  /**
   * Makes a key the active one: key file (atomic), OS-protected copy for this
   * user (when available). The database copy is written by syncToDatabase().
   */
  persist(dk: Buffer, wrap: RecoveryWrap): void {
    if (!matchesKeyCheck(dk, wrap.keyCheck)) throw new Error('refusing to persist a wrap that does not match its key');
    this.keepReplacedKeyFile(wrap.keyId);
    writeJsonDurably(this.keyFilePath, wrap);
    this.saveDeviceKey(dk, wrap.keyId);
    if (this.wrap && this.wrap.keyId !== wrap.keyId) this.forgetDeviceKey(this.wrap.keyId);
    this.dk = dk;
    this.wrap = wrap;
  }

  saveDeviceKey(dk: Buffer, keyId: string): void {
    if (!this.deviceKeys.isAvailable()) return;
    try {
      this.deviceKeys.save(keyId, dk);
    } catch (e) {
      // Not fatal: the passphrase will be asked at the next start.
      this.logger?.warn('Could not save the device-protected key', { error: (e as Error).message });
    }
  }

  private forgetDeviceKey(keyId: string): void {
    try {
      this.deviceKeys.forget(keyId);
    } catch {
      /* best effort */
    }
  }

  /** Stores the current recovery wrap inside the database so the key file can be rebuilt from it. */
  syncToDatabase(db: Db, now: string): void {
    if (!this.wrap) return;
    db.prepare(
      `INSERT INTO app_setting (key, value_json, updated_at, updated_by) VALUES ('security.recovery_wrap', ?, ?, NULL)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify(this.wrap), now);
  }

  /** Recovers the wrap from the database when the key file was deleted (the DB was opened through the device key). */
  restoreKeyFileFromDatabase(db: Db): boolean {
    if (!this.dk) return false;
    const row = db.prepare(`SELECT value_json FROM app_setting WHERE key = 'security.recovery_wrap'`).get() as { value_json: string } | undefined;
    if (!row) return false;
    let wrap: RecoveryWrap;
    try {
      wrap = parseRecoveryWrap(JSON.parse(row.value_json));
    } catch {
      return false;
    }
    if (!matchesKeyCheck(this.dk, wrap.keyCheck)) return false;
    writeJsonDurably(this.keyFilePath, wrap);
    this.wrap = wrap;
    return true;
  }

  /** A stale key file next to a plain database (e.g. after a rolled-back encryption) is removed. */
  removeStaleKeyFile(): void {
    rmSync(this.keyFilePath, { force: true });
  }

  /** Forgets the in-memory key without touching files (the database is plain again). */
  clear(): void {
    this.dk = null;
    this.wrap = null;
  }

  /** Replaces the key file with a new wrap of the SAME key (recovery passphrase change). */
  replaceWrap(wrap: RecoveryWrap): void {
    if (!this.dk || !matchesKeyCheck(this.dk, wrap.keyCheck)) throw new Error('wrap does not match the unlocked key');
    writeJsonDurably(this.keyFilePath, wrap);
    this.wrap = wrap;
  }

  lock(): void {
    this.dk?.fill(0);
    this.dk = null;
    this.wrap = null;
  }
}
