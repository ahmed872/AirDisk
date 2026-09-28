import { useCallback, useEffect, useState } from 'react';
import type { AboutDto, CompanyProfileDto, SearchHitDto, SessionUserDto, SystemStatusDto } from '@airdesk/contracts';
import { call, onSessionLost } from './api';
import { I18nProvider, useI18n, type Locale, type TKey } from './i18n';
import { DEFAULT_PREFS, PrefsProvider, useFmt, type DisplayPrefs } from './prefs';
import { MoneyProvider } from './money';
import { Modal } from './components';
import { AuditPage } from './pages/audit';
import { ChangePasswordPage, LoginPage, SetupPage } from './pages/auth';
import { CompanySettingsPage } from './pages/company';
import { DashboardPage } from './pages/dashboard';
import { AirportsPage } from './pages/airports';
import { FinancePage } from './pages/finance';
import { RecordPage } from './pages/record';
import { ReportsPage } from './pages/reports';
import { TicketsPage } from './pages/tickets';
import { TravelPage } from './pages/travel';
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
  else content = <MoneyProvider base={prefs.baseCurrencyCode}><Shell user={user} onPrefs={(p) => setPrefs(pickPrefs(p))} onSignedOut={() => setUser(null)} onRestored={() => { setUser(null); reload(); }} /></MoneyProvider>;
  return <PrefsProvider prefs={prefs}>{content}</PrefsProvider>;
}

type Page = 'dashboard' | 'tickets' | 'record' | 'travel' | 'customers' | 'suppliers' | 'airlines' | 'airports' | 'finance' | 'reports' | 'users' | 'company' | 'audit' | 'system';
interface NavItem { id: Page; label: TKey; visible: boolean }

function Shell({ user, onPrefs, onSignedOut, onRestored }: {
  user: SessionUserDto; onPrefs: (p: CompanyProfileDto) => void; onSignedOut: () => void; onRestored: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const [page, setPage] = useState<Page>('dashboard');
  const [recordId, setRecordId] = useState<string | null>(null);
  const [about, setAbout] = useState(false);
  const can = (p: string) => user.permissions.includes(p);
  const openRecord = (id: string) => { setRecordId(id); setPage('record'); };
  // Menus mirror permissions for convenience only; the backend authorizes every command.
  const main: NavItem[] = [
    { id: 'dashboard', label: 'navDashboard', visible: true },
    { id: 'tickets', label: 'navTickets', visible: can('booking.view') },
    { id: 'travel', label: 'navTravel', visible: can('booking.view') },
    { id: 'customers', label: 'navCustomers', visible: can('customer.view') },
    { id: 'suppliers', label: 'navSuppliers', visible: can('supplier.view') },
    { id: 'airlines', label: 'navAirlines', visible: can('airline.view') },
    { id: 'airports', label: 'navAirports', visible: can('airport.manage') || can('booking.view') },
  ];
  const money: NavItem[] = [
    { id: 'finance', label: 'navFinance', visible: ['payment.customer.receive', 'payment.supplier.pay', 'expense.view', 'expense.create', 'treasury.view', 'finance.exchange_rates'].some(can) },
    { id: 'reports', label: 'navReports', visible: user.permissions.some((p) => p.startsWith('report.')) },
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
    <button key={n.id} className={page === n.id || (n.id === 'tickets' && page === 'record') ? 'active' : ''} aria-current={page === n.id ? 'page' : undefined} onClick={() => setPage(n.id)} data-nav={n.id}>
      <span>{t(n.label)}</span>
    </button>
  );
  const group = (label: TKey, items: NavItem[]) => {
    const v = items.filter((n) => n.visible);
    return v.length ? <>{<div className="nav-group">{t(label)}</div>}{v.map(navButton)}</> : null;
  };
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="main">
        <div className="brand">{t('appName')}</div>
        {group('navMainGroup', main)}
        {group('finance', money)}
        {group('navAdminGroup', admin)}
        <div className="spacer" />
        <button onClick={() => setAbout(true)} data-testid="about">{t('about')}</button>
        <button onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} data-testid="toggle-language">{t('language')}</button>
        <button onClick={signOut} data-testid="sign-out">{t('signOut')}</button>
      </nav>
      <main className="main">
        <div className="topbar">
          <GlobalSearch onOpen={(hit) => { if (hit.type === 'booking') openRecord(hit.id); else setPage(hit.type === 'customer' ? 'customers' : hit.type === 'supplier' ? 'suppliers' : hit.type === 'airline' ? 'airlines' : 'airports'); }} />
          <div className="whoami"><strong data-testid="current-user">{user.displayName}</strong> <span className="muted ltr">{user.username} · {user.roles.join(' · ')}</span></div>
        </div>
        {page === 'dashboard' && <DashboardPage user={user} canMetrics={can('dashboard.operational') || can('dashboard.financial')} go={(p) => setPage(p as Page)} />}
        {page === 'tickets' && <TicketsPage can={can} open={openRecord} />}
        {page === 'record' && recordId && <RecordPage key={recordId} id={recordId} can={can} onBack={() => setPage('tickets')} />}
        {page === 'travel' && <TravelPage open={openRecord} canChanges={can('booking.view')} />}
        {page === 'customers' && <CustomersPage can={can} />}
        {page === 'suppliers' && <SuppliersPage can={can} />}
        {page === 'airlines' && <AirlinesPage can={can} />}
        {page === 'airports' && <AirportsPage canManage={can('airport.manage')} />}
        {page === 'finance' && <FinancePage can={can} />}
        {page === 'reports' && <ReportsPage can={can} />}
        {page === 'users' && <UsersRolesPage can={can} selfId={user.id} />}
        {page === 'company' && <CompanySettingsPage can={can} onChanged={onPrefs} />}
        {page === 'audit' && <AuditPage canListUsers={can('user.view')} />}
        {page === 'system' && (
          <SystemPage canBackup={can('backup.create')} canRestore={can('backup.restore')} canCheck={can('integrity.run')} onRestored={onRestored} />
        )}
      </main>
      {about && <AboutDialog onClose={() => setAbout(false)} />}
    </div>
  );
}

function GlobalSearch({ onOpen }: { onOpen: (hit: SearchHitDto) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHitDto[] | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); return; }
    const h = setTimeout(() => { call<SearchHitDto[]>('search.global', { query: q }).then(setHits, () => setHits([])); }, 250);
    return () => clearTimeout(h);
  }, [q]);
  return (
    <div className="global-search" role="search">
      <input type="search" value={q} placeholder={t('globalSearch')} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }} data-testid="global-search" aria-label={t('search')} />
      {hits && (
        <ul className="suggestions" data-testid="global-results">
          {hits.length === 0 && <li className="muted">{t('noResults')}</li>}
          {hits.map((h) => (
            <li key={`${h.type}${h.id}`}><button onClick={() => { setQ(''); onOpen(h); }} data-hit={h.type}>
              <span className="badge">{t(`h_${h.type}` as TKey)}</span> <strong>{h.title}</strong> <span className="muted">{h.subtitle}</span>
            </button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { dateTime } = useFmt();
  const [about, setAbout] = useState<AboutDto | null>(null);
  useEffect(() => { call<AboutDto>('system.about').then(setAbout, () => undefined); }, []);
  return (
    <Modal title={t('about')} onClose={onClose} footer={<button onClick={onClose}>{t('close')}</button>} testId="about-dialog">
      {about && (
        <>
          <p>{t('appVersion')}: <strong className="ltr" data-testid="app-version">{about.appVersion}</strong></p>
          <p>{t('schemaVersion')}: <strong className="ltr">{about.schemaVersion}</strong> / {about.latestSchemaVersion}</p>
          <h3>{t('migrationsApplied')}</h3>
          <ul className="plain small ltr">{about.migrations.map((m) => <li key={m.version}>{m.version} · {m.name} · {dateTime(m.appliedAt)} · v{m.appVersion}</li>)}</ul>
          <p className="hint">{t('scopeNote')}</p>
        </>
      )}
    </Modal>
  );
}
