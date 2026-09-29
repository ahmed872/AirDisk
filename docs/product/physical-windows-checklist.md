# Physical Windows 10 / 11 release checklist

**Status: NOT YET EXECUTED.** Nothing in this sheet has been performed. CI runs on `windows-latest`, which is a Windows Server VM with no interactive desktop, no antivirus policy, no printer and no second user. This sheet covers what that cannot prove.

**How to use it:**
- Print it or copy it into a spreadsheet.
- Run every line on one physical **Windows 10 22H2** PC and one physical **Windows 11 23H2 or newer** PC.
- Tick **PASS**, **FAIL** or **N/A**, and write the issue in **Notes** for every FAIL.
- The release may be tagged `1.0.0` only when both sheets have no FAIL, or every FAIL is fixed and re-tested.

Each sheet header: tester · date · PC model · Windows build (`winver`) · antivirus · printer · installer file name · SHA-256.

## Windows 10 (22H2)

| # | Check | Expected result | PASS | FAIL | N/A | Notes |
|---|---|---|:-:|:-:|:-:|---|
| | **Before you start** | | | | | |
| 1 | Record: PC model, Windows edition and build (`winver`), screen resolution, antivirus product, printer model | Written in the header of this sheet | ☐ | ☐ | ☐ | |
| 2 | Have ready: the SIGNED installer + `SHA256SUMS.txt`, a USB drive, a second standard Windows account, a copy of 1.0.0-rc.1 installer and some rc.1 test data (for the upgrade test) | All present | ☐ | ☐ | ☐ | |
| | **Clean install** | | | | | |
| 3 | Check the installer hash: `Get-FileHash .\AirDesk-Setup-<version>-x64.exe` equals the line in SHA256SUMS.txt | Hashes identical | ☐ | ☐ | ☐ | |
| 4 | Right-click installer → Properties → Digital Signatures | Publisher name shown, signature OK, timestamp present | ☐ | ☐ | ☐ | |
| 5 | SmartScreen when double-clicking the downloaded installer | No 'Unknown publisher' (an OV certificate may still show a reputation warning — write the exact text) | ☐ | ☐ | ☐ | |
| 6 | UAC prompt | Shows the verified publisher (not 'Unknown') | ☐ | ☐ | ☐ | |
| 7 | Defender / office antivirus during install and first start | Nothing quarantined or blocked (check Protection history) | ☐ | ☐ | ☐ | |
| 8 | Start menu + desktop shortcut; Apps & Features entry | Both open AirDesk; version and publisher correct | ☐ | ☐ | ☐ | |
| 9 | First start on a clean PC | First-run screen appears; no `airdesk.db` exists in `%ProgramData%\AirDesk\data` until setup is finished | ☐ | ☐ | ☐ | |
| | **First setup, encryption, login** | | | | | |
| 10 | Complete setup: company, admin, press 'Generate a strong passphrase', write it on paper, type it again in the confirmation, tick the checkbox | Setup finishes; login screen appears | ☐ | ☐ | ☐ | |
| 11 | Open `%ProgramData%\AirDesk\data\airdesk.db` in Notepad and search for the company name | Not found (unreadable bytes) | ☐ | ☐ | ☐ | |
| 12 | Log in with the admin account | Dashboard appears | ☐ | ☐ | ☐ | |
| 13 | Backup & restore page → Data encryption | 'Data and backups are encrypted'; 'This Windows user opens the data automatically' | ☐ | ☐ | ☐ | |
| | **Language, keyboard, display** | | | | | |
| 14 | Arabic keyboard layout: create a customer with an Arabic name and mobile typed with Arabic-Indic digits (٠١٠…) | Saved correctly; no cursor jumps inside dialogs | ☐ | ☐ | ☐ | |
| 15 | Record an existing ticket: PNR (Latin), ticket number with Arabic-Indic digits, flight, supplier, price, cost; Confirm ticketed | Saved; Total/Paid/Remaining correct | ☐ | ☐ | ☐ | |
| 16 | Arabic RTL: login, setup, ticket record, payments, reports, backup page | Right-to-left, nothing cut off | ☐ | ☐ | ☐ | |
| 17 | English LTR (language button): same pages | Left-to-right, nothing cut off | ☐ | ☐ | ☐ | |
| 18 | 1366×768 at 100 % scaling: dashboard, ticket record, payments, reports | No horizontal scrolling; dialogs fit | ☐ | ☐ | ☐ | |
| 19 | 1920×1080 at 100 %, 125 %, 150 % scaling | Text sharp; nothing cut off | ☐ | ☐ | ☐ | |
| 20 | Type the recovery passphrase while the Arabic layout is active | Note what happens (passphrase uses Latin letters; switching layout must be obvious to the user) | ☐ | ☐ | ☐ | |
| | **Daily workflow** | | | | | |
| 21 | Customer payment on the ticket record; supplier payment | Receipts print; balances update | ☐ | ☐ | ☐ | |
| 22 | Reissue (date change with change fee) | New ticket number recorded; amounts correct | ☐ | ☐ | ☐ | |
| 23 | Cancellation / refund: supplier result + customer result | Documents created; statements correct | ☐ | ☐ | ☐ | |
| 24 | Schedule change + customer notification (WhatsApp link opens) | Status recorded | ☐ | ☐ | ☐ | |
| 25 | Reports: Sales, Profit, Cash & bank book for this month | Figures match the entries made | ☐ | ☐ | ☐ | |
| | **Printing and PDF** | | | | | |
| 26 | Print a receipt, an invoice and a customer statement on the office printer (A4) | Arabic shaping, numbers and logo correct | ☐ | ☐ | ☐ | |
| 27 | Save a statement as PDF and open it in Edge/Acrobat | Opens; Arabic correct | ☐ | ☐ | ☐ | |
| | **Users and permissions** | | | | | |
| 28 | Sign in to Windows as a STANDARD (non-admin) user; open AirDesk | Unlock screen asks for the recovery passphrase once; after that it opens | ☐ | ☐ | ☐ | |
| 29 | As that standard user: work, back up | No permission errors | ☐ | ☐ | ☐ | |
| 30 | A second Windows user on the same PC | Asked for the passphrase once, then opens automatically for that user | ☐ | ☐ | ☐ | |
| | **Backup and restore** | | | | | |
| 31 | Back up now (default folder) and to a USB drive | 'Working…' shown; the window stays responsive; success message with file path | ☐ | ☐ | ☐ | |
| 32 | Leave AirDesk idle 5+ minutes (backup older than 24 h, or set interval to 1 h) | Automatic backup appears in the list; typing was never interrupted | ☐ | ☐ | ☐ | |
| 33 | Open the .adbk in Notepad; search for a customer name | Not found | ☐ | ☐ | ☐ | |
| 34 | Restore the backup from the USB (your password + RESTORE) | Everyone signed out; data identical after sign-in | ☐ | ☐ | ☐ | |
| | **Upgrade, uninstall, reinstall** | | | | | |
| 35 | On a PC with 1.0.0-rc.1 and pilot data: install the new version over it | Data opens; red 'NOT encrypted' notice for admins | ☐ | ☐ | ☐ | |
| 36 | Enable encryption (admin password + new recovery passphrase) | Everyone signed out; data identical; database now unreadable in Notepad | ☐ | ☐ | ☐ | |
| 37 | Delete unencrypted backups | Old plain backups removed | ☐ | ☐ | ☐ | |
| 38 | Uninstall (Apps & Features) | Program removed; `%ProgramData%\AirDesk` kept | ☐ | ☐ | ☐ | |
| 39 | Reinstall | No setup screen; opens without passphrase for the same Windows user; data intact | ☐ | ☐ | ☐ | |
| | **Recovery** | | | | | |
| 40 | Rename `%ProgramData%\AirDesk\data\airdesk.key`, start AirDesk as a user that has never opened it | 'Key file missing'; 'Read the key from a backup file' + passphrase opens the data | ☐ | ☐ | ☐ | |
| 41 | Wrong passphrase three times | Wait message appears; then the right passphrase works | ☐ | ☐ | ☐ | |
| 42 | Clean-PC drill ([disaster-recovery.md](disaster-recovery.md)) on a second PC | All 13 checks pass | ☐ | ☐ | ☐ | |
| | **Power and shutdown** | | | | | |
| 43 | Sleep and hibernate with AirDesk open, then resume | Works; session rules respected | ☐ | ☐ | ☐ | |
| 44 | Normal Windows shutdown with AirDesk open | Next start opens normally; integrity check ✔ | ☐ | ☐ | ☐ | |
| 45 | Power-loss simulation: hold the power button during normal work (not during a restore) | Next start opens; integrity check ✔; only the last unsaved entry may be missing | ☐ | ☐ | ☐ | |
| 46 | Power loss DURING a restore (pull power after pressing Restore) | Next start finishes or rolls back the restore automatically; integrity check ✔ | ☐ | ☐ | ☐ | |

## Windows 11 (23H2 or newer)

| # | Check | Expected result | PASS | FAIL | N/A | Notes |
|---|---|---|:-:|:-:|:-:|---|
| | **Before you start** | | | | | |
| 1 | Record: PC model, Windows edition and build (`winver`), screen resolution, antivirus product, printer model | Written in the header of this sheet | ☐ | ☐ | ☐ | |
| 2 | Have ready: the SIGNED installer + `SHA256SUMS.txt`, a USB drive, a second standard Windows account, a copy of 1.0.0-rc.1 installer and some rc.1 test data (for the upgrade test) | All present | ☐ | ☐ | ☐ | |
| | **Clean install** | | | | | |
| 3 | Check the installer hash: `Get-FileHash .\AirDesk-Setup-<version>-x64.exe` equals the line in SHA256SUMS.txt | Hashes identical | ☐ | ☐ | ☐ | |
| 4 | Right-click installer → Properties → Digital Signatures | Publisher name shown, signature OK, timestamp present | ☐ | ☐ | ☐ | |
| 5 | SmartScreen when double-clicking the downloaded installer | No 'Unknown publisher' (an OV certificate may still show a reputation warning — write the exact text) | ☐ | ☐ | ☐ | |
| 6 | UAC prompt | Shows the verified publisher (not 'Unknown') | ☐ | ☐ | ☐ | |
| 7 | Defender / office antivirus during install and first start | Nothing quarantined or blocked (check Protection history) | ☐ | ☐ | ☐ | |
| 8 | Start menu + desktop shortcut; Apps & Features entry | Both open AirDesk; version and publisher correct | ☐ | ☐ | ☐ | |
| 9 | First start on a clean PC | First-run screen appears; no `airdesk.db` exists in `%ProgramData%\AirDesk\data` until setup is finished | ☐ | ☐ | ☐ | |
| | **First setup, encryption, login** | | | | | |
| 10 | Complete setup: company, admin, press 'Generate a strong passphrase', write it on paper, type it again in the confirmation, tick the checkbox | Setup finishes; login screen appears | ☐ | ☐ | ☐ | |
| 11 | Open `%ProgramData%\AirDesk\data\airdesk.db` in Notepad and search for the company name | Not found (unreadable bytes) | ☐ | ☐ | ☐ | |
| 12 | Log in with the admin account | Dashboard appears | ☐ | ☐ | ☐ | |
| 13 | Backup & restore page → Data encryption | 'Data and backups are encrypted'; 'This Windows user opens the data automatically' | ☐ | ☐ | ☐ | |
| | **Language, keyboard, display** | | | | | |
| 14 | Arabic keyboard layout: create a customer with an Arabic name and mobile typed with Arabic-Indic digits (٠١٠…) | Saved correctly; no cursor jumps inside dialogs | ☐ | ☐ | ☐ | |
| 15 | Record an existing ticket: PNR (Latin), ticket number with Arabic-Indic digits, flight, supplier, price, cost; Confirm ticketed | Saved; Total/Paid/Remaining correct | ☐ | ☐ | ☐ | |
| 16 | Arabic RTL: login, setup, ticket record, payments, reports, backup page | Right-to-left, nothing cut off | ☐ | ☐ | ☐ | |
| 17 | English LTR (language button): same pages | Left-to-right, nothing cut off | ☐ | ☐ | ☐ | |
| 18 | 1366×768 at 100 % scaling: dashboard, ticket record, payments, reports | No horizontal scrolling; dialogs fit | ☐ | ☐ | ☐ | |
| 19 | 1920×1080 at 100 %, 125 %, 150 % scaling | Text sharp; nothing cut off | ☐ | ☐ | ☐ | |
| 20 | Type the recovery passphrase while the Arabic layout is active | Note what happens (passphrase uses Latin letters; switching layout must be obvious to the user) | ☐ | ☐ | ☐ | |
| | **Daily workflow** | | | | | |
| 21 | Customer payment on the ticket record; supplier payment | Receipts print; balances update | ☐ | ☐ | ☐ | |
| 22 | Reissue (date change with change fee) | New ticket number recorded; amounts correct | ☐ | ☐ | ☐ | |
| 23 | Cancellation / refund: supplier result + customer result | Documents created; statements correct | ☐ | ☐ | ☐ | |
| 24 | Schedule change + customer notification (WhatsApp link opens) | Status recorded | ☐ | ☐ | ☐ | |
| 25 | Reports: Sales, Profit, Cash & bank book for this month | Figures match the entries made | ☐ | ☐ | ☐ | |
| | **Printing and PDF** | | | | | |
| 26 | Print a receipt, an invoice and a customer statement on the office printer (A4) | Arabic shaping, numbers and logo correct | ☐ | ☐ | ☐ | |
| 27 | Save a statement as PDF and open it in Edge/Acrobat | Opens; Arabic correct | ☐ | ☐ | ☐ | |
| | **Users and permissions** | | | | | |
| 28 | Sign in to Windows as a STANDARD (non-admin) user; open AirDesk | Unlock screen asks for the recovery passphrase once; after that it opens | ☐ | ☐ | ☐ | |
| 29 | As that standard user: work, back up | No permission errors | ☐ | ☐ | ☐ | |
| 30 | A second Windows user on the same PC | Asked for the passphrase once, then opens automatically for that user | ☐ | ☐ | ☐ | |
| | **Backup and restore** | | | | | |
| 31 | Back up now (default folder) and to a USB drive | 'Working…' shown; the window stays responsive; success message with file path | ☐ | ☐ | ☐ | |
| 32 | Leave AirDesk idle 5+ minutes (backup older than 24 h, or set interval to 1 h) | Automatic backup appears in the list; typing was never interrupted | ☐ | ☐ | ☐ | |
| 33 | Open the .adbk in Notepad; search for a customer name | Not found | ☐ | ☐ | ☐ | |
| 34 | Restore the backup from the USB (your password + RESTORE) | Everyone signed out; data identical after sign-in | ☐ | ☐ | ☐ | |
| | **Upgrade, uninstall, reinstall** | | | | | |
| 35 | On a PC with 1.0.0-rc.1 and pilot data: install the new version over it | Data opens; red 'NOT encrypted' notice for admins | ☐ | ☐ | ☐ | |
| 36 | Enable encryption (admin password + new recovery passphrase) | Everyone signed out; data identical; database now unreadable in Notepad | ☐ | ☐ | ☐ | |
| 37 | Delete unencrypted backups | Old plain backups removed | ☐ | ☐ | ☐ | |
| 38 | Uninstall (Apps & Features) | Program removed; `%ProgramData%\AirDesk` kept | ☐ | ☐ | ☐ | |
| 39 | Reinstall | No setup screen; opens without passphrase for the same Windows user; data intact | ☐ | ☐ | ☐ | |
| | **Recovery** | | | | | |
| 40 | Rename `%ProgramData%\AirDesk\data\airdesk.key`, start AirDesk as a user that has never opened it | 'Key file missing'; 'Read the key from a backup file' + passphrase opens the data | ☐ | ☐ | ☐ | |
| 41 | Wrong passphrase three times | Wait message appears; then the right passphrase works | ☐ | ☐ | ☐ | |
| 42 | Clean-PC drill ([disaster-recovery.md](disaster-recovery.md)) on a second PC | All 13 checks pass | ☐ | ☐ | ☐ | |
| | **Power and shutdown** | | | | | |
| 43 | Sleep and hibernate with AirDesk open, then resume | Works; session rules respected | ☐ | ☐ | ☐ | |
| 44 | Normal Windows shutdown with AirDesk open | Next start opens normally; integrity check ✔ | ☐ | ☐ | ☐ | |
| 45 | Power-loss simulation: hold the power button during normal work (not during a restore) | Next start opens; integrity check ✔; only the last unsaved entry may be missing | ☐ | ☐ | ☐ | |
| 46 | Power loss DURING a restore (pull power after pressing Restore) | Next start finishes or rolls back the restore automatically; integrity check ✔ | ☐ | ☐ | ☐ | |

**Sign-off:** Windows 10 ☐ passed · Windows 11 ☐ passed — name, date, signature.
