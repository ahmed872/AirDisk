import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';
import { DomainError, ErrorCode } from '../errors';
import { normalizeDigits } from '../text/digits';

/**
 * Field-level validation failure. `reason` is a stable code the UI translates
 * (validation.<reason>); `field` names the input so the form can highlight it.
 */
export function fieldError(field: string, reason: string, message: string): DomainError {
  return new DomainError(ErrorCode.VALIDATION, message, { field, reason });
}

export function isCountryCode(code: string): boolean {
  return /^[A-Z]{2}$/.test(code) && isSupportedCountry(code as CountryCode);
}

export function assertCountryCode(code: string, field = 'country'): string {
  if (!isCountryCode(code)) throw fieldError(field, 'INVALID_COUNTRY', `Unknown country code "${code}"`);
  return code;
}

export interface NormalizedPhone {
  /** E.164, e.g. +201001234567 — the stored, comparable form. */
  e164: string;
  /** What the user typed (trimmed), kept for display fidelity. */
  raw: string;
}

/**
 * Market-neutral phone normalisation (owner requirement: no Egypt-only
 * assumptions). National numbers are interpreted in the company's default
 * country; numbers with + or 00 keep their own country. Arabic-Indic digits,
 * spaces, dashes and brackets are accepted.
 */
export function normalizePhone(input: string, defaultCountry: string, field = 'phone'): NormalizedPhone {
  const raw = input.trim();
  const ascii = normalizeDigits(raw).replace(/^00/, '+');
  if (!/\d/.test(ascii) || /[^\d\s+().\-/]/.test(ascii)) throw fieldError(field, 'INVALID_PHONE', `Not a valid phone number: "${raw}"`);
  const parsed = parsePhoneNumberFromString(ascii, isCountryCode(defaultCountry) ? (defaultCountry as CountryCode) : undefined);
  if (!parsed || !parsed.isPossible()) throw fieldError(field, 'INVALID_PHONE', `Not a valid phone number: "${raw}"`);
  return { e164: parsed.number, raw };
}

export function normalizeOptionalPhone(input: string | null | undefined, defaultCountry: string, field: string): NormalizedPhone | null {
  if (input === null || input === undefined || input.trim() === '') return null;
  return normalizePhone(input, defaultCountry, field);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(input: string | null | undefined, field = 'email'): string | null {
  if (input === null || input === undefined || input.trim() === '') return null;
  const e = input.trim().toLowerCase();
  if (e.length > 200 || !EMAIL_RE.test(e)) throw fieldError(field, 'INVALID_EMAIL', `Not a valid e-mail address: "${input}"`);
  return e;
}

/** Trims; empty → null; enforces a maximum length. */
export function optionalText(input: string | null | undefined, field: string, max: number): string | null {
  if (input === null || input === undefined) return null;
  const t = input.trim();
  if (t === '') return null;
  if (t.length > max) throw fieldError(field, 'TOO_LONG', `${field} must be at most ${max} characters`);
  return t;
}

export function requiredText(input: string | null | undefined, field: string, max: number): string {
  const t = optionalText(input, field, max);
  if (t === null) throw fieldError(field, 'REQUIRED', `${field} is required`);
  return t;
}
