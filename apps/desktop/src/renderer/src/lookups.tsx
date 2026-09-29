import { useEffect, useState } from 'react';
import type { AirlineDto, AirportDto, CustomerDto, PageDto, SupplierDto } from '@airdesk/contracts';
import { call } from './api';
import { Alert } from './components';
import { useI18n } from './i18n';

/** Active suppliers / airlines for selects (small reference lists). */
export function useSuppliers(): SupplierDto[] {
  const [list, setList] = useState<SupplierDto[]>([]);
  useEffect(() => { call<PageDto<SupplierDto>>('suppliers.list', { limit: 200, sortBy: 'name' }).then((p) => setList(p.items), () => setList([])); }, []);
  return list;
}

export function useAirlines(): AirlineDto[] {
  const [list, setList] = useState<AirlineDto[]>([]);
  useEffect(() => { call<PageDto<AirlineDto>>('airlines.list', { limit: 200, sortBy: 'nameEn' }).then((p) => setList(p.items), () => setList([])); }, []);
  return list;
}

export function SupplierSelect({ value, onChange, label, suppliers, testId, disabled, emptyLabel }: { value: string | null; onChange: (id: string | null) => void; label: string; suppliers: SupplierDto[]; testId?: string; disabled?: boolean; emptyLabel?: string }) {
  const { t } = useI18n();
  return (
    <label>{label}
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} data-testid={testId}>
        <option value="">{emptyLabel ?? t('none')}</option>
        {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.supplierNo})</option>)}
      </select>
    </label>
  );
}

export function AirlineSelect({ value, onChange, label, airlines, testId, disabled, emptyLabel }: { value: string | null; onChange: (id: string | null) => void; label: string; airlines: AirlineDto[]; testId?: string; disabled?: boolean; emptyLabel?: string }) {
  const { t, locale } = useI18n();
  return (
    <label>{label}
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} data-testid={testId}>
        <option value="">{emptyLabel ?? t('none')}</option>
        {airlines.map((a) => <option key={a.id} value={a.id}>{a.iataCode ?? '—'} · {locale === 'ar' && a.nameAr ? a.nameAr : a.nameEn}</option>)}
      </select>
    </label>
  );
}

/** Airport code input with type-ahead suggestions (code, name, city, country). */
export function AirportInput({ value, onChange, label, testId, disabled }: { value: string; onChange: (code: string) => void; label: string; testId?: string; disabled?: boolean }) {
  const { locale } = useI18n();
  const [options, setOptions] = useState<AirportDto[]>([]);
  const listId = `ap-${testId ?? label}`;
  useEffect(() => {
    const q = value.trim();
    if (q.length < 2) return;
    const h = setTimeout(() => {
      call<PageDto<AirportDto>>('airports.list', { query: q, limit: 12 }).then((p) => setOptions(p.items), () => undefined);
    }, 200);
    return () => clearTimeout(h);
  }, [value]);
  const match = options.find((o) => o.iataCode === value.toUpperCase());
  return (
    <label>{label}
      <input className="ltr code" list={listId} value={value} maxLength={3} disabled={disabled} data-testid={testId}
        onChange={(e) => onChange(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} />
      <datalist id={listId}>
        {options.map((o) => <option key={o.iataCode} value={o.iataCode}>{`${locale === 'ar' && o.nameAr ? o.nameAr : o.nameEn} — ${locale === 'ar' && o.cityAr ? o.cityAr : o.cityEn ?? ''}`}</option>)}
      </datalist>
      {match && <span className="hint">{locale === 'ar' && match.nameAr ? match.nameAr : match.nameEn}</span>}
    </label>
  );
}

/** Find an existing customer by name / mobile / number, or create one in place (name + mobile). */
export function CustomerPicker({ value, onPick, canCreate }: { value: CustomerDto | null; onPick: (c: CustomerDto) => void; canCreate: boolean }) {
  const { t, errorMessage } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerDto[]>([]);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ fullName: '', primaryMobile: '' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    const h = setTimeout(() => {
      call<PageDto<CustomerDto>>('customers.list', { query, limit: 8 }).then((p) => setResults(p.items), () => setResults([]));
    }, 200);
    return () => clearTimeout(h);
  }, [query]);
  const create = async (confirm: boolean) => {
    setError(null);
    try {
      onPick(await call<CustomerDto>('customers.create', { customer: draft, confirmDuplicates: confirm }));
      setCreating(false);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'DUPLICATE_WARNING' && window.confirm(t('duplicateText'))) return create(true);
      setError(errorMessage(e));
    }
  };
  if (value) {
    return (
      <div className="picked" data-testid="picked-customer">
        <strong>{value.fullName}</strong> <span className="muted ltr">{value.customerNo} · {value.primaryMobile}</span>
      </div>
    );
  }
  return (
    <div className="picker">
      <input type="search" autoFocus placeholder={t('pickCustomer')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="customer-search" />
      {results.length > 0 && (
        <ul className="suggestions" role="listbox">
          {results.map((c) => (
            <li key={c.id}><button type="button" onClick={() => onPick(c)} data-testid="customer-option">{c.fullName} <span className="muted ltr">{c.customerNo} · {c.primaryMobile}</span></button></li>
          ))}
        </ul>
      )}
      {canCreate && !creating && <button type="button" className="link" onClick={() => { setCreating(true); setDraft({ fullName: query, primaryMobile: '' }); }} data-testid="quick-customer">+ {t('quickCustomer')}</button>}
      {creating && (
        <div className="grid inline-form">
          <label>{t('fullName')}<input value={draft.fullName} onChange={(e) => setDraft({ ...draft, fullName: e.target.value })} data-testid="qc-name" /></label>
          <label>{t('primaryMobile')}<input className="ltr" value={draft.primaryMobile} onChange={(e) => setDraft({ ...draft, primaryMobile: e.target.value })} data-testid="qc-mobile" /></label>
          <div className="actions"><button type="button" className="primary" onClick={() => create(false)} data-testid="qc-save">{t('save')}</button><button type="button" onClick={() => setCreating(false)}>{t('cancel')}</button></div>
        </div>
      )}
      {error && <Alert kind="error">{error}</Alert>}
    </div>
  );
}
