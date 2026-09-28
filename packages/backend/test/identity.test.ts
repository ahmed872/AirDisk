import type { AuditEntryDto, CompanyProfileDto, RoleDto, UserDto } from '@airdesk/contracts';
import { ErrorCode, PERMISSIONS, PERMISSION_RENAMES } from '@airdesk/domain';
import { describe, expect, it } from 'vitest';
import { createUlidGenerator, seedSystemData } from '../src';
import { COMPANY, USER_PASSWORD, auditActions, login, makeBackend, ready, userWithRoles, type TestEnv } from './helpers';

const userId = async (env: TestEnv, session: string, username: string) =>
  (await env.call<UserDto[]>('users.list', {}, session)).data!.find((u) => u.username === username)!;
const roleByCode = async (env: TestEnv, session: string, code: string) =>
  (await env.call<RoleDto[]>('roles.list', {}, session)).data!.find((r) => r.code === code)!;

describe('first-run setup (Phase 2)', () => {
  it('is transactional: a failure half-way leaves no company and no user, and setup can be retried', async () => {
    const env = await makeBackend();
    const audit = env.backend.svc.deps.audit;
    const original = audit.append.bind(audit);
    audit.append = (a, e) => {
      if (e.action === 'user.created') throw new Error('disk full (simulated)');
      original(a, e);
    };
    const failed = await env.call('system.setup', {
      company: COMPANY,
      admin: { username: 'owner', displayName: 'Owner', password: 'correct horse battery staple', locale: 'ar' },
    });
    expect(failed.ok).toBe(false);
    const db = env.backend.svc.deps.db;
    expect((db.prepare('SELECT COUNT(*) AS n FROM app_user').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM company_profile').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(0);
    expect((await env.call<{ setupRequired: boolean }>('system.status')).data!.setupRequired).toBe(true);

    audit.append = original;
    const ok = await env.call('system.setup', {
      company: { ...COMPANY, defaultCountryCode: 'SA', baseCurrencyCode: 'SAR', timezone: 'Asia/Riyadh', defaultLocale: 'en' },
      admin: { username: 'owner', displayName: 'Owner', password: 'correct horse battery staple', locale: 'en' },
    });
    expect(ok.ok).toBe(true);
    const s = await login(env);
    const company = (await env.call<CompanyProfileDto>('company.get', {}, s)).data!;
    // Nothing about the development company is hard-coded: the market comes from setup.
    expect(company).toMatchObject({ baseCurrencyCode: 'SAR', defaultCountryCode: 'SA', timezone: 'Asia/Riyadh', dateFormat: 'DD/MM/YYYY', textDirection: 'AUTO' });
    expect(auditActions(env)).toEqual(['setup.completed', 'user.created', 'auth.login']);
  });

  it('rejects an invalid company configuration without creating anything', async () => {
    const env = await makeBackend();
    const r = await env.call('system.setup', {
      company: { ...COMPANY, defaultCountryCode: 'XX' },
      admin: { username: 'owner', displayName: 'Owner', password: 'correct horse battery staple', locale: 'ar' },
    });
    expect(!r.ok && r.error.details?.reason).toBe('INVALID_COUNTRY');
    expect((await env.call<{ setupRequired: boolean }>('system.status')).data!.setupRequired).toBe(true);
  });
});

describe('company configuration', () => {
  it('updates all sections with optimistic locking, audits changed groups, and keeps omitted fields', async () => {
    const { env, adminSession } = await ready();
    const before = (await env.call<CompanyProfileDto>('company.get', {}, adminSession)).data!;
    const r = await env.call<CompanyProfileDto>('company.update', {
      rowVersion: before.rowVersion,
      profile: {
        ...COMPANY, email: 'info@example.com', website: 'https://example.com', taxRegistrationNo: '123-456-789',
        invoiceTitleAr: 'فاتورة', invoiceTermsEn: 'Non-refundable once issued.', dateFormat: 'YYYY-MM-DD', numberFormat: 'ARABIC_INDIC', textDirection: 'RTL',
      },
    }, adminSession);
    expect(r.ok && r.data).toMatchObject({ email: 'info@example.com', dateFormat: 'YYYY-MM-DD', numberFormat: 'ARABIC_INDIC', textDirection: 'RTL', rowVersion: before.rowVersion + 1 });
    const stale = await env.call('company.update', { rowVersion: before.rowVersion, profile: COMPANY }, adminSession);
    expect(!stale.ok && stale.error.code).toBe(ErrorCode.STALE_RECORD);
    const badMail = await env.call('company.update', { rowVersion: r.data!.rowVersion, profile: { ...COMPANY, email: 'x@' } }, adminSession);
    expect(!badMail.ok && badMail.error.code).toBe(ErrorCode.VALIDATION);
    const log = (await env.call<AuditEntryDto[]>('audit.list', { action: 'company.updated' }, adminSession)).data!;
    expect(log).toHaveLength(1);
    expect(log[0]!.metadata).toEqual({ groups: ['general', 'financial'] });
  });

  it('each section needs its own permission: general edits do not unlock financial configuration', async () => {
    const { env, adminSession } = await ready();
    await env.call('roles.create', { code: 'OFFICE', nameAr: 'مكتب', nameEn: 'Office', permissions: ['company.view', 'company.edit'] }, adminSession);
    const office = await userWithRoles(env, adminSession, 'office', ['OFFICE']);
    const cur = (await env.call<CompanyProfileDto>('company.get', {}, office)).data!;
    const general = await env.call<CompanyProfileDto>('company.update', { rowVersion: cur.rowVersion, profile: { ...COMPANY, addressAr: 'شارع ١' } }, office);
    expect(general.ok).toBe(true);
    const fin = await env.call('company.update', { rowVersion: general.data!.rowVersion, profile: { ...COMPANY, baseCurrencyCode: 'USD' } }, office);
    expect(!fin.ok && fin.error.code).toBe(ErrorCode.FORBIDDEN);
    const brand = await env.call('company.update', { rowVersion: general.data!.rowVersion, profile: { ...COMPANY, tradeNameEn: 'Brand' } }, office);
    expect(!brand.ok && brand.error.code).toBe(ErrorCode.FORBIDDEN);
    expect((await env.call<CompanyProfileDto>('company.get', {}, adminSession)).data!.baseCurrencyCode).toBe('EGP');
  });
});

describe('users', () => {
  it('create with contact fields, update, disable, re-enable; disabled users cannot log in; everything audited', async () => {
    const { env, adminSession } = await ready();
    const created = await env.call<UserDto>('users.create', {
      username: 'sara', displayName: 'Sara', password: 'temporary pass 12345', roleCodes: ['SALES_AGENT'], email: 'Sara@Agency.com', mobile: '0100 555 1234',
    }, adminSession);
    expect(created.ok && created.data).toMatchObject({ email: 'sara@agency.com', mobile: '+201005551234', status: 'ACTIVE', roles: ['SALES_AGENT'] });
    const bad = await env.call('users.create', { username: 'omar', displayName: 'O', password: 'temporary pass 12345', roleCodes: ['SALES_AGENT'], email: 'nope' }, adminSession);
    expect(!bad.ok && bad.error.details?.reason).toBe('INVALID_EMAIL');

    const u = created.data!;
    const upd = await env.call<UserDto>('users.update', { userId: u.id, displayName: 'Sara M.', email: null, mobile: null, notes: 'Branch 2', rowVersion: u.rowVersion }, adminSession);
    expect(upd.ok && upd.data).toMatchObject({ displayName: 'Sara M.', email: null, notes: 'Branch 2' });
    const stale = await env.call('users.update', { userId: u.id, displayName: 'x', rowVersion: u.rowVersion }, adminSession);
    expect(!stale.ok && stale.error.code).toBe(ErrorCode.STALE_RECORD);

    expect((await env.call('users.setActive', { userId: u.id, active: false }, adminSession)).ok).toBe(true);
    const denied = await env.call('auth.login', { username: 'sara', password: 'temporary pass 12345' });
    expect(!denied.ok && denied.error.code).toBe(ErrorCode.ACCOUNT_DISABLED);
    expect((await userId(env, adminSession, 'sara')).status).toBe('DISABLED');
    const twice = await env.call('users.setActive', { userId: u.id, active: false }, adminSession);
    expect(!twice.ok && twice.error.details?.reason).toBe('ALREADY_DISABLED');
    expect((await env.call('users.setActive', { userId: u.id, active: true }, adminSession)).ok).toBe(true);
    expect((await env.call('auth.login', { username: 'sara', password: 'temporary pass 12345' })).ok).toBe(true);

    const list = await env.call<UserDto[]>('users.list', { query: 'sar', status: 'ACTIVE' }, adminSession);
    expect(list.data!.map((x) => x.username)).toEqual(['sara']);
    expect(auditActions(env)).toEqual(expect.arrayContaining(['user.created', 'user.updated', 'user.disabled', 'user.enabled']));
    // The password (temporary or not) never reaches the audit trail.
    const all = JSON.stringify(env.backend.svc.deps.db.prepare('SELECT before_json, after_json, metadata_json FROM audit_log').all());
    expect(all).not.toContain('temporary pass');
    expect(all).not.toMatch(/\$argon2/);
  });

  it('a locked account is shown as LOCKED and can be unlocked by an administrator', async () => {
    const { env, adminSession } = await ready();
    await userWithRoles(env, adminSession, 'agent', ['SALES_AGENT']);
    for (let i = 0; i < 5; i++) await env.call('auth.login', { username: 'agent', password: 'wrong password here' });
    const agent = await userId(env, adminSession, 'agent');
    expect(agent.status).toBe('LOCKED');
    expect((await env.call('users.unlock', { userId: agent.id }, adminSession)).ok).toBe(true);
    expect((await userId(env, adminSession, 'agent')).status).toBe('ACTIVE');
    expect((await env.call('auth.login', { username: 'agent', password: USER_PASSWORD })).ok).toBe(true);
    const notLocked = await env.call('users.unlock', { userId: agent.id }, adminSession);
    expect(!notLocked.ok && notLocked.error.details?.reason).toBe('NOT_LOCKED');
    expect(auditActions(env)).toContain('user.unlocked');
  });
});

describe('roles & permissions', () => {
  it('create, rename, change permissions, assign users — effective immediately and audited', async () => {
    const { env, adminSession } = await ready();
    const role = (await env.call<RoleDto>('roles.create', { code: 'TICKETING', nameAr: 'إصدار', nameEn: 'Ticketing', permissions: ['customer.view'] }, adminSession)).data!;
    const t = await userWithRoles(env, adminSession, 'tkt', ['TICKETING']);
    expect((await env.call('customers.list', {}, t)).ok).toBe(true);
    expect((await env.call('airlines.list', {}, t)).ok).toBe(false);

    const renamed = await env.call<RoleDto>('roles.update', { roleId: role.id, nameAr: 'التذاكر', nameEn: 'Ticket desk', description: 'Issues tickets' }, adminSession);
    expect(renamed.ok && renamed.data).toMatchObject({ nameEn: 'Ticket desk', description: 'Issues tickets', userCount: 1 });
    await env.call('roles.setPermissions', { roleId: role.id, permissions: ['customer.view', 'airline.view'] }, adminSession);
    expect((await env.call('airlines.list', {}, t)).ok).toBe(true);
    await env.call('roles.setPermissions', { roleId: role.id, permissions: [] }, adminSession);
    expect((await env.call('customers.list', {}, t)).ok).toBe(false);

    const tkt = (await env.call<UserDto[]>('users.list', {}, adminSession)).data!.find((u) => u.username === 'tkt')!;
    await env.call('users.setRoles', { userId: tkt.id, roleCodes: ['TICKETING', 'SALES_AGENT'] }, adminSession);
    expect((await env.call<{ roles: string[] }>('auth.me', {}, t)).data!.roles.sort()).toEqual(['SALES_AGENT', 'TICKETING']);
    // System roles may be relabelled, but their code (what the system relies on) never changes.
    const adminRole = await roleByCode(env, adminSession, 'ADMIN');
    expect((await env.call<RoleDto>('roles.update', { roleId: adminRole.id, nameAr: 'المدير العام', nameEn: 'Owner' }, adminSession)).data!.code).toBe('ADMIN');
    expect(auditActions(env)).toEqual(expect.arrayContaining(['role.created', 'role.updated', 'role.permissions_changed', 'user.roles_changed']));
    // Roles are never deleted (system roles are protected by a trigger).
    expect(() => env.backend.svc.deps.db.prepare(`DELETE FROM role WHERE code = 'ADMIN'`).run()).toThrow();
  });

  it('prevents privilege escalation: a role manager cannot grant what they do not hold, nor hand out ADMIN', async () => {
    const { env, adminSession } = await ready();
    await env.call('roles.create', { code: 'HR', nameAr: 'موارد', nameEn: 'HR', permissions: ['user.view', 'user.create', 'user.assign_roles', 'role.view', 'role.create', 'role.manage_permissions'] }, adminSession);
    const hr = await userWithRoles(env, adminSession, 'hrmgr', ['HR']);
    const escalate = await env.call('roles.create', { code: 'SUPER', nameAr: 'س', nameEn: 'S', permissions: ['report.profit', 'backup.restore'] }, hr);
    expect(!escalate.ok && escalate.error.code).toBe(ErrorCode.FORBIDDEN);
    const self = await roleByCode(env, adminSession, 'HR');
    const selfGrant = await env.call('roles.setPermissions', { roleId: self.id, permissions: ['user.view', 'company.financial_config'] }, hr);
    expect(!selfGrant.ok && selfGrant.error.code).toBe(ErrorCode.FORBIDDEN);
    const makeAdmin = await env.call('users.create', { username: 'boss2', displayName: 'b', password: 'temporary pass 12345', roleCodes: ['ADMIN'] }, hr);
    expect(!makeAdmin.ok && makeAdmin.error.code).toBe(ErrorCode.FORBIDDEN);
    // Nor a role that carries permissions they lack (Sales Agent can create bookings; HR cannot)…
    const agentRole = await env.call('users.create', { username: 'agent2', displayName: 'a', password: 'temporary pass 12345', roleCodes: ['SALES_AGENT'] }, hr);
    expect(!agentRole.ok && agentRole.error.code).toBe(ErrorCode.FORBIDDEN);
    // …but a role within their own permissions is fine.
    await env.call('roles.create', { code: 'VIEWER', nameAr: 'مشاهد', nameEn: 'Viewer', permissions: ['user.view'] }, adminSession);
    expect((await env.call('users.create', { username: 'viewer1', displayName: 'v', password: 'temporary pass 12345', roleCodes: ['VIEWER'] }, hr)).ok).toBe(true);
  });

  it('upgrades Phase 1 permission codes: old grants are replaced, obsolete codes removed (seed is idempotent)', async () => {
    const { env } = await ready();
    const db = env.backend.svc.deps.db;
    const newId = createUlidGenerator();
    const now = '2026-09-28T09:00:00.000Z';
    const roleId = newId();
    db.prepare(`INSERT INTO permission (code, module, description_ar, description_en) VALUES ('supplier.manage','supplier','x','x'), ('user.manage','user','x','x')`).run();
    db.prepare(`INSERT INTO role (id, code, name_ar, name_en, is_system, created_at) VALUES (?, 'LEGACY', 'قديم', 'Legacy', 0, ?)`).run(roleId, now);
    db.prepare(`INSERT INTO role_permission (role_id, permission_code) VALUES (?, 'supplier.manage'), (?, 'user.manage')`).run(roleId, roleId);
    seedSystemData(db, { newId, now, appVersion: 't' });
    const granted = (db.prepare('SELECT permission_code AS c FROM role_permission WHERE role_id = ? ORDER BY 1').all(roleId) as { c: string }[]).map((r) => r.c);
    expect(granted).toEqual([...new Set([...PERMISSION_RENAMES['supplier.manage']!, ...PERMISSION_RENAMES['user.manage']!])].sort());
    expect((db.prepare(`SELECT COUNT(*) AS n FROM permission`).get() as { n: number }).n).toBe(PERMISSIONS.length);
    seedSystemData(db, { newId, now, appVersion: 't' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM role_permission WHERE role_id = ?').get(roleId) as { n: number }).n).toBe(granted.length);
  });
});

describe('§20 security: a Sales Agent', () => {
  const setup = async () => {
    const r = await ready();
    const agent = await userWithRoles(r.env, r.adminSession, 'agent', ['SALES_AGENT']);
    return { ...r, agent };
  };

  it('cannot see supplier cost/profit or supplier balances', async () => {
    const { env, adminSession, agent } = await setup();
    const perms = (await env.call<{ permissions: string[] }>('auth.me', {}, agent)).data!.permissions;
    for (const p of ['booking.view_cost', 'booking.view_profit', 'supplier.view_financial', 'report.profit', 'dashboard.financial', 'treasury.view']) expect(perms).not.toContain(p);
    const s = (await env.call<{ id: string }>('suppliers.create', { supplier: { name: 'Sup', defaultCurrencyCode: 'EGP' } }, adminSession)).data!;
    expect((await env.call<{ balances: unknown }>('suppliers.get', { id: s.id }, agent)).data!.balances).toBeNull();
    expect((await env.call('ledger.trialBalance', { asOf: '2026-09-30' }, agent)).ok).toBe(false);
  });

  it('cannot manage roles or permissions, or users', async () => {
    const { env, adminSession, agent } = await setup();
    const role = await roleByCode(env, adminSession, 'SALES_AGENT');
    const attempts: [string, unknown][] = [
      ['roles.create', { code: 'XROLE', nameAr: 'x', nameEn: 'x', permissions: [] }],
      ['roles.update', { roleId: role.id, nameAr: 'x', nameEn: 'x' }],
      ['roles.setPermissions', { roleId: role.id, permissions: [...PERMISSIONS.map((p) => p.code)] }],
      ['users.setRoles', { userId: (await userId(env, adminSession, 'agent')).id, roleCodes: ['ADMIN'] }],
      ['users.create', { username: 'evil', displayName: 'e', password: 'temporary pass 12345', roleCodes: ['SALES_AGENT'] }],
      ['users.list', {}],
      ['roles.list', {}],
    ];
    for (const [cmd, payload] of attempts) {
      const r = await env.call(cmd, payload, agent);
      expect(!r.ok && r.error.code, cmd).toBe(ErrorCode.FORBIDDEN);
    }
    expect((await env.call<{ permissions: string[] }>('auth.me', {}, agent)).data!.permissions).not.toContain('user.view');
  });

  it('cannot modify the company configuration (financial or otherwise)', async () => {
    const { env, adminSession, agent } = await setup();
    const cur = (await env.call<CompanyProfileDto>('company.get', {}, agent)).data!;
    expect(cur.legalNameEn).toBe(COMPANY.legalNameEn);
    const r = await env.call('company.update', { rowVersion: cur.rowVersion, profile: { ...COMPANY, baseCurrencyCode: 'USD' } }, agent);
    expect(!r.ok && r.error.code).toBe(ErrorCode.FORBIDDEN);
    const lock = await env.call('company.setLockDate', { lockDate: '2026-09-30' }, agent);
    expect(!lock.ok && lock.error.code).toBe(ErrorCode.FORBIDDEN);
    expect((await env.call<CompanyProfileDto>('company.get', {}, adminSession)).data!.rowVersion).toBe(cur.rowVersion);
  });

  it('cannot disable the last Admin (or any user)', async () => {
    const { env, adminSession, admin, agent } = await setup();
    const r = await env.call('users.setActive', { userId: admin.userId, active: false }, agent);
    expect(!r.ok && r.error.code).toBe(ErrorCode.FORBIDDEN);
    const reset = await env.call('users.resetPassword', { userId: admin.userId, newPassword: 'a brand new password 1' }, agent);
    expect(!reset.ok && reset.error.code).toBe(ErrorCode.FORBIDDEN);
    expect((await userId(env, adminSession, 'owner')).status).toBe('ACTIVE');
  });

  it('cannot perform unauthorized financial or data-protection operations, and every refusal is audited', async () => {
    const { env, agent } = await setup();
    const before = auditActions(env).filter((a) => a === 'auth.permission_denied').length;
    const attempts: [string, unknown][] = [
      ['ledger.summary', { from: '2026-09-01', to: '2026-09-30' }],
      ['currency.setRate', { currencyCode: 'USD', rateDate: '2026-09-28', rate: '50' }],
      ['backup.create', {}],
      ['backup.restore', { filePath: 'x.adbk', password: 'long enough pass', confirmation: 'RESTORE' }],
      ['audit.list', {}],
      ['customers.archive', { id: '01J0000000000000000000000A' }],
      ['suppliers.archive', { id: '01J0000000000000000000000A' }],
      ['airlines.create', { airline: { nameEn: 'X' } }],
    ];
    for (const [cmd, payload] of attempts) {
      const r = await env.call(cmd, payload, agent);
      expect(!r.ok && r.error.code, cmd).toBe(ErrorCode.FORBIDDEN);
    }
    expect(auditActions(env).filter((a) => a === 'auth.permission_denied').length - before).toBe(attempts.length);
    // What an agent legitimately does still works.
    expect((await env.call('customers.create', { customer: { fullName: 'Walk-in', primaryMobile: '01001112222' } }, agent)).ok).toBe(true);
  });

  it('loses access on the very next request after the role is removed', async () => {
    const { env, adminSession, agent } = await setup();
    expect((await env.call('customers.list', {}, agent)).ok).toBe(true);
    const role = await roleByCode(env, adminSession, 'SALES_AGENT');
    const keep = (await env.call<{ code: string }[]>('permissions.list', {}, adminSession)).data!.filter((p) => p.code === 'company.view').map((p) => p.code);
    await env.call('roles.setPermissions', { roleId: role.id, permissions: keep }, adminSession);
    const r = await env.call('customers.list', {}, agent);
    expect(!r.ok && r.error.code).toBe(ErrorCode.FORBIDDEN);
  });
});

describe('audit log query', () => {
  it('filters by entity, action prefix and user, and never exposes password material', async () => {
    const { env, adminSession, admin } = await ready();
    const c = (await env.call<{ id: string }>('customers.create', { customer: { fullName: 'A', primaryMobile: '01001234567' } }, adminSession)).data!;
    await env.call('customers.archive', { id: c.id }, adminSession);
    const q = async (f: Record<string, unknown>) => (await env.call<AuditEntryDto[]>('audit.list', f, adminSession)).data!.map((e) => e.action);
    expect(await q({ entityType: 'customer', entityId: c.id })).toEqual(['customer.archived', 'customer.created']);
    expect(await q({ action: 'customer.' })).toEqual(['customer.archived', 'customer.created']);
    expect(await q({ action: '%' })).toEqual([]);
    expect((await q({ userId: admin.userId })).length).toBeGreaterThan(2);
    const entry = (await env.call<AuditEntryDto[]>('audit.list', { entityId: c.id, action: 'customer.created' }, adminSession)).data![0]!;
    expect(entry).toMatchObject({ workstation: 'TEST-PC', entityType: 'customer' });
    expect((entry.after as Record<string, unknown>).fullName).toBe('A');
    expect((await env.call<{ ok: boolean }>('integrity.run', {}, adminSession)).ok).toBe(true);
  });
});
