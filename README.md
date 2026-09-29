# AirDesk

Commercial, offline-first Windows desktop system for airline-ticket agencies:
customers, suppliers, ticket records, payments, refunds, flight schedule changes, expenses,
profit, receivables/payables, reports, users/permissions, audit and backups.

**Current version:** 1.0.0-rc.2 — release candidate (encryption at rest, recovery passphrase, encrypted backups, signing pipeline). General release gate: [docs/product/release-gate-1.0.0.md](docs/product/release-gate-1.0.0.md). AirDesk records and manages airline-ticket transactions that were booked and issued outside the system (GDS, airline portal, consolidator): customers, passengers, PNRs, ticket numbers, flights, suppliers, purchase cost and customer price, payments and balances, schedule changes and customer notification, reissues, cancellations and refunds, expenses, treasury, opening balances, reports and statements — offline, in Arabic and English, on Windows.

**AirDesk does NOT search flights, reserve seats, create PNRs, issue tickets, or connect to any GDS, airline or consolidator system.** Booking and issuance happen elsewhere; AirDesk records the existing transaction and manages its money.

- Product documentation: [docs/product/README.md](docs/product/README.md) (Arabic user guide, admin guide, architecture, database, financial model, performance, release)
- Completion report: [docs/product/final-report.md](docs/product/final-report.md)
- Specification: [docs/phase-0/README.md](docs/phase-0/README.md) · Phase reports: [1](docs/phase-1/README.md), [2](docs/phase-2/README.md)

```bash
pnpm install
pnpm check          # typecheck + lint + tests
pnpm dev            # run the desktop app
pnpm dist:win       # build the Windows installer
pnpm e2e            # build + Electron E2E (foundation, Phase 2 20-step scenario, operations 14-step workflow)
```
