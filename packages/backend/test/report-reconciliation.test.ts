import type { BookingDto, CancellationDto, DashboardMetricsDto, ExpenseCategoryDto, LedgerSummaryDto, MoneyAccountDto, ReportDto, StatementDto } from '@airdesk/contracts';
import { describe, expect, it } from 'vitest';
import { book, ok, paySupplier, receive, world } from './flow';
import { ready } from './helpers';

/**
 * Every report must agree with the ledger and with figures computed by hand
 * from a known month of activity (all in the base currency, EGP).
 */
describe('Reports reconcile with the ledger and with hand-computed figures', () => {
  it('sales, purchases, profit, aging, supplier volume, expenses, collections, cash book, statements and dashboard', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const period = { from: '2026-09-01', to: '2026-09-30' };
    const bank = await ok<MoneyAccountDto>(env, 'moneyAccounts.save', { name: 'Bank', accountType: 'BANK', currencyCode: 'EGP' }, s);
    await ok(env, 'treasury.transfer', { kind: 'OWNER_CAPITAL', toAccountId: w.cash.id, amountMinor: 2_000_000 }, s); // +20,000 cash (not a collection)
    await ok(env, 'openingBalances.record', { target: 'CUSTOMER', targetId: w.customer.id, side: 'OWED_TO_OFFICE', currency: 'EGP', amountMinor: 30_000, date: '2026-08-31' }, s);

    // A: sale 10,500 / cost 10,100, fully paid by the customer, supplier paid 6,000.
    const a = await book(env, s, w);
    await receive(env, s, w, a.id, 1_050_000);
    await paySupplier(env, s, w, a.id, 600_000);
    // B: sale 5,000 with a 200 discount → net 4,800; cost 4,500; customer pays 1,000.
    const b = await book(env, s, w, { saleMinor: 500_000, costMinor: 450_000, discountMinor: 20_000 });
    await receive(env, s, w, b.id, 100_000);
    // C: sale 3,000 / cost 2,800, cancelled: supplier returns 2,500 + penalty 100; customer credited 3,000 with a 200 fee.
    let c = await book(env, s, w, { saleMinor: 300_000, costMinor: 280_000 });
    await receive(env, s, w, c.id, 300_000); // paid in full before the trip was cancelled
    let cx = await ok<CancellationDto>(env, 'cancellations.request', { bookingId: c.id, cancelType: 'REFUND', reason: 'Trip cancelled' }, s);
    cx = await ok<CancellationDto>(env, 'cancellations.submit', { id: cx.id, rowVersion: cx.rowVersion }, s);
    cx = await ok<CancellationDto>(env, 'cancellations.confirmSupplier', { id: cx.id, rowVersion: cx.rowVersion, lines: [{ ticketId: c.tickets[0]!.id, returnMinor: 250_000, penaltyMinor: 10_000 }] }, s);
    await ok(env, 'cancellations.creditCustomer', { id: cx.id, rowVersion: cx.rowVersion, lines: [{ ticketId: c.tickets[0]!.id, returnMinor: 300_000 }], cancellationFeeMinor: 20_000 }, s);
    c = await ok<BookingDto>(env, 'bookings.get', { id: c.id }, s);
    // Customer credit on C (3,000 − 200 fee = 2,800) is applied to B.
    await ok(env, 'balances.apply', { party: 'CUSTOMER', partyId: w.customer.id, currency: 'EGP', fromBookingId: c.id, allocations: [{ bookingId: b.id, amountMinor: 280_000 }] }, s);
    // Expense 700 from cash; transfer 5,000 cash → bank.
    const cat = (await ok<ExpenseCategoryDto[]>(env, 'expenseCategories.list', {}, s))[0]!;
    await ok(env, 'expenses.create', { categoryId: cat.id, currency: 'EGP', amountMinor: 70_000, moneyAccountId: w.cash.id, paymentMethod: 'CASH', description: 'Internet' }, s);
    await ok(env, 'treasury.transfer', { kind: 'ACCOUNT_TRANSFER', fromAccountId: w.cash.id, toAccountId: bank.id, amountMinor: 500_000 }, s);

    // Hand-computed expectations (minor units):
    const sales = 1_050_000 + (500_000 - 20_000) + (300_000 - 300_000 + 20_000); // A + B net + C (returned) + C fee = 1,550,000
    const purchases = 1_010_000 + 450_000 + (280_000 - 250_000 + 10_000); // A + B + C net cost incl. penalty = 1,500,000
    const expenses = 70_000;
    const collections = 1_050_000 + 100_000 + 300_000;
    const supplierPayments = 600_000;
    const receivables = 30_000 + (480_000 - 100_000 - 280_000); // opening debt + B remaining = 130,000
    const payables = (1_010_000 - 600_000) + 450_000 + (280_000 - 250_000 + 10_000); // A remaining + B + C net = 900,000
    const cashEnd = 2_000_000 + 1_050_000 - 600_000 + 100_000 + 300_000 - 70_000 - 500_000; // 2,280,000

    const summary = await ok<LedgerSummaryDto>(env, 'ledger.summary', period, s);
    expect(summary).toMatchObject({ sales, purchases, grossProfit: sales - purchases, expenses, netProfit: sales - purchases - expenses, collections, supplierPayments, receivables, payables });
    const run = (report: string) => ok<ReportDto>(env, 'reports.run', { report, ...period }, s);
    const total = (r: ReportDto, key: string) => r.rows.reduce((x, row) => x + (Number(row[key]) || 0), 0);
    expect(total(await run('sales'), 'base')).toBe(sales);
    expect(total(await run('purchases'), 'base')).toBe(purchases);
    const profit = await run('profit');
    expect(total(profit, 'gross_profit')).toBe(sales - purchases);
    expect(total(await run('receivables'), 'total')).toBe(receivables);
    expect(total(await run('payables'), 'total')).toBe(payables);
    const sv = await run('supplier_volume');
    expect(total(sv, 'purchases')).toBe(purchases);
    expect(total(sv, 'payments')).toBe(supplierPayments);
    expect(total(sv, 'outstanding')).toBe(payables);
    expect(total(await run('expenses'), 'base')).toBe(expenses);
    expect(total(await run('collections'), 'base')).toBe(collections);
    const cancellations = await run('cancellations');
    expect(cancellations.rows[0]).toMatchObject({ sale_returned: 300_000, fees: 20_000, cost_returned: 250_000, penalties: 10_000, net_impact: 20_000 - 300_000 + 250_000 - 10_000 });
    const cash = (await run('cash_book')).rows.filter((r) => r.account === w.cash.name);
    expect(cash[cash.length - 1]!.balance).toBe(cashEnd);
    const accounts = await ok<MoneyAccountDto[]>(env, 'moneyAccounts.list', {}, s);
    expect(accounts.find((x) => x.id === w.cash.id)!.balanceMinor).toBe(cashEnd);
    expect(accounts.find((x) => x.id === bank.id)!.balanceMinor).toBe(500_000);
    const stmt = (await ok<StatementDto[]>(env, 'statements.get', { party: 'CUSTOMER', partyId: w.customer.id, ...period }, s))[0]!;
    expect(stmt.openingMinor).toBe(30_000);
    expect(stmt.closingMinor).toBe(receivables);
    const supStmt = (await ok<StatementDto[]>(env, 'statements.get', { party: 'SUPPLIER', partyId: w.supplier.id, ...period }, s))[0]!;
    expect(supStmt.closingMinor).toBe(payables);
    const dash = await ok<DashboardMetricsDto>(env, 'dashboard.metrics', period, s);
    expect(dash.financial).toMatchObject({ sales, purchases, grossProfit: sales - purchases, expenses, netProfit: sales - purchases - expenses, collections, receivables, payables });
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });
});
