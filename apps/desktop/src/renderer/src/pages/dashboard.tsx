import type { DashboardSummaryDto, SessionUserDto } from '@airdesk/contracts';
import { call } from '../api';
import { PageHeader, useLoader } from '../components';
import { useI18n, type TKey } from '../i18n';
import { useFmt } from '../prefs';

export function DashboardPage({ user, canSummary, go }: { user: SessionUserDto; canSummary: boolean; go: (page: string) => void }) {
  const { t } = useI18n();
  const { digits, dateTime } = useFmt();
  const summary = useLoader(() => (canSummary ? call<DashboardSummaryDto>('dashboard.summary') : Promise.resolve(null)), [canSummary]);
  const s = summary.data;
  const tile = (key: TKey, page: string, v: { active: number; archived?: number; disabled?: number } | null | undefined) =>
    v && (
      <button className="tile" onClick={() => go(page)} data-testid={`tile-${page}`}>
        <span className="tile-title">{t(key)}</span>
        <span className="tile-value">{digits(v.active)}</span>
        <span className="muted small">
          {t('activeCount')}
          {v.archived !== undefined && ` · ${digits(v.archived)} ${t('archivedCount')}`}
          {v.disabled !== undefined && ` · ${digits(v.disabled)} ${t('disabledCount')}`}
        </span>
      </button>
    );
  return (
    <div className="page" data-testid="page-dashboard">
      <PageHeader title={`${t('welcome')} ${user.displayName}`} />
      {s && (
        <div className="tiles">
          {tile('navCustomers', 'customers', s.customers)}
          {tile('navSuppliers', 'suppliers', s.suppliers)}
          {tile('navAirlines', 'airlines', s.airlines)}
          {tile('users', 'users', s.users)}
        </div>
      )}
      {s && (
        <p className="muted">{t('lastBackup')}: <span className="ltr">{s.lastBackupAt ? dateTime(s.lastBackupAt) : t('never')}</span></p>
      )}
    </div>
  );
}

export function ComingSoonPage({ title }: { title: TKey }) {
  const { t } = useI18n();
  return (
    <div className="page" data-testid="page-coming-soon">
      <PageHeader title={t(title)} />
      <div className="empty"><span className="badge muted">{t('comingSoon')}</span><p>{t('comingSoonText')}</p></div>
    </div>
  );
}
