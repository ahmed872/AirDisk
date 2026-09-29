import {
  DomainError,
  ErrorCode,
  assertAllocationWithin,
  assertWithdrawable,
  customerSideTransition,
  fieldError,
  isSupplierSideTerminal,
  optionalText,
  parseRate,
  requestOverall,
  requiredText,
  supplierSideTransition,
  type CancelType,
  type CustomerSide,
  type DocumentLineDraft,
  type PaymentMethod,
  type SupplierSide,
  type TransferKind,
} from '@airdesk/domain';
import type { CancellationDto, DocumentDto } from '@airdesk/contracts';
import type { BookingService } from './booking-service';
import type { CompanyService } from './company-service';
import { actorOf, hasAny, requirePermission, tx, type Actor, type ServiceDeps } from './context';
import type { CurrencyService } from './currency-service';
import { documentSide, readDocuments } from './document-reader';
import { nextSequenceNumber } from './masterdata-support';
import type { PostingService } from './posting-service';
import type { ReferenceService } from './reference-service';

export interface PaymentInput {
  partyId: string;
  date?: string | null;
  currency: string;
  amountMinor: number;
  moneyAccountId: string;
  paymentMethod: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
  exchangeRate?: string | null;
  /** Booking allocations; any remainder must be explicitly routed on-account. */
  allocations: { bookingId: string; amountMinor: number }[];
  onAccountMinor?: number;
}

interface CancellationRow {
  id: string; request_no: string; booking_id: string; cancel_type: CancelType; scope: 'FULL' | 'PARTIAL'; overall_status: 'OPEN' | 'CLOSED' | 'WITHDRAWN';
  supplier_status: SupplierSide; customer_status: CustomerSide; row_version: number;
}

const CANCELLABLE_DOCS = ['CUSTOMER_RECEIPT', 'CUSTOMER_REFUND', 'SUPPLIER_PAYMENT', 'SUPPLIER_REFUND', 'EXPENSE', 'MONEY_TRANSFER', 'BALANCE_APPLICATION', 'OPENING_BALANCE'];

export interface OpeningBalanceInput {
  target: 'CUSTOMER' | 'SUPPLIER' | 'MONEY_ACCOUNT';
  targetId: string;
  /** OWED_TO_OFFICE: the customer/supplier owes the office, or cash held; OWED_BY_OFFICE: the office owes them. */
  side: 'OWED_TO_OFFICE' | 'OWED_BY_OFFICE';
  currency: string;
  amountMinor: number;
  date?: string | null;
  exchangeRate?: string | null;
  notes?: string | null;
}

export interface TransferInput {
  kind: TransferKind;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  amountMinor: number;
  date?: string | null;
  exchangeRate?: string | null;
  reference?: string | null;
  notes?: string | null;
}

export interface ApplyBalanceInput {
  party: 'CUSTOMER' | 'SUPPLIER';
  partyId: string;
  currency: string;
  /** Where the credit sits: null = on account, otherwise a record that is in credit. */
  fromBookingId?: string | null;
  allocations: { bookingId: string; amountMinor: number }[];
  date?: string | null;
  notes?: string | null;
}

/**
 * Money workflows (owner requirements §11–§18, §24): customer receipts, supplier
 * payments, cash refunds, expenses and the cancellation/refund workflow. Every
 * operation posts immutable documents through the PostingService; balances,
 * "paid", "remaining" and profit are always derived from the journal.
 */
export class FinanceService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly company: CompanyService,
    private readonly currencies: CurrencyService,
    private readonly posting: PostingService,
    private readonly bookings: BookingService,
    private readonly reference: ReferenceService,
  ) {}

  // ── Customer receipts & refunds ─────────────────────────────────────────
  receiveCustomerPayment(actor: Actor, input: PaymentInput): DocumentDto {
    requirePermission(this.deps, actor, 'payment.customer.receive', 'payments.receive');
    const date = input.date ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    const onAccount = this.checkSplit(input);
    // Paying an on-account debt (e.g. an opening balance) is not an overpayment; only the excess is.
    if (onAccount > this.onAccountDue('CUSTOMER', input.partyId, input.currency)) requirePermission(this.deps, actor, 'payment.accept_overpayment', 'payments.receive.onAccount');
    const rate = this.docRate(actor, input.currency, date, input.exchangeRate);
    const id = tx(this.deps, () => {
      const customer = this.party('customer', input.partyId);
      this.assertAccount(input.moneyAccountId, input.currency);
      const lines: DocumentLineDraft[] = [];
      for (const a of input.allocations) {
        const b = this.bookings.accessible(actor, a.bookingId);
        if (b.customer_id !== customer) throw fieldError('allocations', 'WRONG_PARTY', 'The booking belongs to another customer');
        if (b.status === 'DISCARDED' || b.status === 'VOIDED') throw fieldError('allocations', 'BOOKING_CLOSED', 'The booking is closed');
        const open = this.openItem('1200', 'customer_id', customer, a.bookingId, input.currency);
        // Deposits on bookings not yet issued (BR-PAY-03) are limited by the quoted total.
        const limit = b.status === 'DRAFT' || b.status === 'RESERVED' ? this.quoteOpen(a.bookingId, input.currency, open.txn) : open.txn;
        assertAllocationWithin(limit, a.amountMinor, b.booking_no);
        lines.push({ lineType: 'SETTLEMENT', amountMinor: a.amountMinor, bookingId: a.bookingId, ...this.carrying(open, a.amountMinor, input.currency) });
      }
      lines.push(...this.onAccountLines('1200', 'customer_id', customer, input.currency, onAccount, 1));
      const doc = this.posting.post(actor, {
        docType: 'CUSTOMER_RECEIPT', docDate: date, customerId: customer, bookingId: input.allocations.length === 1 ? input.allocations[0]!.bookingId : null,
        currency: input.currency, exchangeRate: rate, moneyAccountId: input.moneyAccountId, paymentMethod: input.paymentMethod,
        paymentReference: optionalText(input.reference, 'reference', 60), description: optionalText(input.notes, 'notes', 500), lines,
      });
      this.deps.audit.append(actorOf(actor), {
        action: 'payment.customer_received', entityType: 'fin_document', entityId: doc.id,
        metadata: { docNo: doc.docNo, amountMinor: input.amountMinor, currency: input.currency, allocations: input.allocations.length, onAccountMinor: onAccount },
      });
      for (const a of input.allocations) this.bookings.reindex(a.bookingId);
      return doc.id;
    });
    return this.document(actor, id);
  }

  /** Cash back to a customer, limited to what we owe them on the booking / on account (BR-REF-02). */
  refundCustomer(actor: Actor, input: PaymentInput): DocumentDto {
    requirePermission(this.deps, actor, 'payment.customer.refund', 'payments.refundCustomer');
    const date = input.date ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    const onAccount = this.checkSplit(input);
    const rate = this.docRate(actor, input.currency, date, input.exchangeRate);
    const id = tx(this.deps, () => {
      const customer = this.party('customer', input.partyId);
      this.assertAccount(input.moneyAccountId, input.currency);
      const lines: DocumentLineDraft[] = [];
      for (const a of input.allocations) {
        const b = this.bookings.accessible(actor, a.bookingId);
        if (b.customer_id !== customer) throw fieldError('allocations', 'WRONG_PARTY', 'The booking belongs to another customer');
        const open = this.openItem('1200', 'customer_id', customer, a.bookingId, input.currency);
        assertAllocationWithin(Math.max(0, -open.txn), a.amountMinor, b.booking_no);
        lines.push({ lineType: 'SETTLEMENT', amountMinor: a.amountMinor, bookingId: a.bookingId, ...this.carrying({ txn: -open.txn, base: -open.base }, a.amountMinor, input.currency) });
      }
      if (onAccount > 0) {
        const open = this.openItem('1200', 'customer_id', customer, null, input.currency);
        assertAllocationWithin(Math.max(0, -open.txn), onAccount, 'on-account credit');
        lines.push({ lineType: 'SETTLEMENT', amountMinor: onAccount, bookingId: null, ...this.carrying({ txn: -open.txn, base: -open.base }, onAccount, input.currency) });
      }
      const doc = this.posting.post(actor, {
        docType: 'CUSTOMER_REFUND', docDate: date, customerId: customer, bookingId: input.allocations.length === 1 ? input.allocations[0]!.bookingId : null,
        currency: input.currency, exchangeRate: rate, moneyAccountId: input.moneyAccountId, paymentMethod: input.paymentMethod,
        paymentReference: optionalText(input.reference, 'reference', 60), description: optionalText(input.notes, 'notes', 500), lines,
      });
      this.deps.audit.append(actorOf(actor), { action: 'payment.customer_refunded', entityType: 'fin_document', entityId: doc.id, metadata: { docNo: doc.docNo, amountMinor: input.amountMinor, currency: input.currency } });
      return doc.id;
    });
    return this.document(actor, id);
  }

  // ── Supplier payments & refunds ─────────────────────────────────────────
  paySupplier(actor: Actor, input: PaymentInput): DocumentDto {
    requirePermission(this.deps, actor, 'payment.supplier.pay', 'payments.paySupplier');
    const date = input.date ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    const onAccount = this.checkSplit(input);
    if (onAccount > this.onAccountDue('SUPPLIER', input.partyId, input.currency)) requirePermission(this.deps, actor, 'payment.accept_overpayment', 'payments.paySupplier.onAccount');
    const rate = this.docRate(actor, input.currency, date, input.exchangeRate);
    const id = tx(this.deps, () => {
      const supplier = this.party('supplier', input.partyId);
      this.assertAccount(input.moneyAccountId, input.currency);
      const lines: DocumentLineDraft[] = [];
      for (const a of input.allocations) {
        const open = this.openItem('2100', 'supplier_id', supplier, a.bookingId, input.currency, -1);
        assertAllocationWithin(Math.max(0, open.txn), a.amountMinor, this.bookingNo(a.bookingId));
        lines.push({ lineType: 'SETTLEMENT', amountMinor: a.amountMinor, bookingId: a.bookingId, ...this.carrying(open, a.amountMinor, input.currency) });
      }
      lines.push(...this.onAccountLines('2100', 'supplier_id', supplier, input.currency, onAccount, -1));
      const doc = this.posting.post(actor, {
        docType: 'SUPPLIER_PAYMENT', docDate: date, supplierId: supplier, bookingId: input.allocations.length === 1 ? input.allocations[0]!.bookingId : null,
        currency: input.currency, exchangeRate: rate, moneyAccountId: input.moneyAccountId, paymentMethod: input.paymentMethod,
        paymentReference: optionalText(input.reference, 'reference', 60), description: optionalText(input.notes, 'notes', 500), lines,
      });
      this.deps.audit.append(actorOf(actor), { action: 'payment.supplier_paid', entityType: 'fin_document', entityId: doc.id, metadata: { docNo: doc.docNo, amountMinor: input.amountMinor, currency: input.currency } });
      return doc.id;
    });
    return this.document(actor, id);
  }

  /** Money received back from a supplier, limited to the supplier's credit (they owe us). */
  recordSupplierRefund(actor: Actor, input: PaymentInput): DocumentDto {
    requirePermission(this.deps, actor, 'payment.supplier.record_refund', 'payments.supplierRefund');
    const date = input.date ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    const onAccount = this.checkSplit(input);
    const rate = this.docRate(actor, input.currency, date, input.exchangeRate);
    const id = tx(this.deps, () => {
      const supplier = this.party('supplier', input.partyId);
      this.assertAccount(input.moneyAccountId, input.currency);
      const lines: DocumentLineDraft[] = [];
      const add = (bookingId: string | null, amount: number, label: string) => {
        const open = this.openItem('2100', 'supplier_id', supplier, bookingId, input.currency, -1);
        assertAllocationWithin(Math.max(0, -open.txn), amount, label);
        lines.push({ lineType: 'SETTLEMENT', amountMinor: amount, bookingId, ...this.carrying({ txn: -open.txn, base: -open.base }, amount, input.currency) });
      };
      for (const a of input.allocations) add(a.bookingId, a.amountMinor, this.bookingNo(a.bookingId));
      if (onAccount > 0) add(null, onAccount, 'on-account credit');
      const doc = this.posting.post(actor, {
        docType: 'SUPPLIER_REFUND', docDate: date, supplierId: supplier, bookingId: input.allocations.length === 1 ? input.allocations[0]!.bookingId : null,
        currency: input.currency, exchangeRate: rate, moneyAccountId: input.moneyAccountId, paymentMethod: input.paymentMethod,
        paymentReference: optionalText(input.reference, 'reference', 60), description: optionalText(input.notes, 'notes', 500), lines,
      });
      this.deps.audit.append(actorOf(actor), { action: 'payment.supplier_refund_received', entityType: 'fin_document', entityId: doc.id, metadata: { docNo: doc.docNo, amountMinor: input.amountMinor, currency: input.currency } });
      return doc.id;
    });
    return this.document(actor, id);
  }

  // ── Expenses ────────────────────────────────────────────────────────────
  recordExpense(actor: Actor, input: { categoryId: string; date?: string | null; currency: string; amountMinor: number; moneyAccountId: string; paymentMethod: PaymentMethod; reference?: string | null; description: string; exchangeRate?: string | null }): DocumentDto {
    requirePermission(this.deps, actor, 'expense.create', 'expenses.create');
    const date = input.date ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    const rate = this.docRate(actor, input.currency, date, input.exchangeRate);
    const description = requiredText(input.description, 'description', 500);
    const id = tx(this.deps, () => {
      this.assertAccount(input.moneyAccountId, input.currency);
      const doc = this.posting.post(actor, {
        docType: 'EXPENSE', docDate: date, currency: input.currency, exchangeRate: rate, moneyAccountId: input.moneyAccountId, paymentMethod: input.paymentMethod,
        paymentReference: optionalText(input.reference, 'reference', 60), description,
        lines: [{ lineType: 'EXPENSE', amountMinor: input.amountMinor, expenseCategoryId: input.categoryId, description }],
      });
      this.deps.audit.append(actorOf(actor), { action: 'expense.recorded', entityType: 'fin_document', entityId: doc.id, metadata: { docNo: doc.docNo, categoryId: input.categoryId, amountMinor: input.amountMinor, currency: input.currency } });
      return doc.id;
    });
    return this.document(actor, id);
  }

  /**
   * Cancels a payment, refund or expense by posting its mirror reversal (the
   * original is never edited). Invoices and bills are corrected with
   * adjustments or the cancellation workflow instead.
   */
  cancelDocument(actor: Actor, documentId: string, reason: string, date?: string | null): DocumentDto {
    const original = this.deps.db.prepare('SELECT doc_type, booking_id, reason_code FROM fin_document WHERE id = ?').get(documentId) as { doc_type: string; booking_id: string | null; reason_code: string | null } | undefined;
    if (!original) throw new DomainError(ErrorCode.NOT_FOUND, 'Document not found');
    this.document(actor, documentId);
    if (original.doc_type === 'MONEY_TRANSFER' && original.reason_code !== 'ACCOUNT_TRANSFER') requirePermission(this.deps, actor, 'treasury.owner_movements', 'documents.cancel.ownerMovement');
    if (!CANCELLABLE_DOCS.includes(original.doc_type)) {
      throw new DomainError(ErrorCode.VALIDATION, 'Invoices and bills are corrected with adjustments or a cancellation, not by cancelling the document', { reason: 'NOT_CANCELLABLE' });
    }
    if (original.booking_id) this.bookings.accessible(actor, original.booking_id);
    const reversal = this.posting.reverse(actor, { documentId, reversalDate: date ?? this.company.today(), reason: requiredText(reason, 'reason', 500) });
    return this.document(actor, reversal.id);
  }

  document(actor: Actor, id: string): DocumentDto {
    const d = readDocuments(this.deps.db, 'd.id = ?', [id])[0];
    if (!d) throw new DomainError(ErrorCode.NOT_FOUND, 'Document not found');
    this.assertCanSeeDocument(actor, d);
    return d;
  }

  assertCanSeeDocument(actor: Actor, d: DocumentDto): void {
    const side = documentSide(d);
    const needed = side === 'SUPPLIER' ? ['booking.view_cost', 'supplier.view_financial', 'payment.supplier.pay']
      : side === 'EXPENSE' ? ['expense.view', 'expense.create']
        : side === 'TREASURY' ? ['treasury.view', 'treasury.transfer', 'finance.opening_balances']
          : ['booking.view', 'payment.customer.receive', 'report.statements'];
    if (!hasAny(actor, needed)) throw new DomainError(ErrorCode.NOT_FOUND, 'Document not found');
    if (side === 'CUSTOMER') for (const b of new Set([d.bookingId, ...d.lines.map((l) => l.bookingId)])) if (b) this.bookings.accessible(actor, b);
  }

  // ── Opening balances (Phase 0 §04 P12) ─────────────────────────────────
  /** Go-live balance of a customer, supplier or money account, held on account against opening-balance equity. */
  recordOpeningBalance(actor: Actor, input: OpeningBalanceInput): DocumentDto {
    requirePermission(this.deps, actor, 'finance.opening_balances', 'openingBalances.record');
    const date = input.date ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    this.assertAmount(input.amountMinor);
    if (input.target === 'MONEY_ACCOUNT' && input.side !== 'OWED_TO_OFFICE') throw fieldError('side', 'NEGATIVE_CASH', 'A money account opens with the cash it holds');
    const rate = this.docRate(actor, input.currency, date, input.exchangeRate);
    const id = tx(this.deps, () => {
      const target = input.target === 'CUSTOMER' ? { customerId: this.party('customer', input.targetId) }
        : input.target === 'SUPPLIER' ? { supplierId: this.party('supplier', input.targetId) }
          : (this.assertAccount(input.targetId, input.currency), { moneyAccountId: input.targetId });
      const doc = this.posting.post(actor, {
        docType: 'OPENING_BALANCE', docDate: date, currency: input.currency, exchangeRate: rate, ...target,
        reasonCode: input.side === 'OWED_TO_OFFICE' ? 'OPENING_DEBIT' : 'OPENING_CREDIT', description: optionalText(input.notes, 'notes', 500),
        lines: [{ lineType: 'OPENING', amountMinor: input.amountMinor }],
      });
      this.deps.audit.append(actorOf(actor), {
        action: 'finance.opening_balance_recorded', entityType: 'fin_document', entityId: doc.id,
        metadata: { docNo: doc.docNo, target: input.target, targetId: input.targetId, side: input.side, amountMinor: input.amountMinor, currency: input.currency },
      });
      return doc.id;
    });
    return this.document(actor, id);
  }

  listOpeningBalances(actor: Actor): DocumentDto[] {
    requirePermission(this.deps, actor, 'finance.opening_balances', 'openingBalances.list');
    return readDocuments(this.deps.db, "d.doc_type = 'OPENING_BALANCE'", [], { withLines: false }).reverse();
  }

  // ── Treasury transfers, owner capital and drawings (Phase 0 §04 P10) ───
  transferMoney(actor: Actor, input: TransferInput): DocumentDto {
    requirePermission(this.deps, actor, 'treasury.transfer', 'treasury.transfer');
    if (input.kind !== 'ACCOUNT_TRANSFER') requirePermission(this.deps, actor, 'treasury.owner_movements', 'treasury.ownerMovement');
    const date = input.date ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    this.assertAmount(input.amountMinor);
    const source = input.kind === 'OWNER_CAPITAL' ? null : input.fromAccountId ?? null;
    const dest = input.kind === 'OWNER_DRAWING' ? null : input.toAccountId ?? null;
    if (input.kind !== 'OWNER_CAPITAL' && !source) throw fieldError('fromAccountId', 'REQUIRED', 'Choose the account the money leaves');
    if (input.kind !== 'OWNER_DRAWING' && !dest) throw fieldError('toAccountId', 'REQUIRED', 'Choose the account the money goes to');
    if (source && dest && source === dest) throw fieldError('toAccountId', 'SAME_ACCOUNT', 'Choose two different accounts');
    const currency = this.reference.moneyAccount((source ?? dest)!).currency_code;
    const rate = this.docRate(actor, currency, date, input.exchangeRate);
    const id = tx(this.deps, () => {
      if (source) this.assertAccount(source, currency);
      if (dest) {
        const a = this.reference.moneyAccount(dest);
        if (a.currency_code !== currency) throw fieldError('toAccountId', 'CURRENCY_MISMATCH', `Both accounts must hold ${currency}`);
        this.assertAccount(dest, currency);
      }
      let carrying = {};
      if (source) {
        const held = this.accountBalance(source, currency);
        if (held.txn < input.amountMinor) throw new DomainError(ErrorCode.VALIDATION, 'The account does not hold that much', { field: 'amountMinor', reason: 'INSUFFICIENT_FUNDS', availableMinor: held.txn });
        carrying = this.carrying(held, input.amountMinor, currency);
      }
      const doc = this.posting.post(actor, {
        docType: 'MONEY_TRANSFER', docDate: date, currency, exchangeRate: rate, reasonCode: input.kind,
        moneyAccountId: (source ?? dest)!, counterMoneyAccountId: source && dest ? dest : null,
        paymentReference: optionalText(input.reference, 'reference', 60), description: optionalText(input.notes, 'notes', 500),
        lines: [{ lineType: 'TRANSFER', amountMinor: input.amountMinor, ...carrying }],
      });
      this.deps.audit.append(actorOf(actor), {
        action: 'treasury.transferred', entityType: 'fin_document', entityId: doc.id,
        metadata: { docNo: doc.docNo, kind: input.kind, fromAccountId: source, toAccountId: dest, amountMinor: input.amountMinor, currency },
      });
      return doc.id;
    });
    return this.document(actor, id);
  }

  listTransfers(actor: Actor, from: string, to: string): DocumentDto[] {
    requirePermission(this.deps, actor, ['treasury.view', 'treasury.transfer'], 'treasury.transfers');
    return readDocuments(this.deps.db, "d.doc_type = 'MONEY_TRANSFER' AND d.doc_date BETWEEN ? AND ?", [from, to], { withLines: false }).reverse();
  }

  // ── Applying credits (Phase 0 §04 P11) ─────────────────────────────────
  /**
   * Uses a party's credit (on account, or on a record in credit) to settle
   * other records of the same party. No cash moves and profit is unchanged.
   */
  applyBalance(actor: Actor, input: ApplyBalanceInput): DocumentDto {
    requirePermission(this.deps, actor, 'balance.apply', 'balances.apply');
    if (input.party === 'SUPPLIER') requirePermission(this.deps, actor, ['supplier.view_financial', 'payment.supplier.pay'], 'balances.apply.supplier');
    const date = input.date ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    if (input.allocations.length === 0) throw fieldError('allocations', 'REQUIRED', 'Choose at least one record');
    for (const a of input.allocations) this.assertAmount(a.amountMinor, 'allocations');
    if (new Set(input.allocations.map((a) => a.bookingId)).size !== input.allocations.length) throw fieldError('allocations', 'DUPLICATE_BOOKING', 'Each record once');
    const from = input.fromBookingId ?? null;
    if (from && input.allocations.some((a) => a.bookingId === from)) throw fieldError('allocations', 'SAME_RECORD', 'A credit cannot be applied to its own record');
    const rate = this.docRate(actor, input.currency, date, null);
    const customer = input.party === 'CUSTOMER';
    const account = customer ? '1200' : '2100';
    const col = customer ? 'customer_id' : 'supplier_id';
    const sign = customer ? 1 : -1;
    const id = tx(this.deps, () => {
      const partyId = this.party(customer ? 'customer' : 'supplier', input.partyId);
      const recordOf = (bookingId: string) => {
        if (!customer) return { no: this.bookingNo(bookingId), status: null };
        const b = this.bookings.accessible(actor, bookingId);
        if (b.customer_id !== partyId) throw fieldError('allocations', 'WRONG_PARTY', 'The record belongs to another customer');
        return { no: b.booking_no, status: b.status };
      };
      if (from) recordOf(from);
      const src = this.openItem(account, col, partyId, from, input.currency, sign);
      const available = Math.max(0, -src.txn);
      assertAllocationWithin(available, input.allocations.reduce((s, a) => s + a.amountMinor, 0), from ? this.bookingNo(from) : 'on-account credit');
      const lines: DocumentLineDraft[] = input.allocations.map((a) => {
        const r = recordOf(a.bookingId);
        if (r.status === 'DISCARDED' || r.status === 'VOIDED') throw fieldError('allocations', 'BOOKING_CLOSED', 'The record is closed');
        const open = this.openItem(account, col, partyId, a.bookingId, input.currency, sign);
        const limit = r.status === 'DRAFT' || r.status === 'RESERVED' ? this.quoteOpen(a.bookingId, input.currency, open.txn) : Math.max(0, open.txn);
        assertAllocationWithin(limit, a.amountMinor, r.no);
        const target = this.carrying(open, a.amountMinor, input.currency).carryingBaseMinor;
        const source = this.carrying({ txn: -src.txn, base: -src.base }, a.amountMinor, input.currency).carryingBaseMinor;
        return {
          lineType: 'APPLICATION', amountMinor: a.amountMinor, bookingId: a.bookingId,
          ...(target !== undefined ? { carryingBaseMinor: target } : {}), ...(source !== undefined ? { sourceCarryingBaseMinor: source } : {}),
        };
      });
      const doc = this.posting.post(actor, {
        docType: 'BALANCE_APPLICATION', docDate: date, currency: input.currency, exchangeRate: rate,
        ...(customer ? { customerId: partyId } : { supplierId: partyId }), bookingId: from, description: optionalText(input.notes, 'notes', 500), lines,
      });
      this.deps.audit.append(actorOf(actor), {
        action: 'balance.applied', entityType: 'fin_document', entityId: doc.id,
        metadata: { docNo: doc.docNo, party: input.party, partyId, fromBookingId: from, allocations: input.allocations.length, amountMinor: doc.totalMinor, currency: input.currency },
      });
      for (const b of [from, ...input.allocations.map((a) => a.bookingId)]) if (b) this.bookings.reindex(b);
      return doc.id;
    });
    return this.document(actor, id);
  }

  // ── Cancellation / refund workflow (Phase 0 §05-4) ─────────────────────
  requestCancellation(actor: Actor, input: { bookingId: string; cancelType: CancelType; ticketIds?: string[] | null; reason: string; expectedSupplierRefundMinor?: number | null; expectedCurrency?: string | null; notes?: string | null }): CancellationDto {
    requirePermission(this.deps, actor, 'refund.request', 'cancellations.request');
    const id = tx(this.deps, () => {
      const b = this.bookings.accessible(actor, input.bookingId);
      if (b.status !== 'ISSUED' && b.status !== 'PARTIALLY_CANCELLED') throw new DomainError(ErrorCode.CONFLICT, 'Only issued bookings can be cancelled', { reason: 'NOT_ISSUED' });
      const live = this.deps.db.prepare(`SELECT id FROM ticket WHERE booking_id = ? AND status IN ('ISSUED','PARTIALLY_REFUNDED')
                                         AND id NOT IN (SELECT ci.ticket_id FROM cancellation_item ci JOIN cancellation_request cr ON cr.id = ci.cancellation_request_id
                                                        WHERE cr.overall_status <> 'WITHDRAWN' AND ci.ticket_id IS NOT NULL)`).all(b.id) as { id: string }[];
      const liveIds = live.map((t) => t.id);
      const tickets = input.ticketIds?.length ? input.ticketIds : liveIds;
      if (!tickets.length) throw new DomainError(ErrorCode.CONFLICT, 'There are no active tickets to cancel', { reason: 'NO_TICKETS' });
      for (const t of tickets) if (!liveIds.includes(t)) throw fieldError('ticketIds', 'TICKET_NOT_CANCELLABLE', 'A selected ticket is already cancelled or in another request');
      if (input.expectedSupplierRefundMinor != null) {
        if (!input.expectedCurrency) throw fieldError('expectedCurrency', 'REQUIRED', 'Currency is required');
        this.currencies.minorUnitOf(input.expectedCurrency);
      }
      const now = this.deps.clock.now().toISOString();
      const reqId = this.deps.newId();
      const no = nextSequenceNumber(this.deps.db, 'CANCELLATION', 'CX');
      const allLive = tickets.length === liveIds.length && (this.deps.db.prepare(`SELECT COUNT(*) AS n FROM ticket WHERE booking_id = ? AND status NOT IN ('VOIDED','REFUNDED','EXCHANGED')`).get(b.id) as { n: number }).n === tickets.length;
      this.deps.db
        .prepare(`INSERT INTO cancellation_request (id, request_no, booking_id, cancel_type, scope, supplier_status, expected_supplier_refund_minor,
                    expected_currency_code, reason, requested_at, requested_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(reqId, no, b.id, input.cancelType, allLive ? 'FULL' : 'PARTIAL', input.cancelType === 'NON_REFUNDABLE' ? 'NOT_APPLICABLE' : 'PENDING',
          input.expectedSupplierRefundMinor ?? null, input.expectedSupplierRefundMinor != null ? input.expectedCurrency : null,
          requiredText(input.reason, 'reason', 500), now, actor.userId, optionalText(input.notes, 'notes', 1000));
      const ins = this.deps.db.prepare('INSERT INTO cancellation_item (id, cancellation_request_id, ticket_id, passenger_id) VALUES (?, ?, ?, (SELECT passenger_id FROM ticket WHERE id = ?))');
      for (const t of tickets) ins.run(this.deps.newId(), reqId, t, t);
      this.deps.audit.append(actorOf(actor), { action: 'cancellation.requested', entityType: 'cancellation_request', entityId: reqId, after: { requestNo: no, bookingId: b.id, cancelType: input.cancelType, tickets: tickets.length, reason: input.reason } });
      return reqId;
    });
    return this.cancellation(actor, id);
  }

  submitToSupplier(actor: Actor, id: string, rowVersion: number): CancellationDto {
    requirePermission(this.deps, actor, 'refund.manage', 'cancellations.submit');
    tx(this.deps, () => {
      const r = this.request(actor, id, rowVersion);
      this.setSides(actor, r, supplierSideTransition(r.supplier_status, 'SUBMITTED'), r.customer_status, 'cancellation.submitted');
    });
    return this.cancellation(actor, id);
  }

  /** Supplier confirms: credit note for returned cost (per ticket) and a bill for any supplier penalty. */
  confirmSupplier(actor: Actor, id: string, input: { rowVersion: number; date?: string | null; lines: { ticketId: string; returnMinor: number; penaltyMinor?: number }[]; externalReference?: string | null }): CancellationDto {
    requirePermission(this.deps, actor, 'refund.manage', 'cancellations.confirmSupplier');
    const date = input.date ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    tx(this.deps, () => {
      const r = this.request(actor, id, input.rowVersion);
      const next = supplierSideTransition(r.supplier_status, 'CONFIRMED');
      const inRequest = this.requestTickets(id);
      const bySupplier = new Map<string, { currency: string; returns: DocumentLineDraft[]; penalties: DocumentLineDraft[] }>();
      for (const l of input.lines) {
        const t = inRequest.find((x) => x.id === l.ticketId);
        if (!t) throw fieldError('lines', 'TICKET_NOT_IN_REQUEST', 'Ticket is not part of this request');
        const cur = this.bookings.costCurrency(t.id) ?? this.company.core().baseCurrency;
        const net = this.bookings.netCost(t.id, t.supplier_id);
        if (l.returnMinor > net) throw new DomainError(ErrorCode.VALIDATION, 'The returned cost exceeds the ticket cost', { reason: 'OVER_ALLOCATION', netMinor: net });
        const g = bySupplier.get(t.supplier_id) ?? { currency: cur, returns: [], penalties: [] };
        const dims = { bookingId: r.booking_id, passengerId: t.passenger_id, ticketId: t.id };
        if (l.returnMinor > 0) g.returns.push({ lineType: 'PURCHASE_RETURN', amountMinor: l.returnMinor, ...dims });
        if ((l.penaltyMinor ?? 0) > 0) g.penalties.push({ lineType: 'SUPPLIER_PENALTY', amountMinor: l.penaltyMinor!, ...dims });
        bySupplier.set(t.supplier_id, g);
      }
      for (const [supplierId, g] of bySupplier) {
        const common = { docDate: date, supplierId, bookingId: r.booking_id, currency: g.currency, exchangeRate: this.bookings.rateForDoc(g.currency, date, null), cancellationRequestId: id, description: r.request_no };
        if (g.returns.length) {
          this.posting.post(actor, { ...common, docType: 'SUPPLIER_CREDIT_NOTE', reasonCode: 'CANCELLATION', lines: g.returns, externalReference: optionalText(input.externalReference, 'externalReference', 60) });
        }
        if (g.penalties.length) this.posting.post(actor, { ...common, docType: 'SUPPLIER_BILL', reasonCode: 'SUPPLIER_PENALTY', lines: g.penalties });
      }
      this.setSides(actor, r, next, r.customer_status, 'cancellation.supplier_confirmed');
    });
    return this.cancellation(actor, id);
  }

  rejectSupplier(actor: Actor, id: string, rowVersion: number, note: string): CancellationDto {
    requirePermission(this.deps, actor, 'refund.manage', 'cancellations.rejectSupplier');
    tx(this.deps, () => {
      const r = this.request(actor, id, rowVersion);
      this.setSides(actor, r, supplierSideTransition(r.supplier_status, 'REJECTED'), r.customer_status, 'cancellation.supplier_rejected', requiredText(note, 'note', 500));
    });
    return this.cancellation(actor, id);
  }

  /** Customer side: credit note for the returned sale (per ticket) and an optional office cancellation fee. */
  creditCustomer(actor: Actor, id: string, input: { rowVersion: number; date?: string | null; lines: { ticketId: string; returnMinor: number }[]; cancellationFeeMinor?: number }): CancellationDto {
    requirePermission(this.deps, actor, 'refund.manage', 'cancellations.creditCustomer');
    const r0 = this.request(actor, id, input.rowVersion);
    // Q6: crediting the customer before the supplier has answered is a separate, sensitive permission.
    if (!isSupplierSideTerminal(r0.supplier_status)) requirePermission(this.deps, actor, 'refund.customer_before_supplier', 'cancellations.creditBeforeSupplier');
    const date = input.date ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    tx(this.deps, () => {
      const r = this.request(actor, id, input.rowVersion);
      const next = customerSideTransition(r.customer_status, 'CREDITED');
      const b = this.bookings.accessible(actor, r.booking_id);
      const inRequest = this.requestTickets(id);
      const lines: DocumentLineDraft[] = [];
      for (const l of input.lines) {
        const t = inRequest.find((x) => x.id === l.ticketId);
        if (!t) throw fieldError('lines', 'TICKET_NOT_IN_REQUEST', 'Ticket is not part of this request');
        const net = this.bookings.netSale(r.booking_id, t.id);
        if (l.returnMinor > net) throw new DomainError(ErrorCode.VALIDATION, 'The returned amount exceeds the ticket sale', { reason: 'OVER_ALLOCATION', netMinor: net });
        if (l.returnMinor > 0) lines.push({ lineType: 'SALE_RETURN', amountMinor: l.returnMinor, bookingId: r.booking_id, passengerId: t.passenger_id, ticketId: t.id });
      }
      const rate = this.bookings.rateForDoc(b.sale_currency_code, date, b.sale_exchange_rate);
      const common = { docDate: date, customerId: b.customer_id, bookingId: b.id, currency: b.sale_currency_code, exchangeRate: rate, cancellationRequestId: id, description: r.request_no };
      if (lines.length) this.posting.post(actor, { ...common, docType: 'CUSTOMER_CREDIT_NOTE', reasonCode: 'CANCELLATION', lines });
      if ((input.cancellationFeeMinor ?? 0) > 0) {
        this.posting.post(actor, { ...common, docType: 'CUSTOMER_INVOICE', reasonCode: 'CANCELLATION_FEE', lines: [{ lineType: 'CANCELLATION_FEE', amountMinor: input.cancellationFeeMinor!, bookingId: b.id }] });
      }
      this.setSides(actor, r, r.supplier_status, next, 'cancellation.customer_credited');
    });
    return this.cancellation(actor, id);
  }

  customerNotApplicable(actor: Actor, id: string, rowVersion: number, note: string): CancellationDto {
    requirePermission(this.deps, actor, 'refund.manage', 'cancellations.customerNotApplicable');
    tx(this.deps, () => {
      const r = this.request(actor, id, rowVersion);
      this.setSides(actor, r, r.supplier_status, customerSideTransition(r.customer_status, 'NOT_APPLICABLE'), 'cancellation.customer_not_applicable', requiredText(note, 'note', 500));
    });
    return this.cancellation(actor, id);
  }

  withdraw(actor: Actor, id: string, rowVersion: number, reason: string): CancellationDto {
    requirePermission(this.deps, actor, ['refund.request', 'refund.manage'], 'cancellations.withdraw');
    tx(this.deps, () => {
      const r = this.request(actor, id, rowVersion);
      if (r.overall_status !== 'OPEN') throw new DomainError(ErrorCode.CONFLICT, 'The request is already closed', { reason: 'NOT_OPEN' });
      assertWithdrawable(r.supplier_status, r.customer_status);
      this.deps.db.prepare(`UPDATE cancellation_request SET overall_status = 'WITHDRAWN', closed_at = ?, notes = COALESCE(notes || char(10), '') || ?, row_version = row_version + 1 WHERE id = ?`)
        .run(this.deps.clock.now().toISOString(), requiredText(reason, 'reason', 500), id);
      this.deps.audit.append(actorOf(actor), { action: 'cancellation.withdrawn', entityType: 'cancellation_request', entityId: id, metadata: { reason } });
    });
    return this.cancellation(actor, id);
  }

  cancellation(actor: Actor, id: string): CancellationDto {
    const row = this.deps.db.prepare('SELECT booking_id FROM cancellation_request WHERE id = ?').get(id) as { booking_id: string } | undefined;
    if (!row) throw new DomainError(ErrorCode.NOT_FOUND, 'Request not found');
    this.bookings.accessible(actor, row.booking_id);
    return this.bookings.cancellations(row.booking_id).find((c) => c.id === id)!;
  }

  listCancellations(actor: Actor, status: 'OPEN' | 'CLOSED' | 'WITHDRAWN' | 'ALL'): CancellationDto[] {
    requirePermission(this.deps, actor, ['refund.request', 'refund.manage'], 'cancellations.list');
    const bookingIds = (this.deps.db.prepare(`SELECT DISTINCT booking_id FROM cancellation_request WHERE (? = 'ALL' OR overall_status = ?) ORDER BY requested_at DESC LIMIT 500`).all(status, status) as { booking_id: string }[]).map((r) => r.booking_id);
    const out: CancellationDto[] = [];
    for (const b of bookingIds) {
      try {
        this.bookings.accessible(actor, b);
      } catch {
        continue;
      }
      out.push(...this.bookings.cancellations(b).filter((c) => status === 'ALL' || c.overallStatus === status));
    }
    return out.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  /**
   * Open items of a party per record and currency (positive = they owe / we owe,
   * negative = credit), plus the unallocated on-account balance. Derived from
   * the journal; used to allocate payments precisely.
   */
  openItems(actor: Actor, party: 'CUSTOMER' | 'SUPPLIER', partyId: string): { bookingId: string | null; bookingNo: string | null; currency: string; openMinor: number; dueDate: string | null }[] {
    requirePermission(this.deps, actor, party === 'CUSTOMER' ? ['payment.customer.receive', 'payment.customer.refund'] : ['payment.supplier.pay', 'payment.supplier.record_refund'], 'payments.openItems');
    const account = party === 'CUSTOMER' ? '1200' : '2100';
    const col = party === 'CUSTOMER' ? 'customer_id' : 'supplier_id';
    const sign = party === 'CUSTOMER' ? 1 : -1;
    const rows = this.deps.db
      .prepare(`SELECT jl.booking_id, b.booking_no, jl.currency_code, SUM(jl.debit_minor - jl.credit_minor) AS bal, b.due_date
                FROM journal_line jl LEFT JOIN booking b ON b.id = jl.booking_id
                WHERE jl.account_code = ? AND jl.${col} = ? GROUP BY jl.booking_id, jl.currency_code HAVING bal <> 0
                ORDER BY (jl.booking_id IS NULL), b.due_date, b.booking_no`)
      .all(account, partyId) as { booking_id: string | null; booking_no: string | null; currency_code: string; bal: number; due_date: string | null }[];
    return rows
      .filter((r) => {
        if (!r.booking_id || party === 'SUPPLIER') return true;
        try { this.bookings.accessible(actor, r.booking_id); return true; } catch { return false; }
      })
      .map((r) => ({ bookingId: r.booking_id, bookingNo: r.booking_no, currency: r.currency_code, openMinor: sign * r.bal, dueDate: r.due_date }));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  private request(actor: Actor, id: string, rowVersion: number): CancellationRow {
    const r = this.deps.db.prepare('SELECT * FROM cancellation_request WHERE id = ?').get(id) as CancellationRow | undefined;
    if (!r) throw new DomainError(ErrorCode.NOT_FOUND, 'Request not found');
    this.bookings.accessible(actor, r.booking_id);
    if (r.row_version !== rowVersion) throw new DomainError(ErrorCode.STALE_RECORD, 'The request was changed by someone else; reload it');
    if (r.overall_status !== 'OPEN') throw new DomainError(ErrorCode.CONFLICT, 'The request is closed', { reason: 'NOT_OPEN' });
    return r;
  }

  private requestTickets(id: string): { id: string; passenger_id: string; supplier_id: string; status: string }[] {
    return this.deps.db.prepare(`SELECT t.id, t.passenger_id, t.supplier_id, t.status FROM cancellation_item ci JOIN ticket t ON t.id = ci.ticket_id WHERE ci.cancellation_request_id = ?`).all(id) as
      { id: string; passenger_id: string; supplier_id: string; status: string }[];
  }

  /** Moves the two sides; when both are terminal the request closes and tickets/passengers/booking follow. */
  private setSides(actor: Actor, r: CancellationRow, supplier: SupplierSide, customer: CustomerSide, action: string, note?: string): void {
    const now = this.deps.clock.now().toISOString();
    const overall = requestOverall(supplier, customer);
    this.deps.db
      .prepare(`UPDATE cancellation_request SET supplier_status = ?, customer_status = ?, overall_status = ?, closed_at = ?,
                  supplier_updated_at = CASE WHEN supplier_status <> ? THEN ? ELSE supplier_updated_at END,
                  customer_updated_at = CASE WHEN customer_status <> ? THEN ? ELSE customer_updated_at END,
                  notes = CASE WHEN ? IS NULL THEN notes ELSE COALESCE(notes || char(10), '') || ? END, row_version = row_version + 1 WHERE id = ?`)
      .run(supplier, customer, overall, overall === 'CLOSED' ? now : null, supplier, now, customer, now, note ?? null, note ?? null, r.id);
    this.deps.audit.append(actorOf(actor), {
      action, entityType: 'cancellation_request', entityId: r.id,
      before: { supplierStatus: r.supplier_status, customerStatus: r.customer_status }, after: { supplierStatus: supplier, customerStatus: customer, overall },
      metadata: note ? { note } : undefined,
    });
    if (overall === 'CLOSED') this.applyClosure(actor, r);
  }

  private applyClosure(actor: Actor, r: CancellationRow): void {
    const db = this.deps.db;
    const now = this.deps.clock.now().toISOString();
    for (const t of this.requestTickets(r.id)) {
      const remaining = this.bookings.netSale(r.booking_id, t.id);
      const to = r.cancel_type === 'VOID' ? 'VOIDED' : remaining > 0 && r.cancel_type === 'REFUND' ? 'PARTIALLY_REFUNDED' : 'REFUNDED';
      db.prepare('UPDATE ticket SET status = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(to, now, t.id);
      db.prepare(`UPDATE booking_passenger SET status = 'CANCELLED', updated_at = ?, row_version = row_version + 1 WHERE id = ?`).run(now, t.passenger_id);
      this.deps.audit.append(actorOf(actor), { action: 'ticket.status_changed', entityType: 'ticket', entityId: t.id, before: { status: t.status }, after: { status: to }, metadata: { requestId: r.id } });
    }
    const b = this.bookings.accessible(actor, r.booking_id);
    const counts = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN p.status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled,
                                      SUM(CASE WHEN t.status = 'VOIDED' THEN 1 ELSE 0 END) AS voided
                               FROM ticket t JOIN booking_passenger p ON p.id = t.passenger_id WHERE t.booking_id = ? AND t.status <> 'EXCHANGED'`).get(r.booking_id) as { total: number; cancelled: number; voided: number };
    const event = counts.cancelled < counts.total ? 'CANCEL_PARTIAL' : counts.voided === counts.total && b.status === 'ISSUED' ? 'VOID_ALL' : 'CANCEL_ALL';
    const to = event === 'CANCEL_PARTIAL' ? 'PARTIALLY_CANCELLED' : event === 'VOID_ALL' ? 'VOIDED' : 'CANCELLED';
    if (to !== b.status) this.bookings.setStatus(actor, b, to, r.request_no);
    this.bookings.reindex(r.booking_id);
  }

  /** Receivable (sign +1) or payable (sign −1, credit-positive) open balance for one party/booking/currency. */
  private openItem(account: '1200' | '2100', partyCol: 'customer_id' | 'supplier_id', partyId: string, bookingId: string | null, currency: string, sign: 1 | -1 = 1): { txn: number; base: number } {
    const r = this.deps.db
      .prepare(`SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS txn, COALESCE(SUM(debit_base_minor - credit_base_minor), 0) AS base FROM journal_line
                WHERE account_code = ? AND ${partyCol} = ? AND currency_code = ? AND ${bookingId ? 'booking_id = ?' : 'booking_id IS NULL'}`)
      .get(...[account, partyId, currency, ...(bookingId ? [bookingId] : [])]) as { txn: number; base: number };
    return { txn: sign * r.txn, base: sign * r.base };
  }

  private quoteOpen(bookingId: string, currency: string, openTxn: number): number {
    const b = this.deps.db.prepare('SELECT sale_currency_code FROM booking WHERE id = ?').get(bookingId) as { sale_currency_code: string };
    if (b.sale_currency_code !== currency) throw fieldError('currency', 'CURRENCY_MISMATCH', `This booking is priced in ${b.sale_currency_code}`);
    const quote = (this.deps.db.prepare('SELECT COALESCE(SUM(fare_minor + taxes_minor + service_fee_minor - discount_minor), 0) AS t FROM booking_price_item WHERE booking_id = ?').get(bookingId) as { t: number }).t;
    return Math.max(0, quote + openTxn);
  }

  /**
   * Foreign-currency settlements clear the balance at the base value it is
   * carried at; the difference to today's rate is realised FX (BR-CUR-04).
   */
  private carrying(open: { txn: number; base: number }, amount: number, currency: string): { carryingBaseMinor?: number } {
    if (currency === this.company.core().baseCurrency || open.txn <= 0 || open.base <= 0) return {};
    return { carryingBaseMinor: Math.max(1, Math.round((open.base * amount) / open.txn)) };
  }

  /** What the party owes on account (e.g. an opening balance), in party-normal sign; 0 if they are in credit. */
  private onAccountDue(party: 'CUSTOMER' | 'SUPPLIER', partyId: string, currency: string): number {
    const open = party === 'CUSTOMER' ? this.openItem('1200', 'customer_id', partyId, null, currency) : this.openItem('2100', 'supplier_id', partyId, null, currency, -1);
    return Math.max(0, open.txn);
  }

  /** On-account part of a payment: first settles what is owed on account (at its carrying value), the rest becomes a credit. */
  private onAccountLines(account: '1200' | '2100', col: 'customer_id' | 'supplier_id', partyId: string, currency: string, amount: number, sign: 1 | -1): DocumentLineDraft[] {
    if (amount <= 0) return [];
    const open = this.openItem(account, col, partyId, null, currency, sign);
    const settle = Math.min(amount, Math.max(0, open.txn));
    const lines: DocumentLineDraft[] = [];
    if (settle > 0) lines.push({ lineType: 'SETTLEMENT', amountMinor: settle, bookingId: null, ...this.carrying(open, settle, currency) });
    if (amount - settle > 0) lines.push({ lineType: 'SETTLEMENT', amountMinor: amount - settle, bookingId: null });
    return lines;
  }

  private accountBalance(accountId: string, currency: string): { txn: number; base: number } {
    return this.deps.db
      .prepare(`SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS txn, COALESCE(SUM(debit_base_minor - credit_base_minor), 0) AS base
                FROM journal_line WHERE account_code = '1110' AND money_account_id = ? AND currency_code = ?`)
      .get(accountId, currency) as { txn: number; base: number };
  }

  private assertAmount(amount: number, field = 'amountMinor'): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw fieldError(field, 'INVALID_AMOUNT', 'The amount must be positive');
  }

  private checkSplit(input: PaymentInput): number {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw fieldError('amountMinor', 'INVALID_AMOUNT', 'The amount must be positive');
    const allocated = input.allocations.reduce((s, a) => {
      if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor <= 0) throw fieldError('allocations', 'INVALID_AMOUNT', 'Allocations must be positive');
      return s + a.amountMinor;
    }, 0);
    const onAccount = input.onAccountMinor ?? 0;
    if (onAccount < 0 || allocated + onAccount !== input.amountMinor) {
      throw fieldError('allocations', 'ALLOCATION_MISMATCH', 'Allocations must add up exactly to the amount');
    }
    if (new Set(input.allocations.map((a) => a.bookingId)).size !== input.allocations.length) throw fieldError('allocations', 'DUPLICATE_BOOKING', 'Each booking once');
    return onAccount;
  }

  private docRate(actor: Actor, currency: string, date: string, override?: string | null): string {
    this.currencies.minorUnitOf(currency);
    if (currency === this.company.core().baseCurrency) return '1';
    if (override) {
      requirePermission(this.deps, actor, 'finance.override_rate', 'payments.overrideRate');
      return parseRate(override);
    }
    const r = this.currencies.rateOn(currency, date);
    if (!r) throw new DomainError(ErrorCode.RATE_REQUIRED, `Enter an exchange rate for ${currency} on ${date} first`, { currency, date });
    return r;
  }

  private assertAccount(id: string, currency: string): void {
    const a = this.reference.moneyAccount(id);
    if (a.is_active !== 1) throw fieldError('moneyAccountId', 'ARCHIVED_READ_ONLY', 'The account is archived');
    if (a.currency_code !== currency) throw fieldError('moneyAccountId', 'CURRENCY_MISMATCH', `This account holds ${a.currency_code}`);
  }

  private party(table: 'customer' | 'supplier', id: string): string {
    const r = this.deps.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id) as { id: string } | undefined;
    if (!r) throw fieldError('partyId', 'NOT_FOUND', `${table} not found`);
    return r.id;
  }

  private bookingNo(id: string): string {
    const r = this.deps.db.prepare('SELECT booking_no FROM booking WHERE id = ?').get(id) as { booking_no: string } | undefined;
    if (!r) throw fieldError('allocations', 'NOT_FOUND', 'Booking not found');
    return r.booking_no;
  }
}
