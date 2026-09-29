import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { csvDocument, csvMoney, csvText } from '../src/renderer/src/csv';

describe('CSV export', () => {
  it('neutralises spreadsheet formulas in text cells (CSV injection)', () => {
    for (const evil of ['=HYPERLINK("http://x","click")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
      expect(csvText(evil).startsWith(`"'`)).toBe(true);
    }
    expect(csvText('أحمد علي')).toBe('"أحمد علي"');
    expect(csvText('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvText(null)).toBe('""');
  });

  it('writes money exactly, with the currency decimals and sign', () => {
    expect(csvMoney(1_050_000, 2)).toBe('10500.00');
    expect(csvMoney(-5, 2)).toBe('-0.05');
    expect(csvMoney(1_234_567, 3)).toBe('1234.567');
    expect(csvMoney(500, 0)).toBe('500');
    fc.assert(fc.property(fc.integer({ min: -9e12, max: 9e12 }), fc.integer({ min: 0, max: 3 }), (minor, d) => {
      expect(Math.round(Number(csvMoney(minor, d)) * 10 ** d)).toBe(minor);
    }));
  });

  it('builds a CRLF document with a quoted header', () => {
    expect(csvDocument(['Name', 'Amount'], [[csvText('A'), csvMoney(100, 2)]])).toBe('"Name","Amount"\r\n"A",1.00');
  });
});
