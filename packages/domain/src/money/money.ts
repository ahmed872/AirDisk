import { DomainError, ErrorCode } from '../errors';
import { normalizeDigits } from '../text/digits';
import { assertCurrencyCode, assertMinorUnit, type CurrencyCode } from './currency';

/**
 * Money is always an integer number of minor units (piastres, halalas, cents).
 * Floating point is never used for stored amounts. JS numbers are exact for
 * integers up to 2^53 (≈ 90 trillion major units at 2 decimals), which we
 * enforce on every operation.
 */
export function assertMinor(value: number, label = 'amount'): number {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError(ErrorCode.INVALID_AMOUNT, `${label} must be a safe integer number of minor units`, { value });
  }
  return value;
}

export function assertPositiveMinor(value: number, label = 'amount'): number {
  assertMinor(value, label);
  if (value <= 0) throw new DomainError(ErrorCode.INVALID_AMOUNT, `${label} must be greater than zero`, { value });
  return value;
}

export function addMinor(a: number, b: number): number {
  return assertMinor(assertMinor(a) + assertMinor(b), 'sum');
}

export function sumMinor(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total = addMinor(total, v);
  return total;
}

export class Money {
  private constructor(
    readonly minor: number,
    readonly currency: CurrencyCode,
  ) {}

  static of(minor: number, currency: CurrencyCode): Money {
    return new Money(assertMinor(minor), assertCurrencyCode(currency));
  }

  static zero(currency: CurrencyCode): Money {
    return Money.of(0, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(addMinor(this.minor, other.minor), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(addMinor(this.minor, -other.minor), this.currency);
  }

  isZero(): boolean {
    return this.minor === 0;
  }

  isPositive(): boolean {
    return this.minor > 0;
  }

  isNegative(): boolean {
    return this.minor < 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.minor === other.minor ? 0 : this.minor < other.minor ? -1 : 1;
  }

  toJSON(): { minor: number; currency: CurrencyCode } {
    return { minor: this.minor, currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new DomainError(ErrorCode.CURRENCY_MISMATCH, `Cannot combine ${this.currency} and ${other.currency}`, {
        left: this.currency,
        right: other.currency,
      });
    }
  }
}

/**
 * Parses a user-typed amount into minor units without floating point.
 * Accepts ASCII or Arabic-Indic digits, thousands separators (',' / '٬' / spaces)
 * and a single decimal point ('.' / '٫'). Rejects more decimals than the
 * currency allows instead of silently rounding.
 */
export function parseAmountToMinor(input: string, minorUnit: number, opts: { allowNegative?: boolean } = {}): number {
  assertMinorUnit(minorUnit);
  let s = normalizeDigits(input).trim().replace(/[\s,]/g, '');
  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(s)) {
    throw new DomainError(ErrorCode.INVALID_AMOUNT, `Not a valid amount: "${input}"`, { input });
  }
  const [intPart = '0', fracPart = ''] = s.split('.');
  if (fracPart.length > minorUnit) {
    throw new DomainError(ErrorCode.INVALID_AMOUNT, `Too many decimal places (max ${minorUnit})`, { input, minorUnit });
  }
  const digits = (intPart === '' ? '0' : intPart) + fracPart.padEnd(minorUnit, '0');
  const value = Number(BigInt(digits));
  assertMinor(value);
  if (negative && value !== 0) {
    if (!opts.allowNegative) throw new DomainError(ErrorCode.INVALID_AMOUNT, 'Negative amounts are not allowed', { input });
    return -value;
  }
  return value;
}

/** Plain, locale-free representation ("10500.50") used in exports and tests. */
export function formatMinor(minor: number, minorUnit: number): string {
  assertMinor(minor);
  assertMinorUnit(minorUnit);
  const negative = minor < 0;
  const abs = String(Math.abs(minor)).padStart(minorUnit + 1, '0');
  const intPart = minorUnit === 0 ? abs : abs.slice(0, -minorUnit);
  const frac = minorUnit === 0 ? '' : `.${abs.slice(-minorUnit)}`;
  return `${negative ? '-' : ''}${intPart}${frac}`;
}
