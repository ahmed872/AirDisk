# Phase 1 — Foundation & Core Domain: Completion Report

**Status:** complete, except the silent install on clean Windows, which is still pending
(see §9). **Date:** 2026-09-28.
**Scope source:** the owner decisions Q1–Q13 and the Phase 1 brief. The Phase 0 financial
model is preserved unchanged.

Related design documents:
[deployment-architecture.md](deployment-architecture.md) (Q1: single PC now, primary/client later) ·
[encryption-and-keys.md](encryption-and-keys.md) (Q7: keys, recovery, no backdoor).

---

## 1. What was built

```
AirDesk/
├─ packages/domain      pure TS: money, currency, exchange, journal, documents,
│                       posting rules, reversal, periods, permissions, password policy
├─ packages/contracts   command names + zod input schemas + DTO types (shared with UI)
├─ packages/backend     SQLite driver, migrator, migration 0001, seed, audit log,
│                       services (auth, users/roles, company, currency, posting,
│                       ledger queries), integrity checks, backup/restore,
│                       command dispatcher, AppBackend composition root
├─ apps/desktop         Electron main (hardened window, IPC gateway, file logger,
│                       smoke-test mode), preload bridge, React renderer
│                       (setup, login, password change, company settings, users,
│                       system/backup), NSIS packaging
└─ .github/workflows/ci.yml   Linux: typecheck, lint, tests+coverage, Electron smoke, UI E2E
                              Windows: tests, installer, silent install, packaged smoke, uninstall
```

| Requirement | Where |
|---|---|
| 1 Project structure | pnpm workspace; layering enforced by lint rules (domain can't import I/O; renderer can't import backend/Node) |
| 2 Electron shell | `apps/desktop/src/main/index.ts`, `security.ts` |
| 3 TypeScript | strict + `noUncheckedIndexedAccess`, `tsconfig.base.json` |
| 4 React frontend | `apps/desktop/src/renderer` (Arabic RTL default, English) |
| 5 SQLite layer | `backend/src/db/connection.ts` (WAL, `synchronous=FULL`, FK on, STRICT tables) |
| 6 Migrations | `backend/src/db/migrator.ts`, `migrations/0001_initial.sql` |
| 7 Core domain | `packages/domain` |
| 8 Data access | parameterised SQL in services/repositories; driver isolated in `db/driver.ts` |
| 9 Application layer | `backend/src/services/*`, `app/dispatcher.ts` |
| 10 Authentication | `services/auth-service.ts`, `session-manager.ts`, `security/password-hasher.ts` |
| 11 RBAC | `domain/security/permissions.ts`, `services/user-service.ts`, dispatcher access rules |
| 12 Company settings | `services/company-service.ts`, `services/settings.ts` |
| 13 Audit logging | `audit/audit-log.ts` (append-only, hash chain, same transaction) |
| 14 Ledger foundation | `domain/ledger/*`, `services/posting-service.ts`, `services/ledger-query-service.ts` |
| 15 Error handling | `domain/errors.ts` stable codes; dispatcher masks unexpected errors |
| 16 Logging | `util/logger.ts` (secret redaction), `desktop/main/file-logger.ts` (daily files, 14 days) |
| 17 Tests | Vitest + fast-check; Playwright E2E for Electron |
| 18 Build | `electron-vite` |
| 19 Windows packaging | `electron-builder.yml`, `build/installer.nsh` |

## 2. Database migrations

| Version | File | Content |
|---|---|---|
| 1 | `packages/backend/src/db/migrations/0001_initial.sql` | Full Phase 0 schema: 40 tables, 1 FTS5 virtual table, 21 integrity triggers, 5 read-model views. |

* **Migration runner:** forward-only, contiguous numbering, SHA-256 checksum per migration.
  * All pending migrations run in **one transaction**, with a foreign-key check before commit.
  * It refuses to start on a checksum mismatch or on a database newer than the app.
  * On upgrades it takes a verified **PRE_MIGRATION backup** first.
* **Financial tables match Phase 0.** `fin_document`, `fin_document_line`, `journal_entry`
  and `journal_line` are identical to the validated Phase 0 DDL, ignoring comments.
  This was checked mechanically.
* **System data is seeded idempotently** from the domain constants (one source of truth).
  This covers 23 accounts, 6 currencies, 77 permissions, 4 system roles and 8 expense
  categories. Drift in a system account is reported as an integrity failure; it is never
  silently "fixed".

## 3. Test results (exact)

Commands: `pnpm typecheck` · `pnpm lint` · `pnpm test:coverage` · `pnpm build` ·
Electron smoke · `pnpm e2e` · `electron-builder --win nsis --x64`.

| Check | Result |
|---|---|
| Typecheck (4 packages) | **0 errors** |
| ESLint | **0 problems**. Custom rules were confirmed to fire on an injected SQL-interpolation violation and on a `node:fs` import inside `domain`. |
| Unit + integration tests | **124 passed / 0 failed**, 12 files |
| Coverage | lines **96.49 %**, statements 93.18 %, functions 94.04 %, branches 85.79 % |
| Phase 0 schema validation script (re-run) | **28/28 passed** |
| Electron 44 smoke test (Linux, real runtime) | **7/7 steps ok**: open+migrate · setup · login · post · backup · restore · integrity |
| Packaged **Windows** `AirDesk.exe` smoke test (run under Wine) | **7/7 steps ok**, `platform: win32`, using the Windows SQLite/Argon2 binaries from inside the asar |
| UI E2E (Playwright driving Electron) | **passed** |
| Windows NSIS installer build | **success**: `AirDesk-Setup-0.1.0-x64.exe`, 122,541,983 bytes |
| Silent install on clean Windows | **not verified here.** See §9. |

The UI E2E run covered:

* The setup wizard, rendered right-to-left.
* That the renderer has no Node access, and that the only bridge function is `invoke`.
* A rejected login showing the Arabic error message, then a successful login.
* The Company settings page.
* A backup (validated `.adbk` file) and an integrity check with all checks passing.
* Switching the language to English (the layout changes to left-to-right).
* A restore call made directly through the bridge, which the backend rejected because it
  re-verifies the password.

### Tests per file

| File | Tests | Covers |
|---|---|---|
| `domain/test/money.test.ts` | 18 | minor units, parsing (Arabic digits), overflow, currency mismatch, property round-trip |
| `domain/test/exchange.test.ts` | 7 | rate parsing, half-up conversion, KWD 3-decimals, properties |
| `domain/test/ledger.test.ts` | 17 | balancing, dimensions, every posting rule, Cases A–D/E/G/H, settlement never touches P&L (property), reversal |
| `domain/test/security-and-time.test.ts` | 9 | permission catalogue, Q5 defaults, password policy, business dates, lock periods |
| `backend/test/migrations.test.ts` | 11 | fresh build, idempotency, checksum, downgrade guard, rollback on failure, pragmas, UNC refusal, seed drift, pre-migration backup |
| `backend/test/auth.test.ts` | 10 | setup-once, Argon2id only, lockout/unlock, uniform errors, idle expiry, forced password change, disabled users |
| `backend/test/rbac.test.ts` | 9 | every command has an access rule (only 3 public), no generic posting over IPC, Case M, live role changes, custom roles, last-admin guard |
| `backend/test/posting.test.ts` | 20 | Phase 0 regression Cases A, B, C, D/E/G, F/K, H, L, instalments, expenses, invariants; locks, backdating, immutability, idempotency, base-currency freeze |
| `backend/test/audit-backup.test.ts` | 8 | hash chain + tamper detection, backup validation, restore round-trip, corrupt/garbage/newer backups, crash-safe restore recovery |
| `backend/test/services-extra.test.ts` | 10 | typed settings, user admin, rates, failed-backup recording, error masking |
| `backend/test/encryption.test.ts` | 1 | SQLCipher: unreadable without key, wrong key refused |
| `desktop/test/security-config.test.ts` | 4 | Electron hardening flags, external-link allow-list, CSP, data directory |

## 4. Financial integrity review

* **One write path.** `PostingService` is the only code that writes to the ledger. Each
  document is posted in ONE transaction, in this order:
  1. number the document,
  2. write the document and its lines,
  3. write the journal,
  4. seal the journal (the database re-checks the balance at this point),
  5. write the audit record,
  6. write the idempotency record.
* **Profit never depends on cash.** Posting rules send receipts, payments and refunds only
  to cash and AR/AP accounts. A property test proves this for random inputs (INV-5), and
  Case C shows the gross profit is identical before and after a supplier payment.
* **Supplier payments are never expenses.** Case C asserts that expenses stay at 0.
* **Balances are never stored.** They are views over the journal. Every figure listed in
  Q11 is computed for any date range from the immutable journal
  (`ledger.summary`, `ledger.trialBalance`).
* **Worked results reproduce exactly** through the real service and the real database:
  * Case A: GP 400.
  * Case B: receivable 5,500.
  * Case C: payable 5,100.
  * Cases D/E/G: GP 200, cash 200, September +400 / October −200.
  * Case H: USD payable cleared in USD, FX −100 below gross profit, net profit 300.
  * Case L: supplier S1 owes us 4,000; supplier S2 is owed 10,000.
* **Documents without a posting rule yet are refused** with `UNSUPPORTED_DOCUMENT`
  (`MONEY_TRANSFER`, `BALANCE_APPLICATION`, `OPENING_BALANCE`, `FX_ADJUSTMENT`), rather
  than being approximated. The schema already supports them.

## 5. Database integrity review

* **The database enforces rules even if app code is buggy.** `STRICT` types, `CHECK`s,
  foreign keys and 21 triggers cover:
  * immutable documents, lines, journal and audit rows;
  * sealing only a balanced journal entry;
  * the lock date;
  * the shape of reversals, and at most one reversal per document;
  * a frozen base currency;
  * no deletion of customers, suppliers, users, money accounts or accounts.
* **Durability:** WAL + `synchronous=FULL`.
* **Integrity checks run at startup, after a restore and on demand.** They cover SQLite
  integrity, foreign keys, INV-1/2/3/4/7/9, and the audit hash chain.
* **Backups are verified by restoring them.** A backup counts as valid only after it is
  re-read, hash-checked, decompressed and integrity-checked.
* **Restores are safe.** Each restore takes a PRE_RESTORE safety backup, swaps files
  atomically and is crash-recoverable through a marker file (tested).

## 6. Security review

| Area | Status |
|---|---|
| Passwords | Argon2id (production: m=64 MiB, t=3). Tests prove plaintext never reaches the DB file or the audit log. No default account; setup is possible only once. |
| Login abuse | 5 failures → 15-minute lock. Unknown user and wrong password return the same error, with a timing-equalising dummy verification. Every attempt is audited. |
| Sessions | Held only in the main process, never by the renderer; idle 15 min and absolute 12 h (configurable). Permissions are re-read on every request, so disabling a user kicks their session immediately. |
| Authorization | Deny by default. Every command declares an access rule, and a test enforces it (only `system.status`, `system.setup` and `auth.login` are public). Services re-check permissions. Denials are audited outside the rolled-back transaction. Generic ledger posting is **not** exposed to the renderer. |
| Sensitive data (Q5) | The Sales Agent role can enter cost but receives neither `booking.view_cost` nor `booking.view_profit`. Field redaction arrives with the booking DTOs in Phase 3. |
| Input | zod `.strict()` schemas on every command (unknown fields rejected). Parameterised SQL only; a lint rule forbids interpolation into `prepare()`. |
| Electron | contextIsolation, sandbox, no nodeIntegration, CSP, navigation/window-open blocked, external-link allow-list, permission requests denied, single IPC channel with sender check. Fuses: RunAsNode off, NODE_OPTIONS off, inspect off, ASAR integrity, only load from ASAR. |
| Audit | Append-only (triggers) and SHA-256 hash-chained; tampering is detected (tested). |
| Encryption (Q7) | Driver capability verified. Key wrapping (DPAPI + recovery passphrase) is specified and scheduled for Phase 10. No backdoor or master key exists in code. |
| Errors / logs | Unexpected errors are masked for the client and logged locally; secrets are redacted before logging or auditing. |

## 7. Deviations from Phase 0

Each deviation below is deliberate. None of them change the financial model.

| # | Phase 0 said | Phase 1 did | Why |
|---|---|---|---|
| 1 | Drizzle as query builder, with parameterised SQL as fallback (§07-5.3) | **Fallback used**: parameterised SQL on `better-sqlite3` | Hand-reviewed SQL migrations are the single schema source. No second schema definition to drift; synchronous transactions stay trivial. |
| 2 | Native module rebuild per Electron ABI (R10) | **Not needed** | Driver v13 and Argon2 ship N-API prebuilds for win32-x64. The packaged Windows exe was verified. |
| 3 | `electron-log`, i18next, Tailwind/Radix, TanStack Router/Query | Own redacting file logger; typed i18n dictionaries (a compile-time error if a translation key is missing); plain CSS with logical properties | Phase 1 has only 6 screens. The UI toolkit decision moves to Phase 2, when real forms and grids arrive. |
| 4 | Seeds as SQL in the schema | Seeded from domain constants, idempotently, with drift detection | One source of truth for accounts, permissions and roles. |
| 5 | — | Added `command_log` (idempotency, specified in Phase 0 §07-1.2) and `tax_code` (Q4 tax foundation) | New owner decisions. |
| 6 | — | New permission `finance.unlock_period` | The Phase 0 matrix said "Accountant: lock ✔, unlock ✘"; it needed its own code. |
| 7 | Contracts depend only on zod | Contracts also import pure constants from `domain` | Error and permission codes have one definition. `domain` still has no I/O (enforced by lint). |
| 8 | Idle → screen lock that preserves the open form | Idle → session expires → sign in again | Simpler and safe for Phase 1. Form-preserving lock arrives with the real data-entry screens (Phase 3). |
| 9 | Versions (unspecified) | Electron **44.4.5** (pinned), Vite 7 (electron-vite 5 caps at 7), Vitest 5, TypeScript 5.9 (typescript-eslint does not support TS 7 yet), zod 4 | Latest compatible set. |

## 8. Owner decisions → implementation

| Q | Implementation in Phase 1 |
|---|---|
| Q1 | Transport-agnostic `AppBackend.dispatch`. Network DB paths refused. Primary/client LAN design documented (not built). |
| Q2 | Revenue posts only through `CUSTOMER_INVOICE`, which the booking *issue* command will call in Phase 3. The booking statuses exist in the schema. |
| Q3 | Receivables and customer credits are first-class, per customer per currency. `payment_terms_days` and `due_date` columns exist. Unpaid balances are never cash. |
| Q4 | `tax_code` table and company tax fields exist; market-neutral currencies and time zones. No e-invoicing. |
| Q5 | Configurable roles; Sales Agent can enter cost but can't view it; ADMIN always has everything. |
| Q6 | Passengers, segments and tickets in the schema (Phase 3 UI). |
| Q7 | Encryption-capable driver (tested); key and recovery design with no backdoor. |
| Q8/Q9 | Immutable documents and journal, reversal-only corrections, append-only hash-chained audit, no-delete triggers. |
| Q10 | Generic document engine; airline-specific data lives only in booking tables. |
| Q11 | `ledger.summary` for any date range, from the journal only. |
| Q12 | Manual backups, history (DB + sidecar), validation-by-restore, safe restore, pre-migration backups. Automatic scheduling is Phase 10. |
| Q13 | Everything company-specific comes from `company_profile`; nothing is hard-coded. |

## 9. Known limitations (carried forward, none blocking Phase 2)

1. **Silent install on clean Windows is not yet verified.**
   * The installer is built, and the packaged app passes the full smoke test on Windows
     binaries.
   * Under Wine, the installer's silent mode exits with code 2; the interactive run just
     waits on its window. I suspect the elevation (UAC) relaunch fails under Wine, but I
     haven't proven it.
   * The CI `windows` job installs silently on a real Windows runner, runs the packaged
     smoke test and verifies that uninstall keeps the data. **Its result must be checked
     before Phase 1 is formally closed.**
2. The installer is **unsigned** (SmartScreen will warn) and uses the default Electron
   icon. Code signing and branding are Phase 10.
3. Automatic/scheduled backups, retention, a secondary backup destination and encrypted
   backups are Phase 10. In Phase 1, backup and restore are manual.
4. The LAN primary/client mode is designed but not built.
5. Mapped network drives are not detected yet; only UNC paths are refused.
6. The rule "cannot reverse a receipt that was already refunded" (Phase 0 §05-3) needs
   allocation tracking, so it moves to Phase 4.
7. The UI has no screens yet for logo upload, tax codes, exchange rates, role editing or
   session settings. The backend commands for rates, roles and settings exist; logo and
   tax-code storage exist in the schema.
8. The renderer bundle is 677 kB because zod and domain constants are shared; it is
   loaded locally, so there is no practical impact. The package also contains non-Windows
   prebuilds of the native modules (a few MB); these can be trimmed.
9. Branch coverage is 85.8 %, below the 90 % target for services. Most uncovered branches
   are defensive error paths. Raising it continues in Phase 2.

## 10. How to reproduce

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test:coverage
pnpm build
xvfb-run -a node_modules/electron/dist/electron apps/desktop --no-sandbox --smoke-test=/tmp/smoke.json
xvfb-run -a pnpm e2e
cd apps/desktop && npx electron-builder --win nsis --x64 --publish never   # needs wine (+ wine32) on Linux
```

**Phase 2 has not been started.**
