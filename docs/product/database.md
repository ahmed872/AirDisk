# AirDesk — Database (schema 6)

SQLite via `better-sqlite3-multiple-ciphers` 12 (SQLite 3.53.4, SQLite3 Multiple Ciphers 2.4.0). **Encrypted at rest** since 1.0.0-rc.2: SQLCipher v4 page format, AES-256 + HMAC-SHA512 per page, a raw 256-bit data key ([encryption-plan.md](encryption-plan.md)). WAL journal, `synchronous=FULL`, `foreign_keys=ON`, all tables `STRICT`, ULID primary keys, money as integer minor units, dates as ISO-8601 text. The Phase 0 reference schema is [schema-draft.sql](../phase-0/schema-draft.sql); `validate_schema.py` (28 checks) still passes against it.

## 1. Migrations

Forward-only, append-only, each applied in its own transaction, recorded in `schema_migration` with a SHA-256 checksum. A database whose applied migration checksum differs from the build refuses to open; a database newer than the build refuses to open; every upgrade is preceded by a verified `PRE_MIGRATION` backup.

| # | Name | Content |
|---|---|---|
| 1 | initial | 40 tables + the FTS5 `search_index` (identity, company, currency/rates, master data, bookings, tickets, cancellations, financial documents & journal, schedule changes, notifications, audit, backups, settings, search), chart of accounts, 21 triggers (immutability, sealing/balance, append-only audit), 28 indexes, views `v_journal`, `v_booking_financials`, `v_customer_balance`, `v_supplier_balance`, `v_money_account_balance`. |
| 2 | master_data | Customer/supplier/airline fields for Phase 2, 2 triggers, 9 indexes. |
| 3 | operations | `booking_price_item` (pre-issue quote: fare, taxes, fee, discount, cost, supplier, ticket number; frozen after issue), extra columns on passenger/segment/ticket/booking/cancellation/notification/airport/money account/expense category, `fin_document.external_reference`, 21 query-driven indexes, 10 triggers (no-delete for tickets, airports, expense categories, cancellations, schedule changes, notifications; draft-only delete for passengers, segments, price items; price items frozen after issue), ~80 airports seeded with Arabic names. |
| 4 | performance_indexes | Indexes found missing by the performance test: `ticket(issue_date)`, `fin_document_line(passenger_id)`, `cancellation_request(requested_at)`. |
| 5 | ledger_completion | `fin_document.counter_money_account_id` (receiving account of a transfer) with triggers allowing it only on `MONEY_TRANSFER` and only when different from the source; indexes on it and on `(doc_type, reason_code)`. |
| 6 | drop_doc_type_index | Removes the `(doc_type, reason_code)` index from migration 5: it made per-supplier queries choose a slow plan (supplier volume report 2.9 s → 0.15 s on the performance dataset). |

Upgrade path verified by tests: a Phase 2 database (schema 2) with real data is upgraded to schema 6; the pre-migration backup exists and validates; integrity checks pass.

## 2. Main tables by area

| Area | Tables |
|---|---|
| Identity & security | `app_user`, `role`, `permission`, `role_permission`, `user_role`, `user_session`, `command_log` (idempotency) |
| Company & settings | `installation`, `company_profile`, `app_setting`, `currency`, `exchange_rate`, `tax_code`, `document_sequence` |
| Master data | `customer`, `traveler`, `supplier`, `airline`, `airport`, `money_account`, `expense_category`, `ledger_account` |
| Ticket records | `booking` (record header: customer, PNR, status, dates, sale currency), `booking_status_history`, `booking_passenger`, `flight_segment` (versioned), `booking_price_item`, `ticket` (+ `exchanged_from_ticket_id` chain), `ticket_segment` |
| After-sale | `cancellation_request`, `cancellation_item`, `schedule_change`, `schedule_change_field`, `notification`, `message_template` |
| Money | `fin_document`, `fin_document_line`, `journal_entry`, `journal_line` |
| Operations | `audit_log` (hash chain), `backup_record`, `search_index` (FTS5 trigram) |

**Seeded reference data:** currencies EGP, SAR, AED, KWD, USD, EUR (active) and QAR, OMR, BHD, JOD, IQD, LYD, TND, MAD, GBP, TRY (inactive until chosen as base currency or activated in settings), system roles and permissions, chart of accounts, ~80 airports. No demo customers, suppliers, users or company data are seeded.

## 3. Integrity rules in the database

- **Immutability:** `fin_document`, `fin_document_line`, `journal_line` and sealed `journal_entry` reject UPDATE/DELETE; `audit_log` is append-only.
- **Balance on seal:** sealing a journal entry fails unless debit = credit in base currency.
- **Foreign keys** everywhere; `PRAGMA foreign_key_check` is part of every backup validation and the integrity check.
- **CHECK constraints** on enums, amounts (> 0 on documents), party/cash requirements by document type, one side per journal line.
- **No hard delete of history** (triggers listed above); master data is archived (`is_active = 0`).
- **No stored balances.** Customer/supplier/cash balances, booking Total/Paid/Remaining, profit and aging are computed from `journal_line`.

## 4. Integrity check (Backup & restore → Run integrity check)

`sqlite.integrity`, `sqlite.foreign_keys`, `INV-1.sealed`, `INV-1.balanced`, `INV-2.trial_balance`, `INV-3.document_totals`, `INV-3.document_journal`, `INV-4.dimensions`, `INV-7.reversals_net_zero`, `INV-9.audit_chain`. Run at start-up, after restore, in every backup validation and on demand.

## 5. Size and speed

See [performance.md](performance.md): a database with 10,000 ticket records, 20,000 tickets, 30,000 documents and 50,000 audit events, with measured search, record, dashboard, statement and report times.


## 6. Files in the data folder (1.0.0-rc.2)

| File | Content |
|---|---|
| `airdesk.db`, `-wal`, `-shm` | Encrypted company database |
| `airdesk.key` | Recovery wrap of the data key (Argon2id + AES-256-GCM); useless without the passphrase |
| `airdesk.key.incoming` | Only during a restore or encryption swap (staged key, crash-safe) |
| `restore-pending.json` | Only during a swap (crash-recovery marker) |
| `airdesk.db.pre-restore-*` | The previous database kept aside by a restore, in its own key |
| `backups/*.adbk` | Backups (format 2: encrypted database + sealed manifest; format 1: rc.1 plain) |
| `backup-history.jsonl` | Backup/restore history with audit-chain checkpoints (`auditSeq`, `auditHeadHash`) |
| `logs/` | Application logs (no customer data, no secrets) |

The database also stores its recovery wrap in `app_setting` (`security.recovery_wrap`). Integrity checks gained `INV-9.audit_tail` (records cut off the end of the audit log) and `INV-9.audit_anchors` (the chain still contains every checkpoint recorded since the last restore). No schema migration was needed: schema version stays 6.
