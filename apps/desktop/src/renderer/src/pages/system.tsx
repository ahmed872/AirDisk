import { useEffect, useState } from 'react';
import type { BackupRecordDto, IntegrityReportDto } from '@airdesk/contracts';
import { call } from '../api';
import { isTKey, useI18n, type TKey } from '../i18n';
import { useFmt } from '../prefs';

interface Schedule { intervalHours: number; keep: number; lastSuccessfulAt: string | null; nextDueAt: string | null; directory: string }

export function SystemPage({ canBackup, canRestore, canCheck, canSettings, onRestored }: { canBackup: boolean; canRestore: boolean; canCheck: boolean; canSettings: boolean; onRestored: () => void }) {
  const { t, errorMessage } = useI18n();
  const { dateTime } = useFmt();
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [edit, setEdit] = useState<{ intervalHours: string; keep: string } | null>(null);
  const [backups, setBackups] = useState<BackupRecordDto[]>([]);
  const [report, setReport] = useState<IntegrityReportDto | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [restore, setRestore] = useState({ filePath: '', password: '', confirmation: '' });

  const load = async () => {
    if (canBackup || canRestore) setBackups(await call<BackupRecordDto[]>('backup.list'));
    if (canBackup || canRestore || canSettings) setSchedule(await call<Schedule>('backup.schedule'));
  };
  const label = (prefix: string, v: string) => (isTKey(`${prefix}${v}`) ? t(`${prefix}${v}` as TKey) : v);
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
      {schedule && (
        <section className="section" data-testid="backup-schedule">
          <h2>{t('autoBackup')}</h2>
          <p>{schedule.intervalHours === 0 ? t('autoBackupOff') : `${t('autoBackupEvery')} ${schedule.intervalHours} ${t('hours')} · ${t('autoBackupKeep')} ${schedule.keep}`}</p>
          <p className="muted small">{t('lastBackup')}: <span className="ltr">{schedule.lastSuccessfulAt ? dateTime(schedule.lastSuccessfulAt) : '—'}</span>
            {schedule.nextDueAt && <> · {t('nextBackup')}: <span className="ltr">{dateTime(schedule.nextDueAt)}</span></>} · <span className="ltr">{schedule.directory}</span></p>
          {!schedule.lastSuccessfulAt && <div className="alert warn">{t('noBackupYet')}</div>}
          {canSettings && !edit && <button onClick={() => setEdit({ intervalHours: String(schedule.intervalHours), keep: String(schedule.keep) })} data-testid="edit-schedule">{t('edit')}</button>}
          {edit && (
            <div className="grid">
              <label>{t('autoBackupEvery')} ({t('hours')}, 0 = {t('off')})<input className="ltr num" value={edit.intervalHours} onChange={(e) => setEdit({ ...edit, intervalHours: e.target.value })} data-testid="schedule-hours" /></label>
              <label>{t('autoBackupKeep')}<input className="ltr num" value={edit.keep} onChange={(e) => setEdit({ ...edit, keep: e.target.value })} data-testid="schedule-keep" /></label>
              <div className="actions">
                <button className="primary" disabled={busy} onClick={() => run(async () => {
                  setSchedule(await call<Schedule>('backup.setSchedule', { intervalHours: Number(edit.intervalHours), keep: Number(edit.keep) }));
                  setEdit(null);
                  setMsg({ ok: true, text: t('saved') });
                })} data-testid="save-schedule">{t('save')}</button>
                <button onClick={() => setEdit(null)}>{t('cancel')}</button>
              </div>
            </div>
          )}
        </section>
      )}
      <h2>{t('backups')}</h2>
      <table>
        <thead><tr><th>{t('date')}</th><th>{t('status')}</th><th>{t('file')}</th></tr></thead>
        <tbody>
          {backups.map((b) => (
            <tr key={b.id}>
              <td className="ltr">{b.startedAt.replace('T', ' ').slice(0, 19)}</td>
              <td><span className={`badge ${b.status === 'SUCCEEDED' ? 'ok' : 'bad'}`}>{label('bk_', b.kind)} · {label('bs_', b.status)}</span></td>
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
            <label>{t('backupFilePath')}
              <span className="input-with-button">
                <input className="ltr" value={restore.filePath} onChange={(e) => setRestore({ ...restore, filePath: e.target.value })} data-testid="restore-path" />
                <button type="button" onClick={async () => { const p = await window.airdesk.pickBackupFile(); if (p) setRestore({ ...restore, filePath: p }); }} data-testid="pick-backup">{t('chooseFile')}</button>
              </span>
            </label>
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
