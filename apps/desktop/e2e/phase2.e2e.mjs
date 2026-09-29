/**
 * Phase 2 E2E — the 20-step acceptance scenario, driving the REAL Electron app
 * (built with `pnpm build`) from an empty data directory, including a full
 * application restart at the end. Run: `xvfb-run -a node apps/desktop/e2e/phase2.e2e.mjs`.
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
const SP = join(appDir, 'out', 'e2e-phase2');
mkdirSync(SP, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'airdesk-e2e2-'));
const ADMIN_PW = 'correct horse battery staple';
const AGENT_TEMP = 'temporary pass 12345';
const AGENT_PW = 'agent real secret 987';
let RECOVERY = '';

let app;
let win;
const results = [];
async function launch() {
  app = await electron.launch({ executablePath: electronPath, args: [appDir, '--no-sandbox'], env: { ...process.env, AIRDESK_DATA_DIR: dataDir } });
  win = await app.firstWindow();
  await win.setViewportSize({ width: 1366, height: 860 });
}
async function step(n, name, fn) {
  const started = Date.now();
  try {
    await fn();
    await win.screenshot({ path: `${SP}/${String(n).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-')}.png` });
    results.push({ n, name, ok: true, ms: Date.now() - started });
    console.log(`E2E step ${n} ✔ ${name}`);
  } catch (e) {
    results.push({ n, name, ok: false });
    console.log(`E2E step ${n} ✘ ${name}`);
    await win.screenshot({ path: `${SP}/FAILED-${n}.png` }).catch(() => undefined);
    throw e;
  }
}
const invoke = (command, payload = {}) => win.evaluate(([c, p]) => window.airdesk.invoke(c, p), [command, payload]);
const dir = () => win.evaluate(() => document.documentElement.dir);
const rows = (sel = '[data-testid=results] tbody tr') => win.locator(sel);
async function login(username, password) {
  await win.fill('[data-testid=login-username]', username);
  await win.fill('[data-testid=login-password]', password);
  await win.click('[data-testid=login-submit]');
}
async function signOut() {
  await win.click('[data-testid=sign-out]');
  await win.waitForSelector('[data-testid=login-username]');
}
async function search(text, expected) {
  await win.fill('[data-testid=search]', text);
  await win.waitForFunction(
    ([n]) => (n === 0 ? !!document.querySelector('[data-testid=empty-state]') : document.querySelectorAll('[data-testid=results] tbody tr').length === n),
    [expected],
  );
  // Let the debounce settle and assert it is stable.
  await win.waitForTimeout(400);
  assert.equal(expected === 0 ? 0 : await rows().count(), expected, `search "${text}"`);
}
async function fill(values) {
  for (const [k, v] of Object.entries(values)) {
    const el = win.locator(`[data-testid=f-${k}]`);
    if ((await el.evaluate((x) => x.tagName)) === 'SELECT') await el.selectOption(v);
    else await el.fill(v);
  }
}
const nav = (id) => win.click(`[data-nav=${id}]`);

try {
  await launch();

  await step(1, 'clean setup screen', async () => {
    await win.waitForSelector('[data-testid=setup-submit]');
    assert.equal(await dir(), 'rtl');
    assert.equal((await invoke('system.status')).data.setupRequired, true);
    assert.equal(await win.evaluate(() => typeof require), 'undefined', 'renderer must not have Node');
  });

  await step(2, 'company details', async () => {
    await win.fill('[data-testid=setup-legalNameAr]', 'وكالة الأفق للسفر');
    await win.fill('[data-testid=setup-legalNameEn]', 'Horizon Travel');
    await win.selectOption('[data-testid=setup-currency]', 'EGP');
    await win.fill('[data-testid=setup-country]', 'EG');
    await win.fill('[data-testid=setup-timezone]', 'Africa/Cairo');
  });

  await step(3, 'first administrator', async () => {
    await win.fill('[data-testid=setup-username]', 'owner');
    await win.fill('[data-testid=setup-displayName]', 'المالك');
    await win.fill('[data-testid=setup-password]', ADMIN_PW);
    await win.fill('[data-testid=setup-confirm]', ADMIN_PW);
    // Every new installation is encrypted: the owner sets the recovery passphrase (typed twice, acknowledged).
    await win.click('[data-testid=recovery-generate]');
    RECOVERY = (await win.textContent('[data-testid=recovery-suggested]')).trim();
    await win.fill('[data-testid=recovery-confirm]', RECOVERY.toLowerCase());
    await win.check('[data-testid=recovery-ack]');
    await win.click('[data-testid=setup-submit]');
    await win.waitForSelector('[data-testid=setup-done]');
    assert.equal((await invoke('system.status')).data.encrypted, true, 'new installations are encrypted');
    assert.equal((await invoke('system.status')).data.setupRequired, false);
    const again = await invoke('system.setup', {
      company: { legalNameAr: 'x', baseCurrencyCode: 'EGP', defaultCountryCode: 'EG', timezone: 'Africa/Cairo', defaultLocale: 'ar' },
      admin: { username: 'intruder', displayName: 'x', password: 'another long password', locale: 'ar' },
    });
    assert.equal(again.error?.code, 'SETUP_ALREADY_DONE', 'setup must never run twice');
  });

  await step(4, 'admin login', async () => {
    await login('owner', 'wrong password!!');
    await win.waitForSelector('[role=alert]');
    await login('owner', ADMIN_PW);
    await win.waitForSelector('[data-testid=page-dashboard]');
    await win.waitForSelector('[data-testid=tile-m_bookingsCreated]');
  });

  await step(5, 'arabic RTL shell', async () => {
    assert.equal(await dir(), 'rtl');
    assert.equal(await win.evaluate(() => document.documentElement.lang), 'ar');
    const labels = await win.locator('.sidebar button span:first-child').allTextContents();
    for (const l of ['لوحة التحكم', 'سجلات التذاكر', 'الرحلات القادمة', 'العملاء', 'الموردون', 'شركات الطيران', 'المدفوعات والمالية', 'التقارير وكشوف الحساب', 'المستخدمون والصلاحيات', 'إعدادات الشركة', 'سجل التدقيق', 'النسخ الاحتياطي والاستعادة']) {
      assert.ok(labels.includes(l), `nav ${l}`);
    }
    // Scope: AirDesk records externally booked tickets — there is no flight search or booking function anywhere.
    const text = await win.evaluate(() => document.body.innerText);
    for (const banned of ['Search flights', 'Book flight', 'بحث عن رحلات', 'احجز رحلة']) assert.ok(!text.includes(banned), banned);
  });

  await step(6, 'switch to English LTR', async () => {
    await win.click('[data-testid=toggle-language]');
    await win.waitForSelector('text=Customers');
    assert.equal(await dir(), 'ltr');
    assert.equal(await win.evaluate(() => document.documentElement.lang), 'en');
  });

  await step(7, 'create customer (validation + duplicate warning)', async () => {
    await nav('customers');
    await win.waitForSelector('[data-testid=empty-state]');
    await win.click('[data-testid=new]');
    await fill({ fullName: 'أحمد إبراهيم', primaryMobile: 'abc', email: 'ahmed@example.com' });
    await win.click('[data-testid=save]');
    await win.waitForSelector('#e-primaryMobile');
    assert.match(await win.textContent('#e-primaryMobile'), /valid phone/);
    await fill({ primaryMobile: '0100 123 4567', whatsappNumber: '+966 50 123 4567' });
    await win.click('[data-testid=save]');
    await win.waitForSelector('[data-testid=results] tbody tr');
    assert.equal(await rows().count(), 1);
    assert.match(await rows().first().textContent(), /C-000001.*\+201001234567/);
    // Same phone again → warning only; going back creates nothing.
    await win.click('[data-testid=new]');
    await fill({ fullName: 'Another Person', primaryMobile: '+20 100 123 4567' });
    await win.click('[data-testid=save]');
    await win.waitForSelector('[data-testid=duplicate-dialog]');
    assert.match(await win.textContent('[data-testid=duplicate-dialog]'), /C-000001.*Same phone number/s);
    await win.click('text=Go back and edit');
    await win.click('[data-testid=edit-dialog] >> text=Close');
    assert.equal(await rows().count(), 1);
  });

  await step(8, 'search customer', async () => {
    await search('احمد ابراهيم', 1);
    await search('1234567', 1);
    await search('AHMED@EXAMPLE', 1);
    await search('zzzz-nothing', 0);
    await search('', 1);
  });

  await step(9, 'edit customer', async () => {
    await rows().first().click();
    await fill({ address: 'Cairo, Nasr City', notes: 'VIP' });
    await win.click('[data-testid=save]');
    await win.waitForSelector('.alert.ok');
    await rows().first().click();
    assert.equal(await win.inputValue('[data-testid=f-address]'), 'Cairo, Nasr City');
    await win.click('[data-testid=edit-dialog] >> text=Close');
  });

  await step(10, 'archive customer', async () => {
    await rows().first().click();
    await win.click('[data-testid=archive]');
    await win.click('[data-testid=confirm]');
    await win.waitForSelector('[data-testid=empty-state]');
    await win.selectOption('[data-testid=status-filter]', 'ARCHIVED');
    await win.waitForSelector('[data-testid=results] [data-status=ARCHIVED]');
    await rows().first().click();
    assert.equal(await win.locator('[data-testid=save]').count(), 0, 'archived records are read-only');
    await win.click('[data-testid=edit-dialog] >> text=Close');
  });

  await step(11, 'create supplier (back in Arabic)', async () => {
    await win.click('[data-testid=toggle-language]');
    await win.waitForFunction(() => document.documentElement.dir === 'rtl');
    await nav('suppliers');
    await win.click('[data-testid=new]');
    await fill({ name: 'شركة الأفق للتوزيع', contactPerson: 'هاني', phonePrimary: '02 2345 6789', email: 'ops@ofok.example', defaultCurrencyCode: 'EGP' });
    await win.click('[data-testid=save]');
    await win.waitForSelector('[data-testid=results] tbody tr');
    assert.match(await rows().first().textContent(), /S-000001/);
  });

  await step(12, 'search supplier', async () => {
    await search('الافق', 1);
    await search('23456789', 1);
    await search('هاني', 1);
    await search('غير موجود', 0);
  });

  await step(13, 'create airline', async () => {
    await nav('airlines');
    await win.click('[data-testid=new]');
    await fill({ nameEn: 'EgyptAir', nameAr: 'مصر للطيران', iataCode: 'ms', icaoCode: 'msr', ticketPrefix: '077', countryCode: 'eg' });
    await win.click('[data-testid=save]');
    await win.waitForSelector('[data-testid=results] tbody tr');
    assert.match(await rows().first().textContent(), /MS.*MSR.*EgyptAir/);
    await win.click('[data-testid=new]');
    await fill({ nameEn: 'Clash', iataCode: 'MS' });
    await win.click('[data-testid=save]');
    await win.waitForSelector('#e-iataCode');
    await win.click('[data-testid=edit-dialog] >> text=إغلاق');
  });

  await step(14, 'create second user', async () => {
    await nav('users');
    await win.waitForSelector('[data-testid=users-table]');
    await win.click('[data-testid=new-user]');
    await fill({ username: 'agent1', displayName: 'سارة', email: 'sara@example.com', mobile: '0100 555 1234', password: AGENT_TEMP });
    await win.uncheck('[data-testid=role-SALES_AGENT]');
    await win.check('[data-testid=role-ACCOUNTANT]');
    await win.click('[data-testid=save]');
    await win.waitForSelector('tr[data-username=agent1]');
  });

  await step(15, 'assign Sales Agent role', async () => {
    await win.click('tr[data-username=agent1] [data-testid=edit-user]');
    await win.uncheck('[data-testid=role-ACCOUNTANT]');
    await win.check('[data-testid=role-SALES_AGENT]');
    await win.click('[data-testid=save]');
    await win.waitForFunction(() => /موظف مبيعات|Sales/.test(document.querySelector('tr[data-username=agent1]')?.textContent ?? '') && !/محاسب/.test(document.querySelector('tr[data-username=agent1]')?.textContent ?? ''));
    await win.click('[data-testid=tab-roles]');
    await win.click('[data-role=SALES_AGENT]');
    await win.waitForSelector('[data-testid=role-editor]');
    assert.equal(await win.isChecked('[data-perm="supplier.view_financial"]'), false);
    assert.equal(await win.isChecked('[data-perm="booking.view_profit"]'), false);
  });

  await step(16, 'login as sales agent', async () => {
    await signOut();
    await login('agent1', AGENT_TEMP);
    await win.waitForSelector('[data-testid=cp-new]');
    await win.fill('[data-testid=cp-current]', AGENT_TEMP);
    await win.fill('[data-testid=cp-new]', AGENT_PW);
    await win.fill('[data-testid=cp-confirm]', AGENT_PW);
    await win.click('[data-testid=cp-submit]');
    await win.waitForSelector('[data-testid=page-dashboard]');
    assert.equal(await win.textContent('[data-testid=current-user]'), 'سارة');
  });

  await step(17, 'restricted access enforced', async () => {
    const navs = await win.locator('.sidebar [data-nav]').evaluateAll((els) => els.map((e) => e.getAttribute('data-nav')));
    for (const hidden of ['users', 'audit', 'system']) assert.ok(!navs.includes(hidden), `agent must not see ${hidden}`);
    await nav('suppliers');
    await win.waitForSelector('[data-testid=results] tbody tr');
    assert.equal(await win.locator('[data-testid=new]').count(), 0, 'agent cannot create suppliers');
    await rows().first().click();
    await win.waitForSelector('text=البيانات المالية مخفية');
    await win.click('[data-testid=edit-dialog] >> text=إغلاق');
    const sup = (await invoke('suppliers.list', {})).data.items[0];
    assert.equal(sup.balances, null, 'supplier financials are redacted server-side');
    // Backend authorization — even with the UI bypassed.
    const denied = [
      ['roles.create', { code: 'HACK', nameAr: 'x', nameEn: 'x', permissions: [] }],
      ['users.list', {}],
      ['company.update', { profile: { legalNameAr: 'x', baseCurrencyCode: 'USD', defaultCountryCode: 'EG', timezone: 'Africa/Cairo', defaultLocale: 'ar' }, rowVersion: 1 }],
      ['ledger.summary', { from: '2026-01-01', to: '2026-12-31' }],
      ['audit.list', {}],
      ['backup.create', {}],
    ];
    for (const [c, p] of denied) assert.equal((await invoke(c, p)).error?.code, 'FORBIDDEN', c);
    await nav('customers');
    await win.waitForSelector('[data-testid=page-customers]');
  });

  await step(18, 'log back in as admin', async () => {
    await signOut();
    await login('owner', ADMIN_PW);
    await win.waitForSelector('[data-testid=page-dashboard]');
  });

  await step(19, 'audit events recorded', async () => {
    await nav('audit');
    await win.waitForSelector('[data-testid=audit-table]');
    const actions = await win.locator('[data-testid=audit-table] [data-action]').evaluateAll((els) => els.map((e) => e.getAttribute('data-action')));
    for (const a of ['setup.completed', 'customer.created', 'customer.updated', 'customer.archived', 'supplier.created', 'airline.created', 'user.created', 'user.roles_changed', 'auth.permission_denied', 'auth.login']) {
      assert.ok(actions.includes(a), `audit has ${a}`);
    }
    await win.fill('[data-testid=audit-action]', 'customer.');
    await win.click('[data-testid=audit-apply]');
    await win.waitForFunction(() => [...document.querySelectorAll('[data-testid=audit-table] [data-action]')].every((e) => e.getAttribute('data-action').startsWith('customer.')));
    assert.equal((await invoke('integrity.run')).data.ok, true, 'hash chain + ledger integrity');
  });

  await step(20, 'data persists after restart', async () => {
    await app.close();
    await launch();
    // Linux CI has no OS keyring: the encrypted data asks for the recovery passphrase (Windows opens it through DPAPI).
    await win.waitForSelector('[data-testid=unlock-page], [data-testid=login-username]');
    if (await win.isVisible('[data-testid=unlock-page]')) {
      await win.fill('[data-testid=unlock-passphrase]', 'wrong recovery passphrase');
      await win.click('[data-testid=unlock-submit]');
      await win.waitForSelector('[data-testid=unlock-page] .alert.error');
      await win.waitForTimeout(2100);
      await win.fill('[data-testid=unlock-passphrase]', RECOVERY);
      await win.click('[data-testid=unlock-submit]');
    }
    await win.waitForSelector('[data-testid=login-username]');
    assert.equal((await invoke('system.status')).data.setupRequired, false);
    await login('owner', ADMIN_PW);
    await win.waitForSelector('[data-testid=tile-m_bookingsCreated]');
    await nav('customers');
    await win.selectOption('[data-testid=status-filter]', 'ALL');
    await win.waitForSelector('[data-testid=results] [data-status=ARCHIVED]');
    assert.match(await rows().first().textContent(), /أحمد إبراهيم/);
    await nav('suppliers');
    await win.waitForSelector('text=S-000001');
    await nav('airlines');
    await win.waitForSelector('text=EgyptAir');
    await nav('users');
    await win.waitForSelector('tr[data-username=agent1]');
    assert.match(await win.textContent('tr[data-username=agent1]'), /سارة/);
  });

  console.log(`E2E PASSED ${results.filter((r) => r.ok).length}/20 — screenshots in ${SP}`);
} finally {
  await app?.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
}
