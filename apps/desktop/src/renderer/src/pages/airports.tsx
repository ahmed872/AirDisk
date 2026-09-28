import { useEffect, useState } from 'react';
import type { AirportDto, PageDto } from '@airdesk/contracts';
import { call } from '../api';
import { Alert, EmptyState, FormFields, LoadError, Modal, PageHeader, StatusBadge, fromRecord, toPayload, useLoader, type FieldDef, type FormValues } from '../components';
import { useI18n, type FieldIssue } from '../i18n';

const DEFS: FieldDef[] = [
  { name: 'iataCode', label: 'iataCode', ltr: true, required: true, maxLength: 3, upper: true },
  { name: 'icaoCode', label: 'icaoCode', ltr: true, maxLength: 4, upper: true },
  { name: 'nameEn', label: 'nameEn', ltr: true, required: true, maxLength: 120 },
  { name: 'nameAr', label: 'nameAr', maxLength: 120 },
  { name: 'cityEn', label: 'nameEn', ltr: true, maxLength: 80 },
  { name: 'cityAr', label: 'nameAr', maxLength: 80 },
  { name: 'countryCode', label: 'country', ltr: true, required: true, maxLength: 2, upper: true },
  { name: 'timezone', label: 'timezone', ltr: true, maxLength: 64 },
];

/** Airport reference data (starter list included; editable; deactivated, never deleted). */
export function AirportsPage({ canManage }: { canManage: boolean }) {
  const { t, locale, errorMessage } = useI18n();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'ARCHIVED' | 'ALL'>('ACTIVE');
  const [edit, setEdit] = useState<AirportDto | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const h = setTimeout(() => setDebounced(query), 250); return () => clearTimeout(h); }, [query]);
  const list = useLoader(() => call<PageDto<AirportDto>>('airports.list', { query: debounced || undefined, status, limit: 200 }), [debounced, status]);
  return (
    <div className="page" data-testid="page-airports">
      <PageHeader title={t('navAirports')}>{canManage && <button className="primary" onClick={() => setEdit('new')}>+ {t('navAirports')}</button>}</PageHeader>
      <div className="toolbar">
        <input type="search" className="grow" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="search" />
        <select value={status} onChange={(e) => setStatus(e.target.value as never)}><option value="ACTIVE">{t('active')}</option><option value="ARCHIVED">{t('archived')}</option><option value="ALL">{t('all')}</option></select>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {list.error && <LoadError error={list.error} onRetry={list.reload} />}
      {list.data && list.data.items.length === 0 && <EmptyState text={t('emptySearch')} />}
      {list.data && list.data.items.length > 0 && (
        <table data-testid="results">
          <thead><tr><th>IATA</th><th>ICAO</th><th>{t('name')}</th><th>{t('country')}</th><th>{t('timezone')}</th><th>{t('status')}</th><th /></tr></thead>
          <tbody>{list.data.items.map((a) => (
            <tr key={a.iataCode}><td className="ltr">{a.iataCode}</td><td className="ltr">{a.icaoCode ?? ''}</td>
              <td>{locale === 'ar' && a.nameAr ? a.nameAr : a.nameEn} <span className="muted">· {locale === 'ar' && a.cityAr ? a.cityAr : a.cityEn}</span></td>
              <td className="ltr">{a.countryCode}</td><td className="ltr">{a.timezone ?? ''}</td><td><StatusBadge status={a.status} /></td>
              <td className="row-actions">{canManage && <>
                <button onClick={() => setEdit(a)}>{t('edit')}</button>
                <button onClick={async () => { try { await call('airports.setActive', { iataCode: a.iataCode, active: a.status !== 'ACTIVE' }); list.reload(); } catch (e) { setError(errorMessage(e)); } }}>{a.status === 'ACTIVE' ? t('archive') : t('restoreRecord')}</button>
              </>}</td></tr>
          ))}</tbody>
        </table>
      )}
      {edit && <AirportDialog airport={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); list.reload(); }} />}
    </div>
  );
}

function AirportDialog({ airport, onClose, onDone }: { airport: AirportDto | null; onClose: () => void; onDone: () => void }) {
  const { t, errorMessage, fieldIssues } = useI18n();
  const [values, setValues] = useState<FormValues>(() => fromRecord(airport, DEFS));
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      const p = toPayload(values, DEFS);
      await call(airport ? 'airports.update' : 'airports.create', airport ? { airport: p, rowVersion: airport.rowVersion } : { airport: p });
      onDone();
    } catch (e) { setError(errorMessage(e)); setIssues(fieldIssues(e)); }
  };
  return (
    <Modal wide title={airport ? airport.iataCode : t('navAirports')} onClose={onClose}
      footer={<><button className="primary" onClick={save}>{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <FormFields defs={airport ? DEFS.map((d) => (d.name === 'iataCode' ? { ...d } : d)) : DEFS} values={values} onChange={setValues} issues={issues} />
    </Modal>
  );
}
