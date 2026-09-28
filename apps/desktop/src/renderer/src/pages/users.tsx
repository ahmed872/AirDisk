import { useMemo, useState } from 'react';
import type { PermissionDto, RoleDto, UserDto } from '@airdesk/contracts';
import { call } from '../api';
import { Alert, ConfirmDialog, EmptyState, FormFields, LoadError, Modal, PageHeader, StatusBadge, fromRecord, toPayload, useLoader, type FieldDef, type FormValues } from '../components';
import { isTKey, useI18n, type FieldIssue } from '../i18n';
import { useFmt } from '../prefs';

type Can = (p: string) => boolean;

/** Users & Roles (Phase 2 §6). Every action is re-authorized by the backend; hiding buttons is only a convenience. */
export function UsersRolesPage({ can, selfId }: { can: Can; selfId: string }) {
  const { t } = useI18n();
  const tabs = [
    { id: 'users' as const, label: t('users'), visible: can('user.view') },
    { id: 'roles' as const, label: t('roles'), visible: can('role.view') },
  ].filter((x) => x.visible);
  const [tab, setTab] = useState(tabs[0]?.id ?? 'users');
  return (
    <div className="page" data-testid="page-users">
      <PageHeader title={t('navUsers')} />
      <div className="tabs" role="tablist">
        {tabs.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? 'active' : ''} onClick={() => setTab(x.id)} data-testid={`tab-${x.id}`}>{x.label}</button>
        ))}
      </div>
      {tab === 'users' && can('user.view') && <UsersTab can={can} selfId={selfId} />}
      {tab === 'roles' && can('role.view') && <RolesTab can={can} />}
    </div>
  );
}

function roleName(r: RoleDto | undefined, code: string, locale: 'ar' | 'en') {
  return r ? (locale === 'ar' ? r.nameAr : r.nameEn) : code;
}

function UsersTab({ can, selfId }: { can: Can; selfId: string }) {
  const { t, locale } = useI18n();
  const { dateTime } = useFmt();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'ALL' | 'ACTIVE' | 'DISABLED'>('ALL');
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'new' } | { kind: 'edit' | 'reset' | 'disable'; user: UserDto } | null>(null);
  const users = useLoader(() => call<UserDto[]>('users.list', { query: query || undefined, status }), [query, status]);
  const roles = useLoader(() => (can('role.view') || can('user.assign_roles') ? call<RoleDto[]>('roles.list') : Promise.resolve([] as RoleDto[])), []);
  const byCode = useMemo(() => new Map((roles.data ?? []).map((r) => [r.code, r])), [roles.data]);
  const done = (msg = t('saved')) => { setDialog(null); setNotice(msg); users.reload(); };
  const quick = async (fn: () => Promise<unknown>) => {
    try { await fn(); done(); } catch (e) { setNotice(null); throw e; }
  };
  const [rowError, setRowError] = useState<string | null>(null);
  const { errorMessage } = useI18n();

  return (
    <>
      <div className="toolbar" role="search">
        <input type="search" className="grow" placeholder={t('search')} aria-label={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="user-search" />
        <label className="inline">{t('status')}
          <select value={status} onChange={(e) => setStatus(e.target.value as never)}>
            <option value="ALL">{t('all')}</option><option value="ACTIVE">{t('active')}</option><option value="DISABLED">{t('disabled')}</option>
          </select>
        </label>
        {can('user.create') && <button className="primary" onClick={() => setDialog({ kind: 'new' })} data-testid="new-user">{t('createUser')}</button>}
      </div>
      {notice && <Alert kind="ok">{notice}</Alert>}
      {rowError && <Alert kind="error">{rowError}</Alert>}
      {users.error && <LoadError error={users.error} onRetry={users.reload} />}
      {users.data && users.data.length === 0 && <EmptyState text={t('emptySearch')} />}
      {users.data && users.data.length > 0 && (
        <table data-testid="users-table">
          <thead><tr><th>{t('username')}</th><th>{t('displayName')}</th><th>{t('email')}</th><th>{t('mobile')}</th><th>{t('roles')}</th><th>{t('status')}</th><th>{t('lastLogin')}</th><th /></tr></thead>
          <tbody>
            {users.data.map((u) => (
              <tr key={u.id} data-username={u.username}>
                <td className="ltr">{u.username}</td>
                <td>{u.displayName}</td>
                <td className="ltr">{u.email ?? ''}</td>
                <td className="ltr">{u.mobile ?? ''}</td>
                <td>{u.roles.map((c) => roleName(byCode.get(c), c, locale)).join('، ')}</td>
                <td><StatusBadge status={u.status} /></td>
                <td className="ltr">{dateTime(u.lastLoginAt)}</td>
                <td className="row-actions">
                  {(can('user.edit') || can('user.assign_roles')) && <button onClick={() => setDialog({ kind: 'edit', user: u })} data-testid="edit-user">{t('edit')}</button>}
                  {can('user.disable') && u.id !== selfId && (u.isActive
                    ? <button className="danger" onClick={() => setDialog({ kind: 'disable', user: u })}>{t('disable')}</button>
                    : <button onClick={() => quick(() => call('users.setActive', { userId: u.id, active: true })).catch((e) => setRowError(errorMessage(e)))}>{t('enable')}</button>)}
                  {can('user.disable') && u.status === 'LOCKED' && (
                    <button onClick={() => quick(() => call('users.unlock', { userId: u.id })).catch((e) => setRowError(errorMessage(e)))}>{t('unlock')}</button>
                  )}
                  {can('user.reset_credentials') && <button onClick={() => setDialog({ kind: 'reset', user: u })}>{t('resetPassword')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {dialog?.kind === 'new' && <UserDialog roles={roles.data ?? []} canAssign={can('user.assign_roles')} canEdit onClose={() => setDialog(null)} onSaved={() => done()} />}
      {dialog?.kind === 'edit' && <UserDialog user={dialog.user} roles={roles.data ?? []} canAssign={can('user.assign_roles')} canEdit={can('user.edit')} onClose={() => setDialog(null)} onSaved={() => done()} />}
      {dialog?.kind === 'reset' && <ResetDialog user={dialog.user} onClose={() => setDialog(null)} onSaved={() => done()} />}
      {dialog?.kind === 'disable' && (
        <ConfirmDialog title={`${t('disable')}: ${dialog.user.username}`} text={t('confirmDisableUser')} confirmLabel={t('disable')} danger
          onClose={() => setDialog(null)} onConfirm={async () => { await call('users.setActive', { userId: dialog.user.id, active: false }); done(); }} />
      )}
    </>
  );
}

function UserDialog({ user, roles, canAssign, canEdit, onClose, onSaved }: {
  user?: UserDto; roles: RoleDto[]; canAssign: boolean; canEdit: boolean; onClose: () => void; onSaved: () => void;
}) {
  const { t, locale, errorMessage, fieldIssues } = useI18n();
  const defs: FieldDef[] = [
    ...(user ? [] : [{ name: 'username', label: 'username', ltr: true, required: true, maxLength: 40 } as FieldDef]),
    { name: 'displayName', label: 'displayName', required: true, maxLength: 100 },
    { name: 'email', label: 'email', kind: 'email', ltr: true, maxLength: 200 },
    { name: 'mobile', label: 'mobile', kind: 'tel', ltr: true, maxLength: 40 },
    ...(user ? [] : [{ name: 'password', label: 'temporaryPassword', kind: 'password', ltr: true, required: true, hint: 'temporaryPasswordHint' } as FieldDef]),
    { name: 'notes', label: 'notes', kind: 'textarea', maxLength: 2000 },
  ];
  const [values, setValues] = useState<FormValues>(() => fromRecord(user ?? null, defs));
  const [selected, setSelected] = useState<string[]>(user?.roles ?? ['SALES_AGENT'].filter((c) => roles.some((r) => r.code === c)));
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (code: string) => setSelected(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setIssues([]);
    const p = toPayload(values, defs);
    try {
      if (!user) {
        await call('users.create', { username: p.username, displayName: p.displayName, password: values.password ?? '', roleCodes: selected, email: p.email, mobile: p.mobile, notes: p.notes });
      } else {
        if (canEdit) await call('users.update', { userId: user.id, displayName: p.displayName, email: p.email, mobile: p.mobile, notes: p.notes, rowVersion: user.rowVersion });
        const changed = [...selected].sort().join() !== [...user.roles].sort().join();
        if (canAssign && changed) await call('users.setRoles', { userId: user.id, roleCodes: selected });
      }
      onSaved();
    } catch (e) {
      setIssues(fieldIssues(e));
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal wide testId="user-dialog" title={user ? `${t('editUser')}: ${user.username}` : t('createUser')} onClose={onClose}
      footer={<><button className="primary" disabled={busy || selected.length === 0} onClick={save} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <FormFields defs={defs} values={values} onChange={setValues} issues={issues} disabled={!!user && !canEdit} />
        {!user && <p className="hint">{t('passwordRule')}</p>}
        <fieldset disabled={!canAssign} className="roles-picker">
          <legend>{t('roles')}</legend>
          <p className="hint">{t('assignRolesHint')}</p>
          {roles.map((r) => (
            <label key={r.code} className="check">
              <input type="checkbox" checked={selected.includes(r.code)} onChange={() => toggle(r.code)} data-testid={`role-${r.code}`} />
              {roleName(r, r.code, locale)} <span className="muted ltr">({r.code})</span>
            </label>
          ))}
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function ResetDialog({ user, onClose, onSaved }: { user: UserDto; onClose: () => void; onSaved: () => void }) {
  const { t, errorMessage } = useI18n();
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await call('users.resetPassword', { userId: user.id, newPassword: pw });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Modal title={`${t('resetPassword')}: ${user.username}`} onClose={onClose}
      footer={<><button className="primary" disabled={!pw} onClick={save}>{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <label>{t('temporaryPassword')}<input type="password" className="ltr" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      <p className="hint">{t('temporaryPasswordHint')} · {t('passwordRule')}</p>
    </Modal>
  );
}

function RolesTab({ can }: { can: Can }) {
  const { t, locale, errorMessage } = useI18n();
  const roles = useLoader(() => call<RoleDto[]>('roles.list'), []);
  const perms = useLoader(() => call<PermissionDto[]>('permissions.list'), []);
  const members = useLoader(() => (can('user.view') ? call<UserDto[]>('users.list', {}) : Promise.resolve([] as UserDto[])), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const role = roles.data?.find((r) => r.id === selectedId) ?? null;

  if (roles.error) return <LoadError error={roles.error} onRetry={roles.reload} />;
  return (
    <div className="split">
      <aside className="list-pane">
        {can('role.create') && <button className="primary block" onClick={() => setCreating(true)} data-testid="new-role">{t('newRole')}</button>}
        <ul className="nav-list" data-testid="roles-list">
          {(roles.data ?? []).map((r) => (
            <li key={r.id}>
              <button className={r.id === selectedId ? 'active' : ''} onClick={() => { setSelectedId(r.id); setNotice(null); }} data-role={r.code}>
                <strong>{roleName(r, r.code, locale)}</strong>
                <span className="muted small ltr">{r.code} · {r.userCount}</span>
                {r.isSystem && <span className="badge muted">{t('systemRole')}</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="detail-pane">
        {notice && <Alert kind={notice.ok ? 'ok' : 'error'}>{notice.text}</Alert>}
        {!role && <EmptyState text={t('selectRole')} />}
        {role && perms.data && (
          <RoleEditor key={`${role.id}:${role.permissions.length}:${role.nameAr}:${role.nameEn}`} role={role} perms={perms.data} can={can}
            members={(members.data ?? []).filter((u) => u.roles.includes(role.code))}
            onSaved={() => { setNotice({ ok: true, text: t('saved') }); roles.reload(); }}
            onError={(e) => setNotice({ ok: false, text: errorMessage(e) })} />
        )}
      </section>
      {creating && (
        <NewRoleDialog onClose={() => setCreating(false)} onSaved={() => { setCreating(false); setNotice({ ok: true, text: t('saved') }); roles.reload(); }} />
      )}
    </div>
  );
}

const MODULE_ORDER = ['company', 'user', 'role', 'customer', 'supplier', 'airline', 'booking', 'finance', 'treasury', 'report'];

function RoleEditor({ role, perms, can, members, onSaved, onError }: {
  role: RoleDto; perms: PermissionDto[]; can: Can; members: UserDto[]; onSaved: () => void; onError: (e: unknown) => void;
}) {
  const { t, locale } = useI18n();
  const [names, setNames] = useState({ nameAr: role.nameAr, nameEn: role.nameEn, description: role.description ?? '' });
  const [granted, setGranted] = useState(new Set(role.permissions));
  const isAdmin = role.code === 'ADMIN';
  const canPerms = can('role.manage_permissions') && !isAdmin;
  const groups = useMemo(() => {
    const m = new Map<string, PermissionDto[]>();
    for (const p of perms) {
      const mod = MODULE_ORDER.includes(p.module) ? p.module : isTKey(`mod_${p.module}`) ? p.module : 'other';
      m.set(mod, [...(m.get(mod) ?? []), p]);
    }
    return [...m.entries()].sort((a, b) => (MODULE_ORDER.indexOf(a[0]) + 1 || 99) - (MODULE_ORDER.indexOf(b[0]) + 1 || 99));
  }, [perms]);
  const toggle = (code: string) => {
    const n = new Set(granted);
    if (n.has(code)) n.delete(code); else n.add(code);
    setGranted(n);
  };
  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); onSaved(); } catch (e) { onError(e); }
  };
  return (
    <div data-testid="role-editor">
      <h2>{roleName(role, role.code, locale)} <span className="muted ltr">({role.code})</span></h2>
      <div className="grid">
        <label>{t('nameAr')}<input value={names.nameAr} disabled={!can('role.edit')} onChange={(e) => setNames({ ...names, nameAr: e.target.value })} /></label>
        <label>{t('nameEn')}<input className="ltr" value={names.nameEn} disabled={!can('role.edit')} onChange={(e) => setNames({ ...names, nameEn: e.target.value })} /></label>
        <label className="span-all">{t('description')}<input value={names.description} disabled={!can('role.edit')} onChange={(e) => setNames({ ...names, description: e.target.value })} /></label>
      </div>
      {can('role.edit') && (
        <div className="actions">
          <button onClick={() => run(() => call('roles.update', { roleId: role.id, nameAr: names.nameAr, nameEn: names.nameEn, description: names.description || null }))} data-testid="rename-role">{t('rename')}</button>
        </div>
      )}
      <h3>{t('members')}</h3>
      {members.length === 0 ? <p className="muted">{t('noMembers')}</p> : <p>{members.map((u) => u.displayName).join('، ')}</p>}
      <h3>{t('permissions')}</h3>
      {isAdmin && <Alert kind="info">{t('adminRoleFixed')}</Alert>}
      <div className="perm-matrix">
        {groups.map(([mod, list]) => (
          <fieldset key={mod} disabled={!canPerms}>
            <legend>{isTKey(`mod_${mod}`) ? t(`mod_${mod}` as never) : mod}</legend>
            {list.map((p) => (
              <label key={p.code} className="check">
                <input type="checkbox" checked={granted.has(p.code)} onChange={() => toggle(p.code)} data-perm={p.code} />
                {locale === 'ar' ? p.ar : p.en}
                {p.sensitive && <span className="badge warn">{t('sensitive')}</span>}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      {canPerms && (
        <div className="actions">
          <button className="primary" onClick={() => run(() => call('roles.setPermissions', { roleId: role.id, permissions: [...granted] }))} data-testid="save-permissions">{t('savePermissions')}</button>
        </div>
      )}
    </div>
  );
}

function NewRoleDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, errorMessage, fieldIssues } = useI18n();
  const defs: FieldDef[] = [
    { name: 'code', label: 'roleCode', ltr: true, required: true, upper: true, maxLength: 40, hint: 'roleCodeHint' },
    { name: 'nameAr', label: 'nameAr', required: true, maxLength: 100 },
    { name: 'nameEn', label: 'nameEn', ltr: true, required: true, maxLength: 100 },
  ];
  const [values, setValues] = useState<FormValues>({});
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await call('roles.create', { code: values.code ?? '', nameAr: values.nameAr ?? '', nameEn: values.nameEn ?? '', permissions: [] });
      onSaved();
    } catch (e) {
      setIssues(fieldIssues(e));
      setError(errorMessage(e));
    }
  };
  return (
    <Modal title={t('newRole')} onClose={onClose} testId="role-dialog"
      footer={<><button className="primary" onClick={save} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <FormFields defs={defs} values={values} onChange={setValues} issues={issues} />
    </Modal>
  );
}
