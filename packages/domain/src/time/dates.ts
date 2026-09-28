import { DomainError, ErrorCode } from '../errors';

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict calendar date check for business dates ('YYYY-MM-DD'). */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function assertIsoDate(value: string, label = 'date'): string {
  if (!isIsoDate(value)) throw new DomainError(ErrorCode.VALIDATION, `${label} must be a valid YYYY-MM-DD date`, { value });
  return value;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The business date of an instant in the company timezone. "Today" is always
 * computed this way — never from the PC's local timezone (EC-C05).
 */
export function businessDate(instant: Date, timeZone: string): string {
  if (!isValidTimeZone(timeZone)) throw new DomainError(ErrorCode.VALIDATION, `Unknown timezone ${timeZone}`, { timeZone });
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
