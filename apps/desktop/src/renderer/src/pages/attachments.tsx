import { useRef, useState } from 'react';
import type { AttachmentDto } from '@airdesk/contracts';
import { call } from '../api';
import { Alert, ConfirmDialog, useLoader } from '../components';
import { useI18n } from '../i18n';
import { useFmt } from '../prefs';

const ACCEPT = '.pdf,.doc,.docx,.jpg,.jpeg,.png';
const MAX_BYTES = 15 * 1024 * 1024;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Ticket files (e-ticket / itinerary as received) attached to a record. The
 * window only reads the file the user picks; storage, type checks, access
 * rules and the audit trail are on the backend; opening/saving goes through
 * the main process.
 */
export function AttachmentsSection({ bookingId, canEdit }: { bookingId: string; canEdit: boolean }) {
  const { t, errorMessage } = useI18n();
  const { dateTime } = useFmt();
  const list = useLoader(() => call<AttachmentDto[]>('attachments.list', { bookingId }), [bookingId]);
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [removing, setRemoving] = useState<AttachmentDto | null>(null);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setMsg(null);
    if (file.size > MAX_BYTES) { setMsg({ ok: false, text: errorMessage({ code: 'VALIDATION', details: { reason: 'FILE_TOO_LARGE' } }) }); return; }
    setBusy(true);
    try {
      await call('attachments.add', { bookingId, fileName: file.name, contentBase64: toBase64(await file.arrayBuffer()), note: note || null });
      setNote('');
      setMsg({ ok: true, text: t('fileUploaded') });
      list.reload();
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const openOrSave = async (a: AttachmentDto, mode: 'open' | 'save') => {
    const r = await window.airdesk.openAttachment(a.id, mode);
    if (!r.ok && r.code !== 'CANCELLED') setMsg({ ok: false, text: errorMessage({ code: r.code }) });
  };

  return (
    <section className="card section" data-testid="ticket-files">
      <h2>📎 {t('ticketFiles')}</h2>
      <p className="hint">{t('ticketFilesHint')}</p>
      {msg && <Alert kind={msg.ok ? 'ok' : 'error'}>{msg.text}</Alert>}
      {list.data && list.data.length === 0 && <p className="muted" data-testid="no-files">{t('noFiles')}</p>}
      {list.data && list.data.length > 0 && (
        <table data-testid="files-table">
          <tbody>{list.data.map((a) => (
            <tr key={a.id} data-file={a.fileName}>
              <td className="ltr">{a.fileName}{a.note && <div className="muted small">{a.note}</div>}</td>
              <td className="num ltr">{size(a.sizeBytes)}</td>
              <td className="muted small">{t('uploadedBy')} {a.createdBy ?? '—'} · <span className="ltr">{dateTime(a.createdAt)}</span></td>
              <td className="row-actions">
                <button onClick={() => openOrSave(a, 'open')} data-testid="file-open">{t('openFile')}</button>
                <button onClick={() => openOrSave(a, 'save')} data-testid="file-save">{t('saveFileAs')}</button>
                {canEdit && <button className="link danger" onClick={() => setRemoving(a)} data-testid="file-remove">{t('removeFile')}</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {canEdit && (
        <div className="toolbar">
          <label className="inline grow">{t('fileNote')}<input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} data-testid="file-note" /></label>
          <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => void upload(e.target.files?.[0])} data-testid="file-input" />
          <button className="primary" disabled={busy} onClick={() => input.current?.click()} data-testid="file-upload">{busy ? t('workingPleaseWait') : t('uploadFile')}</button>
        </div>
      )}
      {removing && (
        <ConfirmDialog title={t('removeFile')} text={`${removing.fileName}`} confirmLabel={t('removeFile')} danger withReason
          onClose={() => setRemoving(null)}
          onConfirm={async (reason) => {
            await call('attachments.remove', { id: removing.id, reason: reason ?? '' });
            setRemoving(null);
            setMsg({ ok: true, text: t('fileRemoved') });
            list.reload();
          }} />
      )}
    </section>
  );
}
