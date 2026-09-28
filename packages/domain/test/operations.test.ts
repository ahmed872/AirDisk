import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  BOOKING_EVENTS, BOOKING_STATUSES, NOTIFICATION_STATUSES, TICKET_STATUSES,
  addDays, ageOn, agingBucket, assertIssuable, assertWithdrawable, bookingTransition, canBookingTransition, changeNotificationTransition,
  changeSeverity, customerSideTransition, diffSegment, normalizePassenger, normalizePnr, normalizeSegment, normalizeTicketNumber,
  paxTypeForAge, planIssue, requestOverall, requiresAttention, saleTotal, settlementStatus, supplierSideTransition, ticketTransition,
  type BookingStatus, type IssueContext, type PriceItem, type SegmentSnapshot,
} from '../src';

const code = (fn: () => unknown) => {
  try { fn(); return 'OK'; } catch (e) { return (e as { details?: { reason?: string }; code: string }).details?.reason ?? (e as { code: string }).code; }
};

describe('booking state machine (Phase 0 §05-1)', () => {
  const allowed: Record<BookingStatus, string[]> = {
    DRAFT: ['RESERVE', 'ISSUE', 'DISCARD'],
    RESERVED: ['RELEASE', 'ISSUE', 'DISCARD'],
    ISSUED: ['CANCEL_PARTIAL', 'CANCEL_ALL', 'VOID_ALL'],
    PARTIALLY_CANCELLED: ['CANCEL_PARTIAL', 'CANCEL_ALL'],
    CANCELLED: [], VOIDED: [], DISCARDED: [],
  };
  it('accepts exactly the transitions in the table (every state × every event)', () => {
    for (const s of BOOKING_STATUSES) {
      for (const e of BOOKING_EVENTS) {
        expect(canBookingTransition(s, e), `${s} ${e}`).toBe(allowed[s].includes(e));
        if (!allowed[s].includes(e)) expect(code(() => bookingTransition(s, e))).toBe('INVALID_TRANSITION');
      }
    }
    expect(bookingTransition('RESERVED', 'ISSUE')).toBe('ISSUED');
    expect(bookingTransition('ISSUED', 'VOID_ALL')).toBe('VOIDED');
  });
  it('terminal states accept nothing', () => {
    for (const s of ['CANCELLED', 'VOIDED', 'DISCARDED'] as const) for (const e of BOOKING_EVENTS) expect(canBookingTransition(s, e)).toBe(false);
  });
});

describe('ticket, cancellation and notification state machines', () => {
  it('ticket transitions', () => {
    expect(ticketTransition('ISSUED', 'REFUND_PARTIAL')).toBe('PARTIALLY_REFUNDED');
    expect(ticketTransition('PARTIALLY_REFUNDED', 'REFUND_FULL')).toBe('REFUNDED');
    for (const s of TICKET_STATUSES.filter((x) => x !== 'ISSUED' && x !== 'PARTIALLY_REFUNDED')) {
      expect(code(() => ticketTransition(s, 'REFUND_FULL'))).toBe('INVALID_TRANSITION');
    }
  });
  it('cancellation sides are independent and the request closes when both are terminal', () => {
    expect(supplierSideTransition('PENDING', 'SUBMITTED')).toBe('SUBMITTED');
    expect(code(() => supplierSideTransition('CONFIRMED', 'REJECTED'))).toBe('INVALID_TRANSITION');
    expect(code(() => supplierSideTransition('PENDING', 'REJECTED'))).toBe('INVALID_TRANSITION');
    expect(customerSideTransition('PENDING', 'CREDITED')).toBe('CREDITED');
    expect(code(() => customerSideTransition('CREDITED', 'NOT_APPLICABLE'))).toBe('INVALID_TRANSITION');
    expect(requestOverall('CONFIRMED', 'PENDING')).toBe('OPEN');
    expect(requestOverall('PENDING', 'CREDITED')).toBe('OPEN');
    expect(requestOverall('REJECTED', 'NOT_APPLICABLE')).toBe('CLOSED');
    expect(requestOverall('PENDING', 'PENDING', true)).toBe('WITHDRAWN');
    expect(code(() => assertWithdrawable('SUBMITTED', 'PENDING'))).toBe('OK');
    expect(code(() => assertWithdrawable('CONFIRMED', 'PENDING'))).toBe('NOT_WITHDRAWABLE');
  });
  it('schedule-change notification status and attention', () => {
    expect(changeNotificationTransition('NOT_NOTIFIED', 'NOTIFICATION_FAILED')).toBe('NOTIFICATION_FAILED');
    expect(changeNotificationTransition('NOTIFICATION_FAILED', 'CUSTOMER_NOTIFIED')).toBe('CUSTOMER_NOTIFIED');
    expect(code(() => changeNotificationTransition('MANUALLY_CONFIRMED', 'NOT_NOTIFIED'))).toBe('INVALID_TRANSITION');
    const attention = NOTIFICATION_STATUSES.filter((s) => requiresAttention(s, false));
    expect(attention).toEqual(['NOT_NOTIFIED', 'NOTIFICATION_FAILED']);
    expect(requiresAttention('NOT_NOTIFIED', true)).toBe(false);
  });
});

describe('passengers, segments, PNR, ticket numbers', () => {
  it('normalizes passenger names to document form and validates identity fields', () => {
    const p = normalizePassenger({ givenName: ' ahmed  ali ', surname: 'hassan', nationality: 'eg', passportNo: 'a 1234567', dateOfBirth: '1990-05-01' }, { today: '2026-09-28' });
    expect(p).toMatchObject({ givenName: 'AHMED ALI', surname: 'HASSAN', nationality: 'EG', passportNo: 'A1234567', idDocumentType: 'PASSPORT', paxType: 'ADT' });
    expect(code(() => normalizePassenger({ givenName: 'أحمد', surname: 'X' }, { today: '2026-09-28' }))).toBe('LATIN_NAME');
    expect(code(() => normalizePassenger({ givenName: 'A', surname: 'B', dateOfBirth: '2030-01-01' }, { today: '2026-09-28' }))).toBe('DATE_IN_FUTURE');
    expect(code(() => normalizePassenger({ givenName: 'A', surname: 'B', nationality: 'XX' }, { today: '2026-09-28' }))).toBe('INVALID_COUNTRY');
    expect(ageOn('2024-10-01', '2026-09-30')).toBe(1);
    expect(paxTypeForAge(1)).toBe('INF');
    expect(paxTypeForAge(11)).toBe('CHD');
    expect(paxTypeForAge(12)).toBe('ADT');
  });
  it('validates segments (multi-segment journeys, local times, codes)', () => {
    const s = normalizeSegment({ airlineId: 'a', flightNumber: ' 915 ', origin: 'cai', destination: 'jed', departureDate: '2026-10-01', departureTime: '23:30', arrivalDate: '2026-10-02', arrivalTime: '01:40' });
    expect(s).toMatchObject({ flightNumber: '915', origin: 'CAI', destination: 'JED', cabinClass: 'ECONOMY', status: 'CONFIRMED' });
    // Westbound same-day arrival earlier in local time is legitimate.
    expect(code(() => normalizeSegment({ airlineId: 'a', flightNumber: '1', origin: 'JED', destination: 'CAI', departureDate: '2026-10-01', departureTime: '09:00', arrivalDate: '2026-10-01', arrivalTime: '08:50' }))).toBe('OK');
    expect(code(() => normalizeSegment({ airlineId: 'a', flightNumber: '1', origin: 'CAI', destination: 'CAI', departureDate: '2026-10-01', departureTime: '09:00', arrivalDate: '2026-10-01', arrivalTime: '10:00' }))).toBe('SAME_AIRPORT');
    expect(code(() => normalizeSegment({ airlineId: 'a', flightNumber: '1', origin: 'CAI', destination: 'JED', departureDate: '2026-10-02', departureTime: '09:00', arrivalDate: '2026-10-01', arrivalTime: '10:00' }))).toBe('ARRIVAL_BEFORE_DEPARTURE');
    expect(code(() => normalizeSegment({ airlineId: 'a', flightNumber: '1', origin: 'CAI', destination: 'JED', departureDate: '2026-10-01', departureTime: '25:00', arrivalDate: '2026-10-01', arrivalTime: '10:00' }))).toBe('INVALID_TIME');
    expect(code(() => normalizeSegment({ airlineId: 'a', flightNumber: 'MS915', origin: 'CAI', destination: 'JED', departureDate: '2026-10-01', departureTime: '09:00', arrivalDate: '2026-10-01', arrivalTime: '10:00' }))).toBe('INVALID_FLIGHT_NUMBER');
  });
  it('PNR and ticket numbers', () => {
    expect(normalizePnr(' abc12x ')).toBe('ABC12X');
    expect(code(() => normalizePnr('AB'))).toBe('INVALID_PNR');
    expect(normalizeTicketNumber('077-2345678901', '077')).toBe('0772345678901');
    expect(code(() => normalizeTicketNumber('0652345678901', '077'))).toBe('TICKET_PREFIX_MISMATCH');
    expect(code(() => normalizeTicketNumber('12345'))).toBe('INVALID_TICKET_NUMBER');
    expect(normalizeTicketNumber('')).toBeNull();
  });
});

describe('pricing and issue (BR-BKG-01/02)', () => {
  const item = (over: Partial<PriceItem> = {}): PriceItem => ({
    id: 'i1', passengerId: 'p1', supplierId: 's1', ticketNumber: null,
    fareMinor: 900_000, taxesMinor: 150_000, serviceFeeMinor: 0, discountMinor: 0, costCurrency: 'EGP', costMinor: 1_010_000, ...over,
  });
  const ctx = (over: Partial<IssueContext> = {}): IssueContext => ({
    hasCustomer: true, activePassengerIds: ['p1'], activeSegmentCount: 1, items: [item()], canZeroPrice: false, canSellBelowCost: false,
    toBase: (_c, m) => m, saleCurrency: 'EGP', ...over,
  });
  it('sale total = fare + taxes + fees − discount; profit is not fixed', () => {
    expect(saleTotal(item())).toBe(1_050_000);
    expect(saleTotal(item({ serviceFeeMinor: 5_000, discountMinor: 20_000 }))).toBe(1_035_000);
  });
  it('rejects bookings that are not issuable', () => {
    expect(code(() => assertIssuable(ctx()))).toBe('OK');
    expect(code(() => assertIssuable(ctx({ activePassengerIds: [] })))).toBe('NO_PASSENGERS');
    expect(code(() => assertIssuable(ctx({ activeSegmentCount: 0 })))).toBe('NO_SEGMENTS');
    expect(code(() => assertIssuable(ctx({ activePassengerIds: ['p1', 'p2'] })))).toBe('PASSENGER_NOT_PRICED');
    expect(code(() => assertIssuable(ctx({ items: [item({ supplierId: null })] })))).toBe('NO_SUPPLIER');
    expect(code(() => assertIssuable(ctx({ items: [item({ costMinor: null })] })))).toBe('NO_COST');
    expect(code(() => assertIssuable(ctx({ items: [item({ fareMinor: 0, taxesMinor: 0, costMinor: 0 })] })))).toBe('ZERO_PRICE');
    expect(code(() => assertIssuable(ctx({ items: [item({ fareMinor: 0, taxesMinor: 0, costMinor: 0 })], canZeroPrice: true })))).toBe('OK');
    expect(code(() => assertIssuable(ctx({ items: [item({ costMinor: 2_000_000 })] })))).toBe('BELOW_COST');
    expect(code(() => assertIssuable(ctx({ items: [item({ costMinor: 2_000_000 })], canSellBelowCost: true })))).toBe('OK');
    expect(code(() => assertIssuable(ctx({ items: [item({ discountMinor: 9_999_999 })] })))).toBe('DISCOUNT_TOO_LARGE');
  });
  it('plans one invoice, an optional discount credit note, and one bill per (supplier, currency)', () => {
    const plan = planIssue('b1', [
      { ...item({ id: 'a', passengerId: 'p1', discountMinor: 10_000 }), ticketId: 't1' },
      { ...item({ id: 'b', passengerId: 'p2', supplierId: 's2', costCurrency: 'USD', costMinor: 20_000 }), ticketId: 't2' },
      { ...item({ id: 'c', passengerId: 'p3' }), ticketId: 't3' },
    ]);
    expect(plan.invoiceLines.map((l) => [l.lineType, l.ticketId])).toEqual([['FARE', 't1'], ['TAXES', 't1'], ['FARE', 't2'], ['TAXES', 't2'], ['FARE', 't3'], ['TAXES', 't3']]);
    expect(plan.discountLines).toEqual([{ lineType: 'DISCOUNT', amountMinor: 10_000, bookingId: 'b1', passengerId: 'p1', ticketId: 't1' }]);
    expect(plan.bills.map((b) => [b.supplierId, b.currency, b.lines.length])).toEqual([['s1', 'EGP', 2], ['s2', 'USD', 1]]);
  });
  it('property: invoice − discount always equals Σ sale totals', () => {
    fc.assert(fc.property(fc.array(fc.record({ f: fc.nat(10_000_000), t: fc.nat(1_000_000), s: fc.nat(100_000), d: fc.nat(100_000) }), { minLength: 1, maxLength: 9 }), (rows) => {
      const items = rows.map((r, i) => ({ ...item({ id: `i${i}`, passengerId: `p${i}`, fareMinor: r.f, taxesMinor: r.t, serviceFeeMinor: r.s, discountMinor: Math.min(r.d, r.f + r.t + r.s) }), ticketId: `t${i}` }));
      const plan = planIssue('b', items);
      const sum = (ls: { amountMinor: number }[]) => ls.reduce((a, l) => a + l.amountMinor, 0);
      expect(sum(plan.invoiceLines) - sum(plan.discountLines)).toBe(items.reduce((a, i) => a + saleTotal(i), 0));
    }));
  });
});

describe('schedule changes', () => {
  const base: SegmentSnapshot = {
    departure_date: '2026-10-01', departure_time: '10:00', arrival_date: '2026-10-01', arrival_time: '12:00', flight_number: '915',
    origin_iata: 'CAI', destination_iata: 'JED', marketing_airline_id: 'a', operating_airline_id: null, departure_terminal: '3',
    arrival_terminal: null, cabin_class: 'ECONOMY', status: 'CONFIRMED',
  };
  it('records exactly the changed fields with old and new values', () => {
    const after = { ...base, departure_time: '10:30', arrival_time: '12:30' };
    expect(diffSegment(base, after)).toEqual([
      { field: 'departure_time', oldValue: '10:00', newValue: '10:30' },
      { field: 'arrival_time', oldValue: '12:00', newValue: '12:30' },
    ]);
    expect(changeSeverity(diffSegment(base, after), base, after)).toBe('MINOR');
  });
  it('classifies MAJOR changes (date, flight, airport, cancellation, big time shift)', () => {
    for (const after of [
      { ...base, departure_date: '2026-10-02' }, { ...base, flight_number: '917' }, { ...base, origin_iata: 'HBE' },
      { ...base, status: 'CANCELLED' }, { ...base, departure_time: '11:00' },
    ]) expect(changeSeverity(diffSegment(base, after), base, after)).toBe('MAJOR');
    const terminal = { ...base, departure_terminal: '2' };
    expect(changeSeverity(diffSegment(base, terminal), base, terminal)).toBe('MINOR');
  });
});

describe('settlement badges and aging', () => {
  it('derives customer settlement from charged and balance', () => {
    expect(settlementStatus(1_050_000, 1_050_000)).toBe('UNPAID');
    expect(settlementStatus(1_050_000, 550_000)).toBe('PARTIALLY_PAID');
    expect(settlementStatus(1_050_000, 0)).toBe('PAID');
    expect(settlementStatus(1_050_000, -100)).toBe('CREDIT');
    expect(settlementStatus(0, 0)).toBe('NOT_CHARGED');
  });
  it('buckets open items by days past due (Current, 1–7, 8–30, 31–60, 60+)', () => {
    const due = '2026-09-01';
    expect(agingBucket(due, '2026-09-01')).toBe('CURRENT');
    expect(agingBucket(due, '2026-08-20')).toBe('CURRENT');
    expect(agingBucket(due, addDays(due, 7))).toBe('D1_7');
    expect(agingBucket(due, addDays(due, 8))).toBe('D8_30');
    expect(agingBucket(due, addDays(due, 31))).toBe('D31_60');
    expect(agingBucket(due, addDays(due, 61))).toBe('D60_PLUS');
  });
});
