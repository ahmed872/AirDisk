import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ErrorCode, convertMinor, parseRate } from '../src';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_ERROR';
};

describe('parseRate', () => {
  it('canonicalises valid decimal strings', () => {
    expect(parseRate('50.50')).toBe('50.5');
    expect(parseRate('1')).toBe('1');
    expect(parseRate('0.0265')).toBe('0.0265');
    expect(parseRate('٥٠٫٥')).toBe('50.5');
  });

  it('rejects zero, negatives, garbage and excessive precision', () => {
    for (const bad of ['0', '0.000', '-1', 'abc', '', '1e3', '1.12345678901']) {
      expect(code(() => parseRate(bad))).toBe(ErrorCode.INVALID_RATE);
    }
  });
});

describe('convertMinor', () => {
  it('Case H: USD 200.00 @ 50.50 = EGP 10,100.00 and @ 51.00 = EGP 10,200.00', () => {
    expect(convertMinor(20_000, 2, '50.50', 2)).toBe(1_010_000);
    expect(convertMinor(20_000, 2, '51.00', 2)).toBe(1_020_000);
  });

  it('rounds half-up exactly once', () => {
    expect(convertMinor(1, 2, '0.5', 2)).toBe(1); // 0.005 -> 0.01
    expect(convertMinor(1, 2, '0.49', 2)).toBe(0); // 0.0049 -> 0.00
    expect(convertMinor(333, 2, '3.3333333333', 2)).toBe(1110); // 11.099999... -> 11.10
  });

  it('handles different minor units (KWD 3 decimals -> EGP 2 decimals)', () => {
    expect(convertMinor(1_000, 3, '155.25', 2)).toBe(15_525); // KWD 1.000 -> EGP 155.25
    expect(convertMinor(15_525, 2, '0.0064412238', 3)).toBe(1_000); // back again, rounded
  });

  it('rate 1 between equal minor units is the identity (property)', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1e14 }), (m) => {
      expect(convertMinor(m, 2, '1', 2)).toBe(m);
    }));
  });

  it('is monotonic in the amount (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e10 }), fc.integer({ min: 0, max: 1e6 }), (a, delta) => {
        expect(convertMinor(a + delta, 2, '50.4512', 2)).toBeGreaterThanOrEqual(convertMinor(a, 2, '50.4512', 2));
      }),
    );
  });
});
