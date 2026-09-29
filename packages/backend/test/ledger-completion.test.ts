import type { AgingRowDto, BookingDto, CustomerDto, DocumentDto, MoneyAccountDto, ReportDto, StatementDto, SupplierDto } from '@airdesk/contracts';
import { ErrorCode } from '@airdesk/domain';
import { describe, expect, it } from 'vitest';
import { book, fail, ok, receive, summary, world } from './flow';
import { auditActions, ready, userWithRoles } from './helpers';

/**
 * Phase 0 §04 P10–P12 through the public commands: go-live opening balances,
 * money transfers / owner capital / drawings, and applying credits.
 */
const accounts = async (env: Awaited<ReturnType<typeof ready>>['env'], s: string) => ok<MoneyAccountDto[]>(env, 'moneyAccounts.list', { includeInactive: true }, s);

describe('Opening balances (go-live)', () => {
  it('customer debt, supplier payable and cash open against equity; profit untouched; aged from their date', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const opening = (payload: Record<string, unknown>) => ok<DocumentDto>(env, 'openingBalances.record', { currency: 'EGP', date: '2026-06-30', ...payload }, s);
    const c = await opening({ target: 'CUSTOMER', targetId: w.customer.id, side: 'OWED_TO_OFFICE', amountMinor: 700_000, notes: 'From the old ledger' });
    expect(c).toMatchObject({ docType: 'OPENING_BALANCE', docNo: 'OPB-2026-000001', customerName: w.customer.fullName, totalMinor: 700_000, reasonCode: 'OPENING_DEBIT' });
    await opening({ target: 'SUPPLIER', targetId: w.supplier.id, side: 'OWED_BY_OFFICE', amountMinor: 2_000_000 });
    await opening({ target: 'MONEY_ACCOUNT', targetId: w.cash.id, side: 'OWED_TO_OFFICE', amountMinor: 500_000 });
    expect((await fail(env, 'openingBalances.record', { target: 'MONEY_ACCOUNT', targetId: w.cash.id, side: 'OWED_BY_OFFICE', currency: 'EGP', amountMinor: 1 }, s)).reason).toBe('NEGATIVE_CASH');

    const customer = await ok<CustomerDto>(env, 'customers.get', { id: w.customer.id }, s);
    expect(customer.balances).toEqual([{ currency: 'EGP', balanceMinor: 700_000 }]);
    const supplier = await ok<SupplierDto>(env, 'suppliers.get', { id: w.supplier.id }, s);
    expect(supplier.balances).toEqual([{ currency: 'EGP', balanceMinor: 2_000_000 }]);
    expect((await accounts(env, s)).find((a) => a.id === w.cash.id)!.balanceMinor).toBe(500_000);
    expect(summary(env)).toMatchObject({ sales: 0, purchases: 0, grossProfit: 0, netProfit: 0, collections: 0, receivables: 700_000, payables: 2_000_000 });

    const stmt = (await ok<StatementDto[]>(env, 'statements.get', { party: 'CUSTOMER', partyId: w.customer.id, from: '2026-07-01', to: '2026-12-31' }, s))[0]!;
    expect(stmt.openingMinor).toBe(700_000);
    const aging = await ok<AgingRowDto[]>(env, 'aging.get', { party: 'CUSTOMER', asOf: '2026-09-28' }, s);
    expect(aging[0]).toMatchObject({ d60PlusMinor: 700_000, totalMinor: 700_000, creditMinor: 0 });
    const listed = await ok<DocumentDto[]>(env, 'openingBalances.list', {}, s);
    expect(listed.map((d) => d.docNo)).toEqual(['OPB-2026-000003', 'OPB-2026-000002', 'OPB-2026-000001']);
    expect(auditActions(env)).toContain('finance.opening_balance_recorded');
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });

  it('paying an opening debt is not an overpayment; only the excess needs permission', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    await ok(env, 'openingBalances.record', { target: 'CUSTOMER', targetId: w.customer.id, side: 'OWED_TO_OFFICE', currency: 'EGP', amountMinor: 400_000 }, s);
    await ok(env, 'roles.create', { code: 'CASHIER', nameAr: 'خزينة', nameEn: 'Cashier', permissions: ['customer.view', 'payment.customer.receive'] }, s);
    const cashier = await userWithRoles(env, s, 'cashier', ['CASHIER']);
    const pay = (amountMinor: number) => ({ partyId: w.customer.id, currency: 'EGP', amountMinor, moneyAccountId: w.cash.id, paymentMethod: 'CASH', allocations: [], onAccountMinor: amountMinor });
    await ok(env, 'payments.receive', pay(300_000), cashier);
    expect((await fail(env, 'payments.receive', pay(150_000), cashier)).code).toBe(ErrorCode.FORBIDDEN); // 100,000 owed → 50,000 would be an overpayment
    await ok(env, 'payments.receive', pay(100_000), cashier);
    const customer = await ok<CustomerDto>(env, 'customers.get', { id: w.customer.id }, s);
    expect(customer.balances).toEqual([]);
    expect(summary(env).collections).toBe(400_000);
  });

  it('only finance.opening_balances may record openings; a wrong opening is corrected by reversal', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const manager = await userWithRoles(env, s, 'manager', ['MANAGER']);
    expect((await fail(env, 'openingBalances.record', { target: 'CUSTOMER', targetId: w.customer.id, side: 'OWED_TO_OFFICE', currency: 'EGP', amountMinor: 1 }, manager)).code).toBe(ErrorCode.FORBIDDEN);
    const d = await ok<DocumentDto>(env, 'openingBalances.record', { target: 'CUSTOMER', targetId: w.customer.id, side: 'OWED_TO_OFFICE', currency: 'EGP', amountMinor: 90_000 }, s);
    const rev = await ok<DocumentDto>(env, 'documents.cancel', { id: d.id, reason: 'Entered twice' }, s);
    expect(rev).toMatchObject({ isReversal: true, reversalOfNo: d.docNo });
    expect((await ok<CustomerDto>(env, 'customers.get', { id: w.customer.id }, s)).balances).toEqual([]);
  });
});

describe('Money transfers, owner capital and drawings', () => {
  it('moves cash to the bank, refuses overdrafts and currency mixing, and never touches profit or collections', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const bank = await ok<MoneyAccountDto>(env, 'moneyAccounts.save', { name: 'Bank', accountType: 'BANK', currencyCode: 'EGP', bankName: 'NBE' }, s);
    await ok(env, 'currency.setRate', { currencyCode: 'USD', rateDate: '2026-09-28', rate: '48' }, s);
    const usd = await ok<MoneyAccountDto>(env, 'moneyAccounts.save', { name: 'USD box', accountType: 'CASH', currencyCode: 'USD' }, s);
    const cap = await ok<DocumentDto>(env, 'treasury.transfer', { kind: 'OWNER_CAPITAL', toAccountId: w.cash.id, amountMinor: 1_000_000, notes: 'Owner funds' }, s);
    expect(cap).toMatchObject({ docType: 'MONEY_TRANSFER', reasonCode: 'OWNER_CAPITAL', moneyAccountName: w.cash.name, counterMoneyAccountId: null });
    const trf = await ok<DocumentDto>(env, 'treasury.transfer', { kind: 'ACCOUNT_TRANSFER', fromAccountId: w.cash.id, toAccountId: bank.id, amountMinor: 600_000, reference: 'DEP-1' }, s);
    expect(trf).toMatchObject({ moneyAccountName: w.cash.name, counterMoneyAccountName: 'Bank', paymentReference: 'DEP-1' });
    await ok(env, 'treasury.transfer', { kind: 'OWNER_DRAWING', fromAccountId: w.cash.id, amountMinor: 100_000 }, s);
    const balances = Object.fromEntries((await accounts(env, s)).map((a) => [a.name, a.balanceMinor]));
    expect(balances[w.cash.name]).toBe(300_000);
    expect(balances.Bank).toBe(600_000);

    expect((await fail(env, 'treasury.transfer', { kind: 'ACCOUNT_TRANSFER', fromAccountId: w.cash.id, toAccountId: bank.id, amountMinor: 300_001 }, s)).reason).toBe('INSUFFICIENT_FUNDS');
    expect((await fail(env, 'treasury.transfer', { kind: 'ACCOUNT_TRANSFER', fromAccountId: w.cash.id, toAccountId: usd.id, amountMinor: 1 }, s)).reason).toBe('CURRENCY_MISMATCH');
    expect((await fail(env, 'treasury.transfer', { kind: 'ACCOUNT_TRANSFER', fromAccountId: w.cash.id, toAccountId: w.cash.id, amountMinor: 1 }, s)).reason).toBe('SAME_ACCOUNT');
    expect((await fail(env, 'treasury.transfer', { kind: 'OWNER_DRAWING', fromAccountId: bank.id, amountMinor: 600_001 }, s)).reason).toBe('INSUFFICIENT_FUNDS');
    expect(summary(env)).toMatchObject({ sales: 0, grossProfit: 0, expenses: 0, netProfit: 0, collections: 0, supplierPayments: 0 });

    const listed = await ok<DocumentDto[]>(env, 'treasury.transfers', { from: '2026-01-01', to: '2026-12-31' }, s);
    expect(listed).toHaveLength(3);
    // Reversal puts the money back.
    await ok(env, 'documents.cancel', { id: trf.id, reason: 'Deposit bounced' }, s);
    const after = Object.fromEntries((await accounts(env, s)).map((a) => [a.name, a.balanceMinor]));
    expect(after[w.cash.name]).toBe(900_000);
    expect(after.Bank).toBe(0);
    expect(auditActions(env)).toContain('treasury.transferred');
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });

  it('owner movements need their own permission; agents cannot see transfers', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const bank = await ok<MoneyAccountDto>(env, 'moneyAccounts.save', { name: 'Bank', accountType: 'BANK', currencyCode: 'EGP' }, s);
    const accountant = await userWithRoles(env, s, 'acc', ['ACCOUNTANT']);
    const agent = await userWithRoles(env, s, 'agent', ['SALES_AGENT']);
    expect((await fail(env, 'treasury.transfer', { kind: 'OWNER_CAPITAL', toAccountId: w.cash.id, amountMinor: 100 }, accountant)).code).toBe(ErrorCode.FORBIDDEN);
    await ok(env, 'treasury.transfer', { kind: 'OWNER_CAPITAL', toAccountId: w.cash.id, amountMinor: 1000 }, s);
    const t = await ok<DocumentDto>(env, 'treasury.transfer', { kind: 'ACCOUNT_TRANSFER', fromAccountId: w.cash.id, toAccountId: bank.id, amountMinor: 500 }, accountant);
    expect((await fail(env, 'treasury.transfer', { kind: 'ACCOUNT_TRANSFER', fromAccountId: w.cash.id, toAccountId: bank.id, amountMinor: 1 }, agent)).code).toBe(ErrorCode.FORBIDDEN);
    expect((await fail(env, 'documents.get', { id: t.id }, agent)).code).toBe(ErrorCode.NOT_FOUND);
    expect((await fail(env, 'treasury.transfers', { from: '2026-01-01', to: '2026-12-31' }, agent)).code).toBe(ErrorCode.FORBIDDEN);
  });
});

describe('Applying credits', () => {
  it('customer credit on account settles a ticket record: paid rises, party balance and profit unchanged', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w); // 10,500.00 due
    await ok(env, 'payments.receive', { partyId: w.customer.id, currency: 'EGP', amountMinor: 300_000, moneyAccountId: w.cash.id, paymentMethod: 'CASH', allocations: [], onAccountMinor: 300_000 }, s);
    const gp = summary(env).grossProfit;
    expect((await fail(env, 'balances.apply', { party: 'CUSTOMER', partyId: w.customer.id, currency: 'EGP', allocations: [{ bookingId: b.id, amountMinor: 300_001 }] }, s)).reason).toBe('OVER_ALLOCATION');
    const apl = await ok<DocumentDto>(env, 'balances.apply', { party: 'CUSTOMER', partyId: w.customer.id, currency: 'EGP', allocations: [{ bookingId: b.id, amountMinor: 300_000 }], notes: 'Advance used' }, s);
    expect(apl).toMatchObject({ docType: 'BALANCE_APPLICATION', docNo: 'APL-2026-000001', totalMinor: 300_000 });
    const after = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(after.customer[0]).toMatchObject({ chargedMinor: 1_050_000, paidMinor: 300_000, balanceMinor: 750_000, settlement: 'PARTIALLY_PAID' });
    expect((await ok<CustomerDto>(env, 'customers.get', { id: w.customer.id }, s)).balances).toEqual([{ currency: 'EGP', balanceMinor: 750_000 }]);
    expect(summary(env).grossProfit).toBe(gp);
    expect(summary(env).collections).toBe(300_000); // the cash was collected once, not again
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });

  it('moves a credit left on one record to another record of the same customer', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const a = await book(env, s, w, { saleMinor: 100_000, costMinor: 90_000 });
    const b = await book(env, s, w, { saleMinor: 200_000, costMinor: 180_000 });
    await receive(env, s, w, a.id, 100_000);
    await ok(env, 'bookings.adjustSale', { bookingId: a.id, ticketId: a.tickets[0]!.id, kind: 'DECREASE', amountMinor: 30_000, reason: 'Goodwill' }, s);
    let aNow = await ok<BookingDto>(env, 'bookings.get', { id: a.id }, s);
    const credit = -aNow.customer[0]!.balanceMinor;
    expect(credit).toBeGreaterThan(0);
    await ok(env, 'balances.apply', { party: 'CUSTOMER', partyId: w.customer.id, currency: 'EGP', fromBookingId: a.id, allocations: [{ bookingId: b.id, amountMinor: credit }] }, s);
    aNow = await ok<BookingDto>(env, 'bookings.get', { id: a.id }, s);
    const bNow = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(aNow.customer[0]!.balanceMinor).toBe(0);
    expect(bNow.customer[0]!.paidMinor).toBe(credit);
    expect((await fail(env, 'balances.apply', { party: 'CUSTOMER', partyId: w.customer.id, currency: 'EGP', fromBookingId: a.id, allocations: [{ bookingId: a.id, amountMinor: 1 }] }, s)).reason).toBe('SAME_RECORD');
  });

  it('supplier advance settles a record payable; hidden from users without cost visibility', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w); // cost 10,100.00 payable
    await ok(env, 'payments.paySupplier', { partyId: w.supplier.id, currency: 'EGP', amountMinor: 1_010_000, moneyAccountId: w.cash.id, paymentMethod: 'BANK_TRANSFER', allocations: [], onAccountMinor: 1_010_000 }, s);
    await ok(env, 'balances.apply', { party: 'SUPPLIER', partyId: w.supplier.id, currency: 'EGP', allocations: [{ bookingId: b.id, amountMinor: 1_010_000 }] }, s);
    const after = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(after.suppliers![0]).toMatchObject({ billedMinor: 1_010_000, paidMinor: 1_010_000, balanceMinor: 0, settlement: 'PAID' });
    expect((await ok<SupplierDto>(env, 'suppliers.get', { id: w.supplier.id }, s)).balances).toEqual([]);
    await ok(env, 'roles.create', { code: 'FRONT', nameAr: 'استقبال', nameEn: 'Front desk', permissions: ['booking.view', 'booking.view_all', 'balance.apply'] }, s);
    const front = await userWithRoles(env, s, 'front', ['FRONT']);
    const seen = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, front);
    expect(seen.documents.map((d) => d.docType)).toEqual(['CUSTOMER_INVOICE']); // bill, supplier payment and supplier-side application stay hidden
    expect(seen.suppliers).toBeNull();
    const apl = after.documents.find((d) => d.docType === 'BALANCE_APPLICATION')!;
    expect((await fail(env, 'documents.get', { id: apl.id }, front)).code).toBe(ErrorCode.NOT_FOUND);
    expect((await fail(env, 'balances.apply', { party: 'SUPPLIER', partyId: w.supplier.id, currency: 'EGP', allocations: [{ bookingId: b.id, amountMinor: 1 }] }, front)).code).toBe(ErrorCode.FORBIDDEN);
    const agent = await userWithRoles(env, s, 'agent', ['SALES_AGENT']);
    expect((await fail(env, 'balances.apply', { party: 'SUPPLIER', partyId: w.supplier.id, currency: 'EGP', allocations: [{ bookingId: b.id, amountMinor: 1 }] }, agent)).code).toBe(ErrorCode.FORBIDDEN);
  });

  it('foreign currency: credit and record carried at different rates realise FX; both clear to zero in base', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    await ok(env, 'currency.setRate', { currencyCode: 'USD', rateDate: '2026-09-28', rate: '50' }, s);
    const usd = await ok<MoneyAccountDto>(env, 'moneyAccounts.save', { name: 'USD box', accountType: 'CASH', currencyCode: 'USD' }, s);
    await ok(env, 'payments.receive', { partyId: w.customer.id, currency: 'USD', amountMinor: 10_000, moneyAccountId: usd.id, paymentMethod: 'CASH', allocations: [], onAccountMinor: 10_000 }, s);
    await ok(env, 'currency.setRate', { currencyCode: 'USD', rateDate: '2026-09-28', rate: '48' }, s);
    const b = await book(env, s, w, { saleCurrency: 'USD', saleMinor: 10_000, costMinor: 9_000, costCurrency: 'USD' });
    await ok(env, 'balances.apply', { party: 'CUSTOMER', partyId: w.customer.id, currency: 'USD', allocations: [{ bookingId: b.id, amountMinor: 10_000 }] }, s);
    const db = env.backend.svc.deps.db;
    const base = db.prepare(`SELECT COALESCE(SUM(debit_base_minor - credit_base_minor), 0) AS v FROM journal_line WHERE account_code = '1200' AND customer_id = ?`).get(w.customer.id) as { v: number };
    expect(base.v).toBe(0);
    expect(summary(env).otherIncome).toBe(20_000); // received at 50, invoiced at 48 → 100 USD × 2 EGP gain
    const profit = await ok<ReportDto>(env, 'reports.run', { report: 'profit', from: '2026-01-01', to: '2026-12-31' }, s);
    expect(profit.rows[0]).toMatchObject({ gross_profit: 48_000 });
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });
});
