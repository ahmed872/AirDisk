# Encryption at rest and recovery (implemented in 1.0.0-rc.2)

AirDesk encrypts the company database and every backup. This page explains what is protected, how the keys work, and what happens when something is lost. The owner-facing procedure is in [disaster-recovery.md](disaster-recovery.md).

## 1. What is protected

| Item | Protection |
|---|---|
| Database `%ProgramData%\AirDesk\data\airdesk.db` (+ `-wal`) | SQLCipher v4 page format through SQLite3 Multiple Ciphers 2.4.0: AES-256 per page with HMAC-SHA512 page authentication. Without the key the file is random bytes, and a modified page is refused. |
| Backups `*.adbk` (format 2) | They contain the encrypted database file as it is. The manifest reveals only product, version, schema, date, kind and size. Company name, counts, trial balance and audit head are sealed with AES-256-GCM under a sub-key of the data key. The seal authenticates every public field and the key wrap. |
| Key file `airdesk.key` | Holds only the recovery wrap (see §2); useless without the passphrase. |
| Working copies (snapshots, restore/encryption temp files) | Same key as the live database. Temporary files are deleted after use. |

**Not protected:**
- The application log does not contain customer data.
- `backup-history.jsonl` holds file names, dates, hashes and audit-chain checkpoints only.
- Printed or exported PDF/CSV files, once the user saves them somewhere.
- Data in memory while AirDesk is open.

Encryption does not replace BitLocker. It protects the files. BitLocker also protects the rest of the disk, including anything left behind when files are deleted.

## 2. Keys

- **Data key (DK).** 256 random bits, generated when the company is set up (or when encryption is enabled on 1.0.0-rc.1 data). It encrypts the database and all its backups. It never leaves the AirDesk process except to its backup worker thread. It is never logged and never sent to the window.
- **Recovery wrap.** The DK encrypted with AES-256-GCM under a key derived by Argon2id from the recovery passphrase:
  - 64 MiB memory, t = 3;
  - a random salt per wrap;
  - authenticated data includes the key id.

  Three identical copies of the wrap exist:
  1. `airdesk.key` next to the database;
  2. inside the database (setting `security.recovery_wrap`), so a deleted key file is rebuilt;
  3. inside every backup manifest, so a backup plus its passphrase is always enough.
- **Device copy.** The DK protected by Windows DPAPI for the current Windows user, through Electron `safeStorage`. It is stored in that user's profile at `%APPDATA%\AirDesk\device-keys\<keyId>.key`. Daily start-up therefore needs no passphrase.
  - Another Windows user, a reinstalled Windows, or another PC cannot open the device copy, and gets the **Unlock** screen instead (passphrase once, then remembered for that user).
  - On Linux without a keyring, Electron's fallback (`basic_text`) is not real protection. There, the passphrase is asked at every start.
- **No master key, no vendor escrow.** Nothing in the source code or the installer can open a company's data.

## 3. Recovery passphrase

- Set at first-run setup. It is mandatory: new installations cannot be created unencrypted.
- The owner can type their own passphrase (at least 12 characters, not trivial) or let AirDesk generate one.
  - A generated passphrase has 25 characters from an alphabet without look-alike characters, about 122 bits of entropy.
  - It is accepted in any letter case, with or without dashes, and with Arabic-Indic digits.
- The owner types it twice and ticks "I have written it down".
- It can be changed later (**Backup & restore → Data encryption → Change recovery passphrase**, Admin password required, audited). The DK stays the same.
  - Backups made **before** the change still open only with the passphrase that was valid when they were made.
  - A new backup is made immediately after the change.
- Wrong passphrases are slowed down: 2 s per failure, at most 30 s, on top of Argon2id's cost.

**If the passphrase is lost:**
- The data stays usable on every Windows account that still opens it automatically. Set a new passphrase from there immediately.
- If no such account exists (disk moved, Windows reinstalled, PC replaced) and the passphrase is lost, the data and its backups **cannot be recovered by anyone**, including the vendor. This is intentional: any recovery path would also be a way in for a thief.

## 4. Start-up states

| State | When | What the user sees |
|---|---|---|
| NEW | No database in the data folder | First-run setup (company + admin + recovery passphrase), or **Restore a backup instead** for a replacement PC |
| LOCKED `PASSPHRASE_REQUIRED` | Encrypted data, no device copy for this Windows user | Unlock with the recovery passphrase (or restore a backup) |
| LOCKED `KEY_FILE_MISSING` / `KEY_FILE_DAMAGED` | `airdesk.key` deleted or corrupted and no device copy | Unlock by choosing any recent backup to read the key from + passphrase |
| LOCKED `DATABASE_DAMAGED` | The right key does not open the file (or it is corrupted) | Restore a backup. The damaged file is moved aside, never deleted. |
| READY | Unlocked | Login |

## 5. Upgrading 1.0.0-rc.1 installations (unencrypted)

After installing the new version over rc.1:
- The data opens as before. Nothing is migrated automatically.
- Admins see a red "data is NOT encrypted" notice and an **Enable encryption** button (Admin password + new recovery passphrase).

The operation:
1. Signs everyone out and refuses other commands.
2. Encrypts a consistent copy on the worker thread and proves it identical before switching: schema and migrations, document count, trial balance, audit-chain head, full integrity check, and the file no longer opens without the key.
3. Stages the key, swaps the files crash-safely, and deletes the plain database file.
4. Makes an encrypted backup.

Old unencrypted backup files are counted and can be deleted with **Delete unencrypted backups** (Admin password + typing `DELETE`, audited).

Tested:
- `encryption-recovery.test.ts` (amounts, documents, balances, summary, migration records and audit chain identical);
- Windows CI, with the real 1.0.0-rc.1 installer upgraded in place.

## 6. Crash safety

Every database swap (restore, encryption, restore onto a new PC) uses a marker file plus a staged key file (`airdesk.key.incoming`). At the next start AppLauncher either finishes the operation, promoting the staged key, or rolls it back, discarding the staged key. If the incoming database's key is not available on this Windows user, the marker waits until the passphrase is entered. A replaced key file is kept (`airdesk.key.replaced-*`) next to the database file it belongs to.

## 7. Audit trail and the key

The audit log is a SHA-256 hash chain (unchanged; existing history keeps verifying). The pre-release audit asked whether the chain should be keyed with the data key (HMAC). It was **not** changed, for these reasons:
- To modify an encrypted database at all, an attacker already needs the data key. With it they could recompute a keyed chain just as easily, so keying adds no protection against the only party able to tamper.
- Without the key, SQLCipher's per-page HMAC-SHA512 already rejects any modification.
- Re-keying the chain would have required rewriting or bridging existing history.

What was added instead, because it does detect tampering that a chain cannot:
- **Tail check (`INV-9.audit_tail`):** records removed from the end of the log are detected through SQLite's AUTOINCREMENT counter.
- **External anchors (`INV-9.audit_anchors`):** every successful backup and every restore records the chain head (sequence and hash) in `backup-history.jsonl`, outside the database and in the backup manifest. The integrity check verifies that the log still contains every anchor recorded since the last restore. Rewriting history before an anchor therefore also requires editing that file.

Tests cover modified, deleted, reordered and re-hashed records, modified metadata, tail truncation, anchors after restart and restore, and encrypted/decrypted databases (`audit-tamper.test.ts`).

## 8. Verified library behaviour (better-sqlite3-multiple-ciphers 12 / SQLite3MC 2.4.0 / SQLite 3.53.4)

| Operation | Result, and how AirDesk uses it |
|---|---|
| Open with `cipher='sqlcipher'`, `legacy=4`, `hexkey` | ✔ used for every connection |
| `PRAGMA hexrekey` (plain→encrypted, key→key) | ✔ used only on private working copies (encryption, restore into this installation's key) |
| Online backup API with an encrypted source | ✘ refused by the library. AirDesk snapshots by checkpoint (TRUNCATE) + pausing automatic checkpoints + asynchronous file copy of the encrypted file. |
| `serialize()` of an encrypted database | returns a **plaintext** image. Never used by AirDesk. |
| Worker thread loading the native module from the asar archive | ✔ (verified in a packaged Electron app on Linux, and in Windows CI) |
| Page-level corruption | reported as SQLITE_CORRUPT. Page 1 corruption: SQLITE_NOTADB. AirDesk distinguishes it from a wrong key through the key check in the wrap. |
