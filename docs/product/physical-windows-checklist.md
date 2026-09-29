# Physical Windows 10 / 11 release checklist

What automated CI cannot prove. CI runs on `windows-latest` (Windows Server, no UI session, no antivirus policy, no printer).

Rules for using this checklist:
- Run it on one **Windows 10 22H2** PC and one **Windows 11 23H2 or newer** PC, both physical (not VMs), with an Arabic keyboard layout installed, before a general release.
- Record the result of every line.
- **Nothing here has been executed yet.**

Legend: ☐ not run · ✔ pass · ✘ fail (write the issue number).

| # | Check | Win 10 | Win 11 |
|---|---|:-:|:-:|
| **Install** | | | |
| 1 | Download the **signed** installer; the file's Properties → Digital Signatures shows the publisher and a timestamp | ☐ | ☐ |
| 2 | SmartScreen: no "Unknown publisher" warning (with a new OV certificate, reputation may still show a warning; note the exact text) | ☐ | ☐ |
| 3 | UAC prompt shows the verified publisher name; install as a standard user who supplies admin credentials | ☐ | ☐ |
| 4 | Defender or the office antivirus does not quarantine or block `AirDesk.exe`, `better_sqlite3.node` or the worker (`resources\app.asar`) | ☐ | ☐ |
| 5 | Start menu and desktop shortcuts open AirDesk; Apps & Features shows AirDesk with the right version and publisher | ☐ | ☐ |
| **Permissions** | | | |
| 6 | A **standard** (non-admin) Windows user can run AirDesk, set up the company, and back up (`%ProgramData%\AirDesk\data` is writable for Users) | ☐ | ☐ |
| 7 | A second Windows user on the same PC is asked for the recovery passphrase once, then opens automatically | ☐ | ☐ |
| 8 | `%ProgramData%\AirDesk\data\airdesk.db` opened in Notepad or a hex viewer shows no readable names or ticket numbers | ☐ | ☐ |
| **Language and display** | | | |
| 9 | Arabic keyboard: type customer names, PNR (Latin), ticket numbers with Arabic-Indic digits (٠٧٧…) in dialogs, with no focus jumps | ☐ | ☐ |
| 10 | Arabic RTL layout correct on login, setup, ticket record, payments, reports; English LTR the same | ☐ | ☐ |
| 11 | 1366×768 at 100 % scaling: no horizontal scrolling on the main pages; dialogs fit | ☐ | ☐ |
| 12 | 1920×1080 at 125 % and 150 % scaling: text sharp, nothing cut off | ☐ | ☐ |
| 13 | Recovery passphrase typed with the Arabic layout active: AirDesk explains that a Latin layout is needed (or it is accepted); note the behaviour | ☐ | ☐ |
| **Printing** | | | |
| 14 | Print a receipt, invoice and statement on the office printer (A4); Arabic shaping and numbers correct | ☐ | ☐ |
| 15 | "Save as PDF" of a statement opens correctly in Edge / Acrobat | ☐ | ☐ |
| **Backup and restore** | | | |
| 16 | Back up now to the default folder and to a USB drive; the file is created, and the page shows "Working…" while it runs | ☐ | ☐ |
| 17 | Automatic backup runs after 5 idle minutes without interrupting typing | ☐ | ☐ |
| 18 | Restore the backup made in #16 (same PC); users sign in again; data identical | ☐ | ☐ |
| **Upgrade, uninstall, reinstall** | | | |
| 19 | Install over the previous release (1.0.0-rc.1 with real pilot data); data opens; **Enable encryption** works; old unencrypted backups can be deleted | ☐ | ☐ |
| 20 | Uninstall: the program is removed, `%ProgramData%\AirDesk` is kept | ☐ | ☐ |
| 21 | Reinstall: no setup screen, opens without the passphrase for the same Windows user, data intact | ☐ | ☐ |
| **Recovery** | | | |
| 22 | Clean-PC drill from [disaster-recovery.md](disaster-recovery.md) with a real office backup on a second PC | ☐ | ☐ |
| 23 | Wrong passphrase three times: the delay message appears, then the right passphrase works | ☐ | ☐ |
| 24 | Windows sleep/hibernate and resume with AirDesk open; power loss simulation (hard power-off during normal work) → data opens and the integrity check is ✔ | ☐ | ☐ |

Sign-off: tester, date, installer SHA-256, and the Windows build (`winver`) for each PC.
