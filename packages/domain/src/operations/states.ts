import { DomainError, ErrorCode } from '../errors';

/**
 * Operational state machines (Phase 0 §05). Pure, table-driven: a transition is
 * either in the table or rejected. Financial statuses such as "paid" are NOT
 * stored — they are derived from the journal (see settlement.ts).
 *
 * These statuses describe the office's RECORD of an airline transaction that
 * was made outside AirDesk (AirDesk never books or issues with an airline):
 * DRAFT = being entered; RESERVED = an external reservation exists but is not
 * ticketed yet; ISSUED = the externally issued ticket is recorded and the sale
 * and purchase are posted. "Refund pending / partially refunded / refunded / closed"
 * are derived from the cancellation workflow and ticket statuses, never stored
 * as booking statuses (so they cannot contradict the documents).
 */
export const BOOKING_STATUSES = ['DRAFT', 'RESERVED', 'ISSUED', 'PARTIALLY_CANCELLED', 'CANCELLED', 'VOIDED', 'DISCARDED'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_EVENTS = ['RESERVE', 'RELEASE', 'ISSUE', 'DISCARD', 'CANCEL_PARTIAL', 'CANCEL_ALL', 'VOID_ALL'] as const;
export type BookingEvent = (typeof BOOKING_EVENTS)[number];

const BOOKING_TABLE: Readonly<Record<BookingStatus, Partial<Record<BookingEvent, BookingStatus>>>> = {
  DRAFT: { RESERVE: 'RESERVED', ISSUE: 'ISSUED', DISCARD: 'DISCARDED' },
  RESERVED: { RELEASE: 'DRAFT', ISSUE: 'ISSUED', DISCARD: 'DISCARDED' },
  ISSUED: { CANCEL_PARTIAL: 'PARTIALLY_CANCELLED', CANCEL_ALL: 'CANCELLED', VOID_ALL: 'VOIDED' },
  PARTIALLY_CANCELLED: { CANCEL_PARTIAL: 'PARTIALLY_CANCELLED', CANCEL_ALL: 'CANCELLED' },
  CANCELLED: {},
  VOIDED: {},
  DISCARDED: {},
};

export function bookingTransition(from: BookingStatus, event: BookingEvent): BookingStatus {
  const to = BOOKING_TABLE[from]?.[event];
  if (!to) {
    throw new DomainError(ErrorCode.CONFLICT, `Cannot ${event.toLowerCase()} a ${from.toLowerCase()} booking`, {
      reason: 'INVALID_TRANSITION', from, event,
    });
  }
  return to;
}

export function canBookingTransition(from: BookingStatus, event: BookingEvent): boolean {
  return !!BOOKING_TABLE[from]?.[event];
}

/** Before issue everything is editable; after issue only non-financial fields (money moves via documents). */
export function isPreIssue(status: BookingStatus): boolean {
  return status === 'DRAFT' || status === 'RESERVED';
}

/** Issued-or-later bookings whose tickets are (partly) live. */
export function isTicketed(status: BookingStatus): boolean {
  return status === 'ISSUED' || status === 'PARTIALLY_CANCELLED';
}

export function assertPreIssue(status: BookingStatus, what = 'This change'): void {
  if (!isPreIssue(status)) {
    throw new DomainError(ErrorCode.CONFLICT, `${what} is only possible before the booking is issued`, { reason: 'BOOKING_ISSUED', status });
  }
}

export function assertNotClosed(status: BookingStatus): void {
  if (status === 'DISCARDED' || status === 'VOIDED' || status === 'CANCELLED') {
    throw new DomainError(ErrorCode.CONFLICT, 'This booking is closed', { reason: 'BOOKING_CLOSED', status });
  }
}

// ── Tickets ────────────────────────────────────────────────────────────────
export const TICKET_STATUSES = ['ISSUED', 'VOIDED', 'EXCHANGED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'USED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketEvent = 'VOID' | 'EXCHANGE' | 'REFUND_PARTIAL' | 'REFUND_FULL' | 'MARK_USED';

const TICKET_TABLE: Readonly<Record<TicketStatus, Partial<Record<TicketEvent, TicketStatus>>>> = {
  ISSUED: { VOID: 'VOIDED', EXCHANGE: 'EXCHANGED', REFUND_PARTIAL: 'PARTIALLY_REFUNDED', REFUND_FULL: 'REFUNDED', MARK_USED: 'USED' },
  PARTIALLY_REFUNDED: { REFUND_PARTIAL: 'PARTIALLY_REFUNDED', REFUND_FULL: 'REFUNDED' },
  VOIDED: {},
  EXCHANGED: {},
  REFUNDED: {},
  USED: {},
};

export function ticketTransition(from: TicketStatus, event: TicketEvent): TicketStatus {
  const to = TICKET_TABLE[from]?.[event];
  if (!to) throw new DomainError(ErrorCode.CONFLICT, `Ticket in status ${from} cannot ${event}`, { reason: 'INVALID_TRANSITION', from, event });
  return to;
}

/** A ticket that no longer carries a live sale. */
export function isTicketClosed(status: TicketStatus): boolean {
  return status === 'VOIDED' || status === 'REFUNDED' || status === 'EXCHANGED';
}

// ── Cancellation / refund request (two independent sides) ─────────────────
export type SupplierSide = 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'REJECTED' | 'NOT_APPLICABLE';
export type CustomerSide = 'PENDING' | 'CREDITED' | 'NOT_APPLICABLE';
export type RequestOverall = 'OPEN' | 'CLOSED' | 'WITHDRAWN';
export type CancelType = 'VOID' | 'REFUND' | 'NON_REFUNDABLE';

const SUPPLIER_SIDE: Readonly<Record<SupplierSide, readonly SupplierSide[]>> = {
  PENDING: ['SUBMITTED', 'CONFIRMED', 'NOT_APPLICABLE'],
  SUBMITTED: ['CONFIRMED', 'REJECTED'],
  CONFIRMED: [],
  REJECTED: [],
  NOT_APPLICABLE: [],
};

export function supplierSideTransition(from: SupplierSide, to: SupplierSide): SupplierSide {
  if (!SUPPLIER_SIDE[from].includes(to)) {
    throw new DomainError(ErrorCode.CONFLICT, `Supplier side cannot move from ${from} to ${to}`, { reason: 'INVALID_TRANSITION', from, to });
  }
  return to;
}

export function customerSideTransition(from: CustomerSide, to: CustomerSide): CustomerSide {
  if (from !== 'PENDING' || to === 'PENDING') {
    throw new DomainError(ErrorCode.CONFLICT, `Customer side cannot move from ${from} to ${to}`, { reason: 'INVALID_TRANSITION', from, to });
  }
  return to;
}

export const isSupplierSideTerminal = (s: SupplierSide) => s === 'CONFIRMED' || s === 'REJECTED' || s === 'NOT_APPLICABLE';
export const isCustomerSideTerminal = (s: CustomerSide) => s !== 'PENDING';

export function requestOverall(supplier: SupplierSide, customer: CustomerSide, withdrawn = false): RequestOverall {
  if (withdrawn) return 'WITHDRAWN';
  return isSupplierSideTerminal(supplier) && isCustomerSideTerminal(customer) ? 'CLOSED' : 'OPEN';
}

/** Withdrawal is only possible while nothing has been posted on either side. */
export function assertWithdrawable(supplier: SupplierSide, customer: CustomerSide): void {
  if (!['PENDING', 'SUBMITTED'].includes(supplier) || customer !== 'PENDING') {
    throw new DomainError(ErrorCode.CONFLICT, 'The request already has posted results and cannot be withdrawn', { reason: 'NOT_WITHDRAWABLE' });
  }
}

// ── Schedule-change notification ───────────────────────────────────────────
export const NOTIFICATION_STATUSES = ['NOT_NOTIFIED', 'CUSTOMER_NOTIFIED', 'NOTIFICATION_FAILED', 'MANUALLY_CONFIRMED'] as const;
export type ChangeNotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

const CHANGE_TABLE: Readonly<Record<ChangeNotificationStatus, readonly ChangeNotificationStatus[]>> = {
  NOT_NOTIFIED: ['CUSTOMER_NOTIFIED', 'NOTIFICATION_FAILED', 'MANUALLY_CONFIRMED'],
  NOTIFICATION_FAILED: ['CUSTOMER_NOTIFIED', 'MANUALLY_CONFIRMED', 'NOTIFICATION_FAILED'],
  CUSTOMER_NOTIFIED: ['MANUALLY_CONFIRMED'],
  MANUALLY_CONFIRMED: [],
};

export function changeNotificationTransition(from: ChangeNotificationStatus, to: ChangeNotificationStatus): ChangeNotificationStatus {
  if (!CHANGE_TABLE[from].includes(to)) {
    throw new DomainError(ErrorCode.CONFLICT, `Notification status cannot move from ${from} to ${to}`, { reason: 'INVALID_TRANSITION', from, to });
  }
  return to;
}

export function requiresAttention(status: ChangeNotificationStatus, superseded: boolean): boolean {
  return !superseded && (status === 'NOT_NOTIFIED' || status === 'NOTIFICATION_FAILED');
}
