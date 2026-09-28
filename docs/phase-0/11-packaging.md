# 11 — Packaging & Installer Strategy

Covers deliverable item **N**, report section **14. Packaging Strategy**.

---

## 1. Deliverable

A single signed **`AirDesk-Setup-<version>-x64.exe`** built with `electron-builder`
(NSIS target), bilingual installer UI (Arabic / English).

| Aspect | Decision |
|---|---|
| Install scope | Per-machine (`C:\Program Files\AirDesk`), requires admin once. All Windows users on the PC share one company database. |
| Data location | `%ProgramData%\AirDesk\` → `data\airdesk.db`, `backups\`, `logs\`, `config.json`. ACL granted to local Users by the installer. Path overridable at first run (local fixed disks only). |
| Shortcuts | Start menu + optional desktop shortcut; file association for `.adbk` (opens restore wizard, admin only). |
| Single instance | Enforced (`requestSingleInstanceLock`). |
| First run | Setup wizard: language → company profile (name, logo, base currency, country, timezone) → Admin account + recovery code/passphrase → backup destination → optional demo data **in a separate sandbox DB**, never mixed with real data. Or *Restore from backup*. |
| Uninstall | Removes program files and shortcuts. **Keeps data and backups by default**; an explicit, unticked-by-default checkbox with a warning deletes data (after offering a final backup). |
| Upgrade | Installing a newer version over an older one keeps data; migrations run on first start with PRE_MIGRATION backup. Installing an older version over newer is blocked by the installer and by the app's downgrade protection. |
| Silent install | `/S` supported for IT deployments; `/D=` for path. |

## 2. Code signing

- Unsigned installers trigger Windows SmartScreen "unknown publisher" warnings that
  destroy customer trust. Every release **must** be signed (Authenticode, SHA-256,
  timestamped) — either with an OV/EV certificate on a hardware token/HSM or a cloud
  signing service (e.g. Azure Trusted Signing). Decision + cost: **Q9**.
- Signing happens only in the protected release workflow; keys never live in the repo.

## 3. Updates

| Mode | Description |
|---|---|
| Offline (default) | Vendor ships a new signed installer; office runs it. Works without internet. |
| Online (optional) | `electron-updater` against a vendor-controlled HTTPS feed with signed metadata; checks at startup, downloads in background, **installs only when the user chooses** and never during work; always takes a backup first. Can be disabled per installation. |

Release channels: `stable` and `beta` (pilot customers).
Versioning: SemVer; schema version is independent and shown in *About*.

## 4. Build pipeline

1. Linux CI: tests (see [09](09-testing-strategy.md)).
2. Windows CI (`windows-latest`): `pnpm install --frozen-lockfile` → rebuild native modules
   for the pinned Electron ABI → `electron-builder --win nsis` → sign → packaged smoke test
   (silent install, launch headless test mode, create DB, post a scripted booking and
   payment, backup, uninstall, assert data kept) → publish artifact.
3. Reproducibility: pinned Node/pnpm/Electron versions, lockfile, deterministic
   `asar`, SBOM (CycloneDX) generated per release.

## 5. Licensing (commercial) — design placeholder

Selling to many offices needs licence enforcement that works **offline**:
signed licence file (Ed25519, vendor private key) containing customer name, installation
id, seat/PC count, edition, expiry/maintenance end; verified at startup with the embedded
public key. Expired maintenance never locks access to existing data (read-only mode at
worst). Model (perpetual + annual maintenance vs. subscription, per-PC vs. per-office)
is a business decision: **Q8**. Implemented in Phase 10.

## 6. Support tooling

- *Help → Export diagnostic bundle*: versions, settings (no secrets), last 7 days of
  logs, integrity report, backup history — **no database content** unless the admin
  explicitly adds an encrypted backup.
- Crash reporting: local only by default; optional opt-in upload.
