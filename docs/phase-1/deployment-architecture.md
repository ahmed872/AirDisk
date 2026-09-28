# Deployment Architecture (owner decision Q1)

AirDesk supports two deployment shapes **with the same code**. Phase 1 ships
the single-PC shape; the primary/client shape is designed here and built in a
later phase (before the first multi-PC pilot).

## 1. Single-PC office (Phase 1)

```
┌───────────────────────── Windows PC ─────────────────────────┐
│  Renderer (React, sandboxed)                                 │
│        │ window.airdesk.invoke(command, payload)             │
│        ▼  Electron IPC (contextBridge, one channel)          │
│  Main process: IPC gateway ── session binding per window     │
│        ▼                                                     │
│  AppBackend.dispatch()  ← transport-agnostic entry point     │
│        ▼  zod validation → session → permission → handler    │
│  Services → Domain (pure) → SQLite (%ProgramData%\AirDesk)   │
└──────────────────────────────────────────────────────────────┘
```

* No network, no cloud, no server install. Fully offline.
* The database is a local file (`airdesk.db`, WAL, `synchronous=FULL`).
* Network (UNC) database paths are refused at startup.

## 2. Multi-PC office: primary + clients (designed, not yet built)

```
          Office LAN (no internet required)
┌──────── Primary PC ────────┐        ┌──── Client PC ─────┐
│ AirDesk (primary mode)     │ HTTPS  │ AirDesk (client)   │
│  AppBackend + SQLite       │◄──────►│  Renderer + thin   │
│  LAN API: same dispatch()  │  LAN   │  HTTPS transport   │
└────────────────────────────┘        └────────────────────┘
```

| Concern | Design |
|---|---|
| Who owns the database | Exactly one primary. Clients **never** open the SQLite file (no shared network file — decision Q1). |
| API | The same command registry (`HANDLERS`) served over HTTPS on the LAN. No new business endpoints: every client call goes through the same validation → session → permission → service path as local IPC. |
| Transport security | TLS with a self-signed certificate generated on the primary; clients pin its fingerprint during a one-time pairing (admin enters a pairing code shown on the primary). |
| Sessions | Session tokens issued by the primary, held by the client's main process (never by its renderer), idle timeout identical to local sessions. |
| Workstation identity | Each client sends its machine name; recorded in `user_session` and the audit log (already a field of every dispatch). |
| Offline behaviour | Core operations stay offline-capable in the sense required by Q1: the office LAN is enough, no internet. If the primary is off, clients show "primary unavailable" and cannot post; there is **no** multi-master sync (financial conflicts would be unsafe). |
| Backups | Run on the primary only. |
| Evolution to server/cloud | The primary process can later run headless as a Windows service or on a server; because the domain and services never import transport code, this requires a new host, not a rewrite. PostgreSQL could replace SQLite behind the repository layer if a hosted edition is ever needed. |

### What Phase 1 already provides for this

* `AppBackend.dispatch({ command, payload, sessionId, workstation })` is the
  only entry point and knows nothing about Electron.
* Sessions are bound by the transport, never supplied by the UI.
* ULID primary keys (safe for any future data movement).
* Idempotent commands (`command_log`) so a client retry after a network
  timeout cannot post a payment twice.

## 3. Data location & installation

| Item | Location |
|---|---|
| Program | `C:\Program Files\AirDesk` (per-machine NSIS install) |
| Company data | `%ProgramData%\AirDesk\data\airdesk.db` (+ `-wal`, `-shm`) |
| Backups | `%ProgramData%\AirDesk\data\backups\*.adbk` (configurable destination; USB/network folders allowed for finished backup files) |
| Logs | `%ProgramData%\AirDesk\data\logs\airdesk-YYYY-MM-DD.log` (14 days) |
| Override | `AIRDESK_DATA_DIR` environment variable |

Uninstall removes the program only; company data is preserved.
