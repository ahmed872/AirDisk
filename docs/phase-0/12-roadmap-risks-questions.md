# 12 — Phase Roadmap, Risks & Unresolved Questions

Covers deliverable item **O** and report sections **15. Phase Roadmap**, **16. Risks**,
**17. Unresolved Questions**.

---

## 1. Phase roadmap

Each phase follows the brief's 10-step method (goal, scope, implementation, DB changes,
UI changes, automated tests, edge-case tests, regression, build verification, final audit)
and the Definition of Done in [09 §7](09-testing-strategy.md). A phase does not start
until the previous one is green and you have signed off.

Multi-currency *columns* exist from Phase 3 (rate = 1, currency = base); foreign-currency
*features* are enabled in Phase 9. This avoids a financial-table migration later.

| Phase | Goal | Scope | Exit criteria (in addition to DoD) |
|---|---|---|---|
| **0** ✅ | Executable specification | This document set | Owner answers blocking questions (Q1–Q7) |
| **1 — Foundation** | A secure, installable, empty shell with a trustworthy data layer | Monorepo, Electron hardening, SQLite (WAL/FULL/STRICT), migrator + checksums + downgrade guard, ULID, money/currency primitives, audit log with hash chain, users/roles/permissions + login/lock/idle, setup wizard, company settings (white label), i18n RTL/LTR shell, manual backup + validated restore (basic), integrity module, CI Linux + Windows installer smoke. Phase 1 spike (07 §5.3). | Installer installs/uninstalls on clean Windows 10 & 11; login/lockout/permission tests; backup→restore round-trip test |
| **2 — Master data & search** | Fast, clean reference data | Customers (+ travellers), suppliers, airlines, airports (seeded), money accounts, expense categories, phone normalisation, duplicate warnings, FTS search + Arabic normaliser, Ctrl+K global search | Search p95 < 150 ms at 100k customers; EC-S01…S08 |
| **3 — Bookings & posting engine** | Sell a ticket correctly | Booking aggregate (passengers, segments, tickets), state machine DRAFT→RESERVED→ISSUED, issue posts INV + BIL via posting engine, document numbering, booking financial panel with redaction | Cases A (accrual part), I, J; INV-1..4; EC-B01…B09 |
| **4 — Payments & statements** | Collect and pay correctly | Customer receipts & supplier payments with allocation/on-account, overpayment rule, reversals, apply-balance, printable receipts, customer/supplier statements, idempotent commands | Cases A, B, C, M; EC-P01…P16; UAT: booking+payment ≤ 90 s |
| **5 — Adjustments, cancellations, refunds** | Change things without losing history | Price adjustments (K), supplier change (L), reissue/exchange, void, cancellation workflow (both sides), fees/penalties, cash refunds | Cases D, E, F, G, K, L; EC-R01…R10 |
| **6 — Expenses, treasury, opening balances, period lock** | Complete books | Expenses + reversal, transfers, owner movements, opening balances (with Excel import template), lock date | Net profit = GP − expenses in scenarios; lock-date tests |
| **7 — Schedule changes & notifications** | Never miss telling a customer | Segment change tracking, severity, ⚠ indicators, notification state machine, templates ar/en, manual channels (WhatsApp click-to-chat, copy, call log), attention list | FR-SCH-*; EC-B12/B13/B15 |
| **8 — Dashboard & reporting** | See the business | Report framework + all brief §15 reports, aging, dashboard with period selector, export XLSX/CSV/PDF, print, employee activity; perf suite at 100k bookings | Report totals reconcile with journal (automated); perf budgets met |
| **9 — Multi-currency** | Foreign-currency suppliers & customers | Rate table, per-document currency, cross-currency settlement, realised FX, per-currency balances/statements, open-foreign-balance report | Case H + EC-C*; FX rounding property tests |
| **10 — Hardening & commercial** | Sellable product | Scheduled/on-exit backups + GFS retention + secondary destination + health warnings, SQLCipher encryption (per Q7), code signing, optional auto-update, licensing (per Q8), diagnostic bundle, security review, accessibility & keyboard audit | Full E2E on Windows; restore disaster drill; external security checklist |
| **11 — Pilot & v1.0** | Real office validation | Beta at 1–2 pilot offices, data migration from their spreadsheets, fixes, documentation (user guide ar/en), release 1.0 | 4 weeks of pilot with reconciled books; zero open P1 bugs |
| Later | Growth | LAN server mode (if Q1 = multi-PC, this moves **before** Phase 11), WhatsApp/SMS/email providers, GDS/PNR import, tax/e-invoicing, other products (hotel/visa/Umrah), attachments, mobile companion | per demand |

## 2. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Financial logic error reaches customers (wrong balances/profit) | Medium | Critical | Journal + invariants, immutable data, scenario DSL reviewed by owner, property tests, pilot reconciliation vs. owner's existing books |
| R2 | Offices need multiple PCs; single-PC design rejected in the field | **High** | High | Q1 now; transport-agnostic backend + ULIDs; LAN server mode planned; explicitly refuse SQLite over network shares |
| R3 | Data loss (disk failure, ransomware, no off-PC backup) | Medium | Critical | FULL sync, automatic validated backups, secondary destination nagging, restore drill in onboarding |
| R4 | Tax / e-invoicing obligations (e.g. Saudi ZATCA *Fatoora* Phase 2, Egyptian ETA e-invoice/e-receipt) make the product non-compliant in a target market | Medium–High | High | Q4 before Phase 6; keep documents/lines tax-ready; compliance may require online integration and cryptographic stamping — a separate phase |
| R5 | Scope creep (hotels, visas, CRM, accounting suite) delays v1 | High | Medium | Phase gates; product-agnostic ledger allows later extension; "Later" list |
| R6 | Poor Arabic search/printing quality | Medium | Medium | Normaliser test corpus, bundled fonts, print review with real printers in UAT |
| R7 | Customers on Windows 7/8.1 or very old hardware | Medium | Medium | State requirements in sales material; installer blocks unsupported OS with a clear message |
| R8 | SmartScreen warnings / AV false positives | High if unsigned | Medium | Code signing (Q9), reputation build-up, submit to AV vendors |
| R9 | Electron security misconfiguration | Low | High | Hardening checklist enforced by test, fuses, CSP, no remote content, dependency audit |
| R10 | Native module (SQLite/argon2) packaging breaks on Electron upgrades | Medium | Medium | Pinned versions, Windows packaged smoke test on every release, spike in Phase 1 |
| R11 | Timezone/date bugs (local flight times, "today", DST) | Medium | Medium | Explicit date types, company timezone, EC-C05…C08 tests |
| R12 | Multi-currency accounting method disputed by customers' accountants | Medium | Medium | Q3; method documented; FX isolated in 7100 so GP is never affected |
| R13 | Employees find it slower than their spreadsheet | Medium | High | Keyboard-first design, measured 90 s target, UAT at phase 4 |
| R14 | Piracy / unlicensed copies | Medium | Medium | Offline signed licences (Phase 10); accept that determined piracy cannot be prevented offline |
| R15 | Many installations on different versions complicate support | High (over time) | Medium | Forward-only migrations tested from every released fixture, diagnostic bundle, update channel |
| R16 | Encryption recovery passphrase lost → data unrecoverable | Low–Medium | Critical | Q7; printed recovery sheet at setup; explicit warning; option to run without encryption |

## 3. Unresolved questions

Questions marked **Blocking** affect data structures or calculations and must be answered
before the phase shown. For each, the default I will implement if you simply say "use
defaults" is given.

| # | Question | Why it matters | Blocking for | Default if unanswered |
|---|---|---|---|---|
| **Q1** | How many PCs does a typical customer office use **at the same time on the same data**? Is a LAN "main PC + client PCs" setup acceptable, or must each PC work fully offline and sync later? | Decides single-PC vs. LAN server mode vs. (strongly discouraged) multi-master sync. Affects roadmap order and support model. | Phase 1 (design), before Phase 11 (delivery) | v1 = single PC; LAN server mode built before pilot if any pilot office needs 2+ PCs. No multi-master sync. |
| **Q2** | When should a sale count as revenue: at **ticket issuance** (default), at booking/reservation, or at travel date? | Changes which month sales/profit fall in. | Phase 3 | Ticket issuance date. |
| **Q3** | Which currencies do suppliers and customers actually use? Is the **realised FX gain/loss** approach (below gross profit, in net profit) acceptable to your target customers' accountants? Is a daily manual rate table acceptable, or do offices use a fixed internal rate? | Multi-currency posting and reporting method. | Phase 9 (columns already present from Phase 3) | Base = company choice; manual daily rates; realised FX in 7100; no unrealised revaluation. |
| **Q4** | Target countries at launch (Egypt? Saudi Arabia? others)? Must invoices be **tax invoices** (VAT on service fees) or comply with **e-invoicing** (ZATCA Fatoora in KSA, ETA in Egypt)? | Legal compliance may require tax lines, QR codes, cryptographic stamping and online submission — significant scope. | Phase 6 design | Egypt-first, non-tax receipts/statements; tax registration number printed; e-invoicing as a later dedicated phase. |
| **Q5** | Should Sales Agents **enter** purchase cost when issuing? Should they **see** cost/profit afterwards? | Permission defaults & UI; also fraud control. | Phase 3 | Enter ✔, view after issue ✘ (configurable per role). |
| **Q6** | May offices refund customers **before** the supplier/airline confirms the refund? | Cash exposure; refund workflow guard. | Phase 5 | Allowed only with `refund.customer_before_supplier` (Admin/Manager). |
| **Q7** | Encrypt the database at rest? This requires an Admin **recovery passphrase**; if it is lost together with the PC, data and encrypted backups are unrecoverable (even by the vendor). | Security vs. recoverability; support policy. | Phase 1 (key architecture), Phase 10 (enable) | Encryption **on** with printed recovery sheet at setup; can be turned off at setup. |
| Q8 | Licensing model: perpetual + yearly maintenance, or subscription? Per PC or per office? Trial period? | Licence file contents and enforcement. | Phase 10 | Per-office perpetual licence with seat count and yearly maintenance; 30-day trial. |
| Q9 | Who owns the **code-signing certificate** (company name on SmartScreen) and budget for it? Product/brand name final ("AirDesk" vs. "AirDisk")? | Release process, installer branding. | Phase 10 (name: Phase 1 for installer IDs) | Product name **AirDesk**, repo name unchanged. |
| Q10 | Are non-flight products (hotels, visas, insurance, Umrah/Hajj packages, transfers) needed in v1? | Booking/ticket model extension. | Phase 3 (to keep extension point) | Flights only in v1; ledger already product-agnostic. |
| Q11 | Do offices have existing data (Excel/other software) to import: customers, suppliers, **opening balances**, historical bookings? | Import tooling scope. | Phase 6 | Import customers, suppliers and opening balances from an Excel template; no historical bookings. |
| Q12 | Do suppliers pay **commissions/incentives/rebates** (e.g. per segment volume) that must appear as income? | Extra revenue type not tied to a single booking. | Phase 6 | Recorded as a supplier credit note with line type "incentive" to a separate revenue account (added then). |
| Q13 | Do offices issue tickets themselves via a GDS (Amadeus/Sabre/Galileo) and want PNR/ticket import? | Future integration, data formats of PNR/ticket fields. | Later | Manual entry only in v1; fields sized for GDS formats. |

**Blocking now (before Phase 1 starts):** Q1 and Q7 (they affect the foundation).
Q2, Q5 and Q10 are needed before Phase 3; the rest can wait for their phases.
