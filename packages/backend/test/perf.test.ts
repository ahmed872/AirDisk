import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { AppLauncher, TEST_ARGON2, TEST_KDF, createArgon2Hasher, createMemoryLogger, createUlidGenerator } from '../src';
import { ADMIN, ready } from './helpers';

/**
 * Representative-office performance test (owner requirement §54). Skipped in
 * the normal suite; run with:  AIRDESK_PERF=1 npx vitest run packages/backend/test/perf.test.ts
 *
 * Builds a non-production dataset of ~5,000 customers, 1,000 suppliers, 400
 * airlines + seeded airports, 10,000 ticket records, 20,000 passengers, 20,000
 * segments, 30,000 posted financial documents and 50,000+ audit events, then
 * times the operations an office uses all day. Master data rows are inserted
 * with SQL for speed; every financial document goes through the real
 * PostingService (validation, journal, sealing, audit).
 */
const RUN = process.env.AIRDESK_PERF === '1';

describe.skipIf(!RUN)('performance with a representative office dataset', () => {
  it('builds the dataset and measures the daily operations', async () => {
    const { env, adminSession, admin } = await ready();
    const db = env.backend.svc.deps.db;
    const id = createUlidGenerator();
    const now = '2026-09-28T09:00:00.000Z';
    const t0 = performance.now();
    const N_CUST = 5_000, N_SUP = 1_000, N_AIR = 400, N_BOOK = 10_000;
    const customers: string[] = [], suppliers: string[] = [], airlines: string[] = [];
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const firstNames = ['أحمد', 'محمد', 'منى', 'سارة', 'علي', 'خالد', 'فاطمة', 'يوسف', 'نور', 'حسن', 'Ahmed', 'Mona', 'John', 'Maria'];
    const lastNames = ['إبراهيم', 'حسين', 'عبدالله', 'السيد', 'محمود', 'الشريف', 'Hassan', 'Smith', 'Ali', 'Khan'];
    db.transaction(() => {
      const insC = db.prepare(`INSERT INTO customer (id, customer_no, full_name, primary_mobile, primary_mobile_raw, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (let i = 0; i < N_CUST; i++) {
        const cid = id();
        const mobile = `+2010${String(10_000_000 + i).padStart(8, '0')}`;
        insC.run(cid, `C-${String(i + 1).padStart(6, '0')}`, `${firstNames[i % firstNames.length]} ${lastNames[(i * 7) % lastNames.length]} ${i}`, mobile, mobile, now, admin.userId, now);
        customers.push(cid);
      }
      const insS = db.prepare(`INSERT INTO supplier (id, supplier_no, name, default_currency_code, created_at, created_by, updated_at) VALUES (?, ?, ?, 'EGP', ?, ?, ?)`);
      for (let i = 0; i < N_SUP; i++) { const sid = id(); insS.run(sid, `S-${String(i + 1).padStart(6, '0')}`, `Supplier ${i}`, now, admin.userId, now); suppliers.push(sid); }
      const insA = db.prepare(`INSERT INTO airline (id, iata_code, name_en, ticket_prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
      for (let i = 0; i < N_AIR; i++) { const aid = id(); insA.run(aid, `${letters[Math.floor(i / 26) % 26]}${letters[i % 26]}`, `Airline ${i}`, String(100 + (i % 899)).padStart(3, '0'), now, now); airlines.push(aid); }
    })();
    for (const c of customers) env.backend.svc.customers.reindex(c);
    for (const s of suppliers) env.backend.svc.suppliers.reindex(s);
    for (const a of airlines) env.backend.svc.airlines.reindex(a);

    const airports = (db.prepare('SELECT iata_code FROM airport').all() as { iata_code: string }[]).map((a) => a.iata_code);
    const bookings: { id: string; customer: string; supplier: string; date: string; tickets: string[] }[] = [];
    const day = (i: number) => { const d = new Date(Date.UTC(2025, 9, 1)); d.setUTCDate(d.getUTCDate() + (i % 360)); return d.toISOString().slice(0, 10); };
    db.transaction(() => {
      const insB = db.prepare(`INSERT INTO booking (id, booking_no, customer_id, status, booking_date, issue_date, due_date, primary_pnr, default_supplier_id, airline_id, sale_currency_code,
                                 contact_name, contact_mobile, sales_agent_id, created_at, created_by, updated_at) VALUES (?, ?, ?, 'ISSUED', ?, ?, ?, ?, ?, ?, 'EGP', ?, ?, ?, ?, ?, ?)`);
      const insP = db.prepare(`INSERT INTO booking_passenger (id, booking_id, seq, given_name, surname, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const insS = db.prepare(`INSERT INTO flight_segment (id, booking_id, seq, marketing_airline_id, flight_number, origin_iata, destination_iata, departure_date, departure_time,
                                 arrival_date, arrival_time, cabin_class, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '10:00', ?, '13:00', 'ECONOMY', ?, ?)`);
      const insT = db.prepare(`INSERT INTO ticket (id, booking_id, passenger_id, ticket_number, validating_airline_id, supplier_id, status, issue_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'ISSUED', ?, ?, ?)`);
      for (let i = 0; i < N_BOOK; i++) {
        const bid = id();
        const customer = customers[i % N_CUST]!;
        const supplier = suppliers[i % N_SUP]!;
        const airline = airlines[i % N_AIR]!;
        const date = day(i);
        insB.run(bid, `BK-${String(i + 1).padStart(6, '0')}`, customer, date, date, date, `P${String(i).padStart(5, '0')}`, supplier, airline, `Contact ${i}`, `+2011${String(i).padStart(8, '0')}`, admin.userId, now, admin.userId, now);
        const tickets: string[] = [];
        for (let p = 1; p <= 2; p++) {
          const pid = id();
          insP.run(pid, bid, p, `PAX${i}`, p === 1 ? 'ALPHA' : 'BETA', now, now);
          const tid = id();
          insT.run(tid, bid, pid, `${String(1_000_000_000_000 + i * 2 + p)}`, airline, supplier, date, now, now);
          tickets.push(tid);
        }
        for (let s = 1; s <= 2; s++) {
          const o = airports[(i + s) % airports.length]!;
          let d = airports[(i + s + 7) % airports.length]!;
          if (d === o) d = airports[(i + s + 8) % airports.length]!;
          insS.run(id(), bid, s, airline, String(100 + (i % 800)), o, d, date, date, now, now);
        }
        bookings.push({ id: bid, customer, supplier, date, tickets });
      }
    })();
    for (const b of bookings) env.backend.svc.bookings.reindex(b.id);
    const tData = performance.now();

    // 30,000 financial documents through the real posting engine.
    const cash = (db.prepare('SELECT id FROM money_account LIMIT 1').get() as { id: string }).id;
    const post = env.backend.svc.posting;
    db.transaction(() => {
      for (const b of bookings) {
        post.post(admin, { docType: 'CUSTOMER_INVOICE', docDate: b.date, currency: 'EGP', customerId: b.customer, bookingId: b.id,
          lines: b.tickets.map((t) => ({ lineType: 'FARE' as const, amountMinor: 525_000, bookingId: b.id, ticketId: t })) });
        post.post(admin, { docType: 'SUPPLIER_BILL', docDate: b.date, currency: 'EGP', supplierId: b.supplier, bookingId: b.id,
          lines: b.tickets.map((t) => ({ lineType: 'PURCHASE_COST' as const, amountMinor: 505_000, bookingId: b.id, ticketId: t })) });
        post.post(admin, { docType: 'CUSTOMER_RECEIPT', docDate: b.date, currency: 'EGP', customerId: b.customer, bookingId: b.id, moneyAccountId: cash, paymentMethod: 'CASH',
          lines: [{ lineType: 'SETTLEMENT', amountMinor: 500_000, bookingId: b.id }] });
      }
    })();
    const tDocs = performance.now();
    // Top up the audit trail to 50,000+ events (e.g. logins/edits over a year).
    db.transaction(() => {
      for (let i = 0; i < 20_000; i++) env.backend.svc.deps.audit.append({ userId: admin.userId, sessionId: null, workstation: 'PERF' }, { action: 'customer.updated', entityType: 'customer', entityId: customers[i % N_CUST]! });
    })();
    const tAudit = performance.now();

    const counts = Object.fromEntries(['customer', 'supplier', 'airline', 'airport', 'booking', 'booking_passenger', 'flight_segment', 'ticket', 'fin_document', 'journal_line', 'audit_log']
      .map((tbl) => [tbl, (db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get() as { n: number }).n]));

    const time = async (label: string, fn: () => Promise<unknown>, runs = 5) => {
      await fn(); // warm-up
      const samples: number[] = [];
      for (let i = 0; i < runs; i++) { const s = performance.now(); await fn(); samples.push(performance.now() - s); }
      samples.sort((a, b) => a - b);
      return { label, medianMs: Math.round(samples[Math.floor(runs / 2)]! * 10) / 10, maxMs: Math.round(samples[runs - 1]! * 10) / 10 };
    };
    const call = async (c: string, p: unknown) => { const r = await env.call(c, p, adminSession); if (!r.ok) throw new Error(`${c}: ${JSON.stringify(r.error)}`); return r.data; };
    const someCustomer = customers[1234]!;
    const results = [
      await time('customer search (name)', () => call('customers.list', { query: 'محمد' })),
      await time('customer search (mobile fragment)', () => call('customers.list', { query: '10001234' })),
      await time('supplier search', () => call('suppliers.list', { query: 'Supplier 77' })),
      await time('ticket record search (PNR)', () => call('bookings.list', { query: 'P01234', status: 'ALL' })),
      await time('ticket record search (ticket number)', () => call('bookings.list', { query: '1000000002469', status: 'ALL' })),
      await time('ticket record list (open, first page)', () => call('bookings.list', { status: 'OPEN' })),
      await time('open ticket record (full detail)', () => call('bookings.get', { id: bookings[4321]!.id })),
      await time('global search', () => call('search.global', { query: 'P0999' })),
      await time('dashboard (month)', () => call('dashboard.metrics', { from: '2026-09-01', to: '2026-09-30' })),
      await time('dashboard (year)', () => call('dashboard.metrics', { from: '2025-10-01', to: '2026-09-30' })),
      await time('customer statement (year)', () => call('statements.get', { party: 'CUSTOMER', partyId: someCustomer, from: '2025-10-01', to: '2026-09-30' })),
      await time('supplier statement (year)', () => call('statements.get', { party: 'SUPPLIER', partyId: suppliers[17]!, from: '2025-10-01', to: '2026-09-30' })),
      await time('monthly sales report', () => call('reports.run', { report: 'sales', from: '2026-08-01', to: '2026-08-31' })),
      await time('monthly profit report', () => call('reports.run', { report: 'profit', from: '2026-08-01', to: '2026-08-31' })),
      await time('receivables aging (all customers)', () => call('aging.get', { party: 'CUSTOMER', asOf: '2026-09-30' }), 3),
      await time('supplier volume (year)', () => call('reports.run', { report: 'supplier_volume', from: '2025-10-01', to: '2026-09-30' }), 3),
      await time('cash & bank book (month)', () => call('reports.run', { report: 'cash_book', from: '2026-08-01', to: '2026-08-31' }), 3),
      await time('upcoming travel (7 days)', () => call('travel.upcoming', { from: '2026-09-01', to: '2026-09-07' })),
      await time('audit log (filtered by entity)', () => call('audit.list', { entityType: 'customer', entityId: someCustomer })),
      await time('integrity check (full)', () => call('integrity.run', {}), 1),
    ];
    const setup = { masterDataMs: Math.round(tData - t0), postingMs: Math.round(tDocs - tData), auditMs: Math.round(tAudit - tDocs) };
    db.pragma('wal_checkpoint(TRUNCATE)');
    const dbSizeMb = Math.round(((db.pragma('page_count', { simple: true }) as number) * (db.pragma('page_size', { simple: true }) as number)) / 1048576 * 10) / 10;
    const backupStart = performance.now();
    const backup = await env.backend.createBackup(null, 'MANUAL');
    const backupMs = Math.round(performance.now() - backupStart);
    const backupSizeMb = Math.round(backup.sizeBytes / 1048576 * 10) / 10;

    // Encrypted installation on the same data, with the backup worker thread exactly as in the desktop app.
    env.backend.close();
    mkdirSync(resolve(__dirname, '../../../node_modules/.cache'), { recursive: true });
    const bundleDir = mkdtempSync(resolve(__dirname, '../../../node_modules/.cache/airdesk-perf-'));
    const workerPath = resolve(bundleDir, 'backup-worker.cjs');
    await build({ entryPoints: [resolve(__dirname, '../src/worker/worker-entry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: workerPath, logLevel: 'silent', external: ['better-sqlite3-multiple-ciphers', '@node-rs/argon2'] });
    const keys = new Map<string, Buffer>();
    const launcher = await AppLauncher.start({
      dataDir: env.dataDir, appVersion: 'perf', logger: createMemoryLogger(), hasher: createArgon2Hasher(TEST_ARGON2), kdf: TEST_KDF, workerPath,
      deviceKeys: { kind: 'test', isAvailable: () => true, load: (k) => keys.get(k) ?? null, save: (k, v) => void keys.set(k, v), forget: (k) => void keys.delete(k), list: () => [...keys.keys()] },
    });
    const lcall = async (command: string, payload: unknown, sessionId: string | null = null) => launcher.dispatch({ command, payload, sessionId, workstation: 'PERF' });
    const sid = async () => ((await lcall('auth.login', { username: ADMIN.username, password: ADMIN.password })).session as { set: string }).set;
    const lagDuring = async (work: () => Promise<unknown>) => {
      let last = performance.now();
      let lag = 0;
      const t = setInterval(() => { const n = performance.now(); lag = Math.max(lag, n - last - 5); last = n; }, 5);
      const start = performance.now();
      const r = await work();
      clearInterval(t);
      lag = Math.max(lag, performance.now() - last - 5);
      return { ms: Math.round(performance.now() - start), maxEventLoopLagMs: Math.round(lag), r };
    };
    const passphrase = 'performance test recovery phrase';
    let s = await sid();
    const enable = await lagDuring(() => lcall('security.enableEncryption', { password: ADMIN.password, passphrase, confirmation: passphrase }, s));
    expect((enable.r as { ok: boolean }).ok).toBe(true);
    s = await sid();
    const encBackup = await lagDuring(() => lcall('backup.create', {}, s));
    const encIntegrity = await lagDuring(() => lcall('integrity.run', {}, s));
    const encSizeMb = Math.round(((encBackup.r as { data: { sizeBytes: number } }).data.sizeBytes / 1048576) * 10) / 10;
    const encrypted = {
      enableEncryptionMs: enable.ms, enableEncryptionMaxLagMs: enable.maxEventLoopLagMs,
      backupMs: encBackup.ms, backupMaxLagMs: encBackup.maxEventLoopLagMs, backupSizeMb: encSizeMb,
      integrityMs: encIntegrity.ms, integrityMaxLagMs: encIntegrity.maxEventLoopLagMs, workerJobs: launcher.backend!.jobs.stats,
    };
    launcher.close();
    rmSync(bundleDir, { recursive: true, force: true });
    expect(encBackup.maxEventLoopLagMs).toBeLessThan(1000);
    expect(encIntegrity.maxEventLoopLagMs).toBeLessThan(250);
    const report = { counts, setup, storage: { dbSizeMb, backupSizeMb, backupMs, encrypted }, results };
    writeFileSync(process.env.AIRDESK_PERF_OUT ?? 'perf-results.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    expect(counts.booking).toBe(N_BOOK);
    expect(counts.fin_document).toBe(3 * N_BOOK);
    expect(counts.audit_log).toBeGreaterThanOrEqual(50_000);
    // Every interactive operation and report must stay under a second on this dataset (the full integrity check is a maintenance task).
    for (const r of results.filter((x) => x.label !== 'integrity check (full)')) {
      expect(r.medianMs, r.label).toBeLessThan(1000);
    }
  }, 1_800_000);
});
