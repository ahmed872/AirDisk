# AirDesk — Performance (representative office dataset)

**Test:** `packages/backend/test/perf.test.ts` (opt-in: `AIRDESK_PERF=1 npx vitest run packages/backend/test/perf.test.ts`). It builds a non-production dataset through the real schema, posts every financial document through the real `PostingService` (validation, journal, sealing, audit), then times the commands through the same dispatcher the UI uses (validation, session, permission checks included). Each operation: 1 warm-up + 5 timed runs (3 for aging/supplier volume, 1 for the full integrity check); median and max reported.

**Machine:** Linux CI container, 4 vCPU Intel Xeon @ 2.10 GHz, 15 GB RAM, virtual disk. A typical office PC with an SSD is expected to be similar or faster; Windows timings were not measured separately.

## Dataset

| Entity | Rows |
|---|---|
| Customers | 5,000 |
| Suppliers | 1,000 |
| Airlines + airports | 400 + 80 (= 480) |
| Ticket records (issued) | 10,000 (spread over 12 months) |
| Passengers | 20,000 |
| Flight segments | 20,000 |
| Tickets | 20,000 |
| Financial documents (invoice, bill, receipt per record) | 30,000 |
| Journal lines | 100,000 |
| Audit events | 50,004 |

Database size **139.8 MB**; verified backup file **24.1 MB** (compressed). Building the dataset: master data and records 56 s, posting 30,000 documents 91 s (≈ 3 ms per document including validation, journal, sealing and audit), 20,000 extra audit events 3.8 s.

## Measurements (ms)

Re-measured in the pre-release audit (same machine class, same dataset). "rc.1 first run" is the measurement published with 1.0.0-rc.1; differences within ±20 % are run-to-run noise in a shared container.

| Operation | Median | Max | rc.1 first run |
|---|---:|---:|---:|
| customer search (name) | 9.4 | 11.0 | 9.8 |
| customer search (mobile fragment) | 5.7 | 5.8 | 5.2 |
| supplier search | 1.8 | 1.8 | — (new) |
| ticket record search (PNR) | 1.9 | 2.7 | 1.7 |
| ticket record search (ticket number) | 3.9 | 4.6 | 3.9 |
| ticket record list (open, first page) | 64.4 | 73.0 | 63 |
| open ticket record (full detail) | 5.5 | 6.9 | 3.8 |
| global search | 2.2 | 18.6 | 1.5 |
| dashboard (month) | 168.4 | 206.2 | 168.4 |
| dashboard (year) | 448.6 | 563.3 | 417.1 |
| customer statement (year) | 0.7 | 1.0 | 0.5 |
| supplier statement (year) | 0.7 | 1.1 | 0.5 |
| monthly sales report | 17.8 | 29.0 | 14.6 |
| monthly profit report | 140.4 | 151.4 | 148.2 |
| receivables aging (all customers) | 111.3 | 114.0 | 105.3 |
| supplier volume (year) | 155.2 | 159.8 | 154.7 |
| cash & bank book (month) | 34.8 | 34.8 | — (new) |
| upcoming travel (7 days) | 19.0 | 22.8 | 22.8 |
| audit log (filtered by entity) | 0.4 | 0.5 | 0.5 |
| integrity check (full) | 2750.7 | 2750.7 | 2077.5 |

Every interactive operation and report is under 0.6 s (worst single run: dashboard for a full year, 563 ms); the test fails if any (other than the full integrity check) exceeds 1 s.

## Backup timing (measured, not hidden)

| Where | 140 MB database, full verified backup |
|---|---:|
| Performance-test worker (after building the dataset in the same process) | 28.3 s |
| A normal AppBackend process opened on the same database (5 consecutive backups) | 13–15 s each |
| Raw SQLite online snapshot alone, standalone process | ~0.4 s |

A verified backup = snapshot → `quick_check` of the snapshot → compression (worker thread) → re-read and SHA-256 → decompression (worker thread) → full validation (`integrity_check`, foreign keys, audit chain, trial balance). The pre-release audit replaced the snapshot's full `integrity_check` by `quick_check` because the final validation runs the full check again on the same bytes. About **5 s of the remaining time is synchronous SQLite verification on the main process**, during which the window does not respond. For a small office database (under 20 MB) the whole backup takes 1–2 s.

**Why automatic backups do not interrupt work:** they run only at start-up (5 s after the window opens, before anyone works) or after 5 minutes without keyboard/mouse activity (checked every 10 minutes). A manual *Back up now* on a very large database keeps the application busy for several seconds (other commands wait); the page shows a "Working… do not close AirDesk" notice while it runs. Moving the verification to a worker thread is listed as *should fix before general sale* in the final report.

The earlier observation that "the first backup of a process spends ~13 s in the snapshot's first step" was re-investigated: it reproduces only inside the performance-test worker that has just written the 140 MB dataset (page cache / WAL state of that process), not in a freshly opened application process, where every backup takes the same 13–15 s.

## Bottlenecks found and fixed

1. **Opening a ticket record: 120 ms → 3–5 ms.** It read `v_booking_financials`, a view that groups the whole journal before filtering. It now uses an indexed per-record query with identical figures.
2. **Missing indexes (migration 4):** tickets by issue date (dashboard), document lines by passenger (removing draft passengers), cancellations by request date; cancellation date filters rewritten as index-friendly ranges.
3. **Supplier volume report: 2.9 s → 0.15 s.** A `(doc_type, reason_code)` index added in migration 5 made SQLite choose a low-selectivity plan for per-supplier queries; migration 6 removes it (caught by this test).
4. **Backups:** the online snapshot copies 1,000 pages per step instead of 100, compression/decompression run on a worker thread, and the snapshot check is `quick_check` (the full check runs once, in the final validation). See *Backup timing* above.

## Not a bottleneck, by design

- **Dashboard (year): ~0.4 s.** Receivables/payables must be computed from all history (no stored balances, by rule); ~100 ms of each dashboard load is that computation.
- **Full integrity check: ~2 s.** It re-verifies every journal entry, the trial balance, foreign keys and the whole audit hash chain; it is a maintenance action, also run inside every backup validation.
