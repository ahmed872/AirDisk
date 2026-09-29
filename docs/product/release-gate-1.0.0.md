# AirDesk release gate: 1.0.0-rc.3

**Status: AirDesk 1.0.0 Release Candidate. The code is complete and it is awaiting external release validation.** It is not 1.0.0 and not generally available.

- **Branch:** `claude/loving-rubin-kyf18y`
- **Version:** `1.0.0-rc.3`. It adds ticket files attached to records and ticket-list filters to rc.2. rc.2 was published as an UNSIGNED pre-release by the owner's decision.
- **Scope (unchanged):** AirDesk records and manages airline tickets and reservations that were booked and issued **outside** it. It does not search flights, reserve seats, create PNRs, issue tickets, or connect to any GDS, airline or consolidator system.

## 1. Implemented in code (this release)

| Area | What |
|---|---|
| Encryption at rest | New installations are created encrypted from the first byte: SQLCipher v4 format via SQLite3 Multiple Ciphers, AES-256 plus HMAC-SHA512 per page, random 256-bit data key. |
| Recovery passphrase | Mandatory at setup. The owner chooses one or generates one (~122 bits), types it twice and confirms it is written down. It wraps the key with Argon2id + AES-256-GCM. There is no master key or escrow. It can be changed later (Admin password, audited). |
| OS key protection | Per Windows user through DPAPI (`safeStorage`), so daily start needs no passphrase. Another Windows user, a reinstalled Windows or another PC must enter the passphrase once. Linux without a keyring asks at every start. |
| Encrypted backups (format 2) | The encrypted database, the recovery wrap, and sealed and authenticated facts. No company data is readable in the file. rc.1 plain backups can still be restored and are encrypted on the way in. |
| Start-up states | NEW / LOCKED / READY, with clear screens for each case: unlock, key from a backup, damaged database → restore (the damaged file is kept aside), restore onto a new PC without creating a temporary company. |
| Upgrade from 1.0.0-rc.1 | **Enable encryption** encrypts a copy on the worker, proves it identical, swaps crash-safely and removes the plain file. Old unencrypted backups can be deleted afterwards. |
| Crash safety | Swap marker plus staged key file: interrupted restores and encryptions finish or roll back at the next start, waiting for the passphrase if needed. |
| Backups off the main thread | Snapshot by checkpoint + asynchronous copy; packaging, verification, re-encryption, integrity check and restore validation run on a worker thread bundled with the app. |
| Audit trail | Tail-truncation check; external chain checkpoints at every backup and restore. Keying the chain to the data key was analysed and rejected: no gain against anyone able to write the encrypted file (see [encryption-plan.md §7](encryption-plan.md)). |
| Code signing | Environment-only credentials (PFX or Azure Trusted Signing).<br>A gate refuses unsigned release builds with a clear message; development installers are named `…-UNSIGNED-x64.exe`.<br>Authenticode + timestamp verification.<br>`release.yml` in a protected environment: tag = version check, sign, verify, smoke-test the signed build, checksums re-verified, **draft** GitHub release.<br>How to get the certificate (Arabic): [code-signing-guide-ar.md](code-signing-guide-ar.md). |
| VAT | Nothing calculated. Status and requirements (generic model, ETA, ZATCA, UAE) documented in [vat-e-invoicing.md](vat-e-invoicing.md). |

## 2. Verified automatically

| Check | Result |
|---|---|
| Typecheck, lint | clean |
| Unit + integration tests | **287 passed, 1 skipped** (the opt-in performance test, run separately and passed), 30 files. Coverage: lines 93.5 %, statements 89.1 %, branches 80.5 %. |
| Encryption and recovery (`encryption-recovery.test.ts`, 14 tests) | See the list below |
| Audit tamper (`audit-tamper.test.ts`, 5 tests) | modified / deleted / reordered / re-hashed events, metadata, tail truncation, checkpoints, restore baseline |
| Worker regression (`backup-worker.test.ts`) | backup: main thread busy 17 ms of 2.6 s; integrity 8 ms of 0.96 s; the same check in-process: 797 ms |
| Security (`release-audit.test.ts`, `rbac.test.ts`) | A Sales Agent calling the backend directly is denied cost, profit, supplier finances, other agents' records, backup/restore/inspect and every `security.*` command. The pre-login `vault.*` commands refuse once the data is open. Strict schemas, parameterised SQL, constrained paths, CSV injection, Electron hardening: all unchanged and tested. |
| Financial regression | A mixed month produces **identical** reports, statements, aging, dashboard, trial balance and account balances before encryption, after encryption, and after recovery on a new PC. The mix covers: sale, cost, partial and supplier payments, cancellation with fee and supplier penalty, customer credit application and refund, expense, transfer, owner capital and drawing, opening balance, reissue. Refund, FX and 3-decimal currency flows are also verified by their own existing suites. |
| Performance (`AIRDESK_PERF=1`, 140 MB) | Every interactive operation < 0.6 s. Encrypted backup 10.3–10.5 s with 8–134 ms main-thread lag; integrity 4.4–4.6 s with 3–6 ms (two runs) ([performance.md](performance.md)). |
| Electron smoke (real runtime, Linux) | full / seed / verify / recover / **upgrade from the real rc.1 build**: all pass; jobs ran on the worker; no customer or ticket text readable in the data folder |
| E2E (Playwright + Electron, Linux) | foundation ✔; Phase 2 20/20 ✔ (restart → unlock screen, wrong then right passphrase); operations 14/14 ✔ |
| Linux CI | ✔ runs 29 (`197fc1b`) and 31 (`c0879bd`): typecheck, lint, tests + coverage, build, Electron smoke, 3 E2E suites |
| Windows CI (`windows-latest`) | ✔ runs 29 and 31: all 15 steps below (run 31 with the UNSIGNED-named development installer) |

Encryption and recovery cases covered by `encryption-recovery.test.ts`:
- setup refusals, then an encrypted database;
- restart; login; ticket record and payment; backup;
- nothing readable on disk, and the key nowhere in clear;
- locked without the device key, wrong passphrase with throttling;
- secrets absent from logs and the audit trail;
- clean-PC recovery;
- corrupted, forged, altered and truncated backups;
- damaged database;
- lost or damaged key file;
- passphrase change;
- cross-key and plain restores;
- rc.1 upgrade with identical amounts and history;
- interrupted encryption and restore;
- migration with encrypted pre-migration backup, backup and restore after it.

The Windows CI job covers:
- tests;
- the signing gate refusal;
- **real 1.0.0-rc.1 installer → data → new installer over it → data opens → encryption enabled → records verified**;
- fresh install writes no database before setup;
- ProgramData ACL;
- packaged smoke test (encrypted, DPAPI, worker);
- seed + encrypted off-site backup;
- uninstall keeps data; reinstall opens through DPAPI **without** the passphrase;
- **clean-PC recovery** (program, data and device key removed → reinstall → restore with passphrase → verify).

## 3. Requires physical or manual verification (not done; none claimed)

- [physical-windows-checklist.md](physical-windows-checklist.md) on a physical Windows 10 and a physical Windows 11 PC:
  - SmartScreen and UAC with the signed installer, antivirus;
  - Arabic keyboard, RTL, scaling at 1366×768 and 1920×1080;
  - printers and PDF;
  - standard-user permissions and a second Windows user;
  - upgrade from real pilot data, uninstall/reinstall;
  - sleep and power loss.
- The clean-PC drill in [disaster-recovery.md](disaster-recovery.md) with a **real office backup** on a replacement PC, recorded in its table.

### Manual results (fill in; empty means not done)

| Check | Windows 10 | Windows 11 | Date / by |
|---|---|---|---|
| Physical checklist (46 items) | ☐ | ☐ | |
| Clean-PC drill with a real office backup | ☐ (any PC) | | |
| Signed installer verified on a physical PC | ☐ | ☐ | |

## 4. Requires external business or legal action

- **Code-signing certificate:** an OV/EV certificate or an Azure Trusted Signing account, added as secrets to the `release` environment; then tag `v1.0.0`.
- **VAT / e-invoicing decision:**
  - target market;
  - VAT treatment of fares vs fees (tax adviser);
  - whether AirDesk must issue legal tax invoices;
  - ETA token or ZATCA onboarding if it must.

## 5. Remaining items

| Item | Classification |
|---|---|
| Signed installer (certificate not supplied) | **EXTERNAL RELEASE REQUIREMENT**: the pipeline is ready and tested up to the certificate |
| Physical Windows 10/11 checklist | **EXTERNAL RELEASE REQUIREMENT**: manual, checklist ready |
| Physical clean-PC drill with a real office backup | **EXTERNAL RELEASE REQUIREMENT**: automated equivalent passes on Windows CI |
| VAT calculation / ETA / ZATCA | **EXTERNAL RELEASE REQUIREMENT** for VAT-registered offices; **ACCEPTABLE LIMITATION** for offices that are not VAT-registered or invoice elsewhere (state it in the contract) |
| Enabling encryption on a very large rc.1 database blocks the window ~2 s during the reopen (everyone is signed out anyway) | ACCEPTABLE LIMITATION |
| Encrypted backups are not compressed (≈ database size) | ACCEPTABLE LIMITATION: disk sizing documented |
| Passphrase lost and no PC opens the data → data unrecoverable | ACCEPTABLE LIMITATION (by design; documented prominently) |
| The external audit-checkpoint file can itself be edited by someone with file access | ACCEPTABLE LIMITATION: detection is best-effort, documented |
| Payments may overdraw a cash box (with a warning) | ACCEPTABLE LIMITATION (Phase 0 rule) |
| LAN multi-user, online auto-update, automatic WhatsApp/SMS, FX revaluation, editable templates, data-key rotation | FUTURE FEATURE |

**No repository-side RELEASE BLOCKER remains.**

## 6. Commits and CI

- `da753f6` backend encryption, recovery, worker
- `fa75bde` desktop launcher, DPAPI, screens, smoke, E2E
- `811554a` worker regression test, signing pipeline, release workflow, Windows CI
- `af22e02` audit tamper tests, financial regression, recovery docs, rc.2
- `5398b1e` + `197fc1b` worker test stabilised (event-loop utilisation), agent tests, docs
- CI run 29 on `197fc1b`: Linux ✔, Windows ✔ ([run](https://github.com/ahmed872/AirDisk/actions/runs/36552574340)).
- `c0879bd` release readiness (workflow hardening, UNSIGNED dev naming, version script, manual test/DR packages): CI run 31 Linux ✔, Windows ✔ ([run](https://github.com/ahmed872/AirDisk/actions/runs/36556816667)).
- Final pass, run locally at `c0879bd`: typecheck ✔, lint ✔, **287 passed / 1 skipped** (coverage lines 93.48 %, statements 89.06 %, branches 80.47 %), Electron smoke 28/28 ✔, E2E foundation ✔ / Phase 2 20/20 ✔ / operations ✔, performance ✔ (worst interactive median 422 ms).

## 7. Recommendation and procedure to 1.0.0

The exact steps are in [deployment-and-release.md §9](deployment-and-release.md). They need no code changes.


**1.0.0-rc.3 is a general-release candidate on the repository side.** Label it `1.0.0` only after the four external items in §5 are closed, in this order:
1. The signed installer from `release.yml`.
2. The physical Windows 10/11 checklist.
3. The physical clean-PC drill.
4. The VAT decision for the target market.

Until then, sell or deploy only as a controlled rollout to offices that are not VAT-registered (or invoice elsewhere), with the unsigned-installer warning explained.
