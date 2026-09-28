import { DomainError, ErrorCode } from '../errors';
import { assertCountryCode, fieldError, optionalText, requiredText } from '../contact/contact';
import { assertIsoDate, isIsoDate } from '../time/dates';
import type { DocumentLineDraft } from '../ledger/documents';

// ── Passengers ─────────────────────────────────────────────────────────────
export const PAX_TYPES = ['ADT', 'CHD', 'INF'] as const;
export type PaxType = (typeof PAX_TYPES)[number];
export const GENDERS = ['M', 'F', 'X'] as const;
export const ID_DOCUMENT_TYPES = ['PASSPORT', 'NATIONAL_ID', 'OTHER'] as const;

export interface PassengerInput {
  paxType?: PaxType | null;
  title?: string | null;
  givenName: string;
  surname: string;
  nameAr?: string | null;
  gender?: (typeof GENDERS)[number] | null;
  dateOfBirth?: string | null;
  nationality?: string | null;
  passportNo?: string | null;
  passportExpiry?: string | null;
  idDocumentType?: (typeof ID_DOCUMENT_TYPES)[number] | null;
  idDocumentNo?: string | null;
  frequentFlyerNo?: string | null;
  mobile?: string | null;
  notes?: string | null;
}

export type NormalizedPassenger = Required<{ [K in keyof PassengerInput]: Exclude<PassengerInput[K], undefined> }> & { paxType: PaxType };

/** Passenger names are stored as on the travel document: Latin letters, upper-case. */
const LATIN_NAME = /^[A-Z][A-Z' -]*$/;

export function normalizePassenger(input: PassengerInput, ctx: { today: string }): NormalizedPassenger {
  const upper = (v: string) => v.trim().replace(/\s+/g, ' ').toUpperCase();
  const givenName = upper(requiredText(input.givenName, 'givenName', 60));
  const surname = upper(requiredText(input.surname, 'surname', 60));
  if (!LATIN_NAME.test(givenName)) throw fieldError('givenName', 'LATIN_NAME', 'Use Latin letters as on the passport');
  if (!LATIN_NAME.test(surname)) throw fieldError('surname', 'LATIN_NAME', 'Use Latin letters as on the passport');
  const dob = optionalText(input.dateOfBirth, 'dateOfBirth', 10);
  if (dob) {
    if (!isIsoDate(dob)) throw fieldError('dateOfBirth', 'INVALID_DATE', 'Invalid date');
    if (dob > ctx.today) throw fieldError('dateOfBirth', 'DATE_IN_FUTURE', 'Date of birth cannot be in the future');
  }
  const expiry = optionalText(input.passportExpiry, 'passportExpiry', 10);
  if (expiry && !isIsoDate(expiry)) throw fieldError('passportExpiry', 'INVALID_DATE', 'Invalid date');
  const nationality = optionalText(input.nationality, 'nationality', 2)?.toUpperCase() ?? null;
  if (nationality) assertCountryCode(nationality, 'nationality');
  const passportNo = optionalText(input.passportNo, 'passportNo', 20)?.toUpperCase().replace(/\s+/g, '') ?? null;
  if (passportNo && !/^[A-Z0-9]{5,20}$/.test(passportNo)) throw fieldError('passportNo', 'INVALID_DOCUMENT_NO', 'Invalid passport number');
  const ff = optionalText(input.frequentFlyerNo, 'frequentFlyerNo', 30)?.toUpperCase() ?? null;
  return {
    paxType: input.paxType ?? 'ADT',
    title: optionalText(input.title, 'title', 10)?.toUpperCase() ?? null,
    givenName,
    surname,
    nameAr: optionalText(input.nameAr, 'nameAr', 120),
    gender: input.gender ?? null,
    dateOfBirth: dob,
    nationality,
    passportNo,
    passportExpiry: expiry,
    idDocumentType: input.idDocumentType ?? (passportNo ? 'PASSPORT' : null),
    idDocumentNo: optionalText(input.idDocumentNo, 'idDocumentNo', 40),
    frequentFlyerNo: ff,
    mobile: optionalText(input.mobile, 'mobile', 40),
    notes: optionalText(input.notes, 'notes', 1000),
  };
}

/** Whole years between two ISO dates. */
export function ageOn(dateOfBirth: string, onDate: string): number {
  const [y1, m1, d1] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = onDate.split('-').map(Number) as [number, number, number];
  return y2 - y1 - (m2 < m1 || (m2 === m1 && d2 < d1) ? 1 : 0);
}

/** Pax type implied by age on the date of travel (IATA: INF < 2, CHD 2–11, ADT 12+). */
export function paxTypeForAge(age: number): PaxType {
  return age < 2 ? 'INF' : age < 12 ? 'CHD' : 'ADT';
}

// ── Segments ───────────────────────────────────────────────────────────────
export const CABIN_CLASSES = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'] as const;
export const SEGMENT_STATUSES = ['CONFIRMED', 'WAITLISTED', 'CANCELLED'] as const;

export interface SegmentInput {
  airlineId: string;
  operatingAirlineId?: string | null;
  flightNumber: string;
  origin: string;
  destination: string;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  cabinClass?: (typeof CABIN_CLASSES)[number] | null;
  bookingClass?: string | null;
  departureTerminal?: string | null;
  arrivalTerminal?: string | null;
  baggage?: string | null;
  seat?: string | null;
  airlineLocator?: string | null;
  status?: (typeof SEGMENT_STATUSES)[number] | null;
  notes?: string | null;
}

export interface NormalizedSegment {
  airlineId: string;
  operatingAirlineId: string | null;
  flightNumber: string;
  origin: string;
  destination: string;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  cabinClass: (typeof CABIN_CLASSES)[number];
  bookingClass: string | null;
  departureTerminal: string | null;
  arrivalTerminal: string | null;
  baggage: string | null;
  seat: string | null;
  airlineLocator: string | null;
  status: (typeof SEGMENT_STATUSES)[number];
  notes: string | null;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalizeSegment(input: SegmentInput): NormalizedSegment {
  const flightNumber = requiredText(input.flightNumber, 'flightNumber', 8).toUpperCase().replace(/\s+/g, '');
  if (!/^\d{1,4}[A-Z]?$/.test(flightNumber)) throw fieldError('flightNumber', 'INVALID_FLIGHT_NUMBER', 'Flight number is 1–4 digits (e.g. 915)');
  const origin = requiredText(input.origin, 'origin', 3).toUpperCase();
  const destination = requiredText(input.destination, 'destination', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(origin)) throw fieldError('origin', 'INVALID_AIRPORT', 'Airport code is 3 letters');
  if (!/^[A-Z]{3}$/.test(destination)) throw fieldError('destination', 'INVALID_AIRPORT', 'Airport code is 3 letters');
  if (origin === destination) throw fieldError('destination', 'SAME_AIRPORT', 'Origin and destination must differ');
  for (const f of ['departureDate', 'arrivalDate'] as const) {
    if (!isIsoDate(input[f] ?? '')) throw fieldError(f, 'INVALID_DATE', 'Invalid date');
  }
  for (const f of ['departureTime', 'arrivalTime'] as const) {
    if (!TIME_RE.test(input[f] ?? '')) throw fieldError(f, 'INVALID_TIME', 'Time is HH:MM (24h)');
  }
  // Local times: a westbound flight may land "earlier" than it departed, so only the dates are ordered.
  if (input.arrivalDate < input.departureDate) throw fieldError('arrivalDate', 'ARRIVAL_BEFORE_DEPARTURE', 'Arrival cannot be before departure');
  const bookingClass = optionalText(input.bookingClass, 'bookingClass', 2)?.toUpperCase() ?? null;
  if (bookingClass && !/^[A-Z]$/.test(bookingClass)) throw fieldError('bookingClass', 'INVALID_VALUE', 'Booking class is one letter');
  if (!input.airlineId) throw fieldError('airlineId', 'REQUIRED', 'Airline is required');
  return {
    airlineId: input.airlineId,
    operatingAirlineId: input.operatingAirlineId ?? null,
    flightNumber,
    origin,
    destination,
    departureDate: input.departureDate,
    departureTime: input.departureTime,
    arrivalDate: input.arrivalDate,
    arrivalTime: input.arrivalTime,
    cabinClass: input.cabinClass ?? 'ECONOMY',
    bookingClass,
    departureTerminal: optionalText(input.departureTerminal, 'departureTerminal', 10),
    arrivalTerminal: optionalText(input.arrivalTerminal, 'arrivalTerminal', 10),
    baggage: optionalText(input.baggage, 'baggage', 40),
    seat: optionalText(input.seat, 'seat', 10)?.toUpperCase() ?? null,
    airlineLocator: optionalText(input.airlineLocator, 'airlineLocator', 10)?.toUpperCase() ?? null,
    status: input.status ?? 'CONFIRMED',
    notes: optionalText(input.notes, 'notes', 500),
  };
}

export function normalizePnr(pnr: string | null | undefined): string | null {
  const v = optionalText(pnr, 'pnr', 10)?.toUpperCase().replace(/\s+/g, '') ?? null;
  if (v && !/^[A-Z0-9]{5,8}$/.test(v)) throw fieldError('pnr', 'INVALID_PNR', 'PNR is 5–8 letters/digits');
  return v;
}

/** 13-digit e-ticket number (3-digit airline prefix + 10 digits); dashes/spaces ignored. */
export function normalizeTicketNumber(input: string | null | undefined, airlinePrefix?: string | null): string | null {
  const raw = optionalText(input, 'ticketNumber', 20);
  if (!raw) return null;
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d{13}$/.test(digits)) throw fieldError('ticketNumber', 'INVALID_TICKET_NUMBER', 'A ticket number has 13 digits');
  if (airlinePrefix && !digits.startsWith(airlinePrefix)) {
    throw fieldError('ticketNumber', 'TICKET_PREFIX_MISMATCH', `Ticket numbers of this airline start with ${airlinePrefix}`);
  }
  return digits;
}

// ── Pricing ────────────────────────────────────────────────────────────────
export interface PriceItem {
  id: string;
  passengerId: string;
  supplierId: string | null;
  ticketNumber: string | null;
  fareMinor: number;
  taxesMinor: number;
  serviceFeeMinor: number;
  discountMinor: number;
  costCurrency: string | null;
  costMinor: number | null;
}

export function saleTotal(p: Pick<PriceItem, 'fareMinor' | 'taxesMinor' | 'serviceFeeMinor' | 'discountMinor'>): number {
  return p.fareMinor + p.taxesMinor + p.serviceFeeMinor - p.discountMinor;
}

export function assertPriceAmounts(p: Pick<PriceItem, 'fareMinor' | 'taxesMinor' | 'serviceFeeMinor' | 'discountMinor'> & { costMinor?: number | null }): void {
  for (const [field, v] of [['fareMinor', p.fareMinor], ['taxesMinor', p.taxesMinor], ['serviceFeeMinor', p.serviceFeeMinor], ['discountMinor', p.discountMinor], ['costMinor', p.costMinor ?? 0]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw fieldError(field, 'INVALID_AMOUNT', 'Amounts must be zero or positive');
  }
  if (p.discountMinor > p.fareMinor + p.taxesMinor + p.serviceFeeMinor) throw fieldError('discountMinor', 'DISCOUNT_TOO_LARGE', 'Discount exceeds the price');
}

export interface IssueContext {
  hasCustomer: boolean;
  activePassengerIds: readonly string[];
  activeSegmentCount: number;
  items: readonly PriceItem[];
  canZeroPrice: boolean;
  canSellBelowCost: boolean;
  /** Converts a (currency, minor) to base minor for the below-cost comparison; null when no rate is known. */
  toBase(currency: string, minor: number): number | null;
  saleCurrency: string;
}

/** BR-BKG-01 — everything that must be true before a booking can be ticketed. */
export function assertIssuable(ctx: IssueContext): void {
  const fail = (reason: string, message: string, details: Record<string, unknown> = {}) => {
    throw new DomainError(ErrorCode.VALIDATION, message, { reason, ...details });
  };
  if (!ctx.hasCustomer) fail('NO_CUSTOMER', 'A customer is required');
  if (ctx.activePassengerIds.length === 0) fail('NO_PASSENGERS', 'Add at least one passenger');
  if (ctx.activeSegmentCount === 0) fail('NO_SEGMENTS', 'Add at least one flight segment');
  const priced = new Set(ctx.items.map((i) => i.passengerId));
  const missing = ctx.activePassengerIds.filter((p) => !priced.has(p));
  if (missing.length) fail('PASSENGER_NOT_PRICED', 'Every passenger needs a price', { passengerIds: missing });
  for (const item of ctx.items) {
    assertPriceAmounts(item);
    if (!item.supplierId) fail('NO_SUPPLIER', 'Every ticket needs a supplier', { itemId: item.id });
    if (item.costMinor === null || !item.costCurrency) fail('NO_COST', 'Enter the purchase cost for every ticket', { itemId: item.id });
    const sale = saleTotal(item);
    if (sale === 0 && !ctx.canZeroPrice) fail('ZERO_PRICE', 'A zero sale price needs special permission', { itemId: item.id });
    if (!ctx.canSellBelowCost && item.costMinor! > 0) {
      const saleBase = ctx.toBase(ctx.saleCurrency, sale);
      const costBase = ctx.toBase(item.costCurrency!, item.costMinor!);
      if (saleBase !== null && costBase !== null && saleBase < costBase) {
        fail('BELOW_COST', 'The sale price is below the purchase cost', { itemId: item.id });
      }
    }
  }
}

export interface IssuePlan {
  invoiceLines: DocumentLineDraft[];
  /** Discounts are contra-revenue (4120), posted as a credit note alongside the invoice. */
  discountLines: DocumentLineDraft[];
  bills: { supplierId: string; currency: string; lines: DocumentLineDraft[] }[];
}

/**
 * What issuing posts (BR-BKG-02): one customer invoice with a line per price
 * component and ticket, an optional discount credit note, and one supplier bill
 * per (supplier, currency). Zero components produce no line.
 */
export function planIssue(bookingId: string, items: readonly (PriceItem & { ticketId: string })[]): IssuePlan {
  const invoiceLines: DocumentLineDraft[] = [];
  const discountLines: DocumentLineDraft[] = [];
  const bills = new Map<string, { supplierId: string; currency: string; lines: DocumentLineDraft[] }>();
  for (const i of items) {
    const dims = { bookingId, passengerId: i.passengerId, ticketId: i.ticketId };
    if (i.fareMinor > 0) invoiceLines.push({ lineType: 'FARE', amountMinor: i.fareMinor, ...dims });
    if (i.taxesMinor > 0) invoiceLines.push({ lineType: 'TAXES', amountMinor: i.taxesMinor, ...dims });
    if (i.serviceFeeMinor > 0) invoiceLines.push({ lineType: 'SERVICE_FEE', amountMinor: i.serviceFeeMinor, ...dims });
    if (i.discountMinor > 0) discountLines.push({ lineType: 'DISCOUNT', amountMinor: i.discountMinor, ...dims });
    if ((i.costMinor ?? 0) > 0) {
      const key = `${i.supplierId}|${i.costCurrency}`;
      const bill = bills.get(key) ?? { supplierId: i.supplierId!, currency: i.costCurrency!, lines: [] };
      bill.lines.push({ lineType: 'PURCHASE_COST', amountMinor: i.costMinor!, ...dims });
      bills.set(key, bill);
    }
  }
  return { invoiceLines, discountLines, bills: [...bills.values()] };
}

// ── Schedule changes (BR-SCH-01/02) ───────────────────────────────────────
export const TRACKED_SEGMENT_FIELDS = [
  'departure_date', 'departure_time', 'arrival_date', 'arrival_time', 'flight_number', 'origin_iata', 'destination_iata',
  'marketing_airline_id', 'operating_airline_id', 'departure_terminal', 'arrival_terminal', 'cabin_class', 'status',
] as const;
export type TrackedSegmentField = (typeof TRACKED_SEGMENT_FIELDS)[number];
export type SegmentSnapshot = Record<TrackedSegmentField, string | null>;

export interface SegmentDiff {
  field: TrackedSegmentField;
  oldValue: string | null;
  newValue: string | null;
}

export function diffSegment(before: SegmentSnapshot, after: SegmentSnapshot): SegmentDiff[] {
  return TRACKED_SEGMENT_FIELDS.filter((f) => (before[f] ?? null) !== (after[f] ?? null)).map((f) => ({
    field: f, oldValue: before[f] ?? null, newValue: after[f] ?? null,
  }));
}

const minutes = (t: string | null) => {
  if (!t || !TIME_RE.test(t)) return 0;
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** MAJOR: date, flight number, airport, airline or cancellation, or a time shift ≥ threshold. */
export function changeSeverity(diffs: readonly SegmentDiff[], before: SegmentSnapshot, after: SegmentSnapshot, thresholdMinutes = 60): 'MINOR' | 'MAJOR' {
  const major: TrackedSegmentField[] = ['departure_date', 'arrival_date', 'flight_number', 'origin_iata', 'destination_iata', 'marketing_airline_id'];
  if (diffs.some((d) => major.includes(d.field))) return 'MAJOR';
  if (diffs.some((d) => d.field === 'status' && d.newValue === 'CANCELLED')) return 'MAJOR';
  const shift = Math.max(
    Math.abs(minutes(after.departure_time) - minutes(before.departure_time)),
    Math.abs(minutes(after.arrival_time) - minutes(before.arrival_time)),
  );
  return shift >= thresholdMinutes ? 'MAJOR' : 'MINOR';
}

// ── Settlement badges & aging (Phase 0 §05-1, §04-9) ───────────────────────
export type CustomerSettlement = 'NOT_CHARGED' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'CREDIT';

export function settlementStatus(chargedMinor: number, balanceMinor: number): CustomerSettlement {
  if (balanceMinor < 0) return 'CREDIT';
  if (chargedMinor <= 0 && balanceMinor === 0) return 'NOT_CHARGED';
  if (balanceMinor === 0) return 'PAID';
  if (balanceMinor >= chargedMinor) return 'UNPAID';
  return 'PARTIALLY_PAID';
}

export const DEFAULT_AGING_BUCKETS = [0, 7, 30, 60] as const;
export type AgingBucket = 'CURRENT' | 'D1_7' | 'D8_30' | 'D31_60' | 'D60_PLUS';

export function daysBetween(from: string, to: string): number {
  assertIsoDate(from, 'from');
  assertIsoDate(to, 'to');
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${assertIsoDate(date)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Age of an open item as of a date, measured from its due date. */
export function agingBucket(dueDate: string, asOf: string): AgingBucket {
  const overdue = daysBetween(dueDate, asOf);
  if (overdue <= 0) return 'CURRENT';
  if (overdue <= 7) return 'D1_7';
  if (overdue <= 30) return 'D8_30';
  if (overdue <= 60) return 'D31_60';
  return 'D60_PLUS';
}

export function assertAllocationWithin(openMinor: number, allocMinor: number, label: string): void {
  if (allocMinor > openMinor) {
    throw new DomainError(ErrorCode.VALIDATION, `The amount exceeds what is open on ${label}`, { reason: 'OVER_ALLOCATION', openMinor, allocMinor });
  }
}
