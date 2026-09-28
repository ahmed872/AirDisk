# AirDesk — Phase 0: Product & Architecture Specification

**Status:** Draft for owner review · **Date:** 2026-09-28 · **Next step:** owner answers
blocking questions, then gives the go-ahead for Phase 1. No application code is written
in Phase 0.

---

## 1. Executive summary

**AirDesk** is a commercial, white-label Windows desktop application for airline-ticket
agencies. It is sold and installed at many different offices, runs fully offline on a
local database, and manages the office's whole cycle: customers, suppliers, bookings,
tickets, payments in instalments, cancellations and refunds, flight schedule changes
with customer notification, expenses, profit, receivables/payables with aging, reporting,
users/permissions, audit trail and backups.

The core design decision is to treat **every monetary event as an immutable financial
document that posts a balanced double-entry journal entry**. Users never see debits and
credits; they see *Sale, Purchase, Payment, Refund, Expense*. But because everything is
derived from one balanced, append-only ledger:

- **Sale ≠ cash ≠ purchase ≠ supplier payment ≠ profit** by construction (separate
  document types and accounts), not by reporting convention.
- **Gross profit = sale − purchase cost** and is provably unaffected by any payment
  (tested as a property). **Supplier payments are never expenses.**
- **Nothing is overwritten.** Price changes, supplier changes, cancellations, discounts
  and bounced payments are new documents; database triggers reject updates and deletes of
  posted financial data.
- **Every balance and report reconciles** with every other (trial balance = 0,
  sub-ledgers = control accounts, fully settled booking: cash = profit).

The draft schema was loaded into SQLite and exercised against the mandatory accounting
cases (A–H, K, L, instalments) and the integrity rules: **28/28 checks passed**
([03 §6](03-database-schema.md)).

**Proposed stack:** Electron + TypeScript + React (Arabic RTL-first, English) with SQLite
(WAL, `synchronous=FULL`, STRICT tables, optional SQLCipher encryption), a pure-TypeScript
domain core, a command dispatcher that enforces permissions server-side, and an NSIS
Windows installer. The backend is transport-agnostic so a **LAN multi-PC mode** can be
added without rewriting — the biggest open question (Q1).

**Roadmap:** 11 gated phases, from Foundation (security, data layer, audit, backup)
through bookings, payments, refunds, expenses, schedule changes, reporting,
multi-currency and commercial hardening to a pilot at a real office and v1.0.

**Top risks:** multi-PC expectations (R2), financial correctness (R1), data loss (R3), and
tax/e-invoicing obligations in target markets such as Saudi ZATCA or Egyptian ETA (R4).

**Decisions needed from you now:** Q1 (number of PCs / LAN) and Q7 (encryption and
recovery passphrase). Q2, Q5, Q10 before Phase 3.

## 2. Document map

| Report section requested | Deliverable item(s) | Document |
|---|---|---|
| 1. Executive Summary | — | this page |
| 2. Functional Requirements | A | [01-requirements-and-business-rules.md §1–2](01-requirements-and-business-rules.md) |
| 3. Business Rules | B | [01-requirements-and-business-rules.md §3–4](01-requirements-and-business-rules.md) |
| 4. Domain Model | C, F | [02-domain-model.md](02-domain-model.md) |
| 5. Database Schema | D | [03-database-schema.md](03-database-schema.md) + [schema-draft.sql](schema-draft.sql) |
| 6. Financial Model | E | [04-financial-model.md](04-financial-model.md) |
| 7. State Machines | G | [05-state-machines.md](05-state-machines.md) |
| 8. Security Model | — | [06-security-and-permissions.md §1–4, 7–10](06-security-and-permissions.md) |
| 9. Permission Matrix | — | [06-security-and-permissions.md §5–6](06-security-and-permissions.md) |
| — Edge cases | H | [08-edge-cases.md](08-edge-cases.md) |
| 10. Architecture | — | [07-architecture.md §1, 4, 6–8](07-architecture.md) |
| 11. Technology Stack | I | [07-architecture.md §2](07-architecture.md) |
| — Project structure | K | [07-architecture.md §3](07-architecture.md) |
| — Migration strategy | L | [07-architecture.md §5](07-architecture.md) |
| 12. Testing Strategy | J | [09-testing-strategy.md](09-testing-strategy.md) |
| 13. Backup Strategy | M | [10-backup-restore.md](10-backup-restore.md) |
| 14. Packaging Strategy | N | [11-packaging.md](11-packaging.md) |
| 15. Phase Roadmap | O | [12-roadmap-risks-questions.md §1](12-roadmap-risks-questions.md) |
| 16. Risks | — | [12-roadmap-risks-questions.md §2](12-roadmap-risks-questions.md) |
| 17. Unresolved Questions | — | [12-roadmap-risks-questions.md §3](12-roadmap-risks-questions.md) |

## 3. Key decisions at a glance

| # | Decision | Where |
|---|---|---|
| D1 | Immutable financial documents + balanced double-entry journal as the single source of financial truth | 04 |
| D2 | Balances are projections of the journal, never stored columns | 02 §3.3 |
| D3 | Payments are allocated to bookings through journal dimensions; excess is explicit on-account credit | 04 §4 |
| D4 | Revenue/cost recognised at ticket issuance; periods are never restated | 01 BR-FIN-05/06 |
| D5 | Customer ≠ passenger; supplier ≠ airline; supplier lives on the ticket | 02 |
| D6 | Cancellation/refund is a two-sided asynchronous workflow; memo amounts never posted | 05 §4 |
| D7 | Integer minor units, frozen rates and base amounts; per-currency party balances; realised FX below gross profit | 04 §6–7 |
| D8 | Flight times stored airport-local; business dates in company timezone | 03 §2 |
| D9 | Permissions enforced in the backend dispatcher with field-level redaction; roles are data | 06 |
| D10 | Append-only, hash-chained audit log written in the same transaction | 06 §7 |
| D11 | Electron + TS + React + SQLite; pure domain package; transport-agnostic backend | 07 |
| D12 | Forward-only checksummed migrations with automatic pre-migration backup and financial fingerprint | 07 §5 |
| D13 | Backups via SQLite online backup API, validated, encrypted, GFS retention; crash-safe atomic restore | 10 |
| D14 | Signed per-machine NSIS installer; data in ProgramData; uninstall keeps data | 11 |

## 4. Glossary

| Term | Meaning |
|---|---|
| Booking | One sale transaction for one customer, containing passengers, segments and tickets. |
| PNR | Passenger Name Record — the reservation locator (e.g. `ABC123`). |
| Segment | One flight leg (e.g. CAI→JED on MS 643). |
| Ticket | Airline ticket (13 digits) for one passenger, covering one or more segments. |
| Supplier | The party the office buys tickets from (consolidator, sub-agent, or the airline). |
| Document | An immutable financial record (invoice, receipt, bill, payment, credit note, refund, expense…). |
| Credit note | A document that reduces what a party owes (entitlement), distinct from the cash refund. |
| Base currency | The installation's reporting currency; all profit figures are in it. |
| Open item | A (party, booking, currency) balance that is not zero. |
| Void | Cancelling a ticket within the supplier's void window, normally without penalty. |
| Reissue / exchange | Replacing a ticket with a new one (date change etc.), usually with fare difference and fees. |
