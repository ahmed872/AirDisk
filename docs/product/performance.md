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

Database size **139.8 MB**; verified backup file **24 MB** (compressed). Building the dataset: master data and records 46 s, posting 30,000 documents 87 s (≈ 2.9 ms per document including audit), 20,000 extra audit events 3.7 s.

## Measurements (ms)

| Operation | Median | Max | Before fixes |
|---|---:|---:|---:|
| customer search (name) | 9.8 | 11.8 | 9 |
| customer search (mobile fragment) | 5.2 | 5.6 | 5 |
| ticket record search (PNR) | 1.7 | 1.9 | 1.8 |
| ticket record search (ticket number) | 3.9 | 5.1 | 3.6 |
| ticket record list (open, first page) | 63 | 67.8 | 59.6 |
| open ticket record (full detail) | 3.8 | 5.5 | 119.7 |
| global search | 1.5 | 1.8 | 1.1 |
| dashboard (month) | 168.4 | 180.4 | 160.7 |
| dashboard (year) | 417.1 | 473.9 | 414.6 |
| customer statement (year) | 0.5 | 0.8 | 0.6 |
| supplier statement (year) | 0.5 | 0.9 | 0.6 |
| monthly sales report | 14.6 | 14.8 | 14.4 |
| monthly profit report | 148.2 | 177.9 | 139.1 |
| receivables aging (all customers) | 105.3 | 153.4 | 110.6 |
| supplier volume (year) | 154.7 | 169.6 | 150.6 |
| upcoming travel (7 days) | 22.8 | 23.6 | 24 |
| audit log (filtered by entity) | 0.5 | 0.6 | 0.5 |
| integrity check (full) | 2077.5 | 2077.5 | 2076 |

Every interactive operation and report is under 0.5 s; the test fails if any (other than the full integrity check) exceeds 1 s.

## Bottlenecks found and fixed

1. **Opening a ticket record: 120 ms → 3–5 ms.** It read `v_booking_financials`, a view that groups the whole journal before filtering. It now uses an indexed per-record query with identical figures.
2. **Missing indexes (migration 4):** tickets by issue date (dashboard), document lines by passenger (removing draft passengers), cancellations by request date; cancellation date filters rewritten as index-friendly ranges.
3. **Supplier volume report: 2.9 s → 0.15 s.** A `(doc_type, reason_code)` index added in migration 5 made SQLite choose a low-selectivity plan for per-supplier queries; migration 6 removes it (caught by this test).
4. **Backups:** the online snapshot copies 1,000 pages per step instead of 100, and compression/decompression run on a worker thread. A full verified backup of the 140 MB database takes about 25 s here (snapshot, integrity check, compression, re-read, decompression, second full validation). In this container the first backup of a process spent ~13 s in the snapshot's first step while later backups took ~1 s; the cause was not identified. Because the verification steps are synchronous SQLite work, **automatic backups run only at start-up or after 5 minutes without user activity**.

## Not a bottleneck, by design

- **Dashboard (year): ~0.4 s.** Receivables/payables must be computed from all history (no stored balances, by rule); ~100 ms of each dashboard load is that computation.
- **Full integrity check: ~2 s.** It re-verifies every journal entry, the trial balance, foreign keys and the whole audit hash chain; it is a maintenance action, also run inside every backup validation.
