import { useEffect, useState } from 'react';
import type { BackupRecordDto, IntegrityReportDto } from '@airdesk/contracts';
import { call } from '../api';
import { useI18n } from '../i18n';

export function SystemPage({ canBackup, canRestore, canCheck, onRestored }: { canBackup: boolean; canRestore: boolean; canCheck: boolean; onRestored: () => void }) {
  const { t, errorMessage } = useI18n();
  const [backups, setBackups] = useState<BackupRecordDto[]>([]);
  const [report, setReport] = useState<IntegrityReportDto | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [restore, setRestore] = useState({ filePath: '', password: '', confirmation: '' });

  const load = () => (canBackup || canRestore ? call<BackupRecordDto[]>('backup.list').then(setBackups) : Promise.resolve());
  useEffect(() => { void load(); }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page card" data-testid="page-system">
      <h1>{t('navSystem')}</h1>
      {msg && <div className={`alert ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</div>}
      <div className="actions">
        {canBackup && (
          <button className="primary" disabled={busy} onClick={() => run(async () => {
            const r = await call<{ filePath: string }>('backup.create');
            setMsg({ ok: true, text: r.filePath });
            await load();
          })}>{t('backupNow')}</button>
        )}
        {canCheck && (
          <button disabled={busy} onClick={() => run(async () => setReport(await call<IntegrityReportDto>('integrity.run')))}>{t('runIntegrity')}</button>
        )}
      </div>
      {report && (
        <div className={`alert ${report.ok ? 'ok' : 'error'}`}>
          {report.ok ? t('integrityOk') : t('integrityFailed')}
          <ul>{report.checks.map((c) => <li key={c.id} className="ltr">{c.ok ? '✔' : '✘'} {c.id}{c.details ? ` — ${c.details}` : ''}</li>)}</ul>
        </div>
      )}
      <h2>{t('backups')}</h2>
      <table>
        <thead><tr><th>{t('date')}</th><th>{t('status')}</th><th>{t('file')}</th></tr></thead>
        <tbody>
          {backups.map((b) => (
            <tr key={b.id}>
              <td className="ltr">{b.startedAt.replace('T', ' ').slice(0, 19)}</td>
              <td><span className={`badge ${b.status === 'SUCCEEDED' ? 'ok' : 'bad'}`}>{b.kind} · {b.status}</span></td>
              <td className="ltr">{b.filePath ?? b.errorMessage}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {canRestore && (
        <>
          <h2>{t('restore')}</h2>
          <p className="muted">{t('restoreWarning')}</p>
          <div className="grid">
            <label>{t('backupFilePath')}<input className="ltr" value={restore.filePath} onChange={(e) => setRestore({ ...restore, filePath: e.target.value })} /></label>
            <label>{t('password')}<input className="ltr" type="password" value={restore.password} onChange={(e) => setRestore({ ...restore, password: e.target.value })} /></label>
            <label>RESTORE<input className="ltr" value={restore.confirmation} onChange={(e) => setRestore({ ...restore, confirmation: e.target.value })} /></label>
          </div>
          <div className="actions">
            <button className="danger" disabled={busy || restore.confirmation !== 'RESTORE' || !restore.filePath || !restore.password}
              onClick={() => run(async () => { await call('backup.restore', restore); onRestored(); })}>{t('restore')}</button>
          </div>
        </>
      )}
    </div>
  );
}
