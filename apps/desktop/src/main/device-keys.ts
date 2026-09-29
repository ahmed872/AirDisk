import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import type { DeviceKeyStore } from '@airdesk/backend';

const KEY_ID = /^[0-9a-f]{32}$/;

/**
 * The data key protected by the operating system for the CURRENT Windows user
 * (DPAPI through Electron safeStorage), stored in that user's profile
 * (%APPDATA%\AirDesk\device-keys). Another Windows user, a reinstalled Windows
 * or another PC cannot decrypt it and is asked for the recovery passphrase.
 * On Linux without a keyring safeStorage falls back to a fixed key
 * ('basic_text'); that is NOT protection, so the store reports itself
 * unavailable there and the passphrase is asked at every start.
 */
export function createDeviceKeyStore(dir: string): DeviceKeyStore {
  const available = (): boolean => {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch {
      return false;
    }
  };
  const file = (keyId: string) => {
    if (!KEY_ID.test(keyId)) throw new Error('invalid key id');
    return join(dir, `${keyId}.key`);
  };
  return {
    kind: process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : 'os-keyring',
    isAvailable: available,
    load(keyId) {
      const p = file(keyId);
      if (!available() || !existsSync(p)) return null;
      const b64 = safeStorage.decryptString(readFileSync(p));
      const dk = Buffer.from(b64, 'base64');
      return dk.length === 32 ? dk : null;
    },
    save(keyId, dk) {
      if (!available()) return;
      mkdirSync(dir, { recursive: true });
      const p = file(keyId);
      writeFileSync(`${p}.tmp`, safeStorage.encryptString(dk.toString('base64')));
      renameSync(`${p}.tmp`, p);
    },
    forget(keyId) {
      rmSync(file(keyId), { force: true });
    },
    list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((f) => f.endsWith('.key')).map((f) => f.slice(0, -4)).filter((id) => KEY_ID.test(id));
    },
  };
}
