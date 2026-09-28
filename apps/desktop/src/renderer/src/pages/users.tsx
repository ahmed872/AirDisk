import { useEffect, useState, type FormEvent } from 'react';
import type { RoleDto, UserDto } from '@airdesk/contracts';
import { call } from '../api';
import { useI18n } from '../i18n';

export function UsersPage() {
  const { t, errorMessage, locale } = useI18n();
  const [users, setUsers] = useState<UserDto[]>([]);
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'SALES_AGENT' });

  const load = async () => {
    setUsers(await call<UserDto[]>('users.list'));
    setRoles(await call<RoleDto[]>('roles.list'));
  };
  useEffect(() => { void load().catch((e) => setMsg({ ok: false, text: errorMessage(e) })); }, []);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setMsg({ ok: true, text: t('saved') });
      await load();
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await call('users.create', { username: form.username, displayName: form.displayName, password: form.password, roleCodes: [form.role] });
      setForm({ ...form, username: '', displayName: '', password: '' });
    });
  };
  return (
    <div className="card" style={{ width: '100%' }}>
      <h1>{t('users')}</h1>
      {msg && <div className={`alert ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</div>}
      <table>
        <thead><tr><th>{t('username')}</th><th>{t('displayName')}</th><th>{t('roles')}</th><th>{t('status')}</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td className="ltr">{u.username}</td>
              <td>{u.displayName}</td>
              <td>{u.roles.join(', ')}</td>
              <td>
                <span className={`badge ${u.isActive ? 'ok' : 'bad'}`}>{u.isActive ? t('active') : t('disabled')}</span>
                {u.isLocked && <span className="badge bad">{t('locked')}</span>}
              </td>
              <td>
                <button type="button" onClick={() => act(() => call('users.setActive', { userId: u.id, active: !u.isActive }))}>
                  {u.isActive ? t('disable') : t('enable')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>{t('createUser')}</h2>
      <form className="grid" onSubmit={create}>
        <label>{t('username')}<input className="ltr" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></label>
        <label>{t('displayName')}<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required /></label>
        <label>{t('temporaryPassword')}<input className="ltr" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>
        <label>{t('roles')}
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {roles.map((r) => <option key={r.id} value={r.code}>{locale === 'ar' ? r.nameAr : r.nameEn}</option>)}
          </select>
        </label>
        <div className="actions"><button className="primary">{t('createUser')}</button></div>
      </form>
    </div>
  );
}
