import { useEffect, useState, type FormEvent } from 'react';
import type { CompanyProfileDto } from '@airdesk/contracts';
import { call } from '../api';
import { useI18n } from '../i18n';

/** White-label company profile (Q13). Read-only unless the user holds settings.company. */
export function CompanySettingsPage({ canEdit, canLock }: { canEdit: boolean; canLock: boolean }) {
  const { t, errorMessage } = useI18n();
  const [p, setP] = useState<CompanyProfileDto | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [lockDate, setLockDate] = useState('');
  const [lockReason, setLockReason] = useState('');

  const load = () => call<CompanyProfileDto>('company.get').then((x) => { setP(x); setLockDate(x.financialLockDate ?? ''); });
  useEffect(() => { void load(); }, []);
  if (!p) return <div>{t('loading')}</div>;

  const set = (k: keyof CompanyProfileDto) => (e: { target: { value: string } }) => setP({ ...p, [k]: e.target.value });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const { rowVersion, baseCurrencyFrozen: _f, financialLockDate: _l, ...profile } = p;
    try {
      setP(await call<CompanyProfileDto>('company.update', { profile, rowVersion }));
      setMsg({ ok: true, text: t('saved') });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  };
  const saveLock = async () => {
    try {
      setP(await call<CompanyProfileDto>('company.setLockDate', { lockDate, reason: lockReason || null }));
      setMsg({ ok: true, text: t('saved') });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  };
  const field = (k: keyof CompanyProfileDto, label: string, ltr = false) => (
    <label>{label}<input className={ltr ? 'ltr' : ''} value={(p[k] as string | null) ?? ''} onChange={set(k)} disabled={!canEdit} /></label>
  );
  return (
    <form className="card" onSubmit={save}>
      <h1>{t('navCompany')}</h1>
      {msg && <div className={`alert ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</div>}
      <div className="grid">
        {field('legalNameAr', t('legalNameAr'))}
        {field('legalNameEn', t('legalNameEn'), true)}
        {field('phonePrimary', t('phoneNumber'), true)}
        {field('email', t('email'), true)}
        {field('addressAr', t('address'))}
        {field('taxRegistrationNo', t('taxNumber'), true)}
        {field('commercialRegistrationNo', t('crNumber'), true)}
        <label>{t('baseCurrency')}<input className="ltr" value={p.baseCurrencyCode} onChange={set('baseCurrencyCode')} disabled={!canEdit || p.baseCurrencyFrozen} /></label>
        {field('timezone', t('timezone'), true)}
      </div>
      {canEdit && <div className="actions"><button className="primary">{t('save')}</button></div>}
      {canLock && (
        <>
          <h2>{t('lockDate')}</h2>
          <div className="grid">
            <label>{t('lockDate')}<input className="ltr" type="date" value={lockDate} onChange={(e) => setLockDate(e.target.value)} /></label>
            <label>Reason / السبب<input value={lockReason} onChange={(e) => setLockReason(e.target.value)} /></label>
          </div>
          <div className="actions"><button type="button" onClick={saveLock} disabled={!lockDate}>{t('save')}</button></div>
        </>
      )}
    </form>
  );
}
