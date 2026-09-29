# Encryption at rest — status and required implementation

**Status in 1.0.0-rc.1:** not enabled. The database (`%ProgramData%\AirDesk\data\airdesk.db`) and backup files (`*.adbk`) are protected only by Windows file permissions; the installer gives the local *Users* group modify rights on the data folder so every Windows user of the PC can open AirDesk. Anyone with access to the PC's disk or to a backup file can read customer data, passport numbers (when entered) and financial records. **Release blocker for general sale.** Interim mitigation for pilots: BitLocker on the PC, password-protected Windows accounts, off-site backup copies stored as confidential.

The key design is in [docs/phase-1/encryption-and-keys.md](../phase-1/encryption-and-keys.md). This page records what the pre-release audit **verified about the SQLite library** and the exact work needed.

## 1. Verified library behaviour (better-sqlite3-multiple-ciphers, SQLCipher v4 mode)

| Operation | Result |
|---|---|
| Open with `cipher='sqlcipher'`, `legacy=4`, `hexkey=…` | ✔ file header and content are unreadable without the key (tested in `packages/backend/test/encryption.test.ts`) |
| `PRAGMA rekey` on an existing plain database | ✔ encrypts in place |
| `ATTACH DATABASE … KEY '…'` | ✔ works |
| Online backup API (`db.backup`) from an encrypted database to a new file | ✘ **refused** ("backup is not supported with incompatible source and target databases") — no plaintext leak, but today's backup code cannot be reused as is |
| `VACUUM INTO 'file:…?cipher=…&hexkey=…'` | ✘ URI filenames are not enabled in this build |

## 2. Required implementation (in this order)

1. **Key material.**
   - A 32-byte data key (DK) is generated when encryption is enabled.
   - The DK is wrapped twice:
     - `dk.dpapi`: Electron `safeStorage` (Windows DPAPI, machine and user scope), for daily unlock;
     - `dk.recovery`: AES-256-GCM with a key derived by Argon2id from a **recovery passphrase** chosen by the Admin, with a per-installation salt.
   - The DK is never written unwrapped, never logged, and never sent to the renderer.
2. **Unlock at start.** The main process unwraps `dk.dpapi` and passes it to `AppBackend.open({ encryptionKey })`; the backend already supports this. If DPAPI fails (Windows reinstalled, profile lost), the app shows an **Unlock with recovery passphrase** screen before the backend opens. It must never offer a bypass.
3. **Enable on an existing installation.**
   1. Take a verified plain backup.
   2. Run `PRAGMA rekey` inside a crash-safe step, with a marker file like the restore marker.
   3. Verify the result: integrity, trial balance, audit chain.
   4. Only then delete the plain backup, or keep it if the Admin chooses.
4. **Backups of an encrypted database.**
   - Snapshot by `wal_checkpoint(TRUNCATE)` followed immediately by a synchronous file copy of the encrypted main file. In the single-process app nothing can write in between.
   - The manifest carries `encrypted: true`, the recovery-wrapped DK and an HMAC keyed from the DK.
   - Validation opens the copy with the DK.
5. **Restore.**
   - Same installation: DK from DPAPI.
   - Backup from another installation, or a new PC: the passphrase unwraps the backup's DK. After restore, the DK is re-wrapped with this PC's DPAPI.
   - First-run screen gets **Restore from backup (with recovery passphrase)**, so a new PC does not need a temporary company first.
6. **Change the recovery passphrase:** re-wraps the DK only (no re-encryption), requires the Admin password, and is audited.
7. **Tests:**
   - unit: wrap/unwrap, wrong passphrase, tampered wrap;
   - integration: enable → work → backup → restore on a "new machine" → wrong passphrase refused;
   - Windows CI: packaged app with real DPAPI;
   - a documented clean-VM recovery drill.

## 3. Why it is not in 1.0.0-rc.1

It changes start-up (unlock screen), first-run (restore with passphrase), backup and restore formats, and adds a key-loss failure mode in which data becomes permanently unreadable. It needs physical Windows validation (DPAPI across user profiles, Windows reinstall) and a recovery drill before real offices depend on it. Shipping it inside a hardening pass without that validation would risk exactly the data loss it is meant to prevent.
