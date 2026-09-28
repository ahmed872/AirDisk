# AirDesk

Commercial, offline-first Windows desktop system for airline-ticket agencies:
customers, suppliers, bookings, payments, refunds, flight schedule changes, expenses,
profit, receivables/payables, reports, users/permissions, audit and backups.

**Current stage:** Phase 2 complete — company configuration, first-run setup, users & granular roles, customers, suppliers and airlines (Arabic RTL / English LTR), on top of the Phase 1 foundation. Bookings & tickets are the recommended Phase 3.

- Specification: [docs/phase-0/README.md](docs/phase-0/README.md)
- Phase 1 report: [docs/phase-1/README.md](docs/phase-1/README.md)
- Phase 2 report: [docs/phase-2/README.md](docs/phase-2/README.md)

```bash
pnpm install
pnpm check          # typecheck + lint + tests
pnpm dev            # run the desktop app
pnpm dist:win       # build the Windows installer
pnpm e2e            # build + Electron E2E (Phase 1 foundation + Phase 2 20-step scenario)
```
