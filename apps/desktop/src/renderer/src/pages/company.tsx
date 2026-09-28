import { useState, type ChangeEvent, type ReactNode } from 'react';
import type { CompanyProfileDto, CurrencyDto } from '@airdesk/contracts';
import { call } from '../api';
import { Alert, FormFields, LoadError, PageHeader, useLoader, type FieldDef, type FormValues } from '../components';
import { useI18n, type FieldIssue, type TKey } from '../i18n';

type Can = (p: string) => boolean;

/**
 * White-label company configuration (Q13, Phase 2 §2). Three sections, each
 * gated by its own permission; the backend re-checks every changed group.
 */
export function CompanySettingsPage({ can, onChanged }: { can: Can; onChanged: (p: CompanyProfileDto) => void }) {
  const { t, locale, errorMessage, fieldIssues } = useI18n();
  const company = useLoader(() => call<CompanyProfileDto>('company.get'), []);
  const currencies = useLoader(() => call<CurrencyDto[]>('currency.list').catch(() => [] as CurrencyDto[]), []);
  if (company.error) return <div className="page"><LoadError error={company.error} onRetry={company.reload} /></div>;
  if (!company.data || !currencies.data) return <div className="page">{t('loading')}</div>;
  return (
    <CompanyForm key={company.data.rowVersion} profile={company.data} currencies={currencies.data} can={can}
      t={t} locale={locale} errorMessage={errorMessage} fieldIssues={fieldIssues}
      onSaved={(p) => { onChanged(p); company.reload(); }} />
  );
}

const PROFILE_KEYS = [
  'legalNameAr', 'legalNameEn', 'tradeNameAr', 'tradeNameEn', 'addressAr', 'addressEn', 'phonePrimary', 'phoneSecondary', 'email', 'website',
  'taxRegistrationNo', 'commercialRegistrationNo', 'iataAgencyCode', 'baseCurrencyCode', 'defaultCountryCode', 'timezone', 'defaultLocale',
  'documentFooterAr', 'documentFooterEn', 'invoiceTitleAr', 'invoiceTitleEn', 'invoiceTermsAr', 'invoiceTermsEn', 'dateFormat', 'numberFormat', 'textDirection',
] as const;

function CompanyForm({ profile, currencies, can, t, locale, errorMessage, fieldIssues, onSaved }: {
  profile: CompanyProfileDto; currencies: CurrencyDto[]; can: Can; t: (k: TKey) => string; locale: 'ar' | 'en';
  errorMessage: (e: unknown) => string; fieldIssues: (e: unknown) => FieldIssue[]; onSaved: (p: CompanyProfileDto) => void;
}) {
  const [values, setValues] = useState<FormValues>(() => Object.fromEntries(PROFILE_KEYS.map((k) => [k, (profile[k] as string | null) ?? ''])));
  const [logo, setLogo] = useState<{ data: string | null; mime: CompanyProfileDto['logoMime'] }>({ data: profile.logoBase64, mime: profile.logoMime });
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lock, setLock] = useState({ date: profile.financialLockDate ?? '', reason: '' });
  const canGeneral = can('company.edit');
  const canBrand = can('company.branding');
  const canFin = can('company.financial_config');
  const anyEdit = canGeneral || canBrand || canFin;

  const general: FieldDef[] = [
    { name: 'legalNameAr', label: 'legalNameAr', required: true, maxLength: 200 },
    { name: 'legalNameEn', label: 'legalNameEn', ltr: true, maxLength: 200 },
    { name: 'addressAr', label: 'addressAr', maxLength: 500 },
    { name: 'addressEn', label: 'addressEn', ltr: true, maxLength: 500 },
    { name: 'phonePrimary', label: 'phoneNumber', kind: 'tel', ltr: true, maxLength: 40 },
    { name: 'phoneSecondary', label: 'phoneSecondary', kind: 'tel', ltr: true, maxLength: 40 },
    { name: 'email', label: 'email', kind: 'email', ltr: true, maxLength: 200 },
    { name: 'website', label: 'website', ltr: true, maxLength: 200 },
    { name: 'defaultCountryCode', label: 'country', ltr: true, required: true, maxLength: 2, upper: true },
    { name: 'timezone', label: 'timezone', ltr: true, required: true, maxLength: 64 },
    { name: 'defaultLocale', label: 'defaultLocale', kind: 'select', options: [{ value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }] },
    { name: 'dateFormat', label: 'dateFormat', kind: 'select', options: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'].map((v) => ({ value: v, label: v })) },
    { name: 'numberFormat', label: 'numberFormat', kind: 'select', options: [{ value: 'LATIN', label: t('numLatin') }, { value: 'ARABIC_INDIC', label: t('numArabic') }] },
    { name: 'textDirection', label: 'textDirection', kind: 'select', options: [{ value: 'AUTO', label: t('dirAuto') }, { value: 'RTL', label: t('dirRtl') }, { value: 'LTR', label: t('dirLtr') }] },
  ];
  const branding: FieldDef[] = [
    { name: 'tradeNameAr', label: 'tradeNameAr', maxLength: 200 },
    { name: 'tradeNameEn', label: 'tradeNameEn', ltr: true, maxLength: 200 },
    { name: 'documentFooterAr', label: 'footerAr', kind: 'textarea', maxLength: 1000 },
    { name: 'documentFooterEn', label: 'footerEn', kind: 'textarea', ltr: true, maxLength: 1000 },
  ];
  const financial: FieldDef[] = [
    {
      name: 'baseCurrencyCode', label: 'baseCurrency', kind: 'select', hint: 'baseCurrencyHint',
      // Once frozen (financial postings exist) only the current currency is offered.
      options: currencies.filter((c) => (profile.baseCurrencyFrozen ? c.code === profile.baseCurrencyCode : c.isActive || c.code === profile.baseCurrencyCode)).map((c) => ({ value: c.code, label: `${c.code} — ${locale === 'ar' ? c.nameAr : c.nameEn}` })),
    },
    { name: 'taxRegistrationNo', label: 'taxNumber', ltr: true, maxLength: 60 },
    { name: 'commercialRegistrationNo', label: 'crNumber', ltr: true, maxLength: 60 },
    { name: 'iataAgencyCode', label: 'iataAgencyCode', ltr: true, maxLength: 20 },
    { name: 'invoiceTitleAr', label: 'invoiceTitleAr', maxLength: 200 },
    { name: 'invoiceTitleEn', label: 'invoiceTitleEn', ltr: true, maxLength: 200 },
    { name: 'invoiceTermsAr', label: 'invoiceTermsAr', kind: 'textarea', maxLength: 2000 },
    { name: 'invoiceTermsEn', label: 'invoiceTermsEn', kind: 'textarea', ltr: true, maxLength: 2000 },
  ];

  const onLogo = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!['image/png', 'image/jpeg'].includes(f.type) || f.size > 512 * 1024) {
      setMsg({ ok: false, text: t('logoHint') });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogo({ data: String(reader.result).split(',')[1] ?? null, mime: f.type as 'image/png' | 'image/jpeg' });
    reader.readAsDataURL(f);
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    setIssues([]);
    const p: Record<string, unknown> = {};
    for (const k of PROFILE_KEYS) p[k] = values[k]?.trim() === '' ? null : values[k]?.trim();
    p.logoBase64 = logo.data;
    p.logoMime = logo.data ? logo.mime : null;
    try {
      const saved = await call<CompanyProfileDto>('company.update', { profile: p, rowVersion: profile.rowVersion });
      setMsg({ ok: true, text: t('saved') });
      onSaved(saved);
    } catch (e) {
      setIssues(fieldIssues(e));
      setMsg({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const saveLock = async () => {
    try {
      await call('company.setLockDate', { lockDate: lock.date, reason: lock.reason || null });
      setMsg({ ok: true, text: t('saved') });
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    }
  };
  const section = (title: TKey, defs: FieldDef[], allowed: boolean, id: string, extra?: ReactNode) => (
    <section className="card section" data-testid={`company-${id}`}>
      <h2>{t(title)}</h2>
      {!allowed && <p className="hint">{t('sectionReadOnly')}</p>}
      <FormFields defs={defs}
        values={values} onChange={setValues} issues={issues} disabled={!allowed} />
      {extra}
    </section>
  );
  return (
    <div className="page" data-testid="page-company">
      <PageHeader title={t('navCompany')}>
        {anyEdit && <button className="primary" onClick={save} disabled={busy} data-testid="save-company">{t('save')}</button>}
      </PageHeader>
      {msg && <Alert kind={msg.ok ? 'ok' : 'error'}>{msg.text}</Alert>}
      {section('sectionGeneral', general, canGeneral, 'general')}
      {section('sectionBranding', branding, canBrand, 'branding', (
        <div className="logo-row">
          <span>{t('logo')}</span>
          {logo.data && <img src={`data:${logo.mime};base64,${logo.data}`} alt={t('logo')} className="logo-preview" />}
          {canBrand && <input type="file" accept="image/png,image/jpeg" onChange={onLogo} aria-label={t('logo')} />}
          {canBrand && logo.data && <button type="button" onClick={() => setLogo({ data: null, mime: null })}>{t('removeLogo')}</button>}
          <span className="hint">{t('logoHint')}</span>
        </div>
      ))}
      {section('sectionFinancial', financial, canFin, 'financial', profile.baseCurrencyFrozen ? <p className="hint">{t('baseCurrencyHint')}</p> : null)}
      {(can('finance.lock_period') || can('finance.unlock_period')) && (
        <section className="card section">
          <h2>{t('lockDate')}</h2>
          <div className="grid">
            <label>{t('lockDate')}<input className="ltr" type="date" value={lock.date} onChange={(e) => setLock({ ...lock, date: e.target.value })} /></label>
            <label>{t('reason')}<input value={lock.reason} onChange={(e) => setLock({ ...lock, reason: e.target.value })} /></label>
          </div>
          <div className="actions"><button type="button" onClick={saveLock} disabled={!lock.date}>{t('save')}</button></div>
        </section>
      )}
    </div>
  );
}
