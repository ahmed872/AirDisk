import { digitsOnly, normalizeSearchText } from '@airdesk/domain';
import type { PartyBalanceDto } from '@airdesk/contracts';
import type { Db } from '../db/driver';

export type SearchEntity = 'customer' | 'supplier' | 'airline' | 'airport' | 'booking';

/**
 * Human-facing sequential numbers (C-000001, S-000001). Allocated inside the
 * caller's write transaction, so a rolled-back create never burns a number.
 */
export function nextSequenceNumber(db: Db, key: string, prefix: string, width = 6): string {
  db.prepare(`INSERT OR IGNORE INTO document_sequence (sequence_key, period_key, prefix, next_value) VALUES (?, '', ?, 1)`).run(key, prefix);
  const row = db.prepare(`SELECT prefix, next_value FROM document_sequence WHERE sequence_key = ? AND period_key = ''`).get(key) as { prefix: string; next_value: number };
  db.prepare(`UPDATE document_sequence SET next_value = next_value + 1 WHERE sequence_key = ? AND period_key = ''`).run(key);
  return `${row.prefix}-${String(row.next_value).padStart(width, '0')}`;
}

/**
 * Keeps the FTS5 trigram index in step with an entity, in the SAME transaction
 * as the write. Text is normalised (Arabic letter folding, digits) exactly as
 * queries are; phone numbers are also indexed as bare digits, with and without
 * the international prefix, so "0100 123 4567" finds +201001234567.
 */
export function indexForSearch(db: Db, type: SearchEntity, id: string, texts: readonly (string | null | undefined)[], phones: readonly (string | null | undefined)[] = []): void {
  const phoneTokens = phones.flatMap((p) => {
    if (!p) return [];
    const d = digitsOnly(p);
    return [d, d.replace(/^0+/, '')];
  });
  const content = [...texts.filter(Boolean).map((t) => normalizeSearchText(t!)), ...phoneTokens].join(' | ');
  db.prepare('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?').run(type, id);
  db.prepare('INSERT INTO search_index (entity_type, entity_id, content) VALUES (?, ?, ?)').run(type, id, content);
}

/**
 * SQL fragment + params selecting matching entity ids. Returns null when the
 * query is empty (no filtering). User input never becomes FTS syntax: each
 * alternative is a double-quoted phrase with embedded quotes doubled.
 */
export function searchClause(type: SearchEntity, rawQuery: string | undefined): { sql: string; params: string[] } | null {
  const q = normalizeSearchText(rawQuery ?? '');
  if (q === '') return null;
  const alternatives = new Set<string>([q]);
  const d = digitsOnly(q);
  if (d.length >= 3 && d.length >= q.replace(/[\s\-+()]/g, '').length) {
    alternatives.add(d);
    const trimmed = d.replace(/^0+/, '');
    if (trimmed.length >= 3) alternatives.add(trimmed);
  }
  const usable = [...alternatives].filter((a) => [...a].length >= 3);
  if (usable.length > 0) {
    const match = usable.map((a) => `"${a.replace(/"/g, '""')}"`).join(' OR ');
    return { sql: `SELECT entity_id FROM search_index WHERE entity_type = ? AND search_index MATCH ?`, params: [type, match] };
  }
  // Trigram needs 3 characters; shorter input falls back to a (small) LIKE scan.
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return { sql: `SELECT entity_id FROM search_index WHERE entity_type = ? AND content LIKE ? ESCAPE '\\'`, params: [type, like] };
}

/** Balances per currency derived from the journal views — never from a stored column. */
export function partyBalances(db: Db, party: 'customer' | 'supplier', id: string): PartyBalanceDto[] {
  const sql =
    party === 'customer'
      ? 'SELECT currency_code, balance_minor FROM v_customer_balance WHERE customer_id = ? ORDER BY currency_code'
      : 'SELECT currency_code, balance_minor FROM v_supplier_balance WHERE supplier_id = ? ORDER BY currency_code';
  return (db.prepare(sql).all(id) as { currency_code: string; balance_minor: number }[])
    .filter((r) => r.balance_minor !== 0)
    .map((r) => ({ currency: r.currency_code, balanceMinor: r.balance_minor }));
}

/** Masks personal identifiers in audit records: enough to recognise, not to reuse. */
export function maskIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length <= 4 ? '****' : `${'*'.repeat(Math.min(value.length - 4, 8))}${value.slice(-4)}`;
}

export interface ListQuery {
  query?: string | undefined;
  status: 'ACTIVE' | 'ARCHIVED' | 'ALL';
  sortBy?: string | undefined;
  sortDir: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/** WHERE clause for the status filter (is_active column). */
export function statusWhere(status: ListQuery['status']): string {
  return status === 'ACTIVE' ? 'e.is_active = 1' : status === 'ARCHIVED' ? 'e.is_active = 0' : '1 = 1';
}
