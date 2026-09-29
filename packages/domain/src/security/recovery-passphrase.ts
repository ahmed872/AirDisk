import { DomainError, ErrorCode } from '../errors';
import { normalizeDigits } from '../text/digits';

/**
 * Recovery passphrase rules (docs/product/encryption-plan.md).
 *
 * The recovery passphrase is the ONLY way to open the company data on another
 * PC, after reinstalling Windows, or from an off-site backup. There is no
 * master key and no vendor copy: if it is lost and no PC can still open the
 * data automatically, the data cannot be recovered.
 *
 * AirDesk can generate one (25 characters from an alphabet without look-alike
 * characters, ~122 bits) or the owner can choose their own (at least 12
 * characters). Generated passphrases are accepted in any letter case, with or
 * without dashes/spaces, and with Arabic-Indic digits.
 */
export const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_GROUPS = 5;
export const RECOVERY_GROUP_SIZE = 5;
export const RECOVERY_PASSPHRASE_MIN_LENGTH = 12;
export const RECOVERY_PASSPHRASE_MAX_LENGTH = 200;

const GENERATED_LENGTH = RECOVERY_GROUPS * RECOVERY_GROUP_SIZE;
const GENERATED_RE = new RegExp(`^[${RECOVERY_ALPHABET}]{${GENERATED_LENGTH}}$`);

/**
 * Formats random bytes as a recovery passphrase `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`.
 * Unbiased: bytes ≥ 240 are skipped (240 = 8 × 30), so pass at least 40 bytes;
 * the caller supplies the randomness (Node crypto or window.crypto).
 */
export function formatRecoveryPassphrase(randomBytes: Uint8Array): string {
  const limit = Math.floor(256 / RECOVERY_ALPHABET.length) * RECOVERY_ALPHABET.length;
  let chars = '';
  for (const b of randomBytes) {
    if (b >= limit) continue;
    chars += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    if (chars.length === GENERATED_LENGTH) break;
  }
  if (chars.length < GENERATED_LENGTH) throw new Error('not enough random bytes for a recovery passphrase');
  return chars.match(new RegExp(`.{${RECOVERY_GROUP_SIZE}}`, 'g'))!.join('-');
}

/**
 * Canonical form used for key derivation. A generated passphrase typed in
 * lower case, without dashes or with spaces normalises to its printed form;
 * any other passphrase is used exactly as typed (Unicode NFKC, trimmed,
 * internal whitespace collapsed).
 */
export function normalizeRecoveryPassphrase(input: string): string {
  const text = normalizeDigits(input.normalize('NFKC')).trim().replace(/\s+/g, ' ');
  const compact = text.replace(/[\s-]/g, '').toUpperCase();
  if (GENERATED_RE.test(compact)) return compact.match(new RegExp(`.{${RECOVERY_GROUP_SIZE}}`, 'g'))!.join('-');
  return text;
}

export type RecoveryPassphraseIssue = 'TOO_SHORT' | 'TOO_LONG' | 'TOO_SIMPLE' | 'MISMATCH';

/** Returns the first problem with a new recovery passphrase (and its confirmation), or null. */
export function recoveryPassphraseIssue(passphrase: string, confirmation?: string): RecoveryPassphraseIssue | null {
  const p = normalizeRecoveryPassphrase(passphrase);
  if (p.length < RECOVERY_PASSPHRASE_MIN_LENGTH) return 'TOO_SHORT';
  if (p.length > RECOVERY_PASSPHRASE_MAX_LENGTH) return 'TOO_LONG';
  if (new Set(p.toLowerCase().replace(/[\s-]/g, '')).size < 5) return 'TOO_SIMPLE';
  if (/^(.)\1+$/.test(p) || /^(0123456789|1234567890|abcdefghijkl|qwertyuiop)/i.test(p)) return 'TOO_SIMPLE';
  if (confirmation !== undefined && normalizeRecoveryPassphrase(confirmation) !== p) return 'MISMATCH';
  return null;
}

export function assertRecoveryPassphrase(passphrase: string, confirmation?: string): string {
  const issue = recoveryPassphraseIssue(passphrase, confirmation);
  if (issue) throw new DomainError(ErrorCode.PASSPHRASE_POLICY, `Recovery passphrase rejected: ${issue}`, { reason: issue });
  return normalizeRecoveryPassphrase(passphrase);
}
