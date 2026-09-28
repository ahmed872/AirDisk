import { DomainError, ErrorCode } from '../errors';
import { assertIsoDate } from '../time/dates';
import type { DocType } from './documents';
import { mirrorJournal, type JournalLineDraft } from './journal';

export interface ReversibleDocument {
  id: string;
  docType: DocType;
  docDate: string;
  isReversal: boolean;
  reversedById: string | null;
}

/**
 * BR-IMM-02/03: a reversal mirrors the original exactly, needs a reason, is
 * dated on/after the original, and can happen once. A reversal itself cannot
 * be reversed — post a new, correct document instead.
 */
export function planReversal(
  original: ReversibleDocument,
  journal: readonly JournalLineDraft[],
  input: { reversalDate: string; reason: string },
): JournalLineDraft[] {
  assertIsoDate(input.reversalDate, 'reversal date');
  if (!input.reason || input.reason.trim().length < 3) {
    throw new DomainError(ErrorCode.VALIDATION, 'A reversal requires a reason');
  }
  if (original.isReversal) throw new DomainError(ErrorCode.CANNOT_REVERSE_REVERSAL, 'A reversal cannot be reversed');
  if (original.reversedById) {
    throw new DomainError(ErrorCode.ALREADY_REVERSED, 'This document has already been reversed', { reversedById: original.reversedById });
  }
  if (input.reversalDate < original.docDate) {
    throw new DomainError(ErrorCode.VALIDATION, 'A reversal cannot be dated before the original document', {
      originalDate: original.docDate,
    });
  }
  return mirrorJournal(journal);
}
