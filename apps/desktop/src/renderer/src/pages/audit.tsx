import { useState } from 'react';
import type { AuditEntryDto, UserDto } from '@airdesk/contracts';
import { call } from '../api';
import { EmptyState, LoadError, Modal, PageHeader, useLoader } from '../components';
import { useI18n } from '../i18n';
import { useFmt } from '../prefs';

const ENTITY_TYPES = ['customer', 'supplier', 'airline', 'app_user', 'role', 'company_profile', 'session', 'backup', 'currency_rate', 'fin_document'];
const PAGE = 100;

/** Read-only view over the existing hash-chained audit log (Phase 1); no second audit implementation. */
export function AuditPage({ canListUsers }: { canListUsers: boolean }) {
  const { t } = useI18n();
  const { dateTime } = useFmt();
  const [draft, setDraft] = useState({ entityType: '', action: '', userId: '', from: '', to: '' });
  const [filter, setFilter] = useState(draft);
  const [pages, setPages] = useState<AuditEntryDto[][]>([]);
  const [open, setOpen] = useState<AuditEntryDto | null>(null);
  const users = useLoader(() => (canListUsers ? call<UserDto[]>('users.list', {}) : Promise.resolve([] as UserDto[])), []);
  const query = (beforeSeq?: number) =>
    call<AuditEntryDto[]>('audit.list', {
      limit: PAGE,
      ...(beforeSeq ? { beforeSeq } : {}),
      ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== '')),
    });
  const first = useLoader(() => query().then((rows) => { setPages([rows]); return rows; }), [filter]);
  const rows = pages.flat();
  const more = async () => {
    const last = rows[rows.length - 1];
    if (last) setPages([...pages, await query(last.seq)]);
  };

  return (
    <div className="page" data-testid="page-audit">
      <PageHeader title={t('navAudit')} />
      <p className="muted">{t('auditIntro')}</p>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setFilter(draft); }}>
        <label className="inline">{t('entityType')}
          <select value={draft.entityType} onChange={(e) => setDraft({ ...draft, entityType: e.target.value })} data-testid="audit-entity">
            <option value="">{t('all')}</option>
            {ENTITY_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="inline">{t('action')}<input className="ltr" value={draft.action} placeholder="customer." onChange={(e) => setDraft({ ...draft, action: e.target.value })} data-testid="audit-action" /></label>
        {canListUsers && (
          <label className="inline">{t('user')}
            <select value={draft.userId} onChange={(e) => setDraft({ ...draft, userId: e.target.value })}>
              <option value="">{t('all')}</option>
              {(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
            </select>
          </label>
        )}
        <label className="inline">{t('from')}<input type="date" className="ltr" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label>
        <label className="inline">{t('to')}<input type="date" className="ltr" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label>
        <button className="primary" data-testid="audit-apply">{t('apply')}</button>
      </form>
      {first.error && <LoadError error={first.error} onRetry={first.reload} />}
      {!first.loading && !first.error && rows.length === 0 && <EmptyState text={t('emptySearch')} />}
      {rows.length > 0 && (
        <table data-testid="audit-table">
          <thead><tr><th>#</th><th>{t('date')}</th><th>{t('user')}</th><th>{t('workstation')}</th><th>{t('action')}</th><th>{t('entity')}</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.seq}>
                <td className="ltr">{r.seq}</td>
                <td className="ltr">{dateTime(r.occurredAt)}</td>
                <td className="ltr">{r.username ?? '—'}</td>
                <td className="ltr">{r.workstation ?? ''}</td>
                <td className="ltr" data-action={r.action}>{r.action}</td>
                <td className="ltr">{r.entityType}{r.entityId ? ` · ${r.entityId.slice(-6)}` : ''}</td>
                <td><button onClick={() => setOpen(r)}>{t('details')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 0 && (pages[pages.length - 1]?.length ?? 0) === PAGE && <div className="actions"><button onClick={more}>{t('loadMore')}</button></div>}
      {open && (
        <Modal wide title={`${open.action} #${open.seq}`} onClose={() => setOpen(null)} footer={<button onClick={() => setOpen(null)}>{t('close')}</button>}>
          <div className="json-grid">
            {(['before', 'after', 'metadata'] as const).map((k) => open[k] != null && (
              <div key={k}><h3>{t(k)}</h3><pre className="ltr">{JSON.stringify(open[k], null, 2)}</pre></div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
