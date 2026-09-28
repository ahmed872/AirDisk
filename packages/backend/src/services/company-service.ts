import { DomainError, ErrorCode, businessDate, classifyLockDateChange, isValidTimeZone } from '@airdesk/domain';
import type { CompanyProfileDto, CompanyProfileInput } from '@airdesk/contracts';
import { actorOf, requirePermission, tx, type Actor, type ServiceDeps } from './context';

interface CompanyRow {
  legal_name_ar: string;
  legal_name_en: string | null;
  trade_name_ar: string | null;
  trade_name_en: string | null;
  logo: Buffer | null;
  logo_mime: string | null;
  address_ar: string | null;
  address_en: string | null;
  phone_primary: string | null;
  phone_secondary: string | null;
  email: string | null;
  website: string | null;
  tax_registration_no: string | null;
  commercial_registration_no: string | null;
  iata_agency_code: string | null;
  base_currency_code: string;
  default_country_code: string;
  timezone: string;
  default_locale: 'ar' | 'en';
  financial_lock_date: string | null;
  document_footer_ar: string | null;
  document_footer_en: string | null;
  row_version: number;
}

export interface CompanyCore {
  baseCurrency: string;
  timezone: string;
  lockDate: string | null;
  legalNameAr: string;
}

const MAX_LOGO_BYTES = 512 * 1024;

/**
 * White-label company profile (owner decision Q13). Nothing about the
 * operating company is hard-coded anywhere; everything comes from here.
 */
export class CompanyService {
  constructor(private readonly deps: ServiceDeps) {}

  exists(): boolean {
    return !!this.deps.db.prepare('SELECT 1 FROM company_profile WHERE id = 1').get();
  }

  core(): CompanyCore {
    const row = this.deps.db
      .prepare('SELECT base_currency_code, timezone, financial_lock_date, legal_name_ar FROM company_profile WHERE id = 1')
      .get() as { base_currency_code: string; timezone: string; financial_lock_date: string | null; legal_name_ar: string } | undefined;
    if (!row) throw new DomainError(ErrorCode.SETUP_REQUIRED, 'Company setup has not been completed');
    return { baseCurrency: row.base_currency_code, timezone: row.timezone, lockDate: row.financial_lock_date, legalNameAr: row.legal_name_ar };
  }

  today(): string {
    return businessDate(this.deps.clock.now(), this.core().timezone);
  }

  baseCurrencyFrozen(): boolean {
    return !!this.deps.db.prepare('SELECT 1 FROM journal_entry LIMIT 1').get();
  }

  get(): CompanyProfileDto {
    const r = this.deps.db.prepare('SELECT * FROM company_profile WHERE id = 1').get() as CompanyRow | undefined;
    if (!r) throw new DomainError(ErrorCode.SETUP_REQUIRED, 'Company setup has not been completed');
    return {
      legalNameAr: r.legal_name_ar,
      legalNameEn: r.legal_name_en,
      tradeNameAr: r.trade_name_ar,
      tradeNameEn: r.trade_name_en,
      addressAr: r.address_ar,
      addressEn: r.address_en,
      phonePrimary: r.phone_primary,
      phoneSecondary: r.phone_secondary,
      email: r.email,
      website: r.website,
      taxRegistrationNo: r.tax_registration_no,
      commercialRegistrationNo: r.commercial_registration_no,
      iataAgencyCode: r.iata_agency_code,
      baseCurrencyCode: r.base_currency_code,
      baseCurrencyFrozen: this.baseCurrencyFrozen(),
      defaultCountryCode: r.default_country_code,
      timezone: r.timezone,
      defaultLocale: r.default_locale,
      financialLockDate: r.financial_lock_date,
      documentFooterAr: r.document_footer_ar,
      documentFooterEn: r.document_footer_en,
      logoBase64: r.logo ? r.logo.toString('base64') : null,
      logoMime: r.logo_mime,
      rowVersion: r.row_version,
    };
  }

  /** Used only by the first-run setup (inside its transaction). */
  insertInitial(input: CompanyProfileInput, userId: string | null): void {
    const v = this.validate(input);
    this.deps.db
      .prepare(
        `INSERT INTO company_profile (id, legal_name_ar, legal_name_en, trade_name_ar, trade_name_en, logo, logo_mime, address_ar, address_en,
           phone_primary, phone_secondary, email, website, tax_registration_no, commercial_registration_no, iata_agency_code,
           base_currency_code, default_country_code, timezone, default_locale, document_footer_ar, document_footer_en, updated_at, updated_by)
         VALUES (1, @legalNameAr, @legalNameEn, @tradeNameAr, @tradeNameEn, @logo, @logoMime, @addressAr, @addressEn,
           @phonePrimary, @phoneSecondary, @email, @website, @taxRegistrationNo, @commercialRegistrationNo, @iataAgencyCode,
           @baseCurrencyCode, @defaultCountryCode, @timezone, @defaultLocale, @documentFooterAr, @documentFooterEn, @now, @userId)`,
      )
      .run({ ...v, now: this.deps.clock.now().toISOString(), userId });
  }

  update(actor: Actor, input: CompanyProfileInput, rowVersion: number): CompanyProfileDto {
    requirePermission(this.deps, actor, 'settings.company', 'company.update');
    const v = this.validate(input);
    return tx(this.deps, () => {
      const before = this.get();
      if (before.rowVersion !== rowVersion) throw new DomainError(ErrorCode.STALE_RECORD, 'Company settings were changed by someone else');
      if (v.baseCurrencyCode !== before.baseCurrencyCode && before.baseCurrencyFrozen) {
        throw new DomainError(ErrorCode.BASE_CURRENCY_FROZEN, 'The base currency cannot change after financial documents exist');
      }
      this.deps.db
        .prepare(
          `UPDATE company_profile SET legal_name_ar=@legalNameAr, legal_name_en=@legalNameEn, trade_name_ar=@tradeNameAr, trade_name_en=@tradeNameEn,
             logo=@logo, logo_mime=@logoMime, address_ar=@addressAr, address_en=@addressEn, phone_primary=@phonePrimary,
             phone_secondary=@phoneSecondary, email=@email, website=@website, tax_registration_no=@taxRegistrationNo,
             commercial_registration_no=@commercialRegistrationNo, iata_agency_code=@iataAgencyCode, base_currency_code=@baseCurrencyCode,
             default_country_code=@defaultCountryCode, timezone=@timezone, default_locale=@defaultLocale,
             document_footer_ar=@documentFooterAr, document_footer_en=@documentFooterEn,
             updated_at=@now, updated_by=@userId, row_version = row_version + 1
           WHERE id = 1 AND row_version = @rowVersion`,
        )
        .run({ ...v, now: this.deps.clock.now().toISOString(), userId: actor.userId, rowVersion });
      const after = this.get();
      this.deps.audit.append(actorOf(actor), {
        action: 'settings.company_updated',
        entityType: 'company_profile',
        entityId: '1',
        before: withoutLogo(before),
        after: withoutLogo(after),
      });
      return after;
    });
  }

  /**
   * Moves the financial lock date (BR-IMM-06). Locking needs finance.lock_period;
   * re-opening a period needs finance.unlock_period and a reason.
   */
  setLockDate(actor: Actor, lockDate: string, reason: string | null | undefined): CompanyProfileDto {
    const current = this.core().lockDate;
    const change = classifyLockDateChange(current, lockDate);
    if (change === 'UNCHANGED') return this.get();
    if (change === 'LOCK') requirePermission(this.deps, actor, 'finance.lock_period', 'company.setLockDate');
    else {
      requirePermission(this.deps, actor, 'finance.unlock_period', 'company.setLockDate');
      if (!reason || reason.trim().length < 5) throw new DomainError(ErrorCode.VALIDATION, 'Re-opening a locked period requires a reason');
    }
    return tx(this.deps, () => {
      this.deps.db
        .prepare('UPDATE company_profile SET financial_lock_date = ?, updated_at = ?, updated_by = ?, row_version = row_version + 1 WHERE id = 1')
        .run(lockDate, this.deps.clock.now().toISOString(), actor.userId);
      this.deps.audit.append(actorOf(actor), {
        action: change === 'LOCK' ? 'period.locked' : 'period.unlocked',
        entityType: 'company_profile',
        entityId: '1',
        before: { financialLockDate: current },
        after: { financialLockDate: lockDate },
        metadata: reason ? { reason } : undefined,
      });
      return this.get();
    });
  }

  private validate(input: CompanyProfileInput) {
    if (!isValidTimeZone(input.timezone)) throw new DomainError(ErrorCode.VALIDATION, `Unknown timezone ${input.timezone}`);
    const cur = this.deps.db.prepare('SELECT is_active FROM currency WHERE code = ?').get(input.baseCurrencyCode) as { is_active: number } | undefined;
    if (!cur || cur.is_active !== 1) throw new DomainError(ErrorCode.VALIDATION, `Unknown currency ${input.baseCurrencyCode}`);
    let logo: Buffer | null = null;
    if (input.logoBase64) {
      if (!input.logoMime) throw new DomainError(ErrorCode.VALIDATION, 'Logo type is required');
      logo = Buffer.from(input.logoBase64, 'base64');
      if (logo.length === 0 || logo.length > MAX_LOGO_BYTES) throw new DomainError(ErrorCode.VALIDATION, 'Logo must be under 512 KB');
    }
    const n = (s: string | null | undefined) => (s && s.trim() !== '' ? s.trim() : null);
    return {
      legalNameAr: input.legalNameAr.trim(),
      legalNameEn: n(input.legalNameEn),
      tradeNameAr: n(input.tradeNameAr),
      tradeNameEn: n(input.tradeNameEn),
      logo,
      logoMime: logo ? input.logoMime! : null,
      addressAr: n(input.addressAr),
      addressEn: n(input.addressEn),
      phonePrimary: n(input.phonePrimary),
      phoneSecondary: n(input.phoneSecondary),
      email: n(input.email),
      website: n(input.website),
      taxRegistrationNo: n(input.taxRegistrationNo),
      commercialRegistrationNo: n(input.commercialRegistrationNo),
      iataAgencyCode: n(input.iataAgencyCode),
      baseCurrencyCode: input.baseCurrencyCode,
      defaultCountryCode: input.defaultCountryCode,
      timezone: input.timezone,
      defaultLocale: input.defaultLocale,
      documentFooterAr: n(input.documentFooterAr),
      documentFooterEn: n(input.documentFooterEn),
    };
  }
}

function withoutLogo(p: CompanyProfileDto) {
  const { logoBase64, ...rest } = p;
  return { ...rest, logoBytes: logoBase64 ? Buffer.from(logoBase64, 'base64').length : 0 };
}
