import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppBackend, createMemoryLogger, runIntegrityChecks } from '@airdesk/backend';

/**
 * `AirDesk.exe --smoke-test=<result.json>` — proves on a clean Windows machine
 * that the PACKAGED app works end to end: native SQLite and Argon2 load inside
 * Electron, migrations run, setup/login work, a financial document posts and
 * balances, and a backup restores. Uses a throw-away data directory.
 */
export async function runSmokeTest(resultPath: string, appVersion: string): Promise<number> {
  const steps: { step: string; ok: boolean; detail?: string }[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'airdesk-smoke-'));
  let backend: AppBackend | null = null;
  const record = (step: string, ok: boolean, detail?: string) => steps.push(detail ? { step, ok, detail } : { step, ok });
  try {
    backend = await AppBackend.open({ dataDir, appVersion, logger: createMemoryLogger() });
    const db = backend.internals.db;
    record('open+migrate', true, `schema v${backend.schemaVersionNow}, sqlite ${(db.prepare('select sqlite_version() v').get() as { v: string }).v}`);

    const call = (command: string, payload: unknown, sessionId: string | null = null) =>
      backend!.dispatch({ command, payload, sessionId, workstation: 'SMOKE' });
    const setup = await call('system.setup', {
      company: { legalNameAr: 'اختبار', baseCurrencyCode: 'EGP', defaultCountryCode: 'EG', timezone: 'Africa/Cairo', defaultLocale: 'ar' },
      admin: { username: 'operator', displayName: 'Smoke', password: 'smoke test password 123', locale: 'ar' },
    });
    record('setup (argon2 hash)', setup.ok, setup.ok ? undefined : JSON.stringify(setup.error));
    const login = await call('auth.login', { username: 'operator', password: 'smoke test password 123' });
    const sessionId = login.session && 'set' in login.session ? login.session.set : null;
    record('login (argon2 verify)', !!sessionId);

    const actor = backend.svc.sessions.resolve(sessionId);
    const now = new Date().toISOString();
    const today = backend.svc.company.today();
    db.prepare(`INSERT INTO customer (id, customer_no, full_name, primary_mobile, primary_mobile_raw, created_at, created_by, updated_at)
                VALUES ('01SMOKECUSTOMER00000000000', 'C-1', 'Smoke', '+20100', '0100', ?, ?, ?)`).run(now, actor.userId, now);
    const posted = backend.svc.posting.post(actor, {
      docType: 'CUSTOMER_INVOICE', docDate: today, currency: 'EGP', customerId: '01SMOKECUSTOMER00000000000',
      lines: [{ lineType: 'FARE', amountMinor: 1_050_000 }],
    });
    record('post document', posted.docNo.startsWith('INV-'), posted.docNo);

    const backup = await call('backup.create', {}, sessionId);
    record('backup (validated)', backup.ok, backup.ok ? undefined : JSON.stringify(backup.error));
    if (backup.ok) {
      const restore = await call('backup.restore', { filePath: (backup.data as { filePath: string }).filePath, password: 'smoke test password 123', confirmation: 'RESTORE' }, sessionId);
      record('restore', restore.ok, restore.ok ? undefined : JSON.stringify(restore.error));
    }
    const report = runIntegrityChecks(backend.internals.db, backend.svc.deps.audit, { now: () => new Date() });
    record('integrity', report.ok, report.checks.filter((c) => !c.ok).map((c) => c.id).join(',') || undefined);
  } catch (e) {
    record('exception', false, (e as Error).stack ?? String(e));
  } finally {
    backend?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
  const ok = steps.length > 0 && steps.every((s) => s.ok);
  writeFileSync(resultPath, JSON.stringify({ ok, appVersion, electron: process.versions.electron, node: process.versions.node, platform: process.platform, steps }, null, 2));
  return ok ? 0 : 1;
}
