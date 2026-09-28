import { createHash } from 'node:crypto';
import type { Db } from '../db/driver';
import type { Clock } from '../util/clock';
import type { IdGenerator } from '../util/ids';
import { canonicalJson, redact } from '../util/json';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditActor {
  userId: string | null;
  sessionId: string | null;
  workstation: string | null;
}

export const SYSTEM_ACTOR: AuditActor = { userId: null, sessionId: null, workstation: null };

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

interface AuditRow {
  seq: number;
  id: string;
  occurred_at: string;
  user_id: string | null;
  session_id: string | null;
  workstation: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before_json: string | null;
  after_json: string | null;
  metadata_json: string | null;
  prev_hash: string;
  hash: string;
}

function hashRow(prevHash: string, row: Omit<AuditRow, 'seq' | 'prev_hash' | 'hash'>): string {
  return createHash('sha256').update(`${prevHash}\n${canonicalJson(row)}`, 'utf8').digest('hex');
}

const toJson = (v: unknown): string | null => (v === undefined || v === null ? null : canonicalJson(redact(v)));

/**
 * Append-only, hash-chained audit trail (Phase 0 §06-7). Callers invoke
 * append() INSIDE the same transaction as the change they describe, so an
 * action can never be committed without its audit record. Tampering with any
 * row breaks the chain from that row on (detected by verifyChain).
 */
export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly newId: IdGenerator,
  ) {}

  append(actor: AuditActor, entry: AuditEntry): void {
    const last = this.db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const row = {
      id: this.newId(),
      occurred_at: this.clock.now().toISOString(),
      user_id: actor.userId,
      session_id: actor.sessionId,
      workstation: actor.workstation,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      before_json: toJson(entry.before),
      after_json: toJson(entry.after),
      metadata_json: toJson(entry.metadata),
    };
    this.db
      .prepare(
        `INSERT INTO audit_log (id, occurred_at, user_id, session_id, workstation, action, entity_type, entity_id,
           before_json, after_json, metadata_json, prev_hash, hash)
         VALUES (@id, @occurred_at, @user_id, @session_id, @workstation, @action, @entity_type, @entity_id,
           @before_json, @after_json, @metadata_json, @prev_hash, @hash)`,
      )
      .run({ ...row, prev_hash: prevHash, hash: hashRow(prevHash, row) });
  }

  headHash(): string {
    const last = this.db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
    return last?.hash ?? GENESIS_HASH;
  }

  /** INV-9: re-computes every hash from genesis. */
  verifyChain(): { ok: boolean; checked: number; brokenAtSeq?: number } {
    let prev = GENESIS_HASH;
    let checked = 0;
    for (const r of this.db.prepare('SELECT * FROM audit_log ORDER BY seq').iterate() as IterableIterator<AuditRow>) {
      const { seq, prev_hash, hash, ...rest } = r;
      if (prev_hash !== prev || hashRow(prev_hash, rest) !== hash) return { ok: false, checked, brokenAtSeq: seq };
      prev = hash;
      checked++;
    }
    return { ok: true, checked };
  }
}
