# AirDesk — Installation and Administration Guide

Version 1.0.0-rc.2 · Audience: the person who installs, configures and looks after AirDesk in an office (owner, office manager, IT support). The day-to-day user guide is in Arabic: [user-guide-ar.md](user-guide-ar.md).

> **Scope.** AirDesk records and manages airline-ticket transactions that were booked and issued **outside** the system (GDS, airline portal, consolidator). It does **not** search flights, reserve or hold seats, create PNRs, issue tickets, or connect to any GDS, airline or consolidator system.

## 1. Requirements

| Item | Requirement |
|---|---|
| OS | Windows 10 or 11, 64-bit. (Validated in CI on Windows Server 2025 / 10.0.26100; physical Windows 10/11 is a field-validation item.) |
| Disk | A few hundred MB for the program; the data grows with use (see [performance.md](performance.md) for the size of a 10,000-record database). Backups are compressed. |
| Network | None for core operations. The only internet use is the optional "Open WhatsApp" link, which opens the user's own WhatsApp. |
| Display | Designed and tested at 1366×768 and 1920×1080. |
| Rights | Administrator rights to install (per-machine install). Daily use needs a normal Windows account. |

## 2. Installation

### Interactive
Run `AirDesk-Setup-<version>-x64.exe`, accept the UAC prompt, optionally change the install folder, finish. Shortcuts are created on the desktop and in the Start menu.

### Silent (for IT / mass deployment)
```powershell
# release installers are signed; development builds are named AirDesk-Setup-<version>-UNSIGNED-x64.exe
AirDesk-Setup-<version>-x64.exe /S /allusers
# optional install folder:
AirDesk-Setup-<version>-x64.exe /S /allusers /D=C:\Apps\AirDesk
```

### What goes where
| Item | Location |
|---|---|
| Program | `C:\Program Files\AirDesk` |
| Company database | `%ProgramData%\AirDesk\data\airdesk.db` (+ `-wal`, `-shm`) |
| Backups | `%ProgramData%\AirDesk\data\backups\*.adbk` |
| Backup history | `%ProgramData%\AirDesk\data\backup-history.jsonl` (append-only, survives restores) |
| Logs | `%ProgramData%\AirDesk\data\logs\airdesk-YYYY-MM-DD.log` (kept 14 days) |
| Override | environment variable `AIRDESK_DATA_DIR` (must be a local disk — network/UNC paths are refused) |

The installer grants the local *Users* group modify rights on `%ProgramData%\AirDesk` so every Windows user of the PC works on the same company database.

### Version information
`AirDesk.exe` → Properties → Details shows *Product name: AirDesk*, *File version: <version>*. *Apps & Features* lists **AirDesk <version>** (e.g. 1.0.0-rc.2). In the app: **About**, which also shows the database schema version and every migration applied.

## 3. Uninstall, reinstall, upgrade

- **Uninstall** (Apps & Features, or `"C:\Program Files\AirDesk\Uninstall AirDesk.exe" /S /allusers`) removes the program only. **Company data and backups are never removed.**
- **Reinstall** on the same PC opens the existing data: first-run setup is not offered again, users sign in as before.
- **Upgrade:** install the newer version over the old one. At first start the new version:
  1. takes a verified **pre-migration backup** (it refuses to migrate if the backup fails);
  2. applies the new database migrations in one transaction each;
  3. verifies migration checksums: a database whose applied migration differs from the one shipped refuses to open (it will not guess);
  4. an **older** program refuses to open a database written by a **newer** one (no silent downgrade).
- Migrations so far: `1 initial`, `2 master_data`, `3 operations`, `4 performance_indexes`, `5 ledger_completion`, `6 drop_doc_type_index`, `7 booking_attachments` (ticket files). Upgrading older databases to the current schema is covered by automated tests; every upgrade first makes a verified pre-migration backup.
- Ticket files (PDF/Word/images, ≤ 15 MB each) are stored inside the encrypted database, so the database and backups grow with them (a typical e-ticket PDF is 50–300 KB). "Open" writes a temporary copy to the Windows temp folder, which is deleted when AirDesk closes.

## 4. First run

The first-run screen appears once per database:
1. **Company:** Arabic legal name (required), English name, base currency (any of the 16 seeded currencies: EGP, SAR, AED, KWD, QAR, OMR, BHD, JOD, IQD, LYD, TND, MAD, USD, EUR, GBP, TRY; frozen after the first financial document; the chosen currency is activated automatically), country, time zone, default language.
2. **First Admin:** username, display name, password (≥ 10 characters, not trivially weak). Passwords are stored only as Argon2id hashes.
3. A cash account in the base currency is created automatically.

Then configure (all under the admin menus):
- **Company settings:** trade names, logo, address, phones, email, website, tax and commercial registration numbers, IATA agency code, invoice title and terms, document footer (Arabic/English), date/number format, financial lock date. These appear on every printed document — this is how AirDesk is **white-labelled**; no customer identity is hard-coded.
- **Users & roles:** create one account per person (never share accounts — the audit trail is per user). See [permissions.md](permissions.md).
- **Money accounts, expense categories, currencies and exchange rates** (Payments & finance).
- **Opening balances** for customers, suppliers and cash/bank on the go-live date (Payments & finance → Opening balances).

## 5. Security model (what an administrator should know)

- **Offline, single-PC** deployment; no server, no open network port. (A LAN primary/client mode is designed but not built.)
- **Authentication:** Argon2id password hashes; lockout after 5 failed attempts for 15 minutes; idle session timeout 15 minutes, absolute session 12 hours (configurable). No hidden master password and no vendor back door: a forgotten password is reset by another Admin.
- **Authorization:** enforced in the backend for every command, with row-level scoping (agents see their own records) and field redaction (cost/profit/supplier balances/identity data). Hiding a menu is never the protection.
- **Financial integrity:** posted documents and journal lines are immutable at database level (triggers reject UPDATE/DELETE). Corrections are reversals or adjustments. Balances are never stored — always derived from the journal.
- **Audit trail:** every change, login, export, backup and restore is recorded with user, time and before/after values, in a SHA-256 hash chain verified by *Run integrity check*. Passwords never appear; passport/ID numbers are masked.
- **Electron hardening:** sandboxed renderer, context isolation, no Node in the renderer, strict Content-Security-Policy, no remote content, navigation and new windows blocked (only `wa.me` links open in the external browser), all permission requests denied, Electron fuses (no `RunAsNode`, no inspector, asar integrity validated, app loads only from asar). The renderer's bridge is exactly five functions: `invoke`, `exportPdf`, `exportCsv`, `pickBackupFile`, `openAttachment` (the main process fetches, access-checks and audits the file itself).
- **Exports:** PDF/CSV only through a user-confirmed Save dialog; CSV needs `report.export`; every export is audited; CSV cells cannot run as spreadsheet formulas.
- **Encryption at rest:** the database and every backup are encrypted (AES-256, SQLCipher v4 page format; backups carry sealed, authenticated manifests). New installations are created encrypted; each Windows user who uses AirDesk has the key protected by Windows (DPAPI) so daily start needs no passphrase. The **recovery passphrase** chosen at setup is the only way to open the data on another PC/Windows installation or from a backup — no master password exists. Details: [encryption-plan.md](encryption-plan.md). Still recommended: BitLocker (protects the rest of the disk and deleted-file remnants).
- **Upgrading from 1.0.0-rc.1:** the existing data stays unencrypted until an Admin clicks **Backup & restore → Data encryption → Enable encryption** (Admin password + new recovery passphrase; everyone is signed out; amounts and history are proven identical before the switch). Afterwards delete the old unencrypted backups with **Delete unencrypted backups**.

## 6. Backup and restore

### Automatic backups
- Default: a verified backup every **24 hours**. AirDesk checks at start-up (before anyone is working) and then every 10 minutes, but only runs the backup after **5 minutes without user activity**, so it never interrupts work. The newest **14** automatic backups are kept; older automatic copies are deleted (and the deletion is audited).
- Manual, pre-migration and pre-restore backups are **never** deleted automatically.
- Change or disable in **Backup & restore → Automatic backup → Edit** (needs `settings.system`, Admin by default).
- The app must be running for automatic backups; if it was closed for days, the backup runs on the next start.

### Manual backup
**Backup & restore → Back up now.** A backup is reported successful only after the file was written atomically, re-read, its SHA-256 checked and integrity-checked (SQLite integrity, foreign keys, audit chain, trial balance), on a background worker thread; the window stays usable and shows "Working…". Duration: a few seconds for a typical office database; about 10 s for a very large one (140 MB, 10,000 ticket records) — do not close AirDesk until it finishes. The destination is always an absolute folder path; a failed backup is recorded as FAILED in the history and audit log and leaves no partial file.

### Off-site copies (required practice)
Copy the newest `.adbk` from `%ProgramData%\AirDesk\data\backups` to a USB drive or another location **at least weekly**. A backup on the same disk does not protect against disk failure, theft or ransomware. Backups are encrypted and open only with the recovery passphrase that was valid when they were made; old unencrypted rc.1 backups should be deleted after enabling encryption.

### Restore (same PC)
1. **Backup & restore → Restore → Choose file…** and pick the `.adbk`.
2. Enter **your** password and type `RESTORE`.
3. AirDesk validates the file (refuses a corrupted file or one from a newer version), takes a **pre-restore safety backup** of the current data, swaps the database atomically, and signs everybody out.
4. Sign in again. If power fails during the swap, the next start finishes or rolls back the restore automatically.

### Data recovery on a new PC
Follow [disaster-recovery.md](disaster-recovery.md). In short: install AirDesk → on the first-run screen choose **Restore a backup instead of setting up a new company** → choose the off-site `.adbk` → enter its **recovery passphrase** → type `RESTORE` → sign in with the original users → **Run integrity check** → make a new backup. No temporary company is needed any more. A plain backup from 1.0.0-rc.1 asks for a new recovery passphrase and is encrypted on the way in.

### Restoring a backup protected by another passphrase
A backup made before a passphrase change (or on another installation) asks for **its** recovery passphrase during restore; the restored data is re-encrypted with this installation's key, so the current passphrase keeps working.

### Tested
Automated: scenario L and `encryption-recovery.test.ts` (restore on the same PC, on a clean PC, across keys and passphrases, corrupted/altered/truncated backups, damaged database, lost key file, interrupted restore/encryption, migration), and on Windows in CI with the packaged installer (backup → restore, restart, uninstall + reinstall, upgrade from rc.1, clean-PC recovery). Not yet done: the physical drill in [disaster-recovery.md](disaster-recovery.md).

### Backup speed
Backup verification, compression, re-encryption and the full integrity check run on a background worker thread; the window stays responsive (regression test `backup-worker.test.ts`). Encrypted backups are stored uncompressed (encrypted data does not compress): expect a backup file about the size of the database (a typical office: 10–40 MB; the 10,000-record test office: 140 MB). Keep 14 automatic backups × that size free on the disk.

## 7. Maintenance

- **Integrity check:** run monthly or after any disk problem (Backup & restore → Run integrity check). All items must be ✔.
- **Financial lock date:** set in Company settings after closing a month; documents dated on or before it are refused.
- **Exchange rates:** enter a rate for each foreign currency on the days you transact; AirDesk never assumes a rate of 1.
- **Logs:** `%ProgramData%\AirDesk\data\logs`. They contain technical errors, never passwords.

## 8. Troubleshooting

| Symptom | What to do |
|---|---|
| "AirDesk could not open its database" at start | Read the newest log file. Common causes: disk full; the data folder moved to a network drive (not allowed); database from a newer version (install the newer version). If the file is damaged, restore the newest backup (§6). |
| A second window does not open | AirDesk runs once per PC session; the running window is brought to the front. |
| "This database was created by a newer version of AirDesk" | Install the same or a newer AirDesk version. |
| AirDesk asks for the **recovery passphrase** at start | Normal after reinstalling Windows, on another Windows account, or on a new PC: enter it once. If the key file is reported missing/damaged, choose **Read the key from a backup file**. |
| "Wrong recovery passphrase" / wait message | Check caps and keyboard layout (the passphrase uses Latin letters). Backups need the passphrase valid when they were made. After repeated failures AirDesk waits up to 30 s between attempts. |
| "The database file is damaged" at start | Restore the newest backup from that screen; the damaged file is kept as `airdesk.db.pre-restore-…`. |
| "Migration N (name) does not match this build" | The database was written by an unofficial or modified build. Restore a backup made by an official build; contact support. |
| Restore refused "an automatic backup is running" | Wait a minute and try again. |
| User locked out | Wait 15 minutes or an Admin unlocks the user in Users & roles. |
| Last Admin forgot the password | There is no back door. Restore a backup made while another Admin existed, or recover from the pre-restore/automatic backups. Always keep two Admin accounts. |
| Printing: Arabic text or layout wrong in PDF | Use **Save PDF** from the print preview (Chromium engine); make sure the Windows display language pack for Arabic is installed for the printer driver's own dialogs. |
| WhatsApp button does nothing | WhatsApp Desktop or a browser must be installed; AirDesk only opens a `wa.me` link — it never sends messages itself. |

## 9. Support information to collect

About dialog (app and schema version), the newest log file, the backup history file, and the output of *Run integrity check*.
