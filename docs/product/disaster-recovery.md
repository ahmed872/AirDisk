# Disaster recovery: restoring AirDesk on a clean PC

For the office owner and whoever installs the replacement PC. Keep a printed copy of this page with the recovery passphrase, in a safe place away from the office PC.

## What you need

1. **The newest backup file** (`AirDesk-….adbk`) from outside the broken PC: a USB drive, another PC, or cloud storage. Copy one off the PC at least weekly: **Backup & restore → Back up now**, then copy the file from `%ProgramData%\AirDesk\data\backups`.
2. **The recovery passphrase** set when the company was set up, or at the last "Change recovery passphrase". A backup opens only with the passphrase that was valid **when that backup was made**.
3. The AirDesk installer, the same version or newer.

Without the passphrase an encrypted backup cannot be opened by anyone. There is no master password and no vendor copy.

## Before you start: write down these reference figures (every week, on paper, with the backup)

So that you can check the restored data, keep with each off-site backup:
- Company name as printed on invoices.
- The number of customers and suppliers: Customers and Suppliers pages, bottom line.
- The balances of 2 known customers and 2 known suppliers.
- The Cash & bank book closing balances.
- Last month's Sales total.

## Procedure on the replacement PC (about 15 minutes)

| # | What to do | What you should see |
|---|---|---|
| 1 | **Install AirDesk.** Run `AirDesk-Setup-<version>-x64.exe` (same version as the old PC or newer). Accept the Windows prompt. | AirDesk opens on the first-run screen. |
| 2 | **Restore the encrypted backup.** Do **not** fill in the company form. Click **Restore a backup instead of setting up a new company** → **Choose file…** → pick the newest `.adbk` from your USB drive or cloud copy. | The backup's date and version, marked "encrypted". |
| 3 | **Enter the recovery passphrase** (from your paper; capital or small letters, dashes optional). Type `RESTORE` and press **Restore**. | After a short wait, the login screen. "Wrong passphrase": this backup was made with an older passphrase, so use the one valid on that date. |
| 4 | **Verify company identity.** Log in with your **usual** user name and password. Open **Company settings**. | Your company name, logo, tax number and address. |
| 5 | **Verify customers.** Open **Customers**. | Same count as on your paper; 2 known customers are found by name or mobile. |
| 6 | **Verify suppliers.** Open **Suppliers**. | Same count; 2 known suppliers present. |
| 7 | **Verify ticket records.** Open **Ticket records**, then the last 3 records. | PNR, ticket numbers, flights and passengers as they were. |
| 8 | **Verify customer balances.** **Reports & statements → Customer statement** for the 2 customers on your paper. | Same closing balance. |
| 9 | **Verify supplier balances.** Supplier statement for the 2 suppliers. | Same closing balance. |
| 10 | **Verify reports.** Run **Sales** for last month and **Cash & bank book** up to the backup date. | Same totals and closing balances as your paper. |
| 11 | **Verify audit integrity.** **Backup & restore → Run integrity check.** | Every line ✔ (database, ledger balanced, audit chain, checkpoints). |
| 12 | **Create a new backup.** **Backup & restore → Back up now.** Copy the new file to the USB drive. | "Backup created" with the file path; the list shows it as succeeded. |
| 13 | **Confirm the new backup can be restored.** On any spare PC (or a test Windows account), repeat steps 1–3 with the NEW file, then log in. | It opens with the same data. The new PC is now protected. |

Anything entered on the old PC after the backup was made is **not** in the restored data. Re-enter it from receipts or paper records. Every other Windows user on the new PC enters the recovery passphrase once at first start.

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

**Not yet performed:** the drill above on a **physical** replacement PC with a **real office backup**. It must be done once before the 1.0.0 release (and once a year after), and the result written below.

### Drill record

| Field | Value |
|---|---|
| Date | |
| Office / backup file name and date | |
| Old PC → new PC (model, Windows build) | |
| Performed by / witnessed by | |
| Steps 1–13 | ☐ all passed · ☐ failed at step __ |
| Differences found (figures that did not match) | |
| Time taken | |
| Result | ☐ PASS ☐ FAIL |
| Signature | |
