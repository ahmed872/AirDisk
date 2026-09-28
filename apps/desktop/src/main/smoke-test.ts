import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppBackend, createMemoryLogger, runIntegrityChecks } from '@airdesk/backend';

/**
 * `AirDesk.exe --smoke-test=<result.json> [--smoke-phase=full|seed|verify] [--smoke-data-dir=<dir>]`
 * proves on a clean Windows machine that the PACKAGED app works end to end:
 * native SQLite and Argon2 load inside Electron, migrations run, first-run
 * setup and login work, master data is created, a financial document posts,
 * a backup restores, and data survives a restart.
 *
 *  - full   (default): throw-away data directory, everything above.
 *  - seed:  first-run setup + master data in --smoke-data-dir (kept).
 *  - verify: re-opens --smoke-data-dir (e.g. after uninstall/reinstall) and
 *            checks setup is NOT offered again and the data is intact.
 *
 * `seed` only does what the public first-run setup screen allows anyway, and
 * refuses to touch a directory that is already set up.
 */
export type SmokePhase = 'full' | 'seed' | 'verify';
const USER = 'operator';
const PASSWORD = 'smoke test password 123';

type Step = { step: string; ok: boolean; detail?: string };
const dataOf = (r: { ok: boolean }): unknown => (r.ok ? (r as { data?: unknown }).data : undefined);

export async function runSmokeTest(resultPath: string, appVersion: string, opts: { phase?: SmokePhase; dataDir?: string } = {}): Promise<number> {
  const phase = opts.phase ?? 'full';
  const steps: Step[] = [];
  const temp = !opts.dataDir;
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'airdesk-smoke-'));
  let backend: AppBackend | null = null;
  const record = (step: string, ok: boolean, detail?: string) => steps.push(detail ? { step, ok, detail } : { step, ok });
  const open = async () => {
    backend = await AppBackend.open({ dataDir, appVersion, logger: createMemoryLogger() });
    return backend;
  };
  try {
    if (phase !== 'full' && temp) throw new Error(`--smoke-phase=${phase} requires --smoke-data-dir`);
    let b = await open();
    const db = () => b.internals.db;
    record('open+migrate', true, `schema v${b.schemaVersionNow}, sqlite ${(db().prepare('select sqlite_version() v').get() as { v: string }).v}, dir ${dataDir}`);
    const call = (command: string, payload: unknown, sessionId: string | null = null) => b.dispatch({ command, payload, sessionId, workstation: 'SMOKE' });
    const login = async (username = USER, password = PASSWORD) => {
      const r = await call('auth.login', { username, password });
      return r.session && 'set' in r.session ? r.session.set : null;
    };
    const status = async () => dataOf(await call('system.status', {})) as { setupRequired: boolean };

    if (phase === 'verify') {
      record('setup not offered again', !(await status()).setupRequired);
      const s = await login();
      record('login', !!s);
      const customers = dataOf(await call('customers.list', { query: 'Smoke Customer', status: 'ALL' }, s)) as { total: number } | undefined;
      record('customer persisted', (customers?.total ?? 0) >= 1);
      const suppliers = dataOf(await call('suppliers.list', { query: 'Smoke Supplier' }, s)) as { total: number } | undefined;
      record('supplier persisted', (suppliers?.total ?? 0) >= 1);
      const airlines = dataOf(await call('airlines.list', { query: 'ZZ' }, s)) as { total: number } | undefined;
      record('airline persisted', (airlines?.total ?? 0) >= 1);
    } else {
      if (!(await status()).setupRequired) throw new Error('Refusing to run setup: this data directory is already set up');
      const setup = await call('system.setup', {
        company: { legalNameAr: 'اختبار', baseCurrencyCode: 'EGP', defaultCountryCode: 'EG', timezone: 'Africa/Cairo', defaultLocale: 'ar' },
        admin: { username: USER, displayName: 'Smoke', password: PASSWORD, locale: 'ar' },
      });
      record('first-run setup (argon2 hash)', setup.ok, setup.ok ? undefined : JSON.stringify(setup.error));
      const again = await call('system.setup', {
        company: { legalNameAr: 'x', baseCurrencyCode: 'EGP', defaultCountryCode: 'EG', timezone: 'Africa/Cairo', defaultLocale: 'ar' },
        admin: { username: 'intruder', displayName: 'x', password: 'another long password', locale: 'ar' },
      });
      record('setup cannot run twice', !again.ok && again.error.code === 'SETUP_ALREADY_DONE');
      let sessionId = await login();
      record('login (argon2 verify)', !!sessionId);

      if (phase === 'full') {
        const actor = b.svc.sessions.resolve(sessionId);
        const now = new Date().toISOString();
        db().prepare(`INSERT INTO customer (id, customer_no, full_name, primary_mobile, primary_mobile_raw, created_at, created_by, updated_at)
                    VALUES ('01SMOKECUSTOMER00000000000', 'C-9999', 'Ledger Probe', '+20100', '0100', ?, ?, ?)`).run(now, actor.userId, now);
        const posted = b.svc.posting.post(actor, {
          docType: 'CUSTOMER_INVOICE', docDate: b.svc.company.today(), currency: 'EGP', customerId: '01SMOKECUSTOMER00000000000',
          lines: [{ lineType: 'FARE', amountMinor: 1_050_000 }],
        });
        record('post document', posted.docNo.startsWith('INV-'), posted.docNo);
        const backup = await call('backup.create', {}, sessionId);
        record('backup (validated)', backup.ok, backup.ok ? undefined : JSON.stringify(backup.error));
        if (backup.ok) {
          const restore = await call('backup.restore', { filePath: (backup.data as { filePath: string }).filePath, password: PASSWORD, confirmation: 'RESTORE' }, sessionId);
          record('restore', restore.ok, restore.ok ? undefined : JSON.stringify(restore.error));
          sessionId = await login();
        }
      }

      const c = await call('customers.create', { customer: { fullName: 'Smoke Customer', primaryMobile: '+966 50 123 4567' } }, sessionId);
      record('create customer', c.ok, c.ok ? undefined : JSON.stringify(c.error));
      const sup = await call('suppliers.create', { supplier: { name: 'Smoke Supplier', defaultCurrencyCode: 'EGP' } }, sessionId);
      record('create supplier', sup.ok, sup.ok ? undefined : JSON.stringify(sup.error));
      const air = await call('airlines.create', { airline: { nameEn: 'Smoke Air', iataCode: 'ZZ' } }, sessionId);
      record('create airline', air.ok, air.ok ? undefined : JSON.stringify(air.error));
      const agent = await call('users.create', { username: 'smokeagent', displayName: 'Agent', password: 'temporary pass 12345', roleCodes: ['SALES_AGENT'] }, sessionId);
      record('create sales agent', agent.ok);
      const agentSession = await login('smokeagent', 'temporary pass 12345');
      await call('auth.changePassword', { currentPassword: 'temporary pass 12345', newPassword: 'agent secret pass 987' }, agentSession);
      const denied = await call('roles.create', { code: 'HACK', nameAr: 'x', nameEn: 'x', permissions: [] }, agentSession);
      record('agent refused role management', !denied.ok && denied.error.code === 'FORBIDDEN');

      if (phase === 'full') {
        b.close();
        b = await open();
        const s2 = await login();
        const kept = dataOf(await call('customers.list', { query: 'Smoke Customer' }, s2)) as { total: number } | undefined;
        record('data persists after restart', !!s2 && (kept?.total ?? 0) === 1);
      }
    }
    const report = runIntegrityChecks(b.internals.db, b.svc.deps.audit, { now: () => new Date() });
    record('integrity', report.ok, report.checks.filter((x) => !x.ok).map((x) => x.id).join(',') || undefined);
  } catch (e) {
    record('exception', false, (e as Error).stack ?? String(e));
  } finally {
    (backend as AppBackend | null)?.close();
    if (temp) rmSync(dataDir, { recursive: true, force: true });
  }
  const ok = steps.length > 0 && steps.every((s) => s.ok);
  writeFileSync(resultPath, JSON.stringify({ ok, phase, appVersion, electron: process.versions.electron, node: process.versions.node, platform: process.platform, steps }, null, 2));
  return ok ? 0 : 1;
}
