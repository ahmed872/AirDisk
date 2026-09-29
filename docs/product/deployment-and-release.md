# AirDesk — Build, Deployment and Release

## 1. Building

```bash
pnpm install --frozen-lockfile
pnpm check        # typecheck + lint + all unit/integration tests
pnpm e2e          # build + Electron E2E: foundation, Phase 2 (20 steps), operations (14 steps)
pnpm dist:win     # Windows NSIS installer → apps/desktop/dist/AirDesk-Setup-<version>-x64.exe
AIRDESK_PERF=1 npx vitest run packages/backend/test/perf.test.ts   # representative-office performance run (~3 min)
```

Native modules (`better-sqlite3-multiple-ciphers`, `@node-rs/argon2`) ship N-API prebuilds for win32-x64; no rebuild is needed.

## 2. Continuous integration (`.github/workflows/ci.yml`)

**Linux job:** install → typecheck → lint → tests with coverage → build → Electron smoke test (real runtime, native modules) → E2E foundation → E2E Phase 2 (20 steps incl. restart) → E2E operations (14 steps at 1366×768, incl. real keyboard typing in dialogs, English-mode overflow checks) → screenshots uploaded.

**Windows job (`windows-latest`):** tests on Windows → NSIS build → silent install → version information check (EXE properties, installer properties, Apps & Features entry) → packaged launch creates `%ProgramData%\AirDesk\data\airdesk.db` → packaged smoke test (native SQLite + Argon2, setup, login, master data, posting, **ticket record + payment with Total/Paid/Remaining**, backup, restore, **ticket record intact after backup→restore**, restart) → first-run seed in the real data directory → silent uninstall (program removed, data kept) → reinstall and verify (no second setup, login, customer/supplier/airline, **ticket record and balances**, schema current, integrity) → final uninstall → installer uploaded as an artifact.

A release candidate is produced only from a commit where both jobs are green.

## 3. Versioning

- Semantic versioning in `apps/desktop/package.json` (all workspace packages carry the same version). Current: **1.0.0-rc.1**.
- Pre-release tags (`-rc.N`) until the release gates in §5 are met; then `1.0.0`.
- MAJOR: incompatible data/format change requiring a manual step (none planned — migrations are automatic). MINOR: new features/migrations. PATCH: fixes only, no migration.
- The **database schema version** is independent (currently 6) and shown in *About* together with the list of applied migrations and the app version that applied each.
- Windows resources: *FileVersion* = full semver, *ProductVersion* = numeric `1.0.0.0`; Apps & Features shows the full semver.

## 4. Update readiness

- **Implemented:** in-place upgrade by running a newer installer; automatic, checksummed, transactional migrations with a verified pre-migration backup; older builds refuse newer databases; data folder survives uninstall/reinstall; crash-safe restore.
- **Not implemented:** online auto-update (no update feed, `publish: []`). When added, updates must be signed and must run the same migration path; an update must never run while a restore or backup is in progress.

## 5. Release checklist (gates for 1.0.0)

| Gate | Status in 1.0.0-rc.1 |
|---|---|
| Linux + Windows CI green on the release commit | ✔ (see final report for run numbers) |
| Regression suites (Phase 0/1/2 + operations) green | ✔ |
| Performance run on a representative dataset | ✔ ([performance.md](performance.md)) |
| Code signing with an EV/OV certificate | ✘ not done — needs the owner's certificate; pipeline specified in §7 |
| Encryption at rest + recovery passphrase flow | ✘ designed, not enabled ([encryption-plan.md](encryption-plan.md)) |
| Field pilot on physical Windows 10 and 11 PCs (UAC, printers, Arabic fonts, antivirus) | ✘ pending |
| Clean-machine disaster-recovery drill (new PC restore) with a real office backup | ✘ pending (procedure documented in the admin guide; automated equivalent passes) |
| User documentation (Arabic) and admin documentation | ✔ |

## 6. White-label

All customer-facing identity comes from **Company settings** (names, logo, address, tax/CR numbers, invoice title and terms, footer). The installer and executable are branded "AirDesk"; a partner edition changes `productName`, `appId`, icons and `copyright` in `apps/desktop/electron-builder.yml` and `package.json`, plus the data folder name, which is hard-coded as `AirDesk` in `apps/desktop/src/main/paths.ts` and `apps/desktop/build/installer.nsh` (change both if a partner edition must keep its data separate).

## 7. Code signing pipeline (not set up — release blocker)

1.0.0-rc.1 installers are **unsigned**: Windows SmartScreen shows "Windows protected your PC / Unknown publisher", and some antivirus products quarantine unsigned per-machine installers. Nothing in the repository pretends otherwise; CI builds unsigned artifacts.

What the owner must provide and what must be built:

1. **Certificate.** An OV or EV code-signing certificate issued to the legal entity that sells AirDesk (or the white-label partner). Since June 2023 the private key must live on a hardware token/HSM or a cloud signing service (e.g. Azure Trusted Signing, DigiCert KeyLocker, SSL.com eSigner); a `.pfx` file in a CI secret is no longer issued by CAs.
2. **Release workflow** (`.github/workflows/release.yml`, protected environment `release` with required reviewers, triggered only by a signed `v*` tag):
   - run the complete CI gates (Linux + Windows jobs) on the tagged commit;
   - build with `pnpm dist:win`, signing through electron-builder's `win.sign` hook calling the cloud signing tool (or `signtool sign /fd sha256 /tr <RFC 3161 timestamp URL> /td sha256`); sign `AirDesk.exe`, the uninstaller and the installer;
   - verify with `signtool verify /pa /all` and `Get-AuthenticodeSignature` (status `Valid`, expected publisher) and fail the job otherwise;
   - repeat the silent install / smoke / uninstall / reinstall steps on the **signed** artifact;
   - publish SHA-256 checksums next to the installer.
3. **Secrets** are scoped to the `release` environment only (never available to pull requests or the `ci.yml` jobs).
4. **Timestamping** is mandatory so signatures remain valid after the certificate expires.

## 8. Windows behaviour verified in CI (and what is not)

- **Verified on `windows-latest` (Windows Server 2022) in every CI run:** NSIS per-machine silent install to `C:\Program Files\AirDesk`; version resources; Apps & Features entry; first launch creates `%ProgramData%\AirDesk\data\airdesk.db`; packaged smoke test; uninstall keeps data; reinstall reuses it with no second setup.
- **No auto-start:** AirDesk does not register itself to start with Windows (no Run key, no login item, no service, no scheduled task). Automatic backups therefore need the app to be open.
- **Paths:** program files are read-only; all writable data (database, backups, logs, backup history) is under `%ProgramData%\AirDesk\data`, which the installer grants *Users* modify rights so standard (non-admin) Windows users can run AirDesk.
- **Not verified:** physical Windows 10 and Windows 11 PCs (UAC prompts, SmartScreen with an unsigned installer, antivirus interaction, Arabic fonts, printers and PDF output, high-DPI scaling, multiple Windows user accounts on one PC). This is a release blocker and needs a pilot checklist run on real hardware.
