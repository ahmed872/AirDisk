/**
 * Operations E2E — the ticket-office workflow in the REAL Electron app at
 * 1366×768: record an externally issued ticket (customer → passenger → PNR →
 * flight → supplier → cost → customer price), confirm it as ticketed, take two
 * customer payments, pay the supplier, record a schedule change and the customer
 * notification, then check profit, statement, travel and dashboard — and that a
 * Sales Agent cannot see cost/profit. Also covers go-live opening balances, a
 * cash-to-bank transfer and applying a customer credit to a record. Run: `xvfb-run -a node apps/desktop/e2e/operations.e2e.mjs`.
 */
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const electronPath = createRequire(import.meta.url)('electron');
const SP = join(appDir, 'out', 'e2e-operations');
mkdirSync(SP, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'airdesk-e2e-ops-'));
const PW = 'correct horse battery staple';
let app;
let win;
let n = 0;
const shot = async (name) => win.screenshot({ path: `${SP}/${String(++n).padStart(2, '0')}-${name}.png` });
const step = async (name, fn) => {
  try {
    await fn();
    await shot(name);
    console.log(`E2E ✔ ${name}`);
  } catch (e) {
    await win.screenshot({ path: `${SP}/FAILED-${name}.png` }).catch(() => undefined);
    console.log(`E2E ✘ ${name}`);
    throw e;
  }
};
const invoke = (c, p = {}) => win.evaluate(([cmd, payload]) => window.airdesk.invoke(cmd, payload), [c, p]);
const must = async (c, p) => { const r = await invoke(c, p); if (!r.ok) throw new Error(`${c}: ${JSON.stringify(r.error)}`); return r.data; };
const text = (sel) => win.textContent(sel);
const dialog = '[role=dialog]';
const saveDialog = async () => { await win.click(`${dialog} [data-testid=save]`); await win.waitForSelector(dialog, { state: 'detached' }); };
const login = async (u, p) => {
  await win.fill('[data-testid=login-username]', u);
  await win.fill('[data-testid=login-password]', p);
  await win.click('[data-testid=login-submit]');
};

try {
  app = await electron.launch({ executablePath: electronPath, args: [appDir, '--no-sandbox'], env: { ...process.env, AIRDESK_DATA_DIR: dataDir } });
  win = await app.firstWindow();
  await win.setViewportSize({ width: 1366, height: 768 });

  await step('setup-and-login', async () => {
    await win.fill('[data-testid=setup-legalNameAr]', 'وكالة الأفق للسفر');
    await win.fill('[data-testid=setup-legalNameEn]', 'Horizon Travel');
    await win.fill('[data-testid=setup-username]', 'owner');
    await win.fill('[data-testid=setup-displayName]', 'المالك');
    await win.fill('[data-testid=setup-password]', PW);
    await win.fill('[data-testid=setup-confirm]', PW);
    await win.click('[data-testid=setup-submit]');
    await win.waitForSelector('[data-testid=setup-done]');
    await login('owner', PW);
    await win.waitForSelector('[data-testid=page-dashboard]');
    await must('suppliers.create', { supplier: { name: 'Company ABC', defaultCurrencyCode: 'EGP' } });
    await must('airlines.create', { airline: { nameEn: 'EgyptAir', nameAr: 'مصر للطيران', iataCode: 'MS', ticketPrefix: '077' } });
  });

  await step('record-ticket-header', async () => {
    await win.click('[data-nav=tickets]');
    await win.waitForSelector('[data-testid=page-tickets]');
    await win.click('[data-testid=new-record]');
    await win.fill('[data-testid=customer-search]', 'أحمد علي');
    await win.click('[data-testid=quick-customer]');
    await win.fill('[data-testid=qc-mobile]', '0100 123 4567');
    await win.click('[data-testid=qc-save]');
    await win.waitForSelector('[data-testid=picked-customer]');
    await win.fill('[data-testid=nr-pnr]', 'abc123');
    await win.selectOption('[data-testid=nr-supplier]', { label: 'Company ABC (S-000001)' });
    await win.selectOption('[data-testid=nr-airline]', { label: 'MS · مصر للطيران' });
    await win.click('[data-testid=create-record]');
    await win.waitForSelector('[data-testid=page-record]');
    assert.equal(await win.getAttribute('[data-testid=record-status]', 'data-status'), 'DRAFT');
  });

  await step('passenger-flight-price', async () => {
    await win.click('[data-testid=add-passenger]');
    await win.fill('[data-testid=p-given]', 'Ahmed');
    await win.fill('[data-testid=p-surname]', 'Ali');
    await saveDialog();
    await win.click('[data-testid=add-segment]');
    await win.fill('[data-testid=s-flight]', '915');
    await win.fill('[data-testid=s-origin]', 'CAI');
    await win.fill('[data-testid=s-destination]', 'JED');
    await win.fill('[data-testid=s-dep-date]', '2026-10-15');
    await win.fill('[data-testid=s-dep-time]', '10:00');
    await win.fill('[data-testid=s-arr-date]', '2026-10-15');
    await win.fill('[data-testid=s-arr-time]', '12:30');
    await saveDialog();
    await win.click('[data-testid=set-price]');
    await win.fill('[data-testid=pr-ticket]', '077-2345678901');
    await win.fill('[data-testid=pr-fare]', '9,000');
    await win.fill('[data-testid=pr-taxes]', '1500');
    await win.fill('[data-testid=pr-cost]', '10100');
    assert.match(await text('[data-testid=price-total]'), /10,500\.00 EGP/);
    await saveDialog();
    assert.match(await text('[data-testid=quote-total]'), /10,500\.00/);
  });

  await step('confirm-ticketed', async () => {
    await win.click('[data-testid=confirm-ticketed]');
    await win.click('[data-testid=ticketed-dialog] [data-testid=confirm]');
    await win.waitForSelector('[data-testid=record-status][data-status=ISSUED]');
    assert.match(await text('[data-testid=tickets-table]'), /0772345678901/);
    assert.match(await text('[data-testid=acc-remaining]'), /10,500\.00/);
    assert.match(await text('[data-testid=gross-profit]'), /400\.00/);
  });

  await step('two-customer-payments', async () => {
    await win.click('[data-testid=record-payment]');
    assert.match(await text('[data-testid=pay-summary]'), /10,500\.00/);
    await win.fill('[data-testid=pay-amount]', '5000');
    await win.fill('[data-testid=pay-reference]', 'R-1');
    await win.click('[data-testid=pay-submit]');
    await win.waitForSelector('[data-testid=print-dialog]');
    assert.match(await text('[data-testid=print-dialog]'), /RCT-\d{4}-000001/);
    await shot('receipt');
    await win.click('[data-testid=print-dialog] footer button:has-text("إغلاق")');
    await win.waitForFunction(() => /5,500\.00/.test(document.querySelector('[data-testid=acc-remaining]')?.textContent ?? ''));
    assert.equal(await win.getAttribute('[data-testid=settlement]', 'class'), 'badge bad');
    await win.click('[data-testid=record-payment]');
    await win.click('[data-testid=pay-submit]'); // prefilled with the remaining 5,500
    await win.waitForSelector('[data-testid=print-dialog]');
    await win.click('[data-testid=print-dialog] footer button:has-text("إغلاق")');
    await win.waitForFunction(() => /0\.00/.test(document.querySelector('[data-testid=acc-remaining]')?.textContent ?? ''));
    assert.match(await text('[data-testid=settlement]'), /مدفوع بالكامل/);
  });

  await step('pay-supplier', async () => {
    await win.click('[data-testid=pay-supplier]');
    await win.click('[data-testid=pay-submit]');
    await win.waitForSelector('[data-testid=print-dialog]');
    await win.click('[data-testid=print-dialog] footer button:has-text("إغلاق")');
    await win.waitForFunction(() => /0\.00/.test(document.querySelector('[data-testid=sup-remaining]')?.textContent ?? ''));
    assert.match(await text('[data-testid=gross-profit]'), /400\.00/); // paying the supplier does not reduce profit
  });

  await step('schedule-change-and-notification', async () => {
    await win.click('[data-testid=edit-segment]');
    await win.fill('[data-testid=s-dep-time]', '13:15');
    await win.fill('[data-testid=s-arr-time]', '15:45');
    await win.fill('[data-testid=s-reason]', 'Airline notice');
    await saveDialog();
    await win.waitForSelector('[data-testid=schedule-banner]');
    assert.match(await text('[data-testid=schedule-changes]'), /10:00[\s\S]*13:15/);
    await shot('schedule-banner');
    await win.click('[data-testid=notify-customer]');
    await win.waitForFunction(() => (document.querySelector('[data-testid=notify-body]')?.value ?? '').includes('13:15'));
    await win.click('[data-testid=notify-sent]');
    await win.waitForSelector('[data-testid=schedule-banner]', { state: 'detached' });
    assert.match(await text('[data-testid=change-status]'), /تم الإبلاغ/);
  });

  await step('travel-reports-statement-dashboard', async () => {
    await win.click('[data-nav=travel]');
    await win.fill('input[type=date] >> nth=0', '2026-10-01');
    await win.fill('input[type=date] >> nth=1', '2026-10-31');
    await win.waitForSelector('[data-testid=travel-table]');
    assert.match(await text('[data-testid=travel-table]'), /MS915/);
    await win.click('[data-nav=reports]');
    await win.selectOption('[data-testid=report-id]', 'profit');
    await win.fill('[data-testid=report-from]', '2026-01-01');
    await win.fill('[data-testid=report-to]', '2026-12-31');
    await win.click('[data-testid=run-report]');
    await win.waitForSelector('[data-testid=report-totals]');
    assert.match(await text('[data-testid=report-totals]'), /400\.00/);
    await shot('profit-report');
    await win.click('[data-testid=tab-statements]');
    await win.fill('[data-testid=customer-search]', 'احمد');
    await win.click('[data-testid=customer-option]');
    await win.click('[data-testid=run-statement]');
    await win.waitForSelector('[data-testid=statement-lines]');
    const rows = await win.locator('[data-testid=statement-lines] tbody tr').count();
    assert.equal(rows, 3); // invoice + two receipts
    assert.match(await text('[data-testid=statement-lines] tfoot'), /0\.00/);
    await win.click('[data-nav=dashboard]');
    await win.click('[data-testid=range-customRange]');
    await win.waitForSelector('[data-testid=tile-m_sales]');
    const all = await must('dashboard.metrics', { from: '2026-01-01', to: '2026-12-31' });
    assert.equal(all.financial.grossProfit, 40_000);
    assert.equal(all.financial.receivables, 0);
  });

  await step('opening-balance-transfer-apply-credit', async () => {
    const closePrint = async () => { await win.click('[data-testid=print-dialog] footer button:has-text("إغلاق")'); await win.waitForSelector('[data-testid=print-dialog]', { state: 'detached' }); };
    const bank = await must('moneyAccounts.save', { name: 'البنك الأهلي', accountType: 'BANK', currencyCode: 'EGP', bankName: 'NBE' });
    const cash = (await must('moneyAccounts.list', {})).find((a) => a.accountType === 'CASH');
    // Go-live cash on hand, through the Opening balances tab.
    await win.click('[data-nav=finance]');
    await win.click('[data-testid=fin-tab-opening]');
    await win.click('[data-testid=new-opening]');
    await win.selectOption('[data-testid=opening-target]', 'MONEY_ACCOUNT');
    await win.selectOption('[data-testid=opening-account]', cash.id);
    await win.fill('[data-testid=opening-amount]', '3000');
    await win.click('[data-testid=opening-dialog] [data-testid=save]');
    await win.waitForSelector('[data-testid=print-dialog]');
    assert.match(await text('[data-testid=print-dialog]'), /OPB-\d{4}-000001/);
    await closePrint();
    assert.match(await text('[data-testid=opening-balances]'), /3,000\.00/);
    // Deposit cash in the bank.
    await win.click('[data-testid=fin-tab-treasury]');
    await win.click('[data-testid=new-transfer]');
    await win.selectOption('[data-testid=transfer-from]', cash.id);
    await win.selectOption('[data-testid=transfer-to]', bank.id);
    await win.fill('[data-testid=transfer-amount]', '2000');
    await win.click('[data-testid=transfer-dialog] [data-testid=save]');
    await win.waitForSelector('[data-testid=print-dialog]');
    assert.match(await text('[data-testid=print-dialog]'), /TRF-\d{4}-000001/);
    await closePrint();
    await win.waitForFunction(() => /البنك الأهلي[\s\S]*2,000\.00/.test(document.querySelector('[data-testid=accounts-table]')?.textContent ?? ''));
    assert.match(await text('[data-testid=transfers]'), /TRF-\d{4}-000001/);
    await shot('treasury-after-transfer');
    // A customer credit (overpaid before go-live) settles a new ticket record.
    const customer = (await must('customers.list', { query: 'احمد' })).items[0];
    await must('openingBalances.record', { target: 'CUSTOMER', targetId: customer.id, side: 'OWED_BY_OFFICE', currency: 'EGP', amountMinor: 50000 });
    const airline = (await must('airlines.list', { query: 'MS' })).items[0];
    const supplier = (await must('suppliers.list', {})).items[0];
    let r = await must('bookings.create', { customerId: customer.id, pnr: 'CRD123', supplierId: supplier.id });
    r = await must('bookings.savePassenger', { bookingId: r.id, passenger: { givenName: 'AHMED', surname: 'ALI' } });
    r = await must('bookings.saveSegment', { bookingId: r.id, segment: { airlineId: airline.id, flightNumber: '911', origin: 'CAI', destination: 'DXB', departureDate: '2026-12-01', departureTime: '08:00', arrivalDate: '2026-12-01', arrivalTime: '12:00' } });
    r = await must('bookings.savePriceItem', { bookingId: r.id, item: { passengerId: r.passengers[0].id, supplierId: supplier.id, fareMinor: 200000, costMinor: 180000, costCurrency: 'EGP' } });
    r = await must('bookings.issue', { id: r.id, rowVersion: r.rowVersion });
    await win.click('[data-testid=fin-tab-customer]');
    await win.fill('[data-testid=customer-search]', 'احمد');
    await win.click('[data-testid=customer-option] >> nth=0');
    await win.waitForSelector('[data-testid=open-items]');
    await win.click('[data-testid=fin-apply-EGP]');
    await win.waitForSelector('[data-testid=apply-credit-dialog]');
    assert.match(await text('[data-testid=apply-credit-dialog]'), /500\.00/);
    await win.click('[data-testid=apply-credit-dialog] [data-testid=save]');
    await win.waitForSelector('[data-testid=print-dialog]');
    assert.match(await text('[data-testid=print-dialog]'), /APL-\d{4}-000001/);
    await closePrint();
    const after = await must('bookings.get', { id: r.id });
    assert.deepEqual([after.customer[0].paidMinor, after.customer[0].balanceMinor], [50000, 150000]);
    await win.waitForFunction(() => /1,500\.00/.test(document.querySelector('[data-testid=open-items]')?.textContent ?? ''));
  });

  await step('reissue-date-change', async () => {
    await win.fill('[data-testid=global-search]', 'CRD123');
    await win.click('[data-testid=global-results] [data-hit=booking]');
    await win.waitForSelector('[data-testid=page-record]');
    await win.click('[data-testid=reissue-ticket]');
    await win.waitForSelector('[data-testid=reissue-dialog]');
    await win.fill('[data-testid=ri-number]', '0779990001112');
    await win.fill('[data-testid=ri-fee]', '300');
    await win.fill('[data-testid=ri-penalty]', '150');
    await win.fill('[data-testid=ri-dep-1]', '2026-12-05');
    await win.fill('[data-testid=ri-arr-1]', '2026-12-05');
    await win.fill('[data-testid=ri-reason]', 'العميل غيّر الموعد إلى 5 ديسمبر');
    await shot('reissue-dialog');
    await saveDialog();
    await win.waitForSelector('[data-testid=tickets-table] tr[data-ticket=EXCHANGED]');
    assert.match(await text('[data-testid=tickets-table]'), /0779990001112/);
    assert.match(await text('[data-testid=tickets-table]'), /مستبدلة/);
    await win.waitForFunction(() => /1,800\.00/.test(document.querySelector('[data-testid=acc-remaining]')?.textContent ?? '')); // 1,500 open + 300 change fee
    assert.equal(await win.locator('[data-testid=schedule-banner]').count(), 0, 'a customer-requested change raises no notification alert');
  });

  await step('layout-1366x768-and-1920x1080', async () => {
    // No page may overflow horizontally at the two reference resolutions (wide tables scroll inside their own container).
    const pages = ['dashboard', 'tickets', 'travel', 'customers', 'suppliers', 'finance', 'reports', 'users', 'company', 'audit', 'system'];
    for (const size of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
      await win.setViewportSize(size);
      for (const p of pages) {
        await win.click(`[data-nav=${p}]`);
        await win.waitForSelector(`[data-testid=page-${p}]`);
        const overflow = await win.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `${p} overflows horizontally by ${overflow}px at ${size.width}x${size.height}`);
      }
      await win.click('[data-nav=tickets]');
      await win.click('[data-record] >> nth=0');
      await win.waitForSelector('[data-testid=page-record]');
      const overflow = await win.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `record page overflows by ${overflow}px at ${size.width}x${size.height}`);
      await shot(`record-${size.width}x${size.height}`);
      await win.click('[data-nav=dashboard]');
      await shot(`dashboard-${size.width}x${size.height}`);
    }
    await win.setViewportSize({ width: 1366, height: 768 });
  });

  await step('global-search-and-english', async () => {
    await win.fill('[data-testid=global-search]', 'ABC123');
    await win.click('[data-testid=global-results] [data-hit=booking]');
    await win.waitForSelector('[data-testid=page-record]');
    await win.click('[data-testid=toggle-language]');
    await win.waitForFunction(() => document.documentElement.dir === 'ltr');
    await win.waitForSelector('text=Ticket record');
    assert.match(await text('[data-testid=settlement]'), /Paid/);
  });

  await step('sales-agent-cannot-see-cost-or-profit', async () => {
    await must('users.create', { username: 'agent1', displayName: 'Sara', password: 'temporary pass 12345', roleCodes: ['SALES_AGENT'] });
    await win.click('[data-testid=sign-out]');
    await login('agent1', 'temporary pass 12345');
    await win.fill('[data-testid=cp-current]', 'temporary pass 12345');
    await win.fill('[data-testid=cp-new]', 'agent real secret 987');
    await win.fill('[data-testid=cp-confirm]', 'agent real secret 987');
    await win.click('[data-testid=cp-submit]');
    await win.waitForSelector('[data-testid=page-dashboard]');
    const customers = await must('customers.list', { query: 'احمد' });
    const rec = await must('bookings.create', { customerId: customers.items[0].id, pnr: 'XYZ789' });
    let b = await must('bookings.savePassenger', { bookingId: rec.id, passenger: { givenName: 'Mona', surname: 'Ali' } });
    const airline = (await must('airlines.list', { query: 'MS' })).items[0];
    const supplier = (await must('suppliers.list', {})).items[0];
    b = await must('bookings.saveSegment', { bookingId: b.id, segment: { airlineId: airline.id, flightNumber: '917', origin: 'CAI', destination: 'JED', departureDate: '2026-11-01', departureTime: '09:00', arrivalDate: '2026-11-01', arrivalTime: '11:30' } });
    b = await must('bookings.savePriceItem', { bookingId: b.id, item: { passengerId: b.passengers[0].id, supplierId: supplier.id, fareMinor: 800000, costMinor: 750000, costCurrency: 'EGP' } });
    await must('bookings.issue', { id: b.id, rowVersion: b.rowVersion });
    await win.click('[data-nav=tickets]');
    await win.click('[data-record] >> nth=0');
    await win.waitForSelector('[data-testid=page-record]');
    assert.equal(await win.locator('[data-testid=profit-box]').count(), 0);
    assert.equal(await win.locator('[data-testid=supplier-account]').count(), 0);
    assert.match(await text('[data-testid=pricing-table]'), /تم إدخال التكلفة \(مخفية\)|Cost entered \(hidden\)/);
    assert.doesNotMatch(await text('[data-testid=page-record]'), /7,500\.00/);
    const navs = await win.locator('.sidebar [data-nav]').evaluateAll((els) => els.map((e) => e.getAttribute('data-nav')));
    for (const hidden of ['users', 'audit', 'system']) assert.ok(!navs.includes(hidden));
    const denied = await invoke('reports.run', { report: 'profit', from: '2026-01-01', to: '2026-12-31' });
    assert.equal(denied.error?.code, 'FORBIDDEN');
    const others = await invoke('bookings.list', { status: 'ALL' });
    assert.equal(others.data.total, 1, 'agent only sees their own records');
  });

  console.log(`E2E OPERATIONS PASSED — screenshots in ${SP}`);
} finally {
  await app?.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
}
