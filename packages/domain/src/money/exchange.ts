import Decimal from 'decimal.js';
import { DomainError, ErrorCode } from '../errors';
import { normalizeDigits } from '../text/digits';
import { assertMinor } from './money';
import { assertMinorUnit } from './currency';

/**
 * Isolated Decimal constructor: high precision, half-up rounding (BR-CUR-03).
 * Never touches the global Decimal configuration.
 */
const D = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

export const MAX_RATE_DECIMALS = 10;

/**
 * Validates an exchange rate string ("50.45", "0.0265") and returns its
 * canonical form. Rates are stored as TEXT, never as floating point.
 * Semantics: 1 unit of transaction currency = rate units of base currency.
 */
export function parseRate(input: string): string {
  const s = normalizeDigits(input).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new DomainError(ErrorCode.INVALID_RATE, `Not a valid exchange rate: "${input}"`, { input });
  const d = new D(s);
  if (d.lte(0)) throw new DomainError(ErrorCode.INVALID_RATE, 'Exchange rate must be greater than zero', { input });
  if (d.decimalPlaces() > MAX_RATE_DECIMALS) {
    throw new DomainError(ErrorCode.INVALID_RATE, `Exchange rate supports at most ${MAX_RATE_DECIMALS} decimals`, { input });
  }
  return d.toFixed();
}

/**
 * Converts an amount in minor units of one currency into minor units of
 * another, applying the rate once and rounding half-up (BR-CUR-03). Callers
 * store the result; it is never recomputed later.
 */
export function convertMinor(amountMinor: number, fromMinorUnit: number, rate: string, toMinorUnit: number): number {
  assertMinor(amountMinor);
  assertMinorUnit(fromMinorUnit);
  assertMinorUnit(toMinorUnit);
  const r = new D(parseRate(rate));
  const major = new D(amountMinor).div(new D(10).pow(fromMinorUnit));
  const target = major.mul(r).mul(new D(10).pow(toMinorUnit)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return assertMinor(target.toNumber(), 'converted amount');
}
