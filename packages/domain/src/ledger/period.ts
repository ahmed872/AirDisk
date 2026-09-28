import { DomainError, ErrorCode } from '../errors';
import { assertIsoDate } from '../time/dates';

/**
 * BR-IMM-06: nothing may be dated on or before the financial lock date.
 * ISO dates compare correctly as strings.
 */
export function assertPeriodOpen(docDate: string, lockDate: string | null | undefined): void {
  assertIsoDate(docDate, 'document date');
  if (lockDate && docDate <= lockDate) {
    throw new DomainError(ErrorCode.PERIOD_LOCKED, `Date ${docDate} is inside the locked period (locked through ${lockDate})`, {
      docDate,
      lockDate,
    });
  }
}

export type LockDateChange = 'LOCK' | 'UNLOCK' | 'UNCHANGED';

/** Moving the lock date forward locks; moving it back (or clearing it) unlocks. */
export function classifyLockDateChange(current: string | null, next: string | null): LockDateChange {
  if (next !== null) assertIsoDate(next, 'lock date');
  if (current === next) return 'UNCHANGED';
  if (current === null) return 'LOCK';
  if (next === null || next < current) return 'UNLOCK';
  return 'LOCK';
}
