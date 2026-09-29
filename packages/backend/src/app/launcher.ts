import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { DomainError, ErrorCode, SEED_CURRENCIES, assertPasswordPolicy, assertRecoveryPassphrase, isDomainError } from '@airdesk/domain';
import { commandSchemas, type BackupHeaderDto, type SystemStatusDto } from '@airdesk/contracts';
import { SYSTEM_ACTOR } from '../audit/audit-log';
import {
  appendBackupHistory,
  migrateWorkingCopy,
  pendingSwap,
  recoverPendingRestore,
  swapInDatabase,
  type BackupHeader,
  type ValidatedBackup,
} from '../backup/backup-service';
import { assertLocalPath, openDatabase } from '../db/connection';
import { MIGRATIONS } from '../db/migrations';
import { PRODUCTION_KDF, type KdfParams, type RecoveryWrap } from '../security/keyring';
import { Vault, databaseFileKind, type DeviceKeyStore } from '../security/vault';
import { systemClock } from '../util/clock';
import { consoleLogger } from '../util/logger';
import { JobRunner } from '../worker/job-runner';
import { AppBackend, DB_FILE_NAME, type BackendOptions } from './backend';
import type { DispatchRequest, DispatchResponse } from './dispatcher';

export interface LauncherOptions extends Omit<BackendOptions, 'vault'> {
  /** OS protection of the data key for the current user (Electron safeStorage/DPAPI). */
  deviceKeys: DeviceKeyStore;
  /** Argon2id cost for new recovery wraps (tests pass TEST_KDF). */
  kdf?: KdfParams;
}

export type LaunchState = 'NEW' | 'LOCKED' | 'READY';
export type LockReason = NonNullable<SystemStatusDto['lockReason']>;

/** Commands answered while the company data is not open. Everything else is refused. */
const PRE_OPEN_COMMANDS = new Set(['system.status', 'system.setup', 'vault.unlock', 'vault.inspectBackup', 'vault.restoreBackup']);

/**
 * Start-up and key handling around AppBackend (docs/product/encryption-plan.md):
 *
 *  - NEW: no database yet. The owner either sets up a new company — which
 *    creates an ENCRYPTED database protected by a recovery passphrase — or
 *    restores a backup (e.g. on a replacement PC) with its recovery passphrase.
 *  - LOCKED: the database is encrypted and this Windows user/PC has no saved
 *    key (first start after reinstalling Windows, another Windows account,
 *    Linux without a keyring) — the recovery passphrase unlocks it; or the
 *    database/key file is damaged — a backup can be restored.
 *  - READY: AppBackend is open; commands go to its dispatcher.
 *
 * Interrupted database swaps (restore, encryption) are finished or rolled back
 * here before anything opens, together with the key that belongs to them.
 */
export class AppLauncher {
  private state: LaunchState = 'NEW';
  private reason: LockReason | undefined;
  private backendInstance: AppBackend | null = null;
  readonly vault: Vault;
  private readonly jobs: JobRunner;
  private failedUnlocks = 0;
  private unlockNotBefore = 0;

  private constructor(private readonly opts: LauncherOptions) {
    this.vault = new Vault(opts.dataDir, opts.deviceKeys, opts.kdf ?? PRODUCTION_KDF, opts.logger ?? consoleLogger);
    this.jobs = new JobRunner(opts.workerPath ?? null, opts.logger);
  }

  static async start(opts: LauncherOptions): Promise<AppLauncher> {
    assertLocalPath(opts.dataDir);
    mkdirSync(opts.dataDir, { recursive: true });
    const launcher = new AppLauncher(opts);
    await launcher.resolve();
    return launcher;
  }

  get launchState(): LaunchState {
    return this.state;
  }

  get lockReason(): LockReason | undefined {
    return this.reason;
  }

  /** The open backend (READY) or null. */
  get backend(): AppBackend | null {
    return this.backendInstance;
  }

  private get livePath(): string {
    return join(this.opts.dataDir, DB_FILE_NAME);
  }

  private get logger() {
    return this.opts.logger ?? consoleLogger;
  }

  private get clock() {
    return this.opts.clock ?? systemClock;
  }

  /** Re-reads the state (it changes inside awaited helpers, which the compiler cannot see). */
  private isReady(): boolean {
    return this.state === 'READY' && this.backendInstance !== null;
  }

  private lock(reason: LockReason): void {
    this.state = 'LOCKED';
    this.reason = reason;
  }

  /** Decides NEW / LOCKED / READY from what is on disk (and finishes interrupted swaps). */
  private async resolve(): Promise<void> {
    this.reason = undefined;
    const marker = pendingSwap(this.livePath);
    if (marker) {
      const staged = this.vault.readStagedKeyFile();
      let current: RecoveryWrap | null = null;
      try {
        current = this.vault.readKeyFile();
      } catch {
        current = null;
      }
      const wrapFor = (keyId: string) => (staged?.keyId === keyId ? staged : current?.keyId === keyId ? current : null);
      const outcome = recoverPendingRestore(this.livePath, (keyId) => this.vault.loadDeviceKey(keyId, wrapFor(keyId)));
      if (outcome === 'NEEDS_KEY') {
        this.logger.warn('An interrupted restore/encryption needs the recovery passphrase to finish');
        this.lock('PASSPHRASE_REQUIRED');
        return;
      }
      this.logger.warn('Recovered an interrupted database swap', { outcome, kind: marker.kind ?? 'RESTORE' });
      if (staged) {
        const dk = outcome === 'COMPLETED' && marker.incomingKeyId === staged.keyId ? this.vault.loadDeviceKey(staged.keyId, staged) : null;
        if (dk) this.vault.promoteStaged(dk);
        else if (outcome === 'COMPLETED' && marker.incomingKeyId === staged.keyId) renameSync(this.vault.stagedKeyFilePath, this.vault.keyFilePath);
        else this.vault.discardStaged();
      }
    } else if (existsSync(this.vault.stagedKeyFilePath)) {
      // A crash before a swap even started: the staged key belongs to nothing.
      this.vault.discardStaged();
    }

    const kind = databaseFileKind(this.livePath);
    if (kind === 'MISSING' || kind === 'EMPTY') {
      if (kind === 'EMPTY') rmSync(this.livePath, { force: true });
      this.state = 'NEW';
      return;
    }
    if (kind === 'PLAIN') {
      if (existsSync(this.vault.keyFilePath)) {
        this.logger.warn('Removed an encryption key file that belongs to no database (plain database found)');
        this.vault.removeStaleKeyFile();
      }
      this.vault.clear();
      await this.openBackend();
      return;
    }
    // Encrypted.
    if (this.vault.isUnlocked) {
      await this.openBackend();
      return;
    }
    let wrap: RecoveryWrap | null = null;
    let damaged = false;
    try {
      wrap = this.vault.readKeyFile();
    } catch {
      damaged = true;
    }
    if (this.vault.tryDeviceUnlock(wrap, (dk) => canOpen(this.livePath, dk))) {
      await this.openBackend();
      return;
    }
    this.lock(damaged ? 'KEY_FILE_DAMAGED' : wrap ? 'PASSPHRASE_REQUIRED' : 'KEY_FILE_MISSING');
  }

  private async openBackend(): Promise<void> {
    try {
      this.backendInstance = await AppBackend.open({ ...this.opts, vault: this.vault });
      this.state = 'READY';
      this.reason = undefined;
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT') || (isDomainError(e) && e.code === ErrorCode.DATABASE_DAMAGED)) {
        this.logger.error('The company database cannot be read (damaged)', { error: (e as Error).message });
        this.lock('DATABASE_DAMAGED');
        return;
      }
      if (isDomainError(e) && e.code === ErrorCode.DATABASE_LOCKED) {
        this.lock('PASSPHRASE_REQUIRED');
        return;
      }
      throw e;
    }
  }

  close(): void {
    this.backendInstance?.close();
    this.backendInstance = null;
  }

  status(): SystemStatusDto {
    const base: SystemStatusDto = {
      setupRequired: this.state === 'NEW',
      appVersion: this.opts.appVersion,
      schemaVersion: 0,
      companyName: null,
      defaultLocale: 'ar',
      vault: this.state,
      encrypted: this.state === 'LOCKED' ? databaseFileKind(this.livePath) === 'ENCRYPTED' : null,
    };
    if (this.state === 'NEW') base.setupCurrencies = SEED_CURRENCIES.map((c) => ({ code: c.code, nameAr: c.nameAr, nameEn: c.nameEn }));
    if (this.state === 'LOCKED') {
      base.lockReason = this.reason!;
      const wait = Math.ceil((this.unlockNotBefore - Date.now()) / 1000);
      if (wait > 0) base.retryAfterSeconds = wait;
    }
    return base;
  }

  async dispatch(req: DispatchRequest): Promise<DispatchResponse> {
    if (this.state === 'READY' && this.backendInstance) {
      if (req.command === 'system.status') {
        const r = await this.backendInstance.dispatch(req);
        return r;
      }
      return this.backendInstance.dispatch(req);
    }
    if (!PRE_OPEN_COMMANDS.has(req.command)) {
      return { ok: false, error: { code: ErrorCode.DATABASE_LOCKED, message: 'The company data is not open yet' } };
    }
    try {
      switch (req.command) {
        case 'system.status':
          return { ok: true, data: this.status() };
        case 'system.setup':
          return await this.setupNew(req);
        case 'vault.unlock': {
          const i = commandSchemas['vault.unlock'].parse(req.payload ?? {});
          await this.unlock(i.passphrase, i.keySourceBackupPath ?? null, req.workstation);
          return { ok: true, data: this.status() };
        }
        case 'vault.inspectBackup': {
          const i = commandSchemas['vault.inspectBackup'].parse(req.payload ?? {});
          const h = await this.jobs.run<BackupHeader>({ type: 'inspect', filePath: i.filePath });
          const dto: BackupHeaderDto = { format: h.format, encrypted: h.encrypted, appVersion: h.appVersion, schemaVersion: h.schemaVersion, createdAt: h.createdAt, kind: h.kind, keyCreatedAt: h.keyCreatedAt, sameKey: false };
          return { ok: true, data: dto };
        }
        case 'vault.restoreBackup': {
          const i = commandSchemas['vault.restoreBackup'].parse(req.payload ?? {});
          await this.restoreOntoThisPc(i.filePath, i.passphrase ?? null, i.newRecovery ?? null);
          return { ok: true, data: this.status() };
        }
      }
    } catch (e) {
      if (isDomainError(e)) return { ok: false, error: { code: e.code, message: e.message, ...(e.details ? { details: { ...e.details } } : {}) } };
      if (e instanceof ZodError) return { ok: false, error: { code: ErrorCode.VALIDATION, message: 'Invalid input', details: { issues: e.issues.map((x) => ({ path: x.path.join('.'), message: x.message })) } } };
      this.logger.error('Unhandled error before the company data was open', { command: req.command, error: (e as Error).message, stack: (e as Error).stack });
      return { ok: false, error: { code: ErrorCode.INTERNAL, message: 'An unexpected error occurred. Details were written to the log.' } };
    }
    return { ok: false, error: { code: ErrorCode.VALIDATION, message: 'Unknown command' } };
  }

  /**
   * First-run setup of a NEW installation: the database is created encrypted
   * from its first byte, with the owner's recovery passphrase. The setup data
   * is validated before anything is written.
   */
  private async setupNew(req: DispatchRequest): Promise<DispatchResponse> {
    if (this.state !== 'NEW') throw new DomainError(ErrorCode.DATABASE_LOCKED, 'Unlock the company data first');
    const input = commandSchemas['system.setup'].parse(req.payload ?? {});
    assertPasswordPolicy(input.admin.password, input.admin.username);
    if (!input.recovery) throw new DomainError(ErrorCode.PASSPHRASE_POLICY, 'A recovery passphrase is required', { reason: 'REQUIRED' });
    const passphrase = assertRecoveryPassphrase(input.recovery.passphrase, input.recovery.confirmation);
    const { dk, wrap } = await this.vault.createKey(passphrase, this.clock.now().toISOString());
    this.vault.persist(dk, wrap);
    try {
      await this.openBackend();
      if (!this.isReady()) throw new DomainError(ErrorCode.INTERNAL, 'The new company database could not be created');
    } catch (e) {
      // Nothing was created that could hold data: go back to NEW.
      this.backendInstance?.close();
      this.backendInstance = null;
      for (const s of ['', '-wal', '-shm']) rmSync(this.livePath + s, { force: true });
      this.vault.removeStaleKeyFile();
      this.vault.clear();
      this.state = 'NEW';
      throw e;
    }
    this.backendInstance!.svc.deps.audit.append(SYSTEM_ACTOR, {
      action: 'security.encryption_enabled', entityType: 'system',
      metadata: { at: 'first_run', keyId: wrap.keyId, deviceProtection: this.vault.deviceKeys.isAvailable() ? this.vault.deviceKeys.kind : 'none' },
    });
    return this.backendInstance!.dispatch({ ...req, payload: { company: input.company, admin: input.admin } });
  }

  /** Wrong passphrases are slowed down (2 s per failure, at most 30 s) on top of Argon2id's own cost. */
  private async unlock(passphrase: string, keySourceBackupPath: string | null, workstation: string): Promise<void> {
    if (this.state !== 'LOCKED') throw new DomainError(ErrorCode.CONFLICT, 'Nothing to unlock', { reason: 'NOT_LOCKED' });
    if (Date.now() < this.unlockNotBefore) {
      throw new DomainError(ErrorCode.WRONG_PASSPHRASE, 'Too many attempts; wait a moment', { retryAfterSeconds: Math.ceil((this.unlockNotBefore - Date.now()) / 1000) });
    }
    let wrap: RecoveryWrap | null = null;
    if (keySourceBackupPath) {
      wrap = (await this.jobs.run<BackupHeader>({ type: 'inspect', filePath: keySourceBackupPath, includeKeyWrap: true })).keyWrap ?? null;
      if (!wrap) throw new DomainError(ErrorCode.BACKUP_INVALID, 'This backup is not encrypted: it holds no key', { reason: 'NOT_ENCRYPTED' });
    } else {
      const marker = pendingSwap(this.livePath);
      const staged = this.vault.readStagedKeyFile();
      try {
        wrap = marker && staged && marker.incomingKeyId === staged.keyId ? staged : this.vault.readKeyFile();
      } catch {
        wrap = null;
      }
      if (!wrap) throw new DomainError(ErrorCode.KEY_FILE_DAMAGED, 'The key file is missing or damaged: choose a backup file to read the key from, or restore a backup');
    }
    try {
      await this.vault.unlockWithPassphrase(wrap, passphrase);
    } catch (e) {
      this.failedUnlocks++;
      this.unlockNotBefore = Date.now() + Math.min(30, this.failedUnlocks * 2) * 1000;
      this.logger.warn('Unlock with recovery passphrase failed', { attempts: this.failedUnlocks });
      throw e;
    }
    this.failedUnlocks = 0;
    this.unlockNotBefore = 0;
    const dk = this.vault.dataKey!;
    if (keySourceBackupPath) {
      // Prefer the newest wrap stored inside the database (the passphrase may have changed after that backup).
      this.vault.adopt(dk, null);
    }
    await this.resolve();
    if (!this.isReady()) {
      this.vault.clear();
      if (this.state === 'LOCKED' && this.reason !== 'DATABASE_DAMAGED') this.lock('DATABASE_DAMAGED');
      throw new DomainError(ErrorCode.DATABASE_DAMAGED, 'The recovery passphrase is correct, but the company data cannot be opened with it (damaged or another company). Restore a backup.');
    }
    if (!this.vault.recoveryWrap) this.vault.persist(dk, wrap);
    else {
      let onDisk: RecoveryWrap | null = null;
      try {
        onDisk = this.vault.readKeyFile();
      } catch {
        onDisk = null;
      }
      if (onDisk?.keyId !== this.vault.recoveryWrap.keyId || onDisk.keyCheck !== this.vault.recoveryWrap.keyCheck) this.vault.persist(dk, this.vault.recoveryWrap);
    }
    // Remember the key for this OS user so the next start needs no passphrase.
    this.vault.saveDeviceKey(dk, this.vault.recoveryWrap!.keyId);
    const b = this.backendInstance!;
    b.vault.syncToDatabase(b.internals.db, this.clock.now().toISOString());
    b.svc.deps.audit.append({ userId: null, sessionId: null, workstation }, {
      action: 'security.unlocked_with_recovery_passphrase', entityType: 'system',
      metadata: { keyFromBackup: !!keySourceBackupPath, deviceProtection: this.vault.deviceKeys.isAvailable() ? this.vault.deviceKeys.kind : 'none' },
    });
  }

  /**
   * Restores a backup when no company data is open here: a replacement PC,
   * a reinstalled Windows, a damaged database. The current database files (if
   * any) are moved aside, never deleted. An encrypted backup keeps its key and
   * passphrase; a plain (1.0.0-rc.1) backup is encrypted on the way in with a
   * NEW recovery passphrase chosen now.
   */
  private async restoreOntoThisPc(filePath: string, passphrase: string | null, newRecovery: { passphrase: string; confirmation: string } | null): Promise<void> {
    if (this.state === 'READY') throw new DomainError(ErrorCode.CONFLICT, 'Company data is open: use Backup & restore inside AirDesk', { reason: 'ALREADY_OPEN' });
    const header = await this.jobs.run<BackupHeader>({ type: 'inspect', filePath });
    const migrations = this.opts.migrations ?? MIGRATIONS;
    let key: Buffer;
    let wrap: RecoveryWrap;
    let validated: ValidatedBackup;
    if (header.encrypted) {
      if (!passphrase) throw new DomainError(ErrorCode.PASSPHRASE_REQUIRED, 'Enter the recovery passphrase of this backup', { keyCreatedAt: header.keyCreatedAt });
      validated = await this.jobs.run<ValidatedBackup>({ type: 'validate', filePath, tempDir: this.opts.dataDir, maxSchemaVersion: migrations.length, currentKeyHex: null, passphrase, target: 'KEEP', keepTemp: true });
      key = Buffer.from(validated.backupKeyHex!, 'hex');
      wrap = validated.backupWrap!;
    } else {
      if (!newRecovery) throw new DomainError(ErrorCode.PASSPHRASE_POLICY, 'This backup is not encrypted: choose a recovery passphrase to protect the data from now on', { reason: 'REQUIRED' });
      const p = assertRecoveryPassphrase(newRecovery.passphrase, newRecovery.confirmation);
      const created = await this.vault.createKey(p, this.clock.now().toISOString());
      key = created.dk;
      wrap = created.wrap;
      validated = await this.jobs.run<ValidatedBackup>({ type: 'validate', filePath, tempDir: this.opts.dataDir, maxSchemaVersion: migrations.length, currentKeyHex: null, target: { rekeyToHex: key.toString('hex') }, keepTemp: true });
    }
    let swapped = false;
    try {
      migrateWorkingCopy(validated.tempDbPath, key, migrations, this.opts.appVersion, this.clock);
      this.vault.stage(key, wrap);
      swapInDatabase({ livePath: this.livePath, incomingPath: validated.tempDbPath, incomingKey: key, incomingKeyId: wrap.keyId, kind: 'RESTORE', clock: this.clock });
      swapped = true;
      this.vault.promoteStaged(key);
    } catch (e) {
      rmSync(validated.tempDbPath, { force: true });
      if (!swapped) this.vault.discardStaged();
      throw e;
    }
    await this.openBackend();
    if (!this.isReady()) throw new DomainError(ErrorCode.DATABASE_DAMAGED, 'The restored data could not be opened');
    const b = this.backendInstance!;
    b.svc.deps.audit.append(SYSTEM_ACTOR, {
      action: 'backup.restored', entityType: 'backup',
      metadata: { mode: 'ONTO_THIS_PC', filePath, backupCreatedAt: validated.manifest.createdAt, dbSha256: validated.manifest.dbSha256, backupWasEncrypted: header.encrypted },
    });
    const head = b.internals.db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined;
    appendBackupHistory(this.opts.dataDir, {
      kind: 'NEW_INSTALLATION_RESTORE', status: 'SUCCEEDED', filePath, at: this.clock.now().toISOString(), auditSeq: head?.seq ?? 0, auditHeadHash: head?.hash ?? '0'.repeat(64),
    });
  }
}

/** True when the database file opens with this key (used to pick a saved device key when the key file is gone). */
function canOpen(path: string, dk: Buffer): boolean {
  try {
    openDatabase({ path, fileMustExist: true, readonly: true, encryptionKey: dk }).close();
    return true;
  } catch {
    return false;
  }
}
