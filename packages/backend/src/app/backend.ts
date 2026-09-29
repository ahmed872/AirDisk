import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { ChartOfAccounts, DomainError, ErrorCode, assertRecoveryPassphrase } from '@airdesk/domain';
import type { BackupRecordDto, EncryptionStatusDto, IntegrityReportDto } from '@airdesk/contracts';
import { AuditLog, SYSTEM_ACTOR } from '../audit/audit-log';
import {
  BACKUP_EXTENSION,
  appendBackupHistory,
  auditAnchors,
  migrateWorkingCopy,
  recoverPendingRestore,
  snapshotDatabase,
  swapInDatabase,
  quickBackupIsEncrypted,
  type BackupHeader,
  type BackupKind,
  type BackupResult,
  type PackageJobResult,
  type ValidatedBackup,
} from '../backup/backup-service';
import { assertLocalPath, openDatabase } from '../db/connection';
import type { Db } from '../db/driver';
import { MIGRATIONS } from '../db/migrations';
import { planMigrations, runMigrations, schemaVersion, type Migration } from '../db/migrator';
import { seedSystemData } from '../db/seed';
import { runIntegrityChecks } from '../integrity/integrity-service';
import { createArgon2Hasher, type PasswordHasher } from '../security/password-hasher';
import { AuthService } from '../services/auth-service';
import { CompanyService } from '../services/company-service';
import { actorOf, requirePermission, type Actor, type ServiceDeps } from '../services/context';
import { CurrencyService } from '../services/currency-service';
import { LedgerQueryService } from '../services/ledger-query-service';
import { PostingService } from '../services/posting-service';
import { SessionManager } from '../services/session-manager';
import { readSetting, writeSetting } from '../services/settings';
import { UserService } from '../services/user-service';
import { CustomerService } from '../services/customer-service';
import { SupplierService } from '../services/supplier-service';
import { AirlineService } from '../services/airline-service';
import { BookingService } from '../services/booking-service';
import { FinanceService } from '../services/finance-service';
import { OperationsService } from '../services/operations-service';
import { ReferenceService } from '../services/reference-service';
import { ReportService } from '../services/report-service';
import { AttachmentService } from '../services/attachment-service';
import { systemClock, type Clock } from '../util/clock';
import { createUlidGenerator, type IdGenerator } from '../util/ids';
import { consoleLogger, type Logger } from '../util/logger';
import { NO_DEVICE_KEYS, Vault, databaseFileKind } from '../security/vault';
import { JobRunner } from '../worker/job-runner';
import { dispatchCommand, type DispatchRequest, type DispatchResponse } from './dispatcher';

export interface BackendOptions {
  /** Directory holding airdesk.db, backups/ and backup-history.jsonl. Must be a local disk. */
  dataDir: string;
  appVersion: string;
  logger?: Logger;
  clock?: Clock;
  hasher?: PasswordHasher;
  migrations?: readonly Migration[];
  /**
   * Key holder for encryption at rest. When it is unlocked the database is
   * opened (and created) encrypted with its key; without one the database is
   * plain (1.0.0-rc.1 installations until encryption is enabled, and tests).
   */
  vault?: Vault;
  /** Script of the backup worker thread (bundled by the desktop app). Null/absent: run jobs in-process. */
  workerPath?: string | null;
}

export interface Services {
  deps: ServiceDeps;
  company: CompanyService;
  auth: AuthService;
  users: UserService;
  currencies: CurrencyService;
  posting: PostingService;
  ledger: LedgerQueryService;
  sessions: SessionManager;
  customers: CustomerService;
  suppliers: SupplierService;
  airlines: AirlineService;
  reference: ReferenceService;
  bookings: BookingService;
  finance: FinanceService;
  operations: OperationsService;
  reports: ReportService;
  attachments: AttachmentService;
}

export const DB_FILE_NAME = 'airdesk.db';

/**
 * Composition root and lifecycle of the backend. Transport-agnostic: the
 * desktop shell feeds dispatch() from Electron IPC today; a LAN primary/server
 * process can feed the very same dispatch() from HTTPS later (owner decision
 * Q1) without touching services or the domain.
 */
export class AppBackend {
  private db!: Db;
  private services!: Services;
  private lastStartupIntegrity: IntegrityReportDto | null = null;

  readonly jobs: JobRunner;

  private constructor(
    private readonly opts: Required<Omit<BackendOptions, 'migrations' | 'workerPath'>> & { migrations: readonly Migration[] },
    private readonly newId: IdGenerator,
    workerPath: string | null,
  ) {
    this.jobs = new JobRunner(workerPath, opts.logger);
  }

  static async open(options: BackendOptions): Promise<AppBackend> {
    assertLocalPath(options.dataDir);
    mkdirSync(options.dataDir, { recursive: true });
    const logger = options.logger ?? consoleLogger;
    const backend = new AppBackend(
      {
        dataDir: options.dataDir,
        appVersion: options.appVersion,
        logger,
        clock: options.clock ?? systemClock,
        hasher: options.hasher ?? createArgon2Hasher(),
        migrations: options.migrations ?? MIGRATIONS,
        vault: options.vault ?? new Vault(options.dataDir, NO_DEVICE_KEYS, undefined, logger),
      },
      createUlidGenerator(),
      options.workerPath ?? null,
    );
    await backend.start();
    return backend;
  }

  get vault(): Vault {
    return this.opts.vault;
  }

  get isEncrypted(): boolean {
    return this.opts.vault.dataKey !== null;
  }

  get livePath(): string {
    return join(this.opts.dataDir, DB_FILE_NAME);
  }

  get backupDir(): string {
    return readSetting(this.db, 'backup.directory') ?? join(this.opts.dataDir, 'backups');
  }

  /** For tests and the smoke test only. */
  get internals(): { db: Db; services: Services } {
    return { db: this.db, services: this.services };
  }

  get startupIntegrity(): IntegrityReportDto | null {
    return this.lastStartupIntegrity;
  }

  dispatch(req: DispatchRequest): Promise<DispatchResponse> {
    if (this.maintenance && req.command !== 'system.status') {
      return Promise.resolve({ ok: false, error: { code: ErrorCode.MAINTENANCE, message: 'AirDesk is busy with a maintenance task; try again in a moment', details: { task: this.maintenance } } });
    }
    if (req.sessionId) this.lastUserActivityAt = this.opts.clock.now().getTime();
    return dispatchCommand(this, req);
  }

  /** Set while the database is being swapped (restore, encryption): every other command is refused. */
  private maintenance: string | null = null;

  /** Last time a signed-in user did anything (used to keep automatic backups out of the way). */
  private lastUserActivityAt = 0;

  get svc(): Services {
    return this.services;
  }

  close(): void {
    try {
      this.services?.sessions.endAll('APP_EXIT');
    } finally {
      this.db?.close();
    }
  }

  private openLive(): Db {
    return openDatabase({ path: this.livePath, encryptionKey: this.opts.vault.dataKey });
  }

  private async start(): Promise<void> {
    const { logger, vault } = this.opts;
    const recovery = recoverPendingRestore(this.livePath, (keyId) => vault.loadDeviceKey(keyId, vault.recoveryWrap));
    if (recovery === 'NEEDS_KEY') throw new DomainError(ErrorCode.DATABASE_LOCKED, 'An interrupted restore needs the recovery passphrase to finish');
    if (recovery !== 'NONE') logger.warn('Recovered an interrupted restore', { outcome: recovery });
    const fileKind = databaseFileKind(this.livePath);
    if (fileKind === 'ENCRYPTED' && !vault.dataKey) throw new DomainError(ErrorCode.DATABASE_LOCKED, 'The company data is encrypted and has not been unlocked');
    if (fileKind === 'PLAIN' && vault.dataKey) throw new DomainError(ErrorCode.KEY_FILE_DAMAGED, 'An encryption key was supplied for an unencrypted database');

    this.db = this.openLive();
    // A key unlocked through this PC's protected store may have lost its key file: rebuild it from the database copy.
    if (vault.dataKey && !vault.recoveryWrap && vault.restoreKeyFileFromDatabase(this.db)) logger.warn('Rebuilt the encryption key file from the database');
    const plan = planMigrations(this.db, this.opts.migrations);
    if (plan.pending.length > 0 && plan.currentVersion > 0) {
      // Phase 0 §07-5.1 rule 4: never migrate without a verified backup first.
      const createdAt = this.opts.clock.now().toISOString();
      const result = await this.packageBackup('PRE_MIGRATION', join(this.opts.dataDir, 'backups'), null, createdAt, plan.currentVersion);
      appendBackupHistory(this.opts.dataDir, {
        kind: 'PRE_MIGRATION', status: 'SUCCEEDED', filePath: result.filePath, sha256: result.sha256, at: createdAt, fromVersion: plan.currentVersion,
        encrypted: result.manifest.encrypted, auditSeq: result.manifest.auditSeq, auditHeadHash: result.manifest.auditHeadHash,
      });
    }
    runMigrations(this.db, this.opts.migrations, { appVersion: this.opts.appVersion, now: () => this.opts.clock.now().toISOString() });
    seedSystemData(this.db, { newId: this.newId, now: this.opts.clock.now().toISOString(), appVersion: this.opts.appVersion });
    this.syncKeyCopy();
    this.services = this.buildServices(this.db);
    this.ensureSearchIndex();
    this.services.reference.ensureDefaultMoneyAccount(null);
    const abandoned = this.services.sessions.recoverAbandoned();
    if (abandoned) logger.warn('Closed sessions left open by an unclean shutdown', { count: abandoned });
    this.lastStartupIntegrity = runIntegrityChecks(this.db, this.services.deps.audit, this.opts.clock, { quick: true });
    if (!this.lastStartupIntegrity.ok) logger.error('Startup integrity check failed', { checks: this.lastStartupIntegrity.checks.filter((c) => !c.ok) });
    logger.info('Backend started', { schemaVersion: schemaVersion(this.db), appVersion: this.opts.appVersion });
  }

  private buildServices(db: Db): Services {
    const { clock, logger, hasher, appVersion } = this.opts;
    const audit = new AuditLog(db, clock, this.newId);
    const deps: ServiceDeps = { db, clock, newId: this.newId, audit, logger, chart: new ChartOfAccounts(), appVersion };
    const sessions = new SessionManager(db, clock, this.newId, audit, () => ({
      idleMinutes: readSetting(db, 'session.idle_minutes'),
      absoluteHours: readSetting(db, 'session.absolute_hours'),
    }));
    const company = new CompanyService(deps);
    const currencies = new CurrencyService(deps, company);
    const base = {
      deps,
      company,
      auth: new AuthService(deps, hasher, sessions, company),
      users: new UserService(deps, hasher, sessions, company),
      currencies,
      posting: new PostingService(deps, company, currencies),
      ledger: new LedgerQueryService(deps, company),
      sessions,
      customers: new CustomerService(deps, company),
      suppliers: new SupplierService(deps, company),
      airlines: new AirlineService(deps, company),
    } as Services;
    const svc = base;
    svc.reference = new ReferenceService(deps, company, currencies);
    svc.bookings = new BookingService(deps, company, currencies, svc.posting, svc.reference);
    svc.finance = new FinanceService(deps, company, currencies, svc.posting, svc.bookings, svc.reference);
    svc.operations = new OperationsService(deps, company, svc.bookings);
    svc.reports = new ReportService(deps, company, svc.ledger, svc.bookings);
    svc.attachments = new AttachmentService(deps, svc.bookings);
    return svc;
  }

  /**
   * Rebuilds the search index for an entity type if it is out of step with
   * its table (e.g. rows created before the index existed, or a restored
   * backup). Cheap check at startup; the index is otherwise maintained in the
   * same transaction as every write.
   */
  private ensureSearchIndex(): void {
    const svc = this.services;
    const types = [
      ['customer', 'customer', (id: string) => svc.customers.reindex(id)],
      ['supplier', 'supplier', (id: string) => svc.suppliers.reindex(id)],
      ['airline', 'airline', (id: string) => svc.airlines.reindex(id)],
      ['airport', 'airport', (id: string) => svc.reference.reindexAirport(id)],
      ['booking', 'booking', (id: string) => svc.bookings.reindex(id)],
    ] as const;
    for (const [type, table, reindex] of types) {
      const rows = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      const indexed = (this.db.prepare('SELECT COUNT(*) AS n FROM search_index WHERE entity_type = ?').get(type) as { n: number }).n;
      if (rows === indexed) continue;
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM search_index WHERE entity_type = ?').run(type);
        const key = table === 'airport' ? 'iata_code' : 'id';
        for (const { id } of this.db.prepare(`SELECT ${key} AS id FROM ${table}`).all() as { id: string }[]) reindex(id);
      })();
      this.opts.logger.info('Rebuilt search index', { type, rows });
    }
  }

  // ---- system operations that need the database handle itself ----

  /** Full integrity check on the live database, run on the worker thread (its own read-only connection). */
  async runIntegrity(actor: Actor): Promise<IntegrityReportDto> {
    requirePermission(this.services.deps, actor, 'integrity.run', 'integrity.run');
    const report = await this.jobs.run<IntegrityReportDto>({
      type: 'integrity', dbPath: this.livePath, keyHex: this.opts.vault.dataKey?.toString('hex') ?? null,
      anchors: auditAnchors(this.opts.dataDir), ranAt: this.opts.clock.now().toISOString(),
    });
    this.services.deps.audit.append(actorOf(actor), { action: 'integrity.check_run', entityType: 'system', metadata: { ok: report.ok } });
    return report;
  }

  /**
   * Snapshot (main thread, non-blocking file copy) + verification and
   * packaging (worker thread). The snapshot never leaves the local data disk.
   */
  private async packageBackup(kind: BackupKind, destinationDir: string, createdBy: string | null, createdAt: string, maxSchemaVersion: number): Promise<BackupResult> {
    mkdirSync(destinationDir, { recursive: true });
    const id = this.newId();
    const snapshotPath = join(this.opts.dataDir, `.snapshot-${id}.sqlite`);
    const stamp = createdAt.replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const finalPath = join(destinationDir, `AirDesk-${stamp}-${kind.toLowerCase()}-${id.slice(-6)}${BACKUP_EXTENSION}`);
    const { vault } = this.opts;
    try {
      await snapshotDatabase(this.db, this.livePath, snapshotPath);
      const r = await this.jobs.run<PackageJobResult>({
        type: 'package', snapshotPath, finalPath, tempDir: this.opts.dataDir, kind, appVersion: this.opts.appVersion, createdBy, createdAt,
        keyHex: vault.dataKey?.toString('hex') ?? null, keyWrap: vault.recoveryWrap, maxSchemaVersion,
      });
      return { id, filePath: finalPath, sha256: r.sha256, sizeBytes: r.sizeBytes, manifest: r.manifest };
    } catch (e) {
      throw e instanceof DomainError ? e : new DomainError(ErrorCode.BACKUP_INVALID, `Backup failed: ${(e as Error).message}`);
    } finally {
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${snapshotPath}${suffix}`, { force: true });
    }
  }

  /** Backups run one at a time (a second request waits for the first). */
  private backupQueue: Promise<unknown> = Promise.resolve();
  private backupsInFlight = 0;

  async createBackup(actor: Actor | null, kind: BackupKind, destinationDir?: string): Promise<BackupResult> {
    if (actor) requirePermission(this.services.deps, actor, 'backup.create', 'backup.create');
    // The finished .adbk may go to a USB/network folder; the working snapshot always stays on the local data disk.
    // A chosen destination must be an absolute folder path (no relative or '..' tricks).
    if (destinationDir !== undefined && (!isAbsolute(destinationDir) || normalize(destinationDir).split(/[\\/]/).includes('..'))) {
      throw new DomainError(ErrorCode.VALIDATION, 'The backup folder must be a full path', { field: 'destinationDir', reason: 'INVALID_PATH' });
    }
    this.backupsInFlight++;
    const run = this.backupQueue.then(() => this.createBackupNow(actor, kind, destinationDir));
    this.backupQueue = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      this.backupsInFlight--;
    }
  }

  private async createBackupNow(actor: Actor | null, kind: BackupKind, destinationDir?: string): Promise<BackupResult> {
    const dest = destinationDir ?? this.backupDir;
    const startedAt = this.opts.clock.now().toISOString();
    const deps = this.services.deps;
    const auditActor = actor ? actorOf(actor) : SYSTEM_ACTOR;
    const encrypted = this.isEncrypted ? 1 : 0;
    try {
      const result = await this.packageBackup(kind, dest, actor?.username ?? null, startedAt, this.opts.migrations.length);
      const finishedAt = this.opts.clock.now().toISOString();
      deps.db.transaction(() => {
        deps.db
          .prepare(
            `INSERT INTO backup_record (id, kind, started_at, finished_at, status, file_path, file_size_bytes, sha256, schema_version,
               app_version, is_encrypted, verified_at, created_by) VALUES (?, ?, ?, ?, 'SUCCEEDED', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(result.id, kind, startedAt, finishedAt, result.filePath, result.sizeBytes, result.sha256, result.manifest.schemaVersion,
            this.opts.appVersion, encrypted, finishedAt, actor?.userId ?? null);
        deps.audit.append(auditActor, { action: 'backup.created', entityType: 'backup', entityId: result.id, metadata: { kind, filePath: result.filePath, sha256: result.sha256, encrypted: encrypted === 1 } });
      })();
      appendBackupHistory(this.opts.dataDir, {
        kind, status: 'SUCCEEDED', filePath: result.filePath, sha256: result.sha256, at: finishedAt, encrypted: encrypted === 1,
        auditSeq: result.manifest.auditSeq, auditHeadHash: result.manifest.auditHeadHash,
      });
      return result;
    } catch (e) {
      const message = (e as Error).message;
      deps.db.transaction(() => {
        deps.db
          .prepare(
            `INSERT INTO backup_record (id, kind, started_at, finished_at, status, schema_version, app_version, is_encrypted, error_message, created_by)
             VALUES (?, ?, ?, ?, 'FAILED', ?, ?, ?, ?, ?)`,
          )
          .run(this.newId(), kind, startedAt, this.opts.clock.now().toISOString(), schemaVersion(this.db), this.opts.appVersion, encrypted, message.slice(0, 1000), actor?.userId ?? null);
        deps.audit.append(auditActor, { action: 'backup.failed', entityType: 'backup', metadata: { kind, error: message.slice(0, 500) } });
      })();
      appendBackupHistory(this.opts.dataDir, { kind, status: 'FAILED', error: message, at: startedAt });
      this.opts.logger.error('Backup failed', { kind, error: message });
      throw e;
    }
  }

  /**
   * Automatic backup (owner decision Q12, Phase 0 §10): runs when the newest
   * successful backup is older than `backup.auto_interval_hours`, then keeps
   * only the newest `backup.keep_scheduled` automatic files. Manual,
   * pre-migration and pre-restore backups are never deleted automatically.
   * Called by the desktop shell at start-up and then every few minutes with
   * `idleMinutes`, so it only runs when nobody has used the app for a while.
   */
  async runScheduledBackup(opts: { idleMinutes?: number } = {}): Promise<{ ran: boolean; filePath?: string; pruned: string[] }> {
    const hours = readSetting(this.db, 'backup.auto_interval_hours');
    // Never while someone is working: a backup of a large database can hold the app for several seconds.
    const busy = opts.idleMinutes !== undefined && this.opts.clock.now().getTime() - this.lastUserActivityAt < opts.idleMinutes * 60_000;
    if (hours === 0 || busy || this.restoring || this.maintenance || this.automaticBackupRunning || this.services.auth.isSetupRequired()) return { ran: false, pruned: [] };
    const last = this.lastSuccessfulBackupAt();
    if (last && this.opts.clock.now().getTime() - Date.parse(last) < hours * 3_600_000) return { ran: false, pruned: [] };
    this.automaticBackupRunning = true;
    try {
      const result = await this.createBackup(null, 'SCHEDULED');
      return { ran: true, filePath: result.filePath, pruned: this.pruneScheduledBackups() };
    } finally {
      this.automaticBackupRunning = false;
    }
  }

  private automaticBackupRunning = false;
  private restoring = false;

  backupSchedule(actor: Actor): { intervalHours: number; keep: number; lastSuccessfulAt: string | null; nextDueAt: string | null; directory: string } {
    requirePermission(this.services.deps, actor, ['backup.create', 'backup.restore', 'settings.system'], 'backup.schedule');
    const intervalHours = readSetting(this.db, 'backup.auto_interval_hours');
    const last = this.lastSuccessfulBackupAt();
    const nextDueAt = intervalHours === 0 ? null : last ? new Date(Date.parse(last) + intervalHours * 3_600_000).toISOString() : this.opts.clock.now().toISOString();
    return { intervalHours, keep: readSetting(this.db, 'backup.keep_scheduled'), lastSuccessfulAt: last, nextDueAt, directory: this.backupDir };
  }

  setBackupSchedule(actor: Actor, input: { intervalHours: number; keep: number }): ReturnType<AppBackend['backupSchedule']> {
    requirePermission(this.services.deps, actor, 'settings.system', 'backup.setSchedule');
    const before = { intervalHours: readSetting(this.db, 'backup.auto_interval_hours'), keep: readSetting(this.db, 'backup.keep_scheduled') };
    const now = this.opts.clock.now().toISOString();
    this.db.transaction(() => {
      writeSetting(this.db, 'backup.auto_interval_hours', input.intervalHours, actor.userId, now);
      writeSetting(this.db, 'backup.keep_scheduled', input.keep, actor.userId, now);
      this.services.deps.audit.append(actorOf(actor), { action: 'settings.backup_schedule_changed', entityType: 'system', before, after: input });
    })();
    return this.backupSchedule(actor);
  }

  private lastSuccessfulBackupAt(): string | null {
    return (this.db.prepare(`SELECT MAX(finished_at) AS at FROM backup_record WHERE status = 'SUCCEEDED' AND kind IN ('MANUAL','SCHEDULED','ON_EXIT')`).get() as { at: string | null }).at;
  }

  /** Deletes automatic backup files beyond the retention count (their history rows and audit records stay). */
  private pruneScheduledBackups(): string[] {
    const keep = readSetting(this.db, 'backup.keep_scheduled');
    const rows = this.db.prepare(`SELECT id, file_path FROM backup_record WHERE kind = 'SCHEDULED' AND status = 'SUCCEEDED' AND file_path IS NOT NULL ORDER BY finished_at DESC`).all() as { id: string; file_path: string }[];
    const removed: string[] = [];
    for (const r of rows.slice(keep)) {
      if (!r.file_path.endsWith(BACKUP_EXTENSION) || !existsSync(r.file_path)) continue;
      try {
        rmSync(r.file_path);
        removed.push(r.file_path);
      } catch (e) {
        this.opts.logger.warn('Could not remove an old automatic backup', { filePath: r.file_path, error: (e as Error).message });
      }
    }
    if (removed.length) this.services.deps.audit.append(SYSTEM_ACTOR, { action: 'backup.pruned', entityType: 'backup', metadata: { kind: 'SCHEDULED', keep, removed } });
    return removed;
  }

  listBackups(actor: Actor): BackupRecordDto[] {
    requirePermission(this.services.deps, actor, ['backup.create', 'backup.restore'], 'backup.list');
    return (
      this.db.prepare('SELECT * FROM backup_record ORDER BY started_at DESC LIMIT 200').all() as {
        id: string; kind: string; status: string; started_at: string; finished_at: string | null; file_path: string | null;
        file_size_bytes: number | null; sha256: string | null; schema_version: number; verified_at: string | null; error_message: string | null;
      }[]
    ).map((r) => ({
      id: r.id, kind: r.kind, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, filePath: r.file_path,
      fileSizeBytes: r.file_size_bytes, sha256: r.sha256, schemaVersion: r.schema_version, verifiedAt: r.verified_at, errorMessage: r.error_message,
    }));
  }

  /**
   * Safe restore (Phase 0 §10-5): step-up password, full validation of the
   * file on the worker thread, mandatory PRE_RESTORE backup, crash-safe atomic
   * swap, reopen, migrate/seed, integrity check. All sessions end; users sign
   * in again.
   *
   * Keys: the restored database always ends up in THIS installation's key (an
   * encrypted backup made with another key needs its recovery passphrase and is
   * re-encrypted; a plain backup is encrypted on the way in). A plain
   * installation that restores an encrypted backup adopts that backup's key and
   * recovery passphrase.
   */
  async restore(actor: Actor, filePath: string, password: string, backupPassphrase?: string | null): Promise<{ manifest: unknown; preRestoreBackup: string }> {
    requirePermission(this.services.deps, actor, 'backup.restore', 'backup.restore');
    await this.services.auth.confirmPassword(actor, password);
    if (this.automaticBackupRunning || this.backupsInFlight > 0) throw new DomainError(ErrorCode.CONFLICT, 'A backup is running; try again in a minute', { reason: 'BACKUP_RUNNING' });
    if (this.restoring || this.maintenance) throw new DomainError(ErrorCode.MAINTENANCE, 'Another maintenance task is running');
    this.restoring = true;
    try {
      return await this.restoreValidated(actor, filePath, backupPassphrase ?? null);
    } finally {
      this.restoring = false;
    }
  }

  private async restoreValidated(actor: Actor, filePath: string, backupPassphrase: string | null): Promise<{ manifest: unknown; preRestoreBackup: string }> {
    const { vault } = this.opts;
    const current = vault.dataKey;
    const validated = await this.jobs.run<ValidatedBackup>({
      type: 'validate', filePath, tempDir: this.opts.dataDir, maxSchemaVersion: this.opts.migrations.length,
      currentKeyHex: current?.toString('hex') ?? null, passphrase: backupPassphrase, target: current ? { rekeyToHex: current.toString('hex') } : 'KEEP', keepTemp: true,
    });
    // Plain installation + encrypted backup: adopt the backup's key (proven by its passphrase).
    const adopt = !current && validated.backupWrap ? { dk: Buffer.from(validated.backupKeyHex!, 'hex'), wrap: validated.backupWrap } : null;
    const incomingKey = current ?? adopt?.dk ?? null;
    let safety: BackupResult;
    try {
      safety = await this.createBackup(null, 'PRE_RESTORE');
    } catch (e) {
      rmSync(validated.tempDbPath, { force: true });
      throw new DomainError(ErrorCode.BACKUP_INVALID, `Restore cancelled: the safety backup of the current data failed (${(e as Error).message})`);
    }
    this.services.deps.audit.append(actorOf(actor), {
      action: 'backup.restore_started', entityType: 'backup',
      metadata: { filePath, backupCreatedAt: validated.manifest.createdAt, safetyBackup: safety.filePath, backupEncrypted: validated.manifest.encrypted, adoptsBackupKey: !!adopt },
    });
    this.services.sessions.endAll('FORCED');
    this.maintenance = 'RESTORE';
    this.db.close();
    let swapped = false;
    try {
      migrateWorkingCopy(validated.tempDbPath, incomingKey, this.opts.migrations, this.opts.appVersion, this.opts.clock);
      if (adopt) vault.stage(adopt.dk, adopt.wrap);
      swapInDatabase({
        livePath: this.livePath, incomingPath: validated.tempDbPath, incomingKey, incomingKeyId: incomingKey ? (adopt?.wrap.keyId ?? vault.recoveryWrap?.keyId ?? null) : null,
        kind: 'RESTORE', clock: this.opts.clock,
      });
      swapped = true;
      if (adopt) vault.promoteStaged(adopt.dk);
    } catch (e) {
      rmSync(validated.tempDbPath, { force: true });
      if (adopt && !swapped) vault.discardStaged();
      throw e;
    } finally {
      // Whatever happened, reopen whichever database is now live.
      this.reopenAfterSwap();
    }
    this.services.deps.audit.append(SYSTEM_ACTOR, {
      action: 'backup.restored',
      entityType: 'backup',
      metadata: {
        restoredByUserId: actor.userId, restoredByUsername: actor.username, filePath, dbSha256: validated.manifest.dbSha256, backupCreatedAt: validated.manifest.createdAt,
        safetyBackup: safety.filePath, encrypted: this.isEncrypted,
      },
    });
    this.recordRestoreAnchor({ kind: 'RESTORE', filePath, by: actor.username, safetyBackup: safety.filePath });
    this.lastStartupIntegrity = runIntegrityChecks(this.db, this.services.deps.audit, this.opts.clock);
    return { manifest: validated.manifest, preRestoreBackup: safety.filePath };
  }

  private reopenAfterSwap(): void {
    this.db = this.openLive();
    seedSystemData(this.db, { newId: this.newId, now: this.opts.clock.now().toISOString(), appVersion: this.opts.appVersion });
    this.syncKeyCopy();
    this.services = this.buildServices(this.db);
    this.ensureSearchIndex();
    this.maintenance = null;
  }

  /** Keeps the database's copy of the recovery wrap equal to the key file (it is how a lost key file is rebuilt). */
  private syncKeyCopy(): void {
    const { vault } = this.opts;
    if (!vault.recoveryWrap) return;
    const row = this.db.prepare(`SELECT value_json FROM app_setting WHERE key = 'security.recovery_wrap'`).get() as { value_json: string } | undefined;
    if (row?.value_json !== JSON.stringify(vault.recoveryWrap)) vault.syncToDatabase(this.db, this.opts.clock.now().toISOString());
  }

  /** The restored chain head becomes the new anchor baseline (anchors from before the restore describe another timeline). */
  private recordRestoreAnchor(entry: Record<string, unknown>): void {
    const head = this.db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined;
    appendBackupHistory(this.opts.dataDir, { ...entry, status: 'SUCCEEDED', at: this.opts.clock.now().toISOString(), auditSeq: head?.seq ?? 0, auditHeadHash: head?.hash ?? '0'.repeat(64) });
  }

  // ───────────────────────── encryption at rest ─────────────────────────

  encryptionStatus(actor: Actor): EncryptionStatusDto {
    requirePermission(this.services.deps, actor, ['settings.system', 'backup.create', 'backup.restore'], 'security.encryptionStatus');
    const { vault } = this.opts;
    const plainBackups = this.unencryptedBackupFiles();
    return {
      encrypted: this.isEncrypted,
      keyCreatedAt: vault.recoveryWrap?.createdAt ?? null,
      deviceProtection: vault.deviceKeys.isAvailable() ? vault.deviceKeys.kind : 'none',
      unencryptedBackupFiles: plainBackups.length,
    };
  }

  /** Files that still hold the company data unencrypted: plain backups and leftover pre-restore database copies. */
  private unencryptedBackupFiles(): string[] {
    const files = new Set<string>();
    for (const r of this.db.prepare(`SELECT file_path FROM backup_record WHERE status = 'SUCCEEDED' AND is_encrypted = 0 AND file_path IS NOT NULL`).all() as { file_path: string }[]) {
      if (r.file_path.endsWith(BACKUP_EXTENSION) && existsSync(r.file_path)) files.add(r.file_path);
    }
    if (existsSync(this.backupDir)) {
      for (const f of readdirSync(this.backupDir)) {
        if (!f.endsWith(BACKUP_EXTENSION)) continue;
        const p = join(this.backupDir, f);
        if (!files.has(p) && this.isPlainBackup(p)) files.add(p);
      }
    }
    for (const f of readdirSync(this.opts.dataDir)) {
      if (/^airdesk\.db\.pre-(restore|encryption)-[^.]+$/.test(f) && databaseFileKind(join(this.opts.dataDir, f)) === 'PLAIN') files.add(join(this.opts.dataDir, f));
    }
    return [...files];
  }

  private isPlainBackup(path: string): boolean {
    // Only the small manifest at the start of the file is read, never the database part.
    return quickBackupIsEncrypted(path) === false;
  }

  /**
   * Turns an unencrypted (1.0.0-rc.1) installation into an encrypted one:
   *  1. everyone is signed out and every other command is refused;
   *  2. a consistent copy of the database is encrypted on the worker thread and
   *     proven identical (schema, documents, trial balance, audit chain head,
   *     full integrity check);
   *  3. the new key is staged (key file + this user's protected copy), the
   *     encrypted copy is swapped in crash-safely and the plain file deleted;
   *  4. an encrypted verified backup is made immediately.
   * Nothing financial changes; old unencrypted backup files are reported and
   * can be deleted with purgeUnencryptedBackups().
   */
  async enableEncryption(actor: Actor, input: { password: string; passphrase: string; confirmation: string }): Promise<{ backupFilePath: string | null; unencryptedBackupFiles: number }> {
    requirePermission(this.services.deps, actor, 'settings.system', 'security.enableEncryption');
    await this.services.auth.confirmPassword(actor, input.password);
    if (this.isEncrypted) throw new DomainError(ErrorCode.CONFLICT, 'Encryption is already enabled', { reason: 'ALREADY_ENCRYPTED' });
    const passphrase = assertRecoveryPassphrase(input.passphrase, input.confirmation);
    if (this.restoring || this.maintenance || this.automaticBackupRunning || this.backupsInFlight > 0) {
      throw new DomainError(ErrorCode.MAINTENANCE, 'A backup or restore is running; try again in a minute');
    }
    const { vault } = this.opts;
    const now = this.opts.clock.now().toISOString();
    const { dk, wrap } = await vault.createKey(passphrase, now);
    this.services.deps.audit.append(actorOf(actor), { action: 'security.encryption_started', entityType: 'system', metadata: { keyId: wrap.keyId } });
    this.services.sessions.endAll('FORCED');
    this.maintenance = 'ENCRYPT';
    const workPath = join(this.opts.dataDir, `.encrypting-${this.newId()}.sqlite`);
    let swapped = false;
    try {
      await snapshotDatabase(this.db, this.livePath, workPath);
      await this.jobs.run({ type: 'encrypt-copy', path: workPath, keyHex: dk.toString('hex') });
      vault.stage(dk, wrap);
      this.db.close();
      try {
        swapInDatabase({ livePath: this.livePath, incomingPath: workPath, incomingKey: dk, incomingKeyId: wrap.keyId, kind: 'ENCRYPT', clock: this.opts.clock });
        swapped = true;
        vault.promoteStaged(dk);
      } finally {
        if (!swapped) vault.discardStaged();
        this.reopenAfterSwap();
      }
    } catch (e) {
      this.maintenance = null;
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${workPath}${suffix}`, { force: true });
      this.opts.logger.error('Enabling encryption failed; the database was left unchanged', { error: (e as Error).message });
      throw e instanceof DomainError ? e : new DomainError(ErrorCode.INTEGRITY_FAILURE, `Encryption was not enabled: ${(e as Error).message}`);
    }
    this.services.deps.audit.append(SYSTEM_ACTOR, {
      action: 'security.encryption_enabled', entityType: 'system',
      metadata: { byUserId: actor.userId, byUsername: actor.username, keyId: wrap.keyId, deviceProtection: vault.deviceKeys.isAvailable() ? vault.deviceKeys.kind : 'none' },
    });
    let backupFilePath: string | null = null;
    try {
      backupFilePath = (await this.createBackup(null, 'MANUAL')).filePath;
    } catch (e) {
      this.opts.logger.warn('First encrypted backup failed', { error: (e as Error).message });
    }
    return { backupFilePath, unencryptedBackupFiles: this.unencryptedBackupFiles().length };
  }

  /** New recovery passphrase for the same key. Backups made before keep the passphrase they were made with. */
  async changeRecoveryPassphrase(actor: Actor, input: { password: string; passphrase: string; confirmation: string }): Promise<{ backupFilePath: string | null }> {
    requirePermission(this.services.deps, actor, 'settings.system', 'security.changeRecoveryPassphrase');
    await this.services.auth.confirmPassword(actor, input.password);
    if (!this.isEncrypted) throw new DomainError(ErrorCode.CONFLICT, 'Encryption is not enabled', { reason: 'NOT_ENCRYPTED' });
    const passphrase = assertRecoveryPassphrase(input.passphrase, input.confirmation);
    const { vault } = this.opts;
    const wrap = await vault.rewrap(passphrase, this.opts.clock.now().toISOString());
    this.db.transaction(() => {
      vault.replaceWrap(wrap);
      vault.syncToDatabase(this.db, this.opts.clock.now().toISOString());
      this.services.deps.audit.append(actorOf(actor), { action: 'security.recovery_passphrase_changed', entityType: 'system', metadata: { keyId: wrap.keyId } });
    })();
    let backupFilePath: string | null = null;
    try {
      backupFilePath = (await this.createBackup(null, 'MANUAL')).filePath;
    } catch (e) {
      this.opts.logger.warn('Backup after passphrase change failed', { error: (e as Error).message });
    }
    return { backupFilePath };
  }

  /** Deletes backup files and leftover database copies that are not encrypted (only once the installation is encrypted). */
  async purgeUnencryptedBackups(actor: Actor, password: string): Promise<{ removed: number }> {
    requirePermission(this.services.deps, actor, 'settings.system', 'security.purgeUnencryptedBackups');
    await this.services.auth.confirmPassword(actor, password);
    if (!this.isEncrypted) throw new DomainError(ErrorCode.CONFLICT, 'Enable encryption first', { reason: 'NOT_ENCRYPTED' });
    const removed: string[] = [];
    for (const f of this.unencryptedBackupFiles()) {
      try {
        rmSync(f, { force: true });
        removed.push(f);
      } catch (e) {
        this.opts.logger.warn('Could not delete an unencrypted backup', { filePath: f, error: (e as Error).message });
      }
    }
    this.services.deps.audit.append(actorOf(actor), { action: 'backup.unencrypted_purged', entityType: 'backup', metadata: { removed } });
    return { removed: removed.length };
  }

  /** Public header of a backup (no key needed): shown before asking for a passphrase. */
  async inspectBackup(actor: Actor, filePath: string): Promise<BackupHeader> {
    requirePermission(this.services.deps, actor, 'backup.restore', 'backup.inspect');
    return this.jobs.run<BackupHeader>({ type: 'inspect', filePath });
  }

  get appVersion(): string {
    return this.opts.appVersion;
  }

  /** Highest schema version this application build knows (older builds refuse newer databases). */
  get latestSchemaVersion(): number {
    return this.opts.migrations.length;
  }

  get schemaVersionNow(): number {
    return schemaVersion(this.db);
  }
}
