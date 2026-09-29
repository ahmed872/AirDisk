import type { IntegrityCheckDto, IntegrityReportDto } from '@airdesk/contracts';
import type { AuditLog } from '../audit/audit-log';
import type { Db } from '../db/driver';
import type { Clock } from '../util/clock';

/** An audit-chain head recorded outside the database (backup history). */
export interface AuditAnchor {
  seq: number;
  hash: string;
  at: string | null;
}

/**
 * Invariant checks shared by tests and production (Phase 0 §04-10, §09-5).
 * Run at startup (quick), before backups, after migrations/restore, on demand.
 */
export function runIntegrityChecks(db: Db, audit: AuditLog, clock: Clock, opts: { quick?: boolean; anchors?: readonly AuditAnchor[] } = {}): IntegrityReportDto {
  const checks: IntegrityCheckDto[] = [];
  const add = (id: string, ok: boolean, details?: string) => checks.push(details ? { id, ok, details } : { id, ok });
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

  const sqliteCheck = (db.pragma(opts.quick ? 'quick_check' : 'integrity_check') as { quick_check?: string; integrity_check?: string }[])
    .map((r) => r.quick_check ?? r.integrity_check)
    .join('; ');
  add('sqlite.integrity', sqliteCheck === 'ok', sqliteCheck === 'ok' ? undefined : sqliteCheck);
  const fk = (db.pragma('foreign_key_check') as unknown[]).length;
  add('sqlite.foreign_keys', fk === 0, fk ? `${fk} violations` : undefined);

  const unsealed = count('SELECT COUNT(*) AS n FROM journal_entry WHERE is_sealed = 0');
  add('INV-1.sealed', unsealed === 0, unsealed ? `${unsealed} unsealed journal entries` : undefined);
  const unbalanced = count(
    `SELECT COUNT(*) AS n FROM (SELECT entry_id FROM journal_line GROUP BY entry_id
       HAVING SUM(debit_base_minor) <> SUM(credit_base_minor) OR COUNT(*) < 2)`,
  );
  add('INV-1.balanced', unbalanced === 0, unbalanced ? `${unbalanced} unbalanced entries` : undefined);

  const tb = db.prepare('SELECT COALESCE(SUM(debit_base_minor), 0) AS d, COALESCE(SUM(credit_base_minor), 0) AS c FROM journal_line').get() as { d: number; c: number };
  add('INV-2.trial_balance', tb.d === tb.c, tb.d === tb.c ? undefined : `debits ${tb.d} ≠ credits ${tb.c}`);

  const badTotals = count(
    `SELECT COUNT(*) AS n FROM fin_document d
       LEFT JOIN (SELECT document_id, SUM(amount_minor) a, SUM(base_amount_minor) b FROM fin_document_line GROUP BY document_id) l
         ON l.document_id = d.id
     WHERE l.a IS NULL OR l.a <> d.total_minor OR l.b <> d.total_base_minor`,
  );
  add('INV-3.document_totals', badTotals === 0, badTotals ? `${badTotals} documents whose lines do not add up` : undefined);
  const noJournal = count('SELECT COUNT(*) AS n FROM fin_document d LEFT JOIN journal_entry e ON e.document_id = d.id WHERE e.id IS NULL');
  add('INV-3.document_journal', noJournal === 0, noJournal ? `${noJournal} documents without journal` : undefined);

  const missingDims = count(
    `SELECT COUNT(*) AS n FROM journal_line WHERE
       (account_code = '1200' AND customer_id IS NULL) OR (account_code = '2100' AND supplier_id IS NULL)
       OR (account_code = '1110' AND money_account_id IS NULL)`,
  );
  add('INV-4.dimensions', missingDims === 0, missingDims ? `${missingDims} control-account lines without party` : undefined);

  const badReversals = count(
    `SELECT COUNT(*) AS n FROM (
       SELECT r.id, jl.account_code, jl.currency_code,
              SUM(jl.debit_minor - jl.credit_minor) AS t, SUM(jl.debit_base_minor - jl.credit_base_minor) AS b
       FROM fin_document r
       JOIN journal_entry e ON e.document_id IN (r.id, r.reversal_of_id)
       JOIN journal_line jl ON jl.entry_id = e.id
       WHERE r.is_reversal = 1
       GROUP BY r.id, jl.account_code, jl.currency_code, jl.customer_id, jl.supplier_id, jl.money_account_id, jl.booking_id
       HAVING t <> 0 OR b <> 0)`,
  );
  add('INV-7.reversals_net_zero', badReversals === 0, badReversals ? `${badReversals} reversal pairs do not net to zero` : undefined);

  const chain = audit.verifyChain();
  add('INV-9.audit_chain', chain.ok, chain.ok ? `${chain.checked} records verified` : `chain broken at record ${chain.brokenAtSeq}`);

  // A hash chain alone cannot see records cut off at its end: SQLite's AUTOINCREMENT
  // counter still remembers the highest sequence number ever used.
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM audit_log').get() as { n: number }).n;
  const used = (db.prepare(`SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'audit_log'), 0) AS n`).get() as { n: number }).n;
  add('INV-9.audit_tail', used === maxSeq, used === maxSeq ? undefined : `records ${maxSeq + 1}–${used} are missing from the end of the audit log`);

  if (opts.anchors && opts.anchors.length) {
    const at = db.prepare('SELECT hash FROM audit_log WHERE seq = ?');
    const broken = opts.anchors.filter((a) => (at.get(a.seq) as { hash: string } | undefined)?.hash !== a.hash);
    add('INV-9.audit_anchors', broken.length === 0,
      broken.length ? `audit log no longer matches ${broken.length} recorded checkpoint(s), first at record ${broken[0]!.seq}` : `${opts.anchors.length} checkpoints match`);
  }

  return { ok: checks.every((c) => c.ok), ranAt: clock.now().toISOString(), checks };
}
