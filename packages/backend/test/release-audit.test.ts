import type { BookingDto, CancellationDto, DashboardMetricsDto, MoneyAccountDto, ReportDto, SupplierDto } from '@airdesk/contracts';
import { ErrorCode } from '@airdesk/domain';
import { describe, expect, it } from 'vitest';
import { book, ok, paySupplier, receive, seg, world } from './flow';
import { ready, userWithRoles } from './helpers';

/**
 * Pre-release audit: a Sales Agent calling the backend directly (bypassing the
 * UI) must not reach cost, profit, supplier money, treasury, owner movements,
 * opening balances, backups or administration — and must only see own records.
 */
describe('Sales Agent calling the backend directly', () => {
  it('every restricted command is refused', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    const agent = await userWithRoles(env, s, 'agent', ['SALES_AGENT']);
    const bill = b.documents.find((d) => d.docType === 'SUPPLIER_BILL')!;
    const y = { from: '2026-01-01', to: '2026-12-31' };
    const denied: [string, unknown][] = [
      ['reports.run', { report: 'profit', ...y }], ['reports.run', { report: 'purchases', ...y }], ['reports.run', { report: 'payables', ...y }],
      ['reports.run', { report: 'receivables', ...y }], ['reports.run', { report: 'supplier_volume', ...y }], ['reports.run', { report: 'cash_book', ...y }],
      ['reports.run', { report: 'expenses', ...y }], ['reports.run', { report: 'employee_activity', ...y }], ['reports.run', { report: 'collections', ...y }],
      ['ledger.summary', y], ['ledger.trialBalance', { asOf: '2026-12-31' }], ['aging.get', { party: 'SUPPLIER', asOf: '2026-12-31' }],
      ['statements.get', { party: 'SUPPLIER', partyId: w.supplier.id, ...y }],
      ['payments.openItems', { party: 'SUPPLIER', partyId: w.supplier.id }],
      ['payments.paySupplier', { partyId: w.supplier.id, currency: 'EGP', amountMinor: 1, moneyAccountId: w.cash.id, paymentMethod: 'CASH', allocations: [], onAccountMinor: 1 }],
      ['treasury.transfer', { kind: 'OWNER_DRAWING', fromAccountId: w.cash.id, amountMinor: 1 }],
      ['treasury.transfers', y], ['openingBalances.record', { target: 'CUSTOMER', targetId: w.customer.id, side: 'OWED_BY_OFFICE', currency: 'EGP', amountMinor: 1 }],
      ['openingBalances.list', {}], ['balances.apply', { party: 'CUSTOMER', partyId: w.customer.id, currency: 'EGP', allocations: [{ bookingId: b.id, amountMinor: 1 }] }],
      ['backup.create', {}], ['backup.list', {}], ['backup.schedule', {}], ['backup.setSchedule', { intervalHours: 0, keep: 1 }],
      ['backup.restore', { filePath: 'C:\\x.adbk', password: 'another real secret 987', confirmation: 'RESTORE' }],
      ['integrity.run', {}], ['audit.list', {}], ['users.list', {}], ['roles.list', {}],
      ['users.create', { username: 'evil', displayName: 'x', password: 'temporary pass 12345', roleCodes: ['ADMIN'] }],
      ['currency.setRate', { currencyCode: 'USD', rateDate: '2026-09-28', rate: '1' }], ['moneyAccounts.save', { name: 'x', accountType: 'CASH', currencyCode: 'EGP' }],
      ['expenses.create', { categoryId: w.cash.id, currency: 'EGP', amountMinor: 1, moneyAccountId: w.cash.id, paymentMethod: 'CASH', description: 'x' }],
      ['bookings.adjustCost', { bookingId: b.id, ticketId: b.tickets[0]!.id, kind: 'DECREASE', amountMinor: 1, reason: 'x' }],
      ['bookings.reissue', { bookingId: b.id, ticketId: b.tickets[0]!.id, rowVersion: b.rowVersion, reason: 'x' }],
      ['cancellations.confirmSupplier', { id: b.id, rowVersion: 1, lines: [{ ticketId: b.tickets[0]!.id, returnMinor: 1 }] }],
    ];
    for (const [command, payload] of denied) {
      const r = await env.call(command, payload, agent);
      expect(r.ok, command).toBe(false);
      expect(['FORBIDDEN', 'NOT_FOUND'], `${command} → ${r.ok ? 'ok' : r.error.code}`).toContain(r.ok ? 'ok' : r.error.code);
    }
    // Documents that reveal cost are invisible, not merely hidden in the UI.
    expect((await env.call('documents.get', { id: bill.id }, agent)).ok).toBe(false);
    // Reads that are allowed come back redacted.
    const supplier = await ok<SupplierDto>(env, 'suppliers.get', { id: w.supplier.id }, agent);
    expect(supplier.balances).toBeNull();
    const accounts = await ok<MoneyAccountDto[]>(env, 'moneyAccounts.list', {}, agent).catch(() => [] as MoneyAccountDto[]);
    expect(accounts.every((a) => a.balanceMinor === null)).toBe(true);
    const dash = await ok<DashboardMetricsDto>(env, 'dashboard.metrics', y, agent);
    expect(dash.financial).toBeNull();
  });

  it('cancellations never show supplier refunds or penalties to users without cost visibility', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const agent = await userWithRoles(env, s, 'agent', ['SALES_AGENT']);
    // The agent records the sale; the office records the supplier's refund answer.
    let b = await ok<BookingDto>(env, 'bookings.create', { customerId: w.customer.id, pnr: 'AGT123', supplierId: w.supplier.id }, agent);
    b = await ok<BookingDto>(env, 'bookings.savePassenger', { bookingId: b.id, passenger: { givenName: 'Mona', surname: 'Ali' } }, agent);
    b = await ok<BookingDto>(env, 'bookings.saveSegment', { bookingId: b.id, segment: seg(w.airline.id) }, agent);
    b = await ok<BookingDto>(env, 'bookings.savePriceItem', { bookingId: b.id, item: { passengerId: b.passengers[0]!.id, supplierId: w.supplier.id, fareMinor: 900_000, costMinor: 800_000, costCurrency: 'EGP' } }, agent);
    b = await ok<BookingDto>(env, 'bookings.issue', { id: b.id, rowVersion: b.rowVersion }, agent);
    let c = await ok<CancellationDto>(env, 'cancellations.request', { bookingId: b.id, cancelType: 'REFUND', reason: 'x', expectedSupplierRefundMinor: 700_000, expectedCurrency: 'EGP' }, agent);
    expect(c.expectedSupplierRefund).toBeNull();
    c = await ok<CancellationDto>(env, 'cancellations.submit', { id: c.id, rowVersion: c.rowVersion }, s);
    c = await ok<CancellationDto>(env, 'cancellations.confirmSupplier', { id: c.id, rowVersion: c.rowVersion, lines: [{ ticketId: b.tickets[0]!.id, returnMinor: 700_000, penaltyMinor: 50_000 }] }, s);
    expect(c.expectedSupplierRefund).toEqual({ currency: 'EGP', minor: 700_000 });
    expect(c.documents.map((d) => d.docType).sort()).toEqual(['SUPPLIER_BILL', 'SUPPLIER_CREDIT_NOTE']);
    const seen = await ok<CancellationDto>(env, 'cancellations.get', { id: c.id }, agent);
    expect(seen.expectedSupplierRefund).toBeNull();
    expect(seen.documents).toEqual([]);
    const listed = await ok<CancellationDto[]>(env, 'cancellations.list', { status: 'ALL' }, agent);
    expect(listed.flatMap((x) => x.documents)).toEqual([]);
    const record = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, agent);
    expect(record.cancellations[0]!.documents).toEqual([]);
    expect(JSON.stringify(record)).not.toContain('700000');
    expect(JSON.stringify(record)).not.toContain('800000');
  });

  it('the flight changes report only lists the agent’s own records', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const other = await book(env, s, w); // created by the owner
    await ok(env, 'bookings.saveSegment', { bookingId: other.id, segmentId: other.segments[0]!.id, segment: seg(w.airline.id, { departureTime: '18:00' }), reason: 'Airline notice' }, s);
    const agent = await userWithRoles(env, s, 'agent', ['SALES_AGENT']);
    const agentView = await ok<ReportDto>(env, 'reports.run', { report: 'flight_changes', from: '2026-01-01', to: '2026-12-31' }, agent);
    expect(agentView.rows).toEqual([]);
    const ownerView = await ok<ReportDto>(env, 'reports.run', { report: 'flight_changes', from: '2026-01-01', to: '2026-12-31' }, s);
    expect(ownerView.rows).toHaveLength(1);
  });
});

describe('Cash & bank book', () => {
  it('opening + in − out = running balance per account, matching the account balance', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const bank = await ok<MoneyAccountDto>(env, 'moneyAccounts.save', { name: 'Bank', accountType: 'BANK', currencyCode: 'EGP' }, s);
    await ok(env, 'openingBalances.record', { target: 'MONEY_ACCOUNT', targetId: w.cash.id, side: 'OWED_TO_OFFICE', currency: 'EGP', amountMinor: 100_000, date: '2026-08-31' }, s);
    const b = await book(env, s, w);
    await receive(env, s, w, b.id, 500_000); // +5,000
    await paySupplier(env, s, w, b.id, 300_000); // −3,000
    await ok(env, 'treasury.transfer', { kind: 'ACCOUNT_TRANSFER', fromAccountId: w.cash.id, toAccountId: bank.id, amountMinor: 200_000 }, s);
    const r = await ok<ReportDto>(env, 'reports.run', { report: 'cash_book', from: '2026-09-01', to: '2026-09-30' }, s);
    const cash = r.rows.filter((x) => x.account === w.cash.name);
    expect(cash.map((x) => [x.doc_type, x.money_in, x.money_out, x.balance])).toEqual([
      ['OPENING', null, null, 100_000],
      ['CUSTOMER_RECEIPT', 500_000, null, 600_000],
      ['SUPPLIER_PAYMENT', null, 300_000, 300_000],
      ['MONEY_TRANSFER', null, 200_000, 100_000],
    ]);
    expect(r.rows.filter((x) => x.account === 'Bank').map((x) => x.balance)).toEqual([0, 200_000]);
    const list = await ok<MoneyAccountDto[]>(env, 'moneyAccounts.list', {}, s);
    expect(list.find((a) => a.id === w.cash.id)!.balanceMinor).toBe(100_000);
    expect(list.find((a) => a.id === bank.id)!.balanceMinor).toBe(200_000);
  });
});

describe('Hostile payloads', () => {
  it('prototype-pollution keys, unknown keys and unknown commands are rejected before any handler runs', async () => {
    const { env, adminSession: s } = await ready();
    const polluted = JSON.parse('{"query":"x","__proto__":{"isAdmin":true}}');
    const r = await env.call('customers.list', polluted, s);
    expect(r.ok).toBe(false);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    expect((await env.call('customers.list', { query: 'x', constructor: { prototype: { x: 1 } } }, s)).ok).toBe(false);
    expect((await env.call('__proto__', {}, s)).ok).toBe(false);
    expect((await env.call('constructor', {}, s)).ok).toBe(false);
    const extra = await env.call('customers.create', { customer: { fullName: 'A', primaryMobile: '01001234567', balance: 999 } }, s);
    expect(extra.ok).toBe(false);
  });

  it('backups can only be written to an absolute folder', async () => {
    const { env, adminSession: s } = await ready();
    for (const destinationDir of ['backups', '../../etc', 'C:relative']) {
      const r = await env.call('backup.create', { destinationDir }, s);
      expect(r.ok, destinationDir).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(ErrorCode.VALIDATION);
    }
    const dir = `${env.dataDir}/usb-copy`;
    expect((await env.call('backup.create', { destinationDir: dir }, s)).ok).toBe(true);
  });
});

describe('Backup failure paths', () => {
  it('a backup that cannot be written is recorded as FAILED, audited, and leaves no partial file', async () => {
    const { env, adminSession: s } = await ready();
    const { writeFileSync, readdirSync } = await import('node:fs');
    const blocker = `${env.dataDir}/not-a-folder`;
    writeFileSync(blocker, 'x'); // the destination "folder" is a file → mkdir/write fails
    const r = await env.call('backup.create', { destinationDir: blocker }, s);
    expect(r.ok).toBe(false);
    const list = await ok<{ kind: string; status: string; errorMessage: string | null }[]>(env, 'backup.list', {}, s);
    expect(list[0]).toMatchObject({ kind: 'MANUAL', status: 'FAILED' });
    const actions = (env.backend.svc.deps.db.prepare('SELECT action FROM audit_log ORDER BY seq').all() as { action: string }[]).map((a) => a.action);
    expect(actions).toContain('backup.failed');
    expect(readdirSync(env.dataDir).filter((f) => f.endsWith('.part') || f.startsWith('.snapshot-'))).toEqual([]);
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });

  it('restoring a missing file is refused and changes nothing', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const r = await env.call('backup.restore', { filePath: `${env.dataDir}/nope.adbk`, password: 'correct horse battery staple', confirmation: 'RESTORE' }, s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ErrorCode.BACKUP_INVALID);
    expect((await ok<{ total: number }>(env, 'customers.list', {}, s)).total).toBe(1);
    expect(w.customer.id).toBeTruthy();
  });
});

describe('Ticket number lifecycle', () => {
  it('recorded once; a mistyped number is corrected only with permission and a reason, audited old → new', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w, { ticketNumbers: ['0771234567890'] });
    const t = b.tickets[0]!;
    expect((await env.call('bookings.setTicketNumber', { bookingId: b.id, ticketId: t.id, ticketNumber: '0771234567891' }, s)).ok).toBe(false); // already set
    const agent = await userWithRoles(env, s, 'agent', ['SALES_AGENT']);
    expect((await env.call('bookings.setTicketNumber', { bookingId: b.id, ticketId: t.id, ticketNumber: '0771234567891', correctionReason: 'typo' }, agent)).ok).toBe(false);
    const fixed = await ok<BookingDto>(env, 'bookings.setTicketNumber', { bookingId: b.id, ticketId: t.id, ticketNumber: '0771234567891', correctionReason: 'Last digit mistyped' }, s);
    expect(fixed.tickets[0]!.ticketNumber).toBe('0771234567891');
    const audit = env.backend.svc.deps.db.prepare(`SELECT before_json, after_json, metadata_json FROM audit_log WHERE action = 'ticket.number_corrected'`).get() as { before_json: string; after_json: string; metadata_json: string };
    expect(JSON.parse(audit.before_json)).toEqual({ ticketNumber: '0771234567890' });
    expect(JSON.parse(audit.after_json)).toEqual({ ticketNumber: '0771234567891' });
    expect(JSON.parse(audit.metadata_json)).toMatchObject({ reason: 'Last digit mistyped' });
    expect((await ok<{ items: unknown[] }>(env, 'bookings.list', { query: '0771234567891', status: 'ALL' }, s)).items).toHaveLength(1);
    expect((await ok<{ items: unknown[] }>(env, 'bookings.list', { query: '0771234567890', status: 'ALL' }, s)).items).toHaveLength(0);
  });
});
