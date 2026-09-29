import type { BookingDto, CustomerDto, MoneyAccountDto, StatementDto } from '@airdesk/contracts';
import { ErrorCode } from '@airdesk/domain';
import { describe, expect, it } from 'vitest';
import { book, fail, ok, receive, summary, world } from './flow';
import { ADMIN, login, makeBackend, ready } from './helpers';

const count = (env: Awaited<ReturnType<typeof ready>>['env'], sql: string) => (env.backend.svc.deps.db.prepare(sql).get() as { n: number }).n;
const base1200 = (env: Awaited<ReturnType<typeof ready>>['env'], customerId: string) =>
  (env.backend.svc.deps.db.prepare(`SELECT COALESCE(SUM(debit_base_minor - credit_base_minor), 0) AS v FROM journal_line WHERE account_code = '1200' AND customer_id = ?`).get(customerId) as { v: number }).v;

describe('Financial audit — precision, rounding, atomicity, conservation', () => {
  it('a new office can use a 3-decimal base currency (OMR) end to end', async () => {
    const env = await makeBackend();
    const r = await env.call('system.status', {});
    expect((r.data as { setupCurrencies: { code: string }[] }).setupCurrencies.map((c) => c.code)).toEqual(expect.arrayContaining(['OMR', 'BHD', 'JOD', 'QAR', 'KWD']));
    const setup = await env.call('system.setup', {
      company: { legalNameAr: 'مكتب مسقط للسفر', baseCurrencyCode: 'OMR', defaultCountryCode: 'OM', timezone: 'Asia/Muscat', defaultLocale: 'ar' },
      admin: { username: ADMIN.username, displayName: 'Owner', password: ADMIN.password, locale: 'ar' },
    });
    expect(setup.ok).toBe(true);
    const s = await login(env);
    const currencies = await ok<{ code: string; isActive: boolean; minorUnit: number }[]>(env, 'currency.list', {}, s);
    expect(currencies.find((c) => c.code === 'OMR')).toMatchObject({ isActive: true, minorUnit: 3 });
    expect(currencies.find((c) => c.code === 'BHD')).toMatchObject({ isActive: false });
    const cash = (await ok<MoneyAccountDto[]>(env, 'moneyAccounts.list', {}, s))[0]!;
    expect(cash.currencyCode).toBe('OMR');
    const customer = await ok<CustomerDto>(env, 'customers.create', { customer: { fullName: 'Said Al Harthy', primaryMobile: '+968 9123 4567' } }, s);
    const supplier = await ok<{ id: string }>(env, 'suppliers.create', { supplier: { name: 'Muscat Consolidator', defaultCurrencyCode: 'OMR' } }, s);
    const airline = await ok<{ id: string }>(env, 'airlines.create', { airline: { nameEn: 'Oman Air', iataCode: 'WY', ticketPrefix: '910' } }, s);
    let b = await ok<BookingDto>(env, 'bookings.create', { customerId: customer.id, pnr: 'MCT123', supplierId: supplier.id }, s);
    b = await ok<BookingDto>(env, 'bookings.savePassenger', { bookingId: b.id, passenger: { givenName: 'SAID', surname: 'ALHARTHY' } }, s);
    b = await ok<BookingDto>(env, 'bookings.saveSegment', { bookingId: b.id, segment: { airlineId: airline.id, flightNumber: '101', origin: 'MCT', destination: 'DXB', departureDate: '2026-11-01', departureTime: '08:00', arrivalDate: '2026-11-01', arrivalTime: '09:10' } }, s).catch(async () => {
      await ok(env, 'airports.create', { airport: { iataCode: 'MCT', nameEn: 'Muscat International', countryCode: 'OM' } }, s);
      return ok<BookingDto>(env, 'bookings.saveSegment', { bookingId: b.id, segment: { airlineId: airline.id, flightNumber: '101', origin: 'MCT', destination: 'DXB', departureDate: '2026-11-01', departureTime: '08:00', arrivalDate: '2026-11-01', arrivalTime: '09:10' } }, s);
    });
    b = await ok<BookingDto>(env, 'bookings.savePriceItem', { bookingId: b.id, item: { passengerId: b.passengers[0]!.id, supplierId: supplier.id, fareMinor: 120_500, serviceFeeMinor: 5_000, costMinor: 118_125, costCurrency: 'OMR' } }, s);
    b = await ok<BookingDto>(env, 'bookings.issue', { id: b.id, rowVersion: b.rowVersion }, s);
    await ok(env, 'payments.receive', { partyId: customer.id, currency: 'OMR', amountMinor: 50_250, moneyAccountId: cash.id, paymentMethod: 'CASH', allocations: [{ bookingId: b.id, amountMinor: 50_250 }] }, s);
    b = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(b.customer[0]).toMatchObject({ currency: 'OMR', chargedMinor: 125_500, paidMinor: 50_250, balanceMinor: 75_250 }); // 125.500 − 50.250 = 75.250
    expect(b.profit).toEqual({ netSalesBaseMinor: 125_500, netCostBaseMinor: 118_125, grossProfitBaseMinor: 7_375 });
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });

  it('a 3-decimal foreign sale (KWD) settled in parts at another rate leaves no base-currency residue', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    await ok(env, 'currency.setRate', { currencyCode: 'KWD', rateDate: '2026-09-28', rate: '160.5' }, s);
    const kwd = await ok<MoneyAccountDto>(env, 'moneyAccounts.save', { name: 'KWD box', accountType: 'CASH', currencyCode: 'KWD' }, s);
    const b = await book(env, s, w, { saleCurrency: 'KWD', saleMinor: 1_250, costMinor: 1_100, costCurrency: 'KWD' }); // 1.250 KWD
    const inv = b.documents.find((d) => d.docType === 'CUSTOMER_INVOICE')!;
    expect(inv).toMatchObject({ totalMinor: 1_250, totalBaseMinor: 20_063 }); // 200.625 EGP → half-up 200.63
    await ok(env, 'currency.setRate', { currencyCode: 'KWD', rateDate: '2026-09-28', rate: '161' }, s);
    const pay = (amountMinor: number) => ok(env, 'payments.receive', { partyId: w.customer.id, currency: 'KWD', amountMinor, moneyAccountId: kwd.id, paymentMethod: 'CASH', allocations: [{ bookingId: b.id, amountMinor }] }, s);
    await pay(625);
    await pay(625);
    expect(base1200(env, w.customer.id)).toBe(0); // carrying values clear the receivable exactly
    const after = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(after.customer[0]).toMatchObject({ balanceMinor: 0, settlement: 'PAID' });
    // Each receipt is valued on its own: 0.625 × 161 = 100.625 EGP → half-up 100.63; twice = 201.26 EGP.
    // The receivable was carried at 200.63, so the realised FX gain is exactly 0.63 — explained, not a residue.
    expect(summary(env).otherIncome).toBe(2 * 10_063 - 20_063);
    const cashBase = (env.backend.svc.deps.db.prepare(`SELECT SUM(debit_base_minor - credit_base_minor) AS v FROM journal_line WHERE account_code = '1110' AND money_account_id = ?`).get(kwd.id) as { v: number }).v;
    expect(cashBase).toBe(20_126);
    const stmt = await ok<StatementDto[]>(env, 'statements.get', { party: 'CUSTOMER', partyId: w.customer.id, from: '2026-01-01', to: '2026-12-31' }, s);
    expect(stmt.find((x) => x.currency === 'KWD')!.closingMinor).toBe(0);
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });

  it('an operation that fails halfway leaves no partial accounting data', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    // Sale in EGP, cost in USD with no USD rate: the invoice is posted inside the transaction, then the bill fails.
    const b = await book(env, s, w, { costCurrency: 'USD', issue: false });
    const before = { docs: count(env, 'SELECT COUNT(*) AS n FROM fin_document'), lines: count(env, 'SELECT COUNT(*) AS n FROM journal_line'), tickets: count(env, 'SELECT COUNT(*) AS n FROM ticket'), audit: count(env, 'SELECT COUNT(*) AS n FROM audit_log') };
    const r = await env.call('bookings.issue', { id: b.id, rowVersion: b.rowVersion }, s);
    expect(r.ok).toBe(false);
    expect(count(env, 'SELECT COUNT(*) AS n FROM fin_document')).toBe(before.docs);
    expect(count(env, 'SELECT COUNT(*) AS n FROM journal_line')).toBe(before.lines);
    expect(count(env, 'SELECT COUNT(*) AS n FROM ticket')).toBe(before.tickets);
    expect(count(env, `SELECT COUNT(*) AS n FROM document_sequence WHERE sequence_key IN ('CUSTOMER_INVOICE','SUPPLIER_BILL') AND next_value > 1`)).toBe(0); // numbering rolled back: no gaps
    const still = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(still.status).toBe('DRAFT');
    // A payment whose second allocation is invalid posts nothing at all.
    const issued = await book(env, s, w);
    const docsBefore = count(env, 'SELECT COUNT(*) AS n FROM fin_document');
    expect((await fail(env, 'payments.receive', { partyId: w.customer.id, currency: 'EGP', amountMinor: 2_100_000, moneyAccountId: w.cash.id, paymentMethod: 'CASH', allocations: [{ bookingId: issued.id, amountMinor: 1_000_000 }, { bookingId: b.id, amountMinor: 1_100_000 }] }, s)).code).toBe(ErrorCode.VALIDATION);
    expect(count(env, 'SELECT COUNT(*) AS n FROM fin_document')).toBe(docsBefore);
    expect(count(env, 'SELECT COUNT(*) AS n FROM audit_log')).toBeGreaterThan(before.audit); // only the successful issue above added records
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });

  it('transfers never create or destroy money; only capital and drawings change total cash', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const bank = await ok<MoneyAccountDto>(env, 'moneyAccounts.save', { name: 'Bank', accountType: 'BANK', currencyCode: 'EGP' }, s);
    const total = () => (env.backend.svc.deps.db.prepare(`SELECT COALESCE(SUM(debit_base_minor - credit_base_minor), 0) AS v FROM journal_line WHERE account_code = '1110'`).get() as { v: number }).v;
    await ok(env, 'treasury.transfer', { kind: 'OWNER_CAPITAL', toAccountId: w.cash.id, amountMinor: 1_000_000 }, s);
    expect(total()).toBe(1_000_000);
    for (let i = 0; i < 5; i++) await ok(env, 'treasury.transfer', { kind: 'ACCOUNT_TRANSFER', fromAccountId: i % 2 ? bank.id : w.cash.id, toAccountId: i % 2 ? w.cash.id : bank.id, amountMinor: 100_000 - i }, s);
    expect(total()).toBe(1_000_000);
    await ok(env, 'treasury.transfer', { kind: 'OWNER_DRAWING', fromAccountId: w.cash.id, amountMinor: 250_000 }, s);
    expect(total()).toBe(750_000);
    const s2 = summary(env);
    expect([s2.sales, s2.grossProfit, s2.expenses, s2.netProfit, s2.collections]).toEqual([0, 0, 0, 0, 0]);
    const b = await book(env, s, w);
    await receive(env, s, w, b.id, 100_000);
    expect(total()).toBe(850_000);
  });
});
