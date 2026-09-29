/**
 * CSV export helpers (pure, unit-tested). Text cells that a spreadsheet would
 * treat as a formula (=, +, -, @, tab, CR) are prefixed with an apostrophe so
 * an exported customer or supplier name can never run as a formula (CSV
 * injection). Money is written as a plain number with the currency's own
 * number of decimals.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvText(value: unknown): string {
  const s = String(value ?? '');
  const safe = FORMULA_START.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function csvMoney(minor: number, decimals: number): string {
  if (!Number.isFinite(minor)) return '""';
  const negative = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const unit = 10 ** decimals;
  const whole = Math.floor(abs / unit);
  const frac = decimals > 0 ? `.${String(abs % unit).padStart(decimals, '0')}` : '';
  return `${negative ? '-' : ''}${whole}${frac}`;
}

export function csvDocument(header: string[], rows: string[][]): string {
  return [header.map(csvText).join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}
