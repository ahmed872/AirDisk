import { createHash } from 'node:crypto';
import { DomainError, ErrorCode } from '@airdesk/domain';
import type { AttachmentDto } from '@airdesk/contracts';
import type { BookingService } from './booking-service';
import { actorOf, requirePermission, tx, type Actor, type ServiceDeps } from './context';

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const TYPES = {
  pdf: { mime: 'application/pdf', ext: ['pdf'] },
  doc: { mime: 'application/msword', ext: ['doc'] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: ['docx'] },
  jpeg: { mime: 'image/jpeg', ext: ['jpg', 'jpeg'] },
  png: { mime: 'image/png', ext: ['png'] },
} as const;

/**
 * The file type is decided by its CONTENT (magic bytes), never by the name the
 * user gave it; the extension must agree. Anything else is refused.
 */
export function detectAttachmentType(bytes: Buffer, fileName: string): (typeof TYPES)[keyof typeof TYPES] {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  let kind: keyof typeof TYPES | null = null;
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') kind = 'pdf';
  else if (starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) kind = 'doc';
  else if (starts([0x50, 0x4b, 0x03, 0x04]) && bytes.includes(Buffer.from('word/'))) kind = 'docx';
  else if (starts([0xff, 0xd8, 0xff])) kind = 'jpeg';
  else if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) kind = 'png';
  if (!kind) throw new DomainError(ErrorCode.VALIDATION, 'Only PDF, Word (.doc, .docx) or image (JPG, PNG) files can be attached', { field: 'file', reason: 'FILE_TYPE' });
  if (!(TYPES[kind].ext as readonly string[]).includes(ext)) {
    throw new DomainError(ErrorCode.VALIDATION, 'The file name does not match its content', { field: 'file', reason: 'FILE_TYPE' });
  }
  return TYPES[kind];
}

/** Keeps a readable name without path parts or characters Windows refuses. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = [...base].filter((c) => c.charCodeAt(0) >= 32).join('').replace(/[<>:"|?*]+/g, '_').replace(/^\.+/, '').trim().slice(-200);
  return cleaned || 'file';
}

interface Row {
  id: string; booking_id: string; file_name: string; mime_type: string; size_bytes: number; sha256: string; note: string | null;
  created_at: string; created_by: string | null; creator: string | null;
}

/**
 * Ticket files attached to a ticket record. Stored in the (encrypted)
 * database. Visibility follows the record: a user who cannot see the record
 * cannot see or download its files.
 */
export class AttachmentService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly bookings: BookingService,
  ) {}

  list(actor: Actor, bookingId: string): AttachmentDto[] {
    requirePermission(this.deps, actor, 'booking.view', 'attachments.list');
    this.bookings.accessible(actor, bookingId);
    const rows = this.deps.db
      .prepare(`SELECT a.id, a.booking_id, a.file_name, a.mime_type, a.size_bytes, a.sha256, a.note, a.created_at, a.created_by, u.display_name AS creator
                FROM booking_attachment a LEFT JOIN app_user u ON u.id = a.created_by
                WHERE a.booking_id = ? AND a.removed_at IS NULL ORDER BY a.created_at, a.id`)
      .all(bookingId) as Row[];
    return rows.map((r) => this.dto(r));
  }

  add(actor: Actor, input: { bookingId: string; fileName: string; contentBase64: string; note?: string | null }): AttachmentDto {
    requirePermission(this.deps, actor, 'booking.edit', 'attachments.add');
    this.bookings.accessible(actor, input.bookingId);
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (bytes.length === 0) throw new DomainError(ErrorCode.VALIDATION, 'The file is empty', { field: 'file', reason: 'REQUIRED' });
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new DomainError(ErrorCode.VALIDATION, 'The file is larger than 15 MB', { field: 'file', reason: 'FILE_TOO_LARGE' });
    const fileName = cleanFileName(input.fileName);
    const type = detectAttachmentType(bytes, fileName);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = this.deps.newId();
    const now = this.deps.clock.now().toISOString();
    tx(this.deps, () => {
      this.deps.db
        .prepare(`INSERT INTO booking_attachment (id, booking_id, file_name, mime_type, size_bytes, sha256, content, note, created_at, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.bookingId, fileName, type.mime, bytes.length, sha256, bytes, input.note?.trim() || null, now, actor.userId);
      this.deps.audit.append(actorOf(actor), {
        action: 'booking.attachment_added', entityType: 'booking', entityId: input.bookingId,
        metadata: { attachmentId: id, fileName, mimeType: type.mime, sizeBytes: bytes.length, sha256 },
      });
    });
    return this.list(actor, input.bookingId).find((a) => a.id === id)!;
  }

  remove(actor: Actor, id: string, reason: string): void {
    requirePermission(this.deps, actor, 'booking.edit', 'attachments.remove');
    const row = this.row(actor, id);
    tx(this.deps, () => {
      this.deps.db.prepare('UPDATE booking_attachment SET removed_at = ?, removed_by = ?, removed_reason = ? WHERE id = ?')
        .run(this.deps.clock.now().toISOString(), actor.userId, reason, id);
      this.deps.audit.append(actorOf(actor), {
        action: 'booking.attachment_removed', entityType: 'booking', entityId: row.booking_id, metadata: { attachmentId: id, fileName: row.file_name, reason },
      });
    });
  }

  /** The file itself (for the desktop shell's save/open dialog); the download is audited. */
  content(actor: Actor, id: string): { fileName: string; mimeType: string; bytes: Buffer } {
    requirePermission(this.deps, actor, 'booking.view', 'attachments.download');
    const row = this.row(actor, id);
    const c = this.deps.db.prepare('SELECT content FROM booking_attachment WHERE id = ?').get(id) as { content: Buffer };
    const bytes = Buffer.from(c.content);
    if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
      throw new DomainError(ErrorCode.INTEGRITY_FAILURE, 'The stored file does not match its checksum');
    }
    this.deps.audit.append(actorOf(actor), {
      action: 'booking.attachment_downloaded', entityType: 'booking', entityId: row.booking_id, metadata: { attachmentId: id, fileName: row.file_name },
    });
    return { fileName: row.file_name, mimeType: row.mime_type, bytes };
  }

  private row(actor: Actor, id: string): Row {
    const r = this.deps.db
      .prepare(`SELECT a.id, a.booking_id, a.file_name, a.mime_type, a.size_bytes, a.sha256, a.note, a.created_at, a.created_by, NULL AS creator
                FROM booking_attachment a WHERE a.id = ? AND a.removed_at IS NULL`)
      .get(id) as Row | undefined;
    if (!r) throw new DomainError(ErrorCode.NOT_FOUND, 'Attachment not found');
    this.bookings.accessible(actor, r.booking_id); // same visibility as the record
    return r;
  }

  private dto(r: Row): AttachmentDto {
    return { id: r.id, bookingId: r.booking_id, fileName: r.file_name, mimeType: r.mime_type, sizeBytes: r.size_bytes, note: r.note, createdAt: r.created_at, createdBy: r.creator };
  }
}
