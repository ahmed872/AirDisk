import { useCallback, useEffect, useState } from 'react';
import type { SessionUserDto, SystemStatusDto } from '@airdesk/contracts';
import { call, onSessionLost } from './api';
import { I18nProvider, useI18n, type Locale } from './i18n';
import { ChangePasswordPage, LoginPage, SetupPage } from './pages/auth';
import { CompanySettingsPage } from './pages/company';
import { SystemPage } from './pages/system';
import { UsersPage } from './pages/users';

export function App() {
  const [status, setStatus] = useState<SystemStatusDto | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const reload = useCallback(() => {
    call<SystemStatusDto>('system.status').then(setStatus, (e: Error) => setBootError(e.message));
  }, []);
  useEffect(reload, [reload]);
  if (bootError) return <div className="center"><div className="alert error">{bootError}</div></div>;
  if (!status) return <div className="center">…</div>;
  return (
    <I18nProvider initial={status.defaultLocale}>
      <Root status={status} reload={reload} />
    </I18nProvider>
  );
}

function Root({ status, reload }: { status: SystemStatusDto; reload: () => void }) {
  const { setLocale } = useI18n();
  const [user, setUser] = useState<SessionUserDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(
    () =>
      onSessionLost(() => {
        setUser(null);
        setNotice('SESSION_EXPIRED');
      }),
    [],
  );

  const signedIn = (u: SessionUserDto) => {
    if (u.locale) setLocale(u.locale as Locale);
    setNotice(null);
    setUser(u);
  };

  if (status.setupRequired) return <SetupPage onDone={reload} />;
  if (!user) return <LoginPage companyName={status.companyName} notice={notice} onSignedIn={signedIn} />;
  if (user.mustChangePassword) return <ChangePasswordPage onDone={() => call<SessionUserDto>('auth.me').then(signedIn)} />;
  return <Shell user={user} onSignedOut={() => setUser(null)} onRestored={() => { setUser(null); reload(); }} />;
}

type Page = 'home' | 'company' | 'users' | 'system';

function Shell({ user, onSignedOut, onRestored }: { user: SessionUserDto; onSignedOut: () => void; onRestored: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const [page, setPage] = useState<Page>('home');
  const can = (p: string) => user.permissions.includes(p);
  const nav: { id: Page; label: string; visible: boolean }[] = [
    { id: 'home', label: t('navHome'), visible: true },
    { id: 'company', label: t('navCompany'), visible: true },
    { id: 'users', label: t('navUsers'), visible: can('user.manage') },
    { id: 'system', label: t('navSystem'), visible: can('backup.create') || can('backup.restore') || can('integrity.run') },
  ];
  const signOut = async () => {
    await call('auth.logout').catch(() => undefined);
    onSignedOut();
  };
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="main">
        <div className="brand">{t('appName')}</div>
        {nav.filter((n) => n.visible).map((n) => (
          <button key={n.id} className={page === n.id ? 'active' : ''} onClick={() => setPage(n.id)}>{n.label}</button>
        ))}
        <div className="spacer" />
        <button onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>{t('language')}</button>
        <button onClick={signOut}>{t('signOut')}</button>
      </nav>
      <main className="main">
        <div className="topbar">
          <strong>{user.displayName}</strong>
          <span className="muted">{user.roles.join(' · ')}</span>
        </div>
        {page === 'home' && (
          <div className="card">
            <h1>{t('welcome')} {user.displayName}</h1>
            <p className="muted">{t('homeIntro')}</p>
            <p>{t('yourRoles')}: {user.roles.join(', ')}</p>
          </div>
        )}
        {page === 'company' && <CompanySettingsPage canEdit={can('settings.company')} canLock={can('finance.lock_period') || can('finance.unlock_period')} />}
        {page === 'users' && <UsersPage />}
        {page === 'system' && <SystemPage canBackup={can('backup.create')} canRestore={can('backup.restore')} canCheck={can('integrity.run')} onRestored={onRestored} />}
      </main>
    </div>
  );
}
