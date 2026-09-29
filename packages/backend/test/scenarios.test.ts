import type { BookingDto, DocumentDto, MoneyAccountDto, ReportDto, StatementDto, ScheduleChangeDto, CancellationDto, DashboardMetricsDto, SearchHitDto, AgingRowDto } from '@airdesk/contracts';
import { ErrorCode } from '@airdesk/domain';
import { describe, expect, it } from 'vitest';
import { book, fail, ok, paySupplier, receive, seg, summary, world } from './flow';
import { ADMIN, COMPANY, auditActions, login, makeBackend, ready, userWithRoles } from './helpers';
import { MIGRATIONS } from '../src';

describe('Scenario A — full sale, fully settled on both sides', () => {
  it('gross profit 400, customer balance 0, supplier balance 0; payments never touch profit', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    let b = await book(env, s, w);
    expect(b.status).toBe('ISSUED');
    expect(b.tickets).toHaveLength(1);
    expect(b.customer).toEqual([{ currency: 'EGP', chargedMinor: 1_050_000, paidMinor: 0, balanceMinor: 1_050_000, settlement: 'UNPAID' }]);
    const gpBefore = summary(env).grossProfit;
    const rct = await receive(env, s, w, b.id, 1_050_000);
    expect(rct).toMatchObject({ docType: 'CUSTOMER_RECEIPT', totalMinor: 1_050_000, moneyAccountName: w.cash.name, createdBy: 'Owner' });
    await paySupplier(env, s, w, b.id, 1_010_000);
    b = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(b.profit).toEqual({ netSalesBaseMinor: 1_050_000, netCostBaseMinor: 1_010_000, grossProfitBaseMinor: 40_000 });
    expect(b.customer[0]).toMatchObject({ paidMinor: 1_050_000, balanceMinor: 0, settlement: 'PAID' });
    expect(b.suppliers![0]).toMatchObject({ supplierName: 'Company ABC', billedMinor: 1_010_000, paidMinor: 1_010_000, balanceMinor: 0, settlement: 'PAID' });
    const sum = summary(env);
    expect(sum).toMatchObject({ sales: 1_050_000, purchases: 1_010_000, grossProfit: 40_000, netProfit: 40_000, collections: 1_050_000, supplierPayments: 1_010_000, receivables: 0, payables: 0 });
    expect(gpBefore).toBe(40_000); // INV-5: payments never change gross profit
    const cash = (await ok<MoneyAccountDto[]>(env, 'moneyAccounts.list', {}, s))[0]!;
    expect(cash.balanceMinor).toBe(40_000); // INV-6: settled booking → cash = gross profit
    expect(auditActions(env)).toEqual(expect.arrayContaining(['booking.created', 'booking.issued', 'document.posted', 'payment.customer_received', 'payment.supplier_paid']));
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });
});

describe('Scenarios B, C, D — partial and multiple payments', () => {
  it('B: customer pays 5,000 → receivable 5,500, gross profit stays 400', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    await receive(env, s, w, b.id, 500_000);
    const after = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(after.customer[0]).toMatchObject({ chargedMinor: 1_050_000, paidMinor: 500_000, balanceMinor: 550_000, settlement: 'PARTIALLY_PAID' });
    expect(summary(env)).toMatchObject({ receivables: 550_000, grossProfit: 40_000 });
  });

  it('C: supplier paid 5,000 → payable 5,100, gross profit identical before and after', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    const gp = summary(env).grossProfit;
    await paySupplier(env, s, w, b.id, 500_000);
    expect(summary(env)).toMatchObject({ payables: 510_000, grossProfit: gp });
    expect(gp).toBe(40_000);
    expect((await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s)).suppliers![0]).toMatchObject({ balanceMinor: 510_000, settlement: 'PARTIALLY_PAID' });
  });

  it('D: payments 5,000 + 2,000 + 1,000 + 2,500 → balance 0 with four independent receipts', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    const docs: DocumentDto[] = [];
    for (const [i, amt] of [500_000, 200_000, 100_000, 250_000].entries()) {
      env.clock.advance(60_000 * (i + 1));
      docs.push(await receive(env, s, w, b.id, amt, { reference: `R${i + 1}` }));
    }
    expect(new Set(docs.map((d) => d.docNo)).size).toBe(4);
    const after = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(after.customer[0]).toMatchObject({ paidMinor: 1_050_000, balanceMinor: 0, settlement: 'PAID' });
    // A fifth payment would exceed the balance: refused unless explicitly routed on-account.
    expect((await fail(env, 'payments.receive', { partyId: w.customer.id, currency: 'EGP', amountMinor: 100, moneyAccountId: w.cash.id, paymentMethod: 'CASH', allocations: [{ bookingId: b.id, amountMinor: 100 }] }, s)).reason).toBe('OVER_ALLOCATION');
    const statement = (await ok<StatementDto[]>(env, 'statements.get', { party: 'CUSTOMER', partyId: w.customer.id, from: '2026-01-01', to: '2026-12-31' }, s))[0]!;
    expect(statement).toMatchObject({ openingMinor: 0, closingMinor: 0, totals: { chargesMinor: 1_050_000, paymentsMinor: 1_050_000, refundsMinor: 0, adjustmentsMinor: 0 } });
    expect(statement.lines.map((l) => l.balanceMinor)).toEqual([1_050_000, 550_000, 350_000, 250_000, 0]);
  });

  it('payment validation: allocations must add up; overpayment needs permission and is explicit; cancelling a receipt reverses it', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    const base = { partyId: w.customer.id, currency: 'EGP', moneyAccountId: w.cash.id, paymentMethod: 'CASH' };
    expect((await fail(env, 'payments.receive', { ...base, amountMinor: 1000, allocations: [{ bookingId: b.id, amountMinor: 900 }] }, s)).reason).toBe('ALLOCATION_MISMATCH');
    expect((await fail(env, 'payments.receive', { ...base, amountMinor: -5, allocations: [] }, s)).code).toBe(ErrorCode.VALIDATION);
    const over = await ok<DocumentDto>(env, 'payments.receive', { ...base, amountMinor: 1_100_000, allocations: [{ bookingId: b.id, amountMinor: 1_050_000 }], onAccountMinor: 50_000 }, s);
    expect(over.lines.map((l) => [l.bookingNo, l.amountMinor])).toEqual([[b.bookingNo, 1_050_000], [null, 50_000]]);
    const usd = await fail(env, 'payments.receive', { ...base, currency: 'USD', amountMinor: 1000, allocations: [] , onAccountMinor: 1000 }, s);
    expect(usd.code).toBe(ErrorCode.RATE_REQUIRED); // no USD rate: never silently assumed 1
    const cancelled = await ok<DocumentDto>(env, 'documents.cancel', { id: over.id, reason: 'Cheque bounced' }, s);
    expect(cancelled).toMatchObject({ isReversal: true, reversalOfNo: over.docNo });
    expect((await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s)).customer[0]!.balanceMinor).toBe(1_050_000);
    expect((await fail(env, 'documents.cancel', { id: over.id, reason: 'again' }, s)).code).toBe(ErrorCode.ALREADY_REVERSED);
    const inv = (await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s)).documents.find((d) => d.docType === 'CUSTOMER_INVOICE')!;
    expect((await fail(env, 'documents.cancel', { id: inv.id, reason: 'no' }, s)).reason).toBe('NOT_CANCELLABLE');
  });
});

describe('Scenario E — cancellation of a settled booking with fees and two independent refunds', () => {
  it('keeps history, posts reversal documents and ends at gross profit 200 with all balances 0', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    let b = await book(env, s, w);
    await receive(env, s, w, b.id, 1_050_000);
    await paySupplier(env, s, w, b.id, 1_010_000);
    const original = b.documents.map((d) => d.docNo);
    let c = await ok<CancellationDto>(env, 'cancellations.request', { bookingId: b.id, cancelType: 'REFUND', reason: 'Customer cancelled', expectedSupplierRefundMinor: 980_000, expectedCurrency: 'EGP' }, s);
    expect(c).toMatchObject({ scope: 'FULL', overallStatus: 'OPEN', supplierStatus: 'PENDING', customerStatus: 'PENDING' });
    expect((await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s)).refundStatus).toBe('PENDING');
    c = await ok<CancellationDto>(env, 'cancellations.submit', { id: c.id, rowVersion: c.rowVersion }, s);
    const ticketId = b.tickets[0]!.id;
    c = await ok<CancellationDto>(env, 'cancellations.confirmSupplier', { id: c.id, rowVersion: c.rowVersion, lines: [{ ticketId, returnMinor: 1_010_000, penaltyMinor: 30_000 }] }, s);
    expect(c.supplierStatus).toBe('CONFIRMED');
    c = await ok<CancellationDto>(env, 'cancellations.creditCustomer', { id: c.id, rowVersion: c.rowVersion, lines: [{ ticketId, returnMinor: 1_050_000 }], cancellationFeeMinor: 50_000 }, s);
    expect(c).toMatchObject({ customerStatus: 'CREDITED', overallStatus: 'CLOSED' });
    expect(c.documents.map((d) => d.docType).sort()).toEqual(['CUSTOMER_CREDIT_NOTE', 'CUSTOMER_INVOICE', 'SUPPLIER_BILL', 'SUPPLIER_CREDIT_NOTE']);
    b = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(b.status).toBe('CANCELLED');
    expect(b.tickets[0]!.status).toBe('REFUNDED');
    expect(b.customer[0]!.balanceMinor).toBe(-1_000_000); // we owe the customer 10,000
    expect(b.suppliers![0]!.balanceMinor).toBe(-980_000); // supplier owes us 9,800
    // Refunds are limited to the credit balance.
    const refund = { partyId: w.customer.id, currency: 'EGP', moneyAccountId: w.cash.id, paymentMethod: 'CASH' };
    expect((await fail(env, 'payments.refundCustomer', { ...refund, amountMinor: 1_000_001, allocations: [{ bookingId: b.id, amountMinor: 1_000_001 }] }, s)).reason).toBe('OVER_ALLOCATION');
    await ok(env, 'payments.refundCustomer', { ...refund, amountMinor: 1_000_000, allocations: [{ bookingId: b.id, amountMinor: 1_000_000 }] }, s);
    await ok(env, 'payments.supplierRefund', { partyId: w.supplier.id, currency: 'EGP', amountMinor: 980_000, moneyAccountId: w.cash.id, paymentMethod: 'BANK_TRANSFER', allocations: [{ bookingId: b.id, amountMinor: 980_000 }] }, s);
    b = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(b.profit).toEqual({ netSalesBaseMinor: 50_000, netCostBaseMinor: 30_000, grossProfitBaseMinor: 20_000 });
    expect(b.customer[0]!.balanceMinor).toBe(0);
    expect(b.suppliers![0]!.balanceMinor).toBe(0);
    expect((await ok<MoneyAccountDto[]>(env, 'moneyAccounts.list', {}, s))[0]!.balanceMinor).toBe(20_000); // cash = gross profit
    for (const no of original) expect(b.documents.some((d) => d.docNo === no && !d.isReversal)).toBe(true);
    expect(b.statusHistory.map((h) => h.toStatus)).toEqual(['DRAFT', 'ISSUED', 'CANCELLED']);
    expect(auditActions(env)).toEqual(expect.arrayContaining(['cancellation.requested', 'cancellation.supplier_confirmed', 'cancellation.customer_credited', 'ticket.status_changed', 'payment.customer_refunded', 'payment.supplier_refund_received']));
    const report = await ok<ReportDto>(env, 'reports.run', { report: 'cancellations', from: '2026-01-01', to: '2026-12-31' }, s);
    expect(report.rows[0]).toMatchObject({ sale_returned: 1_050_000, fees: 50_000, cost_returned: 1_010_000, penalties: 30_000, net_impact: -20_000 });
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });

  it('customer credit before the supplier answers needs its own permission; withdrawal only while nothing is posted', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    await env.call('roles.create', { code: 'DESK', nameAr: 'مكتب', nameEn: 'Desk', permissions: ['booking.view', 'booking.view_all', 'refund.request', 'refund.manage'] }, s);
    const desk = await userWithRoles(env, s, 'desk1', ['DESK']);
    let c = await ok<CancellationDto>(env, 'cancellations.request', { bookingId: b.id, cancelType: 'REFUND', reason: 'x' }, desk);
    expect((await fail(env, 'cancellations.creditCustomer', { id: c.id, rowVersion: c.rowVersion, lines: [{ ticketId: b.tickets[0]!.id, returnMinor: 1 }] }, desk)).code).toBe(ErrorCode.FORBIDDEN);
    c = await ok<CancellationDto>(env, 'cancellations.withdraw', { id: c.id, rowVersion: c.rowVersion, reason: 'Changed mind' }, desk);
    expect(c.overallStatus).toBe('WITHDRAWN');
    const again = await ok<CancellationDto>(env, 'cancellations.request', { bookingId: b.id, cancelType: 'VOID', reason: 'void it' }, s);
    const sub = await ok<CancellationDto>(env, 'cancellations.submit', { id: again.id, rowVersion: again.rowVersion }, s);
    const conf = await ok<CancellationDto>(env, 'cancellations.confirmSupplier', { id: sub.id, rowVersion: sub.rowVersion, lines: [{ ticketId: b.tickets[0]!.id, returnMinor: 1_010_000 }] }, s);
    expect((await fail(env, 'cancellations.withdraw', { id: conf.id, rowVersion: conf.rowVersion, reason: 'x' }, s)).reason).toBe('NOT_WITHDRAWABLE');
    const done = await ok<CancellationDto>(env, 'cancellations.creditCustomer', { id: conf.id, rowVersion: conf.rowVersion, lines: [{ ticketId: b.tickets[0]!.id, returnMinor: 1_050_000 }] }, s);
    expect(done.overallStatus).toBe('CLOSED');
    const after = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(after).toMatchObject({ status: 'VOIDED', refundStatus: 'REFUNDED' });
    expect(after.tickets[0]!.status).toBe('VOIDED');
    expect(after.profit!.grossProfitBaseMinor).toBe(0);
  });
});

describe('Scenario F — partial refund', () => {
  it('price reduction after payment: original sale kept, credit note + refund, supplier side untouched, profit reflects the result', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    let b = await book(env, s, w);
    await receive(env, s, w, b.id, 1_050_000);
    b = await ok<BookingDto>(env, 'bookings.adjustSale', { bookingId: b.id, ticketId: b.tickets[0]!.id, kind: 'DECREASE', amountMinor: 100_000, reason: 'Downgraded seat' }, s);
    expect(b.customer[0]!.balanceMinor).toBe(-100_000);
    await ok(env, 'payments.refundCustomer', { partyId: w.customer.id, currency: 'EGP', amountMinor: 100_000, moneyAccountId: w.cash.id, paymentMethod: 'CASH', allocations: [{ bookingId: b.id, amountMinor: 100_000 }] }, s);
    b = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(b.documents.filter((d) => d.docType === 'CUSTOMER_INVOICE')).toHaveLength(1);
    expect(b.documents.find((d) => d.docType === 'CUSTOMER_INVOICE')!.totalMinor).toBe(1_050_000);
    expect(b.customer[0]).toMatchObject({ chargedMinor: 950_000, balanceMinor: 0 });
    expect(b.suppliers![0]).toMatchObject({ billedMinor: 1_010_000, balanceMinor: 1_010_000 });
    expect(b.profit!.grossProfitBaseMinor).toBe(-60_000);
  });

  it('one of two passengers cancels: only their ticket is refunded; booking becomes partially cancelled', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    let b = await book(env, s, w, { passengers: [{ givenName: 'Ahmed', surname: 'Ali' }, { givenName: 'Mona', surname: 'Ali' }], saleMinor: 2_100_000, costMinor: 2_020_000 });
    const mona = b.tickets.find((t) => t.passengerName === 'MONA ALI')!;
    const c = await ok<CancellationDto>(env, 'cancellations.request', { bookingId: b.id, cancelType: 'REFUND', ticketIds: [mona.id], reason: 'Mona cannot travel' }, s);
    expect(c.scope).toBe('PARTIAL');
    const sub = await ok<CancellationDto>(env, 'cancellations.submit', { id: c.id, rowVersion: c.rowVersion }, s);
    const conf = await ok<CancellationDto>(env, 'cancellations.confirmSupplier', { id: sub.id, rowVersion: sub.rowVersion, lines: [{ ticketId: mona.id, returnMinor: 900_000 }] }, s);
    await ok(env, 'cancellations.creditCustomer', { id: conf.id, rowVersion: conf.rowVersion, lines: [{ ticketId: mona.id, returnMinor: 800_000 }] }, s);
    b = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(b.status).toBe('PARTIALLY_CANCELLED');
    expect(b.refundStatus).toBe('PARTIALLY_REFUNDED');
    expect(b.tickets.map((t) => [t.passengerName, t.status]).sort()).toEqual([['AHMED ALI', 'ISSUED'], ['MONA ALI', 'PARTIALLY_REFUNDED']]);
    expect(b.passengers.find((p) => p.givenName === 'MONA')!.status).toBe('CANCELLED');
    // 21,000 − 8,000 returned = 13,000 net sales; 20,200 − 9,000 = 11,200 net cost → GP 1,800.
    expect(b.profit).toEqual({ netSalesBaseMinor: 1_300_000, netCostBaseMinor: 1_120_000, grossProfitBaseMinor: 180_000 });
    expect((await fail(env, 'cancellations.request', { bookingId: b.id, cancelType: 'REFUND', ticketIds: [mona.id], reason: 'again' }, s)).reason).toBe('TICKET_NOT_CANCELLABLE');
  });
});

describe('Scenario G — flight schedule change', () => {
  it('keeps old and new values, flags attention, records notification and audit', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    let b = await book(env, s, w);
    const segment = b.segments[0]!;
    b = await ok<BookingDto>(env, 'bookings.saveSegment', { bookingId: b.id, segmentId: segment.id, segment: seg(w.airline.id, { departureTime: '13:15', arrivalTime: '15:45' }), reason: 'Airline notice' }, s);
    const change = b.scheduleChanges[0]!;
    expect(change).toMatchObject({ severity: 'MAJOR', notificationStatus: 'NOT_NOTIFIED', requiresAttention: true, superseded: false });
    expect(change.fields).toEqual([
      { field: 'arrival_time', oldValue: '12:30', newValue: '15:45' },
      { field: 'departure_time', oldValue: '10:00', newValue: '13:15' },
    ]);
    expect(b.segments[0]).toMatchObject({ departureTime: '13:15', version: 2, scheduleChanged: true, scheduleAttention: true });
    const list = await ok<{ items: { scheduleAttention: boolean }[] }>(env, 'bookings.list', {}, s);
    expect(list.items[0]!.scheduleAttention).toBe(true);
    const draft = await ok<{ body: string; recipient: string }>(env, 'notifications.draft', { changeId: change.id, locale: 'ar' }, s);
    expect(draft.body).toContain('10:00');
    expect(draft.body).toContain('13:15');
    await ok(env, 'notifications.record', { bookingId: b.id, scheduleChangeId: change.id, channel: 'WHATSAPP', recipient: draft.recipient, body: draft.body, outcome: 'FAILED', note: 'No answer' }, s);
    let changes = await ok<ScheduleChangeDto[]>(env, 'schedule.list', { attentionOnly: true }, s);
    expect(changes[0]!.notificationStatus).toBe('NOTIFICATION_FAILED');
    await ok(env, 'notifications.record', { bookingId: b.id, scheduleChangeId: change.id, channel: 'PHONE_CALL', recipient: draft.recipient, body: draft.body, outcome: 'SENT' }, s);
    changes = await ok<ScheduleChangeDto[]>(env, 'schedule.list', { attentionOnly: true }, s);
    expect(changes).toEqual([]);
    b = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(b.notifications.map((n) => n.status)).toEqual(['SENT', 'FAILED']);
    expect(b.notifications.every((n) => n.deliveryMode === 'MANUAL')).toBe(true);
    expect(auditActions(env)).toEqual(expect.arrayContaining(['schedule.changed', 'notification.recorded']));
    // Financials untouched by a schedule change.
    expect(b.profit!.grossProfitBaseMinor).toBe(40_000);
    // A tiny terminal change is MINOR; issued segments cannot be deleted.
    b = await ok<BookingDto>(env, 'bookings.saveSegment', { bookingId: b.id, segmentId: segment.id, segment: seg(w.airline.id, { departureTime: '13:15', arrivalTime: '15:45', departureTerminal: '2' }) }, s);
    expect(b.scheduleChanges[0]!.severity).toBe('MINOR');
    expect((await fail(env, 'bookings.removeSegment', { bookingId: b.id, segmentId: segment.id }, s)).reason).toBe('BOOKING_ISSUED');
    const channels = await ok<{ channel: string; providerConfigured: boolean }[]>(env, 'notifications.channels', {}, s);
    expect(channels.every((c) => !c.providerConfigured)).toBe(true); // nothing claims to send automatically
    const travel = await ok<{ flight: string; scheduleChanged: boolean }[]>(env, 'travel.upcoming', { from: '2026-10-01', to: '2026-10-31' }, s);
    expect(travel[0]).toMatchObject({ flight: 'MS915', scheduleChanged: true });
  });
});

describe('Scenarios H & I — multiple passengers/segments; supplier different from airline', () => {
  it('H: 3 passengers × 3 segments: every ticket covers the journey; invoice lines per ticket', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w, {
      passengers: [{ givenName: 'Ahmed', surname: 'Ali' }, { givenName: 'Mona', surname: 'Ali' }, { givenName: 'Omar', surname: 'Ali', paxType: 'CHD' }],
      segments: [seg(w.airline.id), seg(w.airline.id, { flightNumber: '1623', origin: 'JED', destination: 'RUH', departureDate: '2026-10-17', arrivalDate: '2026-10-17' }),
        seg(w.airline.id, { flightNumber: '916', origin: 'RUH', destination: 'CAI', departureDate: '2026-10-25', arrivalDate: '2026-10-25' })],
      saleMinor: 3_000_000, costMinor: 2_700_000, ticketNumbers: ['0771111111111', '0771111111112', '0771111111113'],
    });
    expect(b.passengers).toHaveLength(3);
    expect(b.segments.map((x) => `${x.origin}-${x.destination}`)).toEqual(['CAI-JED', 'JED-RUH', 'RUH-CAI']);
    expect(b.tickets.map((t) => t.ticketNumber).sort()).toEqual(['0771111111111', '0771111111112', '0771111111113']);
    const links = env.backend.svc.deps.db.prepare('SELECT COUNT(*) AS n FROM ticket_segment ts JOIN ticket t ON t.id = ts.ticket_id WHERE t.booking_id = ?').get(b.id) as { n: number };
    expect(links.n).toBe(9);
    const inv = b.documents.find((d) => d.docType === 'CUSTOMER_INVOICE')!;
    expect(inv.lines.map((l) => l.passengerName).sort()).toEqual(['AHMED ALI', 'MONA ALI', 'OMAR ALI']);
    expect(b.tickets.every((t) => t.saleMinor === 1_000_000 && t.costMinor === 900_000)).toBe(true);
    const list = await ok<{ items: { route: string; passengerCount: number }[] }>(env, 'bookings.list', { query: '0771111111112' }, s);
    expect(list.items[0]).toMatchObject({ route: 'CAI→JED→RUH→CAI', passengerCount: 3 });
    // A ticket number cannot be reused.
    const dup = await book(env, s, w, { issue: false, ticketNumbers: ['0771111111111'] }).catch((e: Error) => e);
    expect(String(dup)).toMatch(/DUPLICATE_TICKET/);
  });

  it('I: financial documents belong to the supplier, the flight belongs to the airline', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s, { supplierName: 'Company ABC' });
    const b = await book(env, s, w);
    expect(b.segments[0]!.airlineName).toBe('EgyptAir');
    expect(b.tickets[0]).toMatchObject({ airlineName: 'EgyptAir', supplierName: 'Company ABC' });
    const bill = b.documents.find((d) => d.docType === 'SUPPLIER_BILL')!;
    expect(bill).toMatchObject({ supplierName: 'Company ABC', totalMinor: 1_010_000 });
    const st = await ok<StatementDto[]>(env, 'statements.get', { party: 'SUPPLIER', partyId: w.supplier.id, from: '2026-01-01', to: '2026-12-31' }, s);
    expect(st[0]!.closingMinor).toBe(1_010_000);
    const airlineParty = env.backend.svc.deps.db.prepare(`SELECT COUNT(*) AS n FROM journal_line WHERE supplier_id = ?`).get(w.airline.id) as { n: number };
    expect(airlineParty.n).toBe(0);
  });
});

describe('Scenario J — expenses', () => {
  it('gross profit 400, expense 100 → net profit 300; supplier payment does not reduce profit again', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    const cats = await ok<{ id: string; code: string }[]>(env, 'expenseCategories.list', {}, s);
    await receive(env, s, w, b.id, 1_050_000);
    await ok(env, 'expenses.create', { categoryId: cats.find((c) => c.code === 'INTERNET')!.id, currency: 'EGP', amountMinor: 10_000, moneyAccountId: w.cash.id, paymentMethod: 'CASH', description: 'ADSL September' }, s);
    expect(summary(env)).toMatchObject({ grossProfit: 40_000, expenses: 10_000, netProfit: 30_000 });
    await paySupplier(env, s, w, b.id, 1_010_000);
    expect(summary(env)).toMatchObject({ grossProfit: 40_000, expenses: 10_000, netProfit: 30_000, purchases: 1_010_000 });
    const custom = await ok<{ id: string }>(env, 'expenseCategories.save', { code: 'Marketing', nameAr: 'تسويق', nameEn: 'Marketing' }, s);
    await ok(env, 'expenses.create', { categoryId: custom.id, currency: 'EGP', amountMinor: 5_000, moneyAccountId: w.cash.id, paymentMethod: 'CASH', description: 'Flyers' }, s);
    await ok(env, 'expenseCategories.setActive', { id: custom.id, active: false }, s);
    const report = await ok<ReportDto>(env, 'reports.run', { report: 'expenses', from: '2026-01-01', to: '2026-12-31' }, s);
    expect(report.rows.map((r) => r.category_en)).toEqual(['Internet & telecom', 'Marketing']); // history keeps its category
    expect(report.totals).toEqual({ base: 15_000 });
    const profit = await ok<ReportDto>(env, 'reports.run', { report: 'profit', from: '2026-01-01', to: '2026-12-31' }, s);
    expect(profit.totals).toMatchObject({ sales: 1_050_000, purchases: 1_010_000, grossProfit: 40_000, expenses: 15_000, netProfit: 25_000 });
    expect(() => env.backend.svc.deps.db.prepare('DELETE FROM expense_category WHERE id = ?').run(custom.id)).toThrow(/never deleted/);
  });
});

describe('Scenario K — multi-currency (SAR)', () => {
  it('keeps original amount, rate and base amount; later rate edits never rewrite history; settlement difference is FX', async () => {
    const r = await ready();
    const env = r.env;
    let s = r.adminSession;
    const w = await world(env, s);
    await ok(env, 'currency.setRate', { currencyCode: 'SAR', rateDate: '2026-09-28', rate: '13.50' }, s);
    const sarCash = await ok<MoneyAccountDto>(env, 'moneyAccounts.save', { name: 'SAR box', accountType: 'CASH', currencyCode: 'SAR' }, s);
    let b = await book(env, s, w, { saleCurrency: 'SAR', saleMinor: 100_000, costMinor: 90_000, costCurrency: 'SAR' });
    const inv = b.documents.find((d) => d.docType === 'CUSTOMER_INVOICE')!;
    expect(inv).toMatchObject({ currency: 'SAR', exchangeRate: '13.5', totalMinor: 100_000, totalBaseMinor: 1_350_000 });
    expect(b.profit).toEqual({ netSalesBaseMinor: 1_350_000, netCostBaseMinor: 1_215_000, grossProfitBaseMinor: 135_000 });
    env.clock.advance(24 * 3600_000);
    const s1 = await login(env); // the previous session idled out over the simulated day
    await ok(env, 'currency.setRate', { currencyCode: 'SAR', rateDate: '2026-09-29', rate: '13.60' }, s1);
    await ok(env, 'currency.setRate', { currencyCode: 'SAR', rateDate: '2026-09-28', rate: '99' }, s1); // edited later: history must not change
    s = s1;
    await ok(env, 'payments.receive', { partyId: w.customer.id, currency: 'SAR', amountMinor: 100_000, moneyAccountId: sarCash.id, paymentMethod: 'CASH', allocations: [{ bookingId: b.id, amountMinor: 100_000 }] }, s);
    b = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(b.documents.find((d) => d.docType === 'CUSTOMER_INVOICE')).toMatchObject({ exchangeRate: '13.5', totalBaseMinor: 1_350_000 });
    expect(b.customer).toEqual([{ currency: 'SAR', chargedMinor: 100_000, paidMinor: 100_000, balanceMinor: 0, settlement: 'PAID' }]);
    expect(b.profit!.grossProfitBaseMinor).toBe(135_000); // FX never touches gross profit
    expect(summary(env)).toMatchObject({ grossProfit: 135_000, otherIncome: 10_000, netProfit: 145_000 });
    const sales = await ok<ReportDto>(env, 'reports.run', { report: 'sales', from: '2026-01-01', to: '2026-12-31' }, s);
    expect(sales.rows[0]).toMatchObject({ currency: 'SAR', amount: 100_000, base: 1_350_000 });
    // No rate on the date → posting is refused, never assumed 1.
    const usdBooking = await book(env, s, w, { saleCurrency: 'USD', saleMinor: 20_000, costMinor: 19_000, issue: false });
    expect((await fail(env, 'bookings.issue', { id: usdBooking.id, rowVersion: usdBooking.rowVersion }, s)).code).toBe(ErrorCode.RATE_REQUIRED);
  });
});

describe('Scenario L — backup and restore of operational data', () => {
  it('restores bookings, documents, audit chain and balances exactly', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    await receive(env, s, w, b.id, 500_000);
    const before = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    const auditCount = (env.backend.svc.deps.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    const backup = await ok<{ filePath: string }>(env, 'backup.create', {}, s);
    // Destroy/replace: more activity after the backup that the restore must discard.
    await receive(env, s, w, b.id, 550_000);
    await ok(env, 'customers.create', { customer: { fullName: 'Later Customer', primaryMobile: '01009999999' } }, s);
    await ok(env, 'backup.restore', { filePath: backup.filePath, password: ADMIN.password, confirmation: 'RESTORE' }, s);
    const s2 = await login(env);
    const after = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s2);
    expect(after.customer).toEqual(before.customer);
    expect(after.documents.map((d) => d.docNo)).toEqual(before.documents.map((d) => d.docNo));
    expect(after.tickets.map((t) => t.id)).toEqual(before.tickets.map((t) => t.id));
    expect((await ok<{ total: number }>(env, 'customers.list', { query: 'Later' }, s2)).total).toBe(0);
    expect((await ok<{ items: unknown[] }>(env, 'bookings.list', { query: 'ABC123' }, s2)).items).toHaveLength(1); // search index rebuilt
    const auditAfter = (env.backend.svc.deps.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    expect(auditAfter).toBeGreaterThan(auditCount); // restore + login audited on top of the restored chain
    const integrity = await ok<{ ok: boolean; checks: { id: string; ok: boolean }[] }>(env, 'integrity.run', {}, s2);
    expect(integrity.ok).toBe(true);
    expect(summary(env)).toMatchObject({ receivables: 550_000, grossProfit: 40_000 });
  });
});

describe('Scenario M — unauthorized access by a Sales Agent (backend-enforced)', () => {
  it('agent sells and collects but never sees cost, profit, supplier balances or manages roles', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const agent = await userWithRoles(env, s, 'agent', ['SALES_AGENT']);
    // The agent runs the full front-office flow themself.
    const b = await book(env, agent, w);
    expect(b.status).toBe('ISSUED');
    expect(b.priceItems[0]).toMatchObject({ costMinor: null, costCurrency: null, costEntered: true, saleTotalMinor: 1_050_000 });
    expect(b.tickets[0]!.costMinor).toBeNull();
    expect(b.profit).toBeNull();
    expect(b.suppliers).toBeNull();
    expect(b.quote).toMatchObject({ costTotals: null, estimatedProfitBaseMinor: null });
    expect(b.documents.every((d) => !d.docType.startsWith('SUPPLIER_'))).toBe(true);
    await receive(env, agent, w, b.id, 500_000);
    const bill = (await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s)).documents.find((d) => d.docType === 'SUPPLIER_BILL')!;
    const denied: [string, unknown][] = [
      ['documents.get', { id: bill.id }],
      ['reports.run', { report: 'profit', from: '2026-01-01', to: '2026-12-31' }],
      ['reports.run', { report: 'purchases', from: '2026-01-01', to: '2026-12-31' }],
      ['reports.run', { report: 'supplier_volume', from: '2026-01-01', to: '2026-12-31' }],
      ['statements.get', { party: 'SUPPLIER', partyId: w.supplier.id, from: '2026-01-01', to: '2026-12-31' }],
      ['aging.get', { party: 'SUPPLIER', asOf: '2026-12-31' }],
      ['payments.paySupplier', { partyId: w.supplier.id, currency: 'EGP', amountMinor: 1, moneyAccountId: w.cash.id, paymentMethod: 'CASH', allocations: [{ bookingId: b.id, amountMinor: 1 }] }],
      ['bookings.adjustCost', { bookingId: b.id, ticketId: b.tickets[0]!.id, kind: 'DECREASE', amountMinor: 1, reason: 'x' }],
      ['roles.create', { code: 'X_ROLE', nameAr: 'x', nameEn: 'x', permissions: [] }],
      ['roles.setPermissions', { roleId: '01J0000000000000000000000A', permissions: ['booking.view_cost'] }],
      ['documents.cancel', { id: bill.id, reason: 'x' }],
      ['expenses.create', { categoryId: '01J0000000000000000000000A', currency: 'EGP', amountMinor: 1, moneyAccountId: w.cash.id, paymentMethod: 'CASH', description: 'x' }],
      ['moneyAccounts.save', { name: 'x', accountType: 'CASH', currencyCode: 'EGP' }],
    ];
    for (const [cmd, payload] of denied) {
      const r = await env.call(cmd, payload, agent);
      expect(!r.ok && [ErrorCode.FORBIDDEN, ErrorCode.NOT_FOUND]).toContain(r.ok ? 'OK' : r.error.code);
    }
    const dash = await ok<DashboardMetricsDto>(env, 'dashboard.metrics', { from: '2026-09-01', to: '2026-09-30' }, agent);
    expect(dash.financial).toBeNull();
    expect(dash.operational!.bookingsIssued).toBe(1);
    const accounts = await ok<MoneyAccountDto[]>(env, 'moneyAccounts.list', {}, agent);
    expect(accounts[0]!.balanceMinor).toBeNull();
    const hits = await ok<SearchHitDto[]>(env, 'search.global', { query: 'ABC' }, agent);
    expect(hits.some((h) => h.type === 'supplier')).toBe(true);
    expect(JSON.stringify(hits)).not.toMatch(/10100|1010000/);
    const sales = await ok<ReportDto>(env, 'reports.run', { report: 'sales', from: '2026-01-01', to: '2026-12-31' }, agent);
    expect(sales.columns.map((c) => c.key)).not.toContain('cost');
    // Another agent cannot even see this booking.
    const agent2 = await userWithRoles(env, s, 'agent2', ['SALES_AGENT']);
    expect((await fail(env, 'bookings.get', { id: b.id }, agent2)).code).toBe(ErrorCode.NOT_FOUND);
    expect((await ok<{ total: number }>(env, 'bookings.list', {}, agent2)).total).toBe(0);
    expect((await ok<ReportDto>(env, 'reports.run', { report: 'sales', from: '2026-01-01', to: '2026-12-31' }, agent2)).rows).toEqual([]);
    const receipts = await fail(env, 'payments.receive', { partyId: w.customer.id, currency: 'EGP', amountMinor: 1, moneyAccountId: w.cash.id, paymentMethod: 'CASH', allocations: [{ bookingId: b.id, amountMinor: 1 }] }, agent2);
    expect(receipts.code).toBe(ErrorCode.NOT_FOUND);
    expect(auditActions(env).filter((a) => a === 'auth.permission_denied').length).toBeGreaterThanOrEqual(10);
  });

  it('agent without enter_cost cannot price cost; zero price and below-cost sales need their own permissions', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    await env.call('roles.create', { code: 'JUNIOR', nameAr: 'مبتدئ', nameEn: 'Junior', permissions: ['booking.view', 'booking.create', 'booking.edit', 'booking.issue', 'customer.view'] }, s);
    const junior = await userWithRoles(env, s, 'junior', ['JUNIOR']);
    const draft = await book(env, s, w, { issue: false });
    await env.call('bookings.update', { id: draft.id, rowVersion: draft.rowVersion, patch: { notes: 'x' } }, s);
    const b0 = await ok<BookingDto>(env, 'bookings.create', { customerId: w.customer.id }, junior);
    const b1 = await ok<BookingDto>(env, 'bookings.savePassenger', { bookingId: b0.id, passenger: { givenName: 'A', surname: 'B' } }, junior);
    expect((await fail(env, 'bookings.savePriceItem', { bookingId: b1.id, item: { passengerId: b1.passengers[0]!.id, fareMinor: 100, costMinor: 50, costCurrency: 'EGP' } }, junior)).code).toBe(ErrorCode.FORBIDDEN);
    const below = await book(env, s, w, { issue: false, saleMinor: 900_000, costMinor: 1_000_000 });
    const agent = await userWithRoles(env, s, 'agent', ['SALES_AGENT']);
    const r = await env.call('bookings.issue', { id: below.id, rowVersion: below.rowVersion }, agent);
    expect(!r.ok && r.error.code).toBe(ErrorCode.NOT_FOUND); // not the agent's booking
    const issued = await ok<BookingDto>(env, 'bookings.issue', { id: below.id, rowVersion: below.rowVersion }, s); // admin may sell below cost
    expect(issued.profit!.grossProfitBaseMinor).toBe(-100_000);
  });
});

describe('booking lifecycle rules', () => {
  it('draft → reserve → release → issue; discard blocked while a deposit is held; stale edits refused', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    let b = await book(env, s, w, { issue: false });
    expect(b.quote.saleTotalMinor).toBe(1_050_000);
    expect(b.quote.estimatedProfitBaseMinor).toBe(40_000);
    b = await ok<BookingDto>(env, 'bookings.reserve', { id: b.id, rowVersion: b.rowVersion }, s);
    expect(b.status).toBe('RESERVED');
    await receive(env, s, w, b.id, 300_000); // deposit on a reservation (BR-PAY-03)
    b = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(b.customer[0]!.balanceMinor).toBe(-300_000);
    expect((await fail(env, 'bookings.discard', { id: b.id, rowVersion: b.rowVersion, reason: 'x' }, s)).reason).toBe('OPEN_BALANCE');
    expect((await fail(env, 'bookings.update', { id: b.id, rowVersion: b.rowVersion - 1, patch: { notes: 'x' } }, s)).code).toBe(ErrorCode.STALE_RECORD);
    b = await ok<BookingDto>(env, 'bookings.issue', { id: b.id, rowVersion: b.rowVersion }, s);
    expect(b.customer[0]).toMatchObject({ chargedMinor: 1_050_000, paidMinor: 300_000, balanceMinor: 750_000 });
    expect((await fail(env, 'bookings.savePriceItem', { bookingId: b.id, itemId: b.priceItems[0]!.id, item: { passengerId: b.passengers[0]!.id, fareMinor: 1 } }, s)).reason).toBe('BOOKING_ISSUED');
    expect((await fail(env, 'bookings.savePassenger', { bookingId: b.id, passengerId: b.passengers[0]!.id, passenger: { givenName: 'Other', surname: 'Name' } }, s)).reason).toBe('NAME_CHANGE_AFTER_ISSUE');
    expect(() => env.backend.svc.deps.db.prepare('UPDATE booking_price_item SET fare_minor = 1 WHERE id = ?').run(b.priceItems[0]!.id)).toThrow(/frozen/);
    expect(() => env.backend.svc.deps.db.prepare('DELETE FROM ticket WHERE id = ?').run(b.tickets[0]!.id)).toThrow(/never deleted/);
    const empty = await ok<BookingDto>(env, 'bookings.create', { customerId: w.customer.id }, s);
    expect((await fail(env, 'bookings.issue', { id: empty.id, rowVersion: empty.rowVersion }, s)).reason).toBe('NO_PASSENGERS');
    const d = await ok<BookingDto>(env, 'bookings.discard', { id: empty.id, rowVersion: empty.rowVersion, reason: 'Test' }, s);
    expect(d.status).toBe('DISCARDED');
  });

  it('discount agreed in the quote is posted as contra-revenue at issue; ticket number can be recorded later once', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    let b = await book(env, s, w, { discountMinor: 20_000 });
    expect(b.documents.map((d) => d.docType).sort()).toEqual(['CUSTOMER_CREDIT_NOTE', 'CUSTOMER_INVOICE', 'SUPPLIER_BILL']);
    expect(b.customer[0]!.chargedMinor).toBe(1_030_000);
    expect(b.profit!.grossProfitBaseMinor).toBe(20_000);
    b = await ok<BookingDto>(env, 'bookings.setTicketNumber', { bookingId: b.id, ticketId: b.tickets[0]!.id, ticketNumber: '077-9999999999' }, s);
    expect(b.tickets[0]!.ticketNumber).toBe('0779999999999');
    expect((await fail(env, 'bookings.setTicketNumber', { bookingId: b.id, ticketId: b.tickets[0]!.id, ticketNumber: '0779999999990' }, s)).reason).toBe('TICKET_NUMBER_SET');
    expect((await fail(env, 'bookings.setTicketNumber', { bookingId: b.id, ticketId: b.tickets[0]!.id, ticketNumber: '0659999999990' }, s)).code).toBe(ErrorCode.CONFLICT);
  });

  it('changing supplier after issue credits the old supplier and bills the new one (BR-BKG-03)', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    await paySupplier(env, s, w, b.id, 400_000);
    const s2 = await ok<{ id: string }>(env, 'suppliers.create', { supplier: { name: 'Second Consolidator', defaultCurrencyCode: 'EGP' } }, s);
    const after = await ok<BookingDto>(env, 'bookings.changeSupplier', { bookingId: b.id, ticketId: b.tickets[0]!.id, newSupplierId: s2.id, costMinor: 1_000_000, costCurrency: 'EGP', reason: 'Cheaper fare' }, s);
    expect(after.profit!.grossProfitBaseMinor).toBe(50_000);
    const bySupplier = Object.fromEntries(after.suppliers!.map((p) => [p.supplierName, p.balanceMinor]));
    expect(bySupplier).toEqual({ 'Company ABC': -400_000, 'Second Consolidator': 1_000_000 }); // S1 now owes us what we paid
    expect(after.tickets[0]!.supplierName).toBe('Second Consolidator');
  });
});

describe('receivables, payables and aging', () => {
  it('ages open items from the due date into Current / 1–7 / 8–30 / 31–60 / 60+ and keeps credits separate', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    await book(env, s, w); // due today (terms 0)
    const b2 = await book(env, s, w);
    await receive(env, s, w, b2.id, 50_000);
    await ok(env, 'payments.receive', { partyId: w.customer.id, currency: 'EGP', amountMinor: 70_000, moneyAccountId: w.cash.id, paymentMethod: 'CASH', allocations: [], onAccountMinor: 70_000 }, s);
    const rows = await ok<AgingRowDto[]>(env, 'aging.get', { party: 'CUSTOMER', asOf: '2026-10-20' }, s);
    expect(rows).toEqual([expect.objectContaining({ partyName: 'Ahmed Ali', currency: 'EGP', d8to30Minor: 2_050_000, totalMinor: 2_050_000, creditMinor: 70_000 })]);
    const onDue = await ok<AgingRowDto[]>(env, 'aging.get', { party: 'CUSTOMER', asOf: '2026-09-28' }, s);
    expect(onDue[0]!.currentMinor).toBe(2_050_000);
    const pay = await ok<AgingRowDto[]>(env, 'aging.get', { party: 'SUPPLIER', asOf: '2027-01-15' }, s);
    expect(pay[0]).toMatchObject({ partyName: 'Company ABC', d60PlusMinor: 2_020_000 });
    const rec = await ok<ReportDto>(env, 'reports.run', { report: 'receivables', from: '2026-01-01', to: '2026-10-20' }, s);
    expect(rec.rows[0]).toMatchObject({ party: 'Ahmed Ali', d8_30: 2_050_000, credit: 70_000 });
    // Statement closing reconciles with the ledger (sub-ledger = control account).
    const st = (await ok<StatementDto[]>(env, 'statements.get', { party: 'CUSTOMER', partyId: w.customer.id, from: '2026-01-01', to: '2026-12-31' }, s))[0]!;
    const ledger = env.backend.svc.deps.db.prepare(`SELECT SUM(debit_minor - credit_minor) AS v FROM journal_line WHERE account_code = '1200' AND customer_id = ?`).get(w.customer.id) as { v: number };
    expect(st.closingMinor).toBe(ledger.v);
    expect(st.closingMinor).toBe(2_050_000 - 70_000);
  });
});

describe('reports, dashboard, search', () => {
  it('every report runs from the journal and the dashboard respects permissions', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    await receive(env, s, w, b.id, 1_050_000);
    await paySupplier(env, s, w, b.id, 1_000_000);
    for (const report of ['sales', 'purchases', 'profit', 'receivables', 'payables', 'supplier_volume', 'expenses', 'refunds', 'cancellations', 'flight_changes', 'employee_activity', 'collections']) {
      const r = await ok<ReportDto>(env, 'reports.run', { report, from: '2026-01-01', to: '2026-12-31' }, s);
      expect(r.columns.length, report).toBeGreaterThan(0);
    }
    const vol = await ok<ReportDto>(env, 'reports.run', { report: 'supplier_volume', from: '2026-01-01', to: '2026-12-31' }, s);
    expect(vol.rows[0]).toMatchObject({ supplier: 'Company ABC', transactions: 1, purchases: 1_010_000, payments: 1_000_000, outstanding: 10_000, gross_profit: 40_000 });
    const emp = await ok<ReportDto>(env, 'reports.run', { report: 'employee_activity', from: '2026-01-01', to: '2026-12-31' }, s);
    expect(emp.rows.find((r) => r.username === 'owner')).toMatchObject({ bookings_created: 1, bookings_issued: 1, tickets: 1, sales: 1_050_000, receipts: 1, collected: 1_050_000 });
    const dash = await ok<DashboardMetricsDto>(env, 'dashboard.metrics', { from: '2026-09-01', to: '2026-09-30' }, s);
    expect(dash.financial).toMatchObject({ sales: 1_050_000, collections: 1_050_000, purchases: 1_010_000, grossProfit: 40_000, netProfit: 40_000, receivables: 0, payables: 10_000 });
    expect(dash.operational).toMatchObject({ bookingsCreated: 1, bookingsIssued: 1, ticketsIssued: 1 });
    const empty = await ok<DashboardMetricsDto>(env, 'dashboard.metrics', { from: '2026-08-01', to: '2026-08-31' }, s);
    expect(empty.financial!.sales).toBe(0);
    expect(empty.financial!.payables).toBe(0);
    const hits = await ok<SearchHitDto[]>(env, 'search.global', { query: 'ABC123' }, s);
    expect(hits.map((h) => h.type)).toContain('booking');
    const airports = await ok<SearchHitDto[]>(env, 'search.global', { query: 'جدة' }, s);
    expect(airports.find((h) => h.type === 'airport')!.id).toBe('JED');
    expect((await fail(env, 'reports.run', { report: 'sales', from: '2026-12-31', to: '2026-01-01' }, s)).reason).toBe('INVALID_RANGE');
  });
});

describe('master data for operations', () => {
  it('airports, money accounts and currencies are managed without deleting history', async () => {
    const { env, adminSession: s } = await ready();
    const list = await ok<{ items: { iataCode: string }[]; total: number }>(env, 'airports.list', { query: 'JED' }, s);
    expect(list.items[0]!.iataCode).toBe('JED');
    expect((await ok<{ total: number }>(env, 'airports.list', { status: 'ALL', limit: 200 }, s)).total).toBeGreaterThanOrEqual(80);
    await ok(env, 'airports.create', { airport: { iataCode: 'xyz', nameEn: 'Test Field', countryCode: 'EG', timezone: 'Africa/Cairo' } }, s);
    expect((await fail(env, 'airports.create', { airport: { iataCode: 'XYZ', nameEn: 'Dup', countryCode: 'EG' } }, s)).reason).toBe('DUPLICATE_CODE');
    expect((await fail(env, 'airports.create', { airport: { iataCode: 'XY1', nameEn: 'Bad', countryCode: 'EG' } }, s)).reason).toBe('INVALID_AIRPORT');
    await ok(env, 'airports.setActive', { iataCode: 'XYZ', active: false }, s);
    expect(() => env.backend.svc.deps.db.prepare(`DELETE FROM airport WHERE iata_code = 'XYZ'`).run()).toThrow(/never deleted/);
    const bank = await ok<MoneyAccountDto>(env, 'moneyAccounts.save', { name: 'CIB current', accountType: 'BANK', currencyCode: 'EGP', bankName: 'CIB' }, s);
    expect(bank.balanceMinor).toBe(0);
    expect((await fail(env, 'moneyAccounts.save', { name: 'cib CURRENT', accountType: 'BANK', currencyCode: 'EGP' }, s)).reason).toBe('DUPLICATE_NAME');
    expect((await fail(env, 'currency.setActive', { currencyCode: 'EGP', active: false }, s)).reason).toBe('BASE_CURRENCY');
    const about = await ok<{ schemaVersion: number; latestSchemaVersion: number; migrations: { name: string }[] }>(env, 'system.about', {}, s);
    expect(about.schemaVersion).toBe(MIGRATIONS.length);
    expect(about.migrations.map((m) => m.name)).toEqual(['initial', 'master_data', 'operations', 'performance_indexes', 'ledger_completion']);
  });
});

describe('upgrade from a Phase 2 database', () => {
  it('migrates with a verified pre-migration backup, keeps data and creates the missing cash account', async () => {
    const env2 = await makeBackend({ migrations: MIGRATIONS.slice(0, 2) });
    // Phase 2 setup path (service level): a Phase 2 installation had no money accounts at all.
    await env2.backend.svc.auth.setup({ company: COMPANY, admin: { username: ADMIN.username, displayName: 'Owner', password: ADMIN.password, locale: 'ar' } }, 'TEST-PC');
    const s = await login(env2);
    await ok(env2, 'customers.create', { customer: { fullName: 'Legacy Customer', primaryMobile: '01000000001' } }, s);
    expect((env2.backend.svc.deps.db.prepare('SELECT COUNT(*) AS n FROM money_account').get() as { n: number }).n).toBe(0);
    const dataDir = env2.dataDir;
    env2.backend.close();
    const env3 = await makeBackend({ dataDir });
    expect(env3.backend.schemaVersionNow).toBe(MIGRATIONS.length);
    const s3 = await login(env3);
    expect((await ok<{ total: number }>(env3, 'customers.list', { query: 'Legacy' }, s3)).total).toBe(1);
    expect((await ok<MoneyAccountDto[]>(env3, 'moneyAccounts.list', {}, s3)).map((a) => a.currencyCode)).toEqual(['EGP']);
    expect((await ok<{ total: number }>(env3, 'airports.list', { query: 'CAI' }, s3)).total).toBeGreaterThan(0);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(`${dataDir}/backups`).some((f) => f.includes('pre_migration'))).toBe(true);
    expect((await ok<{ ok: boolean }>(env3, 'integrity.run', {}, s3)).ok).toBe(true);
  });
});
