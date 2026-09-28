# 09 — Testing Strategy

Covers deliverable item **J**, report section **12. Testing Strategy**.

---

## 1. Principles

1. **Financial correctness is proven, not eyeballed.** Every business rule (`BR-*`),
   edge case (`EC-*`) and invariant (`INV-*`) has an automated test that names it.
2. **Test against real SQLite**, never mocks, for anything touching persistence — the
   triggers and constraints are part of the design.
3. **Tests go through the same command dispatcher as the UI**, so permission checks,
   validation and audit writing are exercised on every scenario.
4. A phase is not done until its tests, the full regression suite and the Windows build
   are green (see §7).

## 2. Test layers

| Layer | Tool | Scope | Runs |
|---|---|---|---|
| Unit — domain | Vitest | Money arithmetic, rounding, FX conversion, state machines (every state × event), posting rules (document → journal lines), policies | every commit, < 10 s |
| Property-based | fast-check | Random valid operation sequences → invariants INV-1…10 hold; payments never change GP; reversal nets to zero; allocation never exceeds remaining | every commit (bounded runs), nightly (long runs) |
| Accounting scenarios | Vitest + scenario DSL + temp SQLite | Cases A–M and every `EC-*` in the finance area, asserting balances, GP/NP, statements, report rows | every commit |
| Integration — backend | Vitest + temp SQLite | Services + repositories + triggers + FTS + audit chain + migrations | every commit |
| Contract / security | Vitest | Every registered command has a permission; each role × command matrix matches [06 §6](06-security-and-permissions.md); redaction of sensitive fields in DTOs; zod rejects malformed payloads | every commit |
| Migration | Vitest + fixture DBs | Migrate every historical fixture to head; fingerprint unchanged; invariants hold; report snapshots stable | every commit |
| Backup/restore | Vitest + temp dirs | Backup while writing; corrupt/truncated/newer/foreign backups; crash between restore steps (simulated) | every commit |
| E2E | Playwright `_electron` | Login, create customer, booking → issue → payment → print receipt, cancellation with refund, schedule change + notify, backup/restore, RTL/LTR switch, keyboard-only flow | PR to main, Windows |
| Performance | custom harness | 100k bookings / 250k passengers / 1M journal lines: search p95 < 150 ms, dashboard < 500 ms, booking open < 100 ms, receivables report < 2 s, backup of 1 GB DB < 60 s | nightly + before release |
| Packaged smoke | Windows runner | Install NSIS silently, launch, create DB, run a scripted payment, backup, uninstall (data preserved) | every release candidate |
| Manual exploratory / UAT | checklist | Arabic print quality, real printers, real office workflow timing | end of phases 4, 8, 11 |

## 3. Accounting scenario DSL (example)

Scenarios read like the brief, so the business owner can review them:

```ts
scenario('Case C — supplier partially paid keeps profit', ({ given, when, then }) => {
  given.company({ base: 'EGP' });
  given.booking('B1').issued({ sale: 10_500, cost: 10_100, supplier: 'ABC' });
  const gpBefore = then.booking('B1').grossProfit();
  when.supplierPayment({ supplier: 'ABC', booking: 'B1', amount: 5_000 });
  then.booking('B1').expect({ grossProfit: 400, supplierPayable: 5_100 });
  then.booking('B1').grossProfit().equals(gpBefore);          // BR-FIN-03
  then.report('profit', thisMonth).expect({ grossProfit: 400, expenses: 0 });
  then.invariants.allHold();                                  // INV-1..10
});
```

## 4. Mapping of mandatory cases (brief §27) to suites

| Case | Scenario file | Additional tests |
|---|---|---|
| A, B, C | `scenarios/basic-margin.test.ts` | property: payments don't change GP |
| D, E, F, G | `scenarios/cancellation-refund.test.ts` | state machine unit tests (refund) |
| H | `scenarios/multi-currency.test.ts` | rounding/FX unit tests, EC-C* |
| I, J | `scenarios/multi-pax-multi-segment.test.ts` | schedule-change isolation |
| K | `scenarios/modify-after-payment.test.ts` | immutability trigger tests |
| L | `scenarios/supplier-change.test.ts` | per-supplier payable display |
| M | `security/unauthorised-financial.test.ts` | full role × command matrix |

## 5. Invariant checks shared by tests and production

The same `integrity` module used in tests runs in the app: at startup (fast subset),
before every backup (full), after every migration (full), and on demand
(`integrity.run`). Production failures are shown to the Admin and block posting when they
indicate ledger corruption (INV-1/2/7/9).

## 6. Test data

- Deterministic seeded generators (fixed seed per test) for customers, bookings with
  realistic Arabic/English names, routes, suppliers, payment patterns.
- Fixture DB per released schema version kept forever in `tests/fixtures/`.
- No real customer data ever enters the repository.

## 7. Definition of Done per phase (quality gates)

A phase is complete only when **all** are true and reported with exact numbers:

1. `pnpm lint`, `pnpm typecheck` clean (no new suppressions).
2. Unit + property + scenario + integration + contract suites green; coverage for
   `packages/domain` ≥ 95 % lines/branches, `backend/services` & `posting` ≥ 90 %.
3. All `EC-*` rows assigned to the phase have tests and pass.
4. Full regression (all previous phases) green.
5. Migrations: fresh build + every fixture upgrade green, fingerprint unchanged.
6. Windows build produces an installer; packaged smoke test green.
7. Security review checklist for the phase's new commands (permissions, redaction,
   audit, input validation) completed.
8. Financial review: scenario outputs for the phase re-read against
   [04-financial-model.md](04-financial-model.md).
9. Phase report written: goal, scope delivered, DB changes, UI changes, test counts,
   known issues, deviations from spec.

## 8. CI pipeline

```
push / PR ─┬─ linux:   install → lint → typecheck → unit/property → scenarios →
           │            integration → contract/security → migration → coverage gates
           └─ windows: install → build native deps → package NSIS → packaged smoke test
nightly  ──── perf suite (100k dataset) · long property runs · dependency audit
release  ──── signed build · E2E on Windows · smoke install/upgrade from previous version
```
