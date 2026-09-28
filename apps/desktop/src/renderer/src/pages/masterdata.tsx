import { useEffect, useState, type ReactNode } from 'react';
import type { DuplicateCandidateDto, PageDto } from '@airdesk/contracts';
import { ApiError, call } from '../api';
import { Alert, ConfirmDialog, EmptyState, FormFields, LoadError, Modal, PageHeader, StatusBadge, fromRecord, toPayload, useLoader, type FieldDef, type FormValues } from '../components';
import { useI18n, type FieldIssue, type TKey } from '../i18n';
import { useFmt } from '../prefs';

type Entity = 'customers' | 'suppliers' | 'airlines';
interface Row { id: string; status: 'ACTIVE' | 'ARCHIVED'; rowVersion: number }

export interface MasterConfig<T extends Row> {
  entity: Entity;
  payloadKey: 'customer' | 'supplier' | 'airline';
  title: TKey;
  newLabel: TKey;
  editLabel: TKey;
  sort: { value: string; label: TKey }[];
  columns: { label: TKey; cell: (r: T) => ReactNode; ltr?: boolean }[];
  fields: (record: T | null) => FieldDef[];
  defaults?: FormValues;
  /** Fields to omit from the payload for this record (e.g. redacted identity). */
  omit?: (record: T | null) => string[];
  detail?: (record: T) => ReactNode;
  perms: { create: boolean; edit: boolean; archive: boolean };
}

const PAGE = 50;

export function MasterDataPage<T extends Row>({ cfg }: { cfg: MasterConfig<T> }) {
  const { t } = useI18n();
  const { digits: fmtCount } = useFmt();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'ARCHIVED' | 'ALL'>('ACTIVE');
  const [sortBy, setSortBy] = useState(cfg.sort[0]!.value);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<T | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const h = setTimeout(() => { setDebounced(query); setOffset(0); }, 250);
    return () => clearTimeout(h);
  }, [query]);

  const list = useLoader(
    () => call<PageDto<T>>(`${cfg.entity}.list` as never, { query: debounced || undefined, status, sortBy, sortDir, limit: PAGE, offset }),
    [cfg.entity, debounced, status, sortBy, sortDir, offset],
  );
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  return (
    <div className="page" data-testid={`page-${cfg.entity}`}>
      <PageHeader title={t(cfg.title)}>
        {cfg.perms.create && <button className="primary" onClick={() => setEditing('new')} data-testid="new">{t(cfg.newLabel)}</button>}
      </PageHeader>
      {notice && <Alert kind="ok">{notice}</Alert>}
      <div className="toolbar" role="search">
        <input type="search" className="grow" placeholder={t('searchHint')} aria-label={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="search" />
        <label className="inline">{t('status')}
          <select value={status} onChange={(e) => { setStatus(e.target.value as never); setOffset(0); }} data-testid="status-filter">
            <option value="ACTIVE">{t('active')}</option>
            <option value="ARCHIVED">{t('archived')}</option>
            <option value="ALL">{t('all')}</option>
          </select>
        </label>
        <label className="inline">{t('sortBy')}
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} data-testid="sort-by">
            {cfg.sort.map((s) => <option key={s.value} value={s.value}>{t(s.label)}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')} aria-label={t(sortDir === 'asc' ? 'ascending' : 'descending')} data-testid="sort-dir">
          {sortDir === 'asc' ? '↑' : '↓'} {t(sortDir === 'asc' ? 'ascending' : 'descending')}
        </button>
      </div>
      {list.error && <LoadError error={list.error} onRetry={list.reload} />}
      {!list.error && !list.loading && items.length === 0 && (
        <EmptyState text={t(debounced || status !== 'ACTIVE' ? 'emptySearch' : 'emptyList')}
          action={cfg.perms.create && !debounced ? <button className="primary" onClick={() => setEditing('new')}>{t(cfg.newLabel)}</button> : undefined} />
      )}
      {items.length > 0 && (
        <>
          <table data-testid="results">
            <thead><tr>{cfg.columns.map((c) => <th key={c.label} scope="col">{t(c.label)}</th>)}<th scope="col">{t('status')}</th></tr></thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="clickable" tabIndex={0} onClick={() => setEditing(r)} onKeyDown={(e) => e.key === 'Enter' && setEditing(r)}>
                  {cfg.columns.map((c) => <td key={c.label} className={c.ltr ? 'ltr' : undefined}>{c.cell(r)}</td>)}
                  <td><StatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pager">
            <span className="muted">{t('showing')} {fmtCount(offset + 1)}–{fmtCount(offset + items.length)} {t('of')} {fmtCount(total)}</span>
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('prev')}</button>
            <button disabled={offset + items.length >= total} onClick={() => setOffset(offset + PAGE)}>{t('next')}</button>
          </div>
        </>
      )}
      {editing && (
        <EditDialog cfg={cfg} record={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); setNotice(msg); list.reload(); }} />
      )}
    </div>
  );
}

function EditDialog<T extends Row>({ cfg, record, onClose, onSaved }: { cfg: MasterConfig<T>; record: T | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const { t, errorMessage, fieldIssues } = useI18n();
  const defs = cfg.fields(record);
  const [values, setValues] = useState<FormValues>(() => fromRecord(record, defs, cfg.defaults));
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dups, setDups] = useState<DuplicateCandidateDto[] | null>(null);
  const [confirm, setConfirm] = useState<'archive' | 'restore' | null>(null);
  const [busy, setBusy] = useState(false);
  const archived = record?.status === 'ARCHIVED';
  const readOnly = archived || (record ? !cfg.perms.edit : !cfg.perms.create);

  const save = async (confirmDuplicates: boolean) => {
    setBusy(true);
    setError(null);
    setIssues([]);
    const payload = toPayload(values, defs);
    for (const k of cfg.omit?.(record) ?? []) delete payload[k];
    try {
      if (record) await call(`${cfg.entity}.update` as never, { id: record.id, rowVersion: record.rowVersion, [cfg.payloadKey]: payload, confirmDuplicates });
      else await call(`${cfg.entity}.create` as never, { [cfg.payloadKey]: payload, confirmDuplicates });
      onSaved(t('saved'));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE_WARNING') setDups((e.details?.matches as DuplicateCandidateDto[]) ?? []);
      else {
        setIssues(fieldIssues(e));
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal wide testId="edit-dialog" title={t(record ? cfg.editLabel : cfg.newLabel)} onClose={onClose}
        footer={<>
          {!readOnly && <button className="primary" disabled={busy} onClick={() => save(false)} data-testid="save">{t('save')}</button>}
          {record && cfg.perms.archive && (archived
            ? <button onClick={() => setConfirm('restore')} data-testid="restore">{t('restoreRecord')}</button>
            : <button className="danger" onClick={() => setConfirm('archive')} data-testid="archive">{t('archive')}</button>)}
          <button onClick={onClose}>{t('close')}</button>
        </>}>
        {archived && <Alert kind="info">{t('archivedReadOnly')}</Alert>}
        {error && <Alert kind="error">{error}</Alert>}
        <form onSubmit={(e) => { e.preventDefault(); if (!readOnly) void save(false); }}>
          <FormFields defs={defs} values={values} onChange={setValues} issues={issues} disabled={readOnly} />
          <button type="submit" hidden />
        </form>
        {record && cfg.detail?.(record)}
      </Modal>
      {dups && (
        <Modal title={t('duplicateTitle')} onClose={() => setDups(null)} testId="duplicate-dialog"
          footer={<>
            <button onClick={() => setDups(null)} className="primary">{t('goBack')}</button>
            <button onClick={() => { setDups(null); void save(true); }} data-testid="save-anyway">{t('saveAnyway')}</button>
          </>}>
          <Alert kind="warn">{t('duplicateText')}</Alert>
          <table>
            <thead><tr><th>{t('number')}</th><th>{t('name')}</th><th>{t('status')}</th><th>{t('details')}</th></tr></thead>
            <tbody>
              {dups.map((d) => (
                <tr key={d.id}>
                  <td className="ltr">{d.number}</td>
                  <td>{d.name}</td>
                  <td><StatusBadge status={d.status} /></td>
                  <td>{d.signals.map((s) => t(`sig_${s}` as TKey)).join('، ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
      {confirm && record && (
        <ConfirmDialog
          title={t(confirm === 'archive' ? 'archive' : 'restoreRecord')}
          text={confirm === 'archive' ? t('confirmArchive') : t('restoreRecord')}
          confirmLabel={t(confirm === 'archive' ? 'archive' : 'restoreRecord')}
          danger={confirm === 'archive'}
          withReason
          onClose={() => setConfirm(null)}
          onConfirm={async (reason) => {
            await call(`${cfg.entity}.${confirm}` as never, { id: record.id, reason });
            onSaved(t('saved'));
          }}
        />
      )}
    </>
  );
}
