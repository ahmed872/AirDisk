# AirDesk 1.0.0-rc.1: final pre-release audit

> **Status update (1.0.0-rc.2):** The blockers in §D have since been worked on; see [release-gate-1.0.0.md](release-gate-1.0.0.md).
> - Encryption at rest, encrypted backups, the recovery passphrase, clean-PC recovery, backup work moved off the main thread, audit tail/anchor checks and the signing pipeline are **implemented and tested**.
> - Still open:
>   - the certificate itself;
>   - physical Windows 10/11 validation;
>   - the physical DR drill;
>   - the VAT decision.
>
> This report is kept unchanged below as the record of the rc.1 audit.


- **Branch:** `claude/loving-rubin-kyf18y`.
- **Audited code commit:** `59c3634`. The CI run numbers are in §J.
- **Scope checked throughout:** AirDesk records and manages existing ticket transactions:
  - customer → passengers → existing PNR → ticket number → airline → flights → supplier;
  - purchase cost → customer price → payments → balances;
  - changes and reissues → cancellation and refund → accounting → notifications.
- **What AirDesk does not do:** it does **not** search flights, reserve seats, create PNRs, issue tickets, or connect to any GDS, airline or consolidator system. No such function was added.

Categories used: **RELEASE BLOCKER** · **SHOULD FIX BEFORE GENERAL SALE** · **ACCEPTABLE LIMITATION** · **FUTURE FEATURE**.

## A. What was audited

| Area | How |
|---|---|
| Product workflow and terminology | I walked through every screen in the record path and read the i18n strings. I also read the permission labels and menus against the scope statement. |
| Financial / accounting | I read the posting service and rules P1–P12 against Phase 0 §04. New tests cover:<br>• 3-decimal currencies;<br>• partial FX settlement;<br>• atomic rollback;<br>• conservation of money in transfers;<br>• a one-month hand-computed reconciliation of every report, statement, the dashboard and account balances. |
| Security | **Dispatcher.** Each command's access rule, schema strictness and the unknown-command path.<br>**Services.** `requirePermission`, `accessible()` row scoping, cost/profit/supplier redaction, and SQL construction (only whitelisted fragments are interpolated).<br>**Main process.** Filesystem paths in backup, restore and export; the preload bridge; CSP; Electron fuses; `openExternal` allow-list.<br>**Accounts and logging.** Authentication, lockout, sessions, audit chain, log content, and the generic error mapping for internal errors.<br>**Checks run.** A Sales Agent calling ~40 restricted commands directly, bypassing the UI; hostile payloads (`__proto__`, `constructor`, unknown keys); CSV formula injection; a search for default credentials, backdoors, `eval` and `child_process`. |
| Data integrity / DB | Triggers (immutability, no hard delete), the absence of balance columns, migrations 1–6, sequences, and FK and integrity checks. |
| Backup / restore / DR | Timing on the 140 MB dataset in two process setups; failure paths (bad destination, missing file); `.part` cleanup; automatic-backup scheduling; the new-PC recovery procedure. |
| Performance | Perf test on 10,000 records, 30,000 documents and 50,000 audit events, with two new cases (supplier search, cash book). |
| UI/UX | 1366×768 and 1920×1080, Arabic RTL and English LTR, overflow checks on every main page, and real keyboard typing inside dialogs. |
| Reports | All 13 reports plus statements, against hand-computed ledger totals, with authorization per report, CSV precision per currency decimals, and CSV injection escaping. |
| White-label | Hardcoded identity, seeded data, the currency list, and the partner-edition build parameters. |
| Windows release | NSIS config, `installer.nsh`, versions, ProgramData ACL, uninstall/reinstall, paths, auto-start, and the signing configuration. |
| Tests | The new suites were checked for false confidence. One case: the keyboard E2E step was verified to **fail** without the Modal fix before it was accepted. |
| Documentation | All `docs/product/*.md` and the root README. |

## B. What was fixed

Each fix below has a test. All of them are in commit `59c3634`.

| # | Finding | Severity before fix | Fix |
|---|---|---|---|
| 1 | **Supplier refund amounts leaked to Sales Agents.** `cancellations.get` / `list` and the cancellation block of the ticket record returned `expectedSupplierRefund` and supplier-side documents (SCN/SRF) to users without `booking.view_cost`. | Security (confidential cost data) | Redacted server-side. Test: `release-audit.test.ts › cancellation redaction`. |
| 2 | **The flight-changes report showed other agents' records** to a user without `booking.view_all`. | Security (row scoping) | `accessible()` is applied under own scoping. Test: `flight_changes scoping`. |
| 3 | **`backup.create` accepted a relative destination** (resolved against the process working directory). | Security / reliability | It now rejects a non-absolute path or one containing `..` with `INVALID_PATH`. Test included. |
| 4 | **No cash/bank book.** The office could not see movements and running balances of a cash box or bank account. That is basic for a ticket office. | Workflow gap | New report `cash_book` (`treasury.view`): opening balance, each movement, money in, money out, running balance, per account. It is reconciled to the ledger in `report-reconciliation.test.ts` and appears in the operations E2E. |
| 5 | **A mistyped ticket number could not be corrected.** Once recorded it was final (`TICKET_NUMBER_SET`). | Workflow gap | Correction with `booking.adjust_price` and a mandatory reason. It is audited as `ticket.number_corrected` with before/after values. It has no financial effect and is still unique and prefix-checked. Tests: backend lifecycle and E2E. |
| 6 | **Regional currencies were missing** (OMR, BHD, JOD, QAR, IQD, LYD, TND, MAD, GBP, TRY). An office in Oman, Bahrain, Jordan or Qatar could not be set up, which is a white-label blocker. | White-label | Seeded inactive with their correct minor units. The first-run screen reads the list from the backend, and the chosen base currency is activated. Test: OMR office end to end. |
| 7 | **Typing in any dialog lost focus after one character.** The Modal's focus effect re-ran on every parent render, so e.g. "INTERNET" became `إ`/`I` split across fields. | UX (real data-entry bug) | `closeRef` pattern; the effect runs once. The E2E step with real `keyboard.type` fails without the fix and passes with it. |
| 8 | **No warning when a payment or expense takes a cash box below zero.** | Finance UX | Warning before saving for CASH/WALLET outflows larger than the balance. Semantics are unchanged: overdraft is allowed by Phase 0 BR-FIN-08. |
| 9 | **Terminology implied booking or issuance.** Permission labels said "Issue tickets" and "Reserve", and the dead "Bookings / coming soon" page and strings were still there. | Scope | Relabelled: "Record new tickets", "Mark existing reservation (not ticketed)", "Confirm ticketed (issued externally)", "Record reissue / exchange", and so on. The dead page and strings were removed. Permission codes are unchanged, so no data migration was needed. |
| 10 | **Redundant full integrity check inside the backup snapshot step.** The final validation repeats it on the same bytes. | Performance | The snapshot step uses `quick_check`; the full `integrity_check` still runs in the final validation. |
| 11 | **Backup page gave no feedback during a long backup.** | UX | "Working… do not close AirDesk" notice while a backup, restore or integrity check runs. |
| 12 | **Misleading comment:** `electron-builder.yml` said signing was configured in a "protected release workflow" that does not exist. | Honesty of docs | Comment corrected. The real pipeline is specified in `deployment-and-release.md` §7. |
| 13 | **Docs were missing or outdated** on:<br>• the scope statement ("does not … connect to GDS");<br>• cash book;<br>• ticket-number correction;<br>• currencies;<br>• measured backup timing;<br>• encryption status;<br>• signing;<br>• Windows behaviour. | Docs | All product docs and the README were updated. New: `encryption-plan.md`, this report. |

## C. What was intentionally left unchanged

- **Architecture:** posting service, journal, derived balances, dispatcher, IPC bridge, backup format. There was no evidence against any of them.
- **Payments and expenses may overdraw a cash box.** This is by specification (BR-FIN-08: record what really happened); only a warning was added. Transfers still cannot overdraw.
- **Per-document half-up rounding.** The KWD test confirmed that residues go to FX 7100 as designed.
- **The full integrity check stays in every backup validation** (~2.7 s on the large dataset). Trading it away for speed would weaken the "verified backup" guarantee.
- **Automatic backups stay at start-up or after 5 idle minutes.** This already prevents interrupting work.
- **The `booking.void` and `template.manage` permissions** remain. They are unused but harmless, and documented as such.
- **Arabic/English strings** that were already correct and in scope. The notification wording already says automatic sending is not configured and the user sends the message and records the outcome.

## D. Remaining blockers and open items

| Item | Category | Why / what is needed |
|---|---|---|
| Encryption at rest (database + backups) with a recovery passphrase | **RELEASE BLOCKER** | The data is readable by anyone with disk access or a copy of an `.adbk`. The installer grants local *Users* modify rights on `%ProgramData%\AirDesk` (needed for non-admin use), so another Windows user on the same PC can copy the database. The design and verified library behaviour are in [encryption-plan.md](encryption-plan.md). It is not implemented, because it needs physical Windows/DPAPI validation and a recovery drill; see that page §3. Interim for pilots: BitLocker, password-protected Windows accounts, backups treated as confidential. |
| Code signing | **RELEASE BLOCKER** | The installer is unsigned: SmartScreen shows "Unknown publisher" and antivirus may quarantine it. It needs the owner's OV/EV certificate (HSM or cloud signing). The pipeline is in `deployment-and-release.md` §7. Nothing in the repository fakes a signature. |
| Physical Windows 10 and 11 validation | **RELEASE BLOCKER** | CI covers only Windows Server 2022, silently. Still unverified: UAC, SmartScreen, antivirus, Arabic fonts, printers/PDF, high-DPI, several Windows users on one PC. |
| Clean-machine DR drill with a real office backup | **RELEASE BLOCKER** | The automated equivalent passes: backup → restore in tests and on Windows CI, plus uninstall/reinstall. A human drill on a new PC, following admin guide §6, has not been done. |
| VAT and e-invoicing (Egypt ETA, KSA ZATCA Fatoora, UAE) | **SHOULD FIX BEFORE GENERAL SALE** (a blocker in any market where the office is VAT-registered and must e-invoice) | Invoices carry no VAT computation and are not submitted to any tax authority. Company tax and CR numbers print on documents. Sell only to offices that do not need e-invoicing from this software, or implement it per market. |
| Manual backup on a very large database keeps the app busy ~13–15 s, of which ~5 s is synchronous SQLite work on the main process | **SHOULD FIX BEFORE GENERAL SALE** | Automatic backups never interrupt work (they run at start-up or when idle). A typical office database backs up in 1–2 s. The fix is to move snapshot verification and validation to a worker thread with its own read-only connection. |
| Tamper-evidence of the audit chain | **SHOULD FIX BEFORE GENERAL SALE** (part of the encryption work) | The SHA-256 chain detects edits, but someone with direct file access could recompute it. Keying it (HMAC with the data key) comes with encryption. |
| New PC recovery needs a temporary company and Admin before restore | **ACCEPTABLE LIMITATION** | This is documented step by step, and the restore replaces the temporary data completely. A first-run "restore from backup" button comes with encryption (plan step 5). |
| Payments/expenses can overdraw cash (with warning) | **ACCEPTABLE LIMITATION** | By specification. |
| Single PC, no LAN multi-user | **FUTURE FEATURE** | Designed in Phase 1, not built. |
| Online auto-update | **FUTURE FEATURE** | `publish: []`; offline installers only. |
| Automatic WhatsApp/SMS/e-mail sending | **FUTURE FEATURE** | Staff send the message themselves (wa.me link) and record the outcome. |
| Unrealised FX revaluation (FXA documents) | **FUTURE FEATURE** | Reserved and refused explicitly. |
| Editable print/message templates | **FUTURE FEATURE** | `template.manage` is reserved. |

## E. Security findings

- **Fixed:** #1 supplier-refund leak (cost data to agents); #2 report row-scoping gap; #3 relative backup path.
- **Verified sound:**
  - Every one of the dispatcher's commands has an explicit access rule, and unknown commands are refused (`hasOwnProperty`, not the `in` operator).
  - All input schemas are zod `.strict()`, so `__proto__`, `constructor` and unknown keys are rejected before any service runs.
  - SQL is parameterised. Only fixed, whitelisted fragments are interpolated.
  - Internal errors reach the renderer as a generic message; details go only to the local log. Passwords never appear in logs or the audit log; identity numbers are masked.
  - Argon2id hashing; lockout after 5 failures for 15 min; idle 15 min / absolute 12 h sessions; no default credentials, no master password, no backdoor. A search for `eval`, `child_process` and `new Function` found nothing in app code.
  - Electron: sandbox, context isolation, strict CSP, navigation blocked, `openExternal` allow-listed to `wa.me`, permission requests denied, fuses. The preload exposes four functions.
  - CSV export escapes formula starts (`= + - @ tab CR`) and writes money with the currency's own decimals.
  - Restore requires `backup.restore`, the user's password, and typing `RESTORE`. A missing or corrupt file is refused before anything changes.
- **Agent bypass test:** a Sales Agent calling IPC directly was denied, or got redacted data, for all of the following:
  - cost, profit and supplier balances;
  - restricted reports and owner movements;
  - opening balances;
  - backup, restore and integrity;
  - users, roles and admin settings.

  In all, ~40 commands were tested (`release-audit.test.ts`), and E2E step `sales-agent-cannot-see-cost-or-profit` covers the UI.
- **Open:** data at rest is unencrypted, and the audit chain is unkeyed; see D.

## F. Financial findings

- **No error found in posting logic.** The one-month reconciliation matches hand-computed figures exactly:
  - sales 1,550,000; purchases 1,500,000; expenses 70,000;
  - collections 1,450,000; supplier payments 600,000;
  - receivables 130,000; payables 900,000; cash end 2,280,000.

  These match across `ledger.summary`, each of the 13 reports, statements, the dashboard and account balances.
- **Currencies:** 3-decimal currencies (OMR) work end to end. KWD partial settlement leaves no base-currency residue: the difference goes to realised FX by design.
- **Atomicity:** a failing issue (missing USD rate) leaves no documents, tickets or consumed financial sequence numbers. An invalid payment posts nothing.
- **Transfers** conserve money across accounts.
- **Correction workflows** (ticket-number correction) do not touch the ledger.
- **Gaps:** VAT and e-invoicing are absent (D). The cash-book report was missing and is now added.

## G. Performance findings

On the representative dataset (140 MB DB, 10,000 records), every interactive operation and report takes a median of 0.4–449 ms, with a worst single run of 563 ms (year dashboard). The test fails above 1 s. New cases:

| Operation | Median |
|---|---:|
| Supplier search | 1.8 ms |
| Cash & bank book for a month | 34.8 ms |

The full integrity check takes 2.75 s; it is a maintenance action. Details are in [performance.md](performance.md).

## H. Backup / restore findings

**Measured, not hidden.** A full verified backup of the 140 MB database takes:

| Where | Time |
|---|---:|
| Normal application process (5 consecutive backups) | 13–15 s each |
| Perf-test worker that had just written the dataset | 28 s |
| Raw snapshot alone | ~0.4 s |

The earlier "13 s first-step stall" reproduces only in that perf worker, not in a fresh app process. The fix applied was to remove the duplicate integrity check. What remains:

- **Main-process blocking:** ~5 s of synchronous verification (D, should fix).
- **Automatic backups:** start-up or 5 idle minutes only, so they do not interrupt work.
- **Failure handling:** a failed backup is recorded as FAILED, audited, and leaves no `.part` file (test).
- **Restore:** a missing file is refused. Crash-safe restore, the pre-restore backup, and backup → restore identity (tests and Windows CI) were already covered.
- **Encryption:** backups are unencrypted (blocker).

## I. Windows findings

- **Verified on `windows-latest` in every CI run:**
  - per-machine NSIS silent install and version resources;
  - `%ProgramData%\AirDesk\data` created with *Users* modify rights;
  - packaged smoke test (native SQLite + Argon2), setup, login, ticket record, payment, backup, restore, restart;
  - uninstall keeps data; reinstall reuses it with no second setup.
- **No auto-start registration.** There is no Run key, service or scheduled task.
- **Program files are read-only;** all writes go to ProgramData.
- **The data folder name is hardcoded** (`AirDesk`) in `paths.ts` and `installer.nsh`. A partner edition changes both; this is documented.
- **Open:** code signing and physical Windows 10/11 validation (D).

## J. Test results

| Check | Result |
|---|---|
| `pnpm typecheck` (exit code checked) | 0 errors |
| `pnpm lint` | clean |
| `vitest run --coverage` (Linux) | **25 files, 263 passed, 1 skipped** (the opt-in perf test, run separately). Coverage: statements 90.62 %, branches 81.57 %, functions 92.19 %, lines 94.58 %. |
| Perf test (`AIRDESK_PERF=1`) | passed (all operations < 1 s except the full integrity check) |
| Electron smoke (real runtime, native modules) | passed |
| E2E foundation | passed |
| E2E Phase 2 | 20/20 passed |
| E2E operations (1366×768 + 1920×1080, AR + EN, real keyboard typing) | 14/14 steps passed |
| CI Linux + Windows on `59c3634` | **run 21: both jobs green.** Linux: typecheck, lint, tests + coverage, build, smoke, 3 E2E suites. Windows: tests, NSIS build, silent install, version info, packaged launch, packaged smoke, real-directory setup, uninstall keeps data, reinstall verify. |

New test files:
- `release-audit.test.ts` (9 tests);
- `financial-audit.test.ts` (4);
- `report-reconciliation.test.ts` (1).

## K. Exact commit

- **Audit code and docs:** `59c3634` ("Pre-release audit: hardening fixes, cash & bank book, docs").
- **This report:** the following docs-only commit on the same branch.
- **CI:** run 21 for `59c3634`, success on Linux and Windows ([run](https://github.com/ahmed872/AirDisk/actions/runs/36542822875)). Later docs-only commits run the same workflow.

## L. Release recommendation

**Not ready for general sale.** **Ready for a controlled paid pilot** under these conditions:
- 1–3 offices;
- on PCs with BitLocker and password-protected Windows accounts;
- installer handed over directly, with the SmartScreen warning explained;
- no VAT e-invoicing obligation that AirDesk would have to meet;
- weekly off-site backup copies kept as confidential;
- one DR drill performed at the first pilot site.

To reach **1.0.0 general sale**, all four RELEASE BLOCKERS in D must be closed, in this order:
1. encryption at rest with the recovery passphrase, including encrypted backups and first-run restore;
2. a code-signed release pipeline;
3. validation on physical Windows 10 and 11;
4. a clean-machine DR drill.

Then address the SHOULD FIX items (VAT/e-invoicing per target market, backup verification off the main thread, keyed audit chain).
