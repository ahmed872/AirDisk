import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, SYSTEM_ACTOR } from '../src';
import { canonicalJson } from '../src/util/json';
import { ADMIN, login, makeBackend, setupCompany, tempDir, type TestEnv } from './helpers';

/**
 * Tamper-evidence of the audit trail against someone who can write the
 * database directly (for an encrypted database: someone who already holds the
 * data key). Every case must be reported by the integrity check.
 */
async function env10(dataDir = tempDir()): Promise<{ env: TestEnv; s: string }> {
  const env = await makeBackend({ dataDir });
  await setupCompany(env);
  for (let i = 0; i < 10; i++) env.backend.svc.deps.audit.append(SYSTEM_ACTOR, { action: 'test.event', entityType: 'test', entityId: `e${i}`, metadata: { i } });
  return { env, s: await login(env) };
}

const failing = async (env: TestEnv, s: string) => {
  const r = await env.call<{ ok: boolean; checks: { id: string; ok: boolean }[] }>('integrity.run', {}, s);
  return r.data!.checks.filter((c) => !c.ok).map((c) => c.id);
};

function unlock(env: TestEnv): void {
  const db = env.backend.internals.db;
  db.exec('DROP TRIGGER IF EXISTS trg_audit_no_update; DROP TRIGGER IF EXISTS trg_audit_no_delete;');
}

/** What a careful attacker would do: recompute every hash after their edit so the chain itself verifies. */
function rehash(env: TestEnv): void {
  const db = env.backend.internals.db;
  let prev = GENESIS_HASH;
  for (const r of db.prepare('SELECT * FROM audit_log ORDER BY seq').all() as Record<string, unknown>[]) {
    const { seq, prev_hash: _p, hash: _h, ...rest } = r;
    const hash = createHash('sha256').update(`${prev}\n${canonicalJson(rest)}`, 'utf8').digest('hex');
    db.prepare('UPDATE audit_log SET prev_hash = ?, hash = ? WHERE seq = ?').run(prev, hash, seq);
    prev = hash;
  }
}

describe('audit trail tamper-evidence', () => {
  it('normal appends verify, after restart too', async () => {
    const dir = tempDir();
    const { env, s } = await env10(dir);
    expect(await failing(env, s)).toEqual([]);
    env.backend.close();
    const again = await makeBackend({ dataDir: dir });
    expect(await failing(again, await login(again, ADMIN.username, ADMIN.password))).toEqual([]);
  });

  it('modified event, modified metadata, modified previous hash, deleted and reordered events are all detected', async () => {
    const cases: [string, (env: TestEnv) => void][] = [
      ['modified event', (e) => e.backend.internals.db.prepare(`UPDATE audit_log SET action = 'forged' WHERE entity_id = 'e3'`).run()],
      ['modified metadata', (e) => e.backend.internals.db.prepare(`UPDATE audit_log SET metadata_json = '{"i":99}' WHERE entity_id = 'e4'`).run()],
      ['modified previous hash', (e) => e.backend.internals.db.prepare(`UPDATE audit_log SET prev_hash = ? WHERE entity_id = 'e5'`).run('f'.repeat(64))],
      ['deleted event', (e) => e.backend.internals.db.prepare(`DELETE FROM audit_log WHERE entity_id = 'e6'`).run()],
      ['reordered events', (e) => {
        const db = e.backend.internals.db;
        const a = db.prepare(`SELECT seq FROM audit_log WHERE entity_id = 'e1'`).get() as { seq: number };
        const b = db.prepare(`SELECT seq FROM audit_log WHERE entity_id = 'e2'`).get() as { seq: number };
        db.prepare('UPDATE audit_log SET seq = -1 WHERE seq = ?').run(a.seq);
        db.prepare('UPDATE audit_log SET seq = ? WHERE seq = ?').run(a.seq, b.seq);
        db.prepare('UPDATE audit_log SET seq = ? WHERE seq = -1').run(b.seq);
      }],
    ];
    for (const [name, tamper] of cases) {
      const { env, s } = await env10();
      unlock(env);
      tamper(env);
      expect(await failing(env, s), name).toContain('INV-9.audit_chain');
    }
  });

  it('records cut off at the end are detected even though the remaining chain verifies', async () => {
    const { env, s } = await env10();
    unlock(env);
    env.backend.internals.db.prepare('DELETE FROM audit_log WHERE seq > (SELECT MAX(seq) - 3 FROM audit_log)').run();
    const failed = await failing(env, s);
    expect(failed).toContain('INV-9.audit_tail');
    expect(failed).not.toContain('INV-9.audit_chain');
  });

  it('a rewritten history with recomputed hashes is caught by the checkpoints recorded at each backup', async () => {
    const { env, s } = await env10();
    await env.call('backup.create', {}, s); // anchors the current chain head outside the database
    unlock(env);
    env.backend.internals.db.prepare(`UPDATE audit_log SET metadata_json = '{"i":"rewritten"}' WHERE entity_id = 'e2'`).run();
    rehash(env);
    expect(env.backend.svc.deps.audit.verifyChain().ok).toBe(true); // the chain alone is fooled…
    expect(await failing(env, s)).toContain('INV-9.audit_anchors'); // …the external checkpoint is not
  });

  it('after a restore the restored chain is the new baseline (no false alarms)', async () => {
    const { env, s } = await env10();
    const bk = await env.call<{ filePath: string }>('backup.create', {}, s);
    for (let i = 0; i < 5; i++) env.backend.svc.deps.audit.append(SYSTEM_ACTOR, { action: 'test.after', entityType: 'test' });
    await env.call('backup.create', {}, s);
    const r = await env.call('backup.restore', { filePath: bk.data!.filePath, password: ADMIN.password, confirmation: 'RESTORE' }, s);
    expect(r.ok).toBe(true);
    const s2 = await login(env);
    expect(await failing(env, s2)).toEqual([]);
  });
});
