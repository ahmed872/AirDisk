# AirDesk

Commercial, offline-first Windows desktop system for airline-ticket agencies:
customers, suppliers, bookings, payments, refunds, flight schedule changes, expenses,
profit, receivables/payables, reports, users/permissions, audit and backups.

**Current stage:** Phase 1 complete — tested foundation (security, data layer, ledger, audit, backup, Windows packaging). Business screens start in Phase 2.

- Specification: [docs/phase-0/README.md](docs/phase-0/README.md)
- Phase 1 report: [docs/phase-1/README.md](docs/phase-1/README.md)

```bash
pnpm install
pnpm check          # typecheck + lint + tests
pnpm dev            # run the desktop app
pnpm dist:win       # build the Windows installer
```
