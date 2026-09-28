# Encryption at Rest, Keys and Recovery (owner decision Q7)

Status: **driver capability implemented and tested in Phase 1**; key management
and the recovery flow are specified here and implemented in Phase 10, before
any commercial release. Until then, installations run unencrypted.

## 1. What is encrypted

| Asset | Protection |
|---|---|
| Live database `airdesk.db` | SQLCipher v4 format (AES-256) via `better-sqlite3-multiple-ciphers`. Verified in `packages/backend/test/encryption.test.ts`: file header and content are unreadable, wrong or missing key fails to open. |
| Backups `.adbk` | The database inside is the encrypted file itself (same data key); the manifest is authenticated with an HMAC keyed from the data key. |
| Passwords | Argon2id hashes only (never encrypted-reversible, never plaintext). |

## 2. Keys

```
Data key (DK): 32 random bytes, generated once at setup.
   ├─ wrapped by Windows DPAPI (Electron safeStorage)  → dk.dpapi   (daily unlock on this PC)
   └─ wrapped by Recovery Key (RK)                     → dk.recovery (disaster recovery)
RK = Argon2id(recovery passphrase, per-installation salt)   AES-256-GCM wrapping
```

* The DK never leaves the machine in plaintext and is never written to logs.
* DPAPI ties daily unlocking to the Windows machine — copying the database
  file to another PC does not reveal it.
* The **recovery passphrase** is chosen by the Admin at setup, shown once, and
  must be printed/stored by the customer. It is the only way to open the data
  or an encrypted backup on another PC.

## 3. Rules (from Q7)

1. **No hidden master password, no vendor backdoor, no hard-coded recovery
   key.** The application contains no secret that opens customer data.
2. **Lost recovery passphrase + lost PC = data is unrecoverable.** The
   application must not offer any bypass. The setup wizard states this
   explicitly and requires the Admin to confirm they stored the passphrase.
3. Changing the recovery passphrase re-wraps the DK (the database is not
   re-encrypted); it requires the current Admin password.
4. Admin authentication (Argon2id password) is separate from the DK: forgetting
   a password is solved by another Admin or the recovery passphrase flow, never
   by weakening encryption.

## 4. Recovery procedure (to be tested on a clean machine before release)

1. Install AirDesk on the new PC.
2. First-run wizard → **Restore from backup** → choose the `.adbk` file.
3. Enter the recovery passphrase → RK derived → `dk.recovery` from the backup
   manifest unwrapped → DK.
4. Backup validated (hash, integrity, audit chain, trial balance) and restored.
5. DK re-wrapped with this PC's DPAPI. Admin signs in with their password.

Release gate (Phase 10): steps 1–5 executed on a clean Windows VM with a real
backup, and recorded in the release checklist.
