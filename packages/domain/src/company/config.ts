/**
 * Company configuration (owner requirement §2, white label Q13). Fields are
 * grouped by the permission needed to change them, so e.g. a user allowed to
 * change the logo cannot change the base currency or tax identity.
 */
export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const NUMBER_FORMATS = ['LATIN', 'ARABIC_INDIC'] as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[number];

/** AUTO = follow the user's language (Arabic → RTL, English → LTR). */
export const TEXT_DIRECTIONS = ['AUTO', 'RTL', 'LTR'] as const;
export type TextDirection = (typeof TEXT_DIRECTIONS)[number];

export const COMPANY_FIELD_GROUPS = {
  /** company.edit */
  general: [
    'legalNameAr', 'legalNameEn', 'addressAr', 'addressEn', 'phonePrimary', 'phoneSecondary', 'email', 'website',
    'defaultCountryCode', 'timezone', 'defaultLocale', 'dateFormat', 'numberFormat', 'textDirection',
  ],
  /** company.branding */
  branding: ['tradeNameAr', 'tradeNameEn', 'logoBase64', 'logoMime', 'documentFooterAr', 'documentFooterEn'],
  /** company.financial_config — tax identity, invoice identity and currency */
  financial: [
    'baseCurrencyCode', 'taxRegistrationNo', 'commercialRegistrationNo', 'iataAgencyCode',
    'invoiceTitleAr', 'invoiceTitleEn', 'invoiceTermsAr', 'invoiceTermsEn',
  ],
} as const;

export type CompanyFieldGroup = keyof typeof COMPANY_FIELD_GROUPS;

export const COMPANY_GROUP_PERMISSION: Readonly<Record<CompanyFieldGroup, string>> = {
  general: 'company.edit',
  branding: 'company.branding',
  financial: 'company.financial_config',
};

/** Which permission groups a change touches (compared with normalised values). */
export function changedCompanyGroups(before: Record<string, unknown>, after: Record<string, unknown>): CompanyFieldGroup[] {
  const norm = (v: unknown) => (v === undefined || v === '' ? null : v);
  return (Object.keys(COMPANY_FIELD_GROUPS) as CompanyFieldGroup[]).filter((g) =>
    COMPANY_FIELD_GROUPS[g].some((f) => norm(before[f]) !== norm(after[f])),
  );
}
