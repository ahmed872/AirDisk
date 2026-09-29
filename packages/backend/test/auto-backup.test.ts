import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fail, ok } from './flow';
import { auditActions, makeBackend, ready, userWithRoles } from './helpers';

/** Automatic backups (owner decision Q12): due-time, retention of automatic copies only, and the schedule setting. */
describe('Automatic backups', () => {
  it('runs when due, skips when recent, and prunes only old automatic copies', async () => {
    const { env, adminSession: s } = await ready();
    const first = await env.backend.runScheduledBackup();
    expect(first.ran).toBe(true);
    expect(existsSync(first.filePath!)).toBe(true);
    expect((await env.backend.runScheduledBackup()).ran).toBe(false); // < 24 h since the last one
    await ok(env, 'backup.setSchedule', { intervalHours: 1, keep: 2 }, s);
    const manual = await ok<{ filePath: string }>(env, 'backup.create', {}, s);
    const made: string[] = [first.filePath!];
    for (let i = 0; i < 3; i++) {
      env.clock.advance(61 * 60_000);
      const r = await env.backend.runScheduledBackup();
      expect(r.ran).toBe(true);
      made.push(r.filePath!);
    }
    // Keep = 2: the two newest automatic files stay; older automatic ones are removed; the manual backup is untouched.
    expect(made.map(existsSync)).toEqual([false, false, true, true]);
    expect(existsSync(manual.filePath)).toBe(true);
    expect(auditActions(env)).toEqual(expect.arrayContaining(['backup.created', 'backup.pruned', 'settings.backup_schedule_changed']));
  });

  it('is off at 0 hours, does nothing before first-run setup, and only settings.system may change it', async () => {
    const fresh = await makeBackend();
    expect((await fresh.backend.runScheduledBackup()).ran).toBe(false); // not set up yet
    const { env, adminSession: s } = await ready();
    const manager = await userWithRoles(env, s, 'mgr', ['MANAGER']);
    const sched = await ok<{ intervalHours: number; keep: number; nextDueAt: string | null }>(env, 'backup.schedule', {}, manager);
    expect(sched).toMatchObject({ intervalHours: 24, keep: 14 });
    expect((await fail(env, 'backup.setSchedule', { intervalHours: 0, keep: 14 }, manager)).code).toBe('FORBIDDEN');
    const off = await ok<{ intervalHours: number; nextDueAt: string | null }>(env, 'backup.setSchedule', { intervalHours: 0, keep: 14 }, s);
    expect(off).toMatchObject({ intervalHours: 0, nextDueAt: null });
    expect((await env.backend.runScheduledBackup()).ran).toBe(false);
  });
});
