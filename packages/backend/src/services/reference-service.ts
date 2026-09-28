import {
  DomainError,
  ErrorCode,
  assertCountryCode,
  assertStatusTransition,
  fieldError,
  isValidTimeZone,
  optionalText,
  requiredText,
  statusOf,
} from '@airdesk/domain';
import type { AirportDto, CurrencyDto, ExchangeRateDto, ExpenseCategoryDto, MoneyAccountDto, PageDto } from '@airdesk/contracts';
import type { CompanyService } from './company-service';
import { actorOf, hasAny, requirePermission, tx, type Actor, type ServiceDeps } from './context';
import type { CurrencyService } from './currency-service';
import { indexForSearch, searchClause, statusWhere, type ListQuery } from './masterdata-support';

export const MONEY_ACCOUNT_TYPES = ['CASH', 'BANK', 'WALLET', 'CARD_CLEARING'] as const;

interface AirportRow {
  iata_code: string; icao_code: string | null; name_en: string; name_ar: string | null; city_en: string | null; city_ar: string | null;
  country_code: string; timezone: string | null; is_active: number; row_version: number;
}
interface MoneyAccountRow {
  id: string; name: string; account_type: (typeof MONEY_ACCOUNT_TYPES)[number]; currency_code: string; bank_name: string | null;
  account_ref: string | null; notes: string | null; is_active: number; row_version: number;
}
interface CategoryRow {
  id: string; code: string; name_ar: string; name_en: string; ledger_account_code: string; is_active: number; is_system: number; row_version: number;
}

/**
 * Reference data used by operations: airports, money accounts (cash boxes,
 * bank accounts, wallets), expense categories and currencies. Nothing here is
 * ever deleted — records are deactivated so historical documents keep valid
 * references (Phase 0 BR-IMM-05).
 */
export class ReferenceService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly company: CompanyService,
    private readonly currencies: CurrencyService,
  ) {}

  // ── Airports ────────────────────────────────────────────────────────────
  listAirports(actor: Actor, q: ListQuery): PageDto<AirportDto> {
    requirePermission(this.deps, actor, ['booking.view', 'booking.create', 'airport.manage'], 'airports.list');
    const where = [statusWhere(q.status)];
    const params: unknown[] = [];
    const search = searchClause('airport', q.query);
    if (search) {
      where.push(`e.iata_code IN (${search.sql})`);
      params.push(...search.params);
    }
    const w = where.join(' AND ');
    const dir = q.sortDir === 'desc' ? 'DESC' : 'ASC';
    const order = q.sortBy === 'iataCode' ? `e.iata_code ${dir}` : q.sortBy === 'country' ? `e.country_code ${dir}, e.name_en` : `e.name_en COLLATE NOCASE ${dir}`;
    const total = (this.deps.db.prepare(`SELECT COUNT(*) AS n FROM airport e WHERE ${w}`).get(...params) as { n: number }).n;
    // Exact IATA match first so typing "JED" puts Jeddah on top.
    const exact = (q.query ?? '').trim().toUpperCase();
    const rows = this.deps.db
      .prepare(`SELECT e.* FROM airport e WHERE ${w} ORDER BY (e.iata_code = ?) DESC, ${order} LIMIT ? OFFSET ?`)
      .all(...params, exact, q.limit, q.offset) as AirportRow[];
    return { items: rows.map(airportDto), total };
  }

  saveAirport(actor: Actor, input: { iataCode: string; icaoCode?: string | null; nameEn: string; nameAr?: string | null; cityEn?: string | null; cityAr?: string | null; countryCode: string; timezone?: string | null }, isNew: boolean, rowVersion?: number): AirportDto {
    requirePermission(this.deps, actor, 'airport.manage', isNew ? 'airports.create' : 'airports.update');
    const iata = requiredText(input.iataCode, 'iataCode', 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(iata)) throw fieldError('iataCode', 'INVALID_AIRPORT', 'Airport IATA code is 3 letters');
    const icao = optionalText(input.icaoCode, 'icaoCode', 4)?.toUpperCase() ?? null;
    if (icao && !/^[A-Z]{4}$/.test(icao)) throw fieldError('icaoCode', 'INVALID_ICAO', 'Airport ICAO code is 4 letters');
    const country = assertCountryCode(requiredText(input.countryCode, 'countryCode', 2).toUpperCase(), 'countryCode');
    const tz = optionalText(input.timezone, 'timezone', 64);
    if (tz && !isValidTimeZone(tz)) throw fieldError('timezone', 'INVALID_TIMEZONE', 'Unknown time zone');
    const v = {
      iata, icao, nameEn: requiredText(input.nameEn, 'nameEn', 120), nameAr: optionalText(input.nameAr, 'nameAr', 120),
      cityEn: optionalText(input.cityEn, 'cityEn', 80), cityAr: optionalText(input.cityAr, 'cityAr', 80), country, tz,
    };
    tx(this.deps, () => {
      const now = this.deps.clock.now().toISOString();
      const existing = this.deps.db.prepare('SELECT * FROM airport WHERE iata_code = ?').get(iata) as AirportRow | undefined;
      if (isNew) {
        if (existing) throw new DomainError(ErrorCode.CONFLICT, 'This airport code already exists', { field: 'iataCode', reason: 'DUPLICATE_CODE' });
        this.deps.db
          .prepare(`INSERT INTO airport (iata_code, icao_code, name_en, name_ar, city_en, city_ar, country_code, timezone, is_active, created_at, updated_at)
                    VALUES (@iata, @icao, @nameEn, @nameAr, @cityEn, @cityAr, @country, @tz, 1, @now, @now)`)
          .run({ ...v, now });
      } else {
        if (!existing) throw new DomainError(ErrorCode.NOT_FOUND, 'Airport not found');
        if (rowVersion !== undefined && existing.row_version !== rowVersion) throw new DomainError(ErrorCode.STALE_RECORD, 'Airport was changed by someone else');
        this.deps.db
          .prepare(`UPDATE airport SET icao_code=@icao, name_en=@nameEn, name_ar=@nameAr, city_en=@cityEn, city_ar=@cityAr, country_code=@country,
                    timezone=@tz, updated_at=@now, row_version=row_version+1 WHERE iata_code=@iata`)
          .run({ ...v, now });
      }
      this.reindexAirport(iata);
      this.deps.audit.append(actorOf(actor), {
        action: isNew ? 'airport.created' : 'airport.updated', entityType: 'airport', entityId: iata,
        before: existing ? airportDto(existing) : undefined, after: v,
      });
    });
    return airportDto(this.deps.db.prepare('SELECT * FROM airport WHERE iata_code = ?').get(iata) as AirportRow);
  }

  setAirportActive(actor: Actor, iata: string, active: boolean): AirportDto {
    requirePermission(this.deps, actor, 'airport.manage', 'airports.setActive');
    tx(this.deps, () => {
      const r = this.deps.db.prepare('SELECT * FROM airport WHERE iata_code = ?').get(iata) as AirportRow | undefined;
      if (!r) throw new DomainError(ErrorCode.NOT_FOUND, 'Airport not found');
      assertStatusTransition(statusOf(r.is_active), active ? 'ACTIVE' : 'ARCHIVED');
      this.deps.db.prepare('UPDATE airport SET is_active = ?, updated_at = ?, row_version = row_version + 1 WHERE iata_code = ?').run(active ? 1 : 0, this.deps.clock.now().toISOString(), iata);
      this.deps.audit.append(actorOf(actor), { action: active ? 'airport.restored' : 'airport.archived', entityType: 'airport', entityId: iata });
    });
    return airportDto(this.deps.db.prepare('SELECT * FROM airport WHERE iata_code = ?').get(iata) as AirportRow);
  }

  reindexAirport(iata: string): void {
    const r = this.deps.db.prepare('SELECT * FROM airport WHERE iata_code = ?').get(iata) as AirportRow;
    indexForSearch(this.deps.db, 'airport', iata, [r.iata_code, r.icao_code, r.name_en, r.name_ar, r.city_en, r.city_ar, r.country_code]);
  }

  /** Throws unless the airport exists and is active (used when saving segments). */
  assertAirport(iata: string, field: string): void {
    const r = this.deps.db.prepare('SELECT is_active FROM airport WHERE iata_code = ?').get(iata) as { is_active: number } | undefined;
    if (!r) throw fieldError(field, 'UNKNOWN_AIRPORT', `Unknown airport ${iata}`);
  }

  // ── Money accounts ──────────────────────────────────────────────────────
  listMoneyAccounts(actor: Actor, includeInactive = false): MoneyAccountDto[] {
    requirePermission(this.deps, actor, ['treasury.view', 'treasury.manage_accounts', 'payment.customer.receive', 'payment.customer.refund', 'payment.supplier.pay', 'payment.supplier.record_refund', 'expense.create'], 'moneyAccounts.list');
    const showBalance = hasAny(actor, 'treasury.view');
    const rows = this.deps.db
      .prepare(`SELECT * FROM money_account ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY is_active DESC, name COLLATE NOCASE`)
      .all() as MoneyAccountRow[];
    const bal = this.deps.db.prepare('SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS b FROM journal_line WHERE account_code = ? AND money_account_id = ?');
    return rows.map((r) => ({
      id: r.id, name: r.name, accountType: r.account_type, currencyCode: r.currency_code, bankName: r.bank_name, accountRef: r.account_ref,
      notes: r.notes, isActive: r.is_active === 1, rowVersion: r.row_version,
      balanceMinor: showBalance ? (bal.get('1110', r.id) as { b: number }).b : null,
    }));
  }

  saveMoneyAccount(actor: Actor, input: { id?: string; name: string; accountType: (typeof MONEY_ACCOUNT_TYPES)[number]; currencyCode: string; bankName?: string | null; accountRef?: string | null; notes?: string | null; rowVersion?: number }): MoneyAccountDto {
    requirePermission(this.deps, actor, 'treasury.manage_accounts', input.id ? 'moneyAccounts.update' : 'moneyAccounts.create');
    const name = requiredText(input.name, 'name', 80);
    this.currencies.minorUnitOf(input.currencyCode);
    const id = tx(this.deps, () => {
      const dup = this.deps.db.prepare('SELECT id FROM money_account WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, input.id ?? '') as { id: string } | undefined;
      if (dup) throw new DomainError(ErrorCode.CONFLICT, 'An account with this name exists', { field: 'name', reason: 'DUPLICATE_NAME' });
      const now = this.deps.clock.now().toISOString();
      const v = { name, type: input.accountType, currency: input.currencyCode, bank: optionalText(input.bankName, 'bankName', 80), ref: optionalText(input.accountRef, 'accountRef', 60), notes: optionalText(input.notes, 'notes', 500) };
      if (!input.id) {
        const newId = this.deps.newId();
        this.deps.db
          .prepare(`INSERT INTO money_account (id, name, account_type, currency_code, bank_name, account_ref, notes, is_active, created_at, created_by, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
          .run(newId, v.name, v.type, v.currency, v.bank, v.ref, v.notes, now, actor.userId, now);
        this.deps.audit.append(actorOf(actor), { action: 'money_account.created', entityType: 'money_account', entityId: newId, after: v });
        return newId;
      }
      const before = this.deps.db.prepare('SELECT * FROM money_account WHERE id = ?').get(input.id) as MoneyAccountRow | undefined;
      if (!before) throw new DomainError(ErrorCode.NOT_FOUND, 'Account not found');
      if (input.rowVersion !== undefined && before.row_version !== input.rowVersion) throw new DomainError(ErrorCode.STALE_RECORD, 'Account was changed by someone else');
      const used = this.deps.db.prepare('SELECT 1 FROM journal_line WHERE money_account_id = ? LIMIT 1').get(input.id);
      if (used && before.currency_code !== v.currency) {
        throw new DomainError(ErrorCode.CONFLICT, 'The currency of an account with transactions cannot change', { field: 'currencyCode', reason: 'CURRENCY_LOCKED' });
      }
      this.deps.db
        .prepare(`UPDATE money_account SET name=?, account_type=?, currency_code=?, bank_name=?, account_ref=?, notes=?, updated_at=?, row_version=row_version+1 WHERE id=?`)
        .run(v.name, v.type, v.currency, v.bank, v.ref, v.notes, now, input.id);
      this.deps.audit.append(actorOf(actor), { action: 'money_account.updated', entityType: 'money_account', entityId: input.id, before: { name: before.name, currency: before.currency_code }, after: v });
      return input.id;
    });
    return this.listMoneyAccounts(actor, true).find((a) => a.id === id)!;
  }

  setMoneyAccountActive(actor: Actor, id: string, active: boolean): void {
    requirePermission(this.deps, actor, 'treasury.manage_accounts', 'moneyAccounts.setActive');
    tx(this.deps, () => {
      const r = this.deps.db.prepare('SELECT is_active FROM money_account WHERE id = ?').get(id) as { is_active: number } | undefined;
      if (!r) throw new DomainError(ErrorCode.NOT_FOUND, 'Account not found');
      assertStatusTransition(statusOf(r.is_active), active ? 'ACTIVE' : 'ARCHIVED');
      this.deps.db.prepare('UPDATE money_account SET is_active = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(active ? 1 : 0, this.deps.clock.now().toISOString(), id);
      this.deps.audit.append(actorOf(actor), { action: active ? 'money_account.restored' : 'money_account.archived', entityType: 'money_account', entityId: id });
    });
  }

  /**
   * Every installation needs somewhere to record cash. Created at first-run
   * setup (and for databases upgraded from Phase 2) in the base currency.
   */
  ensureDefaultMoneyAccount(userId: string | null): void {
    const db = this.deps.db;
    if (db.prepare('SELECT 1 FROM money_account LIMIT 1').get()) return;
    const owner = userId ?? (db.prepare(`SELECT u.id FROM app_user u ORDER BY u.created_at LIMIT 1`).get() as { id: string } | undefined)?.id;
    const base = db.prepare('SELECT base_currency_code FROM company_profile WHERE id = 1').get() as { base_currency_code: string } | undefined;
    if (!owner || !base) return;
    const id = this.deps.newId();
    const now = this.deps.clock.now().toISOString();
    // Only columns that exist since schema v1, so this is safe on any schema version.
    db.prepare(`INSERT INTO money_account (id, name, account_type, currency_code, is_active, created_at, created_by) VALUES (?, ?, 'CASH', ?, 1, ?, ?)`)
      .run(id, `الخزينة / Cash (${base.base_currency_code})`, base.base_currency_code, now, owner);
    this.deps.audit.append({ userId: owner, sessionId: null, workstation: 'SYSTEM' }, {
      action: 'money_account.created', entityType: 'money_account', entityId: id, metadata: { automatic: true },
    });
  }

  moneyAccount(id: string): MoneyAccountRow {
    const r = this.deps.db.prepare('SELECT * FROM money_account WHERE id = ?').get(id) as MoneyAccountRow | undefined;
    if (!r) throw fieldError('moneyAccountId', 'NOT_FOUND', 'Account not found');
    return r;
  }

  // ── Expense categories ──────────────────────────────────────────────────
  listExpenseCategories(actor: Actor, includeArchived = false): ExpenseCategoryDto[] {
    requirePermission(this.deps, actor, ['expense.view', 'expense.create', 'expense.category.manage'], 'expenseCategories.list');
    const rows = this.deps.db
      .prepare(`SELECT * FROM expense_category ${includeArchived ? '' : 'WHERE is_active = 1'} ORDER BY is_active DESC, is_system DESC, name_en COLLATE NOCASE`)
      .all() as CategoryRow[];
    return rows.map(categoryDto);
  }

  expenseAccounts(): { code: string; nameAr: string; nameEn: string }[] {
    return (this.deps.db.prepare(`SELECT code, name_ar, name_en FROM ledger_account WHERE account_class = 'EXPENSE' AND is_active = 1 ORDER BY code`).all() as { code: string; name_ar: string; name_en: string }[])
      .map((a) => ({ code: a.code, nameAr: a.name_ar, nameEn: a.name_en }));
  }

  saveExpenseCategory(actor: Actor, input: { id?: string; code: string; nameAr: string; nameEn: string; accountCode?: string | null; rowVersion?: number }): ExpenseCategoryDto {
    requirePermission(this.deps, actor, 'expense.category.manage', input.id ? 'expenseCategories.update' : 'expenseCategories.create');
    const code = requiredText(input.code, 'code', 30).toUpperCase().replace(/\s+/g, '_');
    if (!/^[A-Z][A-Z0-9_]*$/.test(code)) throw fieldError('code', 'INVALID_CODE', 'Use letters, digits and _');
    const account = input.accountCode ?? '6190';
    const acc = this.deps.db.prepare(`SELECT account_class FROM ledger_account WHERE code = ?`).get(account) as { account_class: string } | undefined;
    if (!acc || acc.account_class !== 'EXPENSE') throw fieldError('accountCode', 'INVALID_ACCOUNT', 'Choose an expense account');
    const v = { code, nameAr: requiredText(input.nameAr, 'nameAr', 80), nameEn: requiredText(input.nameEn, 'nameEn', 80), account };
    const id = tx(this.deps, () => {
      const dup = this.deps.db.prepare('SELECT id FROM expense_category WHERE code = ? AND id <> ?').get(code, input.id ?? '');
      if (dup) throw new DomainError(ErrorCode.CONFLICT, 'Category code exists', { field: 'code', reason: 'DUPLICATE_CODE' });
      const now = this.deps.clock.now().toISOString();
      if (!input.id) {
        const newId = this.deps.newId();
        this.deps.db
          .prepare(`INSERT INTO expense_category (id, code, name_ar, name_en, ledger_account_code, is_active, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`)
          .run(newId, code, v.nameAr, v.nameEn, account, now, now);
        this.deps.audit.append(actorOf(actor), { action: 'expense_category.created', entityType: 'expense_category', entityId: newId, after: v });
        return newId;
      }
      const before = this.deps.db.prepare('SELECT * FROM expense_category WHERE id = ?').get(input.id) as CategoryRow | undefined;
      if (!before) throw new DomainError(ErrorCode.NOT_FOUND, 'Category not found');
      if (input.rowVersion !== undefined && before.row_version !== input.rowVersion) throw new DomainError(ErrorCode.STALE_RECORD, 'Category was changed by someone else');
      // History keeps its category: renaming is display-only; the ledger account of past journal lines never changes.
      this.deps.db
        .prepare(`UPDATE expense_category SET code=?, name_ar=?, name_en=?, ledger_account_code=?, updated_at=?, row_version=row_version+1 WHERE id=?`)
        .run(before.is_system ? before.code : code, v.nameAr, v.nameEn, account, now, input.id);
      this.deps.audit.append(actorOf(actor), { action: 'expense_category.updated', entityType: 'expense_category', entityId: input.id, before: categoryDto(before), after: v });
      return input.id;
    });
    return categoryDto(this.deps.db.prepare('SELECT * FROM expense_category WHERE id = ?').get(id) as CategoryRow);
  }

  setExpenseCategoryActive(actor: Actor, id: string, active: boolean): void {
    requirePermission(this.deps, actor, 'expense.category.manage', 'expenseCategories.setActive');
    tx(this.deps, () => {
      const r = this.deps.db.prepare('SELECT is_active FROM expense_category WHERE id = ?').get(id) as { is_active: number } | undefined;
      if (!r) throw new DomainError(ErrorCode.NOT_FOUND, 'Category not found');
      assertStatusTransition(statusOf(r.is_active), active ? 'ACTIVE' : 'ARCHIVED');
      this.deps.db.prepare('UPDATE expense_category SET is_active = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(active ? 1 : 0, this.deps.clock.now().toISOString(), id);
      this.deps.audit.append(actorOf(actor), { action: active ? 'expense_category.restored' : 'expense_category.archived', entityType: 'expense_category', entityId: id });
    });
  }

  // ── Currencies & rates ──────────────────────────────────────────────────
  setCurrencyActive(actor: Actor, code: string, active: boolean): CurrencyDto[] {
    requirePermission(this.deps, actor, 'finance.exchange_rates', 'currency.setActive');
    if (!active && code === this.company.core().baseCurrency) throw new DomainError(ErrorCode.VALIDATION, 'The base currency cannot be deactivated', { reason: 'BASE_CURRENCY' });
    tx(this.deps, () => {
      const r = this.deps.db.prepare('SELECT is_active FROM currency WHERE code = ?').get(code) as { is_active: number } | undefined;
      if (!r) throw new DomainError(ErrorCode.NOT_FOUND, 'Currency not found');
      this.deps.db.prepare('UPDATE currency SET is_active = ? WHERE code = ?').run(active ? 1 : 0, code);
      this.deps.audit.append(actorOf(actor), { action: active ? 'currency.activated' : 'currency.deactivated', entityType: 'currency', entityId: code });
    });
    return this.currencies.list();
  }

  listRates(actor: Actor, currencyCode?: string): ExchangeRateDto[] {
    requirePermission(this.deps, actor, ['finance.exchange_rates', 'treasury.view', 'report.profit'], 'currency.rates');
    const rows = this.deps.db
      .prepare(`SELECT r.currency_code, r.rate_date, r.rate, r.created_at, u.username FROM exchange_rate r LEFT JOIN app_user u ON u.id = r.created_by
                WHERE (? IS NULL OR r.currency_code = ?) ORDER BY r.rate_date DESC, r.currency_code LIMIT 500`)
      .all(currencyCode ?? null, currencyCode ?? null) as { currency_code: string; rate_date: string; rate: string; created_at: string; username: string | null }[];
    return rows.map((r) => ({ currencyCode: r.currency_code, rateDate: r.rate_date, rate: r.rate, createdAt: r.created_at, createdBy: r.username }));
  }
}

function airportDto(r: AirportRow): AirportDto {
  return {
    iataCode: r.iata_code, icaoCode: r.icao_code, nameEn: r.name_en, nameAr: r.name_ar, cityEn: r.city_en, cityAr: r.city_ar,
    countryCode: r.country_code, timezone: r.timezone, status: statusOf(r.is_active), rowVersion: r.row_version,
  };
}

function categoryDto(r: CategoryRow): ExpenseCategoryDto {
  return {
    id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, accountCode: r.ledger_account_code,
    isSystem: r.is_system === 1, status: statusOf(r.is_active), rowVersion: r.row_version,
  };
}
