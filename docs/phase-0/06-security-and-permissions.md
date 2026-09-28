# 06 — Security Model & Permission Matrix

Covers report sections **8. Security Model** and **9. Permission Matrix**.

---

## 1. Threat model (what we defend against)

| Threat | Example | Primary controls |
|---|---|---|
| Unauthorised employee action | Agent reverses a receipt to pocket cash | RBAC enforced in the backend, audit log, reversals visible in reports |
| Snooping on sensitive data | Agent reads profit margins or passport numbers | Field-level redaction in the backend DTOs (UI never receives the data) |
| Record tampering to hide fraud | Editing a past payment amount | Immutable financial rows (triggers), hash-chained audit log, lock date |
| Stolen/lost PC or copied DB file | Laptop theft | Optional SQLCipher encryption at rest (Q7), Windows account, backups encrypted |
| Malicious/corrupt backup file | Restoring a crafted or damaged file | Manifest + SHA-256 + integrity_check on a temp copy before swap |
| Injection | Search box `' OR 1=1`, FTS syntax abuse, CSV formula injection | Parameterised queries only, FTS query escaping, export cell escaping |
| Renderer compromise (XSS) | Malicious text in a customer name rendered as HTML | React escaping, strict CSP, sandboxed renderer, no Node in renderer, IPC allow-list |
| Supply chain / update tampering | Fake update binary | Code-signed installers, signed update metadata, locked dependency versions, `pnpm audit` in CI |
| Brute-force login | Guessing the admin password | Argon2id, lockout, no default passwords |
| Data loss | Disk failure, ransomware, power loss | `synchronous=FULL`, automatic backups with off-machine copy reminders |

Out of scope: an attacker with administrator rights on the Windows machine *and* the
encryption key (can do anything); network attacks (no network service in v1).

## 2. Authentication

- Local accounts only (v1). Username + password.
- **Argon2id** (`@node-rs/argon2`), parameters tuned so hashing takes ~250–400 ms on a
  low-end office PC (starting point m = 64 MiB, t = 3, p = 1); parameters are stored in the
  PHC string so they can be raised later with rehash-on-login.
- Password policy: min 10 chars, not equal to username, checked against a small bundled
  list of common passwords. No forced periodic rotation (NIST 800-63B).
- **First run**: setup wizard creates the Admin account with a password chosen by the
  installer — there is no default password anywhere.
- Lockout: 5 consecutive failures → 15 min lock (configurable); every failure is audited
  (`auth.login_failed`, without the attempted password).
- Admin password reset of another user sets `must_change_password = 1`.
- Account recovery if the only Admin forgets the password: offline **recovery code**
  generated at setup (shown once, to be printed and stored), which allows resetting the
  Admin password. Without it, vendor support cannot recover access — by design.

## 3. Sessions

- Session lives in the backend (main process) memory: random 256-bit id bound to the
  renderer's `webContents`. The renderer never holds credentials.
- Idle screen-lock after N minutes (default 15) → password re-entry; unsaved form state is
  kept. Hard logout after M hours (default 12).
- **Step-up re-authentication** (password again) for: restore, user/role management,
  moving the lock date back, changing base currency (pre-posting only), exporting full
  data.
- Sessions recorded in `user_session` (start, end, reason, workstation).

## 4. Authorisation

- **Deny by default.** Every backend command is registered with the permissions it
  requires; a CI test enumerates the command registry and fails if any command has no
  permission declaration.
- **Single enforcement point**: the command dispatcher checks permissions before the
  handler runs. The UI hides what you cannot do, but that is convenience only.
- **Field-level redaction**: DTO mappers drop `cost`, `profit`, `supplier balance`,
  identity documents, etc. when the session lacks `booking.view_cost`,
  `booking.view_profit`, `customer.view_identity`… The renderer never receives them.
- **Row-level option**: `booking.view_all` vs. own bookings only (sales agent sees
  bookings where `sales_agent_id = me`) — configurable per role.
- **Thresholds** (future-ready): e.g. refund above X requires `refund.approve_large`.
- Roles are data; permissions are code constants seeded into `permission`. Admins can
  create custom roles from the permission list. System roles can be cloned, not deleted.
- The last active Admin cannot be removed.

## 5. Permission catalogue

| Module | Permission | Sensitive |
|---|---|---|
| Customers | `customer.view`, `customer.create`, `customer.edit`, `customer.deactivate` | |
| | `customer.view_identity` (passport / national ID) | ✔ |
| Bookings | `booking.view`, `booking.view_all`, `booking.create`, `booking.edit`, `booking.issue`, `booking.reserve`, `booking.discard` | |
| | `booking.enter_cost`, `booking.view_cost`, `booking.view_profit` | ✔ |
| | `booking.adjust_price`, `booking.change_supplier`, `booking.sell_below_cost`, `booking.zero_price`, `booking.reissue`, `booking.void` | ✔ |
| Schedule | `schedule.change`, `schedule.notify`, `schedule.confirm` | |
| Customer money | `payment.customer.receive`, `payment.customer.reverse`, `payment.customer.refund`, `payment.accept_overpayment`, `balance.apply` | ✔ (except receive) |
| Suppliers | `supplier.view`, `supplier.manage`, `supplier.view_balance` | |
| Supplier money | `payment.supplier.pay`, `payment.supplier.reverse`, `payment.supplier.record_refund` | ✔ |
| Refunds | `refund.request`, `refund.manage`, `refund.customer_before_supplier` | ✔ |
| Expenses | `expense.view`, `expense.create`, `expense.reverse`, `expense.category.manage` | ✔ |
| Treasury | `treasury.view`, `treasury.transfer`, `treasury.manage_accounts`, `treasury.owner_movements` | ✔ |
| Finance admin | `finance.backdate` (date older than N days within open period), `finance.lock_period`, `finance.opening_balances`, `finance.exchange_rates`, `finance.override_rate` | ✔ |
| Dashboard | `dashboard.operational`, `dashboard.financial` | ✔ (financial) |
| Reports | `report.sales`, `report.purchases`, `report.profit`, `report.receivables`, `report.payables`, `report.supplier_performance`, `report.statements`, `report.expenses`, `report.refunds`, `report.schedule_changes`, `report.employee_activity`, `report.export` | ✔ (financial ones) |
| Reference | `airline.manage`, `airport.manage`, `template.manage` | |
| Admin | `user.manage`, `role.manage`, `settings.company`, `settings.system`, `audit.view`, `backup.create`, `backup.restore`, `integrity.run` | ✔ |

## 6. Default permission matrix

✔ granted · ✘ not granted · ◐ restricted variant (explained below)

| Permission group | Admin | Manager | Accountant | Sales Agent |
|---|---|---|---|---|
| Customers: view/create/edit | ✔ | ✔ | ✔ view only | ✔ |
| Customers: view identity | ✔ | ✔ | ✘ | ✔ |
| Bookings: view | ✔ all | ✔ all | ✔ all | ◐ own (configurable to all) |
| Bookings: create/edit/reserve/issue | ✔ | ✔ | ✘ | ✔ |
| Bookings: enter cost | ✔ | ✔ | ✔ | ✔ (Q5) |
| Bookings: view cost / view profit | ✔ | ✔ | ✔ | ✘ (Q5) |
| Bookings: adjust price / change supplier / reissue | ✔ | ✔ | ✘ | ✘ |
| Bookings: sell below cost / zero price | ✔ | ✔ | ✘ | ✘ |
| Bookings: void | ✔ | ✔ | ✘ | ✘ |
| Schedule: change / notify / confirm | ✔ | ✔ | ✘ | ✔ |
| Customer receipts: receive | ✔ | ✔ | ✔ | ✔ |
| Customer receipts: reverse | ✔ | ✔ | ✔ | ✘ |
| Customer refunds (cash out) | ✔ | ✔ | ✔ | ✘ |
| Accept overpayment / apply balance | ✔ | ✔ | ✔ | ◐ apply own bookings only |
| Suppliers: view / manage | ✔ | ✔ view | ✔ | ◐ names only (for selection) |
| Supplier payments / reversals / refunds | ✔ | ✘ | ✔ | ✘ |
| Refund workflow: request | ✔ | ✔ | ✔ | ✔ |
| Refund workflow: manage (confirm amounts, credit customer) | ✔ | ✔ | ✔ | ✘ |
| Refund customer before supplier | ✔ | ✔ | ✘ | ✘ |
| Expenses: create / reverse / categories | ✔ | ✘ view | ✔ | ✘ |
| Treasury: view / transfer / owner movements | ✔ | ✔ view | ✔ (owner movements ✘) | ✘ |
| Finance admin: lock period, opening balances, rates | ✔ | ✘ | ✔ (lock ✔, unlock ✘) | ✘ |
| Dashboard operational | ✔ | ✔ | ✔ | ✔ |
| Dashboard financial | ✔ | ✔ | ✔ | ✘ |
| Reports: sales / schedule changes | ✔ | ✔ | ✔ | ◐ own sales, no cost/profit columns |
| Reports: purchases, profit, payables, supplier performance, expenses | ✔ | ✔ | ✔ | ✘ |
| Reports: receivables, statements | ✔ | ✔ | ✔ | ◐ customer statements only |
| Reports: employee activity | ✔ | ✔ | ✘ | ✘ |
| Export | ✔ | ✔ | ✔ | ✘ |
| Users / roles / company & system settings | ✔ | ✘ | ✘ | ✘ |
| Audit log view | ✔ | ✔ | ✘ | ✘ |
| Backup create | ✔ | ✔ | ✔ | ✘ |
| Backup restore | ✔ | ✘ | ✘ | ✘ |

## 7. Audited actions (minimum set)

`auth.login`, `auth.logout`, `auth.login_failed`, `auth.locked`, `auth.password_changed`,
`auth.permission_denied`, `user.*`, `role.*`, `settings.*`, `customer.create/update/deactivate`,
`supplier.create/update/deactivate`, `booking.create/update/status_changed/issue/void`,
`booking.price_adjusted`, `booking.supplier_changed`, `booking.reissued`,
`segment.schedule_changed`, `notification.sent/failed/confirmed`, `document.posted`,
`document.reversed`, `cancellation.*`, `expense.*`, `treasury.*`, `period.locked/unlocked`,
`rate.*`, `backup.created/failed`, `backup.restored`, `export.performed`,
`integrity.check_run`.

Each record: user, session, workstation, action, entity type/id, timestamp, before JSON,
after JSON, metadata (e.g. reason, amount, IP-less device info), `prev_hash`, `hash`.
Audit rows are written **in the same transaction** as the change, so an action can never
succeed without its audit record (and vice versa). Verification of the hash chain is part
of the integrity check and of backup validation.

## 8. Data protection

| Concern | Control |
|---|---|
| Passwords | Argon2id only; never logged; never in backups in plaintext (hashes only). |
| DB at rest | SQLCipher AES-256 (Q7). Data key random; wrapped by Windows DPAPI (Electron `safeStorage`) for daily unlock and by the Admin recovery passphrase (Argon2id-derived) for disaster recovery. |
| Backups | Encrypted with the same data key (or a backup password), AES-256-GCM, with manifest. |
| Integration secrets (future WhatsApp/SMS API keys) | Stored encrypted via `safeStorage`, never in plain settings. |
| Logs | Rotating local logs contain IDs and error codes, never passwords, full passport numbers or payloads. |
| Printing | Receipts/invoices never print cost or profit. |
| Exports | Permission-gated, audited; CSV/XLSX cells beginning with `= + - @` or tab/CR are prefixed to prevent formula injection. |
| Data folder | `%ProgramData%\AirDesk\` with ACL restricted to local Users/Administrators; path must be a local fixed disk. |

## 9. Input validation & injection prevention

- zod schemas at the IPC boundary for every command (strings trimmed, max lengths,
  enums, ISO dates, integer money, E.164 phones, IATA codes `^[A-Z]{3}$`, ticket numbers
  `^\d{13}$`, PNR `^[A-Z0-9]{5,8}$` after normalisation).
- All SQL through the query builder or tagged templates with bound parameters. A lint
  rule forbids string concatenation into SQL; raw SQL is reviewed.
- FTS5 `MATCH` input is tokenised and each token double-quoted (escaping embedded quotes)
  — user text never becomes FTS syntax.
- HTML print templates render through React/escaped templates only.

## 10. Electron hardening checklist (enforced by a test that inspects BrowserWindow options)

`contextIsolation: true` · `sandbox: true` · `nodeIntegration: false` ·
`webSecurity: true` · no `remote` module · strict CSP (`default-src 'self'`, no
`unsafe-eval`) · all content loaded from the packaged app (no remote URLs) · navigation and
`window.open` blocked · `shell.openExternal` allow-listed to `https://wa.me/`, `mailto:`,
`tel:` · preload exposes one typed `invoke(command, payload)` · Electron fuses:
`RunAsNode` off, `EnableNodeCliInspectArguments` off, ASAR integrity on,
`OnlyLoadAppFromAsar` on.
