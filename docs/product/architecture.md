# AirDesk — Architecture (as built, 1.0.0-rc.1)

The design decisions are in [Phase 0 §07](../phase-0/07-architecture.md); this page describes what the product actually is now.

## 1. Shape

```
┌──────────────────────────── Windows PC (single office) ────────────────────────────┐
│ Renderer  (React 19, sandboxed, contextIsolation, CSP, no Node)                    │
│   window.airdesk = { invoke, exportPdf, exportCsv, pickBackupFile }  ← preload     │
│        │ IPC: airdesk:invoke · airdesk:export · airdesk:pick-backup                │
│ Main process (Electron 44)                                                         │
│   trusted-sender check · session bound per WebContents (renderer never sees it)    │
│   save/open dialogs · PDF (printToPDF) · automatic-backup timer · single instance  │
│        │ AppBackend.dispatch({ command, payload, sessionId, workstation })         │
│ Backend (packages/backend, transport-agnostic)                                     │
│   zod contract validation → session → access rule → service → domain → SQLite      │
│   Services: auth, users/roles, company, customers, suppliers, airlines,            │
│             reference (airports, money accounts, expense categories, currencies),  │
│             bookings (ticket records), finance (payments, refunds, transfers,      │
│             openings, credit application, cancellations), operations (schedule     │
│             changes, notifications, travel), reports, ledger query, posting        │
│   Cross-cutting: AuditLog (hash chain), PostingService (only writer of money),     │
│             backup/restore, integrity checks, migrations                           │
│ Domain (packages/domain, pure TypeScript, no I/O)                                  │
│   money & FX, ledger (documents, posting rules P1–P12, journal validation,         │
│   reversal), state machines, validation, permissions & roles                       │
│ SQLite (better-sqlite3-multiple-ciphers; WAL; synchronous=FULL; STRICT tables;     │
│   FTS5 trigram search index) — %ProgramData%\AirDesk\data\airdesk.db               │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Packages: `packages/domain` (pure rules), `packages/contracts` (zod command schemas + DTO types shared by UI and backend), `packages/backend` (services, database, backup), `apps/desktop` (Electron main, preload, React renderer, E2E).

## 2. Request path

1. The renderer calls `window.airdesk.invoke('payments.receive', payload)`.
2. The main process rejects untrusted senders, attaches the session id it holds for that window and the workstation name.
3. `dispatchCommand` validates the payload against the strict zod schema (unknown keys rejected), resolves the session (idle/absolute timeouts), and evaluates the command's declared access rule. Every contract command must declare one (tested); only `system.status`, `system.setup` and `auth.login` are public.
4. The service re-checks the precise permission (`requirePermission`, audited when denied) **before** opening a transaction, applies row-level scoping (`accessible()`), runs domain validation, and writes inside one SQLite transaction together with its audit record.
5. Money never moves outside `PostingService.post/reverse`: price → validate → build journal → validate journal → insert document, lines, journal → seal (database trigger re-checks balance) → audit.
6. Responses are DTOs with server-side redaction (cost/profit/supplier/identity fields are `null` without permission).

## 3. Key invariants (enforced in more than one layer)

| Invariant | Where |
|---|---|
| Balances are derived, never stored | No balance columns (tested with `PRAGMA table_info`); all positions/statements/aging/reports query the journal. |
| Posted money is immutable | `fin_document`, lines, journal: UPDATE/DELETE rejected by triggers; corrections are reversals/adjustments. |
| Every journal balances in base currency | Domain `validateJournal`, DB seal trigger, integrity check INV-1/INV-2. |
| History is never deleted | No-delete triggers on tickets, airports, expense categories, cancellations, schedule changes, notifications; archive instead of delete. |
| Authorization is server-side | Dispatcher access rules + service `requirePermission` + scoping + redaction. |
| Audit is one system | `AuditLog.append` in the same transaction; SHA-256 chain verified by integrity check. |

## 4. Scope boundary (important)

AirDesk is a **record-management** system for ticket offices. Ticket records store the PNR, ticket numbers, flights, supplier, purchase cost and customer price of transactions made in a GDS/airline portal/consolidator. There is no flight search, availability, seat reservation, PNR creation, ticket issuance, and no connection to any GDS, airline or consolidator system. "Confirm ticketed" records that the ticket was issued elsewhere and posts the sale and purchase.

## 5. External integrations

| Integration | Status |
|---|---|
| WhatsApp | **Implemented as a link only**: opens `https://wa.me/<number>?text=<message>` in the user's browser/WhatsApp. No messages are sent by AirDesk. |
| Notification providers (SMS, e-mail, WhatsApp Business API) | **Not implemented.** `ProviderRegistry` exposes the channel abstraction; no provider is configured and none is claimed. Notifications are recorded as MANUAL with the outcome entered by the user. |
| GDS / airline / consolidator APIs | **Not implemented, out of scope.** |
| E-invoicing / tax authority (ETA, ZATCA) | **Not implemented.** The generic document model (numbered, immutable, with tax number and invoice title/terms on prints) is the foundation. |
| Online updates | **Not implemented** (offline installer only; `publish: []`). |
| Code signing | **Configured-not-connected**: electron-builder writes version resources; signing requires a certificate in the release workflow. |

## 6. Multi-PC

Not built. The backend is transport-agnostic so a LAN primary/client mode can reuse the same dispatcher ([deployment-architecture](../phase-1/deployment-architecture.md)). Sharing the database file over the network is refused by design.
