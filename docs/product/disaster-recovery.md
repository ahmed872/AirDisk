# Disaster recovery: restoring AirDesk on a clean PC

For the office owner and whoever installs the replacement PC. Keep a printed copy of this page with the recovery passphrase, in a safe place away from the office PC.

## What you need

1. **The newest backup file** (`AirDesk-….adbk`) from outside the broken PC: a USB drive, another PC, or cloud storage. Copy one off the PC at least weekly: **Backup & restore → Back up now**, then copy the file from `%ProgramData%\AirDesk\data\backups`.
2. **The recovery passphrase** set when the company was set up, or at the last "Change recovery passphrase". A backup opens only with the passphrase that was valid **when that backup was made**.
3. The AirDesk installer, the same version or newer.

Without the passphrase an encrypted backup cannot be opened by anyone. There is no master password and no vendor copy.

## Procedure (about 10 minutes)

| # | Step | How to check it |
|---|---|---|
| 1 | Install AirDesk on the new PC (double-click the installer, or `AirDesk-Setup-x.y.z-x64.exe /S /allusers`). | AirDesk opens on the first-run screen. |
| 2 | On the first-run screen choose **Restore a backup instead of setting up a new company**. Do **not** create a new company. | The "Restore the company data from a backup" screen appears. |
| 3 | **Choose file…**, select the `.adbk`. | AirDesk shows the backup's date, version and "encrypted". |
| 4 | Type the **recovery passphrase** (any letter case; dashes optional for a generated one), type `RESTORE`, press **Restore**. | "Wrong passphrase" means this backup was made with another passphrase: try the one valid at that date. |
| 5 | AirDesk checks the backup before using it: checksum, sealed manifest, page authentication, SQLite integrity, foreign keys, audit chain, trial balance. | A damaged or altered file is refused and nothing is written. |
| 6 | The login screen appears. Sign in with the **original** user name and password (not a new one). | The login works. |
| 7 | **Backup & restore → Run integrity check.** | Every line shows ✔ (database, ledger balanced, audit chain, checkpoints). |
| 8 | Customers: search for 2–3 known customers. | Found, with their details. |
| 9 | Suppliers: open 1–2 suppliers; check their statement. | Balances as expected. |
| 10 | Ticket records: open the last few records (PNR, ticket numbers, flights). | Present and unchanged. |
| 11 | Payments: open a recent record and check Total / Paid / Remaining; **Payments & finance → Treasury** for cash and bank balances. | Match the last known figures. |
| 12 | Reports: run the Sales and Cash & bank book reports for the current month. | Totals match the last known figures. |
| 13 | Log in once as each other user who works on this PC. | Each can sign in; each Windows user enters the recovery passphrase once if AirDesk asks. |
| 14 | **Backup & restore → Back up now**, then copy the new file off the PC. | The backup succeeds and says "encrypted". |

Anything entered after the backup was made is **not** in the restored data. Re-enter it from paper records or receipts.

## Other situations

| Situation | What to do |
|---|---|
| Windows was reinstalled on the same PC; the data folder survived | Start AirDesk → **Unlock** screen → recovery passphrase. Nothing else changes. |
| Another Windows user on the same PC | Enter the recovery passphrase once; after that AirDesk opens automatically for that user. |
| `airdesk.key` was deleted and AirDesk asks for a key | **Read the key from a backup file** → choose any recent backup → recovery passphrase. |
| "The database file is damaged" | Restore the newest backup from that screen. The damaged file is moved aside as `airdesk.db.pre-restore-…`, not deleted. |
| The passphrase is lost but AirDesk still opens on some Windows account | Sign in as an Admin there → **Backup & restore → Data encryption → Change recovery passphrase** → make a new backup and copy it off the PC. Older backups still need the old passphrase. |
| The passphrase is lost and no PC opens the data | The data cannot be recovered. |

## What is verified automatically, and what is not

**Automated, on every change:**
- `packages/backend/test/encryption-recovery.test.ts`: clean-PC restore from an off-site encrypted backup, then original logins, customers, suppliers, ticket records with Total/Paid/Remaining, reports, trial balance, integrity/audit/anchor checks, and future backups. Also wrong passphrase, corrupted, altered or truncated backups, damaged database, lost key file, interrupted restore, and migration.
- A full month of mixed activity reports identical amounts before encryption, after encryption, and after recovery.
- Windows CI, on the packaged installer: seed data → encrypted off-site backup → uninstall → delete `%ProgramData%\AirDesk` **and** the Windows user's device key (a clean machine) → reinstall → `--smoke-phase=recover` with the backup and passphrase → verify logins, records, balances, reports, integrity, a new backup, and that no customer or ticket data is readable on disk.

**Not yet performed:** the drill above on a **physical** replacement PC with a **real office backup**. It must be done once before general release (and once a year after), with the result recorded below.

| Date | Office / backup date | PC / Windows version | Duration | Result | By |
|---|---|---|---|---|---|
| — | — | — | — | not yet performed | — |
