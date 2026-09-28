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
  /** Whether Phase 1 ships a posting rule. Others arrive in later phases (see roadmap). */
  readonly supported: boolean;
}

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
  MONEY_TRANSFER: { prefix: 'TRF', party: 'NONE', cash: null, lineTypes: ['TRANSFER'], supported: false },
  BALANCE_APPLICATION: { prefix: 'APL', party: 'NONE', cash: null, lineTypes: ['APPLICATION'], supported: false },
  OPENING_BALANCE: { prefix: 'OPB', party: 'NONE', cash: null, lineTypes: ['OPENING'], supported: false },
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
   */
  carryingBaseMinor?: number;
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
  paymentMethod?: PaymentMethod | null;
  paymentReference?: string | null;
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

  draft.lines.forEach((line, index) => {
    if (!meta.lineTypes.includes(line.lineType)) {
      throw new DomainError(ErrorCode.VALIDATION, `Line type ${line.lineType} is not allowed on ${draft.docType}`, { index });
    }
    assertPositiveMinor(line.amountMinor, `line ${index + 1} amount`);
    if (line.lineType === 'EXPENSE' && !line.expenseCategoryId) {
      throw new DomainError(ErrorCode.VALIDATION, 'Expense lines require a category', { index });
    }
    if (line.carryingBaseMinor !== undefined) {
      if (line.lineType !== 'SETTLEMENT') throw new DomainError(ErrorCode.VALIDATION, 'Only settlement lines can carry a base value', { index });
      assertMinor(line.carryingBaseMinor, 'carrying base');
      if (line.carryingBaseMinor <= 0) throw new DomainError(ErrorCode.INVALID_AMOUNT, 'Carrying base must be positive', { index });
    }
  });
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
    if (isBase && line.carryingBaseMinor !== undefined && line.carryingBaseMinor !== baseAmountMinor) {
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
