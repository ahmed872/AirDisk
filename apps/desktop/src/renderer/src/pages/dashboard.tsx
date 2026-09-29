import { useState } from 'react';
import type { DashboardMetricsDto, DashboardSummaryDto, SessionUserDto } from '@airdesk/contracts';
import { call } from '../api';
import { PageHeader, useLoader } from '../components';
import { useI18n, type TKey } from '../i18n';
import { useMoney } from '../money';
import { useFmt } from '../prefs';

type Range = 'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'lastMonth' | 'customRange';
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function rangeOf(r: Range, custom: { from: string; to: string }): { from: string; to: string } {
  const now = new Date();
  const d = (y: number, m: number, day: number) => ymd(new Date(y, m, day));
  switch (r) {
    case 'today': return { from: ymd(now), to: ymd(now) };
    case 'yesterday': { const y = new Date(now.getTime() - 86_400_000); return { from: ymd(y), to: ymd(y) }; }
    case 'thisWeek': {
      // Week starts on Saturday (EG/SA office week).
      const back = (now.getDay() + 1) % 7;
      return { from: ymd(new Date(now.getTime() - back * 86_400_000)), to: ymd(now) };
    }
    case 'thisMonth': return { from: d(now.getFullYear(), now.getMonth(), 1), to: ymd(now) };
    case 'lastMonth': return { from: d(now.getFullYear(), now.getMonth() - 1, 1), to: d(now.getFullYear(), now.getMonth(), 0) };
    default: return custom;
  }
}

/** Figures by permission: agents see operations only; managers/accountants also see money (all from the ledger). */
export function DashboardPage({ user, canMetrics, go }: { user: SessionUserDto; canMetrics: boolean; go: (page: string) => void }) {
  const { t } = useI18n();
  const m = useMoney();
  const { digits, dateTime } = useFmt();
  const [range, setRange] = useState<Range>('thisMonth');
  const [custom, setCustom] = useState({ from: ymd(new Date()), to: ymd(new Date()) });
  const r = rangeOf(range, custom);
  const metrics = useLoader(() => (canMetrics ? call<DashboardMetricsDto>('dashboard.metrics', r) : Promise.resolve(null)), [canMetrics, r.from, r.to]);
  const summary = useLoader(() => (canMetrics ? call<DashboardSummaryDto>('dashboard.summary') : Promise.resolve(null)), [canMetrics]);
  const d = metrics.data;
  const tile = (key: TKey, value: string, page?: string, tone?: string) => (
    <button className={`tile ${tone ?? ''}`} onClick={() => page && go(page)} data-testid={`tile-${key}`} key={key}>
      <span className="tile-title">{t(key)}</span><span className="tile-value ltr">{value}</span>
    </button>
  );
  return (
    <div className="page" data-testid="page-dashboard">
      <PageHeader title={`${t('welcome')} ${user.displayName}`} />
      {canMetrics && (
        <div className="toolbar">
          {(['today', 'yesterday', 'thisWeek', 'thisMonth', 'lastMonth', 'customRange'] as const).map((x) => (
            <button key={x} className={range === x ? 'primary' : ''} onClick={() => setRange(x)} data-testid={`range-${x}`}>{t(x)}</button>
          ))}
          {range === 'customRange' && <>
            <input type="date" className="ltr" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <input type="date" className="ltr" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </>}
        </div>
      )}
      {d?.financial && (
        <>
          <div className="tiles">
            {tile('m_sales', m.fmt(d.financial.sales, d.baseCurrency), 'reports')}
            {tile('m_purchases', m.fmt(d.financial.purchases, d.baseCurrency), 'reports')}
            {tile('m_grossProfit', m.fmt(d.financial.grossProfit, d.baseCurrency), 'reports', d.financial.grossProfit < 0 ? 'neg' : 'pos')}
            {tile('m_expenses', m.fmt(d.financial.expenses, d.baseCurrency), 'finance')}
            {tile('m_netProfit', m.fmt(d.financial.netProfit, d.baseCurrency), 'reports', d.financial.netProfit < 0 ? 'neg' : 'pos')}
            {tile('m_collections', m.fmt(d.financial.collections, d.baseCurrency), 'finance')}
            {tile('m_receivables', m.fmt(d.financial.receivables, d.baseCurrency), 'finance')}
            {tile('m_payables', m.fmt(d.financial.payables, d.baseCurrency), 'finance')}
            {tile('m_customerRefunds', m.fmt(d.financial.customerRefunds, d.baseCurrency), 'reports')}
            {tile('m_supplierRefunds', m.fmt(d.financial.supplierRefunds, d.baseCurrency), 'reports')}
          </div>
          <p className="hint">{t('fromLedgerNote')}</p>
        </>
      )}
      {d?.operational && (
        <div className="tiles">
          {tile('m_bookingsCreated', digits(d.operational.bookingsCreated), 'tickets')}
          {tile('m_bookingsIssued', digits(d.operational.bookingsIssued), 'tickets')}
          {tile('m_ticketsIssued', digits(d.operational.ticketsIssued), 'tickets')}
          {tile('m_cancellations', digits(d.operational.cancellations), 'tickets')}
          {tile('m_openRefundRequests', digits(d.operational.openRefundRequests), 'tickets', d.operational.openRefundRequests ? 'warn' : '')}
          {tile('m_upcomingDepartures', digits(d.operational.upcomingDepartures), 'travel')}
          {tile('m_changesRequiringAttention', digits(d.operational.changesRequiringAttention), 'travel', d.operational.changesRequiringAttention ? 'neg' : '')}
        </div>
      )}
      {summary.data && <p className="muted">{t('lastBackup')}: <span className="ltr">{summary.data.lastBackupAt ? dateTime(summary.data.lastBackupAt) : t('never')}</span></p>}
    </div>
  );
}
