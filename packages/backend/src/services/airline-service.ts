import {
  DomainError,
  ErrorCode,
  assertEditable,
  assertStatusTransition,
  findDuplicates,
  normalizeAirline,
  statusOf,
  type AirlineInput,
  type NormalizedAirline,
} from '@airdesk/domain';
import type { AirlineDto, DuplicateCandidateDto, PageDto } from '@airdesk/contracts';
import type { CompanyService } from './company-service';
import { actorOf, requirePermission, tx, type Actor, type ServiceDeps } from './context';
import { indexForSearch, searchClause, statusWhere, type ListQuery } from './masterdata-support';

interface AirlineRow {
  id: string; name_en: string; name_ar: string | null; iata_code: string | null; icao_code: string | null; ticket_prefix: string | null;
  country_code: string | null; phone: string | null; email: string | null; website: string | null; notes: string | null;
  is_active: number; created_at: string; updated_at: string; row_version: number;
}

const SORT: Record<string, string> = {
  nameEn: 'e.name_en COLLATE NOCASE',
  iataCode: 'e.iata_code',
  createdAt: 'e.created_at',
  updatedAt: 'e.updated_at',
};

/**
 * Airline master data (owner requirement §13). Airlines are reference data
 * with no balances; IATA/ICAO codes are unique among ACTIVE airlines (a code
 * can be reused only after the old record is archived). Never deleted.
 */
export class AirlineService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly company: CompanyService,
  ) {}

  list(actor: Actor, q: ListQuery): PageDto<AirlineDto> {
    requirePermission(this.deps, actor, 'airline.view', 'airlines.list');
    const where = [statusWhere(q.status)];
    const params: unknown[] = [];
    const search = searchClause('airline', q.query);
    if (search) {
      where.push(`e.id IN (${search.sql})`);
      params.push(...search.params);
    }
    const order = `${SORT[q.sortBy ?? 'nameEn'] ?? SORT.nameEn} ${q.sortDir === 'desc' ? 'DESC' : 'ASC'}, e.id`;
    const whereSql = where.join(' AND ');
    const total = (this.deps.db.prepare(`SELECT COUNT(*) AS n FROM airline e WHERE ${whereSql}`).get(...params) as { n: number }).n;
    const rows = this.deps.db.prepare(`SELECT e.* FROM airline e WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, q.limit, q.offset) as AirlineRow[];
    return { items: rows.map(toDto), total };
  }

  get(actor: Actor, id: string): AirlineDto {
    requirePermission(this.deps, actor, 'airline.view', 'airlines.get');
    return toDto(this.row(id));
  }

  create(actor: Actor, input: AirlineInput, confirmDuplicates: boolean): AirlineDto {
    requirePermission(this.deps, actor, 'airline.create', 'airlines.create');
    const a = normalizeAirline(input, { defaultCountry: this.company.core().defaultCountry });
    const id = tx(this.deps, () => {
      this.assertUniqueCodes(undefined, a);
      this.guardDuplicates(undefined, a, confirmDuplicates);
      const newId = this.deps.newId();
      const now = this.deps.clock.now().toISOString();
      this.deps.db
        .prepare(
          `INSERT INTO airline (id, name_en, name_ar, iata_code, icao_code, ticket_prefix, country_code, phone, email, website, notes,
             is_active, created_at, created_by, updated_at)
           VALUES (@id, @nameEn, @nameAr, @iataCode, @icaoCode, @ticketPrefix, @countryCode, @phone, @email, @website, @notes, 1, @now, @userId, @now)`,
        )
        .run({ ...a, id: newId, now, userId: actor.userId });
      this.reindex(newId);
      this.deps.audit.append(actorOf(actor), { action: 'airline.created', entityType: 'airline', entityId: newId, after: a });
      return newId;
    });
    return this.get(actor, id);
  }

  update(actor: Actor, id: string, input: AirlineInput, rowVersion: number, confirmDuplicates: boolean): AirlineDto {
    requirePermission(this.deps, actor, 'airline.edit', 'airlines.update');
    const a = normalizeAirline(input, { defaultCountry: this.company.core().defaultCountry });
    tx(this.deps, () => {
      const before = this.row(id);
      assertEditable(statusOf(before.is_active));
      if (before.row_version !== rowVersion) throw new DomainError(ErrorCode.STALE_RECORD, 'This airline was changed by someone else');
      this.assertUniqueCodes(id, a);
      this.guardDuplicates(id, a, confirmDuplicates);
      this.deps.db
        .prepare(
          `UPDATE airline SET name_en=@nameEn, name_ar=@nameAr, iata_code=@iataCode, icao_code=@icaoCode, ticket_prefix=@ticketPrefix,
             country_code=@countryCode, phone=@phone, email=@email, website=@website, notes=@notes, updated_at=@now, row_version = row_version + 1
           WHERE id=@id AND row_version=@rowVersion`,
        )
        .run({ ...a, id, rowVersion, now: this.deps.clock.now().toISOString() });
      this.reindex(id);
      this.deps.audit.append(actorOf(actor), { action: 'airline.updated', entityType: 'airline', entityId: id, before: fromRow(before), after: a });
    });
    return this.get(actor, id);
  }

  setStatus(actor: Actor, id: string, target: 'ACTIVE' | 'ARCHIVED', reason: string | null | undefined): AirlineDto {
    requirePermission(this.deps, actor, 'airline.archive', target === 'ARCHIVED' ? 'airlines.archive' : 'airlines.restore');
    tx(this.deps, () => {
      const before = this.row(id);
      assertStatusTransition(statusOf(before.is_active), target);
      if (target === 'ACTIVE') this.assertUniqueCodes(id, fromRow(before));
      this.deps.db
        .prepare('UPDATE airline SET is_active = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?')
        .run(target === 'ACTIVE' ? 1 : 0, this.deps.clock.now().toISOString(), id);
      this.deps.audit.append(actorOf(actor), {
        action: target === 'ARCHIVED' ? 'airline.archived' : 'airline.restored', entityType: 'airline', entityId: id,
        before: { status: statusOf(before.is_active) }, after: { status: target }, metadata: reason ? { reason } : undefined,
      });
    });
    return this.get(actor, id);
  }

  reindex(id: string): void {
    const r = this.row(id);
    indexForSearch(this.deps.db, 'airline', id, [r.name_en, r.name_ar, r.iata_code, r.icao_code, r.ticket_prefix, r.email], [r.phone]);
  }

  /** Codes are identifiers, so a clash is a hard error, not a warning. */
  private assertUniqueCodes(id: string | undefined, a: NormalizedAirline): void {
    for (const [col, value, field] of [['iata_code', a.iataCode, 'iataCode'], ['icao_code', a.icaoCode, 'icaoCode']] as const) {
      if (!value) continue;
      const clash = this.deps.db
        .prepare(`SELECT id, name_en FROM airline WHERE ${col} = ? AND is_active = 1 AND id <> ?`)
        .get(value, id ?? '') as { id: string; name_en: string } | undefined;
      if (clash) {
        throw new DomainError(ErrorCode.CONFLICT, `Code ${value} is already used by ${clash.name_en}`, { field, reason: 'DUPLICATE_CODE', otherId: clash.id });
      }
    }
  }

  private guardDuplicates(id: string | undefined, a: NormalizedAirline, confirmed: boolean): void {
    const rows = this.deps.db
      .prepare('SELECT id, name_en, iata_code, is_active FROM airline WHERE name_en = ? COLLATE NOCASE OR (name_ar IS NOT NULL AND name_ar = ?) LIMIT 20')
      .all(a.nameEn, a.nameAr ?? '') as { id: string; name_en: string; iata_code: string | null; is_active: number }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const matches: DuplicateCandidateDto[] = findDuplicates(
      { id, name: a.nameEn, phones: [], email: null },
      rows.map((r) => ({ id: r.id, name: r.name_en, phones: [], email: null })),
      { includeSameName: true },
    ).map((m) => {
      const r = byId.get(m.id)!;
      return { id: r.id, number: r.iata_code ?? '—', name: r.name_en, status: statusOf(r.is_active), signals: m.signals };
    });
    if (matches.length && !confirmed) throw new DomainError(ErrorCode.DUPLICATE_WARNING, 'Possible duplicate airline', { matches });
  }

  private row(id: string): AirlineRow {
    const r = this.deps.db.prepare('SELECT * FROM airline WHERE id = ?').get(id) as AirlineRow | undefined;
    if (!r) throw new DomainError(ErrorCode.NOT_FOUND, 'Airline not found', { id });
    return r;
  }
}

function toDto(r: AirlineRow): AirlineDto {
  return {
    id: r.id, nameEn: r.name_en, nameAr: r.name_ar, iataCode: r.iata_code, icaoCode: r.icao_code, ticketPrefix: r.ticket_prefix,
    countryCode: r.country_code, phone: r.phone, email: r.email, website: r.website, notes: r.notes, status: statusOf(r.is_active),
    createdAt: r.created_at, updatedAt: r.updated_at, rowVersion: r.row_version,
  };
}

function fromRow(r: AirlineRow): NormalizedAirline {
  return {
    nameEn: r.name_en, nameAr: r.name_ar, iataCode: r.iata_code, icaoCode: r.icao_code, ticketPrefix: r.ticket_prefix,
    countryCode: r.country_code, phone: r.phone, email: r.email, website: r.website, notes: r.notes,
  };
}
