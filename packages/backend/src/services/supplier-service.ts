import {
  DomainError,
  ErrorCode,
  assertEditable,
  assertStatusTransition,
  findDuplicates,
  normalizeSupplier,
  statusOf,
  type NormalizedSupplier,
  type SupplierInput,
} from '@airdesk/domain';
import type { DuplicateCandidateDto, PageDto, SupplierDto } from '@airdesk/contracts';
import type { CompanyService } from './company-service';
import { actorOf, hasAny, requirePermission, tx, type Actor, type ServiceDeps } from './context';
import { indexForSearch, nextSequenceNumber, partyBalances, searchClause, statusWhere, type ListQuery } from './masterdata-support';

interface SupplierRow {
  id: string; supplier_no: string; name: string; contact_person: string | null; phone: string | null; phone_secondary: string | null;
  email: string | null; address: string | null; country_code: string | null; default_currency_code: string; payment_terms_days: number;
  airline_id: string | null; notes: string | null; is_active: number; created_at: string; created_by_name: string | null;
  updated_at: string; updated_by_name: string | null; row_version: number;
}

const SELECT = `SELECT e.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name
  FROM supplier e LEFT JOIN app_user cu ON cu.id = e.created_by LEFT JOIN app_user uu ON uu.id = e.updated_by`;

const SORT: Record<string, string> = {
  supplierNo: 'e.supplier_no',
  name: 'e.name COLLATE NOCASE',
  createdAt: 'e.created_at',
  updatedAt: 'e.updated_at',
};

/**
 * Supplier master data (owner requirements §11–§12). A supplier is its own
 * financial party and is never assumed to be an airline (optional link only).
 * Financial information (derived balances) requires supplier.view_financial —
 * the sales-agent role does not have it (Phase 0 Q5).
 */
export class SupplierService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly company: CompanyService,
  ) {}

  list(actor: Actor, q: ListQuery): PageDto<SupplierDto> {
    requirePermission(this.deps, actor, 'supplier.view', 'suppliers.list');
    const where = [statusWhere(q.status)];
    const params: unknown[] = [];
    const search = searchClause('supplier', q.query);
    if (search) {
      where.push(`e.id IN (${search.sql})`);
      params.push(...search.params);
    }
    const order = `${SORT[q.sortBy ?? 'supplierNo'] ?? SORT.supplierNo} ${q.sortDir === 'desc' ? 'DESC' : 'ASC'}, e.id`;
    const whereSql = where.join(' AND ');
    const total = (this.deps.db.prepare(`SELECT COUNT(*) AS n FROM supplier e WHERE ${whereSql}`).get(...params) as { n: number }).n;
    const rows = this.deps.db.prepare(`${SELECT} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, q.limit, q.offset) as SupplierRow[];
    return { items: rows.map((r) => this.toDto(actor, r, false)), total };
  }

  get(actor: Actor, id: string): SupplierDto {
    requirePermission(this.deps, actor, 'supplier.view', 'suppliers.get');
    return this.toDto(actor, this.row(id), true);
  }

  create(actor: Actor, input: SupplierInput, confirmDuplicates: boolean): SupplierDto {
    requirePermission(this.deps, actor, 'supplier.create', 'suppliers.create');
    const s = this.normalize(input);
    const id = tx(this.deps, () => {
      this.guardDuplicates(undefined, s, confirmDuplicates);
      const newId = this.deps.newId();
      const now = this.deps.clock.now().toISOString();
      const supplierNo = nextSequenceNumber(this.deps.db, 'SUPPLIER', 'S');
      this.deps.db
        .prepare(
          `INSERT INTO supplier (id, supplier_no, name, contact_person, phone, phone_secondary, email, address, country_code,
             default_currency_code, payment_terms_days, airline_id, notes, is_active, created_at, created_by, updated_at, updated_by)
           VALUES (@id, @supplierNo, @name, @contactPerson, @phonePrimary, @phoneSecondary, @email, @address, @countryCode,
             @defaultCurrencyCode, @paymentTermsDays, @airlineId, @notes, 1, @now, @userId, @now, @userId)`,
        )
        .run({ ...s, id: newId, supplierNo, now, userId: actor.userId });
      this.reindex(newId);
      this.deps.audit.append(actorOf(actor), {
        action: 'supplier.created', entityType: 'supplier', entityId: newId, after: { supplierNo, ...s },
        metadata: confirmDuplicates ? { duplicatesAcknowledged: true } : undefined,
      });
      return newId;
    });
    return this.get(actor, id);
  }

  update(actor: Actor, id: string, input: SupplierInput, rowVersion: number, confirmDuplicates: boolean): SupplierDto {
    requirePermission(this.deps, actor, 'supplier.edit', 'suppliers.update');
    const s = this.normalize(input);
    tx(this.deps, () => {
      const before = this.row(id);
      assertEditable(statusOf(before.is_active));
      if (before.row_version !== rowVersion) throw new DomainError(ErrorCode.STALE_RECORD, 'This supplier was changed by someone else');
      this.guardDuplicates(id, s, confirmDuplicates);
      this.deps.db
        .prepare(
          `UPDATE supplier SET name=@name, contact_person=@contactPerson, phone=@phonePrimary, phone_secondary=@phoneSecondary, email=@email,
             address=@address, country_code=@countryCode, default_currency_code=@defaultCurrencyCode, payment_terms_days=@paymentTermsDays,
             airline_id=@airlineId, notes=@notes, updated_at=@now, updated_by=@userId, row_version = row_version + 1
           WHERE id=@id AND row_version=@rowVersion`,
        )
        .run({ ...s, id, rowVersion, now: this.deps.clock.now().toISOString(), userId: actor.userId });
      this.reindex(id);
      this.deps.audit.append(actorOf(actor), {
        action: 'supplier.updated', entityType: 'supplier', entityId: id, before: fromRow(before), after: s,
        metadata: confirmDuplicates ? { duplicatesAcknowledged: true } : undefined,
      });
    });
    return this.get(actor, id);
  }

  setStatus(actor: Actor, id: string, target: 'ACTIVE' | 'ARCHIVED', reason: string | null | undefined): SupplierDto {
    requirePermission(this.deps, actor, 'supplier.archive', target === 'ARCHIVED' ? 'suppliers.archive' : 'suppliers.restore');
    tx(this.deps, () => {
      const before = this.row(id);
      assertStatusTransition(statusOf(before.is_active), target);
      this.deps.db
        .prepare('UPDATE supplier SET is_active = ?, updated_at = ?, updated_by = ?, row_version = row_version + 1 WHERE id = ?')
        .run(target === 'ACTIVE' ? 1 : 0, this.deps.clock.now().toISOString(), actor.userId, id);
      this.deps.audit.append(actorOf(actor), {
        action: target === 'ARCHIVED' ? 'supplier.archived' : 'supplier.restored', entityType: 'supplier', entityId: id,
        before: { status: statusOf(before.is_active) }, after: { status: target }, metadata: reason ? { reason } : undefined,
      });
    });
    return this.get(actor, id);
  }

  reindex(id: string): void {
    const r = this.row(id);
    indexForSearch(this.deps.db, 'supplier', id, [r.supplier_no, r.name, r.contact_person, r.email], [r.phone, r.phone_secondary]);
  }

  private normalize(input: SupplierInput): NormalizedSupplier {
    const s = normalizeSupplier(input, { defaultCountry: this.company.core().defaultCountry });
    const cur = this.deps.db.prepare('SELECT is_active FROM currency WHERE code = ?').get(s.defaultCurrencyCode) as { is_active: number } | undefined;
    if (!cur || cur.is_active !== 1) {
      throw new DomainError(ErrorCode.VALIDATION, 'Unknown currency', { field: 'defaultCurrencyCode', reason: 'INVALID_CURRENCY' });
    }
    if (s.airlineId && !this.deps.db.prepare('SELECT 1 FROM airline WHERE id = ?').get(s.airlineId)) {
      throw new DomainError(ErrorCode.VALIDATION, 'Unknown airline', { field: 'airlineId', reason: 'NOT_FOUND' });
    }
    return s;
  }

  private guardDuplicates(id: string | undefined, s: NormalizedSupplier, confirmed: boolean): void {
    const phones = [s.phonePrimary, s.phoneSecondary].filter((p): p is string => !!p);
    const ph = phones.map(() => '?').join(',');
    const rows = this.deps.db
      .prepare(
        `SELECT id, supplier_no, name, phone, phone_secondary, email, is_active FROM supplier
         WHERE name = ? COLLATE NOCASE ${phones.length ? `OR phone IN (${ph}) OR phone_secondary IN (${ph})` : ''} ${s.email ? 'OR email = ?' : ''} LIMIT 50`,
      )
      .all(s.name, ...phones, ...phones, ...(s.email ? [s.email] : [])) as { id: string; supplier_no: string; name: string; phone: string | null; phone_secondary: string | null; email: string | null; is_active: number }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const matches: DuplicateCandidateDto[] = findDuplicates(
      { id, name: s.name, phones, email: s.email },
      rows.map((r) => ({ id: r.id, name: r.name, phones: [r.phone, r.phone_secondary], email: r.email })),
      { includeSameName: true },
    ).map((m) => {
      const r = byId.get(m.id)!;
      return { id: r.id, number: r.supplier_no, name: r.name, status: statusOf(r.is_active), signals: m.signals };
    });
    if (matches.length && !confirmed) throw new DomainError(ErrorCode.DUPLICATE_WARNING, 'Possible duplicate supplier', { matches });
  }

  private row(id: string): SupplierRow {
    const r = this.deps.db.prepare(`${SELECT} WHERE e.id = ?`).get(id) as SupplierRow | undefined;
    if (!r) throw new DomainError(ErrorCode.NOT_FOUND, 'Supplier not found', { id });
    return r;
  }

  private toDto(actor: Actor, r: SupplierRow, withBalances: boolean): SupplierDto {
    const financial = hasAny(actor, 'supplier.view_financial');
    return {
      id: r.id,
      supplierNo: r.supplier_no,
      name: r.name,
      contactPerson: r.contact_person,
      phonePrimary: r.phone,
      phoneSecondary: r.phone_secondary,
      email: r.email,
      address: r.address,
      countryCode: r.country_code,
      defaultCurrencyCode: r.default_currency_code,
      paymentTermsDays: r.payment_terms_days,
      airlineId: r.airline_id,
      notes: r.notes,
      status: statusOf(r.is_active),
      balances: financial ? (withBalances ? partyBalances(this.deps.db, 'supplier', r.id) : []) : null,
      financialRedacted: !financial,
      createdAt: r.created_at,
      createdBy: r.created_by_name,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by_name,
      rowVersion: r.row_version,
    };
  }
}

function fromRow(r: SupplierRow): NormalizedSupplier {
  return {
    name: r.name, contactPerson: r.contact_person, phonePrimary: r.phone, phoneSecondary: r.phone_secondary, email: r.email,
    address: r.address, countryCode: r.country_code, defaultCurrencyCode: r.default_currency_code, paymentTermsDays: r.payment_terms_days,
    airlineId: r.airline_id, notes: r.notes,
  };
}
