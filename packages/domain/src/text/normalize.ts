import { normalizeDigits } from './digits';

const ARABIC_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const LETTER_FOLDS: ReadonlyArray<[RegExp, string]> = [
  [/[أإآٱ]/g, 'ا'],
  [/ى/g, 'ي'],
  [/ة/g, 'ه'],
  [/ؤ/g, 'و'],
  [/ئ/g, 'ي'],
];

/**
 * Canonical form used for BOTH indexing and querying (Phase 0 §07-4): the same
 * person written "أحمد", "احمد" or "أَحْمَد", or a number typed with Arabic-Indic
 * digits, must match. Latin text is case- and accent-folded.
 */
export function normalizeSearchText(input: string): string {
  let s = normalizeDigits(input).normalize('NFKC');
  s = s.replace(ARABIC_DIACRITICS, '').replace(TATWEEL, '');
  for (const [re, to] of LETTER_FOLDS) s = s.replace(re, to);
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return s.replace(/\s+/g, ' ').trim();
}

/** Digits only, for phone-fragment search ("0100 123" → "0100123"). */
export function digitsOnly(input: string): string {
  return normalizeDigits(input).replace(/\D/g, '');
}

/** Word tokens of a normalised string (used by name-similarity checks). */
export function nameTokens(input: string): string[] {
  return normalizeSearchText(input)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}
