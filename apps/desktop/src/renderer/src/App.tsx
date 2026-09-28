import { useCallback, useEffect, useState } from 'react';
import type { CompanyProfileDto, SessionUserDto, SystemStatusDto } from '@airdesk/contracts';
import { call, onSessionLost } from './api';
import { I18nProvider, useI18n, type Locale, type TKey } from './i18n';
import { DEFAULT_PREFS, PrefsProvider, type DisplayPrefs } from './prefs';
import { AuditPage } from './pages/audit';
import { ChangePasswordPage, LoginPage, SetupPage } from './pages/auth';
import { CompanySettingsPage } from './pages/company';
import { ComingSoonPage, DashboardPage } from './pages/dashboard';
import { AirlinesPage, CustomersPage, SuppliersPage } from './pages/parties';
import { SystemPage } from './pages/system';
import { UsersRolesPage } from './pages/users';

export function App() {
  const [status, setStatus] = useState<SystemStatusDto | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const reload = useCallback(() => {
    call<SystemStatusDto>('system.status').then(setStatus, (e: Error) => setBootError(e.message));
  }, []);
  useEffect(reload, [reload]);
  if (bootError) return <div className="center"><div className="alert error" role="alert">{bootError}</div></div>;
  if (!status) return <div className="center">…</div>;
  return (
    <I18nProvider initial={status.defaultLocale}>
      <Root status={status} reload={reload} />
    </I18nProvider>
  );
}

const pickPrefs = (p: CompanyProfileDto): DisplayPrefs => ({
  dateFormat: p.dateFormat, numberFormat: p.numberFormat, textDirection: p.textDirection, timezone: p.timezone, baseCurrencyCode: p.baseCurrencyCode,
});

function Root({ status, reload }: { status: SystemStatusDto; reload: () => void }) {
  const { setLocale } = useI18n();
  const [user, setUser] = useState<SessionUserDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<DisplayPrefs>(DEFAULT_PREFS);
  const [justSetUp, setJustSetUp] = useState(false);

  useEffect(
    () =>
      onSessionLost(() => {
        setUser(null);
        setNotice('SESSION_EXPIRED');
      }),
    [],
  );
  useEffect(() => {
    if (!user || user.mustChangePassword) return;
    call<CompanyProfileDto>('company.get').then((p) => setPrefs(pickPrefs(p)), () => setPrefs(DEFAULT_PREFS));
  }, [user]);

  const signedIn = (u: SessionUserDto) => {
    if (u.locale) setLocale(u.locale as Locale);
    setNotice(null);
    setJustSetUp(false);
    setUser(u);
  };

  let content;
  if (status.setupRequired) content = <SetupPage onDone={() => { setJustSetUp(true); reload(); }} />;
  else if (!user) content = <LoginPage companyName={status.companyName} notice={notice} info={justSetUp ? 'setupDone' : null} onSignedIn={signedIn} />;
  else if (user.mustChangePassword) content = <ChangePasswordPage onDone={() => call<SessionUserDto>('auth.me').then(signedIn)} />;
  else content = <Shell user={user} onPrefs={(p) => setPrefs(pickPrefs(p))} onSignedOut={() => setUser(null)} onRestored={() => { setUser(null); reload(); }} />;
  return <PrefsProvider prefs={prefs}>{content}</PrefsProvider>;
}

type Page = 'dashboard' | 'customers' | 'suppliers' | 'airlines' | 'bookings' | 'finance' | 'reports' | 'users' | 'company' | 'audit' | 'system';
interface NavItem { id: Page; label: TKey; visible: boolean; soon?: boolean }

function Shell({ user, onPrefs, onSignedOut, onRestored }: {
  user: SessionUserDto; onPrefs: (p: CompanyProfileDto) => void; onSignedOut: () => void; onRestored: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const [page, setPage] = useState<Page>('dashboard');
  const can = (p: string) => user.permissions.includes(p);
  // Menus mirror permissions for convenience only; the backend authorizes every command.
  const main: NavItem[] = [
    { id: 'dashboard', label: 'navDashboard', visible: true },
    { id: 'customers', label: 'navCustomers', visible: can('customer.view') },
    { id: 'suppliers', label: 'navSuppliers', visible: can('supplier.view') },
    { id: 'airlines', label: 'navAirlines', visible: can('airline.view') },
    { id: 'bookings', label: 'navBookings', visible: true, soon: true },
    { id: 'finance', label: 'navFinance', visible: true, soon: true },
    { id: 'reports', label: 'navReports', visible: true, soon: true },
  ];
  const admin: NavItem[] = [
    { id: 'users', label: 'navUsers', visible: can('user.view') || can('role.view') },
    { id: 'company', label: 'navCompany', visible: can('company.view') },
    { id: 'audit', label: 'navAudit', visible: can('audit.view') },
    { id: 'system', label: 'navSystem', visible: can('backup.create') || can('backup.restore') || can('integrity.run') },
  ];
  const signOut = async () => {
    await call('auth.logout').catch(() => undefined);
    onSignedOut();
  };
  const navButton = (n: NavItem) => (
    <button key={n.id} className={page === n.id ? 'active' : ''} aria-current={page === n.id ? 'page' : undefined} onClick={() => setPage(n.id)} data-nav={n.id}>
      <span>{t(n.label)}</span>
      {n.soon && <span className="soon">{t('comingSoon')}</span>}
    </button>
  );
  const visibleAdmin = admin.filter((n) => n.visible);
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="main">
        <div className="brand">{t('appName')}</div>
        <div className="nav-group">{t('navMainGroup')}</div>
        {main.filter((n) => n.visible).map(navButton)}
        {visibleAdmin.length > 0 && <div className="nav-group">{t('navAdminGroup')}</div>}
        {visibleAdmin.map(navButton)}
        <div className="spacer" />
        <button onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} data-testid="toggle-language">{t('language')}</button>
        <button onClick={signOut} data-testid="sign-out">{t('signOut')}</button>
      </nav>
      <main className="main">
        <div className="topbar">
          <strong data-testid="current-user">{user.displayName}</strong>
          <span className="muted ltr">{user.username} · {user.roles.join(' · ')}</span>
        </div>
        {page === 'dashboard' && <DashboardPage user={user} canSummary={can('dashboard.operational') || can('dashboard.financial')} go={(p) => setPage(p as Page)} />}
        {page === 'customers' && <CustomersPage can={can} />}
        {page === 'suppliers' && <SuppliersPage can={can} />}
        {page === 'airlines' && <AirlinesPage can={can} />}
        {page === 'bookings' && <ComingSoonPage title="navBookings" />}
        {page === 'finance' && <ComingSoonPage title="navFinance" />}
        {page === 'reports' && <ComingSoonPage title="navReports" />}
        {page === 'users' && <UsersRolesPage can={can} selfId={user.id} />}
        {page === 'company' && <CompanySettingsPage can={can} onChanged={onPrefs} />}
        {page === 'audit' && <AuditPage canListUsers={can('user.view')} />}
        {page === 'system' && (
          <SystemPage canBackup={can('backup.create')} canRestore={can('backup.restore')} canCheck={can('integrity.run')} onRestored={onRestored} />
        )}
      </main>
    </div>
  );
}
