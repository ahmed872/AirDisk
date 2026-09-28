# 03 — Database Schema (initial, complete draft)

Covers deliverable item **D**, report section **5. Database Schema**.
The executable DDL is [schema-draft.sql](schema-draft.sql). This document explains the
conventions and decisions behind it.

---

## 1. Engine & connection settings

| Setting | Value | Why |
|---|---|---|
| Engine | SQLite ≥ 3.45 (bundled with the Node driver, not the OS) | Zero-admin, single-file, proven for local business data, excellent backup API. |
| Driver | `better-sqlite3` family, SQLCipher-capable build (`better-sqlite3-multiple-ciphers`) | Synchronous transactions = no interleaving inside a financial write; optional encryption at rest (Q7). |
| `journal_mode` | `WAL` | Readers don't block the writer; crash-safe. |
| `synchronous` | `FULL` | Every commit is durable even on power loss (frequent in target markets). The cost (~ms per commit) is irrelevant at office volumes. |
| `foreign_keys` | `ON` (every connection) | Referential integrity. |
| `busy_timeout` | 5000 ms | Defensive; there is a single writer process anyway. |
| Tables | `STRICT` | Type affinity is enforced — a money column can never silently hold `'10.5'` or `10.5`. |
| Startup check | `PRAGMA quick_check` + schema version check; weekly `integrity_check` + `foreign_key_check` | Detect corruption early and before backups. |
| Location | Local fixed disk only; network/UNC paths are refused | SQLite over SMB is a documented corruption source. |

## 2. Conventions

| Concern | Convention |
|---|---|
| Primary keys | `TEXT` ULID generated in the app. Time-ordered, globally unique (safe for future LAN/server mode, backup merges and imports), and does not leak business volume. Human-facing numbers are separate (`booking_no`, `doc_no`). |
| Human numbers | `document_sequence` table incremented in the same transaction → gap-free per type & year, e.g. `BK-2026-000123`, `RCT-2026-000045`. Prefixes configurable in settings. |
| Money | `INTEGER` minor units, column suffix `_minor`. Never `REAL`. Currency exponent from `currency.minor_unit` (2 for EGP/SAR/USD/EUR; 3 supported for KWD/BHD/JOD/OMR). |
| Base amounts | `*_base_minor`, computed at posting and frozen. |
| Exchange rates | `TEXT` decimal string, parsed with `decimal.js`; never floating point. |
| Signs | Every stored amount is `> 0` (or `>= 0` for base/FX lines). Direction comes from document type / debit-credit side. |
| Instants | `TEXT` ISO-8601 UTC with ms, suffix `_at`. |
| Business dates | `TEXT 'YYYY-MM-DD'` in the company timezone, suffix `_date`. "Today" is computed in the company timezone, not the PC's. |
| Flight times | Airport-local date + `'HH:MM'` + airport code; `*_utc` derived when the airport timezone is known. |
| Booleans | `INTEGER` 0/1 with `CHECK`. |
| Enumerations | `TEXT` + `CHECK (x IN (...))`. Readable in backups and ad-hoc queries; adding a value is a (cheap) migration. |
| Optimistic concurrency | `row_version` on mutable rows; update statements include `WHERE row_version = ?` and bump it. Stale edits fail with a friendly "record changed by X" message. |
| Audit columns | `created_at/by`, `updated_at/by` on mutable rows; full before/after goes to `audit_log`. |
| Deletion | Financial rows: never. Master data: `is_active = 0`. Draft bookings: status `DISCARDED`. |

## 3. Table catalogue

| # | Area | Tables | Mutability |
|---|---|---|---|
| 0 | Meta | `schema_migration`, `installation` | append-only |
| 1 | Identity & access | `app_user`, `role`, `permission`, `role_permission`, `user_role`, `user_session` | mutable (audited) |
| 2 | Settings & reference | `currency`, `company_profile`, `app_setting`, `document_sequence`, `exchange_rate`, `airport`, `airline` | mutable (audited); base currency frozen after first posting |
| 3 | Parties | `customer`, `traveler`, `supplier`, `money_account` | mutable (audited), never deleted |
| 4 | Chart of accounts | `ledger_account`, `expense_category` | system-seeded; categories configurable |
| 5 | Bookings | `booking`, `booking_status_history`, `booking_passenger`, `flight_segment`, `ticket`, `ticket_segment` | mutable non-financial fields (audited) |
| 6 | Cancellation workflow | `cancellation_request`, `cancellation_item` | mutable workflow state (audited) |
| 7 | Finance | `fin_document`, `fin_document_line`, `journal_entry`, `journal_line` | **immutable** (triggers) |
| 8 | Schedule & notification | `schedule_change`, `schedule_change_field`, `message_template`, `notification` | change rows immutable except workflow status; notifications status-only updates |
| 9 | Admin | `audit_log` (append-only, hash chain), `backup_record`, `search_index` (FTS5) | |
| 10 | Read models | `v_journal`, `v_booking_financials`, `v_customer_balance`, `v_supplier_balance`, `v_money_account_balance` | views |

Column-level definitions, constraints and comments are in the DDL.

## 4. Integrity enforcement (defence in depth)

Correctness is enforced at three layers; each catches what the previous might miss:

1. **Contract layer** — zod schemas validate every command payload at the IPC boundary
   (types, ranges, formats, lengths).
2. **Domain/service layer** — business rules (state transitions, allocation limits,
   permissions, lock date, balanced postings) inside a single SQLite transaction.
3. **Database layer** — `STRICT` types, `CHECK`s, FKs, unique indexes and triggers:

| Trigger | Guarantees |
|---|---|
| `trg_fin_document_no_update/no_delete`, `trg_fin_document_line_*`, `trg_journal_line_*`, `trg_journal_entry_no_delete` | Posted financial data cannot be modified or deleted, even by buggy code or a developer console. |
| `trg_journal_entry_seal` | A journal entry can only transition unsealed → sealed, and only if it has ≥ 2 lines and debits = credits (base). |
| `trg_journal_line_sealed` | No line can be added to a sealed entry. |
| `trg_fin_document_lock_date` | Nothing can be posted into a locked period. |
| `trg_fin_document_reversal_shape` | A reversal must mirror its original's type, party, currency and amount; `reversal_of_id UNIQUE` → at most one reversal. |
| `trg_audit_no_update/no_delete` | Audit log is append-only. |
| `trg_company_base_currency_frozen` | Base currency can't change after postings. |
| `trg_booking_no_delete`, `trg_customer_no_delete`, `trg_supplier_no_delete` | History can't be orphaned. |

Unsealed journal entries at startup indicate a bug (the service seals inside the same
transaction); the integrity check reports them.

> **Honest limit:** anyone with the database file and the encryption key (if any) can
> drop triggers and edit data with an external tool. Triggers stop *accidents and bugs*;
> the **hash-chained audit log** makes deliberate tampering *detectable*; SQLCipher
> encryption (Q7) makes it *harder*. No local-only design can make it impossible.

## 5. Index strategy

- Every FK used in a list screen or report is indexed (`ix_booking_customer`,
  `ix_doc_customer`, `ix_jl_*` partial indexes on non-NULL dimensions, …).
- Report date filters: `ix_doc_date_type`, `ix_journal_entry_date`,
  `ix_booking_status_date`, `ix_segment_departure`.
- Uniqueness: `booking_no`, `doc_no`, `ticket_number` (partial, non-NULL), `supplier_no`,
  `customer_no`, `username NOCASE`, one reversal per document.
- Search: one FTS5 table with the **trigram** tokenizer (substring match for names,
  PNRs, ticket numbers, phone fragments). See [07-architecture.md §4](07-architecture.md).
- Performance budget verified in Phase 8 with a 100k-booking / 1M-journal-line synthetic
  dataset (see [09-testing-strategy.md](09-testing-strategy.md)).

## 6. Phase 0 verification of the draft

The DDL was loaded into SQLite 3.45.1 and exercised with a throw-away script that posts
the spec's worked examples through raw SQL following the posting rules in
[04-financial-model.md](04-financial-model.md). **28/28 checks passed**, including:

- Cases A, B, C, D/E/G, F/K, H, L and the 4-instalment example produce exactly the
  expected gross profit, receivable, payable and paid figures.
- A fully settled cancelled booking ends with **cash = gross profit = 200**.
- Period view: September keeps +400, October shows −200 for the late cancellation.
- Trial balance = 0 across all postings.
- Rejected as designed: updating/deleting posted documents or journal lines, negative
  payment, sealing an unbalanced entry, inserting into a sealed entry, posting into a
  locked period, changing base currency after postings, deleting a booking with history
  or any customer, malformed reversal, double reversal, audit-log tampering.
- Trigram FTS finds a customer by a 7-digit phone fragment.

This is a *design* check, not a substitute for the Phase 1–5 automated test suites.

## 7. Known schema follow-ups (intentionally deferred)

| Item | Phase |
|---|---|
| Attachments (passport scans, e-ticket PDFs) as files in the data folder + `attachment` table | 5 or later |
| Tax lines (VAT on service fees) once Q4 is answered | TBD |
| `service_item` for non-flight products (hotel, visa, insurance) — Q10 | post-v1 |
| Projection tables for balances if views miss the performance budget | 8 |
| LAN server mode: `workstation` table, per-session device info | per Q1 |
