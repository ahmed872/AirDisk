import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppBackend, ManualClock, SYSTEM_ACTOR, TEST_ARGON2, createArgon2Hasher, createMemoryLogger } from '../src';
import { COMPANY, ADMIN, tempDir } from './helpers';

/**
 * Regression guard for "a large backup freezes the app": backup packaging,
 * verification and the full integrity check must run on the worker thread,
 * leaving the main event loop (which serves every window) responsive. The
 * worker is bundled exactly like the desktop build does.
 */
let workerPath = '';
let bundleDir = '';
beforeAll(async () => {
  // Inside the repository so the bundle resolves the native modules from node_modules.
  mkdirSync(resolve(__dirname, '../../../node_modules/.cache'), { recursive: true });
  bundleDir = mkdtempSync(resolve(__dirname, '../../../node_modules/.cache/airdesk-worker-'));
  workerPath = join(bundleDir, 'backup-worker.cjs');
  await build({
    entryPoints: [resolve(__dirname, '../src/worker/worker-entry.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: workerPath, logLevel: 'silent',
    external: ['better-sqlite3-multiple-ciphers', '@node-rs/argon2'],
  });
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

async function bigBackend(dataDir: string, worker: string | null): Promise<{ b: AppBackend; session: string }> {
  const b = await AppBackend.open({
    dataDir, appVersion: 't', clock: new ManualClock('2026-09-28T09:00:00.000Z'), logger: createMemoryLogger(), hasher: createArgon2Hasher(TEST_ARGON2), workerPath: worker,
  });
  const call = (command: string, payload: unknown, sessionId: string | null = null) => b.dispatch({ command, payload, sessionId, workstation: 'T' });
  if (b.svc.auth.isSetupRequired()) {
    await call('system.setup', { company: COMPANY, admin: { username: ADMIN.username, displayName: 'Owner', password: ADMIN.password, locale: 'ar' } });
    // Enough history that verifying the audit chain alone takes a noticeable time.
    const db = b.internals.db;
    db.transaction(() => {
      for (let i = 0; i < 60_000; i++) b.svc.deps.audit.append(SYSTEM_ACTOR, { action: 'test.bulk', entityType: 'test', metadata: { i, pad: 'x'.repeat(200) } });
    })();
  }
  const r = await call('auth.login', { username: ADMIN.username, password: ADMIN.password });
  return { b, session: (r.session as { set: string }).set };
}

/** Largest gap between 5 ms timer ticks while `work` runs = how long the main thread was blocked. */
async function maxEventLoopLag(work: () => Promise<unknown>): Promise<{ lag: number; took: number }> {
  let last = performance.now();
  let lag = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - last - 5);
    last = now;
  }, 5);
  const t0 = performance.now();
  try {
    await work();
  } finally {
    clearInterval(timer);
    lag = Math.max(lag, performance.now() - last - 5);
  }
  return { lag, took: performance.now() - t0 };
}

describe('backup and integrity work stay off the main thread', () => {
  it('a verified backup and a full integrity check keep the event loop responsive', async () => {
    const dir = tempDir();
    const { b, session } = await bigBackend(dir, workerPath);
    const call = (command: string) => b.dispatch({ command, payload: {}, sessionId: session, workstation: 'T' });
    const backup = await maxEventLoopLag(() => call('backup.create'));
    const integrity = await maxEventLoopLag(() => call('integrity.run'));
    expect(b.jobs.stats.inWorker).toBeGreaterThanOrEqual(2);
    expect(b.jobs.stats.inProcess).toBe(0);

    // Same work in-process, to prove the measurement would catch a regression.
    b.close();
    const inProcess = await bigBackend(dir, null);
    const blocked = await maxEventLoopLag(() => inProcess.b.dispatch({ command: 'integrity.run', payload: {}, sessionId: inProcess.session, workstation: 'T' }));
    inProcess.b.close();

    console.log(`backup ${backup.took.toFixed(0)} ms (max lag ${backup.lag.toFixed(0)} ms), integrity ${integrity.took.toFixed(0)} ms (max lag ${integrity.lag.toFixed(0)} ms), in-process integrity lag ${blocked.lag.toFixed(0)} ms`);
    expect(blocked.lag).toBeGreaterThan(150);
    expect(integrity.lag).toBeLessThan(Math.max(100, blocked.lag / 3));
    expect(backup.lag).toBeLessThan(150);
  }, 120_000);
});
