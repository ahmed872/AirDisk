import type { BookingDto, CancellationDto, DashboardMetricsDto, ScheduleChangeDto } from '@airdesk/contracts';
import { ErrorCode } from '@airdesk/domain';
import { describe, expect, it } from 'vitest';
import { book, fail, ok, seg, summary, world } from './flow';
import { auditActions, ready, userWithRoles } from './helpers';

/** FR-REF-06: a ticket reissued outside AirDesk (customer changed date) is recorded as an exchange. */
describe('Ticket reissue / exchange', () => {
  it('replaces the ticket, records the new flight without an alert, and posts only the differences', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    let b = await book(env, s, w, { ticketNumbers: ['0771234567890'] }); // sale 10,500 / cost 10,100
    const old = b.tickets[0]!;
    const segment = b.segments[0]!;
    b = await ok<BookingDto>(env, 'bookings.reissue', {
      bookingId: b.id, ticketId: old.id, rowVersion: b.rowVersion, newTicketNumber: '077-1234567891',
      fareDifferenceMinor: 100_000, changeFeeMinor: 50_000, additionalCostMinor: 90_000, supplierPenaltyMinor: 20_000,
      segments: [{ segmentId: segment.id, segment: seg(w.airline.id, { departureDate: '2026-10-20', arrivalDate: '2026-10-20' }) }],
      reason: 'Customer moved the trip to 20 Oct', externalReference: 'ADM-77',
    }, s);
    expect(b.tickets.map((t) => [t.ticketNumber, t.status, t.exchangedFromNumber])).toEqual([
      ['0771234567890', 'EXCHANGED', null],
      ['0771234567891', 'ISSUED', '0771234567890'],
    ]);
    expect(b.segments[0]!.departureDate).toBe('2026-10-20');
    const inv = b.documents.filter((d) => d.docType === 'CUSTOMER_INVOICE');
    expect(inv.map((d) => d.totalMinor)).toEqual([1_050_000, 150_000]);
    expect(b.documents.filter((d) => d.docType === 'SUPPLIER_BILL').map((d) => [d.totalMinor, d.externalReference])).toEqual([[1_010_000, null], [110_000, 'ADM-77']]);
    expect(b.customer[0]).toMatchObject({ chargedMinor: 1_200_000, balanceMinor: 1_200_000 });
    expect(b.profit).toEqual({ netSalesBaseMinor: 1_200_000, netCostBaseMinor: 1_120_000, grossProfitBaseMinor: 80_000 });
    // The new flight is history-tracked but needs no customer notification: the customer asked for it.
    const changes = await ok<ScheduleChangeDto[]>(env, 'schedule.list', {}, s);
    expect(changes.map((c) => c.notificationStatus)).toEqual(['MANUALLY_CONFIRMED']);
    expect(await ok<ScheduleChangeDto[]>(env, 'schedule.list', { attentionOnly: true }, s)).toEqual([]);
    const dash = await ok<DashboardMetricsDto>(env, 'dashboard.metrics', { from: '2026-09-01', to: '2026-09-30' }, s);
    expect(dash.operational!.changesRequiringAttention).toBe(0);
    expect((await ok<{ items: { id: string }[] }>(env, 'bookings.list', { query: '0771234567891', status: 'ALL' }, s)).items.map((x) => x.id)).toEqual([b.id]);
    expect(auditActions(env)).toEqual(expect.arrayContaining(['ticket.reissued', 'ticket.status_changed', 'schedule.changed']));
    expect(summary(env).grossProfit).toBe(80_000);
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });

  it('a later refund of the reissued ticket covers the whole exchange chain', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    let b = await book(env, s, w);
    b = await ok<BookingDto>(env, 'bookings.reissue', { bookingId: b.id, ticketId: b.tickets[0]!.id, rowVersion: b.rowVersion, changeFeeMinor: 50_000, supplierPenaltyMinor: 20_000, reason: 'Date change' }, s);
    const current = b.tickets.find((t) => t.status === 'ISSUED')!;
    let c = await ok<CancellationDto>(env, 'cancellations.request', { bookingId: b.id, cancelType: 'REFUND', reason: 'Trip cancelled' }, s);
    expect(c.tickets.map((t) => t.ticketId)).toEqual([current.id]); // the exchanged ticket is closed
    c = await ok<CancellationDto>(env, 'cancellations.submit', { id: c.id, rowVersion: c.rowVersion }, s);
    // More than the new ticket's own 200.00 cost: the original 10,100 carries over.
    c = await ok<CancellationDto>(env, 'cancellations.confirmSupplier', { id: c.id, rowVersion: c.rowVersion, lines: [{ ticketId: current.id, returnMinor: 1_000_000, penaltyMinor: 30_000 }] }, s);
    expect((await fail(env, 'cancellations.creditCustomer', { id: c.id, rowVersion: c.rowVersion, lines: [{ ticketId: current.id, returnMinor: 1_100_001 }] }, s)).reason).toBe('OVER_ALLOCATION');
    c = await ok<CancellationDto>(env, 'cancellations.creditCustomer', { id: c.id, rowVersion: c.rowVersion, lines: [{ ticketId: current.id, returnMinor: 1_100_000 }] }, s);
    expect(c.overallStatus).toBe('CLOSED');
    b = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(b.tickets.find((t) => t.id === current.id)!.status).toBe('REFUNDED');
    expect(b.status).toBe('CANCELLED');
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });

  it('guards: exchanged tickets are closed, numbers stay unique, stale edits and agents are refused', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    let b = await book(env, s, w, { ticketNumbers: ['0771234567890'] });
    const first = b.tickets[0]!;
    expect((await fail(env, 'bookings.reissue', { bookingId: b.id, ticketId: first.id, rowVersion: b.rowVersion, newTicketNumber: '0771234567890', reason: 'x' }, s)).reason).toBe('DUPLICATE_TICKET');
    expect((await fail(env, 'bookings.reissue', { bookingId: b.id, ticketId: first.id, rowVersion: b.rowVersion - 1, reason: 'x' }, s)).code).toBe(ErrorCode.STALE_RECORD);
    b = await ok<BookingDto>(env, 'bookings.reissue', { bookingId: b.id, ticketId: first.id, rowVersion: b.rowVersion, reason: 'Name spelling fixed by airline' }, s);
    expect((await fail(env, 'bookings.reissue', { bookingId: b.id, ticketId: first.id, rowVersion: b.rowVersion, reason: 'again' }, s)).reason).toBe('INVALID_TRANSITION');
    const fresh = b.tickets.find((t) => t.status === 'ISSUED')!;
    expect(fresh.ticketNumber).toBeNull(); // recorded later with "Record ticket number"
    b = await ok<BookingDto>(env, 'bookings.setTicketNumber', { bookingId: b.id, ticketId: fresh.id, ticketNumber: '0771234567899' }, s);
    const agent = await userWithRoles(env, s, 'agent', ['SALES_AGENT']);
    expect((await fail(env, 'bookings.reissue', { bookingId: b.id, ticketId: fresh.id, rowVersion: b.rowVersion, reason: 'x' }, agent)).code).toBe(ErrorCode.FORBIDDEN);
    const draft = await book(env, s, w, { issue: false });
    expect((await fail(env, 'bookings.reissue', { bookingId: draft.id, ticketId: fresh.id, rowVersion: draft.rowVersion, reason: 'x' }, s)).reason).toBe('NOT_ISSUED');
  });
});

/** Regression: supplier/airline references are written when the document is posted (documents are immutable afterwards). */
describe('Supplier references on documents', () => {
  it('are kept on the bill at confirmation, on cost adjustments, reissues and supplier refunds', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    let b = await ok<BookingDto>(env, 'bookings.create', { customerId: w.customer.id, pnr: 'REF123', supplierId: w.supplier.id }, s);
    b = await ok<BookingDto>(env, 'bookings.savePassenger', { bookingId: b.id, passenger: { givenName: 'Ahmed', surname: 'Ali' } }, s);
    b = await ok<BookingDto>(env, 'bookings.saveSegment', { bookingId: b.id, segment: seg(w.airline.id) }, s);
    b = await ok<BookingDto>(env, 'bookings.savePriceItem', { bookingId: b.id, item: { passengerId: b.passengers[0]!.id, supplierId: w.supplier.id, fareMinor: 500_000, costMinor: 450_000, costCurrency: 'EGP', supplierReference: 'CONS-INV-991' } }, s);
    b = await ok<BookingDto>(env, 'bookings.issue', { id: b.id, rowVersion: b.rowVersion }, s);
    const refOf = (x: BookingDto, type: string) => x.documents.filter((d) => d.docType === type).map((d) => d.externalReference);
    expect(refOf(b, 'SUPPLIER_BILL')).toEqual(['CONS-INV-991']);
    const ticketId = b.tickets[0]!.id;
    b = await ok<BookingDto>(env, 'bookings.adjustCost', { bookingId: b.id, ticketId, kind: 'INCREASE', amountMinor: 5_000, reason: 'ADM', externalReference: 'ADM-1' }, s);
    expect(refOf(b, 'SUPPLIER_BILL')).toEqual(['CONS-INV-991', 'ADM-1']);
    b = await ok<BookingDto>(env, 'bookings.reissue', { bookingId: b.id, ticketId, rowVersion: b.rowVersion, supplierPenaltyMinor: 10_000, reason: 'Date change', externalReference: 'RI-7' }, s);
    expect(refOf(b, 'SUPPLIER_BILL')).toEqual(['CONS-INV-991', 'ADM-1', 'RI-7']);
    const current = b.tickets.find((t) => t.status === 'ISSUED')!;
    let c = await ok<CancellationDto>(env, 'cancellations.request', { bookingId: b.id, cancelType: 'REFUND', reason: 'x' }, s);
    c = await ok<CancellationDto>(env, 'cancellations.submit', { id: c.id, rowVersion: c.rowVersion }, s);
    await ok(env, 'cancellations.confirmSupplier', { id: c.id, rowVersion: c.rowVersion, lines: [{ ticketId: current.id, returnMinor: 400_000 }], externalReference: 'RFND-55' }, s);
    b = await ok<BookingDto>(env, 'bookings.get', { id: b.id }, s);
    expect(refOf(b, 'SUPPLIER_CREDIT_NOTE')).toEqual(['RFND-55']);
    const report = await ok<{ rows: Record<string, unknown>[] }>(env, 'reports.run', { report: 'purchases', from: '2026-01-01', to: '2026-12-31' }, s);
    expect(report.rows.map((r) => r.external_reference)).toEqual(expect.arrayContaining(['CONS-INV-991', 'ADM-1', 'RI-7']));
    expect((await ok<{ ok: boolean }>(env, 'integrity.run', {}, s)).ok).toBe(true);
  });
});
