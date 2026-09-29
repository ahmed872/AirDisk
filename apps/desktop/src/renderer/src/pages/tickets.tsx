import { useEffect, useState } from 'react';
import type { BookingDto, BookingListItemDto, CustomerDto, PageDto } from '@airdesk/contracts';
import { call } from '../api';
import { Alert, EmptyState, LoadError, Modal, PageHeader, useLoader } from '../components';
import { useI18n, type TKey } from '../i18n';
import { AirlineSelect, CustomerPicker, SupplierSelect, useAirlines, useSuppliers } from '../lookups';
import { CurrencySelect, useMoney } from '../money';
import { useFmt } from '../prefs';

type Can = (p: string) => boolean;
const PAGE = 50;

interface Filters {
  dateField: 'BOOKING' | 'ISSUE' | 'TRAVEL';
  payment: 'ALL' | 'DUE' | 'SETTLED' | 'CREDIT';
  attachment: 'ALL' | 'WITH' | 'WITHOUT';
  supplierId: string | null;
  airlineId: string | null;
  agentId: string | null;
  attention: boolean;
}
const NO_FILTERS: Filters = { dateField: 'BOOKING', payment: 'ALL', attachment: 'ALL', supplierId: null, airlineId: null, agentId: null, attention: false };

/** List of ticket records (the office's records of externally booked/issued tickets). */
export function TicketsPage({ can, open, presetCustomerId }: { can: Can; open: (id: string) => void; presetCustomerId?: string | null }) {
  const { t } = useI18n();
  const m = useMoney();
  const { date } = useFmt();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('OPEN');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [showMore, setShowMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const suppliers = useSuppliers();
  const airlines = useAirlines();
  const canAll = can('booking.view_all');
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { if (canAll) call<{ id: string; name: string }[]>('bookings.agentOptions').then(setAgents, () => setAgents([])); }, [canAll]);
  useEffect(() => { const h = setTimeout(() => { setDebounced(query); setOffset(0); }, 250); return () => clearTimeout(h); }, [query]);
  const setFilter = (patch: Partial<Filters>) => { setF({ ...f, ...patch }); setOffset(0); };
  const active = Object.entries(f).filter(([k, v]) => v !== NO_FILTERS[k as keyof Filters]).length + (from ? 1 : 0) + (to ? 1 : 0) + (status !== 'OPEN' ? 1 : 0);
  const clearAll = () => { setF(NO_FILTERS); setFrom(''); setTo(''); setStatus('OPEN'); setQuery(''); setOffset(0); };
  const list = useLoader(() => call<PageDto<BookingListItemDto>>('bookings.list', {
    query: debounced || undefined, status, from: from || undefined, to: to || undefined, dateField: f.dateField, payment: f.payment, attachment: f.attachment,
    supplierId: f.supplierId ?? undefined, airlineId: f.airlineId ?? undefined, agentId: f.agentId ?? undefined, attention: f.attention || undefined,
    customerId: presetCustomerId ?? undefined, limit: PAGE, offset,
  }), [debounced, status, from, to, f, offset, presetCustomerId]);
  const items = list.data?.items ?? [];
  return (
    <div className="page" data-testid="page-tickets">
      <PageHeader title={t('navTickets')}>
        {can('booking.create') && <button className="primary" onClick={() => setCreating(true)} data-testid="new-record">+ {t('recordTicket')}</button>}
      </PageHeader>
      <p className="hint">{t('scopeNote')}</p>
      <div className="toolbar" role="search">
        <input type="search" className="grow" placeholder={t('globalSearch')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="search" />
        <label className="inline">{t('status')}
          <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} data-testid="status-filter">
            <option value="OPEN">{t('openRecords')}</option><option value="ALL">{t('all')}</option>
            {['DRAFT', 'RESERVED', 'ISSUED', 'PARTIALLY_CANCELLED', 'CANCELLED', 'VOIDED', 'DISCARDED'].map((s) => <option key={s} value={s}>{t(`st_${s}` as TKey)}</option>)}
          </select>
        </label>
        <label className="inline">{t('dateOf')}
          <select value={f.dateField} onChange={(e) => setFilter({ dateField: e.target.value as Filters['dateField'] })} data-testid="date-field">
            <option value="BOOKING">{t('dateRecorded')}</option><option value="ISSUE">{t('dateIssued')}</option><option value="TRAVEL">{t('dateTravel')}</option>
          </select>
        </label>
        <label className="inline">{t('from')}<input type="date" className="ltr" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} data-testid="filter-from" /></label>
        <label className="inline">{t('to')}<input type="date" className="ltr" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} data-testid="filter-to" /></label>
        <label className="inline">{t('paymentFilter')}
          <select value={f.payment} onChange={(e) => setFilter({ payment: e.target.value as Filters['payment'] })} data-testid="payment-filter">
            <option value="ALL">{t('all')}</option><option value="DUE">{t('payf_DUE')}</option><option value="SETTLED">{t('payf_SETTLED')}</option><option value="CREDIT">{t('payf_CREDIT')}</option>
          </select>
        </label>
        <button type="button" onClick={() => setShowMore(!showMore)} aria-expanded={showMore} data-testid="more-filters">{t('moreFilters')}{active ? ` (${active})` : ''}</button>
        {active > 0 && <button type="button" className="link" onClick={clearAll} data-testid="clear-filters">{t('clearFilters')}</button>}
      </div>
      {showMore && (
        <div className="toolbar" data-testid="more-filters-panel">
          <SupplierSelect label={t('supplier')} value={f.supplierId} onChange={(v) => setFilter({ supplierId: v })} suppliers={suppliers} testId="filter-supplier" emptyLabel={t('all')} />
          <AirlineSelect label={t('airline')} value={f.airlineId} onChange={(v) => setFilter({ airlineId: v })} airlines={airlines} testId="filter-airline" emptyLabel={t('all')} />
          {canAll && (
            <label>{t('salesAgent')}
              <select value={f.agentId ?? ''} onChange={(e) => setFilter({ agentId: e.target.value || null })} data-testid="filter-agent">
                <option value="">{t('all')}</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          )}
          <label>{t('ticketFile')}
            <select value={f.attachment} onChange={(e) => setFilter({ attachment: e.target.value as Filters['attachment'] })} data-testid="filter-attachment">
              <option value="ALL">{t('all')}</option><option value="WITH">{t('withFile')}</option><option value="WITHOUT">{t('withoutFile')}</option>
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={f.attention} onChange={(e) => setFilter({ attention: e.target.checked })} data-testid="filter-attention" />{t('needsFollowUp')}</label>
        </div>
      )}
      {list.data && <p className="muted small" data-testid="result-count">{t('resultsCount').replace('{n}', String(list.data.total))}</p>}
      {list.error && <LoadError error={list.error} onRetry={list.reload} />}
      {!list.loading && !list.error && items.length === 0 && <EmptyState text={t(debounced ? 'emptySearch' : 'emptyList')} />}
      {items.length > 0 && (
        <div className="table-scroll">
          <table data-testid="results">
            <thead><tr><th>{t('recordNo')}</th><th>PNR</th><th>{t('date')}</th><th>{t('customer')}</th><th>{t('passengers')}</th><th>{t('flights')}</th><th>{t('status')}</th>
              <th className="num">{t('total')}</th><th className="num">{t('remaining')}</th><th /></tr></thead>
            <tbody>{items.map((r) => (
              <tr key={r.id} className="clickable" tabIndex={0} onClick={() => open(r.id)} onKeyDown={(e) => e.key === 'Enter' && open(r.id)} data-record={r.bookingNo}>
                <td className="ltr">{r.bookingNo}</td>
                <td className="ltr">{r.pnr ?? ''}</td>
                <td className="ltr">{date(r.bookingDate)}</td>
                <td>{r.customerName}</td>
                <td className="clip ltr" title={r.passengerNames}>{r.passengerNames}</td>
                <td className="ltr">{r.route ?? ''}{r.firstDeparture ? <span className="muted small"> · {date(r.firstDeparture.slice(0, 10))}</span> : null}</td>
                <td><span className="badge" data-status={r.status}>{t(`st_${r.status}` as TKey)}</span>{r.refundStatus !== 'NONE' && <span className="badge warn">{t(`rf_${r.refundStatus}` as TKey)}</span>}</td>
                <td className="num ltr">{m.fmt(r.totalMinor, r.saleCurrency)}</td>
                <td className={`num ltr ${r.balanceMinor > 0 ? 'due-text' : ''}`}>{r.status === 'DRAFT' || r.status === 'RESERVED' ? '' : m.fmt(r.balanceMinor, r.saleCurrency)}</td>
                <td>{r.scheduleAttention && <span className="badge bad" title={t('scheduleChangedBanner')} data-testid="attention">⚠</span>}
                  {r.attachmentCount > 0 && <span className="badge" title={t('ticketFiles')} data-testid="has-file">📎 {r.attachmentCount}</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {list.data && list.data.total > PAGE && (
        <div className="pager">
          <span className="muted">{offset + 1}–{offset + items.length} {t('of')} {list.data.total}</span>
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('prev')}</button>
          <button disabled={offset + items.length >= list.data.total} onClick={() => setOffset(offset + PAGE)}>{t('next')}</button>
        </div>
      )}
      {creating && <NewRecordDialog can={can} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); open(id); }} />}
    </div>
  );
}

/** Step 1 of recording an existing ticket: who pays, which reservation (PNR), supplier and airline. */
function NewRecordDialog({ can, onClose, onCreated }: { can: Can; onClose: () => void; onCreated: (id: string) => void }) {
  const { t, errorMessage } = useI18n();
  const m = useMoney();
  const suppliers = useSuppliers();
  const airlines = useAirlines();
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [pnr, setPnr] = useState('');
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [airlineId, setAirlineId] = useState<string | null>(null);
  const [currency, setCurrency] = useState(m.base);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!customer) return;
    setBusy(true);
    setError(null);
    try {
      const b = await call<BookingDto>('bookings.create', { customerId: customer.id, pnr: pnr || null, supplierId, airlineId, saleCurrency: currency });
      onCreated(b.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal wide title={t('newRecordTitle')} onClose={onClose} testId="new-record-dialog"
      footer={<><button className="primary" disabled={!customer || busy} onClick={create} data-testid="create-record">{t('createRecord')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      <Alert kind="info">{t('scopeNote')}</Alert>
      {error && <Alert kind="error">{error}</Alert>}
      <h3>{t('customerLabel')}</h3>
      <CustomerPicker value={customer} onPick={setCustomer} canCreate={can('customer.create')} />
      {customer && <button className="link" onClick={() => setCustomer(null)}>{t('edit')}</button>}
      <div className="grid">
        <label>{t('pnr')}<input className="ltr code" value={pnr} maxLength={8} onChange={(e) => setPnr(e.target.value.toUpperCase())} data-testid="nr-pnr" /><span className="hint">{t('pnrHint')}</span></label>
        <SupplierSelect label={t('supplierSource')} value={supplierId} onChange={setSupplierId} suppliers={suppliers} testId="nr-supplier" />
        <AirlineSelect label={t('airline')} value={airlineId} onChange={setAirlineId} airlines={airlines} testId="nr-airline" />
        <CurrencySelect label={t('saleCurrency')} value={currency} onChange={setCurrency} testId="nr-currency" />
      </div>
      <p className="hint">{t('supplierSourceHint')}</p>
    </Modal>
  );
}
