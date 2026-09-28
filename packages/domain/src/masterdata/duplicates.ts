import { digitsOnly, nameTokens, normalizeSearchText } from '../text/normalize';

export type DuplicateSignal = 'SAME_PHONE' | 'SAME_EMAIL' | 'SIMILAR_NAME_AND_PHONE' | 'SAME_NAME';

export interface PartyFingerprint {
  id?: string;
  name: string;
  /** E.164 numbers (primary, secondary, WhatsApp …). */
  phones: readonly (string | null | undefined)[];
  email: string | null | undefined;
}

export interface DuplicateMatch {
  id: string;
  signals: DuplicateSignal[];
}

/** Sørensen–Dice over name tokens; 1 = same tokens in any order. */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}

const SUFFIX = 7;
const suffix = (e164: string) => digitsOnly(e164).slice(-SUFFIX);

/**
 * Duplicate WARNING signals (owner requirement §10). Detection only — the
 * system never merges automatically; an authorised user decides. Signals:
 *  - SAME_PHONE: any normalised number in common;
 *  - SAME_EMAIL: identical normalised e-mail;
 *  - SIMILAR_NAME_AND_PHONE: name similarity ≥ 0.75 and a number ending in the
 *    same 7 digits (typo in the country/area part);
 *  - SAME_NAME: identical normalised name (weak; shown for suppliers/airlines).
 */
export function findDuplicates(candidate: PartyFingerprint, existing: readonly (PartyFingerprint & { id: string })[], opts: { includeSameName?: boolean } = {}): DuplicateMatch[] {
  const phones = new Set(candidate.phones.filter((p): p is string => !!p));
  const suffixes = new Set([...phones].map(suffix));
  const email = candidate.email?.toLowerCase() ?? null;
  const name = normalizeSearchText(candidate.name);
  const out: DuplicateMatch[] = [];
  for (const other of existing) {
    if (other.id === candidate.id) continue;
    const signals: DuplicateSignal[] = [];
    const otherPhones = other.phones.filter((p): p is string => !!p);
    if (otherPhones.some((p) => phones.has(p))) signals.push('SAME_PHONE');
    if (email && other.email && other.email.toLowerCase() === email) signals.push('SAME_EMAIL');
    if (!signals.includes('SAME_PHONE') && otherPhones.some((p) => suffixes.has(suffix(p))) && nameSimilarity(candidate.name, other.name) >= 0.75) {
      signals.push('SIMILAR_NAME_AND_PHONE');
    }
    if (opts.includeSameName && name !== '' && normalizeSearchText(other.name) === name) signals.push('SAME_NAME');
    if (signals.length) out.push({ id: other.id, signals });
  }
  return out;
}
