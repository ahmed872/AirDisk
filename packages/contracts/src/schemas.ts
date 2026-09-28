import { z } from 'zod';

/**
 * Input schemas for every backend command (validated at the transport
 * boundary before any handler runs). Strings are trimmed and bounded; money is
 * integer minor units; dates are ISO; nothing unbounded crosses the IPC line.
 */
const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).optional().nullable();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'ULID');
export const currencyCode = z.string().regex(/^[A-Z]{3}$/);
export const locale = z.enum(['ar', 'en']);
const username = z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, . _ -');
const password = z.string().min(1).max(128);
const roleCode = z.string().trim().min(2).max(40).regex(/^[A-Z][A-Z0-9_]*$/);
const permissionCode = z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/);

export const companyProfileInput = z
  .object({
    legalNameAr: text(200),
    legalNameEn: optText(200),
    tradeNameAr: optText(200),
    tradeNameEn: optText(200),
    addressAr: optText(500),
    addressEn: optText(500),
    phonePrimary: optText(40),
    phoneSecondary: optText(40),
    email: z.string().trim().email().max(200).optional().nullable().or(z.literal('')),
    website: optText(200),
    taxRegistrationNo: optText(60),
    commercialRegistrationNo: optText(60),
    iataAgencyCode: optText(20),
    baseCurrencyCode: currencyCode,
    defaultCountryCode: z.string().regex(/^[A-Z]{2}$/),
    timezone: text(64),
    defaultLocale: locale,
    documentFooterAr: optText(1000),
    documentFooterEn: optText(1000),
    invoiceTitleAr: optText(200),
    invoiceTitleEn: optText(200),
    invoiceTermsAr: optText(2000),
    invoiceTermsEn: optText(2000),
    dateFormat: z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']).optional(),
    numberFormat: z.enum(['LATIN', 'ARABIC_INDIC']).optional(),
    textDirection: z.enum(['AUTO', 'RTL', 'LTR']).optional(),
    /** base64 image; bounded to ~512 KB decoded. */
    logoBase64: z.string().max(700_000).optional().nullable(),
    logoMime: z.enum(['image/png', 'image/jpeg', 'image/svg+xml']).optional().nullable(),
  })
  .strict();
export type CompanyProfileInput = z.infer<typeof companyProfileInput>;

// Master data inputs are shape-checked here; business validation (phones,
// codes, countries, dates) happens in the domain layer on the backend.
const s = (max: number) => z.string().max(max).optional().nullable();
export const customerInput = z
  .object({
    customerType: z.enum(['INDIVIDUAL', 'CORPORATE']).optional(),
    fullName: z.string().max(200),
    fullNameLatin: s(200),
    primaryMobile: z.string().max(40),
    secondaryMobile: s(40),
    whatsappNumber: s(40),
    email: s(200),
    address: s(500),
    nationality: s(2),
    nationalId: s(40),
    passportNo: s(20),
    passportExpiry: s(10),
    dateOfBirth: s(10),
    preferredLocale: locale.optional().nullable(),
    paymentTermsDays: z.number().int().min(0).max(365).optional().nullable(),
    notes: s(2000),
  })
  .strict();
export type CustomerInputDto = z.infer<typeof customerInput>;

export const supplierInput = z
  .object({
    name: z.string().max(200),
    contactPerson: s(200),
    phonePrimary: s(40),
    phoneSecondary: s(40),
    email: s(200),
    address: s(500),
    countryCode: s(2),
    defaultCurrencyCode: z.string().max(3),
    paymentTermsDays: z.number().int().min(0).max(365).optional().nullable(),
    airlineId: ulid.optional().nullable(),
    notes: s(2000),
  })
  .strict();
export type SupplierInputDto = z.infer<typeof supplierInput>;

export const airlineInput = z
  .object({
    nameEn: z.string().max(200),
    nameAr: s(200),
    iataCode: s(2),
    icaoCode: s(3),
    ticketPrefix: s(3),
    countryCode: s(2),
    phone: s(40),
    email: s(200),
    website: s(200),
    notes: s(2000),
  })
  .strict();
export type AirlineInputDto = z.infer<typeof airlineInput>;

const statusFilter = z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE');
const listQuery = <F extends [string, ...string[]]>(sortFields: F) =>
  z
    .object({
      query: z.string().max(100).optional(),
      status: statusFilter,
      sortBy: z.enum(sortFields).optional(),
      sortDir: z.enum(['asc', 'desc']).default('asc'),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    })
    .strict();
const idOnly = z.object({ id: ulid }).strict();
const statusChange = z.object({ id: ulid, reason: optText(500) }).strict();

export const commandSchemas = {
  'system.status': z.object({}).strict(),
  'system.setup': z
    .object({
      company: companyProfileInput,
      admin: z.object({ username, displayName: text(100), password, locale }).strict(),
    })
    .strict(),

  'auth.login': z.object({ username: z.string().trim().min(1).max(40), password }).strict(),
  'auth.logout': z.object({}).strict(),
  'auth.me': z.object({}).strict(),
  'auth.changePassword': z.object({ currentPassword: password, newPassword: password }).strict(),

  'company.get': z.object({}).strict(),
  'company.update': z.object({ profile: companyProfileInput, rowVersion: z.number().int().positive() }).strict(),
  'company.setLockDate': z.object({ lockDate: isoDate, reason: optText(500) }).strict(),

  'currency.list': z.object({}).strict(),
  'currency.setRate': z.object({ currencyCode, rateDate: isoDate, rate: z.string().trim().min(1).max(30) }).strict(),

  'users.list': z.object({ query: z.string().max(100).optional(), status: z.enum(['ALL', 'ACTIVE', 'DISABLED']).default('ALL') }).strict(),
  'users.create': z
    .object({
      username, displayName: text(100), password, roleCodes: z.array(roleCode).min(1).max(20), locale: locale.optional(),
      email: s(200), mobile: s(40), notes: s(2000),
    })
    .strict(),
  'users.update': z
    .object({ userId: ulid, displayName: text(100), email: s(200), mobile: s(40), notes: s(2000), locale: locale.optional().nullable(), rowVersion: z.number().int().positive() })
    .strict(),
  'users.unlock': z.object({ userId: ulid }).strict(),
  'users.setRoles': z.object({ userId: ulid, roleCodes: z.array(roleCode).min(1).max(20) }).strict(),
  'users.setActive': z.object({ userId: ulid, active: z.boolean() }).strict(),
  'users.resetPassword': z.object({ userId: ulid, newPassword: password }).strict(),

  'roles.list': z.object({}).strict(),
  'roles.create': z
    .object({ code: roleCode, nameAr: text(100), nameEn: text(100), permissions: z.array(permissionCode).max(500) })
    .strict(),
  'roles.update': z.object({ roleId: ulid, nameAr: text(100), nameEn: text(100), description: optText(500) }).strict(),
  'roles.setPermissions': z.object({ roleId: ulid, permissions: z.array(permissionCode).max(500) }).strict(),
  'permissions.list': z.object({}).strict(),

  'ledger.summary': z.object({ from: isoDate, to: isoDate }).strict(),
  'ledger.trialBalance': z.object({ asOf: isoDate }).strict(),

  'integrity.run': z.object({}).strict(),

  'backup.create': z.object({ destinationDir: z.string().max(1000).optional() }).strict(),
  'backup.list': z.object({}).strict(),
  'backup.restore': z.object({ filePath: z.string().min(1).max(1000), password, confirmation: z.literal('RESTORE') }).strict(),

  'audit.list': z
    .object({
      limit: z.number().int().min(1).max(500).default(100),
      beforeSeq: z.number().int().positive().optional(),
      entityType: z.string().max(40).optional(),
      entityId: z.string().max(60).optional(),
      action: z.string().max(60).optional(),
      userId: ulid.optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
    })
    .strict(),

  'dashboard.summary': z.object({}).strict(),

  'customers.list': listQuery(['customerNo', 'fullName', 'createdAt', 'updatedAt']),
  'customers.get': idOnly,
  'customers.checkDuplicates': z.object({ customer: customerInput.partial(), excludeId: ulid.optional() }).strict(),
  'customers.create': z.object({ customer: customerInput, confirmDuplicates: z.boolean().default(false) }).strict(),
  'customers.update': z.object({ id: ulid, customer: customerInput, rowVersion: z.number().int().positive(), confirmDuplicates: z.boolean().default(false) }).strict(),
  'customers.archive': statusChange,
  'customers.restore': statusChange,

  'suppliers.list': listQuery(['supplierNo', 'name', 'createdAt', 'updatedAt']),
  'suppliers.get': idOnly,
  'suppliers.create': z.object({ supplier: supplierInput, confirmDuplicates: z.boolean().default(false) }).strict(),
  'suppliers.update': z.object({ id: ulid, supplier: supplierInput, rowVersion: z.number().int().positive(), confirmDuplicates: z.boolean().default(false) }).strict(),
  'suppliers.archive': statusChange,
  'suppliers.restore': statusChange,

  'airlines.list': listQuery(['nameEn', 'iataCode', 'createdAt', 'updatedAt']),
  'airlines.get': idOnly,
  'airlines.create': z.object({ airline: airlineInput, confirmDuplicates: z.boolean().default(false) }).strict(),
  'airlines.update': z.object({ id: ulid, airline: airlineInput, rowVersion: z.number().int().positive(), confirmDuplicates: z.boolean().default(false) }).strict(),
  'airlines.archive': statusChange,
  'airlines.restore': statusChange,
} as const;

export type CommandName = keyof typeof commandSchemas;
export type CommandInput<C extends CommandName> = z.input<(typeof commandSchemas)[C]>;
export const COMMAND_NAMES = Object.keys(commandSchemas) as CommandName[];
