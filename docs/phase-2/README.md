# Phase 2 — Company, Identity & Master Data: Completion Report

**Status:** Complete. Waiting for owner review. Phase 3 has **not** been started.
**Branch:** `claude/loving-rubin-kyf18y` · **Commits:** `91d93e8` (backend), `efaa624` (UI, E2E, CI), plus this report.
**Builds on:** Phase 1 (approved and closed). Phase 1 was not reopened, and the Phase 0 financial model was not changed.

---

## 1. Executive summary

AirDesk now has everything a travel agency needs before it can record its first booking:

- a configurable company profile;
- a safe first-run setup;
- users and custom roles with granular permissions;
- customers, suppliers and airlines with search, duplicate warnings and archiving.

It all works in Arabic (RTL, primary) and English (LTR).

- **Authorization is enforced in the backend.** Every command is checked there; hiding menus in the UI is only a convenience.
- **Audit uses the existing chain.** Every change is written to the Phase 1 hash-chained audit log in the same transaction as the change.
- **Balances are derived.** There are no stored balance columns; customer and supplier balances come from the immutable journal.
- **Nothing is deleted or merged.** Records are archived, and possible duplicates only produce a warning.

**Results:**

| Check | Result |
|---|---|
| Automated tests | 176 / 176 passed |
| 20-step E2E in real Electron | 20 / 20, including an app restart |
| Phase 0 financial validation | 28 / 28 |
| Coverage | 97.3% lines, 88.1% branches |
| Typecheck and lint | clean |
| Linux CI | green |
| Windows CI | results in §14 |

## 2. Features implemented

| Area | Delivered |
|---|---|
| **Company configuration** | Legal and trade names (ar/en), logo (PNG/JPEG ≤ 512 KB), addresses, phones, e-mail, website, country, time zone, base currency, tax/CR/IATA agency numbers, invoice title and terms (ar/en), document footers, default language, date format (DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD), number format (Latin or Arabic-Indic digits) and interface direction (follow language, RTL or LTR). The formats are applied across the app. Three sections (general, branding, financial) each need their own permission. The base currency locks once financial postings exist. |
| **First-run setup** | Company, base currency and first Admin are created in a single transaction. If it fails half-way, nothing is created and setup can be retried. The setup screen is only offered while no user exists; `system.setup` is refused afterwards (`SETUP_ALREADY_DONE`). Setup shows its steps (1/2 company and currency, 2/2 administrator) and confirms completion on the login screen. There is no default or hidden account. |
| **Users** | ID, username, display name, e-mail, mobile (normalized), status (Active / Locked / Disabled), roles, created/updated, last login, notes. Admins can create, edit, disable/enable, unlock and reset passwords (the user must change a reset password at next sign-in). Passwords are stored only as Argon2id hashes. Disabled users cannot log in, and their live sessions end immediately. |
| **Roles and permissions** | Four default roles (Admin, Manager, Accountant, Sales Agent) plus custom roles. Users & Roles screen: view, create and rename roles; a permission matrix grouped by module with sensitive permissions marked; assign roles to users (several per user). Changes take effect on the very next request. |
| **Protections** | Last active Admin (`LAST_ADMIN`); self-lockout, i.e. disabling yourself or removing your own Admin role (`SELF_LOCKOUT`); the Admin role always holds all permissions; privilege escalation, i.e. granting permissions or roles you don't hold (`ESCALATION`); system roles cannot be deleted (DB trigger). |
| **Customers** | Customer number (C-000001…), individual/company, name (plus Latin name), primary and secondary mobile, WhatsApp, e-mail, address, nationality, national ID, passport number and expiry, date of birth, preferred language, payment terms, notes. Search by name (Arabic-aware), any phone fragment in any format, e-mail or number. Filter Active/Archived/All; sort by number, name, created or updated; paging. Identity fields are hidden without `customer.view_identity`. |
| **Suppliers** | Supplier number (S-…), name, contact person, two phones, e-mail, address, country, default currency, payment terms, optional linked airline (a supplier is **never** treated as the airline), notes. Same search, filter and sort. Balances are shown only with `supplier.view_financial`. |
| **Airlines** | English/Arabic name, IATA (2 characters) and ICAO (3 letters) codes, unique among **active** airlines; 3-digit ticket prefix, country, phone, e-mail, website, notes; status. |
| **Duplicate detection** | Warning only (`DUPLICATE_WARNING`). Signals: same phone, same e-mail, similar name plus similar phone, and (for suppliers and airlines) same name. The user either goes back or deliberately saves a separate record; that choice is audited. **Nothing is ever merged automatically.** |
| **Archiving** | Records are ACTIVE or ARCHIVED; deleting customers, suppliers and airlines is blocked by triggers. Archived records are read-only until restored. The archive reason is audited, and financial history is untouched. |
| **Financial parties** | No `balance` columns. Balances per currency are read from the journal views (`v_customer_balance`, `v_supplier_balance`) and labelled "derived from the journal". |
| **App shell** | Operations: Dashboard, Customers, Suppliers, Airlines, plus Bookings & Tickets, Finance and Reports marked **Coming soon** (these screens contain no inputs or buttons). Administration: Users & Roles, Company settings, Audit log, Backup & restore. |
| **Dashboard** | Active/archived counts, limited to what the user may see, and the last backup time. |
| **Audit log viewer** | Filter by record type, action prefix, user and date range; before/after/metadata details; paging. Read-only view over the existing hash-chained log. |
| **Internationalisation** | Every UI string is an `[ar, en]` pair (compile-time enforced). Backend error codes and every validation reason are translated, with field-level messages. |

## 3. Files and modules changed

49 files changed: +5,106 / −511 lines, measured from `ef07ad2` (end of Phase 1).

- **Domain** (`packages/domain`), all new unless noted:
  - `text/normalize.ts`: Arabic and Latin search folding.
  - `contact/contact.ts`: phones, e-mail and country validation.
  - `masterdata/masterdata.ts`: customer, supplier and airline rules, archive rules.
  - `masterdata/duplicates.ts`: duplicate signals.
  - `security/users.ts`: user state transitions.
  - `company/config.ts`: company field groups and the permission for each.
  - Modified: `security/permissions.ts`, `errors.ts`, `index.ts`.
  - New dependency: `libphonenumber-js`.
- **Contracts** (`packages/contracts`): `schemas.ts` (20 new commands, new inputs), `dto.ts` (new and extended DTOs).
- **Backend** (`packages/backend`):
  - New: migration `0002_master_data.sql`, `customer-service.ts`, `supplier-service.ts`, `airline-service.ts`, `masterdata-support.ts`.
  - Rewritten: `company-service.ts`, `user-service.ts`.
  - Updated: `dispatcher.ts` (access rules and new handlers), `backend.ts` (services, search-index self-repair), `seed.ts` (permission upgrade path).
- **Desktop renderer:**
  - New: `components.tsx` (dialogs, forms, badges, empty and error states), `prefs.tsx` (display formats and direction), `pages/masterdata.tsx` (shared list and editor), `pages/parties.tsx`, `pages/dashboard.tsx`, `pages/audit.tsx`.
  - Rewritten: `App.tsx`, `i18n.tsx`, `pages/users.tsx`, `pages/company.tsx`.
  - Updated: `pages/auth.tsx`, `pages/system.tsx`, `styles.css`.
- **Desktop main:** `smoke-test.ts` (full/seed/verify phases), `index.ts`.
- **Tests and CI:**
  - New: `backend/test/identity.test.ts`, `backend/test/masterdata.test.ts`, `domain/test/masterdata.test.ts`, `e2e/phase2.e2e.mjs`.
  - Updated: `migrations.test.ts`, `rbac.test.ts`, `foundation.e2e.mjs`, `.github/workflows/ci.yml`, `eslint.config.mjs`.

## 4. Database migrations

**`0002_master_data`** is additive only: `ALTER TABLE … ADD COLUMN`, new indexes and new triggers. No table was rebuilt and no data was rewritten.

| Table | Change |
|---|---|
| `company_profile` | Added `date_format`, `number_format`, `text_direction` (CHECK-constrained, with defaults), `invoice_title_ar/en`, `invoice_terms_ar/en`. |
| `app_user` | Added `email`, `mobile`, `notes`. |
| `customer` | Added `address`. Indexes on secondary mobile, WhatsApp, e-mail and (status, name). |
| `supplier` | Added `phone_secondary`, `country_code`. Indexes on phone, e-mail and (status, name). |
| `airline` | Added `country_code`. Unique partial indexes on ICAO (active rows only); (status, name) index. |
| Triggers | `trg_airline_no_delete`; `trg_role_no_delete_system`. |

- **Upgrade path:** existing Phase 1 databases migrate automatically. A verified `PRE_MIGRATION` backup is taken first (Phase 1 mechanism, tested). The seed then maps old permission codes to their replacements (`PERMISSION_RENAMES`, e.g. `user.manage` → the six `user.*` codes), grants them to every role that held the old code, and removes obsolete codes. This is covered by a test, and running it twice is harmless.
- **Search index self-repair:** the full-text search index rebuilds itself at startup and after a restore if its size doesn't match the tables.
- **Checksums:** migration checksums (Phase 1) protect `0001` and `0002` against edits.

## 5. Domain changes

These are pure functions with no database, Node or Electron imports (enforced by a lint rule):

- **Phones** (market-neutral) → E.164 via libphonenumber:
  - The company's default country applies; a supplier's own country applies to its phones.
  - Accepts Arabic-Indic digits, `00` and `+` prefixes, spaces and dashes.
  - Tests cover Egypt, Saudi Arabia, the UAE, the UK and the US. Nothing assumes Egyptian formats.
- **Search normalization:**
  - Arabic: أ/إ/آ→ا, ة→ه, ى→ي; diacritics and tatweel stripped; digits folded.
  - Latin: accents removed, lowercase.
  - Phone digits are indexed with and without leading zeros.
- **Validation:** returns `VALIDATION {field, reason}` with stable reason codes, e.g. `INVALID_PHONE`, `INVALID_EMAIL`, `INVALID_COUNTRY`, `DATE_IN_FUTURE`, `INVALID_IATA`, `INVALID_ICAO`, `INVALID_TICKET_PREFIX`, `INVALID_URL`, `OUT_OF_RANGE`, `TOO_LONG`, `REQUIRED`. The UI translates them.
- **Archive rules:** `ALREADY_ARCHIVED` / `ALREADY_ACTIVE` / `ARCHIVED_READ_ONLY`.
- **User transitions:** `SELF_LOCKOUT`, `ALREADY_DISABLED`, `NOT_LOCKED`; derived status ACTIVE / LOCKED / DISABLED.
- **Company field groups:** the fields that changed decide which permission(s) an update needs.
- **Duplicate detection:** Dice similarity on name tokens plus phone and e-mail comparison. It returns reasons only and never acts on them.

## 6. UI changes

| Screen / element | Description |
|---|---|
| Setup | Two labelled steps and the password rule shown; completion confirmed on the login screen. |
| Shell | Two navigation groups with "Coming soon" badges; language toggle; current user and roles in the top bar. |
| Customers / Suppliers / Airlines | Shared list component: debounced search, status filter, sort field and direction, paging, "showing x–y of n", empty state (different for "no records yet" and "no matches"), load-error state with Retry. The editor dialog shows a message under each invalid field, a duplicate-warning dialog (matching records and their signals), archive/restore with a reason, an archived read-only banner, derived balances or a "hidden" notice, and created/updated info. |
| Users & Roles | Users tab (search, status filter, create/edit, role checkboxes, disable with confirmation, unlock, reset password). Roles tab (list with user counts and system badge; rename; members; permission matrix grouped by module; new role). |
| Company settings | Three sections, each read-only when the user lacks that section's permission; logo preview, upload and remove; lock-date section (Phase 1). |
| Audit log | Filters, table and a JSON details dialog. |
| Display preferences | The configured date format, digits and direction apply everywhere. |
| Direction handling | Phones, e-mails and codes are always rendered LTR, even in RTL. |
| Accessibility | Dialogs are `role=dialog`/`aria-modal`, close on Escape and restore focus. Invalid fields carry `aria-invalid` and `aria-describedby`. Tabs use `role=tab`. Keyboard activation works on table rows. |

## 7. RBAC / permission matrix

The default role grants for the Phase 2 modules, generated from `SYSTEM_ROLES`. ⚠ marks a sensitive permission. There are 93 permissions in total; the Phase 1 booking/finance/report grants are unchanged.

| Permission | ADMIN | MANAGER | ACCOUNTANT | SALES_AGENT |
|---|:-:|:-:|:-:|:-:|
| `company.view` | ✔ | ✔ | ✔ | ✔ |
| `company.edit` ⚠ | ✔ | — | — | — |
| `company.branding` ⚠ | ✔ | — | — | — |
| `company.financial_config` ⚠ | ✔ | — | — | — |
| `customer.view` | ✔ | ✔ | ✔ | ✔ |
| `customer.create` | ✔ | ✔ | — | ✔ |
| `customer.edit` | ✔ | ✔ | — | ✔ |
| `customer.archive` | ✔ | ✔ | — | — |
| `customer.view_identity` ⚠ | ✔ | ✔ | — | ✔ |
| `supplier.view` | ✔ | ✔ | ✔ | ✔ |
| `supplier.create` | ✔ | — | ✔ | — |
| `supplier.edit` | ✔ | — | ✔ | — |
| `supplier.archive` | ✔ | — | ✔ | — |
| `supplier.view_financial` ⚠ | ✔ | ✔ | ✔ | — |
| `airline.view` | ✔ | ✔ | ✔ | ✔ |
| `airline.create` | ✔ | ✔ | — | — |
| `airline.edit` | ✔ | ✔ | — | — |
| `airline.archive` | ✔ | ✔ | — | — |
| `user.view` ⚠ | ✔ | ✔ | — | — |
| `user.create` ⚠ | ✔ | — | — | — |
| `user.edit` ⚠ | ✔ | — | — | — |
| `user.disable` ⚠ | ✔ | — | — | — |
| `user.reset_credentials` ⚠ | ✔ | — | — | — |
| `user.assign_roles` ⚠ | ✔ | — | — | — |
| `role.view` ⚠ | ✔ | ✔ | — | — |
| `role.create` ⚠ | ✔ | — | — | — |
| `role.edit` ⚠ | ✔ | — | — | — |
| `role.manage_permissions` ⚠ | ✔ | — | — | — |

- **Sales Agent (Q5):** has no `booking.view_cost`, `booking.view_profit`, `supplier.view_financial`, `report.profit`, `dashboard.financial` or `treasury.view`. It keeps `booking.enter_cost`, so an agent can enter a cost but never read cost or profit back.
- **Custom roles:** can combine any permissions, but only an Admin can grant permissions the Admin role alone holds (escalation guard).
- **Default-role changes:** these are defaults for new installations. On an upgraded database, existing grants are mapped through `PERMISSION_RENAMES` rather than reset.

## 8. Security changes

- **Backend authorization everywhere:**
  - New commands declare their access in the dispatcher, and services call `requirePermission` **before** opening a transaction.
  - A registry test checks that every contract command has a rule and that only `system.status`, `system.setup` and `auth.login` are public.
  - Every refusal is audited as `auth.permission_denied`.
- **Data-level redaction on the server, not in the UI:**
  - Supplier balances are `null` without `supplier.view_financial`.
  - Customer identity fields are `null` without `customer.view_identity`.
  - A user who cannot see identity data also cannot erase it by accident: an update keeps the stored values.
- **Escalation guards:**
  - A non-Admin cannot create or edit a role with permissions they don't hold.
  - A non-Admin cannot assign a role whose permissions they don't hold, or assign ADMIN at all.
  - Self-lockout is blocked, and the last active Admin is protected.
- **Company configuration:** each changed field group is authorized separately, so general-edit rights cannot change the base currency, tax numbers or branding.
- **Optimistic locking** (`rowVersion`) on company, users, customers, suppliers and airlines. A stale edit is refused (`STALE_RECORD`), even when it would change nothing.
- **Input safety:**
  - All payloads are validated by strict zod schemas at the transport boundary; unknown keys such as `balance` are rejected.
  - All SQL values are bound parameters. Search text reaches FTS5 only as a quoted phrase via `MATCH ?`, and SQL-injection strings return no results (tested).
  - The files exempted from the "no template literals in SQL" lint rule are documented and use only fixed internal fragments (whitelisted sort columns, table literals, generated `?` lists).
  - URL fields must be `http(s)` (`javascript:` is rejected).
  - Logo uploads are size-limited, MIME types are enumerated, and logos are rendered only through `<img>`.
- **No unnecessary personal data:** only fields an agency needs for ticketing are collected. Passport, national ID and date of birth are optional.
- **Unchanged from Phase 1:** there is still no plaintext password anywhere (Argon2id only) and no hidden master or recovery account.
- **The packaged app keeps its hardening:**
  - Electron fuses stay as they were: the inspector is disabled, the app loads only from the asar archive, and the asar's integrity is validated.
  - This is also why the Windows CI drives the packaged app through its built-in smoke mode rather than Playwright.
- **Smoke mode:**
  - `--smoke-phase=seed` runs only the public first-run setup, and refuses a data directory that is already set up.
  - It therefore grants nothing that the first-run screen doesn't already offer on a fresh installation.

## 9. Audit changes

There is still only one audit implementation: the Phase 1 hash-chained `AuditLog.append`, called inside the same transaction as the change. Phase 2 added:

- **New actions:**
  - `customer.created/updated/archived/restored`, and the same four for `supplier.*` and `airline.*`;
  - `user.updated`, `user.unlocked`, `role.updated`, `company.updated` (with `metadata.groups`).
- **Existing actions still used:** `user.created/disabled/enabled/roles_changed/password_reset`, `role.created/permissions_changed`, `setup.completed`, `auth.*`.
- **Duplicate confirmation:** a deliberate save despite the warning records `metadata.duplicatesAcknowledged: true`.
- **Archive and restore** record the reason.
- **Secrets are kept out of the audit trail:**
  - Passwords, temporary passwords and hashes never appear in audit rows (a test searches every audit row).
  - Passport and national-ID numbers are masked to their last 4 characters.
  - The logo image itself is not copied into audit rows.
- **Query and viewer:** `audit.list` gained filters (record type, record ID, action prefix with LIKE-escaping, user, date range) and returns workstation and before/after. The integrity check verifies the whole chain, and passes after the full E2E.

## 10. Tests executed

| Suite | What it covers |
|---|---|
| Domain unit tests (`packages/domain/test/*`) | Normalization, phones in five countries, all validation reasons, duplicate signals, archive and user transitions, company field groups, permission catalogue evolution, Sales Agent defaults, plus all Phase 1 ledger/money/exchange/security tests (property-based where relevant). |
| Backend integration (`identity.test.ts`) | Setup rollback on a mid-transaction failure; a new market chosen at setup (SAR/SA); invalid setup creates nothing; company sections and permission groups; users create/update/disable/enable/unlock; disabled user cannot log in; no password material in audit; roles create/rename/permissions/assignment taking effect immediately; escalation guards; Phase 1 → 2 permission upgrade; the §20 Sales Agent matrix (6 tests); audit filters. |
| Backend integration (`masterdata.test.ts`) | Customer full lifecycle, search (Arabic folding, Arabic-Indic digits, phone fragments, e-mail, number, injection string), status filters, sorting, paging, duplicate warning and confirmation (no merge), identity redaction and masking, no balance columns plus derived balances; supplier ≠ airline, supplier financial redaction; supplier and airline updates; airline code uniqueness among active records; archive/restore conflicts; never deleted; dashboard summary. |
| Phase 1 regression | Migrations (the count-agnostic update below), auth, RBAC, posting and ledger immutability, audit and backup/restore, encryption, services, desktop security config. All pass unchanged except the two intentional updates below. |
| E2E | Phase 1 `foundation.e2e.mjs` (updated only for the renamed menus) and the Phase 2 `phase2.e2e.mjs` 20-step scenario. |
| Smoke (packaged runtime) | `full` (14 steps), `seed`, `verify`. |
| Phase 0 financial model | `validate_schema.py`: 28 worked-example checks. |

The two intentional test updates were:

- **`migrations.test.ts`:** now counts migrations instead of assuming exactly one.
- **`rbac.test.ts`:** self-disable is now the stronger `SELF_LOCKOUT`, with a genuine `LAST_ADMIN` case added.

## 11. Exact pass/fail counts

| Suite | Passed | Failed |
|---|---:|---:|
| Domain: masterdata | 25 | 0 |
| Domain: ledger, money, exchange, security (Phase 1) | 51 | 0 |
| Backend: identity (Phase 2) | 16 | 0 |
| Backend: masterdata (Phase 2) | 11 | 0 |
| Backend: posting, audit-backup, auth, rbac, migrations, services, encryption | 69 | 0 |
| Desktop: security config | 4 | 0 |
| **Vitest total (15 files)** | **176** | **0** |
| E2E Phase 2 (steps) | 20 | 0 |
| E2E Phase 1 foundation | 1 scenario | 0 |
| Packaged smoke, full (steps) | 14 | 0 |
| Phase 0 financial validation | 28 | 0 |
| Typecheck (4 packages) / lint | clean | 0 |

## 12. Coverage

The coverage run is `vitest --coverage`, v8.

| Scope | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| **All files** | 94.42% | 88.08% | 95.30% | 97.33% |
| backend services | 95.55% | 88.40% | 98.62% | 98.53% |
| customer / supplier / airline services | 96–100% | 80–89% | 100% | 98–100% |
| user service | 98.85% | 93.84% | 100% | 100% |
| domain masterdata / contact | 98.8% / 100% | 97.1% / 97.6% | 100% | 100% |

The renderer has no unit tests; it is covered by the two Electron E2E runs.

## 13. E2E results

`apps/desktop/e2e/phase2.e2e.mjs` runs the real Electron app built by `pnpm build`, starting from an empty data directory. Result: **20/20**, both locally and on Linux CI (`xvfb`). A screenshot of every step is uploaded as a CI artifact.

1. Clean setup screen (RTL; the renderer has no Node).
2. Company details.
3. First Admin. Setup completes and `system.setup` is refused afterwards.
4. A wrong password is rejected, then the Admin logs in.
5. Arabic RTL shell with every menu item; the Coming Soon pages contain no controls.
6. Switch to English LTR.
7. Create a customer. The invalid phone is rejected with a field message; the duplicate warning appears for the same phone, and going back creates nothing.
8. Search: Arabic folding, phone digits, case-insensitive e-mail, an empty state for no matches.
9. Edit the customer and confirm the change persisted.
10. Archive with confirmation. The customer disappears from Active, shows in Archived, and is read-only.
11. Switch back to Arabic and create a supplier.
12. Search suppliers (أ/ا folding, phone digits, contact name, empty state).
13. Create an airline (codes upper-cased); a clashing IATA code shows a field error.
14. Create a second user (as Accountant).
15. Reassign that user to Sales Agent. The role matrix shows `supplier.view_financial` and `booking.view_profit` unchecked.
16. Log in as the agent; the temporary password must be changed.
17. Restricted access:
    - no Users, Audit or Backup menus, and no "new supplier" button;
    - supplier financials show as hidden, and the server returns `balances: null`;
    - direct calls to `roles.create`, `users.list`, `company.update`, `ledger.summary`, `audit.list` and `backup.create` all return `FORBIDDEN`.
18. Log back in as Admin.
19. The audit log contains every expected action (including `auth.permission_denied`), the action filter works, and the integrity check passes.
20. After the app is closed and relaunched on the same data: no setup screen, login works, and the archived customer, the supplier, the airline and the agent are all intact.

The same steps are numbered 18 = log back in and 19 = verify audit, because the audit log can only be read by the Admin.

## 14. Windows CI results

The `windows-latest` job runs these steps on every push:

1. Unit and integration tests on Windows.
2. NSIS installer build.
3. Silent per-machine install.
4. **Packaged launch:** the GUI starts from `Program Files` and creates `%ProgramData%\AirDesk\data\airdesk.db`.
5. **Packaged smoke (full):** native SQLite and Argon2, setup, login, master data, posting, backup, restore, restart, integrity.
6. **Real-data-directory seed:** first-run setup, login, customer, supplier, airline and Sales Agent in `%ProgramData%\AirDesk\data`.
7. **Silent uninstall:** the program is removed and the database is kept.
8. **Reinstall and verify:** setup is not offered again, login works, records are intact, integrity passes.
9. Final uninstall.

Linux job for the same commit (run 36463088910): **green**, covering typecheck, lint, 176 tests with coverage, build, Electron smoke, and both E2E suites.

Windows job for the same commit (run 36463088910, job 109066680274, `windows-latest`, Windows 10.0.26100, win32, Electron 44.4.5): **green, every step passed**; details in the addendum.

## 15. Installer result

- **Installer:** NSIS per-machine installer, `AirDesk-Setup-0.1.0-x64.exe`, uploaded as a CI artifact.
- **Data location:** data is kept in `%ProgramData%\AirDesk`, and uninstall never removes it; reinstall picks it up (§14).
- **Signing:** builds are unsigned, as in Phase 1. Code signing belongs to the release workflow (Phase 10).
- **Field validation:** interactive UAC prompts and physical Windows 10/11 versions stay a documented field-validation item, as agreed; they are not a blocker.

## 16. Financial regression result

Nothing in the ledger changed. Phase 2 did not touch posting rules, journal tables, triggers or views.

- **Phase 0 model:** `validate_schema.py` passes 28/28.
- **Phase 1 tests:** the posting and ledger tests (20 posting tests plus 51 domain ledger/money/exchange/security tests) all pass.
- **Immutability triggers:** still reject UPDATE and DELETE on journal rows and on audit rows.
- **Derived balances:** a Phase 2 test posts an invoice and a receipt and a bill through the Phase 1 posting service, and confirms the customer and supplier screens show the balance derived from the journal (5,500.00 and 10,100.00 EGP).
- **Archiving:** archiving a supplier does not change its balance.
- **No balance columns:** `customer` and `supplier` have none (a test checks this with `PRAGMA table_info`).

## 17. Known limitations

1. **Customer merge is not implemented.** Duplicates produce a warning only. A future **controlled merge** must re-point bookings and financial documents through reversing and reposting entries, keep both histories, require a dedicated permission and an audit record, and **never** delete financial history. It is deliberately out of scope.
2. **Windows field validation:** interactive UAC and physical Windows 10/11 machines remain a field-validation item (not a blocker).
3. **Duplicate checks read at most 50 candidates** from indexed phone, e-mail and name matches. This is tuned for agency-sized data; very large imports would need a batch tool (Phase 9, data migration).
4. **Paging:** supplier pick-lists load up to 200 active airlines, and list screens page 50 rows at a time. There is no infinite scroll yet.
5. **Logo:** PNG/JPEG only in the UI (≤ 512 KB). SVG is accepted by the Phase 1 contract but only ever rendered through `<img>`; restricting it is a candidate hardening item.
6. **Dashboard:** it shows counts only. Financial KPIs arrive with finance and reports.
7. **Renderer bundle:** it is unminified (~760 KB), which is harmless for a desktop app. Code splitting can follow later.
8. **Role deletion:** custom roles can be emptied of permissions but not deleted, so historical audit references keep working.

## 18. Deviations from Phase 0 / Phase 1

| Item | Deviation | Reason |
|---|---|---|
| Permission catalogue | Coarse codes (`user.manage`, `role.manage`, `supplier.manage`, `airline.manage`, `settings.company`, `customer.deactivate`, `supplier.view_balance`) were replaced with the granular set required by Phase 2 §7. | Phase 2 requirement. The seed's upgrade path migrates existing grants, so no role loses access. |
| Self-disable error | Now `SELF_LOCKOUT` instead of `LAST_ADMIN`. | Stronger rule: nobody may disable themselves or remove their own Admin role. `LAST_ADMIN` still guards the last active Admin. |
| Smoke test | Gained `seed` and `verify` phases. | Needed to prove setup, login and data preservation on real Windows through the packaged app, whose inspector fuse (kept disabled) prevents Playwright. |
| Airline codes | IATA and ICAO are unique among **active** airlines only. | Archive-instead-of-delete must allow a code to be reused by a successor record; restoring a clashing archived airline is refused. |

The Phase 0 financial model, the journal, the audit chain, backup and restore, and the encryption design are all unchanged.

## 19. Recommended Phase 3 scope

This is a recommendation only; Phase 3 has not been started.

**Bookings and tickets (core workflow):**

- booking header linked to customer, supplier and airline, with passengers from the customer record;
- flight segments, ticket numbers validated against the airline's ticket prefix, PNR;
- statuses (reserved, issued, void, reissued, refunded, per Phase 0);
- sale price and cost entered with the Sales Agent cost-entry and no-profit-view rule (Q5);
- posting of the customer invoice and supplier bill through the existing posting service;
- booking list and search;
- booking-level audit and immutability of issued financials;
- E2E for issue, void and reissue.

Customer/supplier statements, receipts and payments UI and reports should follow in the finance phases, per the Phase 0 plan.

---

### Addendum: CI verification

The results below are from [CI run 36463088910](https://github.com/ahmed872/AirDisk/actions/runs/36463088910) on code commit `efaa624`. The later commits change only documentation.

**Linux job** (`ubuntu-latest`): ✅. Typecheck, lint, 176/176 tests with coverage, build, Electron smoke, Phase 1 foundation E2E, Phase 2 E2E 20/20.

**Windows job** (`windows-latest`, OS 10.0.26100, `platform: win32`, Electron 44.4.5, Node 24.21.0, SQLite 3.53.4): ✅

| Step | Result |
|---|---|
| Unit + integration tests on Windows | 176 / 176 passed (15 files) |
| NSIS installer build | `AirDesk-Setup-0.1.0-x64.exe` built (per-machine, fuses applied); uploaded as artifact `AirDesk-Setup-windows-x64` |
| Silent install `/S /allusers` | `C:\Program Files\AirDesk\AirDesk.exe` present |
| Packaged GUI launch + DB init | Process stayed up; created `C:\ProgramData\AirDesk\data\airdesk.db` (+ WAL/SHM) and `logs\` |
| Packaged smoke, `full` | 14 / 14 steps passed: open+migrate (schema v2), first-run setup, setup refused a second time, login, post `INV-2026-000001`, validated backup, restore, create customer/supplier/airline, create Sales Agent, agent refused role management, data persists after restart, integrity |
| Real data directory, `seed` | 10 / 10 steps in `C:\ProgramData\AirDesk\data`: setup, setup-twice refused, login, customer/supplier/airline, Sales Agent, agent refused, integrity |
| Silent uninstall | Program removed; `airdesk.db` **preserved** |
| Reinstall + `verify` | 7 / 7 steps: open+migrate, **setup not offered again**, login, customer/supplier/airline persisted, integrity |
| Final uninstall | done |

Interactive UAC prompts and physical Windows 10/11 machines remain the documented field-validation item (not a blocker).
