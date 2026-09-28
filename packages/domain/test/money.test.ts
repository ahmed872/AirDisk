import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ErrorCode, Money, addMinor, formatMinor, normalizeDigits, parseAmountToMinor, sumMinor } from '../src';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_ERROR';
};

describe('normalizeDigits', () => {
  it('converts Arabic-Indic and Persian digits and Arabic separators', () => {
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(normalizeDigits('۱۲۳')).toBe('123');
    expect(normalizeDigits('١٠٬٥٠٠٫٥٠')).toBe('10,500.50');
  });
});

describe('parseAmountToMinor', () => {
  it.each([
    ['10500', 2, 1_050_000],
    ['10,500.50', 2, 1_050_050],
    ['10 500.5', 2, 1_050_050],
    ['١٠٬٥٠٠٫٥٠', 2, 1_050_050],
    ['.5', 2, 50],
    ['0', 2, 0],
    ['12.345', 3, 12_345],
    ['1500', 0, 1500],
  ])('parses %s (minor unit %i)', (input, unit, expected) => {
    expect(parseAmountToMinor(input, unit)).toBe(expected);
  });

  it('rejects more decimals than the currency allows instead of rounding', () => {
    expect(code(() => parseAmountToMinor('10.555', 2))).toBe(ErrorCode.INVALID_AMOUNT);
    expect(code(() => parseAmountToMinor('10.5', 0))).toBe(ErrorCode.INVALID_AMOUNT);
  });

  it('rejects garbage, empty input and negatives by default', () => {
    for (const bad of ['', 'abc', '1.2.3', '--5', '5-', '1e5', 'NaN']) {
      expect(code(() => parseAmountToMinor(bad, 2))).toBe(ErrorCode.INVALID_AMOUNT);
    }
    expect(code(() => parseAmountToMinor('-5', 2))).toBe(ErrorCode.INVALID_AMOUNT);
    expect(parseAmountToMinor('-5', 2, { allowNegative: true })).toBe(-500);
  });

  it('rejects amounts beyond the safe integer range', () => {
    expect(code(() => parseAmountToMinor('999999999999999999', 2))).toBe(ErrorCode.INVALID_AMOUNT);
  });

  it('round-trips with formatMinor for any safe amount (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e13, max: 1e13 }), fc.integer({ min: 0, max: 3 }), (minor, unit) => {
        expect(parseAmountToMinor(formatMinor(minor, unit), unit, { allowNegative: true })).toBe(minor);
      }),
    );
  });
});

describe('formatMinor', () => {
  it('formats without locale or floating point', () => {
    expect(formatMinor(1_050_050, 2)).toBe('10500.50');
    expect(formatMinor(5, 2)).toBe('0.05');
    expect(formatMinor(-5, 2)).toBe('-0.05');
    expect(formatMinor(12_345, 3)).toBe('12.345');
    expect(formatMinor(7, 0)).toBe('7');
  });
});

describe('Money', () => {
  it('adds and subtracts in the same currency', () => {
    const a = Money.of(1_050_000, 'EGP');
    const b = Money.of(500_000, 'EGP');
    expect(a.subtract(b).minor).toBe(550_000);
    expect(a.add(b).equals(Money.of(1_550_000, 'EGP'))).toBe(true);
    expect(a.compare(b)).toBe(1);
    expect(Money.zero('EGP').isZero()).toBe(true);
  });

  it('never mixes currencies', () => {
    expect(code(() => Money.of(1, 'EGP').add(Money.of(1, 'USD')))).toBe(ErrorCode.CURRENCY_MISMATCH);
  });

  it('rejects fractional minor units and invalid currency codes', () => {
    expect(code(() => Money.of(1.5, 'EGP'))).toBe(ErrorCode.INVALID_AMOUNT);
    expect(code(() => Money.of(1, 'egp'))).toBe(ErrorCode.VALIDATION);
  });

  it('detects overflow instead of losing precision', () => {
    expect(code(() => addMinor(Number.MAX_SAFE_INTEGER, 1))).toBe(ErrorCode.INVALID_AMOUNT);
    expect(sumMinor([500_000, 200_000, 100_000, 250_000])).toBe(1_050_000);
  });
});
