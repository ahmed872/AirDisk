import { DomainError, ErrorCode } from '../errors';
import { assertCurrencyCode } from '../money/currency';
import { convertMinor, parseRate } from '../money/exchange';
import { assertPositiveMinor, assertMinor, sumMinor } from '../money/money';
import { assertIsoDate } from '../time/dates';

/**
 * Financial document types (Phase 0 §04-2). Every monetary fact in AirDesk is
 * one of these. Documents are generic commercial documents: nothing here is
 * airline-specific, so hotels/visas can later reuse the same engine (Q10).
 */
export const DOC_TYPES = [
  'CUSTOMER_INVOICE',
  'CUSTOMER_CREDIT_NOTE',
  'CUSTOMER_RECEIPT',
  'CUSTOMER_REFUND',
  'SUPPLIER_BILL',
  'SUPPLIER_CREDIT_NOTE',
  'SUPPLIER_PAYMENT',
  'SUPPLIER_REFUND',
  'EXPENSE',
  'MONEY_TRANSFER',
  'BALANCE_APPLICATION',
  'OPENING_BALANCE',
  'FX_ADJUSTMENT',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const LINE_TYPES = [
  'FARE',
  'TAXES',
  'SERVICE_FEE',
  'CHANGE_FEE',
  'CANCELLATION_FEE',
  'DISCOUNT',
  'SALE_RETURN',
  'PURCHASE_COST',
  'PURCHASE_RETURN',
  'SUPPLIER_PENALTY',
  'SETTLEMENT',
  'EXPENSE',
  'TRANSFER',
  'APPLICATION',
  'OPENING',
  'FX',
] as const;
export type LineType = (typeof LINE_TYPES)[number];

export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'WALLET', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

type Party = 'CUSTOMER' | 'SUPPLIER' | 'NONE';
type Cash = 'IN' | 'OUT' | null;

export interface DocTypeMeta {
  readonly prefix: string;
  readonly party: Party;
  readonly cash: Cash;
  readonly lineTypes: readonly LineType[];
  /** Whether a posting rule ships for this type (FX_ADJUSTMENT is still reserved). */
  readonly supported: boolean;
  /** Party / money-account rules are type-specific (see validateSpecialDocument), not the generic ones above. */
  readonly special?: true;
}

/** MONEY_TRANSFER kinds (Phase 0 §04 P10), stored in `reasonCode`. */
export const TRANSFER_KINDS = ['ACCOUNT_TRANSFER', 'OWNER_CAPITAL', 'OWNER_DRAWING'] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];
/** OPENING_BALANCE sides (Phase 0 §04 P12), stored in `reasonCode`: DEBIT = owed to the office / cash held. */
export const OPENING_SIDES = ['OPENING_DEBIT', 'OPENING_CREDIT'] as const;
export type OpeningSide = (typeof OPENING_SIDES)[number];

export const DOC_TYPE_META: Readonly<Record<DocType, DocTypeMeta>> = {
  CUSTOMER_INVOICE: { prefix: 'INV', party: 'CUSTOMER', cash: null, lineTypes: ['FARE', 'TAXES', 'SERVICE_FEE', 'CHANGE_FEE', 'CANCELLATION_FEE'], supported: true },
  CUSTOMER_CREDIT_NOTE: { prefix: 'CRN', party: 'CUSTOMER', cash: null, lineTypes: ['SALE_RETURN', 'DISCOUNT'], supported: true },
  CUSTOMER_RECEIPT: { prefix: 'RCT', party: 'CUSTOMER', cash: 'IN', lineTypes: ['SETTLEMENT'], supported: true },
  CUSTOMER_REFUND: { prefix: 'RFD', party: 'CUSTOMER', cash: 'OUT', lineTypes: ['SETTLEMENT'], supported: true },
  SUPPLIER_BILL: { prefix: 'BIL', party: 'SUPPLIER', cash: null, lineTypes: ['PURCHASE_COST', 'SUPPLIER_PENALTY'], supported: true },
  SUPPLIER_CREDIT_NOTE: { prefix: 'SCN', party: 'SUPPLIER', cash: null, lineTypes: ['PURCHASE_RETURN'], supported: true },
  SUPPLIER_PAYMENT: { prefix: 'SPY', party: 'SUPPLIER', cash: 'OUT', lineTypes: ['SETTLEMENT'], supported: true },
  SUPPLIER_REFUND: { prefix: 'SRF', party: 'SUPPLIER', cash: 'IN', lineTypes: ['SETTLEMENT'], supported: true },
  EXPENSE: { prefix: 'EXP', party: 'NONE', cash: 'OUT', lineTypes: ['EXPENSE'], supported: true },
  MONEY_TRANSFER: { prefix: 'TRF', party: 'NONE', cash: null, lineTypes: ['TRANSFER'], supported: true, special: true },
  BALANCE_APPLICATION: { prefix: 'APL', party: 'NONE', cash: null, lineTypes: ['APPLICATION'], supported: true, special: true },
  OPENING_BALANCE: { prefix: 'OPB', party: 'NONE', cash: null, lineTypes: ['OPENING'], supported: true, special: true },
  FX_ADJUSTMENT: { prefix: 'FXA', party: 'NONE', cash: null, lineTypes: ['FX'], supported: false },
};

export interface DocumentLineDraft {
  lineType: LineType;
  /** Amount in the document currency, strictly positive (BR-IMM-04). */
  amountMinor: number;
  bookingId?: string | null;
  passengerId?: string | null;
  ticketId?: string | null;
  expenseCategoryId?: string | null;
  description?: string | null;
  /**
   * Settlement lines only: the base-currency value at which the balance being
   * settled is carried. The difference to this line's own base value is a
   * realised FX gain/loss (BR-CUR-04). Omit for same-rate settlements.
   * Also used by TRANSFER lines (the source account's carrying value) and
   * APPLICATION lines (the carrying value of the record being settled).
   */
  carryingBaseMinor?: number;
  /** APPLICATION lines only: carrying value of the credit being applied (its source). */
  sourceCarryingBaseMinor?: number;
}

export interface DocumentDraft {
  docType: DocType;
  docDate: string;
  currency: string;
  /** Required when currency differs from base currency; must be omitted or '1' otherwise. */
  exchangeRate?: string;
  customerId?: string | null;
  supplierId?: string | null;
  bookingId?: string | null;
  moneyAccountId?: string | null;
  /** MONEY_TRANSFER between accounts only: the receiving account (`moneyAccountId` is the source). */
  counterMoneyAccountId?: string | null;
  paymentMethod?: PaymentMethod | null;
  paymentReference?: string | null;
  /** The supplier's / airline's own reference (ADM, refund notice, invoice no.). Set once at posting, never edited. */
  externalReference?: string | null;
  reasonCode?: string | null;
  description?: string | null;
  cancellationRequestId?: string | null;
  lines: DocumentLineDraft[];
}

export interface PricedLine extends DocumentLineDraft {
  baseAmountMinor: number;
}

export interface PricedDocument extends Omit<DocumentDraft, 'lines' | 'exchangeRate'> {
  exchangeRate: string;
  totalMinor: number;
  totalBaseMinor: number;
  lines: PricedLine[];
}

export interface PricingContext {
  baseCurrency: string;
  minorUnitOf(currency: string): number;
}

/** Structural validation independent of the database (party, cash, line types, amounts). */
export function validateDocumentDraft(draft: DocumentDraft): void {
  const meta = DOC_TYPE_META[draft.docType];
  if (!meta) throw new DomainError(ErrorCode.VALIDATION, `Unknown document type ${String(draft.docType)}`);
  if (!meta.supported) {
    throw new DomainError(ErrorCode.UNSUPPORTED_DOCUMENT, `${draft.docType} posting is not available in this version`, {
      docType: draft.docType,
    });
  }
  assertIsoDate(draft.docDate, 'document date');
  assertCurrencyCode(draft.currency);
  if (draft.lines.length === 0) throw new DomainError(ErrorCode.VALIDATION, 'A document needs at least one line');
  if (meta.special) validateSpecialDocument(draft);
  else validateGenericParties(draft, meta);

  draft.lines.forEach((line, index) => {
    if (!meta.lineTypes.includes(line.lineType)) {
      throw new DomainError(ErrorCode.VALIDATION, `Line type ${line.lineType} is not allowed on ${draft.docType}`, { index });
    }
    assertPositiveMinor(line.amountMinor, `line ${index + 1} amount`);
    if (line.lineType === 'EXPENSE' && !line.expenseCategoryId) {
      throw new DomainError(ErrorCode.VALIDATION, 'Expense lines require a category', { index });
    }
    for (const [value, label] of [[line.carryingBaseMinor, 'Carrying base'], [line.sourceCarryingBaseMinor, 'Source carrying base']] as const) {
      if (value === undefined) continue;
      assertMinor(value, label);
      if (value <= 0) throw new DomainError(ErrorCode.INVALID_AMOUNT, `${label} must be positive`, { index });
    }
    if (line.carryingBaseMinor !== undefined && !['SETTLEMENT', 'TRANSFER', 'APPLICATION'].includes(line.lineType)) {
      throw new DomainError(ErrorCode.VALIDATION, 'Only settlement, transfer and application lines can carry a base value', { index });
    }
    if (line.sourceCarryingBaseMinor !== undefined && line.lineType !== 'APPLICATION') {
      throw new DomainError(ErrorCode.VALIDATION, 'Only application lines have a source carrying value', { index });
    }
  });
}

function validateGenericParties(draft: DocumentDraft, meta: DocTypeMeta): void {
  if (draft.counterMoneyAccountId) throw new DomainError(ErrorCode.VALIDATION, `${draft.docType} cannot have a receiving account`);
  if (meta.party === 'CUSTOMER' && !draft.customerId) throw new DomainError(ErrorCode.VALIDATION, `${draft.docType} requires a customer`);
  if (meta.party === 'SUPPLIER' && !draft.supplierId) throw new DomainError(ErrorCode.VALIDATION, `${draft.docType} requires a supplier`);
  if (meta.party !== 'CUSTOMER' && draft.customerId) throw new DomainError(ErrorCode.VALIDATION, `${draft.docType} cannot have a customer`);
  if (meta.party !== 'SUPPLIER' && draft.supplierId) throw new DomainError(ErrorCode.VALIDATION, `${draft.docType} cannot have a supplier`);
  if (meta.cash) {
    if (!draft.moneyAccountId || !draft.paymentMethod) {
      throw new DomainError(ErrorCode.VALIDATION, `${draft.docType} requires a money account and payment method`);
    }
  } else if (draft.moneyAccountId || draft.paymentMethod) {
    throw new DomainError(ErrorCode.VALIDATION, `${draft.docType} does not move cash`);
  }
}

const invalid = (message: string, details?: Record<string, unknown>) => new DomainError(ErrorCode.VALIDATION, message, details);

/**
 * Party and account rules of the documents that do not follow the generic
 * one-party / one-cash-side pattern (Phase 0 §04 P10–P12).
 */
function validateSpecialDocument(draft: DocumentDraft): void {
  const lines = draft.lines;
  switch (draft.docType) {
    case 'MONEY_TRANSFER': {
      const kind = draft.reasonCode as TransferKind;
      if (!TRANSFER_KINDS.includes(kind)) throw invalid('Unknown transfer kind', { reasonCode: draft.reasonCode });
      if (draft.customerId || draft.supplierId || draft.bookingId) throw invalid('A transfer has no customer, supplier or record');
      if (!draft.moneyAccountId) throw invalid('A transfer needs a money account');
      if (kind === 'ACCOUNT_TRANSFER') {
        if (!draft.counterMoneyAccountId) throw invalid('A transfer between accounts needs a receiving account');
        if (draft.counterMoneyAccountId === draft.moneyAccountId) throw invalid('Choose two different accounts', { reason: 'SAME_ACCOUNT' });
      } else if (draft.counterMoneyAccountId) {
        throw invalid('Owner capital and drawings use one account');
      }
      if (lines.length !== 1) throw invalid('A transfer has exactly one line');
      if (lines.some((l) => l.bookingId || l.ticketId || l.passengerId || l.expenseCategoryId)) throw invalid('Transfer lines carry no record');
      break;
    }
    case 'OPENING_BALANCE': {
      if (!OPENING_SIDES.includes(draft.reasonCode as OpeningSide)) throw invalid('Unknown opening balance side', { reasonCode: draft.reasonCode });
      const targets = [draft.customerId, draft.supplierId, draft.moneyAccountId].filter(Boolean).length;
      if (targets !== 1) throw invalid('An opening balance belongs to exactly one customer, supplier or money account');
      if (draft.moneyAccountId && draft.reasonCode !== 'OPENING_DEBIT') throw invalid('A money account opens with the cash it holds', { reason: 'NEGATIVE_CASH' });
      if (draft.counterMoneyAccountId || draft.paymentMethod || draft.bookingId) throw invalid('An opening balance moves no cash and has no record');
      if (lines.length !== 1) throw invalid('An opening balance has exactly one line');
      if (lines.some((l) => l.bookingId || l.ticketId || l.passengerId || l.expenseCategoryId || l.carryingBaseMinor !== undefined)) {
        throw invalid('Opening balances are held on account, not on a record');
      }
      break;
    }
    case 'BALANCE_APPLICATION': {
      if (Boolean(draft.customerId) === Boolean(draft.supplierId)) throw invalid('An application belongs to exactly one customer or supplier');
      if (draft.moneyAccountId || draft.counterMoneyAccountId || draft.paymentMethod) throw invalid('An application moves no cash');
      const targets = lines.map((l) => l.bookingId);
      if (targets.some((b) => !b)) throw invalid('Each application line names the record it settles');
      if (new Set(targets).size !== targets.length) throw invalid('Each record once', { reason: 'DUPLICATE_BOOKING' });
      if (draft.bookingId && targets.includes(draft.bookingId)) throw invalid('A credit cannot be applied to its own record', { reason: 'SAME_RECORD' });
      break;
    }
    default:
      throw invalid(`${draft.docType} has no special rules`);
  }
}

/**
 * Applies the exchange rate once, per line, half-up; the document base total
 * is the SUM of line base amounts so journals always balance (Phase 0 §04-7).
 */
export function priceDocument(draft: DocumentDraft, ctx: PricingContext): PricedDocument {
  validateDocumentDraft(draft);
  const isBase = draft.currency === ctx.baseCurrency;
  let rate: string;
  if (isBase) {
    if (draft.exchangeRate !== undefined && parseRate(draft.exchangeRate) !== '1') {
      throw new DomainError(ErrorCode.INVALID_RATE, 'Base-currency documents always use rate 1');
    }
    rate = '1';
  } else {
    if (draft.exchangeRate === undefined) {
      throw new DomainError(ErrorCode.RATE_REQUIRED, `An exchange rate is required for ${draft.currency}`, { currency: draft.currency });
    }
    rate = parseRate(draft.exchangeRate);
  }
  const fromUnit = ctx.minorUnitOf(draft.currency);
  const toUnit = ctx.minorUnitOf(ctx.baseCurrency);
  const lines: PricedLine[] = draft.lines.map((line) => {
    const baseAmountMinor = isBase ? line.amountMinor : convertMinor(line.amountMinor, fromUnit, rate, toUnit);
    if (isBase && ((line.carryingBaseMinor !== undefined && line.carryingBaseMinor !== baseAmountMinor) ||
        (line.sourceCarryingBaseMinor !== undefined && line.sourceCarryingBaseMinor !== baseAmountMinor))) {
      throw new DomainError(ErrorCode.VALIDATION, 'Base-currency settlements cannot carry a different base value');
    }
    return { ...line, baseAmountMinor };
  });
  const { exchangeRate: _ignored, ...rest } = draft;
  return {
    ...rest,
    exchangeRate: rate,
    lines,
    totalMinor: sumMinor(lines.map((l) => l.amountMinor)),
    totalBaseMinor: sumMinor(lines.map((l) => l.baseAmountMinor)),
  };
}
