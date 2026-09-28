import { DomainError, ErrorCode } from '../errors';
import { assertCurrencyCode } from '../money/currency';
import { assertMinor, sumMinor } from '../money/money';
import type { ChartOfAccounts } from './accounts';

export type Side = 'DEBIT' | 'CREDIT';

/** Analytical dimensions carried by a journal line (Phase 0 §04-1.6). */
export interface Dimensions {
  customerId?: string | null;
  supplierId?: string | null;
  moneyAccountId?: string | null;
  bookingId?: string | null;
  ticketId?: string | null;
  expenseCategoryId?: string | null;
}

export interface JournalLineDraft {
  accountCode: string;
  side: Side;
  /** Currency of amountMinor (the line's transaction currency). */
  currency: string;
  /** Amount in the line currency, >= 0. May be 0 only on pure base-currency adjustment lines. */
  amountMinor: number;
  /** Amount in base currency, frozen at posting, >= 0. Balancing is done on this value. */
  baseAmountMinor: number;
  dims: Dimensions;
}

export interface JournalTotals {
  debitBaseMinor: number;
  creditBaseMinor: number;
}

export function journalTotals(lines: readonly JournalLineDraft[]): JournalTotals {
  return {
    debitBaseMinor: sumMinor(lines.filter((l) => l.side === 'DEBIT').map((l) => l.baseAmountMinor)),
    creditBaseMinor: sumMinor(lines.filter((l) => l.side === 'CREDIT').map((l) => l.baseAmountMinor)),
  };
}

const DIMENSION_FIELD = {
  CUSTOMER: 'customerId',
  SUPPLIER: 'supplierId',
  MONEY_ACCOUNT: 'moneyAccountId',
} as const;

/**
 * Validates a journal before it is persisted (INV-1). The database repeats the
 * balance check when the entry is sealed, so a bug here cannot slip through.
 */
export function validateJournal(lines: readonly JournalLineDraft[], chart: ChartOfAccounts): void {
  if (lines.length < 2) {
    throw new DomainError(ErrorCode.UNBALANCED_ENTRY, 'A journal entry needs at least two lines', { lines: lines.length });
  }
  lines.forEach((line, index) => {
    const account = chart.get(line.accountCode);
    if (!account) throw new DomainError(ErrorCode.UNKNOWN_ACCOUNT, `Unknown account ${line.accountCode}`, { index });
    assertCurrencyCode(line.currency);
    assertMinor(line.amountMinor, 'line amount');
    assertMinor(line.baseAmountMinor, 'line base amount');
    if (line.amountMinor < 0 || line.baseAmountMinor < 0) {
      throw new DomainError(ErrorCode.INVALID_AMOUNT, 'Journal amounts are never negative; use the opposite side', { index });
    }
    if (line.amountMinor === 0 && line.baseAmountMinor === 0) {
      throw new DomainError(ErrorCode.INVALID_AMOUNT, 'Journal line has no amount', { index });
    }
    if (account.dimension !== 'NONE') {
      const field = DIMENSION_FIELD[account.dimension];
      if (!line.dims[field]) {
        throw new DomainError(ErrorCode.MISSING_DIMENSION, `Account ${account.code} requires ${field}`, { index, field });
      }
    }
  });
  const totals = journalTotals(lines);
  if (totals.debitBaseMinor !== totals.creditBaseMinor) {
    throw new DomainError(ErrorCode.UNBALANCED_ENTRY, 'Debits and credits (base currency) do not match', { ...totals });
  }
}

/** The journal of a reversal: identical lines with debit and credit swapped. */
export function mirrorJournal(lines: readonly JournalLineDraft[]): JournalLineDraft[] {
  return lines.map((l) => ({ ...l, side: l.side === 'DEBIT' ? 'CREDIT' : 'DEBIT', dims: { ...l.dims } }));
}
