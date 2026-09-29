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
      record('ticket record + balances persisted', await recordPersisted(call, s));
      const about = dataOf(await call('system.about', {}, s)) as { schemaVersion: number; latestSchemaVersion: number } | undefined;
      record('schema up to date', !!about && about.schemaVersion === about.latestSchemaVersion, about ? `schema v${about.schemaVersion}` : undefined);
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
      // Ticket-office operations: record an externally issued ticket, take a payment, pay the supplier part.
      const ops = await recordTicket(call, sessionId, {
        customerId: (dataOf(c) as { id: string } | undefined)?.id, supplierId: (dataOf(sup) as { id: string } | undefined)?.id,
        airlineId: (dataOf(air) as { id: string } | undefined)?.id, today: b.svc.company.today(),
      });
      for (const [step, ok, detail] of ops) record(step, ok, detail);
      if (phase === 'full') {
        const bk = await call('backup.create', {}, sessionId);
        const rs = bk.ok ? await call('backup.restore', { filePath: (bk.data as { filePath: string }).filePath, password: PASSWORD, confirmation: 'RESTORE' }, sessionId) : bk;
        sessionId = await login();
        record('backup → restore keeps ticket record + balances', rs.ok && (await recordPersisted(call, sessionId)), rs.ok ? undefined : JSON.stringify(rs.error));
      }
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
        record('ticket record persists after restart', await recordPersisted(call, s2));
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

type Call = (command: string, payload: unknown, sessionId?: string | null) => Promise<{ ok: boolean; error?: { code: string } }>;
const PNR = 'SMK123';
interface RecordShape { id: string; rowVersion: number; status: string; passengers: { id: string }[]; customer: { chargedMinor: number; paidMinor: number; balanceMinor: number }[] }

/** Records a ticket issued outside AirDesk (PNR + ticket number) and a partial customer payment. */
async function recordTicket(call: Call, s: string | null, ids: { customerId?: string; supplierId?: string; airlineId?: string; today: string }): Promise<[string, boolean, string?][]> {
  const out: [string, boolean, string?][] = [];
  const step = async (name: string, command: string, payload: unknown): Promise<RecordShape | null> => {
    const r = await call(command, payload, s);
    out.push([name, r.ok, r.ok ? undefined : JSON.stringify(r.error)]);
    return r.ok ? (dataOf(r) as RecordShape) : null;
  };
  if (!ids.customerId || !ids.supplierId || !ids.airlineId) return [['ticket record prerequisites', false]];
  const d = new Date(`${ids.today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 30);
  const dep = d.toISOString().slice(0, 10);
  let r = await step('ticket record created', 'bookings.create', { customerId: ids.customerId, pnr: PNR, supplierId: ids.supplierId });
  if (r) r = await step('passenger added', 'bookings.savePassenger', { bookingId: r.id, passenger: { givenName: 'SMOKE', surname: 'TRAVELLER' } });
  if (r) r = await step('flight added', 'bookings.saveSegment', { bookingId: r.id, segment: { airlineId: ids.airlineId, flightNumber: '101', origin: 'CAI', destination: 'JED', departureDate: dep, departureTime: '10:00', arrivalDate: dep, arrivalTime: '12:30' } });
  if (r) r = await step('price + cost entered', 'bookings.savePriceItem', { bookingId: r.id, item: { passengerId: r.passengers[0]!.id, supplierId: ids.supplierId, fareMinor: 1_000_000, costMinor: 950_000, costCurrency: 'EGP', ticketNumber: '9991234567890' } });
  if (r) r = await step('confirmed ticketed (sale + purchase posted)', 'bookings.issue', { id: r.id, rowVersion: r.rowVersion });
  if (!r) return out;
  const accounts = dataOf(await call('moneyAccounts.list', {}, s)) as { id: string; currencyCode: string }[] | undefined;
  const cash = accounts?.find((a) => a.currencyCode === 'EGP');
  const pay = await call('payments.receive', { partyId: ids.customerId, currency: 'EGP', amountMinor: 400_000, moneyAccountId: cash?.id, paymentMethod: 'CASH', allocations: [{ bookingId: r.id, amountMinor: 400_000 }] }, s);
  out.push(['customer payment received', pay.ok, pay.ok ? undefined : JSON.stringify(pay.error)]);
  const after = dataOf(await call('bookings.get', { id: r.id }, s)) as RecordShape | undefined;
  const pos = after?.customer[0];
  out.push(['total / paid / remaining', !!pos && pos.chargedMinor === 1_000_000 && pos.paidMinor === 400_000 && pos.balanceMinor === 600_000, pos ? `${pos.chargedMinor}/${pos.paidMinor}/${pos.balanceMinor}` : undefined]);
  return out;
}

async function recordPersisted(call: Call, s: string | null): Promise<boolean> {
  const list = dataOf(await call('bookings.list', { query: PNR, status: 'ALL' }, s)) as { items: { id: string }[] } | undefined;
  const id = list?.items[0]?.id;
  if (!id) return false;
  const r = dataOf(await call('bookings.get', { id }, s)) as RecordShape | undefined;
  const pos = r?.customer[0];
  return r?.status === 'ISSUED' && !!pos && pos.chargedMinor === 1_000_000 && pos.paidMinor === 400_000 && pos.balanceMinor === 600_000;
}
