# AirDesk — Build, Deployment and Release

## 1. Building

```bash
pnpm install --frozen-lockfile
pnpm check        # typecheck + lint + all unit/integration tests
pnpm e2e          # build + Electron E2E: foundation, Phase 2 (20 steps), operations (14 steps)
pnpm dist:win     # development installer (UNSIGNED, says so) → apps/desktop/dist/AirDesk-Setup-<version>-x64.exe
pnpm dist:win:release   # release installer: refuses to build without signing credentials (§7)
AIRDESK_PERF=1 npx vitest run packages/backend/test/perf.test.ts   # representative-office performance run (~3 min)
```

Native modules (`better-sqlite3-multiple-ciphers`, `@node-rs/argon2`) ship N-API prebuilds for win32-x64; no rebuild is needed.

## 2. Continuous integration (`.github/workflows/ci.yml`)

**Linux job:** install → typecheck → lint → tests with coverage → build → Electron smoke test (real runtime, native modules) → E2E foundation → E2E Phase 2 (20 steps incl. restart) → E2E operations (14 steps at 1366×768, incl. real keyboard typing in dialogs, English-mode overflow checks) → screenshots uploaded.

**Windows job (`windows-latest`):** tests on Windows → NSIS build → signing gate refuses a release build without credentials → **upgrade from the real 1.0.0-rc.1 installer** (rc.1 data seeded, new version installed over it, data opens, encryption enabled in place, all records verified) → silent install → version information check (EXE properties, installer properties, Apps & Features entry) → packaged launch on a clean PC writes no database before setup → `%ProgramData%\AirDesk` grants Users modify rights → packaged smoke test (native SQLite + Argon2, setup, login, master data, posting, **ticket record + payment with Total/Paid/Remaining**, backup, restore, **ticket record intact after backup→restore**, restart) → first-run seed in the real data directory → silent uninstall (program removed, data kept) → reinstall and verify (no second setup, login, customer/supplier/airline, **ticket record and balances**, schema current, integrity) → **clean-PC disaster recovery** (program, data folder and the Windows user's device key removed; reinstall; restore the encrypted off-site backup with the recovery passphrase; verify logins, records, balances, reports, a new backup) → final uninstall → installer uploaded as an artifact. Every packaged smoke run also asserts the database is encrypted, backup/integrity jobs ran on the worker thread, DPAPI reopens the data for the same Windows user after reinstall, and no customer/ticket text is readable anywhere in the data folder.

A release candidate is produced only from a commit where both jobs are green.

## 3. Versioning

- Semantic versioning in `apps/desktop/package.json` (all workspace packages carry the same version). Current: **1.0.0-rc.2**.
- Pre-release tags (`-rc.N`) until the release gates in §5 are met; then `1.0.0`.
- MAJOR: incompatible data/format change requiring a manual step (none planned — migrations are automatic). MINOR: new features/migrations. PATCH: fixes only, no migration.
- The **database schema version** is independent (currently 6) and shown in *About* together with the list of applied migrations and the app version that applied each.
- Windows resources: *FileVersion* = full semver, *ProductVersion* = numeric `1.0.0.0`; Apps & Features shows the full semver.

## 4. Update readiness

- **Implemented:** in-place upgrade by running a newer installer; automatic, checksummed, transactional migrations with a verified pre-migration backup; older builds refuse newer databases; data folder survives uninstall/reinstall; crash-safe restore.
- **Not implemented:** online auto-update (no update feed, `publish: []`). When added, updates must be signed and must run the same migration path; an update must never run while a restore or backup is in progress.

## 5. Release checklist (gates for 1.0.0)

| Gate | Status in 1.0.0-rc.2 |
|---|---|
| Linux + Windows CI green on the release commit | ✔ (run numbers in [release-gate-1.0.0.md](release-gate-1.0.0.md)) |
| Regression suites (Phase 0/1/2, operations, encryption/recovery, audit tamper, worker) green | ✔ |
| Performance run on a representative dataset | ✔ ([performance.md](performance.md)) |
| Encryption at rest + recovery passphrase + encrypted backups | ✔ implemented and tested ([encryption-plan.md](encryption-plan.md)) |
| Automated clean-PC recovery (Windows CI, packaged app) | ✔ |
| Signing pipeline (environment credentials, gate, verification, protected release workflow) | ✔ implemented; **certificate not yet supplied** |
| Signed installer produced by `release.yml` and verified | ✘ external: needs the owner's OV/EV certificate or Azure Trusted Signing account |
| Physical Windows 10 / 11 checklist | ✘ external: [physical-windows-checklist.md](physical-windows-checklist.md) not yet executed |
| Clean-PC drill with a real office backup on physical hardware | ✘ external: [disaster-recovery.md](disaster-recovery.md) |
| VAT / e-invoicing decision for the target market | ✘ external business/legal decision ([vat-e-invoicing.md](vat-e-invoicing.md)) |

Version stays `-rc.N` until every ✘ above is closed; then `1.0.0`.

## 6. White-label

All customer-facing identity comes from **Company settings** (names, logo, address, tax/CR numbers, invoice title and terms, footer). The installer and executable are branded "AirDesk"; a partner edition changes `productName`, `appId`, icons and `copyright` in `apps/desktop/electron-builder.yml` and `package.json`, plus the data folder name, which is hard-coded as `AirDesk` in `apps/desktop/src/main/paths.ts` and `apps/desktop/build/installer.nsh` (change both if a partner edition must keep its data separate).

## 7. Code signing pipeline (implemented — certificate pending)

Nothing secret is in the repository (`*.pfx`, `*.p12`, `*.cer` are git-ignored). Signing is configured only through the environment:

| Option | Environment / secrets (GitHub environment `release`) |
|---|---|
| OV/EV certificate as PFX (token-exportable or CA-issued) | `WIN_CSC_LINK` (path, base64 or https URL), `WIN_CSC_KEY_PASSWORD` |
| Azure Trusted Signing (cloud HSM, recommended when no hardware token) | secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`; variables `AIRDESK_AZURE_SIGNING_ENDPOINT`, `AIRDESK_AZURE_SIGNING_ACCOUNT`, `AIRDESK_AZURE_CERT_PROFILE`, `AIRDESK_PUBLISHER_NAME` |
| Optional check of the signer | variable `AIRDESK_SIGNER_SUBJECT` (e.g. `CN=Your Company Ltd`) |

- `pnpm dist:win` — development/CI build, unsigned, prints "Building UNSIGNED".
- `pnpm dist:win:release` — sets `AIRDESK_REQUIRE_SIGNING=1`; **fails with a clear message** if credentials are missing, half-configured, or both kinds are set; otherwise electron-builder signs `AirDesk.exe`, the uninstaller and the installer with SHA-256 and an RFC 3161 timestamp.
- `apps/desktop/scripts/verify-signature.ps1` — fails unless installer and `AirDesk.exe` are `Valid`, timestamped and (optionally) from the expected subject.
- `.github/workflows/release.yml`, on a `v*.*.*` tag (or manual dispatch for a dry run, without a GitHub release):
  1. full CI gates (Linux + Windows);
  2. the tag must equal the version in every `package.json`;
  3. build and sign in the protected `release` environment (fails without credentials);
  4. verify Authenticode + timestamp;
  5. silent install + packaged smoke test of the **signed** build;
  6. SHA-256 checksums, re-verified against the file, with the signature re-checked;
  7. a **draft** GitHub release. RC tags are marked pre-release. A person publishes it.
- Development/CI installers are named `AirDesk-Setup-<version>-UNSIGNED-x64.exe` and uploaded as `AirDesk-Setup-UNSIGNED-dev-build-…`. The release job refuses any file with `UNSIGNED` in its name.
- CI proves the gate refuses unsigned release builds on every run; the signed path runs only when the owner adds the certificate.

Step-by-step (Arabic) for obtaining the certificate: [code-signing-guide-ar.md](code-signing-guide-ar.md).

**Certificate requirements:** OV or EV code-signing certificate in the name of the selling legal entity (or the white-label partner), private key on a hardware token/HSM or a cloud signing service (CA/B Forum rules since June 2023). EV gives immediate SmartScreen reputation; OV builds reputation over downloads. **Exact external action:** buy the certificate (or create an Azure Trusted Signing account + certificate profile), add the secrets/variables above to the `release` environment with required reviewers, push tag `v1.0.0`.

## 8. Windows behaviour verified in CI (and what is not)

- **Verified on `windows-latest` (Windows Server 2022) in every CI run:** NSIS per-machine silent install to `C:\Program Files\AirDesk`; version resources; Apps & Features entry; first launch creates `%ProgramData%\AirDesk\data\airdesk.db`; packaged smoke test; uninstall keeps data; reinstall reuses it with no second setup.
- **No auto-start:** AirDesk does not register itself to start with Windows (no Run key, no login item, no service, no scheduled task). Automatic backups therefore need the app to be open.
- **Paths:** program files are read-only; all writable data (database, backups, logs, backup history) is under `%ProgramData%\AirDesk\data`, which the installer grants *Users* modify rights so standard (non-admin) Windows users can run AirDesk.
- **Not verified:** physical Windows 10 and Windows 11 PCs (UAC prompts, SmartScreen with an unsigned installer, antivirus interaction, Arabic fonts, printers and PDF output, high-DPI scaling, multiple Windows user accounts on one PC). This is a release blocker and needs a pilot checklist run on real hardware.

## 9. From 1.0.0-rc.2 to 1.0.0 (no engineering work needed)

When the external items in [release-gate-1.0.0.md](release-gate-1.0.0.md) §5 are closed:
1. **Certificate:** add it to the `release` environment ([code-signing-guide-ar.md](code-signing-guide-ar.md)). Dry run: *Actions → Release → Run workflow* on the current commit; the artifact must be signed.
2. **Physical checks:** run [physical-windows-checklist.md](physical-windows-checklist.md) on Windows 10 and 11 with that signed dry-run installer; record PASS/FAIL. Any FAIL goes back to engineering.
3. **DR drill:** follow [disaster-recovery.md](disaster-recovery.md) with a real office backup; fill in the drill record.
4. **VAT:** record the market decision in [vat-e-invoicing.md](vat-e-invoicing.md) §4. Sell only where no VAT/e-invoicing obligation applies to AirDesk, or after that work is done.
5. **Version:** `node scripts/set-version.mjs 1.0.0`. Change "1.0.0-rc.2" to "1.0.0" in `README.md`, `docs/product/README.md` and the status line of `release-gate-1.0.0.md`, and fill in the manual-results table there. Commit; wait for CI green on Linux and Windows.
6. **Tag:** `git tag -a v1.0.0 -m "AirDesk 1.0.0" && git push origin v1.0.0`. Approve the `release` environment when GitHub asks.
7. **Publish:** open the draft release, check the installer name, `SHA256SUMS.txt` and the signature (Properties → Digital Signatures on a Windows PC), then **Publish**.

The same procedure with `1.0.0-rc.3` produces a signed pre-release instead, for pilots.

## 10. Unsigned pre-releases (owner decision, pilots only)

Adding `release-requests/v<version>.json` (with `"signed": false`, `"channel": "pre-release"`) runs `.github/workflows/prerelease-unsigned.yml`:
1. full CI gates (Linux + Windows);
2. unsigned build, still named `…-UNSIGNED-x64.exe`;
3. silent install + packaged smoke test;
4. `SHA256SUMS.txt`;
5. a GitHub **pre-release** `v<version>` whose notes warn about SmartScreen.

It refuses to publish a version without a pre-release suffix (e.g. `1.0.0`), because a final version must be signed through `release.yml`. `v1.0.0-rc.2` was requested this way by the owner for pilot use.
