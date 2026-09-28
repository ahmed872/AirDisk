import { createHash } from 'node:crypto';
import { DomainError, ErrorCode } from '@airdesk/domain';
import type { Db } from './driver';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
  appVersion: string;
}

export interface MigrationPlan {
  currentVersion: number;
  targetVersion: number;
  pending: Migration[];
}

/** Line endings are normalised so a Windows checkout produces the same checksum. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function ensureMigrationTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    applied_at  TEXT NOT NULL,
    app_version TEXT NOT NULL
  ) STRICT`);
}

export function appliedMigrations(db: Db): AppliedMigration[] {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'`).get();
  if (!exists) return [];
  return db
    .prepare(`SELECT version, name, checksum, applied_at AS appliedAt, app_version AS appVersion FROM schema_migration ORDER BY version`)
    .all() as AppliedMigration[];
}

function assertWellFormed(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migrations must be numbered 1..n without gaps (found ${m.version} at position ${i + 1})`);
  });
}

/**
 * Compares the database with the migrations shipped in this build. Refuses to
 * continue when an applied migration was altered (checksum mismatch) or when
 * the database was created by a newer AirDesk (downgrade protection).
 */
export function planMigrations(db: Db, migrations: readonly Migration[]): MigrationPlan {
  assertWellFormed(migrations);
  const applied = appliedMigrations(db);
  for (const a of applied) {
    const known = migrations[a.version - 1];
    if (!known) {
      throw new DomainError(ErrorCode.DATABASE_TOO_NEW, 'This database was created by a newer version of AirDesk', {
        databaseVersion: a.version,
        appVersion: migrations.length,
      });
    }
    if (migrationChecksum(known.sql) !== a.checksum) {
      throw new DomainError(ErrorCode.MIGRATION_CHECKSUM_MISMATCH, `Migration ${a.version} (${a.name}) does not match this build`, {
        version: a.version,
      });
    }
  }
  const currentVersion = applied.length ? applied[applied.length - 1]!.version : 0;
  return { currentVersion, targetVersion: migrations.length, pending: migrations.slice(currentVersion) };
}

/**
 * Applies all pending migrations in ONE transaction: either the database moves
 * to the target version completely, or it is left untouched. Foreign keys are
 * verified before commit.
 */
export function runMigrations(db: Db, migrations: readonly Migration[], opts: { appVersion: string; now: () => string }): MigrationPlan {
  const plan = planMigrations(db, migrations);
  if (plan.pending.length === 0) return plan;
  db.transaction(() => {
    ensureMigrationTable(db);
    const record = db.prepare(`INSERT INTO schema_migration (version, name, checksum, applied_at, app_version) VALUES (?, ?, ?, ?, ?)`);
    for (const m of plan.pending) {
      db.exec(m.sql);
      record.run(m.version, m.name, migrationChecksum(m.sql), opts.now(), opts.appVersion);
    }
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      throw new DomainError(ErrorCode.INTEGRITY_FAILURE, 'Migration left foreign key violations', { count: fkViolations.length });
    }
    db.pragma(`user_version = ${plan.targetVersion}`);
  })();
  return plan;
}

export function schemaVersion(db: Db): number {
  const applied = appliedMigrations(db);
  return applied.length ? applied[applied.length - 1]!.version : 0;
}
