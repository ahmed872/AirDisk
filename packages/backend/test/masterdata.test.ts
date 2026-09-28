import { ErrorCode } from '@airdesk/domain';
import type { AirlineDto, CustomerDto, DuplicateCandidateDto, PageDto, SupplierDto } from '@airdesk/contracts';
import { describe, expect, it } from 'vitest';
import { auditActions, doc, fixtures, ready, userWithRoles } from './helpers';

const customer = (over: Record<string, unknown> = {}) => ({ fullName: 'أحمد علي', primaryMobile: '0100 123 4567', ...over });

describe('customers', () => {
  it('create → get → update → archive → restore, with numbers, audit and optimistic locking', async () => {
    const { env, adminSession } = await ready();
    const created = await env.call<CustomerDto>('customers.create', { customer: customer({ email: 'Ahmed@Example.com', whatsappNumber: '+966501234567' }) }, adminSession);
    expect(created.ok).toBe(true);
    const c = created.data!;
    expect(c).toMatchObject({ customerNo: 'C-000001', primaryMobile: '+201001234567', email: 'ahmed@example.com', status: 'ACTIVE', createdBy: 'Owner' });

    const upd = await env.call<CustomerDto>('customers.update', { id: c.id, rowVersion: c.rowVersion, customer: customer({ fullName: 'أحمد علي حسن', address: 'القاهرة' }) }, adminSession);
    expect(upd.ok && upd.data!.fullName).toBe('أحمد علي حسن');
    const stale = await env.call('customers.update', { id: c.id, rowVersion: c.rowVersion, customer: customer() }, adminSession);
    expect(!stale.ok && stale.error.code).toBe(ErrorCode.STALE_RECORD);

    const arch = await env.call<CustomerDto>('customers.archive', { id: c.id, reason: 'Duplicate entry' }, adminSession);
    expect(arch.ok && arch.data!.status).toBe('ARCHIVED');
    const editArchived = await env.call('customers.update', { id: c.id, rowVersion: arch.data!.rowVersion, customer: customer() }, adminSession);
    expect(!editArchived.ok && editArchived.error.details?.reason).toBe('ARCHIVED_READ_ONLY');
    const again = await env.call('customers.archive', { id: c.id }, adminSession);
    expect(!again.ok && again.error.details?.reason).toBe('ALREADY_ARCHIVED');
    expect((await env.call<CustomerDto>('customers.restore', { id: c.id }, adminSession)).data!.status).toBe('ACTIVE');

    expect(auditActions(env)).toEqual(expect.arrayContaining(['customer.created', 'customer.updated', 'customer.archived', 'customer.restored']));
    // Customers are never hard-deleted (trigger from migration 0001).
    expect(() => env.backend.svc.deps.db.prepare('DELETE FROM customer WHERE id = ?').run(c.id)).toThrow(/never deleted/);
  });

  it('rejects invalid input with a field and reason the UI can translate', async () => {
    const { env, adminSession } = await ready();
    const bad = await env.call('customers.create', { customer: customer({ primaryMobile: 'abc' }) }, adminSession);
    expect(!bad.ok && bad.error).toMatchObject({ code: ErrorCode.VALIDATION, details: { field: 'primaryMobile', reason: 'INVALID_PHONE' } });
    const email = await env.call('customers.create', { customer: customer({ email: 'nope' }) }, adminSession);
    expect(!email.ok && email.error.details?.reason).toBe('INVALID_EMAIL');
    const extra = await env.call('customers.create', { customer: { ...customer(), balance: 100 } }, adminSession);
    expect(!extra.ok && extra.error.code).toBe(ErrorCode.VALIDATION);
  });

  it('search: Arabic folding, phone fragments in any format, e-mail, customer number; status filter and sorting', async () => {
    const { env, adminSession } = await ready();
    const mk = async (fullName: string, primaryMobile: string, extra: Record<string, unknown> = {}) =>
      (await env.call<CustomerDto>('customers.create', { customer: { fullName, primaryMobile, ...extra }, confirmDuplicates: true }, adminSession)).data!;
    const a = await mk('أحمد إبراهيم', '01001234567', { email: 'ahmed@x.com' });
    const b = await mk('Mona Saeed', '+966501112233', { whatsappNumber: '+971509998877' });
    const c = await mk('فاطمة محمود', '01229876543');
    await env.call('customers.archive', { id: c.id }, adminSession);
    const find = async (query: string, status = 'ACTIVE') =>
      (await env.call<PageDto<CustomerDto>>('customers.list', { query, status }, adminSession)).data!.items.map((x) => x.id);

    expect(await find('احمد ابراهيم')).toEqual([a.id]);
    expect(await find('٠١٠٠١٢٣')).toEqual([a.id]);
    expect(await find('0100 123 4567')).toEqual([a.id]);
    expect(await find('1234567')).toEqual([a.id]);
    expect(await find('9998877')).toEqual([b.id]);
    expect(await find('AHMED@X')).toEqual([a.id]);
    expect(await find('C-000002')).toEqual([b.id]);
    expect(await find('mo')).toEqual([b.id]);
    expect(await find('فاطمه')).toEqual([]);
    expect(await find('فاطمه', 'ARCHIVED')).toEqual([c.id]);
    expect(await find('فاطمه', 'ALL')).toEqual([c.id]);
    expect(await find('"; DROP TABLE customer; --')).toEqual([]);

    const sorted = await env.call<PageDto<CustomerDto>>('customers.list', { status: 'ALL', sortBy: 'customerNo', sortDir: 'desc' }, adminSession);
    expect(sorted.data!.items.map((x) => x.customerNo)).toEqual(['C-000003', 'C-000002', 'C-000001']);
    expect(sorted.data!.total).toBe(3);
    const page = await env.call<PageDto<CustomerDto>>('customers.list', { status: 'ALL', limit: 1, offset: 1 }, adminSession);
    expect(page.data!.items.map((x) => x.customerNo)).toEqual(['C-000002']);
    expect(page.data!.total).toBe(3);
  });

  it('duplicates: warning (not a merge) unless explicitly confirmed; confirmation is audited', async () => {
    const { env, adminSession } = await ready();
    const first = (await env.call<CustomerDto>('customers.create', { customer: customer({ email: 'a@b.com' }) }, adminSession)).data!;

    const check = await env.call<DuplicateCandidateDto[]>('customers.checkDuplicates', { customer: { fullName: 'x', primaryMobile: '+20 100 123 4567' } }, adminSession);
    expect(check.data).toEqual([{ id: first.id, number: 'C-000001', name: 'أحمد علي', status: 'ACTIVE', signals: ['SAME_PHONE'] }]);

    const dup = await env.call('customers.create', { customer: customer({ fullName: 'Someone Else', primaryMobile: '01001234567' }) }, adminSession);
    expect(!dup.ok && dup.error.code).toBe(ErrorCode.DUPLICATE_WARNING);
    expect(!dup.ok && (dup.error.details?.matches as DuplicateCandidateDto[])[0]!.id).toBe(first.id);

    const byEmail = await env.call('customers.create', { customer: customer({ primaryMobile: '0111 000 0000', email: 'A@B.com' }) }, adminSession);
    expect(!byEmail.ok && (byEmail.error.details?.matches as DuplicateCandidateDto[])[0]!.signals).toEqual(['SAME_EMAIL']);

    const similar = await env.call('customers.create', { customer: customer({ fullName: 'احمد على', primaryMobile: '+201221234567' }) }, adminSession);
    expect(!similar.ok && (similar.error.details?.matches as DuplicateCandidateDto[])[0]!.signals).toEqual(['SIMILAR_NAME_AND_PHONE']);

    const confirmed = await env.call<CustomerDto>('customers.create', { customer: customer({ fullName: 'Someone Else' }), confirmDuplicates: true }, adminSession);
    expect(confirmed.ok).toBe(true);
    const audit = env.backend.svc.deps.db.prepare(`SELECT metadata_json FROM audit_log WHERE action = 'customer.created' ORDER BY seq DESC LIMIT 1`).get() as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toEqual({ duplicatesAcknowledged: true });
    // Both records exist independently: nothing was merged.
    expect((await env.call<PageDto<CustomerDto>>('customers.list', { status: 'ALL' }, adminSession)).data!.total).toBe(2);
    // Updating a record never flags itself.
    const self = await env.call('customers.update', { id: first.id, rowVersion: first.rowVersion, customer: customer({ email: 'a@b.com', notes: 'vip' }) }, adminSession);
    expect(!self.ok && self.error.code).toBe(ErrorCode.DUPLICATE_WARNING); // still matches the confirmed second customer
    const selfOnly = (await env.call<DuplicateCandidateDto[]>('customers.checkDuplicates', { customer: { fullName: 'x', email: 'a@b.com' }, excludeId: first.id }, adminSession)).data!;
    expect(selfOnly.map((d) => d.id)).not.toContain(first.id);
  });

  it('identity data is redacted without customer.view_identity and cannot be erased blindly', async () => {
    const { env, adminSession } = await ready();
    const created = (await env.call<CustomerDto>('customers.create', { customer: customer({ passportNo: 'A1234567', nationalId: '29001011234567' }) }, adminSession)).data!;
    expect(created.passportNo).toBe('A1234567');
    await env.call('roles.create', { code: 'FRONT_DESK', nameAr: 'استقبال', nameEn: 'Front desk', permissions: ['customer.view', 'customer.edit'] }, adminSession);
    const desk = await userWithRoles(env, adminSession, 'desk1', ['FRONT_DESK']);
    const seen = (await env.call<CustomerDto>('customers.get', { id: created.id }, desk)).data!;
    expect(seen).toMatchObject({ passportNo: null, nationalId: null, identityRedacted: true });
    const edited = await env.call<CustomerDto>('customers.update', { id: created.id, rowVersion: seen.rowVersion, customer: customer({ notes: 'called' }) }, desk);
    expect(edited.ok).toBe(true);
    expect((await env.call<CustomerDto>('customers.get', { id: created.id }, adminSession)).data!.passportNo).toBe('A1234567');
    const audit = env.backend.svc.deps.db.prepare(`SELECT after_json FROM audit_log WHERE action = 'customer.created'`).get() as { after_json: string };
    expect(audit.after_json).not.toContain('A1234567');
    expect(audit.after_json).toContain('4567');
  });

  it('balances are derived from the journal (no stored balance column)', async () => {
    const { env, adminSession, admin } = await ready();
    const cols = (t: string) => (env.backend.svc.deps.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    for (const t of ['customer', 'supplier']) expect(cols(t).some((c) => /balance/.test(c))).toBe(false);
    const c = (await env.call<CustomerDto>('customers.create', { customer: customer() }, adminSession)).data!;
    expect(c.balances).toEqual([]);
    const f = fixtures(env, admin.userId);
    const b = f.booking(c.id);
    env.backend.svc.posting.post(admin, doc.invoice(c.id, b, 1_050_000));
    env.backend.svc.posting.post(admin, doc.receipt(c.id, b, f.moneyAccount(), 500_000));
    expect((await env.call<CustomerDto>('customers.get', { id: c.id }, adminSession)).data!.balances).toEqual([{ currency: 'EGP', balanceMinor: 550_000 }]);
  });
});

describe('suppliers', () => {
  it('CRUD, search, supplier ≠ airline, and financial information gated by supplier.view_financial', async () => {
    const { env, adminSession, admin } = await ready();
    const airline = (await env.call<AirlineDto>('airlines.create', { airline: { nameEn: 'EgyptAir', iataCode: 'MS' } }, adminSession)).data!;
    const s = await env.call<SupplierDto>('suppliers.create', {
      supplier: { name: 'Company ABC', contactPerson: 'Hany', phonePrimary: '0223456789', email: 'ops@abc.com', defaultCurrencyCode: 'EGP' },
    }, adminSession);
    expect(s.ok && s.data).toMatchObject({ supplierNo: 'S-000001', phonePrimary: '+20223456789', airlineId: null, financialRedacted: false });
    const find = async (query: string) => (await env.call<PageDto<SupplierDto>>('suppliers.list', { query }, adminSession)).data!.items.length;
    expect(await find('abc')).toBe(1);
    expect(await find('hany')).toBe(1);
    expect(await find('23456789')).toBe(1);
    expect(await find('S-000001')).toBe(1);

    // A ticket's airline (EgyptAir) and supplier (Company ABC) are independent records.
    expect(s.data!.airlineId).toBeNull();
    const linked = await env.call<SupplierDto>('suppliers.create', { supplier: { name: 'EgyptAir Direct', defaultCurrencyCode: 'EGP', airlineId: airline.id } }, adminSession);
    expect(linked.data!.airlineId).toBe(airline.id);
    const badCurrency = await env.call('suppliers.create', { supplier: { name: 'Y', defaultCurrencyCode: 'XYZ' } }, adminSession);
    expect(!badCurrency.ok && badCurrency.error.details?.reason).toBe('INVALID_CURRENCY');
    const dup = await env.call('suppliers.create', { supplier: { name: 'company abc', defaultCurrencyCode: 'EGP' } }, adminSession);
    expect(!dup.ok && dup.error.code).toBe(ErrorCode.DUPLICATE_WARNING);

    const f = fixtures(env, admin.userId);
    const cust = f.customer();
    env.backend.svc.posting.post(admin, doc.bill(s.data!.id, f.booking(cust), 1_010_000));
    expect((await env.call<SupplierDto>('suppliers.get', { id: s.data!.id }, adminSession)).data!.balances).toEqual([{ currency: 'EGP', balanceMinor: 1_010_000 }]);

    const agent = await userWithRoles(env, adminSession, 'agent', ['SALES_AGENT']);
    const agentView = (await env.call<SupplierDto>('suppliers.get', { id: s.data!.id }, agent)).data!;
    expect(agentView).toMatchObject({ name: 'Company ABC', balances: null, financialRedacted: true });
    const agentList = (await env.call<PageDto<SupplierDto>>('suppliers.list', {}, agent)).data!;
    expect(agentList.items.every((x) => x.balances === null)).toBe(true);
    const agentCreate = await env.call('suppliers.create', { supplier: { name: 'Z', defaultCurrencyCode: 'EGP' } }, agent);
    expect(!agentCreate.ok && agentCreate.error.code).toBe(ErrorCode.FORBIDDEN);

    expect((await env.call<SupplierDto>('suppliers.archive', { id: s.data!.id }, adminSession)).data!.status).toBe('ARCHIVED');
    expect(auditActions(env)).toEqual(expect.arrayContaining(['supplier.created', 'supplier.archived']));
    // Archiving never touches financial history.
    expect((await env.call<SupplierDto>('suppliers.get', { id: s.data!.id }, adminSession)).data!.balances).toEqual([{ currency: 'EGP', balanceMinor: 1_010_000 }]);
  });
});

describe('airlines', () => {
  it('CRUD, unique codes among active airlines, search, archive frees the code, never deleted', async () => {
    const { env, adminSession } = await ready();
    const ms = (await env.call<AirlineDto>('airlines.create', { airline: { nameEn: 'EgyptAir', nameAr: 'مصر للطيران', iataCode: 'ms', icaoCode: 'MSR', ticketPrefix: '077', countryCode: 'EG' } }, adminSession)).data!;
    expect(ms).toMatchObject({ iataCode: 'MS', icaoCode: 'MSR', status: 'ACTIVE' });
    const clash = await env.call('airlines.create', { airline: { nameEn: 'Other', iataCode: 'MS' } }, adminSession);
    expect(!clash.ok && clash.error).toMatchObject({ code: ErrorCode.CONFLICT, details: { field: 'iataCode', reason: 'DUPLICATE_CODE' } });
    const icaoClash = await env.call('airlines.create', { airline: { nameEn: 'Other', icaoCode: 'msr' } }, adminSession);
    expect(!icaoClash.ok && icaoClash.error.details?.field).toBe('icaoCode');
    const invalid = await env.call('airlines.create', { airline: { nameEn: 'Bad', iataCode: '12' } }, adminSession);
    expect(!invalid.ok && invalid.error.details?.reason).toBe('INVALID_IATA');

    const find = async (query: string) => (await env.call<PageDto<AirlineDto>>('airlines.list', { query }, adminSession)).data!.items.map((a) => a.id);
    expect(await find('مصر')).toEqual([ms.id]);
    expect(await find('ms')).toEqual([ms.id]);
    expect(await find('077')).toEqual([ms.id]);

    await env.call('airlines.archive', { id: ms.id }, adminSession);
    const reuse = await env.call<AirlineDto>('airlines.create', { airline: { nameEn: 'EgyptAir (new)', iataCode: 'MS' } }, adminSession);
    expect(reuse.ok).toBe(true);
    const restore = await env.call('airlines.restore', { id: ms.id }, adminSession);
    expect(!restore.ok && restore.error.details?.reason).toBe('DUPLICATE_CODE');
    expect(() => env.backend.svc.deps.db.prepare('DELETE FROM airline WHERE id = ?').run(ms.id)).toThrow(/never deleted/);
    expect(auditActions(env)).toEqual(expect.arrayContaining(['airline.created', 'airline.archived']));
  });
});

describe('dashboard summary', () => {
  it('counts only what the caller may see', async () => {
    const { env, adminSession } = await ready();
    await env.call('customers.create', { customer: customer() }, adminSession);
    const admin = (await env.call<{ customers: { active: number }; users: { active: number } | null }>('dashboard.summary', {}, adminSession)).data!;
    expect(admin.customers.active).toBe(1);
    expect(admin.users!.active).toBe(1);
    const agent = await userWithRoles(env, adminSession, 'agent', ['SALES_AGENT']);
    const agentView = (await env.call<{ users: unknown; lastBackupAt: unknown }>('dashboard.summary', {}, agent)).data!;
    expect(agentView.users).toBeNull();
  });
});
