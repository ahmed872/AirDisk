import { useEffect, useState, type FormEvent } from 'react';
import type { SessionUserDto, SystemStatusDto } from '@airdesk/contracts';
import { call } from '../api';
import { useI18n, type TKey } from '../i18n';

export function LoginPage({ companyName, notice, info, onSignedIn }: { companyName: string | null; notice: string | null; info?: TKey | null; onSignedIn: (u: SessionUserDto) => void }) {
  const { t, errorMessage } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(notice ? errorMessage({ code: notice }) : null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ user: SessionUserDto }>('auth.login', { username, password });
      onSignedIn(r.user);
    } catch (err) {
      setError(errorMessage(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center">
      <form className="card narrow" onSubmit={submit}>
        <h1>{companyName ?? t('appName')}</h1>
        <p className="muted">{t('appName')}</p>
        {info && !error && <div className="alert ok" role="status" data-testid="setup-done">{t(info)}</div>}
        {error && <div className="alert error" role="alert">{error}</div>}
        <label>{t('username')}<input className="ltr" data-testid="login-username" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label>{t('password')}<input className="ltr" data-testid="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <div className="actions"><button className="primary" disabled={busy} data-testid="login-submit">{t('signIn')}</button></div>
      </form>
    </div>
  );
}

export function ChangePasswordPage({ onDone }: { onDone: () => void }) {
  const { t, errorMessage } = useI18n();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError(t('passwordsDoNotMatch'));
    try {
      await call('auth.changePassword', { currentPassword: cur, newPassword: next });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <div className="center">
      <form className="card narrow" onSubmit={submit}>
        <h1>{t('changePasswordTitle')}</h1>
        <p className="muted">{t('changePasswordIntro')}</p>
        {error && <div className="alert error">{error}</div>}
        <label>{t('currentPassword')}<input className="ltr" data-testid="cp-current" type="password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>
        <label>{t('newPassword')}<input className="ltr" data-testid="cp-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required /></label>
        <label>{t('confirmPassword')}<input className="ltr" data-testid="cp-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label>
        <div className="actions"><button className="primary" data-testid="cp-submit">{t('save')}</button></div>
      </form>
    </div>
  );
}


import { EMPTY_RECOVERY, RecoveryFields, RestoreOntoPc, type RecoveryValue } from './vault';

export function SetupPage({ onDone, encryptedAlready }: { onDone: () => void; encryptedAlready?: boolean }) {
  const { t, errorMessage, setLocale, locale } = useI18n();
  const [recovery, setRecovery] = useState<RecoveryValue>(EMPTY_RECOVERY);
  const [restoreMode, setRestoreMode] = useState(false);
  const [f, setF] = useState({
    legalNameAr: '', legalNameEn: '', baseCurrencyCode: 'EGP', defaultCountryCode: 'EG', timezone: 'Africa/Cairo', defaultLocale: 'ar' as 'ar' | 'en',
    username: '', displayName: '', password: '', confirm: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [currencies, setCurrencies] = useState<{ code: string; nameAr: string; nameEn: string }[]>([]);
  useEffect(() => { call<SystemStatusDto>('system.status').then((s) => setCurrencies(s.setupCurrencies ?? []), () => setCurrencies([])); }, []);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.password !== f.confirm) return setError(t('passwordsDoNotMatch'));
    if (!encryptedAlready && !recovery.acknowledged) return setError(t('recoveryAck'));
    setBusy(true);
    setError(null);
    try {
      await call('system.setup', {
        company: {
          legalNameAr: f.legalNameAr, legalNameEn: f.legalNameEn || null, baseCurrencyCode: f.baseCurrencyCode,
          defaultCountryCode: f.defaultCountryCode.toUpperCase(), timezone: f.timezone, defaultLocale: f.defaultLocale,
        },
        admin: { username: f.username, displayName: f.displayName, password: f.password, locale: f.defaultLocale },
        ...(encryptedAlready ? {} : { recovery: { passphrase: recovery.passphrase, confirmation: recovery.confirmation } }),
      });
      setLocale(f.defaultLocale);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (restoreMode) return <RestoreOntoPc onDone={onDone} onBack={() => setRestoreMode(false)} />;
  return (
    <div className="center">
      <form className="card" onSubmit={submit}>
        <h1>{t('setupTitle')}</h1>
        <p className="muted">{t('setupIntro')}</p>
        {!encryptedAlready && <p className="hint">{t('newCompanyOrRestore')} <button type="button" className="link" onClick={() => setRestoreMode(true)} data-testid="setup-restore-instead">{t('restoreInstead')}</button></p>}
        {error && <div className="alert error" role="alert">{error}</div>}
        <h2>{t('setupStep1')}</h2>
        <div className="grid">
          <label>{t('legalNameAr')}<input data-testid="setup-legalNameAr" value={f.legalNameAr} onChange={set('legalNameAr')} required autoFocus /></label>
          <label>{t('legalNameEn')}<input className="ltr" data-testid="setup-legalNameEn" value={f.legalNameEn} onChange={set('legalNameEn')} /></label>
          <label>{t('baseCurrency')}
            <select data-testid="setup-currency" value={f.baseCurrencyCode} onChange={set('baseCurrencyCode')}>{(currencies.length ? currencies : [{ code: 'EGP', nameAr: '', nameEn: '' }]).map((c) => <option key={c.code} value={c.code}>{c.code}{c.nameEn ? ` — ${locale === 'ar' ? c.nameAr : c.nameEn}` : ''}</option>)}</select>
            <span className="muted">{t('baseCurrencyHint')}</span>
          </label>
          <label>{t('country')}<input className="ltr" data-testid="setup-country" maxLength={2} value={f.defaultCountryCode} onChange={set('defaultCountryCode')} required /></label>
          <label>{t('timezone')}<input className="ltr" data-testid="setup-timezone" list="setup-timezones" value={f.timezone} onChange={set('timezone')} required />
            <datalist id="setup-timezones">{['Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Muscat', 'Asia/Amman', 'Asia/Baghdad', 'Asia/Beirut', 'Africa/Tripoli', 'Africa/Tunis', 'Africa/Algiers', 'Africa/Casablanca', 'Africa/Khartoum', 'Europe/Istanbul', 'Europe/London'].map((z) => <option key={z} value={z} />)}</datalist></label>
          <label>{t('defaultLocale')}
            <select value={f.defaultLocale} onChange={set('defaultLocale')}><option value="ar">العربية</option><option value="en">English</option></select>
          </label>
        </div>
        <h2>{t('setupStep2')}</h2>
        <p className="hint">{t('passwordRule')}</p>
        <div className="grid">
          <label>{t('username')}<input className="ltr" data-testid="setup-username" value={f.username} onChange={set('username')} required /></label>
          <label>{t('displayName')}<input data-testid="setup-displayName" value={f.displayName} onChange={set('displayName')} required /></label>
          <label>{t('password')}<input className="ltr" data-testid="setup-password" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required /></label>
          <label>{t('confirmPassword')}<input className="ltr" data-testid="setup-confirm" type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} required /></label>
        </div>
        {!encryptedAlready && (<><h2>{t('recoveryTitle')}</h2><RecoveryFields value={recovery} onChange={setRecovery} /></>)}
        <div className="actions"><button className="primary" disabled={busy} data-testid="setup-submit">{t('finishSetup')}</button></div>
        {busy && <div className="alert info" role="status">{t('workingPleaseWait')}</div>}
      </form>
    </div>
  );
}
