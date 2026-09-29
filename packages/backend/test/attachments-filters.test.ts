import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { AttachmentDto, BookingDto, BookingListItemDto, PageDto } from '@airdesk/contracts';
import { book, fail, ok, paySupplier, receive, seg, world } from './flow';
import { ADMIN, login, ready, userWithRoles } from './helpers';

const pdf = (text = 'E-TICKET 0779991234567 PASSENGER ALI') => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${text}\n%%EOF\n`, 'latin1');
const docx = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....[Content_Types].xml....word/document.xml....')]);
const jpg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const b64 = (b: Buffer) => b.toString('base64');

describe('ticket files attached to a record', () => {
  it('stores PDF / Word / image files by content type, lists them, and returns the exact bytes', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    const added = await ok<AttachmentDto>(env, 'attachments.add', { bookingId: b.id, fileName: 'eticket.pdf', contentBase64: b64(pdf()), note: 'as received from MS' }, s);
    expect(added).toMatchObject({ fileName: 'eticket.pdf', mimeType: 'application/pdf', note: 'as received from MS', createdBy: 'Owner' });
    await ok(env, 'attachments.add', { bookingId: b.id, fileName: 'itinerary.docx', contentBase64: b64(docx()) }, s);
    await ok(env, 'attachments.add', { bookingId: b.id, fileName: 'C:\\Users\\x\\scan.JPG', contentBase64: b64(jpg()) }, s);
    const list = await ok<AttachmentDto[]>(env, 'attachments.list', { bookingId: b.id }, s);
    expect(list.map((a) => [a.fileName, a.mimeType])).toEqual([
      ['eticket.pdf', 'application/pdf'],
      ['itinerary.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['scan.JPG', 'image/jpeg'],
    ]);
    const actor = env.backend.svc.sessions.resolve(s);
    expect(env.backend.svc.attachments.content(actor, added.id).bytes.equals(pdf())).toBe(true);
    const actions = (env.backend.internals.db.prepare('SELECT action FROM audit_log').all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['booking.attachment_added', 'booking.attachment_downloaded']));
    const items = await ok<PageDto<BookingListItemDto>>(env, 'bookings.list', { status: 'ALL' }, s);
    expect(items.items.find((i) => i.id === b.id)!.attachmentCount).toBe(3);
  });

  it('refuses executables, renamed files, empty and oversized files', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    const add = (fileName: string, content: Buffer) => fail(env, 'attachments.add', { bookingId: b.id, fileName, contentBase64: b64(content) }, s);
    expect(await add('ticket.pdf', Buffer.from('MZ\x90\x00 this is an exe', 'latin1'))).toEqual({ code: 'VALIDATION', reason: 'FILE_TYPE' });
    expect(await add('virus.exe', pdf())).toEqual({ code: 'VALIDATION', reason: 'FILE_TYPE' }); // PDF content, wrong extension
    expect(await add('ticket.pdf', jpg())).toEqual({ code: 'VALIDATION', reason: 'FILE_TYPE' });
    expect((await add('big.pdf', Buffer.concat([pdf(), Buffer.alloc(15 * 1024 * 1024)]))).reason).toBe('FILE_TOO_LARGE');
    expect((await ok<AttachmentDto[]>(env, 'attachments.list', { bookingId: b.id }, s))).toEqual([]);
  });

  it('files follow record visibility; removal is audited and never deletes the stored file', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    const a = await ok<AttachmentDto>(env, 'attachments.add', { bookingId: b.id, fileName: 'eticket.pdf', contentBase64: b64(pdf()) }, s);
    const agent = await userWithRoles(env, s, 'agent1', ['SALES_AGENT']);
    // The agent does not own this record: its files are invisible (same answer as for the record).
    expect((await fail(env, 'attachments.list', { bookingId: b.id }, agent)).code).toBe('NOT_FOUND');
    expect((await fail(env, 'attachments.add', { bookingId: b.id, fileName: 'x.pdf', contentBase64: b64(pdf()) }, agent)).code).toBe('NOT_FOUND');
    expect((await fail(env, 'attachments.remove', { id: a.id, reason: 'not mine' }, agent)).code).toBe('NOT_FOUND');
    expect(() => env.backend.svc.attachments.content(env.backend.svc.sessions.resolve(agent), a.id)).toThrow(/not found/i);
    // An accountant can see records but not edit them.
    const acc = await userWithRoles(env, s, 'acc1', ['ACCOUNTANT']);
    expect((await ok<AttachmentDto[]>(env, 'attachments.list', { bookingId: b.id }, acc))).toHaveLength(1);
    expect((await fail(env, 'attachments.add', { bookingId: b.id, fileName: 'x.pdf', contentBase64: b64(pdf()) }, acc)).code).toBe('FORBIDDEN');
    // Removal needs a reason, hides the file, keeps it in the database and the audit trail.
    expect((await fail(env, 'attachments.remove', { id: a.id, reason: '' }, s)).code).toBe('VALIDATION');
    await ok(env, 'attachments.remove', { id: a.id, reason: 'wrong passenger' }, s);
    expect(await ok<AttachmentDto[]>(env, 'attachments.list', { bookingId: b.id }, s)).toEqual([]);
    const db = env.backend.internals.db;
    expect(db.prepare('SELECT removed_reason FROM booking_attachment WHERE id = ?').get(a.id)).toEqual({ removed_reason: 'wrong passenger' });
    expect(() => db.prepare('DELETE FROM booking_attachment').run()).toThrow(/never deleted/);
    expect(() => db.prepare(`UPDATE booking_attachment SET content = x'00'`).run()).toThrow(/immutable/);
    expect((await fail(env, 'attachments.remove', { id: a.id, reason: 'again please' }, s)).code).toBe('NOT_FOUND');
  });

  it('files travel with backups and restore byte-for-byte', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const b = await book(env, s, w);
    const a = await ok<AttachmentDto>(env, 'attachments.add', { bookingId: b.id, fileName: 'eticket.pdf', contentBase64: b64(pdf('UNIQUE-MARKER-7788')) }, s);
    const bk = await ok<{ filePath: string }>(env, 'backup.create', {}, s);
    const manifest = JSON.parse(strFromU8(unzipSync(new Uint8Array(readFileSync(bk.filePath)))['manifest.json']!));
    expect(manifest.schemaVersion).toBeGreaterThanOrEqual(7);
    await ok(env, 'attachments.remove', { id: a.id, reason: 'test restore' }, s);
    expect((await env.call('backup.restore', { filePath: bk.filePath, password: ADMIN.password, confirmation: 'RESTORE' }, s)).ok).toBe(true);
    const s2 = await login(env);
    const list = await ok<AttachmentDto[]>(env, 'attachments.list', { bookingId: b.id }, s2);
    expect(list).toHaveLength(1);
    expect(env.backend.svc.attachments.content(env.backend.svc.sessions.resolve(s2), a.id).bytes.equals(pdf('UNIQUE-MARKER-7788'))).toBe(true);
    expect(join(env.dataDir, 'airdesk.db')).toBeTruthy();
  });
});

describe('ticket record filters', () => {
  it('filter by travel/issue date, supplier, airline, agent, payment state, ticket file and follow-up', async () => {
    const { env, adminSession: s } = await ready();
    const w = await world(env, s);
    const other = await world(env, s, { customerName: 'Mona Hassan', supplierName: 'Supplier XYZ' });
    const fz = await ok<{ id: string }>(env, 'airlines.create', { airline: { nameEn: 'FlyDubai', iataCode: 'FZ', ticketPrefix: '141' } }, s);
    // A: paid in full, EgyptAir, Company ABC, travel 2026-10-15.
    const a = await book(env, s, w);
    await receive(env, s, w, a.id, 1_050_000);
    await paySupplier(env, s, w, a.id, 100_000);
    // B: nothing paid, flydubai, Supplier XYZ, travel 2026-12-01, has a ticket file.
    const bRec = await book(env, s, other, { segments: [seg(fz.id, { departureDate: '2026-12-01', arrivalDate: '2026-12-01', flightNumber: '101', destination: 'DXB' })] });
    await ok(env, 'attachments.add', { bookingId: bRec.id, fileName: 'eticket.pdf', contentBase64: b64(pdf()) }, s);
    // C: draft by an agent.
    const agentSession = await userWithRoles(env, s, 'agent1', ['SALES_AGENT']);
    const c = await ok<BookingDto>(env, 'bookings.create', { customerId: w.customer.id, pnr: 'AGT001' }, agentSession);

    const ids = async (filters: Record<string, unknown>, session = s) =>
      (await ok<PageDto<BookingListItemDto>>(env, 'bookings.list', { status: 'ALL', ...filters }, session)).items.map((i) => i.id).sort();
    const sorted = (...x: string[]) => [...x].sort();
    expect(await ids({ dateField: 'TRAVEL', from: '2026-11-01', to: '2026-12-31' })).toEqual([bRec.id]);
    expect(await ids({ dateField: 'TRAVEL', from: '2026-10-01', to: '2026-10-31' })).toEqual([a.id]);
    const today = env.backend.svc.company.today();
    expect(await ids({ dateField: 'ISSUE', from: today, to: today })).toEqual(sorted(a.id, bRec.id));
    expect(await ids({ supplierId: other.supplier.id })).toEqual([bRec.id]);
    expect(await ids({ airlineId: fz.id })).toEqual([bRec.id]);
    expect(await ids({ payment: 'SETTLED' })).toEqual([a.id]);
    expect(await ids({ payment: 'DUE' })).toEqual([bRec.id]);
    expect(await ids({ payment: 'CREDIT' })).toEqual([]);
    expect(await ids({ attachment: 'WITH' })).toEqual([bRec.id]);
    expect(await ids({ attachment: 'WITHOUT' })).toEqual(sorted(a.id, c.id));
    expect(await ids({ attention: true })).toEqual([]);
    const agentId = env.backend.svc.sessions.resolve(agentSession).userId;
    expect(await ids({ agentId })).toEqual([c.id]);
    expect(await ok<{ id: string; name: string }[]>(env, 'bookings.agentOptions', {}, s)).toEqual(expect.arrayContaining([expect.objectContaining({ id: agentId })]));
    // Agents only ever see their own records; the agent filter cannot widen that, and agent options are not theirs to list.
    expect(await ids({ agentId: env.backend.svc.sessions.resolve(s).userId }, agentSession)).toEqual([c.id]);
    expect((await fail(env, 'bookings.agentOptions', {}, agentSession)).code).toBe('FORBIDDEN');
  });
});
