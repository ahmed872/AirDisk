import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase, runMigrations } from '../src';
import { tempDir } from './helpers';

/**
 * Q7 foundation: the chosen driver encrypts at rest (SQLCipher v4 format).
 * Key management / recovery is specified in docs/phase-1 and enabled in Phase 10.
 */
describe('encryption at rest (driver capability)', () => {
  it('an encrypted database is unreadable without the right key', () => {
    const path = join(tempDir(), 'enc.db');
    const key = randomBytes(32);
    const db = openDatabase({ path, encryptionKey: key });
    runMigrations(db, MIGRATIONS, { appVersion: 't', now: () => 'now' });
    db.exec(`INSERT INTO currency (code, name_ar, name_en, minor_unit) VALUES ('EGP', 'جنيه', 'Egyptian Pound Secret Marker', 2)`);
    db.close();

    const header = readFileSync(path).subarray(0, 16).toString('latin1');
    expect(header).not.toBe('SQLite format 3\u0000');
    expect(readFileSync(path).includes(Buffer.from('Secret Marker'))).toBe(false);

    const reopened = openDatabase({ path, encryptionKey: key });
    expect((reopened.prepare('SELECT name_en FROM currency').get() as { name_en: string }).name_en).toContain('Secret Marker');
    reopened.close();

    expect(() => openDatabase({ path })).toThrow();
    expect(() => openDatabase({ path, encryptionKey: randomBytes(32) })).toThrow();
  });
});
