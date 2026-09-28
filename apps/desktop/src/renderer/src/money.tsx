import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CurrencyDto } from '@airdesk/contracts';
import { call } from './api';
import { useI18n } from './i18n';
import { useFmt } from './prefs';

interface Money {
  currencies: CurrencyDto[];
  active: CurrencyDto[];
  base: string;
  unit(code: string): number;
  /** "1,050,000" minor → "10,500.00 EGP" in the configured digit style. */
  fmt(minor: number | null | undefined, currency: string): string;
  /** Minor → plain decimal string for an input field ("10500.00"). */
  toInput(minor: number | null | undefined, currency: string): string;
  /** User text (any digits, commas) → minor units, or null if invalid/empty. */
  parse(text: string, currency: string): number | null;
  reload(): void;
}

const Ctx = createContext<Money | null>(null);
const AR = '٠١٢٣٤٥٦٧٨٩';
const FA = '۰۱۲۳۴۵۶۷۸۹';

export function MoneyProvider({ base, children }: { base: string; children: ReactNode }) {
  const [currencies, setCurrencies] = useState<CurrencyDto[]>([]);
  const [tick, setTick] = useState(0);
  const { money } = useFmt();
  useEffect(() => {
    call<CurrencyDto[]>('currency.list').then(setCurrencies, () => setCurrencies([]));
  }, [tick]);
  const value = useMemo<Money>(() => {
    const unit = (code: string) => currencies.find((c) => c.code === code)?.minorUnit ?? 2;
    return {
      currencies,
      active: currencies.filter((c) => c.isActive),
      base,
      unit,
      fmt: (minor, currency) => (minor === null || minor === undefined ? '—' : money(minor, currency, unit(currency))),
      toInput: (minor, currency) => (minor === null || minor === undefined ? '' : (minor / 10 ** unit(currency)).toFixed(unit(currency))),
      parse: (text, currency) => {
        const t = text.trim().replace(/[٠-٩]/g, (d) => String(AR.indexOf(d))).replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[,\s٬]/g, '').replace('٫', '.');
        if (t === '') return null;
        const u = unit(currency);
        const re = new RegExp(`^\\d{1,13}(\\.\\d{0,${u}})?$`);
        if (!re.test(t)) return null;
        const [i, f = ''] = t.split('.');
        return Number(i) * 10 ** u + Number((f + '0'.repeat(u)).slice(0, u) || '0');
      },
      reload: () => setTick((x) => x + 1),
    };
  }, [currencies, base, money]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMoney(): Money {
  const v = useContext(Ctx);
  if (!v) throw new Error('MoneyProvider missing');
  return v;
}

/** Decimal amount input bound to minor units. Invalid text shows an inline error instead of guessing. */
export function MoneyInput({ value, currency, onChange, label, testId, disabled, required }: {
  value: number | null; currency: string; onChange: (minor: number | null) => void; label: string; testId?: string; disabled?: boolean; required?: boolean;
}) {
  const m = useMoney();
  const { t } = useI18n();
  const [text, setText] = useState(m.toInput(value, currency));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    if (m.parse(text, currency) !== value) setText(m.toInput(value, currency));
  }, [value, currency]);
  return (
    <label>
      <span>{label} <span className="muted ltr">({currency})</span>{required && <span className="req"> *</span>}</span>
      <input className="ltr num" inputMode="decimal" value={text} disabled={disabled} data-testid={testId} aria-invalid={bad || undefined}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = m.parse(e.target.value, currency);
          setBad(e.target.value.trim() !== '' && parsed === null);
          onChange(parsed);
        }} />
      {bad && <span className="field-error">{t('invalidFields')}</span>}
    </label>
  );
}

export function CurrencySelect({ value, onChange, label, testId, disabled, onlyActive = true }: {
  value: string; onChange: (c: string) => void; label: string; testId?: string; disabled?: boolean; onlyActive?: boolean;
}) {
  const m = useMoney();
  const { locale } = useI18n();
  const list = onlyActive ? m.active : m.currencies;
  return (
    <label>{label}
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        {list.map((c) => <option key={c.code} value={c.code}>{c.code} — {locale === 'ar' ? c.nameAr : c.nameEn}</option>)}
      </select>
    </label>
  );
}
