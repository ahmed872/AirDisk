import { useState } from 'react';
import type { ScheduleChangeDto, UpcomingTravelDto } from '@airdesk/contracts';
import { call } from '../api';
import { EmptyState, LoadError, PageHeader, useLoader } from '../components';
import { useI18n, type TKey } from '../i18n';
import { useFmt } from '../prefs';

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Operational view: who is flying soon, and which schedule changes still need the customer to be told. */
export function TravelPage({ open, canChanges }: { open: (bookingId: string) => void; canChanges: boolean }) {
  const { t } = useI18n();
  const { date } = useFmt();
  const now = new Date();
  const [from, setFrom] = useState(ymd(now));
  const [to, setTo] = useState(ymd(new Date(now.getTime() + 7 * 86_400_000)));
  const [attentionOnly, setAttentionOnly] = useState(false);
  const travel = useLoader(() => call<UpcomingTravelDto[]>('travel.upcoming', { from, to, attentionOnly }), [from, to, attentionOnly]);
  const changes = useLoader(() => (canChanges ? call<ScheduleChangeDto[]>('schedule.list', { attentionOnly: true }) : Promise.resolve([] as ScheduleChangeDto[])), [canChanges]);
  return (
    <div className="page" data-testid="page-travel">
      <PageHeader title={t('navTravel')} />
      {(changes.data?.length ?? 0) > 0 && (
        <section className="card section attention-box" data-testid="attention-changes">
          <h2>⚠ {t('scheduleChangedBanner')} — {t('needsAttention')}</h2>
          <table>
            <thead><tr><th>{t('recordNo')}</th><th>{t('segment')}</th><th>{t('customer')}</th><th>{t('contactMobile')}</th><th>{t('changes')}</th><th>{t('notification')}</th></tr></thead>
            <tbody>{changes.data!.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => open(c.bookingId)}>
                <td className="ltr">{c.bookingNo}</td><td className="ltr">{c.segmentLabel}</td><td>{c.customerName}</td><td className="ltr">{c.contactMobile}</td>
                <td className="small">{c.fields.map((f) => `${f.oldValue ?? '—'} → ${f.newValue ?? '—'}`).join(' · ')}</td>
                <td><span className="badge bad">{t(`ns_${c.notificationStatus}` as TKey)}</span></td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}
      <div className="toolbar">
        <label className="inline">{t('from')}<input type="date" className="ltr" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="inline">{t('to')}<input type="date" className="ltr" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} />{t('attentionOnly')}</label>
      </div>
      {travel.error && <LoadError error={travel.error} onRetry={travel.reload} />}
      {travel.data && travel.data.length === 0 && <EmptyState text={t('emptySearch')} />}
      {travel.data && travel.data.length > 0 && (
        <div className="table-scroll">
          <table data-testid="travel-table">
            <thead><tr><th>{t('departure')}</th><th>{t('flightNumber')}</th><th>{t('origin')}</th><th>{t('destination')}</th><th>{t('passengers')}</th><th>{t('customer')}</th><th>PNR</th><th>{t('status')}</th><th>{t('notification')}</th></tr></thead>
            <tbody>{travel.data.map((r) => (
              <tr key={r.segmentId} className={`clickable ${r.scheduleAttention ? 'attention' : ''}`} onClick={() => open(r.bookingId)}>
                <td className="ltr">{date(r.departureDate)} {r.departureTime}</td><td className="ltr">{r.flight}</td><td className="ltr">{r.origin}</td><td className="ltr">{r.destination}</td>
                <td className="ltr clip" title={r.passengers}>{r.passengers}</td><td>{r.customerName} <span className="muted ltr">{r.contactMobile}</span></td><td className="ltr">{r.pnr ?? ''}</td>
                <td>{t(`st_${r.bookingStatus}` as TKey)}{r.segmentStatus === 'CANCELLED' ? ` · ${t('st_CANCELLED')}` : ''}</td>
                <td>{r.scheduleChanged ? <span className={`badge ${r.scheduleAttention ? 'bad' : 'ok'}`}>⚠ {r.notificationStatus ? t(`ns_${r.notificationStatus}` as TKey) : ''}</span> : ''}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
