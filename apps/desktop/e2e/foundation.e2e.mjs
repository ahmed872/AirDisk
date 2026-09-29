/**
 * Phase 1 foundation E2E: drives the REAL Electron app (built with `pnpm build`)
 * through first-run setup, a rejected and an accepted login, company settings,
 * a validated backup, the integrity check and the language switch, and checks
 * that the renderer has no Node access. Run: `xvfb-run -a pnpm e2e` on Linux CI.
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
const SP = join(appDir, 'out', 'e2e-screenshots');
mkdirSync(SP, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'airdesk-e2e-'));
const app = await electron.launch({
  executablePath: electronPath,
  args: [appDir, '--no-sandbox'],
  env: { ...process.env, AIRDESK_DATA_DIR: dataDir },
});
const log = (...a) => console.log('E2E', ...a);
const win = await app.firstWindow();
await win.setViewportSize({ width: 1280, height: 820 });
await win.waitForSelector('text=إعداد الشركة لأول مرة');
assert.equal(await win.evaluate(() => document.documentElement.dir), 'rtl');
assert.equal(await win.evaluate(() => typeof require), 'undefined', 'renderer must not have Node');
assert.deepEqual(await win.evaluate(() => Object.keys(window.airdesk)), ['invoke', 'exportPdf', 'exportCsv', 'pickBackupFile', 'openAttachment'], 'bridge surface is exactly these five functions');
await win.screenshot({ path: `${SP}/01-setup.png` });
const inputs = win.locator('form input');
await inputs.nth(0).fill('وكالة النيل للسياحة');
await inputs.nth(1).fill('Nile Travel Agency');
await win.fill('[data-testid=setup-username]', 'owner');
await win.fill('[data-testid=setup-displayName]', 'Owner');
await win.fill('[data-testid=setup-password]', 'correct horse battery staple');
await win.fill('[data-testid=setup-confirm]', 'correct horse battery staple');
// Recovery passphrase: required, typed twice, acknowledged.
await win.click('[data-testid=setup-submit]');
assert.ok(await win.isVisible('[data-testid=setup-submit]'), 'setup does not finish without a recovery passphrase');
assert.equal(await win.$eval('[data-testid=recovery-passphrase]', (e) => e.validity.valid), false);
await win.fill('[data-testid=recovery-passphrase]', 'nile agency recovery phrase 2026');
await win.fill('[data-testid=recovery-confirm]', 'nile agency recovery phrase 2026');
await win.check('[data-testid=recovery-ack]');
await win.click('[data-testid=setup-submit]');
await win.waitForSelector('text=تسجيل الدخول');
await win.screenshot({ path: `${SP}/02-login.png` });
await win.fill('input[autocomplete=username]', 'owner');
await win.fill('input[type=password]', 'wrong password!!');
await win.click('button.primary');
await win.waitForSelector('[role=alert]');
assert.match(await win.textContent('[role=alert]'), /غير صحيحة/);
await win.fill('input[type=password]', 'correct horse battery staple');
await win.click('button.primary');
await win.waitForSelector('.sidebar');
assert.ok((await win.locator('.sidebar button span:first-child').allTextContents()).includes('المستخدمون والصلاحيات'));
await win.screenshot({ path: `${SP}/03-home.png` });
await win.click('[data-nav=company]');
await win.waitForSelector('text=الاسم القانوني (عربي)');
await win.screenshot({ path: `${SP}/04-company.png` });
await win.click('[data-nav=system]');
await win.click('text=نسخ احتياطي الآن');
await win.waitForSelector('[data-testid=page-system] > .alert.ok');
assert.match(await win.textContent('[data-testid=page-system] > .alert.ok'), /\.adbk$/);
assert.ok(await win.isVisible('[data-testid=encryption-on]'), 'backup page shows the data is encrypted');
await win.click('text=فحص سلامة البيانات');
await win.waitForSelector('text=كل الفحوص سليمة');
await win.screenshot({ path: `${SP}/05-system.png` });
await win.click('text=English');
await win.waitForSelector('text=Company settings');
assert.equal(await win.evaluate(() => document.documentElement.dir), 'ltr');
await win.screenshot({ path: `${SP}/06-english.png` });
const direct = await win.evaluate(() => window.airdesk.invoke('backup.restore', { filePath: 'x', password: 'y', confirmation: 'RESTORE' }));
assert.equal(direct.error?.code, 'INVALID_CREDENTIALS', 'restore must re-verify the password in the backend');
await app.close();
rmSync(dataDir, { recursive: true, force: true });
log('PASSED — screenshots in', SP);
