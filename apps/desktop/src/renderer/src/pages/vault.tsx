import { useEffect, useState, type FormEvent } from 'react';
import { formatRecoveryPassphrase, type BackupHeaderDto, type EncryptionStatusDto, type SystemStatusDto } from '@airdesk/contracts';
import { call } from '../api';
import { Alert, Modal } from '../components';
import { useI18n } from '../i18n';
import { useFmt } from '../prefs';

export interface RecoveryValue {
  passphrase: string;
  confirmation: string;
  acknowledged: boolean;
}
export const EMPTY_RECOVERY: RecoveryValue = { passphrase: '', confirmation: '', acknowledged: false };

/** A generated passphrase from the browser's CSPRNG (never leaves this window except to the backend). */
function generate(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return formatRecoveryPassphrase(bytes);
}

/**
 * Recovery passphrase entry with the explanation a ticket-office owner needs:
 * what it is for, that nobody else has it, and that losing it can mean losing
 * the data. The owner types it twice (or generates one) and confirms it is written down.
 */
export function RecoveryFields({ value, onChange, idPrefix = 'recovery' }: { value: RecoveryValue; onChange: (v: RecoveryValue) => void; idPrefix?: string }) {
  const { t } = useI18n();
  const [suggested, setSuggested] = useState<string | null>(null);
  return (
    <div className="recovery" data-testid={`${idPrefix}-section`}>
      <p>{t('recoveryIntro')}</p>
      <Alert kind="warn">{t('recoveryWarning')}</Alert>
      <p className="hint">{t('recoveryRule')}</p>
      <div className="actions">
        <button type="button" onClick={() => { const p = generate(); setSuggested(p); onChange({ ...value, passphrase: p, confirmation: '' }); }} data-testid={`${idPrefix}-generate`}>{t('recoveryGenerate')}</button>
      </div>
      {suggested && <p>{t('recoveryGenerated')} <strong className="ltr passphrase" data-testid={`${idPrefix}-suggested`}>{suggested}</strong></p>}
      <div className="grid">
        <label>{t('recoveryPassphrase')}<input className="ltr" type="text" autoComplete="off" spellCheck={false} value={value.passphrase} onChange={(e) => onChange({ ...value, passphrase: e.target.value })} data-testid={`${idPrefix}-passphrase`} required /></label>
        <label>{t('recoveryConfirm')}<input className="ltr" type="password" autoComplete="off" value={value.confirmation} onChange={(e) => onChange({ ...value, confirmation: e.target.value })} data-testid={`${idPrefix}-confirm`} required /></label>
      </div>
      <label className="check"><input type="checkbox" checked={value.acknowledged} onChange={(e) => onChange({ ...value, acknowledged: e.target.checked })} data-testid={`${idPrefix}-ack`} /> {t('recoveryAck')}</label>
    </div>
  );
}

/** The company data is encrypted and not unlocked for this Windows user / PC, or it is damaged. */
export function UnlockPage({ status, onOpened }: { status: SystemStatusDto; onOpened: () => void }) {
  const { t, errorMessage } = useI18n();
  const reason = status.lockReason ?? 'PASSPHRASE_REQUIRED';
  const needsKeySource = reason === 'KEY_FILE_MISSING' || reason === 'KEY_FILE_DAMAGED';
  const [mode, setMode] = useState<'unlock' | 'restore'>(reason === 'DATABASE_DAMAGED' ? 'restore' : 'unlock');
  const [passphrase, setPassphrase] = useState('');
  const [keySource, setKeySource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call('vault.unlock', { passphrase, keySourceBackupPath: keySource });
      onOpened();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (mode === 'restore') {
    return <RestoreOntoPc onDone={onOpened} onBack={reason === 'DATABASE_DAMAGED' ? undefined : () => setMode('unlock')} intro={reason === 'DATABASE_DAMAGED' ? t('unlock_DATABASE_DAMAGED') : undefined} />;
  }
  return (
    <div className="center">
      <form className="card narrow" onSubmit={submit} data-testid="unlock-page">
        <h1>{t('unlockTitle')}</h1>
        <p>{t(`unlock_${reason}` as never)}</p>
        {error && <Alert kind="error">{error}</Alert>}
        {needsKeySource && (
          <p>
            <button type="button" onClick={async () => setKeySource(await window.airdesk.pickBackupFile())} data-testid="unlock-key-source">{t('keyFromBackup')}</button>{' '}
            {keySource && <span className="ltr muted">{keySource}</span>}
          </p>
        )}
        <label>{t('recoveryPassphrase')}<input className="ltr" type="password" autoComplete="off" autoFocus value={passphrase} onChange={(e) => setPassphrase(e.target.value)} data-testid="unlock-passphrase" required /></label>
        <div className="actions">
          <button className="primary" disabled={busy || !passphrase || (needsKeySource && !keySource)} data-testid="unlock-submit">{t('unlockButton')}</button>
          <button type="button" className="link" onClick={() => setMode('restore')} data-testid="unlock-restore-instead">{t('restoreFromBackupInstead')}</button>
        </div>
      </form>
    </div>
  );
}

/** Restore a backup when no company data is open here (replacement PC, reinstalled Windows, damaged data). */
export function RestoreOntoPc({ onDone, onBack, intro }: { onDone: () => void; onBack?: () => void; intro?: string }) {
  const { t, errorMessage } = useI18n();
  const { dateTime } = useFmt();
  const [filePath, setFilePath] = useState<string | null>(null);
  const [header, setHeader] = useState<BackupHeaderDto | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [recovery, setRecovery] = useState<RecoveryValue>(EMPTY_RECOVERY);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async () => {
    setError(null);
    const p = await window.airdesk.pickBackupFile();
    if (!p) return;
    setFilePath(p);
    setHeader(null);
    try {
      setHeader(await call<BackupHeaderDto>('vault.inspectBackup', { filePath: p }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!filePath || !header) return;
    setBusy(true);
    setError(null);
    try {
      await call('vault.restoreBackup', header.encrypted
        ? { filePath, passphrase, confirmation }
        : { filePath, newRecovery: { passphrase: recovery.passphrase, confirmation: recovery.confirmation }, confirmation });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const ready = !!header && confirmation === 'RESTORE' && (header.encrypted ? !!passphrase : recovery.acknowledged && !!recovery.passphrase);
  return (
    <div className="center">
      <form className="card" onSubmit={submit} data-testid="restore-onto-pc">
        <h1>{t('restoreOntoPcTitle')}</h1>
        {intro && <Alert kind="warn">{intro}</Alert>}
        <p>{t('restoreOntoPcIntro')}</p>
        {error && <Alert kind="error">{error}</Alert>}
        <p><button type="button" onClick={pick} data-testid="restore-pick">{t('chooseBackupFile')}</button> {filePath && <span className="ltr muted" data-testid="restore-file">{filePath}</span>}</p>
        {header && (
          <>
            <p data-testid="restore-header">{t('backupInfo').replace('{date}', dateTime(header.createdAt)).replace('{version}', header.appVersion)} · {header.encrypted ? t('backupEncrypted') : t('backupNotEncrypted')}</p>
            {header.encrypted
              ? <label>{t('backupPassphraseLabel')}<input className="ltr" type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} data-testid="restore-passphrase" required /></label>
              : <RecoveryFields value={recovery} onChange={setRecovery} idPrefix="restore-recovery" />}
            <label>{t('typeRestore')}<input className="ltr" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} data-testid="restore-confirm" /></label>
          </>
        )}
        <div className="actions">
          <button className="primary" disabled={busy || !ready} data-testid="restore-submit">{t('restoreNow')}</button>
          {onBack && <button type="button" className="link" onClick={onBack}>{t('backToUnlock')}</button>}
        </div>
        {busy && <Alert kind="info">{t('workingPleaseWait')}</Alert>}
      </form>
    </div>
  );
}

/** Backup & restore page: encryption status and actions (enable for rc.1 data, change passphrase, delete plain backups). */
export function EncryptionCard({ canManage, onSignedOut }: { canManage: boolean; onSignedOut: () => void }) {
  const { t, errorMessage } = useI18n();
  const { date } = useFmt();
  const [s, setS] = useState<EncryptionStatusDto | null>(null);
  const [dialog, setDialog] = useState<null | 'enable' | 'change' | 'purge'>(null);
  const [password, setPassword] = useState('');
  const [recovery, setRecovery] = useState<RecoveryValue>(EMPTY_RECOVERY);
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => { call<EncryptionStatusDto>('security.encryptionStatus').then(setS, () => setS(null)); };
  useEffect(load, []);
  const close = () => { setDialog(null); setPassword(''); setRecovery(EMPTY_RECOVERY); setConfirm(''); };
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (dialog === 'enable') {
        await call('security.enableEncryption', { password, passphrase: recovery.passphrase, confirmation: recovery.confirmation });
        close();
        onSignedOut();
        return;
      }
      if (dialog === 'change') {
        const r = await call<{ backupFilePath: string | null }>('security.changeRecoveryPassphrase', { password, passphrase: recovery.passphrase, confirmation: recovery.confirmation });
        setMsg({ ok: true, text: `${t('recoveryChangedDone')} ${r.backupFilePath ?? ''}` });
      }
      if (dialog === 'purge') {
        const r = await call<{ removed: number }>('security.purgeUnencryptedBackups', { password, confirmation: confirm });
        setMsg({ ok: true, text: t('purgedDone').replace('{n}', String(r.removed)) });
      }
      close();
      load();
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  if (!s) return null;
  const needsRecovery = dialog === 'enable' || dialog === 'change';
  return (
    <section className="card section" data-testid="encryption-card">
      <h2>{t('encryptionTitle')}</h2>
      {msg && <Alert kind={msg.ok ? 'ok' : 'error'}>{msg.text}</Alert>}
      {s.encrypted
        ? <>
            <Alert kind="ok"><span data-testid="encryption-on">{t('encryptionOn')}</span></Alert>
            <p>{t(s.deviceProtection === 'none' ? 'encryptionDevice_none' : 'encryptionDevice_dpapi')}</p>
            {s.keyCreatedAt && <p className="muted">{t('encryptionKeyDate')} <span className="ltr">{date(s.keyCreatedAt.slice(0, 10))}</span></p>}
          </>
        : <Alert kind="error"><span data-testid="encryption-off">{t('encryptionOff')}</span></Alert>}
      {s.unencryptedBackupFiles > 0 && <p data-testid="unencrypted-count">{t('unencryptedBackups').replace('{n}', String(s.unencryptedBackupFiles))}</p>}
      {canManage && (
        <div className="actions">
          {!s.encrypted && <button className="primary" onClick={() => setDialog('enable')} data-testid="enable-encryption">{t('enableEncryption')}</button>}
          {s.encrypted && <button onClick={() => setDialog('change')} data-testid="change-recovery">{t('changeRecovery')}</button>}
          {s.encrypted && s.unencryptedBackupFiles > 0 && <button className="danger" onClick={() => setDialog('purge')} data-testid="purge-unencrypted">{t('purgeUnencrypted')}</button>}
        </div>
      )}
      {dialog && (
        <Modal title={t(dialog === 'enable' ? 'enableEncryption' : dialog === 'change' ? 'changeRecovery' : 'purgeUnencrypted')} onClose={close} wide testId="encryption-dialog"
          footer={<>
            <button onClick={close}>{t('cancel')}</button>
            <button className={dialog === 'purge' ? 'danger' : 'primary'} disabled={busy || !password || (needsRecovery && !recovery.acknowledged) || (dialog === 'purge' && confirm !== 'DELETE')} onClick={run} data-testid="encryption-submit">{t('apply')}</button>
          </>}>
          {dialog === 'enable' && <p>{t('enableEncryptionIntro')}</p>}
          {dialog === 'change' && <p>{t('changeRecoveryIntro')}</p>}
          {needsRecovery && <RecoveryFields value={recovery} onChange={setRecovery} idPrefix="enc-recovery" />}
          {dialog === 'purge' && <label>{t('purgeConfirmHint')}<input className="ltr" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="purge-confirm" /></label>}
          <label>{t('yourPassword')}<input className="ltr" type="password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="encryption-password" /></label>
          {busy && <Alert kind="info">{t('workingPleaseWait')}</Alert>}
        </Modal>
      )}
    </section>
  );
}
