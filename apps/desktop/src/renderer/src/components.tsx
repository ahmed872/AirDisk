import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n, type FieldIssue, type TKey } from './i18n';

/** Accessible modal dialog: focus moves inside, Escape closes, the page behind is inert. */
export function Modal({ title, onClose, children, footer, wide, testId }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="overlay" role="presentation">
      <div ref={ref} className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <header><h2>{title}</h2></header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="actions">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, text, confirmLabel, danger, withReason, onConfirm, onClose }: {
  title: string; text: string; confirmLabel: string; danger?: boolean; withReason?: boolean;
  onConfirm: (reason: string | null) => Promise<void> | void; onClose: () => void;
}) {
  const { t, errorMessage } = useI18n();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim() || null);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} testId="confirm-dialog"
      footer={<>
        <button type="button" className={danger ? 'danger' : 'primary'} disabled={busy} onClick={go} data-testid="confirm">{confirmLabel}</button>
        <button type="button" onClick={onClose}>{t('cancel')}</button>
      </>}>
      <p>{text}</p>
      {withReason && <label>{t('reason')}<input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>}
      {error && <Alert kind="error">{error}</Alert>}
    </Modal>
  );
}

export function Alert({ kind, children }: { kind: 'error' | 'ok' | 'info' | 'warn'; children: ReactNode }) {
  return <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function StatusBadge({ status }: { status: 'ACTIVE' | 'ARCHIVED' | 'DISABLED' | 'LOCKED' }) {
  const { t } = useI18n();
  const map = { ACTIVE: ['ok', 'active'], ARCHIVED: ['muted', 'archived'], DISABLED: ['bad', 'disabled'], LOCKED: ['warn', 'locked'] } as const;
  const [cls, key] = map[status];
  return <span className={`badge ${cls}`} data-status={status}>{t(key)}</span>;
}

export function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return <div className="empty" data-testid="empty-state"><p>{text}</p>{action}</div>;
}

export function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="alert error" role="alert">
      {t('loadFailed')}: {error} <button type="button" onClick={onRetry}>{t('retry')}</button>
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="page-header"><h1>{title}</h1><div className="actions tight">{children}</div></div>;
}

/* ───────── Forms ───────── */

export type FieldKind = 'text' | 'tel' | 'email' | 'date' | 'number' | 'textarea' | 'select' | 'password';
export interface FieldDef {
  name: string;
  label: TKey;
  kind?: FieldKind;
  ltr?: boolean;
  required?: boolean;
  maxLength?: number;
  options?: { value: string; label: string }[];
  hint?: TKey;
  upper?: boolean;
  wide?: boolean;
}

export type FormValues = Record<string, string>;

export function FormFields({ defs, values, onChange, issues, disabled }: {
  defs: FieldDef[]; values: FormValues; onChange: (v: FormValues) => void; issues: FieldIssue[]; disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="grid">
      {defs.map((d) => {
        const err = issues.find((i) => i.field === d.name);
        const common = {
          name: d.name,
          id: `f-${d.name}`,
          'data-testid': `f-${d.name}`,
          className: d.ltr ? 'ltr' : undefined,
          value: values[d.name] ?? '',
          disabled,
          required: d.required,
          maxLength: d.maxLength,
          'aria-invalid': err ? true : undefined,
          'aria-describedby': err ? `e-${d.name}` : undefined,
          onChange: (e: { target: { value: string } }) => onChange({ ...values, [d.name]: d.upper ? e.target.value.toUpperCase() : e.target.value }),
        };
        let input: ReactNode;
        if (d.kind === 'textarea') input = <textarea rows={3} {...common} />;
        else if (d.kind === 'select') input = <select {...common}>{d.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
        else input = <input type={d.kind ?? 'text'} dir={d.ltr ? 'ltr' : undefined} {...common} />;
        return (
          <label key={d.name} htmlFor={`f-${d.name}`} className={d.wide || d.kind === 'textarea' ? 'span-all' : undefined}>
            <span>{t(d.label)}{d.required && <span className="req" aria-hidden> *</span>}</span>
            {input}
            {d.hint && <span className="hint">{t(d.hint)}</span>}
            {err && <span className="field-error" id={`e-${d.name}`}>{err.message}</span>}
          </label>
        );
      })}
    </div>
  );
}

/** Converts form strings to a payload: '' → null, numeric fields parsed. */
export function toPayload(values: FormValues, defs: FieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const v = (values[d.name] ?? '').trim();
    if (d.kind === 'number') out[d.name] = v === '' ? null : Number(v);
    else out[d.name] = v === '' ? null : v;
  }
  return out;
}

export function fromRecord(rec: object | null, defs: FieldDef[], defaults: FormValues = {}): FormValues {
  const out: FormValues = { ...defaults };
  if (!rec) return out;
  const r = rec as Record<string, unknown>;
  for (const d of defs) if (r[d.name] !== null && r[d.name] !== undefined) out[d.name] = String(r[d.name]);
  return out;
}

/** Tiny data-loading hook with error + reload. */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const { errorMessage } = useI18n();
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const fn = useCallback(load, deps);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e) => live && setState({ data: null, error: errorMessage(e), loading: false }),
    );
    return () => {
      live = false;
    };
  }, [fn, tick, errorMessage]);
  return { ...state, reload: () => setTick((x) => x + 1) };
}
