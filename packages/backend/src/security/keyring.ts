import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashRaw, hashRawSync } from '@node-rs/argon2';
import { z } from 'zod';
import { DomainError, ErrorCode, normalizeRecoveryPassphrase } from '@airdesk/domain';

/**
 * Key material for encryption at rest (docs/product/encryption-plan.md).
 *
 *  - DK: a random 256-bit data key. It encrypts the database (SQLCipher v4
 *    format via SQLite3 Multiple Ciphers) and every backup made from it.
 *  - Recovery wrap: the DK encrypted with AES-256-GCM under a key derived by
 *    Argon2id from the owner's recovery passphrase (random salt per wrap).
 *    Stored next to the database (airdesk.key), inside the database and in
 *    every backup manifest, so a backup plus its passphrase is always enough.
 *  - Device wrap: the DK protected by the operating system for one Windows
 *    user on one PC (DPAPI via Electron safeStorage) so daily start-up needs
 *    no passphrase. See DeviceKeyStore.
 *
 * No master key, no vendor escrow, nothing derivable from the source code:
 * without the passphrase or a device wrap the DK cannot be recovered.
 */

export interface KdfParams {
  memoryCost: number; // KiB
  timeCost: number;
  parallelism: number;
}

/** ~0.3–0.6 s on an office PC; the salt makes every wrap unique. */
export const PRODUCTION_KDF: KdfParams = { memoryCost: 65_536, timeCost: 3, parallelism: 1 };
/** Tests only: still real Argon2id, just cheap. Never accepted for production wraps (see MIN_KDF). */
export const TEST_KDF: KdfParams = { memoryCost: 1_024, timeCost: 1, parallelism: 1 };

const b64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(512);

export const recoveryWrapSchema = z
  .object({
    format: z.literal(1),
    product: z.literal('AirDesk'),
    /** Identifies the DK (random, not derived from it). */
    keyId: z.string().regex(/^[0-9a-f]{32}$/),
    kdf: z.object({
      alg: z.literal('argon2id'),
      memoryCost: z.number().int().min(1024).max(4_194_304),
      timeCost: z.number().int().min(1).max(20),
      parallelism: z.number().int().min(1).max(16),
      salt: b64,
    }).strict(),
    cipher: z.literal('aes-256-gcm'),
    iv: b64,
    ciphertext: b64,
    tag: b64,
    /** HMAC-SHA256(DK, label): proves a DK is the right one without trying the database. */
    keyCheck: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string().max(40),
  })
  .strict();
export type RecoveryWrap = z.infer<typeof recoveryWrapSchema>;

const AAD = (keyId: string) => Buffer.from(`AirDesk data key v1|${keyId}`, 'utf8');

export function generateDataKey(): Buffer {
  return randomBytes(32);
}

export function newKeyId(): string {
  return randomBytes(16).toString('hex');
}

export function keyCheckOf(dk: Buffer): string {
  return createHmac('sha256', dk).update('AirDesk key check v1').digest('hex');
}

export function matchesKeyCheck(dk: Buffer, keyCheck: string): boolean {
  const a = Buffer.from(keyCheckOf(dk), 'hex');
  const b = Buffer.from(keyCheck, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Sub-keys for other purposes (e.g. sealing backup manifests) never reuse the DK itself. */
export function deriveSubKey(dk: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', dk, Buffer.alloc(0), `AirDesk ${purpose} v1`, 32));
}

const kdfOptions = (kdf: RecoveryWrap['kdf']) => ({
  algorithm: 2 as const, // Argon2id
  memoryCost: kdf.memoryCost,
  timeCost: kdf.timeCost,
  parallelism: kdf.parallelism,
  outputLen: 32,
  salt: Buffer.from(kdf.salt, 'base64'),
});

async function kek(passphrase: string, kdf: RecoveryWrap['kdf']): Promise<Buffer> {
  return hashRaw(normalizeRecoveryPassphrase(passphrase), kdfOptions(kdf));
}

export async function wrapDataKey(dk: Buffer, passphrase: string, keyId: string, params: KdfParams, createdAt: string): Promise<RecoveryWrap> {
  if (dk.length !== 32) throw new Error('data key must be 32 bytes');
  const kdf = { alg: 'argon2id' as const, ...params, salt: randomBytes(16).toString('base64') };
  const key = await kek(passphrase, kdf);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD(keyId));
  const ciphertext = Buffer.concat([cipher.update(dk), cipher.final()]);
  key.fill(0);
  return recoveryWrapSchema.parse({
    format: 1, product: 'AirDesk', keyId, kdf, cipher: 'aes-256-gcm',
    iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    keyCheck: keyCheckOf(dk), createdAt,
  });
}

/** Throws WRONG_PASSPHRASE when the passphrase (or a tampered wrap) does not authenticate. */
export async function unwrapDataKey(wrap: RecoveryWrap, passphrase: string): Promise<Buffer> {
  return openWrap(wrap, await kek(passphrase, wrap.kdf));
}

/** Synchronous variant for the backup worker thread (never call it on the main thread). */
export function unwrapDataKeySync(wrap: RecoveryWrap, passphrase: string): Buffer {
  return openWrap(wrap, hashRawSync(normalizeRecoveryPassphrase(passphrase), kdfOptions(wrap.kdf)));
}

function openWrap(wrap: RecoveryWrap, key: Buffer): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(wrap.iv, 'base64'));
    decipher.setAAD(AAD(wrap.keyId));
    decipher.setAuthTag(Buffer.from(wrap.tag, 'base64'));
    const dk = Buffer.concat([decipher.update(Buffer.from(wrap.ciphertext, 'base64')), decipher.final()]);
    if (dk.length !== 32 || !matchesKeyCheck(dk, wrap.keyCheck)) throw new Error('key check failed');
    return dk;
  } catch {
    throw new DomainError(ErrorCode.WRONG_PASSPHRASE, 'The recovery passphrase is not correct');
  } finally {
    key.fill(0);
  }
}

/** AES-256-GCM seal for small JSON payloads (backup manifest details). */
export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: string; ciphertext: string; tag: string } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv: iv.toString('base64'), ciphertext: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

export function unseal(key: Buffer, sealed: { iv: string; ciphertext: string; tag: string }, aad: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  d.setAAD(aad);
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(sealed.ciphertext, 'base64')), d.final()]);
}

export function parseRecoveryWrap(raw: unknown): RecoveryWrap {
  const r = recoveryWrapSchema.safeParse(raw);
  if (!r.success) throw new DomainError(ErrorCode.KEY_FILE_DAMAGED, 'The encryption key file is damaged or not an AirDesk key file');
  return r.data;
}
