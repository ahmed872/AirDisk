import { DomainError, ErrorCode } from '../errors';
import { ACCOUNT } from './accounts';
import type { LineType, PricedDocument, PricedLine } from './documents';
import { journalTotals, type JournalLineDraft, type Side } from './journal';

export interface PostingContext {
  baseCurrency: string;
  /** Ledger account an expense category maps to (configurable per installation). */
  expenseAccountFor(expenseCategoryId: string): string;
}

/** Revenue / contra-revenue / cost / contra-cost account per line type (Phase 0 §04-4). */
const LINE_ACCOUNT: Partial<Record<LineType, string>> = {
  FARE: ACCOUNT.TICKET_SALES,
  TAXES: ACCOUNT.TICKET_SALES,
  SERVICE_FEE: ACCOUNT.SERVICE_FEES,
  CHANGE_FEE: ACCOUNT.SERVICE_FEES,
  CANCELLATION_FEE: ACCOUNT.CANCELLATION_FEES,
  SALE_RETURN: ACCOUNT.SALES_RETURNS,
  DISCOUNT: ACCOUNT.DISCOUNTS,
  PURCHASE_COST: ACCOUNT.PURCHASE_COST,
  SUPPLIER_PENALTY: ACCOUNT.SUPPLIER_PENALTIES,
  PURCHASE_RETURN: ACCOUNT.PURCHASE_RETURNS,
};

function lineAccount(lineType: LineType): string {
  const code = LINE_ACCOUNT[lineType];
  if (!code) throw new DomainError(ErrorCode.VALIDATION, `No account mapping for line type ${lineType}`);
  return code;
}

const opposite = (side: Side): Side => (side === 'DEBIT' ? 'CREDIT' : 'DEBIT');

/**
 * Turns a priced document into its journal. Pure and deterministic: the same
 * document always yields the same journal. Payments/receipts only ever touch
 * cash and receivable/payable accounts — never revenue, cost or expense —
 * which is what keeps profit independent of cash (BR-FIN-03/04).
 */
export function buildJournal(doc: PricedDocument, ctx: PostingContext): JournalLineDraft[] {
  const cur = doc.currency;
  const booking = (l: PricedLine) => l.bookingId ?? doc.bookingId ?? null;
  const out: JournalLineDraft[] = [];
  const push = (accountCode: string, side: Side, amountMinor: number, baseAmountMinor: number, dims: JournalLineDraft['dims']) =>
    out.push({ accountCode, side, currency: cur, amountMinor, baseAmountMinor, dims });

  const receivable = (l: PricedLine, side: Side, base = l.baseAmountMinor) =>
    push(ACCOUNT.RECEIVABLE, side, l.amountMinor, base, { customerId: doc.customerId, bookingId: booking(l) });
  const payable = (l: PricedLine, side: Side, base = l.baseAmountMinor) =>
    push(ACCOUNT.PAYABLE, side, l.amountMinor, base, { supplierId: doc.supplierId, bookingId: booking(l) });
  const pnl = (l: PricedLine, side: Side, extra: JournalLineDraft['dims'] = {}) =>
    push(lineAccount(l.lineType), side, l.amountMinor, l.baseAmountMinor, { bookingId: booking(l), ticketId: l.ticketId ?? null, ...extra });
  const cash = (side: Side) => push(ACCOUNT.CASH, side, doc.totalMinor, doc.totalBaseMinor, { moneyAccountId: doc.moneyAccountId });

  switch (doc.docType) {
    case 'CUSTOMER_INVOICE':
      for (const l of doc.lines) {
        receivable(l, 'DEBIT');
        pnl(l, 'CREDIT');
      }
      break;
    case 'CUSTOMER_CREDIT_NOTE':
      for (const l of doc.lines) {
        pnl(l, 'DEBIT');
        receivable(l, 'CREDIT');
      }
      break;
    case 'CUSTOMER_RECEIPT':
      cash('DEBIT');
      for (const l of doc.lines) receivable(l, 'CREDIT', l.carryingBaseMinor);
      break;
    case 'CUSTOMER_REFUND':
      for (const l of doc.lines) receivable(l, 'DEBIT', l.carryingBaseMinor);
      cash('CREDIT');
      break;
    case 'SUPPLIER_BILL':
      for (const l of doc.lines) {
        pnl(l, 'DEBIT', { supplierId: doc.supplierId });
        payable(l, 'CREDIT');
      }
      break;
    case 'SUPPLIER_CREDIT_NOTE':
      for (const l of doc.lines) {
        payable(l, 'DEBIT');
        pnl(l, 'CREDIT', { supplierId: doc.supplierId });
      }
      break;
    case 'SUPPLIER_PAYMENT':
      for (const l of doc.lines) payable(l, 'DEBIT', l.carryingBaseMinor);
      cash('CREDIT');
      break;
    case 'SUPPLIER_REFUND':
      cash('DEBIT');
      for (const l of doc.lines) payable(l, 'CREDIT', l.carryingBaseMinor);
      break;
    case 'EXPENSE':
      for (const l of doc.lines) {
        push(ctx.expenseAccountFor(l.expenseCategoryId!), 'DEBIT', l.amountMinor, l.baseAmountMinor, {
          expenseCategoryId: l.expenseCategoryId,
        });
      }
      cash('CREDIT');
      break;
    // P10: money only changes place; a foreign-currency balance leaves its source at the value it is carried at.
    case 'MONEY_TRANSFER':
      for (const l of doc.lines) {
        const base = l.carryingBaseMinor ?? l.baseAmountMinor;
        if (doc.reasonCode === 'ACCOUNT_TRANSFER') {
          push(ACCOUNT.CASH, 'DEBIT', l.amountMinor, base, { moneyAccountId: doc.counterMoneyAccountId });
          push(ACCOUNT.CASH, 'CREDIT', l.amountMinor, base, { moneyAccountId: doc.moneyAccountId });
        } else if (doc.reasonCode === 'OWNER_CAPITAL') {
          push(ACCOUNT.CASH, 'DEBIT', l.amountMinor, base, { moneyAccountId: doc.moneyAccountId });
          push(ACCOUNT.OWNER, 'CREDIT', l.amountMinor, base, {});
        } else {
          push(ACCOUNT.OWNER, 'DEBIT', l.amountMinor, base, {});
          push(ACCOUNT.CASH, 'CREDIT', l.amountMinor, base, { moneyAccountId: doc.moneyAccountId });
        }
      }
      break;
    // P12: go-live balances against opening-balance equity, held on account (no record).
    case 'OPENING_BALANCE':
      for (const l of doc.lines) {
        const side: Side = doc.reasonCode === 'OPENING_DEBIT' ? 'DEBIT' : 'CREDIT';
        if (doc.customerId) push(ACCOUNT.RECEIVABLE, side, l.amountMinor, l.baseAmountMinor, { customerId: doc.customerId, bookingId: null });
        else if (doc.supplierId) push(ACCOUNT.PAYABLE, side, l.amountMinor, l.baseAmountMinor, { supplierId: doc.supplierId, bookingId: null });
        else push(ACCOUNT.CASH, side, l.amountMinor, l.baseAmountMinor, { moneyAccountId: doc.moneyAccountId });
        push(ACCOUNT.OPENING_EQUITY, opposite(side), l.amountMinor, l.baseAmountMinor, {});
      }
      break;
    // P11: a party's credit (on account, or on another record = doc.bookingId) settles a record's balance. No cash, no P&L.
    case 'BALANCE_APPLICATION':
      for (const l of doc.lines) {
        const source = l.sourceCarryingBaseMinor ?? l.baseAmountMinor;
        const target = l.carryingBaseMinor ?? l.baseAmountMinor;
        const from = doc.bookingId ?? null;
        if (doc.customerId) {
          push(ACCOUNT.RECEIVABLE, 'DEBIT', l.amountMinor, source, { customerId: doc.customerId, bookingId: from });
          push(ACCOUNT.RECEIVABLE, 'CREDIT', l.amountMinor, target, { customerId: doc.customerId, bookingId: l.bookingId ?? null });
        } else {
          push(ACCOUNT.PAYABLE, 'DEBIT', l.amountMinor, target, { supplierId: doc.supplierId, bookingId: l.bookingId ?? null });
          push(ACCOUNT.PAYABLE, 'CREDIT', l.amountMinor, source, { supplierId: doc.supplierId, bookingId: from });
        }
      }
      break;
    case 'FX_ADJUSTMENT':
      throw new DomainError(ErrorCode.UNSUPPORTED_DOCUMENT, `${doc.docType} posting is not available in this version`);
    default: {
      const exhaustive: never = doc.docType;
      throw new DomainError(ErrorCode.VALIDATION, `Unknown document type ${String(exhaustive)}`);
    }
  }

  // Realised FX (BR-CUR-04): only settlements at a rate different from the one
  // the balance is carried at may leave a base difference; it goes to 7100.
  const { debitBaseMinor, creditBaseMinor } = journalTotals(out);
  const diff = debitBaseMinor - creditBaseMinor;
  if (diff !== 0) {
    const hasCarrying = doc.lines.some((l) => l.carryingBaseMinor !== undefined || l.sourceCarryingBaseMinor !== undefined);
    if (!hasCarrying) throw new DomainError(ErrorCode.UNBALANCED_ENTRY, 'Posting rule produced an unbalanced journal', { diff });
    out.push({
      accountCode: ACCOUNT.FX,
      side: opposite(diff > 0 ? 'DEBIT' : 'CREDIT'),
      currency: ctx.baseCurrency,
      amountMinor: Math.abs(diff),
      baseAmountMinor: Math.abs(diff),
      dims: { bookingId: doc.bookingId ?? null },
    });
  }
  return out;
}
