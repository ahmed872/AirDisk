import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSION_CODES,
  COMPANY_FIELD_GROUPS,
  COMPANY_GROUP_PERMISSION,
  ErrorCode,
  PERMISSION_RENAMES,
  assertEditable,
  assertStatusTransition,
  assertUserTransition,
  changedCompanyGroups,
  defaultPermissionsForRole,
  deriveUserStatus,
  findDuplicates,
  isCountryCode,
  isIataAirlineCode,
  nameSimilarity,
  normalizeAirline,
  normalizeCustomer,
  normalizeEmail,
  normalizePhone,
  normalizeSearchText,
  normalizeSupplier,
  statusOf,
} from '../src';

const fail = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    const err = e as { code?: string; details?: { reason?: string; field?: string } };
    return { code: err.code, reason: err.details?.reason, field: err.details?.field };
  }
  return { code: 'NO_ERROR' };
};
const ctx = { defaultCountry: 'EG', today: '2026-09-28' };

describe('search text normalisation', () => {
  it('folds Arabic letter variants, diacritics, tatweel and digits', () => {
    expect(normalizeSearchText('أَحْمَد')).toBe(normalizeSearchText('احمد'));
    expect(normalizeSearchText('إبراهيم')).toBe('ابراهيم');
    expect(normalizeSearchText('مـــصـــر')).toBe('مصر');
    expect(normalizeSearchText('فاطمة')).toBe(normalizeSearchText('فاطمه'));
    expect(normalizeSearchText('مصطفى')).toBe(normalizeSearchText('مصطفي'));
    expect(normalizeSearchText('٠١٠٠')).toBe('0100');
    expect(normalizeSearchText('  José  ÁLVAREZ ')).toBe('jose alvarez');
  });
});

describe('phone normalisation (market-neutral)', () => {
  it.each([
    ['01001234567', 'EG', '+201001234567'],
    ['٠١٠٠١٢٣٤٥٦٧', 'EG', '+201001234567'],
    ['00201001234567', 'EG', '+201001234567'],
    ['+20 100 123 4567', 'SA', '+201001234567'],
    ['0501234567', 'SA', '+966501234567'],
    ['+971 50 123 4567', 'EG', '+971501234567'],
    ['(202) 555-0147', 'US', '+12025550147'],
    ['07911 123456', 'GB', '+447911123456'],
  ])('%s in %s → %s', (raw, country, e164) => {
    expect(normalizePhone(raw, country).e164).toBe(e164);
  });

  it('rejects garbage and impossible numbers with a field-level reason', () => {
    for (const bad of ['abc', '12', 'call me', '+20 1', '0100-ABC-4567']) {
      expect(fail(() => normalizePhone(bad, 'EG', 'primaryMobile'))).toMatchObject({ code: ErrorCode.VALIDATION, reason: 'INVALID_PHONE', field: 'primaryMobile' });
    }
  });

  it('validates e-mail and country codes', () => {
    expect(normalizeEmail(' Ali@Example.COM ')).toBe('ali@example.com');
    expect(normalizeEmail('')).toBeNull();
    expect(fail(() => normalizeEmail('not-an-email'))).toMatchObject({ reason: 'INVALID_EMAIL' });
    expect(isCountryCode('SA')).toBe(true);
    expect(isCountryCode('XX')).toBe(false);
    expect(isCountryCode('sa')).toBe(false);
  });
});

describe('customer validation', () => {
  it('normalises a complete customer', () => {
    const c = normalizeCustomer(
      { fullName: '  أحمد علي ', primaryMobile: '0100 123 4567', whatsappNumber: '+966501234567', email: 'A@B.CO', nationality: 'eg', passportNo: 'a1234567' },
      ctx,
    );
    expect(c).toMatchObject({
      fullName: 'أحمد علي', primaryMobile: '+201001234567', primaryMobileRaw: '0100 123 4567', whatsappNumber: '+966501234567',
      email: 'a@b.co', nationality: 'EG', passportNo: 'A1234567', customerType: 'INDIVIDUAL', paymentTermsDays: 0,
    });
  });

  it('requires name and mobile, validates dates, country and ranges', () => {
    expect(fail(() => normalizeCustomer({ fullName: ' ', primaryMobile: '01001234567' }, ctx))).toMatchObject({ reason: 'REQUIRED', field: 'fullName' });
    expect(fail(() => normalizeCustomer({ fullName: 'A', primaryMobile: '' }, ctx))).toMatchObject({ reason: 'REQUIRED', field: 'primaryMobile' });
    expect(fail(() => normalizeCustomer({ fullName: 'A', primaryMobile: '01001234567', dateOfBirth: '2030-01-01' }, ctx))).toMatchObject({ reason: 'DATE_IN_FUTURE' });
    expect(fail(() => normalizeCustomer({ fullName: 'A', primaryMobile: '01001234567', passportExpiry: '2026-13-01' }, ctx))).toMatchObject({ reason: 'INVALID_DATE' });
    expect(fail(() => normalizeCustomer({ fullName: 'A', primaryMobile: '01001234567', nationality: 'ZZ' }, ctx))).toMatchObject({ reason: 'INVALID_COUNTRY' });
    expect(fail(() => normalizeCustomer({ fullName: 'A', primaryMobile: '01001234567', paymentTermsDays: 400 }, ctx))).toMatchObject({ reason: 'OUT_OF_RANGE' });
    expect(fail(() => normalizeCustomer({ fullName: 'x'.repeat(201), primaryMobile: '01001234567' }, ctx))).toMatchObject({ reason: 'TOO_LONG' });
  });
});

describe('supplier and airline validation', () => {
  it('suppliers: name + currency required; phones interpreted in the supplier country', () => {
    const s = normalizeSupplier({ name: 'Company ABC', defaultCurrencyCode: 'usd', phonePrimary: '0501234567', countryCode: 'SA' }, ctx);
    expect(s).toMatchObject({ name: 'Company ABC', defaultCurrencyCode: 'USD', phonePrimary: '+966501234567', countryCode: 'SA' });
    expect(fail(() => normalizeSupplier({ name: '', defaultCurrencyCode: 'EGP' }, ctx))).toMatchObject({ reason: 'REQUIRED' });
    expect(fail(() => normalizeSupplier({ name: 'X', defaultCurrencyCode: 'E1' }, ctx))).toMatchObject({ reason: 'INVALID_CURRENCY' });
  });

  it('airlines: IATA 2 chars (not two digits), ICAO 3 letters, ticket prefix 3 digits, URL scheme', () => {
    expect(normalizeAirline({ nameEn: 'EgyptAir', iataCode: 'ms', icaoCode: 'msr', ticketPrefix: '077' }, ctx)).toMatchObject({ iataCode: 'MS', icaoCode: 'MSR' });
    expect(isIataAirlineCode('9W')).toBe(true);
    expect(isIataAirlineCode('12')).toBe(false);
    for (const [input, reason] of [
      [{ nameEn: 'X', iataCode: 'MSR' }, 'TOO_LONG'],
      [{ nameEn: 'X', iataCode: '12' }, 'INVALID_IATA'],
      [{ nameEn: 'X', icaoCode: 'M1R' }, 'INVALID_ICAO'],
      [{ nameEn: 'X', ticketPrefix: '77' }, 'INVALID_TICKET_PREFIX'],
      [{ nameEn: 'X', website: 'egyptair.com' }, 'INVALID_URL'],
      [{ nameEn: '' }, 'REQUIRED'],
    ] as const) {
      expect(fail(() => normalizeAirline(input, ctx)).reason).toBe(reason);
    }
  });
});

describe('duplicate detection (warning only, never merge)', () => {
  const existing = [
    { id: 'A', name: 'Ahmed Ali Hassan', phones: ['+201001234567'], email: 'ahmed@x.com' },
    { id: 'B', name: 'Mona Saeed', phones: ['+966501112233'], email: null },
    { id: 'C', name: 'أحمد علي', phones: ['+201221234567'], email: null },
  ];

  it('flags same phone, same e-mail, and similar name + same trailing digits', () => {
    expect(findDuplicates({ name: 'Someone', phones: ['+201001234567'], email: null }, existing)).toEqual([{ id: 'A', signals: ['SAME_PHONE'] }]);
    expect(findDuplicates({ name: 'Someone', phones: [], email: 'AHMED@x.com' }, existing)).toEqual([{ id: 'A', signals: ['SAME_EMAIL'] }]);
    expect(findDuplicates({ name: 'احمد على', phones: ['+201001234567'], email: null }, existing).map((m) => m.id)).toEqual(['A', 'C']);
    expect(findDuplicates({ name: 'Other Person', phones: ['+201221234567'].map((p) => p.replace('122', '155')), email: null }, existing)).toEqual([]);
  });

  it('ignores the record itself and optionally flags identical names', () => {
    expect(findDuplicates({ id: 'A', name: 'x', phones: ['+201001234567'], email: null }, existing)).toEqual([]);
    expect(findDuplicates({ name: 'MONA  saeed', phones: [], email: null }, existing, { includeSameName: true })).toEqual([{ id: 'B', signals: ['SAME_NAME'] }]);
  });

  it('name similarity is order-insensitive and Arabic-folded', () => {
    expect(nameSimilarity('Ali Ahmed', 'ahmed ali')).toBe(1);
    expect(nameSimilarity('أحمد علي', 'احمد علي')).toBe(1);
    expect(nameSimilarity('Ali', 'Mona')).toBe(0);
  });
});

describe('archive rules and user states', () => {
  it('ACTIVE ⇄ ARCHIVED only; archived records are read-only', () => {
    expect(statusOf(1)).toBe('ACTIVE');
    expect(statusOf(0)).toBe('ARCHIVED');
    expect(() => assertStatusTransition('ACTIVE', 'ARCHIVED')).not.toThrow();
    expect(fail(() => assertStatusTransition('ARCHIVED', 'ARCHIVED'))).toMatchObject({ code: ErrorCode.CONFLICT, reason: 'ALREADY_ARCHIVED' });
    expect(fail(() => assertEditable('ARCHIVED'))).toMatchObject({ reason: 'ARCHIVED_READ_ONLY' });
  });

  it('derives user status and forbids self-lockout', () => {
    const now = '2026-09-28T10:00:00.000Z';
    expect(deriveUserStatus({ isActive: true, lockedUntil: null }, now)).toBe('ACTIVE');
    expect(deriveUserStatus({ isActive: true, lockedUntil: '2026-09-28T10:10:00.000Z' }, now)).toBe('LOCKED');
    expect(deriveUserStatus({ isActive: true, lockedUntil: '2026-09-28T09:00:00.000Z' }, now)).toBe('ACTIVE');
    expect(deriveUserStatus({ isActive: false, lockedUntil: '2026-09-28T10:10:00.000Z' }, now)).toBe('DISABLED');
    expect(fail(() => assertUserTransition('DISABLE', 'ACTIVE', { isSelf: true }))).toMatchObject({ reason: 'SELF_LOCKOUT' });
    expect(fail(() => assertUserTransition('REMOVE_ADMIN_ROLE', 'ACTIVE', { isSelf: true }))).toMatchObject({ reason: 'SELF_LOCKOUT' });
    expect(fail(() => assertUserTransition('ENABLE', 'ACTIVE', { isSelf: false }))).toMatchObject({ reason: 'ALREADY_ACTIVE' });
    expect(fail(() => assertUserTransition('UNLOCK', 'ACTIVE', { isSelf: false }))).toMatchObject({ reason: 'NOT_LOCKED' });
    expect(() => assertUserTransition('DISABLE', 'LOCKED', { isSelf: false })).not.toThrow();
  });
});

describe('company configuration groups', () => {
  it('every company field belongs to exactly one permission group', () => {
    const all = Object.values(COMPANY_FIELD_GROUPS).flat();
    expect(new Set(all).size).toBe(all.length);
    for (const perm of Object.values(COMPANY_GROUP_PERMISSION)) expect(ALL_PERMISSION_CODES.has(perm)).toBe(true);
  });

  it('detects exactly which groups a change touches', () => {
    const before = { legalNameAr: 'أ', baseCurrencyCode: 'EGP', logoBase64: null, taxRegistrationNo: null, dateFormat: 'DD/MM/YYYY' };
    expect(changedCompanyGroups(before, { ...before })).toEqual([]);
    expect(changedCompanyGroups(before, { ...before, logoBase64: 'AAA' })).toEqual(['branding']);
    expect(changedCompanyGroups(before, { ...before, taxRegistrationNo: '123' })).toEqual(['financial']);
    expect(changedCompanyGroups(before, { ...before, dateFormat: 'YYYY-MM-DD', baseCurrencyCode: 'SAR' })).toEqual(['general', 'financial']);
    expect(changedCompanyGroups(before, { ...before, taxRegistrationNo: '' })).toEqual([]);
  });
});

describe('permission catalogue evolution', () => {
  it('renamed codes are gone from the catalogue and every replacement exists', () => {
    for (const [oldCode, replacements] of Object.entries(PERMISSION_RENAMES)) {
      expect(ALL_PERMISSION_CODES.has(oldCode)).toBe(false);
      for (const r of replacements) expect(ALL_PERMISSION_CODES.has(r)).toBe(true);
    }
  });

  it('Phase 2 categories exist (company, users, roles, customers, suppliers, airlines)', () => {
    for (const c of [
      'company.view', 'company.edit', 'company.branding', 'company.financial_config',
      'user.view', 'user.create', 'user.edit', 'user.disable', 'user.reset_credentials',
      'role.view', 'role.create', 'role.edit', 'role.manage_permissions',
      'customer.view', 'customer.create', 'customer.edit', 'customer.archive',
      'supplier.view', 'supplier.create', 'supplier.edit', 'supplier.archive', 'supplier.view_financial',
      'airline.view', 'airline.create', 'airline.edit', 'airline.archive',
    ]) expect(ALL_PERMISSION_CODES.has(c)).toBe(true);
  });

  it('Sales Agent defaults: customer work yes; supplier financials, roles, users, company finance no', () => {
    const agent = new Set(defaultPermissionsForRole('SALES_AGENT'));
    for (const yes of ['customer.view', 'customer.create', 'customer.edit', 'supplier.view', 'airline.view', 'company.view']) expect(agent.has(yes)).toBe(true);
    for (const no of ['supplier.view_financial', 'booking.view_cost', 'booking.view_profit', 'role.manage_permissions', 'role.create', 'user.disable', 'user.create', 'company.financial_config', 'company.edit', 'customer.archive']) {
      expect(agent.has(no)).toBe(false);
    }
  });
});
