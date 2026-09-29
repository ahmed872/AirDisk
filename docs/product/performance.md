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

### 1.0.0-rc.2: encrypted database, work on the worker thread

Same 140 MB dataset, encrypted in place with **Enable encryption**, then measured through the launcher with the bundled backup worker (as in the desktop app). "Main-thread lag" is the longest time the main event loop could not run a 5 ms timer, i.e. how long the window would have been unresponsive.

| Operation | Duration | Longest main-thread lag | Where the work runs |
|---|---:|---:|---|
| Verified encrypted backup (snapshot, quick check, package, re-read, full validation) | 10.5 s | **8 ms** | worker thread (main: checkpoint + asynchronous file copy) |
| Full integrity check | 4.6 s | **3 ms** | worker thread, read-only connection |
| Enable encryption on 1.0.0-rc.1 data (one-time; everyone signed out) | 22.1 s | 2.2 s | copy + encrypt + verify on the worker. The reopen after the swap (seed, search-index check) is on the main thread while no one can work. |
| Encrypted backup file size | 135.6 MB | | encrypted pages do not compress; plain rc.1 backups of the same data were 24 MB |

Regression guard in the normal suite (`backup-worker.test.ts`, a 60,000-event audit log): during a 2.6 s verified backup the main thread was **busy 17 ms**, and during a 0.96 s integrity check 8 ms. The same integrity check run in-process keeps it busy 797 ms. The test fails if work moves back to the main thread.

The only main-thread step left in a backup is the WAL checkpoint before the copy. It is bounded by SQLite's auto-checkpoint (≤ ~1,000 pages, about 4 MB) in normal use.

### 1.0.0-rc.1 figures (plain database, verification on the main thread), kept for comparison

| Where | 140 MB database, full verified backup |
|---|---:|
| Performance-test process | 25–28 s |
| A normal AppBackend process opened on the same database | 13–15 s each, of which ~5 s blocked the main thread |

**Automatic backups** still run only at start-up (5 s after the window opens) or after 5 minutes without keyboard/mouse activity (checked every 10 minutes). A manual *Back up now* no longer blocks the window. The page shows a "Working…" notice until the verified file exists.

## Bottlenecks found and fixed

1. **Opening a ticket record: 120 ms → 3–5 ms.** It read `v_booking_financials`, a view that groups the whole journal before filtering. It now uses an indexed per-record query with identical figures.
2. **Missing indexes (migration 4):** tickets by issue date (dashboard), document lines by passenger (removing draft passengers), cancellations by request date; cancellation date filters rewritten as index-friendly ranges.
3. **Supplier volume report: 2.9 s → 0.15 s.** A `(doc_type, reason_code)` index added in migration 5 made SQLite choose a low-selectivity plan for per-supplier queries; migration 6 removes it (caught by this test).
4. **Backups:** rc.2 takes the snapshot by checkpoint + asynchronous file copy (also works for encrypted databases, where the SQLite backup API is refused), and runs packaging, verification, re-encryption and the full integrity check on a worker thread. See *Backup timing* above.

## Not a bottleneck, by design

- **Dashboard (year): ~0.4 s.** Receivables/payables must be computed from all history (no stored balances, by rule); ~100 ms of each dashboard load is that computation.
- **Full integrity check: ~2 s.** It re-verifies every journal entry, the trial balance, foreign keys and the whole audit hash chain; it is a maintenance action, also run inside every backup validation.
