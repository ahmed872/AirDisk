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
    /** base64 image; bounded to ~512 KB decoded. */
    logoBase64: z.string().max(700_000).optional().nullable(),
    logoMime: z.enum(['image/png', 'image/jpeg', 'image/svg+xml']).optional().nullable(),
  })
  .strict();
export type CompanyProfileInput = z.infer<typeof companyProfileInput>;

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

  'users.list': z.object({}).strict(),
  'users.create': z
    .object({ username, displayName: text(100), password, roleCodes: z.array(roleCode).min(1).max(20), locale: locale.optional() })
    .strict(),
  'users.setRoles': z.object({ userId: ulid, roleCodes: z.array(roleCode).min(1).max(20) }).strict(),
  'users.setActive': z.object({ userId: ulid, active: z.boolean() }).strict(),
  'users.resetPassword': z.object({ userId: ulid, newPassword: password }).strict(),

  'roles.list': z.object({}).strict(),
  'roles.create': z
    .object({ code: roleCode, nameAr: text(100), nameEn: text(100), permissions: z.array(permissionCode).max(500) })
    .strict(),
  'roles.setPermissions': z.object({ roleId: ulid, permissions: z.array(permissionCode).max(500) }).strict(),
  'permissions.list': z.object({}).strict(),

  'ledger.summary': z.object({ from: isoDate, to: isoDate }).strict(),
  'ledger.trialBalance': z.object({ asOf: isoDate }).strict(),

  'integrity.run': z.object({}).strict(),

  'backup.create': z.object({ destinationDir: z.string().max(1000).optional() }).strict(),
  'backup.list': z.object({}).strict(),
  'backup.restore': z.object({ filePath: z.string().min(1).max(1000), password, confirmation: z.literal('RESTORE') }).strict(),

  'audit.list': z.object({ limit: z.number().int().min(1).max(500).default(100), beforeSeq: z.number().int().positive().optional() }).strict(),
} as const;

export type CommandName = keyof typeof commandSchemas;
export type CommandInput<C extends CommandName> = z.input<(typeof commandSchemas)[C]>;
export const COMMAND_NAMES = Object.keys(commandSchemas) as CommandName[];
