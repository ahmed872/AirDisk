import { DomainError, ErrorCode } from '../errors';

export type CurrencyCode = string;

export interface CurrencyInfo {
  readonly code: CurrencyCode;
  /** Number of decimal places of the minor unit (EGP/SAR/USD/EUR = 2, KWD = 3, JPY = 0). */
  readonly minorUnit: number;
}

const CODE_RE = /^[A-Z]{3}$/;

export function assertCurrencyCode(code: string): CurrencyCode {
  if (!CODE_RE.test(code)) throw new DomainError(ErrorCode.VALIDATION, `Invalid currency code: ${code}`, { code });
  return code;
}

export function assertMinorUnit(minorUnit: number): number {
  if (!Number.isInteger(minorUnit) || minorUnit < 0 || minorUnit > 4) {
    throw new DomainError(ErrorCode.VALIDATION, `Invalid currency minor unit: ${minorUnit}`, { minorUnit });
  }
  return minorUnit;
}

/**
 * Currencies seeded on a new installation. Market-neutral: the base currency is
 * chosen per company at setup; nothing here assumes Egypt or Saudi Arabia.
 */
export const SEED_CURRENCIES: ReadonlyArray<CurrencyInfo & { nameAr: string; nameEn: string; symbol: string }> = [
  { code: 'EGP', minorUnit: 2, nameAr: 'جنيه مصري', nameEn: 'Egyptian Pound', symbol: 'ج.م' },
  { code: 'SAR', minorUnit: 2, nameAr: 'ريال سعودي', nameEn: 'Saudi Riyal', symbol: 'ر.س' },
  { code: 'USD', minorUnit: 2, nameAr: 'دولار أمريكي', nameEn: 'US Dollar', symbol: '$' },
  { code: 'EUR', minorUnit: 2, nameAr: 'يورو', nameEn: 'Euro', symbol: '€' },
  { code: 'AED', minorUnit: 2, nameAr: 'درهم إماراتي', nameEn: 'UAE Dirham', symbol: 'د.إ' },
  { code: 'KWD', minorUnit: 3, nameAr: 'دينار كويتي', nameEn: 'Kuwaiti Dinar', symbol: 'د.ك' },
];
