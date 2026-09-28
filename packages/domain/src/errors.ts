/**
 * Stable, machine-readable error codes shared by every layer. The renderer maps
 * them to translated messages; they are part of the IPC contract, so existing
 * codes must never be renamed.
 */
export const ErrorCode = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  STALE_RECORD: 'STALE_RECORD',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  PASSWORD_POLICY: 'PASSWORD_POLICY',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  SETUP_REQUIRED: 'SETUP_REQUIRED',
  SETUP_ALREADY_DONE: 'SETUP_ALREADY_DONE',
  LAST_ADMIN: 'LAST_ADMIN',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  INVALID_RATE: 'INVALID_RATE',
  RATE_REQUIRED: 'RATE_REQUIRED',
  UNBALANCED_ENTRY: 'UNBALANCED_ENTRY',
  MISSING_DIMENSION: 'MISSING_DIMENSION',
  UNKNOWN_ACCOUNT: 'UNKNOWN_ACCOUNT',
  UNSUPPORTED_DOCUMENT: 'UNSUPPORTED_DOCUMENT',
  PERIOD_LOCKED: 'PERIOD_LOCKED',
  ALREADY_REVERSED: 'ALREADY_REVERSED',
  CANNOT_REVERSE_REVERSAL: 'CANNOT_REVERSE_REVERSAL',
  BASE_CURRENCY_FROZEN: 'BASE_CURRENCY_FROZEN',
  MIGRATION_CHECKSUM_MISMATCH: 'MIGRATION_CHECKSUM_MISMATCH',
  DATABASE_TOO_NEW: 'DATABASE_TOO_NEW',
  INTEGRITY_FAILURE: 'INTEGRITY_FAILURE',
  BACKUP_INVALID: 'BACKUP_INVALID',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** An expected, user-explainable failure. Anything else is a bug (INTERNAL). */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}

export function invariant(condition: unknown, code: ErrorCode, message: string, details?: Record<string, unknown>): asserts condition {
  if (!condition) throw new DomainError(code, message, details);
}
