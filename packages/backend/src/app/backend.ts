import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { ChartOfAccounts, DomainError, ErrorCode } from '@airdesk/domain';
import type { BackupRecordDto, IntegrityReportDto } from '@airdesk/contracts';
import { AuditLog, SYSTEM_ACTOR } from '../audit/audit-log';
import {
  BACKUP_EXTENSION,
  appendBackupHistory,
  createBackupFile,
  recoverPendingRestore,
  swapInRestoredDatabase,
  validateBackupFile,
  type BackupKind,
  type BackupResult,
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
import { systemClock, type Clock } from '../util/clock';
import { createUlidGenerator, type IdGenerator } from '../util/ids';
import { consoleLogger, type Logger } from '../util/logger';
import { dispatchCommand, type DispatchRequest, type DispatchResponse } from './dispatcher';

export interface BackendOptions {
  /** Directory holding airdesk.db, backups/ and backup-history.jsonl. Must be a local disk. */
  dataDir: string;
  appVersion: string;
  logger?: Logger;
  clock?: Clock;
  hasher?: PasswordHasher;
  migrations?: readonly Migration[];
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

  private constructor(
    private readonly opts: Required<Omit<BackendOptions, 'migrations'>> & { migrations: readonly Migration[] },
    private readonly newId: IdGenerator,
  ) {}

  static async open(options: BackendOptions): Promise<AppBackend> {
    assertLocalPath(options.dataDir);
    mkdirSync(options.dataDir, { recursive: true });
    const backend = new AppBackend(
      {
        dataDir: options.dataDir,
        appVersion: options.appVersion,
        logger: options.logger ?? consoleLogger,
        clock: options.clock ?? systemClock,
        hasher: options.hasher ?? createArgon2Hasher(),
        migrations: options.migrations ?? MIGRATIONS,
      },
      createUlidGenerator(),
    );
    await backend.start();
    return backend;
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
    if (req.sessionId) this.lastUserActivityAt = this.opts.clock.now().getTime();
    return dispatchCommand(this, req);
  }

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

  private async start(): Promise<void> {
    const { logger } = this.opts;
    const recovery = recoverPendingRestore(this.livePath);
    if (recovery !== 'NONE') logger.warn('Recovered an interrupted restore', { outcome: recovery });

    this.db = openDatabase({ path: this.livePath });
    const plan = planMigrations(this.db, this.opts.migrations);
    if (plan.pending.length > 0 && plan.currentVersion > 0) {
      // Phase 0 §07-5.1 rule 4: never migrate without a verified backup first.
      const result = await createBackupFile({
        db: this.db,
        destinationDir: join(this.opts.dataDir, 'backups'),
        workDir: this.opts.dataDir,
        kind: 'PRE_MIGRATION',
        appVersion: this.opts.appVersion,
        createdBy: null,
        clock: this.opts.clock,
        newId: this.newId,
        maxSchemaVersion: plan.currentVersion,
      });
      appendBackupHistory(this.opts.dataDir, { kind: 'PRE_MIGRATION', status: 'SUCCEEDED', filePath: result.filePath, sha256: result.sha256, at: result.manifest.createdAt, fromVersion: plan.currentVersion });
    }
    runMigrations(this.db, this.opts.migrations, { appVersion: this.opts.appVersion, now: () => this.opts.clock.now().toISOString() });
    seedSystemData(this.db, { newId: this.newId, now: this.opts.clock.now().toISOString(), appVersion: this.opts.appVersion });
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

  runIntegrity(actor: Actor): IntegrityReportDto {
    requirePermission(this.services.deps, actor, 'integrity.run', 'integrity.run');
    const report = runIntegrityChecks(this.db, this.services.deps.audit, this.opts.clock);
    this.services.deps.audit.append(actorOf(actor), { action: 'integrity.check_run', entityType: 'system', metadata: { ok: report.ok } });
    return report;
  }

  async createBackup(actor: Actor | null, kind: BackupKind, destinationDir?: string): Promise<BackupResult> {
    if (actor) requirePermission(this.services.deps, actor, 'backup.create', 'backup.create');
    // The finished .adbk may go to a USB/network folder; the working snapshot always stays on the local data disk.
    // A chosen destination must be an absolute folder path (no relative or '..' tricks).
    if (destinationDir !== undefined && (!isAbsolute(destinationDir) || normalize(destinationDir).split(/[\\/]/).includes('..'))) {
      throw new DomainError(ErrorCode.VALIDATION, 'The backup folder must be a full path', { field: 'destinationDir', reason: 'INVALID_PATH' });
    }
    const dest = destinationDir ?? this.backupDir;
    const startedAt = this.opts.clock.now().toISOString();
    const deps = this.services.deps;
    const auditActor = actor ? actorOf(actor) : SYSTEM_ACTOR;
    try {
      const result = await createBackupFile({
        db: this.db, destinationDir: dest, workDir: this.opts.dataDir, kind, appVersion: this.opts.appVersion, createdBy: actor?.username ?? null,
        clock: this.opts.clock, newId: this.newId, maxSchemaVersion: this.opts.migrations.length,
      });
      const finishedAt = this.opts.clock.now().toISOString();
      deps.db.transaction(() => {
        deps.db
          .prepare(
            `INSERT INTO backup_record (id, kind, started_at, finished_at, status, file_path, file_size_bytes, sha256, schema_version,
               app_version, is_encrypted, verified_at, created_by) VALUES (?, ?, ?, ?, 'SUCCEEDED', ?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(result.id, kind, startedAt, finishedAt, result.filePath, result.sizeBytes, result.sha256, result.manifest.schemaVersion,
            this.opts.appVersion, finishedAt, actor?.userId ?? null);
        deps.audit.append(auditActor, { action: 'backup.created', entityType: 'backup', entityId: result.id, metadata: { kind, filePath: result.filePath, sha256: result.sha256 } });
      })();
      appendBackupHistory(this.opts.dataDir, { kind, status: 'SUCCEEDED', filePath: result.filePath, sha256: result.sha256, at: finishedAt });
      return result;
    } catch (e) {
      const message = (e as Error).message;
      deps.db.transaction(() => {
        deps.db
          .prepare(
            `INSERT INTO backup_record (id, kind, started_at, finished_at, status, schema_version, app_version, is_encrypted, error_message, created_by)
             VALUES (?, ?, ?, ?, 'FAILED', ?, ?, 0, ?, ?)`,
          )
          .run(this.newId(), kind, startedAt, this.opts.clock.now().toISOString(), schemaVersion(this.db), this.opts.appVersion, message.slice(0, 1000), actor?.userId ?? null);
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
    if (hours === 0 || busy || this.restoring || this.automaticBackupRunning || this.services.auth.isSetupRequired()) return { ran: false, pruned: [] };
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
   * file, mandatory PRE_RESTORE backup, crash-safe atomic swap, reopen,
   * migrate/seed, integrity check. All sessions end; users sign in again.
   */
  async restore(actor: Actor, filePath: string, password: string): Promise<{ manifest: unknown; preRestoreBackup: string }> {
    requirePermission(this.services.deps, actor, 'backup.restore', 'backup.restore');
    await this.services.auth.confirmPassword(actor, password);
    if (this.automaticBackupRunning) throw new DomainError(ErrorCode.CONFLICT, 'An automatic backup is running; try again in a minute', { reason: 'BACKUP_RUNNING' });
    this.restoring = true;
    try {
      return await this.restoreValidated(actor, filePath);
    } finally {
      this.restoring = false;
    }
  }

  private async restoreValidated(actor: Actor, filePath: string): Promise<{ manifest: unknown; preRestoreBackup: string }> {
    const validated = validateBackupFile(filePath, { maxSchemaVersion: this.opts.migrations.length, tempDir: this.opts.dataDir });
    let safety: BackupResult;
    try {
      safety = await this.createBackup(null, 'PRE_RESTORE');
    } catch (e) {
      throw new DomainError(ErrorCode.BACKUP_INVALID, `Restore cancelled: the safety backup of the current data failed (${(e as Error).message})`);
    }
    this.services.deps.audit.append(actorOf(actor), {
      action: 'backup.restore_started', entityType: 'backup', metadata: { filePath, backupCreatedAt: validated.manifest.createdAt, safetyBackup: safety.filePath },
    });
    this.services.sessions.endAll('FORCED');
    this.db.close();
    try {
      swapInRestoredDatabase({ livePath: this.livePath, validated, migrations: this.opts.migrations, appVersion: this.opts.appVersion, clock: this.opts.clock });
    } finally {
      // Whatever happened, reopen whichever database is now live.
      this.db = openDatabase({ path: this.livePath, fileMustExist: true });
      seedSystemData(this.db, { newId: this.newId, now: this.opts.clock.now().toISOString(), appVersion: this.opts.appVersion });
      this.services = this.buildServices(this.db);
      this.ensureSearchIndex();
    }
    this.services.deps.audit.append(SYSTEM_ACTOR, {
      action: 'backup.restored',
      entityType: 'backup',
      metadata: { restoredByUserId: actor.userId, restoredByUsername: actor.username, filePath, dbSha256: validated.manifest.dbSha256, backupCreatedAt: validated.manifest.createdAt, safetyBackup: safety.filePath },
    });
    appendBackupHistory(this.opts.dataDir, { kind: 'RESTORE', status: 'SUCCEEDED', filePath, by: actor.username, at: this.opts.clock.now().toISOString(), safetyBackup: safety.filePath });
    this.lastStartupIntegrity = runIntegrityChecks(this.db, this.services.deps.audit, this.opts.clock);
    return { manifest: validated.manifest, preRestoreBackup: safety.filePath };
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
