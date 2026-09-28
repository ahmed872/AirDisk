import { useState } from 'react';
import type { CustomerDto, ReportDto, StatementDto } from '@airdesk/contracts';
import { call } from '../api';
import { Alert, EmptyState, PageHeader } from '../components';
import { isTKey, useI18n, type TKey } from '../i18n';
import { CustomerPicker, SupplierSelect, useSuppliers } from '../lookups';
import { useMoney } from '../money';
import { useFmt } from '../prefs';
import { PrintFrame, StatementBody, StatementPrint } from '../print';

type Can = (p: string) => boolean;

const REPORTS: { id: string; perm: string }[] = [
  { id: 'sales', perm: 'report.sales' }, { id: 'purchases', perm: 'report.purchases' }, { id: 'profit', perm: 'report.profit' },
  { id: 'receivables', perm: 'report.receivables' }, { id: 'payables', perm: 'report.payables' }, { id: 'supplier_volume', perm: 'report.supplier_performance' },
  { id: 'collections', perm: 'report.receivables' }, { id: 'expenses', perm: 'report.expenses' }, { id: 'refunds', perm: 'report.refunds' },
  { id: 'cancellations', perm: 'report.refunds' }, { id: 'flight_changes', perm: 'report.schedule_changes' }, { id: 'employee_activity', perm: 'report.employee_activity' },
];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Every report is computed from the journal; nothing here is typed in by hand. */
export function ReportsPage({ can }: { can: Can }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'reports' | 'statements'>(REPORTS.some((r) => can(r.perm)) ? 'reports' : 'statements');
  return (
    <div className="page" data-testid="page-reports">
      <PageHeader title={t('navReports')} />
      <div className="tabs" role="tablist">
        {REPORTS.some((r) => can(r.perm)) && <button role="tab" className={tab === 'reports' ? 'active' : ''} onClick={() => setTab('reports')}>{t('reportsTitle')}</button>}
        {can('report.statements') && <button role="tab" className={tab === 'statements' ? 'active' : ''} onClick={() => setTab('statements')} data-testid="tab-statements">{t('statements')}</button>}
      </div>
      <p className="hint">{t('fromLedgerNote')}</p>
      {tab === 'reports' && <Reports can={can} />}
      {tab === 'statements' && can('report.statements') && <Statements can={can} />}
    </div>
  );
}

function Reports({ can }: { can: Can }) {
  const { t, errorMessage } = useI18n();
  const m = useMoney();
  const { date } = useFmt();
  const allowed = REPORTS.filter((r) => can(r.perm));
  const now = new Date();
  const [id, setId] = useState(allowed[0]?.id ?? 'sales');
  const [from, setFrom] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(ymd(now));
  const [data, setData] = useState<ReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const run = async () => {
    setError(null);
    try { setData(await call<ReportDto>('reports.run', { report: id, from, to })); } catch (e) { setError(errorMessage(e)); setData(null); }
  };
  const label = (k: string) => (isTKey(k) ? t(k as TKey) : k);
  const cell = (type: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return '';
    if (type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? date(String(v)) : String(v);
    if (type === 'code' && isTKey(`st_${String(v)}`)) return t(`st_${String(v)}` as TKey);
    if (type === 'code' && isTKey(`docType_${String(v)}`)) return t(`docType_${String(v)}` as TKey);
    return String(v);
  };
  const moneyCell = (key: string, v: unknown, row: Record<string, unknown>) => {
    // Amount columns carry the transaction currency; everything else is base currency.
    const txn = key === 'amount' || data?.notes.includes('amountsInTransactionCurrency');
    return m.fmt(Number(v), txn && typeof row.currency === 'string' ? row.currency : m.base);
  };
  const csv = () => {
    if (!data) return '';
    const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const head = data.columns.map((c) => esc(label(c.label))).join(',');
    const body = data.rows.map((r) => data.columns.map((c) => esc(c.type === 'money' && r[c.key] !== null ? (Number(r[c.key]) / 10 ** m.unit(typeof r.currency === 'string' && (c.key === 'amount' || data.notes.includes('amountsInTransactionCurrency')) ? r.currency : m.base)).toFixed(2) : r[c.key])).join(','));
    return [head, ...body].join('\r\n');
  };
  const table = data && (
    <>
      {data.rows.length === 0 ? <EmptyState text={t('emptySearch')} /> : (
        <div className="table-scroll">
          <table data-testid="report-table">
            <thead><tr>{data.columns.map((c) => <th key={c.key} className={c.type === 'money' || c.type === 'number' ? 'num' : ''}>{label(c.label)}</th>)}</tr></thead>
            <tbody>{data.rows.map((r, i) => (
              <tr key={i}>{data.columns.map((c) => <td key={c.key} className={`${c.type === 'money' || c.type === 'number' ? 'num ' : ''}${c.type !== 'text' ? 'ltr' : ''}`}>{c.type === 'money' ? (r[c.key] === null ? '—' : moneyCell(c.key, r[c.key], r)) : cell(c.type, r[c.key])}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {data.totals && (
        <div className="totals" data-testid="report-totals">
          {Object.entries(data.totals).map(([k, v]) => <div key={k}><span>{label(k)}</span><strong className="ltr">{['transactions', 'bookings_created', 'bookings_issued', 'tickets', 'receipts', 'attention'].includes(k) ? v : m.fmt(v, m.base)}</strong></div>)}
        </div>
      )}
    </>
  );
  return (
    <section className="card section">
      <div className="toolbar">
        <label className="inline">{t('reportsTitle')}<select value={id} onChange={(e) => { setId(e.target.value); setData(null); }} data-testid="report-id">{allowed.map((r) => <option key={r.id} value={r.id}>{t(`r_${r.id}` as TKey)}</option>)}</select></label>
        <label className="inline">{t('from')}<input type="date" className="ltr" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="report-from" /></label>
        <label className="inline">{id === 'receivables' || id === 'payables' ? t('asOf') : t('to')}<input type="date" className="ltr" value={to} onChange={(e) => setTo(e.target.value)} data-testid="report-to" /></label>
        <button className="primary" onClick={run} data-testid="run-report">{t('run')}</button>
        {data && <button onClick={() => setPrinting(true)}>{t('print')}</button>}
        {data && can('report.export') && <button onClick={() => window.airdesk.exportCsv(`${id}-${from}-${to}`, csv())} data-testid="export-csv">{t('exportCsv')}</button>}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {table}
      {printing && data && <PrintFrame title={t(`r_${id}` as TKey)} fileName={`${id}-${from}-${to}`} onClose={() => setPrinting(false)}><h2>{t(`r_${id}` as TKey)}</h2><p className="ltr">{date(from)} – {date(to)}</p>{table}</PrintFrame>}
    </section>
  );
}

function Statements({ can }: { can: Can }) {
  const { t, errorMessage } = useI18n();
  const suppliers = useSuppliers();
  const now = new Date();
  const [party, setParty] = useState<'CUSTOMER' | 'SUPPLIER'>('CUSTOMER');
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [from, setFrom] = useState(ymd(new Date(now.getFullYear(), 0, 1)));
  const [to, setTo] = useState(ymd(now));
  const [data, setData] = useState<StatementDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState<StatementDto | null>(null);
  const partyId = party === 'CUSTOMER' ? customer?.id : supplierId;
  const run = async () => {
    if (!partyId) return;
    setError(null);
    try { setData(await call<StatementDto[]>('statements.get', { party, partyId, from, to })); } catch (e) { setError(errorMessage(e)); setData(null); }
  };
  return (
    <section className="card section">
      <div className="toolbar">
        <label className="inline">{t('type')}<select value={party} onChange={(e) => { setParty(e.target.value as never); setData(null); }} data-testid="statement-party">
          <option value="CUSTOMER">{t('customerStatement')}</option>{can('supplier.view_financial') && <option value="SUPPLIER">{t('supplierStatement')}</option>}
        </select></label>
        <label className="inline">{t('from')}<input type="date" className="ltr" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="inline">{t('to')}<input type="date" className="ltr" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="primary" disabled={!partyId} onClick={run} data-testid="run-statement">{t('run')}</button>
      </div>
      {party === 'CUSTOMER'
        ? (customer ? <p><strong>{customer.fullName}</strong> <button className="link" onClick={() => { setCustomer(null); setData(null); }}>{t('edit')}</button></p> : <CustomerPicker value={null} onPick={setCustomer} canCreate={false} />)
        : <div className="grid"><SupplierSelect label={t('pickSupplier')} value={supplierId} onChange={setSupplierId} suppliers={suppliers} /></div>}
      {error && <Alert kind="error">{error}</Alert>}
      {data && data.length === 0 && <EmptyState text={t('noOpenItems')} />}
      {data?.map((s) => (
        <div key={s.currency} className="statement" data-testid="statement">
          <StatementBody statement={s} />
          <div className="actions"><button onClick={() => setPrinting(s)} data-testid="print-statement">{t('print')} / PDF</button></div>
        </div>
      ))}
      {printing && <StatementPrint statement={printing} onClose={() => setPrinting(null)} />}
    </section>
  );
}
