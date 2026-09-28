import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocumentDraft } from '@airdesk/domain';
import { afterEach } from 'vitest';
import {
  AppBackend,
  ManualClock,
  TEST_ARGON2,
  createArgon2Hasher,
  createMemoryLogger,
  createUlidGenerator,
  type Actor,
  type DispatchResponse,
  type Migration,
} from '../src';

export const ADMIN = { username: 'owner', password: 'correct horse battery staple' };
/** Password every test user sets after their temporary one (must not contain the username). */
export const USER_PASSWORD = 'another real secret 987';
export const COMPANY = {
  legalNameAr: 'شركة الاختبار للسياحة',
  legalNameEn: 'Test Travel Co.',
  baseCurrencyCode: 'EGP',
  defaultCountryCode: 'EG',
  timezone: 'Africa/Cairo',
  defaultLocale: 'ar' as const,
};

const dirs: string[] = [];
const open: AppBackend[] = [];
afterEach(() => {
  for (const b of open.splice(0)) {
    try {
      b.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'airdesk-test-'));
  dirs.push(d);
  return d;
}

export interface TestEnv {
  backend: AppBackend;
  clock: ManualClock;
  dataDir: string;
  logger: ReturnType<typeof createMemoryLogger>;
  call<T = unknown>(command: string, payload?: unknown, sessionId?: string | null): Promise<DispatchResponse & { data?: T }>;
}

export async function makeBackend(opts: { dataDir?: string; migrations?: readonly Migration[]; clock?: ManualClock } = {}): Promise<TestEnv> {
  const dataDir = opts.dataDir ?? tempDir();
  const clock = opts.clock ?? new ManualClock('2026-09-28T09:00:00.000Z');
  const logger = createMemoryLogger();
  const backend = await AppBackend.open({
    dataDir,
    appVersion: '0.1.0-test',
    clock,
    logger,
    hasher: createArgon2Hasher(TEST_ARGON2),
    ...(opts.migrations ? { migrations: opts.migrations } : {}),
  });
  open.push(backend);
  return {
    backend,
    clock,
    dataDir,
    logger,
    call: (command, payload = {}, sessionId = null) =>
      backend.dispatch({ command, payload, sessionId, workstation: 'TEST-PC' }) as never,
  };
}

export async function setupCompany(env: TestEnv): Promise<void> {
  const r = await env.call('system.setup', {
    company: COMPANY,
    admin: { username: ADMIN.username, displayName: 'Owner', password: ADMIN.password, locale: 'ar' },
  });
  if (!r.ok) throw new Error(`setup failed: ${JSON.stringify(r.error)}`);
}

export async function login(env: TestEnv, username = ADMIN.username, password = ADMIN.password): Promise<string> {
  const r = await env.call('auth.login', { username, password });
  if (!r.ok || !r.session || !('set' in r.session)) throw new Error(`login failed: ${JSON.stringify(r)}`);
  return r.session.set;
}

export function actor(env: TestEnv, sessionId: string): Actor {
  return env.backend.svc.sessions.resolve(sessionId);
}

/** Creates a user with the given roles and returns a logged-in session (temporary password already changed). */
export async function userWithRoles(env: TestEnv, adminSession: string, username: string, roleCodes: string[]): Promise<string> {
  const temp = 'temporary pass 12345';
  const created = await env.call('users.create', { username, displayName: username, password: temp, roleCodes }, adminSession);
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const s = await login(env, username, temp);
  const changed = await env.call('auth.changePassword', { currentPassword: temp, newPassword: USER_PASSWORD }, s);
  if (!changed.ok) throw new Error(JSON.stringify(changed.error));
  return s;
}

export async function ready(): Promise<{ env: TestEnv; adminSession: string; admin: Actor }> {
  const env = await makeBackend();
  await setupCompany(env);
  const adminSession = await login(env);
  return { env, adminSession, admin: actor(env, adminSession) };
}

const ids = createUlidGenerator();

/**
 * Minimal party/booking fixtures inserted with SQL. Their management screens
 * and services arrive in Phases 2–3; Phase 1 only needs valid references for
 * the ledger.
 */
export function fixtures(env: TestEnv, adminId: string) {
  const db = env.backend.svc.deps.db;
  const now = env.clock.now().toISOString();
  const customer = (name = 'Ahmed') => {
    const id = ids();
    db.prepare(
      `INSERT INTO customer (id, customer_no, full_name, primary_mobile, primary_mobile_raw, created_at, created_by, updated_at)
       VALUES (?, ?, ?, '+201001234567', '01001234567', ?, ?, ?)`,
    ).run(id, `C-${id.slice(-6)}`, name, now, adminId, now);
    return id;
  };
  const supplier = (currency = 'EGP') => {
    const id = ids();
    db.prepare(
      `INSERT INTO supplier (id, supplier_no, name, default_currency_code, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, `S-${id.slice(-6)}`, `Supplier ${id.slice(-4)}`, currency, now, adminId, now);
    return id;
  };
  const moneyAccount = (currency = 'EGP') => {
    const id = ids();
    db.prepare(`INSERT INTO money_account (id, name, account_type, currency_code, created_at, created_by) VALUES (?, ?, 'CASH', ?, ?, ?)`).run(
      id, `Cash ${currency} ${id.slice(-4)}`, currency, now, adminId,
    );
    return id;
  };
  const booking = (customerId: string, issueDate = '2026-09-01') => {
    const id = ids();
    db.prepare(
      `INSERT INTO booking (id, booking_no, customer_id, status, booking_date, issue_date, sale_currency_code, contact_name, contact_mobile,
         sales_agent_id, created_at, created_by, updated_at) VALUES (?, ?, ?, 'ISSUED', ?, ?, 'EGP', 'Ahmed', '+201001234567', ?, ?, ?, ?)`,
    ).run(id, `BK-${id.slice(-6)}`, customerId, issueDate, issueDate, adminId, now, adminId, now);
    return id;
  };
  const expenseCategory = (code: string) => (db.prepare('SELECT id FROM expense_category WHERE code = ?').get(code) as { id: string }).id;
  return { customer, supplier, moneyAccount, booking, expenseCategory };
}

/** Document builders mirroring the Phase 0 worked examples (amounts in EGP minor units). */
export const doc = {
  invoice: (c: string, b: string, amount: number, date = '2026-09-01', lineType: 'FARE' | 'CANCELLATION_FEE' | 'CHANGE_FEE' = 'FARE'): DocumentDraft => ({
    docType: 'CUSTOMER_INVOICE', docDate: date, currency: 'EGP', customerId: c, bookingId: b, lines: [{ lineType, amountMinor: amount }],
  }),
  creditNote: (c: string, b: string, amount: number, date: string, lineType: 'SALE_RETURN' | 'DISCOUNT' = 'SALE_RETURN'): DocumentDraft => ({
    docType: 'CUSTOMER_CREDIT_NOTE', docDate: date, currency: 'EGP', customerId: c, bookingId: b, lines: [{ lineType, amountMinor: amount }],
  }),
  bill: (s: string, b: string, amount: number, date = '2026-09-01', lineType: 'PURCHASE_COST' | 'SUPPLIER_PENALTY' = 'PURCHASE_COST'): DocumentDraft => ({
    docType: 'SUPPLIER_BILL', docDate: date, currency: 'EGP', supplierId: s, bookingId: b, lines: [{ lineType, amountMinor: amount }],
  }),
  supplierCredit: (s: string, b: string, amount: number, date: string): DocumentDraft => ({
    docType: 'SUPPLIER_CREDIT_NOTE', docDate: date, currency: 'EGP', supplierId: s, bookingId: b, lines: [{ lineType: 'PURCHASE_RETURN', amountMinor: amount }],
  }),
  receipt: (c: string, b: string, m: string, amount: number, date = '2026-09-02'): DocumentDraft => ({
    docType: 'CUSTOMER_RECEIPT', docDate: date, currency: 'EGP', customerId: c, moneyAccountId: m, paymentMethod: 'CASH',
    lines: [{ lineType: 'SETTLEMENT', amountMinor: amount, bookingId: b }],
  }),
  refund: (c: string, b: string, m: string, amount: number, date: string): DocumentDraft => ({
    docType: 'CUSTOMER_REFUND', docDate: date, currency: 'EGP', customerId: c, moneyAccountId: m, paymentMethod: 'CASH',
    lines: [{ lineType: 'SETTLEMENT', amountMinor: amount, bookingId: b }],
  }),
  supplierPayment: (s: string, b: string, m: string, amount: number, date = '2026-09-03'): DocumentDraft => ({
    docType: 'SUPPLIER_PAYMENT', docDate: date, currency: 'EGP', supplierId: s, moneyAccountId: m, paymentMethod: 'BANK_TRANSFER',
    lines: [{ lineType: 'SETTLEMENT', amountMinor: amount, bookingId: b }],
  }),
  supplierRefund: (s: string, b: string, m: string, amount: number, date: string): DocumentDraft => ({
    docType: 'SUPPLIER_REFUND', docDate: date, currency: 'EGP', supplierId: s, moneyAccountId: m, paymentMethod: 'BANK_TRANSFER',
    lines: [{ lineType: 'SETTLEMENT', amountMinor: amount, bookingId: b }],
  }),
};

export function bookingFinancials(env: TestEnv, bookingId: string) {
  const r = env.backend.svc.deps.db.prepare('SELECT * FROM v_booking_financials WHERE booking_id = ?').get(bookingId) as Record<string, number>;
  return {
    sales: r.net_sales_base_minor,
    cost: r.net_cost_base_minor,
    gp: r.gross_profit_base_minor,
    paid: r.customer_paid_net_base_minor,
    ar: r.customer_balance_base_minor,
    supplierPaid: r.supplier_paid_net_base_minor,
    ap: r.supplier_balance_base_minor,
  };
}

export function count(env: TestEnv, table: string): number {
  return (env.backend.svc.deps.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

export function auditActions(env: TestEnv): string[] {
  return (env.backend.svc.deps.db.prepare('SELECT action FROM audit_log ORDER BY seq').all() as { action: string }[]).map((r) => r.action);
}

export const newIdForTests = ids;
