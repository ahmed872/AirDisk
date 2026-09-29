# AirDesk 1.0.0-rc.1 — Product Completion Report

> Superseded for release decisions by [release-gate-1.0.0.md](release-gate-1.0.0.md) (1.0.0-rc.2: encryption, recovery, signing pipeline) and the pre-release audit [release-audit.md](release-audit.md).

Branch `claude/loving-rubin-kyf18y`. This phase: 11 commits from `3f68146` to `5a9fd18`, 82 files changed (+10,913 / −124). CI evidence: runs 11–18 (Linux + Windows).

## A. Executive summary

AirDesk is now a working ticket-office system: a Windows desktop application, offline, in Arabic RTL and English LTR, for recording and managing airline tickets that were booked and issued **outside** the system. The whole daily cycle is implemented, and every step is tested end-to-end in the real application:
- a customer, passengers, the PNR, flights, supplier, purchase cost and customer price;
- confirming the ticket as issued, then Total/Paid/Remaining;
- customer and supplier payments, schedule changes with customer notification, reissues, cancellations and two-sided refunds;
- expenses, treasury, opening balances;
- statements, aging, 12 reports and a dashboard;
- printing and export, automatic verified backups, restore and a full audit trail.

The financial core from Phase 0 was completed, not rewritten:
- the reserved posting rules for transfers, owner capital/drawings, credit application and opening balances now exist;
- balances are still never stored;
- posted money is still immutable.

Quality:
- **Tests:** 249 automated tests, 3 E2E suites (41 scripted steps/checks) and a packaged-app smoke test on Windows all pass.
- **CI:** green on Linux and Windows.
- **Performance:** measured on a 10,000-record / 30,000-document / 50,000-audit-event dataset. Every interactive operation takes under 0.5 s.
- **Defects found and fixed during this phase:**
  - supplier references crashed posting;
  - CSV formula injection;
  - wrong decimals for 3-decimal currencies;
  - a slow record screen;
  - a slow supplier report caused by an index added earlier in this phase.

**Not yet ready for general commercial release.** Code signing, encryption at rest and a field pilot on physical Windows PCs are still open (see K and N). The recommendation is a **controlled pilot** release.

## B. Implemented features

| Area | Implemented (all with backend authorization, audit, ar/en UI) |
|---|---|
| Company, first run, users, roles | Phase 2 features retained; setup also opens the base-currency cash account; About shows app/schema versions and migrations. |
| Master data | Customers (duplicate warning, identity data permission-gated), suppliers, airlines (ticket prefix), **airports** (≈80 seeded, Arabic names, editable, archive not delete). |
| Ticket records | Draft → reserved → ticketed; passengers (Latin names, optional documents); flights (validated flight numbers/airports/times); per-passenger price (fare, taxes, service fee, discount), purchase cost, supplier, ticket number, supplier reference; quote and estimated profit; **Confirm ticketed** posts invoice, discount credit note and one bill per supplier & currency; ticket numbers recorded later once; record print. |
| After issue | Adjust customer price (invoice / credit note), adjust cost (bill / supplier credit note, supplier reference), change supplier, **reissue/exchange** (new ticket linked to old, flights, fare difference, change fee, extra cost, penalty). |
| Payments | Customer receipts with allocation to records, deposits before issue (limited to quote), explicit on-account; customer refunds limited to credit; supplier payments/refunds; **apply credit** (on account or from another record); reversal of any payment; printed receipts/vouchers; Total/Paid/Remaining with settlement badge. |
| Cancellations / refunds | Two-sided workflow (supplier result, customer result) for VOID / REFUND / NON_REFUNDABLE, partial by ticket, supplier penalties, office cancellation fee, credit-before-supplier permission, withdrawal; ticket/passenger/record statuses follow. |
| Schedule changes | Versioned segments with old/new values, MINOR/MAJOR severity, attention banner and list, notification draft (ar/en), `wa.me` link (no automatic sending), manual outcome, customer confirmation/response; customer-requested reissue changes need no alert. |
| Upcoming travel | Departures in a date range with attention flags. |
| Expenses & treasury | Expenses with categories (ledger-mapped), money accounts (cash/bank/wallet/card, any currency, live balances), **transfers**, **owner capital and drawings**, exchange rates by date, currency activation. |
| Go-live | **Opening balances** for customers, suppliers and money accounts. |
| Reports | 12 journal-based reports (sales, purchases, profit, receivables aging, payables aging, supplier volume, expenses, refunds, cancellations, flight changes, employee activity, collections), customer/supplier statements, aging buckets, dashboard with date presets, global permission-aware search; print, PDF and CSV export (user-confirmed, audited, formula-safe). |
| Backup & restore | Manual and **automatic** verified backups with retention, pre-migration and pre-restore safety backups, crash-safe restore with file picker, integrity check, backup history. |
| Multi-currency | Document currency + frozen rate + base amount; carrying-value settlements; realised FX; per-currency statements; 2- and 3-decimal currencies. |
| Invoice/tax foundation | Numbered immutable documents; tax/commercial registration numbers, invoice title and terms on prints. (No VAT calculation — see K.) |
| Windows | NSIS installer, silent install/uninstall, data preserved, reinstall, version resources. |

## C. Architecture

Unchanged layering (see [architecture.md](architecture.md)):
- **Layers:** React renderer (sandboxed) → Electron main (session binding, dialogs, PDF, backup timer) → transport-agnostic backend (zod contracts → session → access rule → services) → pure domain → SQLite.
- **New backend services:** reference, bookings, finance, operations, reports.
- **Money:** `PostingService` remains the only writer of money.
- **Audit:** the single `AuditLog` remains the only audit system.
- **Renderer bridge:** exactly `invoke`, `exportPdf`, `exportCsv`, `pickBackupFile`.
- **Scope:** record management only. No flight search, availability, seats, PNR creation, ticket issuance or airline APIs.

## D. Database

Schema **6** (see [database.md](database.md)):

| Migration | Content |
|---|---|
| 3 · operations | Price items, operational columns, 21 indexes, 10 history-protection triggers, airport seed |
| 4 · performance_indexes | 3 indexes |
| 5 · ledger_completion | Receiving account for transfers, guarded by triggers |
| 6 · drop_doc_type_index | Removes an index that caused a slow plan |

All tables are STRICT with foreign keys.

**Upgrade path tested:**
- a Phase 2 database (schema 2) upgrades to schema 6, with a verified pre-migration backup;
- migration checksums are enforced;
- a database newer than the build is refused.

Phase 0 `validate_schema.py`: **28/28**.

## E. Financial model

Phase 0 design, now complete except FX_ADJUSTMENT (reserved). See [financial-model.md](financial-model.md).

**New posting rules:**
- **P10 MONEY_TRANSFER:** account↔account, owner capital, drawings. No overdraft; same currency only.
- **P11 BALANCE_APPLICATION:** customer or supplier credit settles records. Foreign-currency differences are realised FX.
- **P12 OPENING_BALANCE:** against opening-balance equity.
- **Reissue:** posts only the differences on the new ticket. Refund and cost limits follow the exchange chain.

**Fixed:**
- Paying an opening debt is no longer treated as an overpayment.
- Supplier references are written at posting. Before, the UPDATE was rejected by the immutability trigger and crashed the operation.

**Invariants re-verified by tests:**
- every journal balances;
- payments never change profit;
- reversals net to zero;
- no stored balances;
- no hard delete of financial history.

## F. Security

- **Authorization:**
  - Every command declares an access rule, and a test enforces it.
  - Services re-check permissions before transactions.
  - Row-level scoping: agents see only their own records.
  - Server-side redaction of cost, profit, supplier balances and identity data. Supplier-side openings and applications are also hidden without cost permission.
  - Owner movements, opening balances, reissue, credit application and the backup schedule each have their own permission.
- **Authentication:**
  - Argon2id hashes, lockout, idle and absolute session limits.
  - No hidden master password.
- **Electron:**
  - sandbox, context isolation, CSP, no navigation/new windows (only `wa.me` opens externally), permission requests denied, fuses on, asar integrity;
  - the backup file picker and exports require a session and permission and accept trusted senders only.
- **Data safety:**
  - CSV export neutralises formulas;
  - export file names are sanitised;
  - SQL values are always bound;
  - FTS input is quoted.
- **Dependencies:** `pnpm audit` found no known vulnerabilities (production and development).
- **Not in place:**
  - encryption at rest (designed, not enabled);
  - code signing.

Both are listed in K and N.

## G. Testing (exact counts, final commit `5a9fd18`)

| Kind | Count | Result |
|---|---:|---|
| Unit — domain (money, exchange, ledger, P10–P12 incl. properties, operations/state machines, master data, security/time) | 105 | 105 passed |
| Unit — desktop (Electron security config 5, CSV export 3) | 8 | 8 passed |
| Integration — backend (scenarios A–M and lifecycle 24, posting 20, identity 16, master data 11, migrations 11, auth 10, services 10, RBAC 9, ledger completion 9, audit/backup 8, reissue 4, automatic backup 3, encryption 1) | 136 | 136 passed |
| **Total automated (vitest)** | **249** | **249 passed, 0 failed** (+1 opt-in performance test, run separately: passed) |
| Security-focused (RBAC 9, auth 10, security & time 9, Electron config 5, CSV injection/export 3, encryption 1, scenario M 2) | 39 | passed (also permission assertions in other suites) |
| Financial (posting 20, ledger 17, P10–P12 13, money 18, exchange 7, ledger completion 9, reissue 4, scenarios 24) | 112 | passed |
| E2E — foundation (Electron + Playwright) | 8 checks | passed |
| E2E — Phase 2 scenario incl. restart | 20 steps | 20/20 passed |
| E2E — operations workflow at 1366×768 + layout at 1366×768 and 1920×1080 | 13 steps | 13/13 passed |
| Packaged smoke on Windows (full / seed / verify after reinstall) | 23 / 17 / 9 steps | all passed |
| Regression: Phase 0 `validate_schema.py` | 28 checks | 28/28 |
| Regression: Phase 1 (124) and Phase 2 (176) suites | contained in the 249 | all pass |
| Coverage (domain + backend source; renderer covered by E2E only) | statements 89.92 %, branches 80.95 %, functions 91.05 %, lines 93.94 % | — |

**Earlier-phase tests edited during this phase** (each follows an intended behaviour change):
- the foundation E2E bridge-surface assertion (now four functions);
- the Phase 2 E2E navigation and dashboard selectors;
- the setup audit list (now includes `money_account.created`);
- the "unsupported document" posting test (MONEY_TRANSFER is now supported, so it uses FX_ADJUSTMENT).

## H. Windows (CI `windows-latest`, Windows 10.0.26100, Electron 44.4.5)

Runs 16 (`6482bbe`), 17 (`217e174`) and 18 (`5a9fd18`, final code): **all steps passed.** The steps:
1. **Tests:** unit and integration tests on Windows.
2. **Build:** NSIS installer `AirDesk-Setup-1.0.0-rc.1-x64.exe` (artifact ≈122 MB).
3. **Install:** silent per-machine install.
4. **Version information:**
   - EXE: ProductName `AirDesk`, FileVersion `1.0.0-rc.1`, ProductVersion `1.0.0.0`, LegalCopyright `Copyright © AirDesk`;
   - installer: ProductName `AirDesk`, ProductVersion `1.0.0-rc.1`;
   - Apps & Features: `AirDesk 1.0.0-rc.1`, publisher `AirDesk`.
5. **First launch:** the packaged launch creates `C:\ProgramData\AirDesk\data\airdesk.db`.
6. **Packaged smoke (23 steps):** schema v5 (v6 from run 18), SQLite 3.53.4, Argon2 setup/login, posting, backup + restore, customer/supplier/airline, ticket record, Total/Paid/Remaining `1000000/400000/600000`, backup → restore keeps the record, agent refused, restart, integrity.
7. **Seed:** first-run seed in the real data directory (17 steps).
8. **Uninstall:** silent uninstall removes the program and keeps `airdesk.db`.
9. **Reinstall and verify (9 steps):** no second setup, login, customer, supplier and airline all persisted, ticket record and balances persisted, schema up to date, integrity.
10. **Final uninstall.**

Not covered: interactive UAC, physical Windows 10/11 machines, printers, antivirus interaction (field pilot).

## I. Backup / restore

- **Formats and safety:**
  - format `.adbk` (zip: manifest + database), with SHA-256, integrity check, audit chain and trial balance verified before a backup is reported successful;
  - pre-migration and pre-restore safety backups;
  - crash-safe swap with recovery at next start.
- **Automatic backups:**
  - every 24 h by default, kept 14;
  - runs only at start-up or after 5 min of inactivity;
  - configurable by Admin; pruning audited.
- **Tests:**
  - Scenario L (backup → further changes → restore → records, documents, audit chain, balances identical);
  - automatic backup/retention/idle tests;
  - Windows packaged smoke (ticket record and balances identical after backup → restore, restart, uninstall + reinstall).
- **Documentation:** data recovery on a new PC is documented step by step ([admin-guide.md](admin-guide.md) §6).
- **Size and time:** a verified backup of the 140 MB performance database is 24 MB and takes ≈25 s in CI.
- **Limitations:** backups are **not encrypted**. In this container the first backup of a process stalled ≈13 s in the snapshot's first step; later backups took ≈1 s. The cause was not identified, and the idle-only scheduling limits the impact.

## J. Performance

Details are in [performance.md](performance.md).

**Dataset:**
- 5,000 customers, 1,000 suppliers, 480 airlines and airports;
- 10,000 issued ticket records, 20,000 passengers, 20,000 segments, 20,000 tickets;
- 30,000 documents posted through `PostingService`, 100,000 journal lines;
- 50,004 audit events;
- database size 139.8 MB.

**Medians (ms):**

| Operation | Median |
|---|---:|
| Customer search by name | 9.8 |
| Customer search by mobile | 5.2 |
| PNR search | 1.7 |
| Ticket-number search | 3.9 |
| Open records list | 63 |
| Record detail | 3.8 |
| Global search | 1.5 |
| Dashboard, month | 168 |
| Dashboard, year | 417 |
| Customer statement | 0.5 |
| Supplier statement | 0.5 |
| Monthly sales | 14.6 |
| Monthly profit | 148 |
| Receivables aging | 105 |
| Supplier volume | 155 |
| Upcoming travel | 22.8 |
| Audit filter | 0.5 |
| Full integrity check | 2,078 |

**Fixed:**
- record detail: 120 → 4 ms;
- 3 missing indexes;
- supplier volume: 2.9 s → 0.15 s;
- backup snapshot/compression.

**Machine:** 4 vCPU Xeon 2.1 GHz container. Windows timings were not measured.

## K. Known limitations

1. **Encryption at rest is not enabled.** The database and backups are protected only by Windows permissions; the recovery passphrase flow is designed but not built.
2. **Installers are unsigned.** SmartScreen will warn. A certificate is needed.
3. **Not validated on physical Windows 10/11 PCs.** This includes UAC prompts, printers, fonts and antivirus.
4. **No VAT/tax calculation and no e-invoicing** (ETA/ZATCA). The document model and printed tax numbers are only a foundation.
5. **No notification providers.** WhatsApp is a `wa.me` link; SMS, e-mail and the WhatsApp API are not implemented and are not claimed.
6. **Single PC only.** The LAN primary/client mode is designed, not built; online auto-update is not implemented.
7. **Currency and FX gaps:**
   - FX_ADJUSTMENT (period-end revaluation) is not implemented;
   - transfers between accounts of different currencies are not supported.
8. **Permissions and templates:**
   - `template.manage` and `booking.void` are defined but unused; a void is a cancellation of type VOID;
   - there are no editable message or print templates.
9. **Records and customers:**
   - customer merge is not implemented (duplicates only warn);
   - passenger names cannot change after issue (by rule); a name correction the airline makes by issuing a new ticket is recorded by cancelling the ticket and recording a new one.
10. **Backups:**
    - backups are not encrypted;
    - the first backup of a large database can take ~25 s; it runs only when idle.
11. **Test coverage gaps:**
    - E2E runs on Linux; Windows runs the packaged smoke test, not the UI E2E;
    - renderer code is excluded from coverage figures.
12. **Reporting:** there is a fixed set of 12 reports and no custom report builder.

## L. External integrations

| Integration | Status |
|---|---|
| WhatsApp (`wa.me` link to open the user's WhatsApp with a drafted message) | **Implemented** (link only) |
| PDF export (Chromium `printToPDF`) and CSV export | **Implemented** (local) |
| Notification provider abstraction (`ProviderRegistry`) | **Configured-not-connected**: no provider is registered; notifications are MANUAL records |
| Code signing (electron-builder signing hook) | **Configured-not-connected**: needs a certificate |
| SMS / e-mail / WhatsApp Business API | **Not implemented** |
| GDS / airline / consolidator APIs | **Not implemented** (out of scope) |
| Tax authority e-invoicing (ETA / ZATCA) | **Not implemented** |
| Online updates | **Not implemented** |

## M. Commercial readiness checklist

| Item | Status |
|---|---|
| Core ticket-office workflow end to end | ✔ |
| Financial correctness (immutable double entry, derived balances, reversals, FX) | ✔ |
| Go-live support (opening balances) and treasury | ✔ |
| Backend-enforced RBAC, scoping, redaction, audit trail | ✔ |
| Arabic RTL and English LTR, 1366×768 and 1920×1080 | ✔ |
| White-label via company settings | ✔ |
| Offline operation | ✔ |
| Windows installer: silent install, uninstall keeps data, reinstall, upgrade/migrations, version info | ✔ (CI) |
| Automatic verified backups and documented recovery | ✔ |
| Performance at office scale | ✔ |
| User guide (Arabic) and admin/technical documentation | ✔ |
| Code-signed installer | ✘ |
| Encryption at rest + recovery passphrase | ✘ |
| Field pilot on physical PCs and printers | ✘ |
| Clean-machine disaster-recovery drill with a real office backup | ✘ |
| VAT / e-invoicing (market-dependent) | ✘ |

## N. Release recommendation

**Release 1.0.0-rc.1 to a controlled pilot:** 1–3 friendly offices, one PC each, with the vendor on hand for installation and weekly off-site backup checks. Do **not** release generally yet.

**Conditions for 1.0.0 (general availability):**
1. Sign the installer.
2. Enable encryption at rest with the recovery-passphrase flow and encrypted backups.
3. Complete the pilot on physical Windows 10/11 PCs (printing, Arabic fonts, antivirus, UAC).
4. Perform a clean-machine disaster-recovery drill with a real office backup.
5. Decide VAT/e-invoicing per target market.

Nothing in the core workflow or the financial engine is known to be broken. All automated suites and both CI platforms are green on the final code.

## Addendum — CI for the final code commit

Run 18 (`5a9fd18`, the last code commit; later commits are documentation only):
- **Linux job 109214847323: success.** Typecheck, lint, tests with coverage, build, Electron smoke, and all three E2E suites passed.
- **Windows job 109215155489: success.** All 14 steps passed: tests, NSIS build, silent install, version information, packaged launch, packaged smoke (schema v6), real-directory seed, uninstall keeps data, reinstall and verify.
