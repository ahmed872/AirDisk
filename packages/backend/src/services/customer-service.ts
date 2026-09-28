import {
  DomainError,
  ErrorCode,
  assertEditable,
  assertStatusTransition,
  digitsOnly,
  findDuplicates,
  normalizeCustomer,
  normalizeEmail,
  normalizeOptionalPhone,
  statusOf,
  type CustomerInput,
  type NormalizedCustomer,
  type PartyFingerprint,
} from '@airdesk/domain';
import type { CustomerDto, CustomerInputDto, DuplicateCandidateDto, PageDto } from '@airdesk/contracts';
import type { CompanyService } from './company-service';
import { actorOf, hasAny, requirePermission, tx, type Actor, type ServiceDeps } from './context';
import {
  indexForSearch,
  maskIdentifier,
  nextSequenceNumber,
  partyBalances,
  searchClause,
  statusWhere,
  type ListQuery,
} from './masterdata-support';

interface CustomerRow {
  id: string; customer_no: string; customer_type: 'INDIVIDUAL' | 'CORPORATE'; full_name: string; full_name_latin: string | null;
  primary_mobile: string; primary_mobile_raw: string; secondary_mobile: string | null; whatsapp_number: string | null;
  email: string | null; address: string | null; nationality: string | null; national_id: string | null; passport_no: string | null;
  passport_expiry: string | null; date_of_birth: string | null; preferred_locale: 'ar' | 'en' | null; payment_terms_days: number;
  notes: string | null; is_active: number; created_at: string; created_by_name: string | null; updated_at: string;
  updated_by_name: string | null; row_version: number;
}

const SELECT = `SELECT e.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name
  FROM customer e LEFT JOIN app_user cu ON cu.id = e.created_by LEFT JOIN app_user uu ON uu.id = e.updated_by`;

const SORT: Record<string, string> = {
  customerNo: 'e.customer_no',
  fullName: 'e.full_name COLLATE NOCASE',
  createdAt: 'e.created_at',
  updatedAt: 'e.updated_at',
};

/**
 * Customer master data (owner requirements §8–§10). Customers are reusable
 * financial parties: their balance is always derived from the journal, never
 * stored. Customers are archived, never deleted (DB trigger enforces it).
 */
export class CustomerService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly company: CompanyService,
  ) {}

  list(actor: Actor, q: ListQuery): PageDto<CustomerDto> {
    requirePermission(this.deps, actor, 'customer.view', 'customers.list');
    const where = [statusWhere(q.status)];
    const params: unknown[] = [];
    const search = searchClause('customer', q.query);
    if (search) {
      where.push(`e.id IN (${search.sql})`);
      params.push(...search.params);
    }
    const order = `${SORT[q.sortBy ?? 'customerNo'] ?? SORT.customerNo} ${q.sortDir === 'desc' ? 'DESC' : 'ASC'}, e.id`;
    const whereSql = where.join(' AND ');
    const total = (this.deps.db.prepare(`SELECT COUNT(*) AS n FROM customer e WHERE ${whereSql}`).get(...params) as { n: number }).n;
    const rows = this.deps.db.prepare(`${SELECT} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, q.limit, q.offset) as CustomerRow[];
    return { items: rows.map((r) => this.toDto(actor, r, false)), total };
  }

  get(actor: Actor, id: string): CustomerDto {
    requirePermission(this.deps, actor, 'customer.view', 'customers.get');
    return this.toDto(actor, this.row(id), true);
  }

  checkDuplicates(actor: Actor, input: Partial<CustomerInputDto>, excludeId?: string): DuplicateCandidateDto[] {
    requirePermission(this.deps, actor, ['customer.view', 'customer.create', 'customer.edit'], 'customers.checkDuplicates');
    const country = this.company.core().defaultCountry;
    const phones = [input.primaryMobile, input.secondaryMobile, input.whatsappNumber]
      .map((p, i) => {
        try {
          return normalizeOptionalPhone(p, country, `phone${i}`)?.e164 ?? null;
        } catch {
          return null; // incomplete numbers while typing are simply ignored
        }
      })
      .filter((p): p is string => !!p);
    let email: string | null = null;
    try {
      email = normalizeEmail(input.email);
    } catch {
      email = null;
    }
    return this.duplicates({ id: excludeId, name: input.fullName ?? '', phones, email });
  }

  create(actor: Actor, input: CustomerInput, confirmDuplicates: boolean): CustomerDto {
    requirePermission(this.deps, actor, 'customer.create', 'customers.create');
    const c = this.normalize(input);
    const id = tx(this.deps, () => {
      this.guardDuplicates({ name: c.fullName, phones: [c.primaryMobile, c.secondaryMobile, c.whatsappNumber], email: c.email }, confirmDuplicates);
      const newId = this.deps.newId();
      const now = this.deps.clock.now().toISOString();
      const customerNo = nextSequenceNumber(this.deps.db, 'CUSTOMER', 'C');
      this.deps.db
        .prepare(
          `INSERT INTO customer (id, customer_no, customer_type, full_name, full_name_latin, primary_mobile, primary_mobile_raw, secondary_mobile,
             whatsapp_number, email, address, nationality, national_id, passport_no, passport_expiry, date_of_birth, preferred_locale,
             payment_terms_days, notes, is_active, created_at, created_by, updated_at, updated_by)
           VALUES (@id, @customerNo, @customerType, @fullName, @fullNameLatin, @primaryMobile, @primaryMobileRaw, @secondaryMobile,
             @whatsappNumber, @email, @address, @nationality, @nationalId, @passportNo, @passportExpiry, @dateOfBirth, @preferredLocale,
             @paymentTermsDays, @notes, 1, @now, @userId, @now, @userId)`,
        )
        .run({ ...c, id: newId, customerNo, now, userId: actor.userId });
      this.reindex(newId);
      this.deps.audit.append(actorOf(actor), {
        action: 'customer.created', entityType: 'customer', entityId: newId, after: { customerNo, ...auditView(c) },
        metadata: confirmDuplicates ? { duplicatesAcknowledged: true } : undefined,
      });
      return newId;
    });
    return this.get(actor, id);
  }

  update(actor: Actor, id: string, input: CustomerInput, rowVersion: number, confirmDuplicates: boolean): CustomerDto {
    requirePermission(this.deps, actor, 'customer.edit', 'customers.update');
    const c = this.normalize(input);
    tx(this.deps, () => {
      const before = this.row(id);
      assertEditable(statusOf(before.is_active));
      if (before.row_version !== rowVersion) throw new DomainError(ErrorCode.STALE_RECORD, 'This customer was changed by someone else');
      // Users who cannot see identity data must not be able to erase it blindly.
      const canIdentity = hasAny(actor, 'customer.view_identity');
      const identity = canIdentity
        ? { nationalId: c.nationalId, passportNo: c.passportNo, passportExpiry: c.passportExpiry, dateOfBirth: c.dateOfBirth }
        : { nationalId: before.national_id, passportNo: before.passport_no, passportExpiry: before.passport_expiry, dateOfBirth: before.date_of_birth };
      this.guardDuplicates({ id, name: c.fullName, phones: [c.primaryMobile, c.secondaryMobile, c.whatsappNumber], email: c.email }, confirmDuplicates);
      this.deps.db
        .prepare(
          `UPDATE customer SET customer_type=@customerType, full_name=@fullName, full_name_latin=@fullNameLatin, primary_mobile=@primaryMobile,
             primary_mobile_raw=@primaryMobileRaw, secondary_mobile=@secondaryMobile, whatsapp_number=@whatsappNumber, email=@email,
             address=@address, nationality=@nationality, national_id=@nationalId, passport_no=@passportNo, passport_expiry=@passportExpiry,
             date_of_birth=@dateOfBirth, preferred_locale=@preferredLocale, payment_terms_days=@paymentTermsDays, notes=@notes,
             updated_at=@now, updated_by=@userId, row_version = row_version + 1
           WHERE id=@id AND row_version=@rowVersion`,
        )
        .run({ ...c, ...identity, id, rowVersion, now: this.deps.clock.now().toISOString(), userId: actor.userId });
      this.reindex(id);
      this.deps.audit.append(actorOf(actor), {
        action: 'customer.updated', entityType: 'customer', entityId: id,
        before: auditView(fromRow(before)), after: auditView({ ...c, ...identity }),
        metadata: confirmDuplicates ? { duplicatesAcknowledged: true } : undefined,
      });
    });
    return this.get(actor, id);
  }

  setStatus(actor: Actor, id: string, target: 'ACTIVE' | 'ARCHIVED', reason: string | null | undefined): CustomerDto {
    requirePermission(this.deps, actor, 'customer.archive', target === 'ARCHIVED' ? 'customers.archive' : 'customers.restore');
    tx(this.deps, () => {
      const before = this.row(id);
      assertStatusTransition(statusOf(before.is_active), target);
      this.deps.db
        .prepare('UPDATE customer SET is_active = ?, updated_at = ?, updated_by = ?, row_version = row_version + 1 WHERE id = ?')
        .run(target === 'ACTIVE' ? 1 : 0, this.deps.clock.now().toISOString(), actor.userId, id);
      this.deps.audit.append(actorOf(actor), {
        action: target === 'ARCHIVED' ? 'customer.archived' : 'customer.restored', entityType: 'customer', entityId: id,
        before: { status: statusOf(before.is_active) }, after: { status: target }, metadata: reason ? { reason } : undefined,
      });
    });
    return this.get(actor, id);
  }

  /** Rebuilds the search entry from the stored row (single source of truth). */
  reindex(id: string): void {
    const r = this.row(id);
    indexForSearch(this.deps.db, 'customer', id, [r.customer_no, r.full_name, r.full_name_latin, r.email], [r.primary_mobile, r.primary_mobile_raw, r.secondary_mobile, r.whatsapp_number]);
  }

  private normalize(input: CustomerInput): NormalizedCustomer {
    return normalizeCustomer(input, { defaultCountry: this.company.core().defaultCountry, today: this.company.today() });
  }

  private duplicates(candidate: PartyFingerprint): DuplicateCandidateDto[] {
    const phones = candidate.phones.filter((p): p is string => !!p);
    const suffixes = phones.map((p) => `%${digitsOnly(p).slice(-7)}`);
    const conds: string[] = [];
    const params: unknown[] = [];
    if (phones.length) {
      const ph = phones.map(() => '?').join(',');
      conds.push(`primary_mobile IN (${ph}) OR secondary_mobile IN (${ph}) OR whatsapp_number IN (${ph})`);
      params.push(...phones, ...phones, ...phones);
      for (const s of suffixes) {
        conds.push('primary_mobile LIKE ? OR secondary_mobile LIKE ? OR whatsapp_number LIKE ?');
        params.push(s, s, s);
      }
    }
    if (candidate.email) {
      conds.push('email = ?');
      params.push(candidate.email);
    }
    if (!conds.length) return [];
    const rows = this.deps.db
      .prepare(`SELECT id, customer_no, full_name, primary_mobile, secondary_mobile, whatsapp_number, email, is_active FROM customer WHERE ${conds.join(' OR ')} LIMIT 50`)
      .all(...params) as { id: string; customer_no: string; full_name: string; primary_mobile: string; secondary_mobile: string | null; whatsapp_number: string | null; email: string | null; is_active: number }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return findDuplicates(
      candidate,
      rows.map((r) => ({ id: r.id, name: r.full_name, phones: [r.primary_mobile, r.secondary_mobile, r.whatsapp_number], email: r.email })),
    ).map((m) => {
      const r = byId.get(m.id)!;
      return { id: r.id, number: r.customer_no, name: r.full_name, status: statusOf(r.is_active), signals: m.signals };
    });
  }

  /** Duplicates are a WARNING: the write proceeds only if the user explicitly confirmed. Never merged automatically. */
  private guardDuplicates(candidate: PartyFingerprint, confirmed: boolean): void {
    const matches = this.duplicates(candidate);
    if (matches.length && !confirmed) {
      throw new DomainError(ErrorCode.DUPLICATE_WARNING, 'Possible duplicate customer', { matches });
    }
  }

  private row(id: string): CustomerRow {
    const r = this.deps.db.prepare(`${SELECT} WHERE e.id = ?`).get(id) as CustomerRow | undefined;
    if (!r) throw new DomainError(ErrorCode.NOT_FOUND, 'Customer not found', { id });
    return r;
  }

  private toDto(actor: Actor, r: CustomerRow, withBalances: boolean): CustomerDto {
    const identity = hasAny(actor, 'customer.view_identity');
    return {
      id: r.id,
      customerNo: r.customer_no,
      customerType: r.customer_type,
      fullName: r.full_name,
      fullNameLatin: r.full_name_latin,
      primaryMobile: r.primary_mobile,
      primaryMobileRaw: r.primary_mobile_raw,
      secondaryMobile: r.secondary_mobile,
      whatsappNumber: r.whatsapp_number,
      email: r.email,
      address: r.address,
      nationality: r.nationality,
      nationalId: identity ? r.national_id : null,
      passportNo: identity ? r.passport_no : null,
      passportExpiry: identity ? r.passport_expiry : null,
      dateOfBirth: identity ? r.date_of_birth : null,
      identityRedacted: !identity,
      preferredLocale: r.preferred_locale,
      paymentTermsDays: r.payment_terms_days,
      notes: r.notes,
      status: statusOf(r.is_active),
      balances: withBalances ? partyBalances(this.deps.db, 'customer', r.id) : [],
      createdAt: r.created_at,
      createdBy: r.created_by_name,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by_name,
      rowVersion: r.row_version,
    };
  }
}

function fromRow(r: CustomerRow): NormalizedCustomer {
  return {
    customerType: r.customer_type, fullName: r.full_name, fullNameLatin: r.full_name_latin, primaryMobile: r.primary_mobile,
    primaryMobileRaw: r.primary_mobile_raw, secondaryMobile: r.secondary_mobile, whatsappNumber: r.whatsapp_number, email: r.email,
    address: r.address, nationality: r.nationality, nationalId: r.national_id, passportNo: r.passport_no, passportExpiry: r.passport_expiry,
    dateOfBirth: r.date_of_birth, preferredLocale: r.preferred_locale, paymentTermsDays: r.payment_terms_days, notes: r.notes,
  };
}

/** What the audit log keeps: everything except identity numbers, which are masked. */
function auditView(c: NormalizedCustomer) {
  const { primaryMobileRaw: _raw, nationalId, passportNo, dateOfBirth, ...rest } = c;
  return { ...rest, nationalId: maskIdentifier(nationalId), passportNo: maskIdentifier(passportNo), dateOfBirth: dateOfBirth ? '****' : null };
}
