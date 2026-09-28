import { DomainError, ErrorCode } from '../errors';
import {
  assertCountryCode,
  fieldError,
  normalizeEmail,
  normalizeOptionalPhone,
  normalizePhone,
  optionalText,
  requiredText,
} from '../contact/contact';
import { isIsoDate } from '../time/dates';

// ---------------------------------------------------------------------------
// Archive rules (owner requirement §14): no destructive deletion of master
// data that business records may reference. ACTIVE ⇄ ARCHIVED only.
// ---------------------------------------------------------------------------
export type RecordStatus = 'ACTIVE' | 'ARCHIVED';

export function statusOf(isActive: number | boolean): RecordStatus {
  return isActive === 1 || isActive === true ? 'ACTIVE' : 'ARCHIVED';
}

export function assertStatusTransition(current: RecordStatus, target: RecordStatus): void {
  if (current === target) {
    throw new DomainError(ErrorCode.CONFLICT, target === 'ARCHIVED' ? 'Already archived' : 'Already active', { reason: `ALREADY_${target}` });
  }
}

/** Archived records are read-only: restore first, then edit (keeps the history of what was archived). */
export function assertEditable(current: RecordStatus): void {
  if (current === 'ARCHIVED') throw new DomainError(ErrorCode.CONFLICT, 'Archived records cannot be edited; restore it first', { reason: 'ARCHIVED_READ_ONLY' });
}

function optionalIsoDate(input: string | null | undefined, field: string): string | null {
  const v = optionalText(input, field, 10);
  if (v !== null && !isIsoDate(v)) throw fieldError(field, 'INVALID_DATE', `${field} must be a valid date`);
  return v;
}

function optionalCountry(input: string | null | undefined, field: string): string | null {
  const v = optionalText(input, field, 2);
  return v === null ? null : assertCountryCode(v.toUpperCase(), field);
}

function nonNegativeInt(input: number | null | undefined, field: string, max: number): number {
  const v = input ?? 0;
  if (!Number.isInteger(v) || v < 0 || v > max) throw fieldError(field, 'OUT_OF_RANGE', `${field} must be between 0 and ${max}`);
  return v;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
export interface CustomerInput {
  customerType?: 'INDIVIDUAL' | 'CORPORATE';
  fullName: string;
  fullNameLatin?: string | null;
  primaryMobile: string;
  secondaryMobile?: string | null;
  whatsappNumber?: string | null;
  email?: string | null;
  address?: string | null;
  nationality?: string | null;
  nationalId?: string | null;
  passportNo?: string | null;
  passportExpiry?: string | null;
  dateOfBirth?: string | null;
  preferredLocale?: 'ar' | 'en' | null;
  paymentTermsDays?: number | null;
  notes?: string | null;
}

export interface NormalizedCustomer {
  customerType: 'INDIVIDUAL' | 'CORPORATE';
  fullName: string;
  fullNameLatin: string | null;
  primaryMobile: string;
  primaryMobileRaw: string;
  secondaryMobile: string | null;
  whatsappNumber: string | null;
  email: string | null;
  address: string | null;
  nationality: string | null;
  nationalId: string | null;
  passportNo: string | null;
  passportExpiry: string | null;
  dateOfBirth: string | null;
  preferredLocale: 'ar' | 'en' | null;
  paymentTermsDays: number;
  notes: string | null;
}

/**
 * Validates and canonicalises a customer. Identity data (national ID,
 * passport) is optional — collected only when the office needs it for
 * ticketing (data minimisation) — and is redacted for users without
 * customer.view_identity.
 */
export function normalizeCustomer(input: CustomerInput, ctx: { defaultCountry: string; today: string }): NormalizedCustomer {
  const primary = normalizePhone(requiredText(input.primaryMobile, 'primaryMobile', 40), ctx.defaultCountry, 'primaryMobile');
  const dob = optionalIsoDate(input.dateOfBirth, 'dateOfBirth');
  if (dob && dob > ctx.today) throw fieldError('dateOfBirth', 'DATE_IN_FUTURE', 'Date of birth cannot be in the future');
  const type = input.customerType ?? 'INDIVIDUAL';
  if (type !== 'INDIVIDUAL' && type !== 'CORPORATE') throw fieldError('customerType', 'INVALID_VALUE', 'Unknown customer type');
  return {
    customerType: type,
    fullName: requiredText(input.fullName, 'fullName', 200),
    fullNameLatin: optionalText(input.fullNameLatin, 'fullNameLatin', 200),
    primaryMobile: primary.e164,
    primaryMobileRaw: primary.raw,
    secondaryMobile: normalizeOptionalPhone(input.secondaryMobile, ctx.defaultCountry, 'secondaryMobile')?.e164 ?? null,
    whatsappNumber: normalizeOptionalPhone(input.whatsappNumber, ctx.defaultCountry, 'whatsappNumber')?.e164 ?? null,
    email: normalizeEmail(input.email),
    address: optionalText(input.address, 'address', 500),
    nationality: optionalCountry(input.nationality, 'nationality'),
    nationalId: optionalText(input.nationalId, 'nationalId', 40),
    passportNo: optionalText(input.passportNo, 'passportNo', 20)?.toUpperCase() ?? null,
    passportExpiry: optionalIsoDate(input.passportExpiry, 'passportExpiry'),
    dateOfBirth: dob,
    preferredLocale: input.preferredLocale ?? null,
    paymentTermsDays: nonNegativeInt(input.paymentTermsDays, 'paymentTermsDays', 365),
    notes: optionalText(input.notes, 'notes', 2000),
  };
}

// ---------------------------------------------------------------------------
// Suppliers (a separate business/financial party — never assumed to be an airline)
// ---------------------------------------------------------------------------
export interface SupplierInput {
  name: string;
  contactPerson?: string | null;
  phonePrimary?: string | null;
  phoneSecondary?: string | null;
  email?: string | null;
  address?: string | null;
  countryCode?: string | null;
  defaultCurrencyCode: string;
  paymentTermsDays?: number | null;
  airlineId?: string | null;
  notes?: string | null;
}

export interface NormalizedSupplier {
  name: string;
  contactPerson: string | null;
  phonePrimary: string | null;
  phoneSecondary: string | null;
  email: string | null;
  address: string | null;
  countryCode: string | null;
  defaultCurrencyCode: string;
  paymentTermsDays: number;
  airlineId: string | null;
  notes: string | null;
}

export function normalizeSupplier(input: SupplierInput, ctx: { defaultCountry: string }): NormalizedSupplier {
  const cur = requiredText(input.defaultCurrencyCode, 'defaultCurrencyCode', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) throw fieldError('defaultCurrencyCode', 'INVALID_CURRENCY', 'Invalid currency');
  const country = optionalCountry(input.countryCode, 'countryCode');
  const phoneCountry = country ?? ctx.defaultCountry;
  return {
    name: requiredText(input.name, 'name', 200),
    contactPerson: optionalText(input.contactPerson, 'contactPerson', 200),
    phonePrimary: normalizeOptionalPhone(input.phonePrimary, phoneCountry, 'phonePrimary')?.e164 ?? null,
    phoneSecondary: normalizeOptionalPhone(input.phoneSecondary, phoneCountry, 'phoneSecondary')?.e164 ?? null,
    email: normalizeEmail(input.email),
    address: optionalText(input.address, 'address', 500),
    countryCode: country,
    defaultCurrencyCode: cur,
    paymentTermsDays: nonNegativeInt(input.paymentTermsDays, 'paymentTermsDays', 365),
    airlineId: optionalText(input.airlineId, 'airlineId', 26),
    notes: optionalText(input.notes, 'notes', 2000),
  };
}

// ---------------------------------------------------------------------------
// Airlines
// ---------------------------------------------------------------------------
export interface AirlineInput {
  nameEn: string;
  nameAr?: string | null;
  iataCode?: string | null;
  icaoCode?: string | null;
  ticketPrefix?: string | null;
  countryCode?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  notes?: string | null;
}

export interface NormalizedAirline {
  nameEn: string;
  nameAr: string | null;
  iataCode: string | null;
  icaoCode: string | null;
  ticketPrefix: string | null;
  countryCode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  notes: string | null;
}

/** IATA airline designator: 2 characters, letters/digits, not two digits (e.g. MS, SV, 9W). */
export function isIataAirlineCode(code: string): boolean {
  return /^[A-Z0-9]{2}$/.test(code) && !/^\d{2}$/.test(code);
}

export function normalizeAirline(input: AirlineInput, ctx: { defaultCountry: string }): NormalizedAirline {
  const iata = optionalText(input.iataCode, 'iataCode', 2)?.toUpperCase() ?? null;
  if (iata !== null && !isIataAirlineCode(iata)) throw fieldError('iataCode', 'INVALID_IATA', 'IATA code must be 2 letters/digits (e.g. MS)');
  const icao = optionalText(input.icaoCode, 'icaoCode', 3)?.toUpperCase() ?? null;
  if (icao !== null && !/^[A-Z]{3}$/.test(icao)) throw fieldError('icaoCode', 'INVALID_ICAO', 'ICAO code must be 3 letters (e.g. MSR)');
  const prefix = optionalText(input.ticketPrefix, 'ticketPrefix', 3);
  if (prefix !== null && !/^\d{3}$/.test(prefix)) throw fieldError('ticketPrefix', 'INVALID_TICKET_PREFIX', 'Ticket prefix must be 3 digits (e.g. 077)');
  const website = optionalText(input.website, 'website', 200);
  if (website !== null && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(website)) throw fieldError('website', 'INVALID_URL', 'Website must start with http:// or https://');
  const country = optionalCountry(input.countryCode, 'countryCode');
  return {
    nameEn: requiredText(input.nameEn, 'nameEn', 200),
    nameAr: optionalText(input.nameAr, 'nameAr', 200),
    iataCode: iata,
    icaoCode: icao,
    ticketPrefix: prefix,
    countryCode: country,
    phone: normalizeOptionalPhone(input.phone, country ?? ctx.defaultCountry, 'phone')?.e164 ?? null,
    email: normalizeEmail(input.email),
    website,
    notes: optionalText(input.notes, 'notes', 2000),
  };
}
