import { useState, type FormEvent } from 'react';
import type { SessionUserDto } from '@airdesk/contracts';
import { call } from '../api';
import { useI18n } from '../i18n';

export function LoginPage({ companyName, notice, onSignedIn }: { companyName: string | null; notice: string | null; onSignedIn: (u: SessionUserDto) => void }) {
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
        {error && <div className="alert error" role="alert">{error}</div>}
        <label>{t('username')}<input className="ltr" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label>{t('password')}<input className="ltr" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <div className="actions"><button className="primary" disabled={busy}>{t('signIn')}</button></div>
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
        <label>{t('currentPassword')}<input className="ltr" type="password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>
        <label>{t('newPassword')}<input className="ltr" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required /></label>
        <label>{t('confirmPassword')}<input className="ltr" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label>
        <div className="actions"><button className="primary">{t('save')}</button></div>
      </form>
    </div>
  );
}

const CURRENCIES = ['EGP', 'SAR', 'USD', 'EUR', 'AED', 'KWD'];

export function SetupPage({ onDone }: { onDone: () => void }) {
  const { t, errorMessage, setLocale } = useI18n();
  const [f, setF] = useState({
    legalNameAr: '', legalNameEn: '', baseCurrencyCode: 'EGP', defaultCountryCode: 'EG', timezone: 'Africa/Cairo', defaultLocale: 'ar' as 'ar' | 'en',
    username: '', displayName: '', password: '', confirm: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.password !== f.confirm) return setError(t('passwordsDoNotMatch'));
    setBusy(true);
    setError(null);
    try {
      await call('system.setup', {
        company: {
          legalNameAr: f.legalNameAr, legalNameEn: f.legalNameEn || null, baseCurrencyCode: f.baseCurrencyCode,
          defaultCountryCode: f.defaultCountryCode.toUpperCase(), timezone: f.timezone, defaultLocale: f.defaultLocale,
        },
        admin: { username: f.username, displayName: f.displayName, password: f.password, locale: f.defaultLocale },
      });
      setLocale(f.defaultLocale);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center">
      <form className="card" onSubmit={submit}>
        <h1>{t('setupTitle')}</h1>
        <p className="muted">{t('setupIntro')}</p>
        {error && <div className="alert error">{error}</div>}
        <h2>{t('companySection')}</h2>
        <div className="grid">
          <label>{t('legalNameAr')}<input value={f.legalNameAr} onChange={set('legalNameAr')} required autoFocus /></label>
          <label>{t('legalNameEn')}<input className="ltr" value={f.legalNameEn} onChange={set('legalNameEn')} /></label>
          <label>{t('baseCurrency')}
            <select value={f.baseCurrencyCode} onChange={set('baseCurrencyCode')}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
            <span className="muted">{t('baseCurrencyHint')}</span>
          </label>
          <label>{t('country')}<input className="ltr" maxLength={2} value={f.defaultCountryCode} onChange={set('defaultCountryCode')} required /></label>
          <label>{t('timezone')}<input className="ltr" value={f.timezone} onChange={set('timezone')} required /></label>
          <label>{t('defaultLocale')}
            <select value={f.defaultLocale} onChange={set('defaultLocale')}><option value="ar">العربية</option><option value="en">English</option></select>
          </label>
        </div>
        <h2>{t('adminSection')}</h2>
        <div className="grid">
          <label>{t('username')}<input className="ltr" value={f.username} onChange={set('username')} required /></label>
          <label>{t('displayName')}<input value={f.displayName} onChange={set('displayName')} required /></label>
          <label>{t('password')}<input className="ltr" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required /></label>
          <label>{t('confirmPassword')}<input className="ltr" type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} required /></label>
        </div>
        <div className="actions"><button className="primary" disabled={busy}>{t('finishSetup')}</button></div>
      </form>
    </div>
  );
}
