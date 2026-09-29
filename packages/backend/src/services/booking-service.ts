import {
  DomainError,
  ErrorCode,
  addDays,
  assertIssuable,
  assertPreIssue,
  assertPriceAmounts,
  bookingTransition,
  changeSeverity,
  convertMinor,
  diffSegment,
  fieldError,
  isPreIssue,
  isTicketClosed,
  normalizeEmail,
  normalizePassenger,
  normalizePnr,
  normalizeSegment,
  normalizeTicketNumber,
  optionalText,
  parseRate,
  planIssue,
  requiredText,
  requiresAttention,
  saleTotal,
  settlementStatus,
  type BookingStatus,
  type ChangeNotificationStatus,
  type DocumentLineDraft,
  type PassengerInput,
  type PriceItem,
  type SegmentInput,
  type SegmentSnapshot,
  type TicketStatus,
} from '@airdesk/domain';
import type {
  BookingDto, BookingListItemDto, CancellationDto, CustomerPositionDto, MoneyDto, NotificationDto, PageDto, PassengerDto, PriceItemDto,
  RefundStatusDto, ScheduleChangeDto, SegmentDto, SupplierPositionDto, TicketDto,
} from '@airdesk/contracts';
import type { CompanyService } from './company-service';
import { actorOf, hasAny, requirePermission, tx, type Actor, type ServiceDeps } from './context';
import type { CurrencyService } from './currency-service';
import { documentSide, readDocuments } from './document-reader';
import { indexForSearch, maskIdentifier, nextSequenceNumber, searchClause } from './masterdata-support';
import type { PostingService } from './posting-service';
import type { ReferenceService } from './reference-service';
import { readSetting } from './settings';

export interface BookingRow {
  id: string; booking_no: string; customer_id: string; status: BookingStatus; booking_date: string; issue_date: string | null; due_date: string | null;
  ticketing_deadline_at: string | null; primary_pnr: string | null; default_supplier_id: string | null; airline_id: string | null;
  sale_currency_code: string; sale_exchange_rate: string | null; contact_name: string; contact_mobile: string; contact_whatsapp: string | null;
  contact_email: string | null; sales_agent_id: string; notes: string | null; created_at: string; created_by: string; updated_at: string;
  updated_by: string | null; row_version: number;
}
interface PassengerRow {
  id: string; booking_id: string; seq: number; pax_type: 'ADT' | 'CHD' | 'INF'; title: string | null; given_name: string; surname: string;
  name_ar: string | null; gender: 'M' | 'F' | 'X' | null; date_of_birth: string | null; passport_no: string | null; passport_expiry: string | null;
  nationality: string | null; mobile: string | null; status: 'ACTIVE' | 'CANCELLED'; id_document_type: PassengerDto['idDocumentType'];
  id_document_no: string | null; frequent_flyer_no: string | null; notes: string | null; row_version: number;
}
interface SegmentRow {
  id: string; booking_id: string; seq: number; marketing_airline_id: string; operating_airline_id: string | null; flight_number: string;
  origin_iata: string; destination_iata: string; departure_date: string; departure_time: string; arrival_date: string; arrival_time: string;
  departure_terminal: string | null; arrival_terminal: string | null; cabin_class: SegmentDto['cabinClass']; booking_class: string | null;
  airline_locator: string | null; status: SegmentDto['status']; version: number; baggage: string | null; seat: string | null; notes: string | null;
  row_version: number;
}
interface ItemRow {
  id: string; booking_id: string; seq: number; passenger_id: string; supplier_id: string | null; validating_airline_id: string | null;
  ticket_number: string | null; fare_minor: number; taxes_minor: number; service_fee_minor: number; discount_minor: number;
  cost_currency_code: string | null; cost_minor: number | null; supplier_reference: string | null; notes: string | null; ticket_id: string | null;
  row_version: number;
}

export interface BookingListQuery {
  query?: string | undefined;
  status: 'ALL' | 'OPEN' | 'DRAFT' | 'RESERVED' | 'ISSUED' | 'PARTIALLY_CANCELLED' | 'CANCELLED' | 'VOIDED' | 'DISCARDED';
  from?: string | undefined;
  to?: string | undefined;
  customerId?: string | undefined;
  unpaidOnly?: boolean | undefined;
  sortDir: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface PriceItemInput {
  passengerId: string;
  supplierId?: string | null;
  validatingAirlineId?: string | null;
  ticketNumber?: string | null;
  fareMinor: number;
  taxesMinor?: number;
  serviceFeeMinor?: number;
  discountMinor?: number;
  costCurrency?: string | null;
  costMinor?: number | null;
  supplierReference?: string | null;
  notes?: string | null;
}

const SEGMENT_SNAPSHOT_COLUMNS = [
  'departure_date', 'departure_time', 'arrival_date', 'arrival_time', 'flight_number', 'origin_iata', 'destination_iata',
  'marketing_airline_id', 'operating_airline_id', 'departure_terminal', 'arrival_terminal', 'cabin_class', 'status',
] as const;

/**
 * Ticket records ("bookings" internally). IMPORTANT — scope: AirDesk does NOT
 * book flights. The airline reservation and ticket issuance happen OUTSIDE
 * AirDesk (the office's GDS / airline portal / consolidator). A booking here is
 * the office's RECORD of that external transaction: the employee types the
 * existing PNR, ticket numbers, flights, supplier, purchase cost and the price
 * charged to the customer. Nothing in this service contacts an airline, GDS or
 * supplier system; no PNR or ticket number is ever generated.
 *
 * Statuses: DRAFT = record being entered; RESERVED = the office holds an
 * external reservation that is not ticketed yet (optional); ISSUED = "ticketed"
 * — the externally issued ticket(s) are recorded and the sale + purchase are
 * posted to the ledger. The method `issue()` therefore RECORDS ticketing; it
 * does not issue anything with an airline.
 *
 * (owner requirements §4–§10, §30). A record is priced and edited
 * freely while DRAFT/RESERVED; issuing it creates the tickets and posts the
 * customer invoice + supplier bill(s) atomically (BR-BKG-02). After issue,
 * money only moves through documents (adjustments, cancellations, payments)
 * and schedule edits become tracked schedule-change events (BR-SCH-01).
 *
 * Visibility: without booking.view_all a user sees only the bookings they
 * created or sell. Cost is hidden without booking.view_cost and profit
 * without booking.view_profit — in every response, not just the UI.
 */
export class BookingService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly company: CompanyService,
    private readonly currencies: CurrencyService,
    private readonly posting: PostingService,
    private readonly reference: ReferenceService,
  ) {}

  // ── Queries ─────────────────────────────────────────────────────────────
  list(actor: Actor, q: BookingListQuery): PageDto<BookingListItemDto> {
    requirePermission(this.deps, actor, 'booking.view', 'bookings.list');
    const where: string[] = [];
    const params: unknown[] = [];
    if (!hasAny(actor, 'booking.view_all')) {
      where.push('(b.sales_agent_id = ? OR b.created_by = ?)');
      params.push(actor.userId, actor.userId);
    }
    if (q.status === 'OPEN') where.push(`b.status IN ('DRAFT','RESERVED','ISSUED','PARTIALLY_CANCELLED')`);
    else if (q.status !== 'ALL') {
      where.push('b.status = ?');
      params.push(q.status);
    }
    if (q.from) { where.push('b.booking_date >= ?'); params.push(q.from); }
    if (q.to) { where.push('b.booking_date <= ?'); params.push(q.to); }
    if (q.customerId) { where.push('b.customer_id = ?'); params.push(q.customerId); }
    if (q.unpaidOnly) where.push(`EXISTS (SELECT 1 FROM journal_line jl WHERE jl.booking_id = b.id AND jl.account_code = '1200' GROUP BY jl.currency_code HAVING SUM(jl.debit_minor - jl.credit_minor) > 0)`);
    const search = searchClause('booking', q.query);
    if (search) { where.push(`b.id IN (${search.sql})`); params.push(...search.params); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.deps.db.prepare(`SELECT COUNT(*) AS n FROM booking b ${w}`).get(...params) as { n: number }).n;
    const rows = this.deps.db
      .prepare(`SELECT b.*, c.full_name, c.customer_no, u.display_name AS agent_name, a.name_en AS airline_name FROM booking b
                JOIN customer c ON c.id = b.customer_id LEFT JOIN app_user u ON u.id = b.sales_agent_id LEFT JOIN airline a ON a.id = b.airline_id
                ${w} ORDER BY b.booking_date ${q.sortDir === 'asc' ? 'ASC' : 'DESC'}, b.booking_no ${q.sortDir === 'asc' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`)
      .all(...params, q.limit, q.offset) as (BookingRow & { full_name: string; customer_no: string; agent_name: string | null; airline_name: string | null })[];
    return { items: rows.map((r) => this.listItem(r)), total };
  }

  private listItem(r: BookingRow & { full_name: string; customer_no: string; agent_name: string | null; airline_name: string | null }): BookingListItemDto {
    const db = this.deps.db;
    const pax = db.prepare(`SELECT given_name || ' ' || surname AS n FROM booking_passenger WHERE booking_id = ? AND status = 'ACTIVE' ORDER BY seq`).all(r.id) as { n: string }[];
    const segs = db.prepare(`SELECT origin_iata, destination_iata, departure_date, departure_time FROM flight_segment WHERE booking_id = ? AND status <> 'CANCELLED' ORDER BY seq`).all(r.id) as { origin_iata: string; destination_iata: string; departure_date: string; departure_time: string }[];
    const pos = this.customerPositions(r.id).find((p) => p.currency === r.sale_currency_code);
    const quote = (db.prepare('SELECT COALESCE(SUM(fare_minor + taxes_minor + service_fee_minor - discount_minor), 0) AS t FROM booking_price_item WHERE booking_id = ?').get(r.id) as { t: number }).t;
    const charged = isPreIssue(r.status) || r.status === 'DISCARDED' ? quote : pos?.chargedMinor ?? 0;
    const balance = pos?.balanceMinor ?? 0;
    return {
      id: r.id, bookingNo: r.booking_no, pnr: r.primary_pnr, status: r.status, bookingDate: r.booking_date, issueDate: r.issue_date,
      customerId: r.customer_id, customerName: r.full_name, customerNo: r.customer_no, contactMobile: r.contact_mobile,
      passengerCount: pax.length, passengerNames: pax.map((p) => p.n).join('، '),
      route: segs.length ? routeOf(segs) : null, firstDeparture: segs[0] ? `${segs[0].departure_date} ${segs[0].departure_time}` : null,
      airlineName: r.airline_name, saleCurrency: r.sale_currency_code, totalMinor: charged, balanceMinor: balance,
      settlement: pos ? pos.settlement : isPreIssue(r.status) ? 'NOT_CHARGED' : settlementStatus(charged, balance),
      refundStatus: this.refundStatus(r.id), scheduleAttention: this.hasAttention(r.id), agentName: r.agent_name,
    };
  }

  get(actor: Actor, id: string): BookingDto {
    requirePermission(this.deps, actor, 'booking.view', 'bookings.get');
    const r = this.accessible(actor, id);
    const db = this.deps.db;
    const viewCost = hasAny(actor, 'booking.view_cost');
    const viewProfit = hasAny(actor, 'booking.view_profit');
    const viewIdentity = hasAny(actor, 'customer.view_identity');
    const names = db.prepare(`SELECT c.full_name, c.customer_no, a.name_en AS airline_name, s.name AS supplier_name, ag.display_name AS agent,
                                     cu.display_name AS created_by, uu.display_name AS updated_by
                              FROM booking b JOIN customer c ON c.id = b.customer_id LEFT JOIN airline a ON a.id = b.airline_id
                              LEFT JOIN supplier s ON s.id = b.default_supplier_id LEFT JOIN app_user ag ON ag.id = b.sales_agent_id
                              LEFT JOIN app_user cu ON cu.id = b.created_by LEFT JOIN app_user uu ON uu.id = b.updated_by WHERE b.id = ?`)
      .get(id) as { full_name: string; customer_no: string; airline_name: string | null; supplier_name: string | null; agent: string | null; created_by: string | null; updated_by: string | null };

    const passengers = (db.prepare('SELECT * FROM booking_passenger WHERE booking_id = ? ORDER BY seq').all(id) as PassengerRow[]).map((p) => passengerDto(p, viewIdentity));
    const paxName = new Map(passengers.map((p) => [p.id, `${p.givenName} ${p.surname}`]));
    const changes = this.scheduleChanges(id);
    const segments = (db.prepare(`SELECT fs.*, a.name_en AS airline_name, a.iata_code AS airline_code, o.name_en AS origin_name, d.name_en AS dest_name
                                  FROM flight_segment fs JOIN airline a ON a.id = fs.marketing_airline_id
                                  LEFT JOIN airport o ON o.iata_code = fs.origin_iata LEFT JOIN airport d ON d.iata_code = fs.destination_iata
                                  WHERE fs.booking_id = ? ORDER BY fs.seq`).all(id) as (SegmentRow & { airline_name: string; airline_code: string | null; origin_name: string | null; dest_name: string | null })[])
      .map((s): SegmentDto => ({
        id: s.id, seq: s.seq, airlineId: s.marketing_airline_id, airlineName: s.airline_name, airlineCode: s.airline_code,
        operatingAirlineId: s.operating_airline_id, flightNumber: s.flight_number, origin: s.origin_iata, originName: s.origin_name,
        destination: s.destination_iata, destinationName: s.dest_name, departureDate: s.departure_date, departureTime: s.departure_time,
        arrivalDate: s.arrival_date, arrivalTime: s.arrival_time, cabinClass: s.cabin_class, bookingClass: s.booking_class,
        departureTerminal: s.departure_terminal, arrivalTerminal: s.arrival_terminal, baggage: s.baggage, seat: s.seat,
        airlineLocator: s.airline_locator, status: s.status, notes: s.notes, version: s.version,
        scheduleChanged: changes.some((c) => c.segmentId === s.id),
        scheduleAttention: changes.some((c) => c.segmentId === s.id && c.requiresAttention), rowVersion: s.row_version,
      }));
    const items = db.prepare(`SELECT i.*, s.name AS supplier_name FROM booking_price_item i LEFT JOIN supplier s ON s.id = i.supplier_id WHERE i.booking_id = ? ORDER BY i.seq`).all(id) as (ItemRow & { supplier_name: string | null })[];
    const priceItems = items.map((i): PriceItemDto => ({
      id: i.id, seq: i.seq, passengerId: i.passenger_id, supplierId: i.supplier_id, supplierName: i.supplier_name,
      validatingAirlineId: i.validating_airline_id, ticketNumber: i.ticket_number, fareMinor: i.fare_minor, taxesMinor: i.taxes_minor,
      serviceFeeMinor: i.service_fee_minor, discountMinor: i.discount_minor, saleTotalMinor: saleTotal(toItem(i)),
      costCurrency: viewCost ? i.cost_currency_code : null, costMinor: viewCost ? i.cost_minor : null, costEntered: i.cost_minor !== null,
      supplierReference: viewCost ? i.supplier_reference : null, notes: i.notes, ticketId: i.ticket_id, rowVersion: i.row_version,
    }));
    const tickets = this.tickets(id, viewCost, r.sale_currency_code, paxName);
    const costTotals = new Map<string, number>();
    for (const i of items) if (i.cost_minor !== null && i.cost_currency_code) costTotals.set(i.cost_currency_code, (costTotals.get(i.cost_currency_code) ?? 0) + i.cost_minor);
    const quoteSale = items.reduce((s, i) => s + saleTotal(toItem(i)), 0);

    const docs = readDocuments(db, `(d.booking_id = ? OR d.id IN (SELECT document_id FROM fin_document_line WHERE booking_id = ?))`, [id, id])
      .filter((d) => viewCost || documentSide(d) !== 'SUPPLIER');
    // Same figures as v_booking_financials, read through ix_jl_booking: the view groups every
    // booking before filtering, which scans the whole journal (measured in the performance test).
    const fin = db
      .prepare(`SELECT COALESCE(SUM(CASE WHEN la.account_class IN ('REVENUE','CONTRA_REVENUE') THEN jl.credit_base_minor - jl.debit_base_minor END), 0) AS net_sales_base_minor,
                  COALESCE(SUM(CASE WHEN la.account_class IN ('COST','CONTRA_COST') THEN jl.debit_base_minor - jl.credit_base_minor END), 0) AS net_cost_base_minor,
                  COALESCE(SUM(CASE WHEN la.account_class IN ('REVENUE','CONTRA_REVENUE','COST','CONTRA_COST') THEN jl.credit_base_minor - jl.debit_base_minor END), 0) AS gross_profit_base_minor
                FROM journal_line jl JOIN ledger_account la ON la.code = jl.account_code WHERE jl.booking_id = ?`)
      .get(id) as { net_sales_base_minor: number; net_cost_base_minor: number; gross_profit_base_minor: number };

    return {
      id: r.id, bookingNo: r.booking_no, status: r.status, pnr: r.primary_pnr, bookingDate: r.booking_date, issueDate: r.issue_date,
      dueDate: r.due_date, ticketingDeadlineAt: r.ticketing_deadline_at, customerId: r.customer_id, customerName: names.full_name,
      customerNo: names.customer_no, airlineId: r.airline_id, airlineName: names.airline_name, defaultSupplierId: r.default_supplier_id,
      defaultSupplierName: names.supplier_name, saleCurrency: r.sale_currency_code, contactName: r.contact_name, contactMobile: r.contact_mobile,
      contactWhatsapp: r.contact_whatsapp, contactEmail: r.contact_email, notes: r.notes, agentName: names.agent, createdAt: r.created_at,
      createdBy: names.created_by, updatedAt: r.updated_at, updatedBy: names.updated_by, rowVersion: r.row_version,
      passengers, segments, priceItems, tickets,
      quote: {
        saleTotalMinor: quoteSale,
        costTotals: viewCost ? [...costTotals].map(([currency, minor]): MoneyDto => ({ currency, minor })) : null,
        estimatedProfitBaseMinor: viewProfit && viewCost ? this.estimateProfit(r, items) : null,
      },
      customer: this.customerPositions(id),
      suppliers: viewCost || hasAny(actor, 'supplier.view_financial') ? this.supplierPositions(id) : null,
      profit: viewProfit ? { netSalesBaseMinor: fin.net_sales_base_minor, netCostBaseMinor: fin.net_cost_base_minor, grossProfitBaseMinor: fin.gross_profit_base_minor } : null,
      documents: docs,
      cancellations: this.cancellations(id, paxName),
      scheduleChanges: changes,
      notifications: this.notifications(id),
      statusHistory: (db.prepare(`SELECT h.from_status, h.to_status, h.changed_at, u.display_name AS by_name, h.reason FROM booking_status_history h
                                  LEFT JOIN app_user u ON u.id = h.changed_by WHERE h.booking_id = ? ORDER BY h.changed_at, h.id`).all(id) as
        { from_status: string | null; to_status: string; changed_at: string; by_name: string | null; reason: string | null }[])
        .map((h) => ({ fromStatus: h.from_status, toStatus: h.to_status, changedAt: h.changed_at, changedBy: h.by_name, reason: h.reason })),
      refundStatus: this.refundStatus(id),
      can: { viewCost, viewProfit, enterCost: hasAny(actor, 'booking.enter_cost') },
    };
  }

  // ── Header ──────────────────────────────────────────────────────────────
  create(actor: Actor, input: {
    customerId: string; pnr?: string | null; saleCurrency?: string | null; airlineId?: string | null; supplierId?: string | null;
    contactName?: string | null; contactMobile?: string | null; contactWhatsapp?: string | null; contactEmail?: string | null; notes?: string | null;
  }): BookingDto {
    requirePermission(this.deps, actor, 'booking.create', 'bookings.create');
    const core = this.company.core();
    const id = tx(this.deps, () => {
      const c = this.deps.db.prepare('SELECT * FROM customer WHERE id = ?').get(input.customerId) as { id: string; full_name: string; primary_mobile: string; whatsapp_number: string | null; email: string | null; is_active: number } | undefined;
      if (!c) throw fieldError('customerId', 'NOT_FOUND', 'Customer not found');
      if (c.is_active !== 1) throw fieldError('customerId', 'ARCHIVED_READ_ONLY', 'The customer is archived');
      const saleCurrency = input.saleCurrency ?? core.baseCurrency;
      this.currencies.minorUnitOf(saleCurrency);
      this.assertRef('airline', input.airlineId, 'airlineId');
      this.assertRef('supplier', input.supplierId, 'supplierId');
      const now = this.deps.clock.now().toISOString();
      const bookingId = this.deps.newId();
      const bookingNo = nextSequenceNumber(this.deps.db, 'BOOKING', 'BK');
      this.deps.db
        .prepare(`INSERT INTO booking (id, booking_no, customer_id, status, booking_date, primary_pnr, default_supplier_id, airline_id, sale_currency_code,
                    contact_name, contact_mobile, contact_whatsapp, contact_email, sales_agent_id, notes, created_at, created_by, updated_at)
                  VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(bookingId, bookingNo, c.id, this.company.today(), normalizePnr(input.pnr), input.supplierId ?? null, input.airlineId ?? null, saleCurrency,
          optionalText(input.contactName, 'contactName', 120) ?? c.full_name, optionalText(input.contactMobile, 'contactMobile', 40) ?? c.primary_mobile,
          optionalText(input.contactWhatsapp, 'contactWhatsapp', 40) ?? c.whatsapp_number, normalizeEmail(input.contactEmail, 'contactEmail') ?? c.email,
          actor.userId, optionalText(input.notes, 'notes', 2000), now, actor.userId, now);
      this.history(actor, bookingId, null, 'DRAFT', null);
      this.reindex(bookingId);
      this.deps.audit.append(actorOf(actor), { action: 'booking.created', entityType: 'booking', entityId: bookingId, after: { bookingNo, customerId: c.id, saleCurrency } });
      return bookingId;
    });
    return this.get(actor, id);
  }

  update(actor: Actor, id: string, rowVersion: number, patch: {
    pnr?: string | null; airlineId?: string | null; supplierId?: string | null; saleCurrency?: string; contactName?: string; contactMobile?: string;
    contactWhatsapp?: string | null; contactEmail?: string | null; notes?: string | null; ticketingDeadlineAt?: string | null;
  }): BookingDto {
    requirePermission(this.deps, actor, 'booking.edit', 'bookings.update');
    tx(this.deps, () => {
      const r = this.accessible(actor, id);
      this.assertVersion(r, rowVersion);
      if (r.status === 'DISCARDED' || r.status === 'VOIDED') throw new DomainError(ErrorCode.CONFLICT, 'This booking is closed', { reason: 'BOOKING_CLOSED' });
      if (patch.saleCurrency !== undefined && patch.saleCurrency !== r.sale_currency_code) {
        assertPreIssue(r.status, 'Changing the sale currency');
        this.currencies.minorUnitOf(patch.saleCurrency);
      }
      if (patch.supplierId !== undefined && patch.supplierId !== r.default_supplier_id) this.assertRef('supplier', patch.supplierId, 'supplierId');
      if (patch.airlineId !== undefined && patch.airlineId !== r.airline_id) this.assertRef('airline', patch.airlineId, 'airlineId');
      const next = {
        pnr: patch.pnr !== undefined ? normalizePnr(patch.pnr) : r.primary_pnr,
        airlineId: patch.airlineId !== undefined ? patch.airlineId : r.airline_id,
        supplierId: patch.supplierId !== undefined ? patch.supplierId : r.default_supplier_id,
        saleCurrency: patch.saleCurrency ?? r.sale_currency_code,
        contactName: patch.contactName !== undefined ? requiredText(patch.contactName, 'contactName', 120) : r.contact_name,
        contactMobile: patch.contactMobile !== undefined ? requiredText(patch.contactMobile, 'contactMobile', 40) : r.contact_mobile,
        contactWhatsapp: patch.contactWhatsapp !== undefined ? optionalText(patch.contactWhatsapp, 'contactWhatsapp', 40) : r.contact_whatsapp,
        contactEmail: patch.contactEmail !== undefined ? normalizeEmail(patch.contactEmail, 'contactEmail') : r.contact_email,
        notes: patch.notes !== undefined ? optionalText(patch.notes, 'notes', 2000) : r.notes,
        deadline: patch.ticketingDeadlineAt !== undefined ? optionalText(patch.ticketingDeadlineAt, 'ticketingDeadlineAt', 30) : r.ticketing_deadline_at,
      };
      this.deps.db
        .prepare(`UPDATE booking SET primary_pnr=?, airline_id=?, default_supplier_id=?, sale_currency_code=?, contact_name=?, contact_mobile=?, contact_whatsapp=?,
                    contact_email=?, notes=?, ticketing_deadline_at=?, updated_at=?, updated_by=?, row_version=row_version+1 WHERE id=?`)
        .run(next.pnr, next.airlineId, next.supplierId, next.saleCurrency, next.contactName, next.contactMobile, next.contactWhatsapp, next.contactEmail,
          next.notes, next.deadline, this.deps.clock.now().toISOString(), actor.userId, id);
      this.reindex(id);
      this.deps.audit.append(actorOf(actor), {
        action: 'booking.updated', entityType: 'booking', entityId: id,
        before: { pnr: r.primary_pnr, airlineId: r.airline_id, supplierId: r.default_supplier_id, saleCurrency: r.sale_currency_code, contactMobile: r.contact_mobile, notes: r.notes },
        after: { pnr: next.pnr, airlineId: next.airlineId, supplierId: next.supplierId, saleCurrency: next.saleCurrency, contactMobile: next.contactMobile, notes: next.notes },
      });
    });
    return this.get(actor, id);
  }

  // ── Passengers ──────────────────────────────────────────────────────────
  savePassenger(actor: Actor, bookingId: string, passengerId: string | null, input: PassengerInput): BookingDto {
    requirePermission(this.deps, actor, 'booking.edit', 'bookings.savePassenger');
    const p = normalizePassenger(input, { today: this.company.today() });
    tx(this.deps, () => {
      const b = this.accessible(actor, bookingId);
      if (b.status === 'DISCARDED' || b.status === 'VOIDED' || b.status === 'CANCELLED') throw new DomainError(ErrorCode.CONFLICT, 'This booking is closed', { reason: 'BOOKING_CLOSED' });
      const now = this.deps.clock.now().toISOString();
      if (!passengerId) {
        assertPreIssue(b.status, 'Adding a passenger');
        const seq = (this.deps.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM booking_passenger WHERE booking_id = ?').get(bookingId) as { n: number }).n;
        const newId = this.deps.newId();
        this.deps.db
          .prepare(`INSERT INTO booking_passenger (id, booking_id, seq, pax_type, title, given_name, surname, name_ar, gender, date_of_birth, passport_no,
                      passport_expiry, nationality, mobile, id_document_type, id_document_no, frequent_flyer_no, notes, created_at, updated_at)
                    VALUES (@id, @bookingId, @seq, @paxType, @title, @givenName, @surname, @nameAr, @gender, @dateOfBirth, @passportNo, @passportExpiry,
                      @nationality, @mobile, @idDocumentType, @idDocumentNo, @frequentFlyerNo, @notes, @now, @now)`)
          .run({ ...p, id: newId, bookingId, seq, now });
        this.deps.audit.append(actorOf(actor), { action: 'booking.passenger_added', entityType: 'booking', entityId: bookingId, after: auditPassenger(p) });
      } else {
        const before = this.deps.db.prepare('SELECT * FROM booking_passenger WHERE id = ? AND booking_id = ?').get(passengerId, bookingId) as PassengerRow | undefined;
        if (!before) throw new DomainError(ErrorCode.NOT_FOUND, 'Passenger not found');
        // Without identity permission the (masked) identity fields sent back are ignored, never written.
        const canIdentity = hasAny(actor, 'customer.view_identity');
        const merged = canIdentity ? p : { ...p, passportNo: before.passport_no, idDocumentNo: before.id_document_no, dateOfBirth: before.date_of_birth, passportExpiry: before.passport_expiry };
        if (!isPreIssue(b.status) && (merged.givenName !== before.given_name || merged.surname !== before.surname || merged.paxType !== before.pax_type)) {
          throw new DomainError(ErrorCode.CONFLICT, 'A ticketed passenger name cannot be changed; reissue the ticket instead', { reason: 'NAME_CHANGE_AFTER_ISSUE' });
        }
        this.deps.db
          .prepare(`UPDATE booking_passenger SET pax_type=@paxType, title=@title, given_name=@givenName, surname=@surname, name_ar=@nameAr, gender=@gender,
                      date_of_birth=@dateOfBirth, passport_no=@passportNo, passport_expiry=@passportExpiry, nationality=@nationality, mobile=@mobile,
                      id_document_type=@idDocumentType, id_document_no=@idDocumentNo, frequent_flyer_no=@frequentFlyerNo, notes=@notes, updated_at=@now,
                      row_version=row_version+1 WHERE id=@id`)
          .run({ ...merged, id: passengerId, now });
        this.deps.audit.append(actorOf(actor), {
          action: 'booking.passenger_updated', entityType: 'booking', entityId: bookingId,
          before: auditPassenger(rowToPassenger(before)), after: auditPassenger(merged), metadata: { passengerId },
        });
      }
      this.touch(actor, bookingId);
    });
    return this.get(actor, bookingId);
  }

  removePassenger(actor: Actor, bookingId: string, passengerId: string): BookingDto {
    requirePermission(this.deps, actor, 'booking.edit', 'bookings.removePassenger');
    tx(this.deps, () => {
      const b = this.accessible(actor, bookingId);
      assertPreIssue(b.status, 'Removing a passenger');
      const p = this.deps.db.prepare('SELECT * FROM booking_passenger WHERE id = ? AND booking_id = ?').get(passengerId, bookingId) as PassengerRow | undefined;
      if (!p) throw new DomainError(ErrorCode.NOT_FOUND, 'Passenger not found');
      if (this.deps.db.prepare('SELECT 1 FROM fin_document_line WHERE passenger_id = ?').get(passengerId)) {
        throw new DomainError(ErrorCode.CONFLICT, 'This passenger has financial history', { reason: 'HAS_HISTORY' });
      }
      this.deps.db.prepare('DELETE FROM booking_price_item WHERE passenger_id = ?').run(passengerId);
      this.deps.db.prepare('DELETE FROM booking_passenger WHERE id = ?').run(passengerId);
      this.deps.audit.append(actorOf(actor), { action: 'booking.passenger_removed', entityType: 'booking', entityId: bookingId, before: auditPassenger(rowToPassenger(p)) });
      this.touch(actor, bookingId);
    });
    return this.get(actor, bookingId);
  }

  // ── Segments (and schedule changes after issue) ─────────────────────────
  saveSegment(actor: Actor, bookingId: string, segmentId: string | null, input: SegmentInput, opts: { reason?: string | null; source?: 'MANUAL' | 'AIRLINE_NOTICE' } = {}): BookingDto {
    requirePermission(this.deps, actor, 'booking.edit', 'bookings.saveSegment');
    const s = normalizeSegment(input);
    const b0 = this.accessible(actor, bookingId);
    if (!isPreIssue(b0.status)) requirePermission(this.deps, actor, 'schedule.change', 'schedule.change');
    tx(this.deps, () => {
      const b = this.accessible(actor, bookingId);
      this.assertRef('airline', s.airlineId, 'airlineId');
      if (s.operatingAirlineId) this.assertRef('airline', s.operatingAirlineId, 'operatingAirlineId');
      this.reference.assertAirport(s.origin, 'origin');
      this.reference.assertAirport(s.destination, 'destination');
      const now = this.deps.clock.now().toISOString();
      const values = {
        airlineId: s.airlineId, operatingAirlineId: s.operatingAirlineId, flightNumber: s.flightNumber, origin: s.origin, destination: s.destination,
        departureDate: s.departureDate, departureTime: s.departureTime, arrivalDate: s.arrivalDate, arrivalTime: s.arrivalTime, cabinClass: s.cabinClass,
        bookingClass: s.bookingClass, departureTerminal: s.departureTerminal, arrivalTerminal: s.arrivalTerminal, baggage: s.baggage, seat: s.seat,
        airlineLocator: s.airlineLocator, status: s.status, notes: s.notes, now,
      };
      if (!segmentId) {
        assertPreIssue(b.status, 'Adding a segment');
        const seq = (this.deps.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM flight_segment WHERE booking_id = ?').get(bookingId) as { n: number }).n;
        const newId = this.deps.newId();
        this.deps.db
          .prepare(`INSERT INTO flight_segment (id, booking_id, seq, marketing_airline_id, operating_airline_id, flight_number, origin_iata, destination_iata,
                      departure_date, departure_time, arrival_date, arrival_time, departure_terminal, arrival_terminal, cabin_class, booking_class,
                      airline_locator, status, baggage, seat, notes, created_at, updated_at)
                    VALUES (@id, @bookingId, @seq, @airlineId, @operatingAirlineId, @flightNumber, @origin, @destination, @departureDate, @departureTime,
                      @arrivalDate, @arrivalTime, @departureTerminal, @arrivalTerminal, @cabinClass, @bookingClass, @airlineLocator, @status, @baggage, @seat,
                      @notes, @now, @now)`)
          .run({ ...values, id: newId, bookingId, seq });
        if (!b.airline_id) this.deps.db.prepare('UPDATE booking SET airline_id = ? WHERE id = ?').run(s.airlineId, bookingId);
        this.deps.audit.append(actorOf(actor), { action: 'booking.segment_added', entityType: 'booking', entityId: bookingId, after: s });
      } else {
        const before = this.deps.db.prepare('SELECT * FROM flight_segment WHERE id = ? AND booking_id = ?').get(segmentId, bookingId) as SegmentRow | undefined;
        if (!before) throw new DomainError(ErrorCode.NOT_FOUND, 'Segment not found');
        const beforeSnap = snapshot(before);
        const afterSnap: SegmentSnapshot = {
          departure_date: s.departureDate, departure_time: s.departureTime, arrival_date: s.arrivalDate, arrival_time: s.arrivalTime,
          flight_number: s.flightNumber, origin_iata: s.origin, destination_iata: s.destination, marketing_airline_id: s.airlineId,
          operating_airline_id: s.operatingAirlineId, departure_terminal: s.departureTerminal, arrival_terminal: s.arrivalTerminal,
          cabin_class: s.cabinClass, status: s.status,
        };
        const diffs = diffSegment(beforeSnap, afterSnap);
        const tracked = !isPreIssue(b.status) && diffs.length > 0;
        this.deps.db
          .prepare(`UPDATE flight_segment SET marketing_airline_id=@airlineId, operating_airline_id=@operatingAirlineId, flight_number=@flightNumber,
                      origin_iata=@origin, destination_iata=@destination, departure_date=@departureDate, departure_time=@departureTime,
                      arrival_date=@arrivalDate, arrival_time=@arrivalTime, departure_terminal=@departureTerminal, arrival_terminal=@arrivalTerminal,
                      cabin_class=@cabinClass, booking_class=@bookingClass, airline_locator=@airlineLocator, status=@status, baggage=@baggage, seat=@seat,
                      notes=@notes, version = version + ${tracked ? 1 : 0}, updated_at=@now, row_version=row_version+1 WHERE id=@id`)
          .run({ ...values, id: segmentId });
        if (tracked) {
          const changeId = this.deps.newId();
          const severity = changeSeverity(diffs, beforeSnap, afterSnap, readSetting(this.deps.db, 'schedule.major_threshold_minutes'));
          this.deps.db
            .prepare(`INSERT INTO schedule_change (id, booking_id, segment_id, segment_version_before, segment_version_after, source, severity, before_json,
                        after_json, changed_at, changed_by, confirmation_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(changeId, bookingId, segmentId, before.version, before.version + 1, opts.source ?? 'MANUAL', severity, JSON.stringify(beforeSnap),
              JSON.stringify(afterSnap), now, actor.userId, optionalText(opts.reason, 'reason', 500));
          const insField = this.deps.db.prepare('INSERT INTO schedule_change_field (change_id, field_name, old_value, new_value) VALUES (?, ?, ?, ?)');
          for (const d of diffs) insField.run(changeId, d.field, d.oldValue, d.newValue);
          // BR-SCH-04: a newer change supersedes older unresolved ones on the same segment (history kept).
          this.deps.db
            .prepare(`UPDATE schedule_change SET superseded_by_id = ?, row_version = row_version + 1
                      WHERE segment_id = ? AND id <> ? AND superseded_by_id IS NULL AND notification_status IN ('NOT_NOTIFIED','NOTIFICATION_FAILED')`)
            .run(changeId, segmentId, changeId);
          this.deps.audit.append(actorOf(actor), {
            action: 'schedule.changed', entityType: 'schedule_change', entityId: changeId,
            before: beforeSnap, after: afterSnap, metadata: { bookingId, segmentId, severity, fields: diffs.map((d) => d.field), reason: opts.reason ?? null },
          });
        } else {
          this.deps.audit.append(actorOf(actor), { action: 'booking.segment_updated', entityType: 'booking', entityId: bookingId, before: beforeSnap, after: afterSnap, metadata: { segmentId } });
        }
      }
      this.touch(actor, bookingId);
    });
    return this.get(actor, bookingId);
  }

  removeSegment(actor: Actor, bookingId: string, segmentId: string): BookingDto {
    requirePermission(this.deps, actor, 'booking.edit', 'bookings.removeSegment');
    tx(this.deps, () => {
      const b = this.accessible(actor, bookingId);
      assertPreIssue(b.status, 'Removing a segment');
      const s = this.deps.db.prepare('SELECT * FROM flight_segment WHERE id = ? AND booking_id = ?').get(segmentId, bookingId) as SegmentRow | undefined;
      if (!s) throw new DomainError(ErrorCode.NOT_FOUND, 'Segment not found');
      this.deps.db.prepare('DELETE FROM flight_segment WHERE id = ?').run(segmentId);
      this.deps.audit.append(actorOf(actor), { action: 'booking.segment_removed', entityType: 'booking', entityId: bookingId, before: snapshot(s) });
      this.touch(actor, bookingId);
    });
    return this.get(actor, bookingId);
  }

  // ── Pricing ─────────────────────────────────────────────────────────────
  savePriceItem(actor: Actor, bookingId: string, itemId: string | null, input: PriceItemInput): BookingDto {
    requirePermission(this.deps, actor, 'booking.edit', 'bookings.savePriceItem');
    const touchesCost = input.costMinor !== undefined || input.costCurrency !== undefined;
    if (touchesCost) requirePermission(this.deps, actor, 'booking.enter_cost', 'bookings.enterCost');
    tx(this.deps, () => {
      const b = this.accessible(actor, bookingId);
      assertPreIssue(b.status, 'Changing prices');
      const pax = this.deps.db.prepare('SELECT id FROM booking_passenger WHERE id = ? AND booking_id = ?').get(input.passengerId, bookingId);
      if (!pax) throw fieldError('passengerId', 'NOT_FOUND', 'Passenger not found');
      if (input.supplierId) this.assertRef('supplier', input.supplierId, 'supplierId');
      if (input.validatingAirlineId) this.assertRef('airline', input.validatingAirlineId, 'validatingAirlineId');
      const before = itemId ? (this.deps.db.prepare('SELECT * FROM booking_price_item WHERE id = ? AND booking_id = ?').get(itemId, bookingId) as ItemRow | undefined) : undefined;
      if (itemId && !before) throw new DomainError(ErrorCode.NOT_FOUND, 'Price item not found');
      const clash = this.deps.db.prepare('SELECT id FROM booking_price_item WHERE booking_id = ? AND passenger_id = ? AND id <> ?').get(bookingId, input.passengerId, itemId ?? '');
      if (clash) throw fieldError('passengerId', 'ALREADY_PRICED', 'This passenger already has a price');
      const airlineId = input.validatingAirlineId ?? b.airline_id;
      const prefix = airlineId ? (this.deps.db.prepare('SELECT ticket_prefix FROM airline WHERE id = ?').get(airlineId) as { ticket_prefix: string | null } | undefined)?.ticket_prefix : null;
      const ticketNumber = normalizeTicketNumber(input.ticketNumber, prefix);
      if (ticketNumber && this.deps.db.prepare('SELECT 1 FROM ticket WHERE ticket_number = ?').get(ticketNumber)) {
        throw fieldError('ticketNumber', 'DUPLICATE_TICKET', 'This ticket number already exists');
      }
      const v = {
        fareMinor: input.fareMinor, taxesMinor: input.taxesMinor ?? 0, serviceFeeMinor: input.serviceFeeMinor ?? 0, discountMinor: input.discountMinor ?? 0,
        costMinor: touchesCost ? (input.costMinor ?? null) : (before?.cost_minor ?? null),
        costCurrency: touchesCost ? (input.costCurrency ?? null) : (before?.cost_currency_code ?? null),
      };
      assertPriceAmounts(v);
      if (v.costMinor !== null && !v.costCurrency) throw fieldError('costCurrency', 'REQUIRED', 'Cost currency is required');
      if (v.costCurrency) this.currencies.minorUnitOf(v.costCurrency);
      const supplierRef = hasAny(actor, 'booking.view_cost') || !before ? optionalText(input.supplierReference, 'supplierReference', 60) : before.supplier_reference;
      const now = this.deps.clock.now().toISOString();
      const row = {
        passengerId: input.passengerId, supplierId: input.supplierId ?? b.default_supplier_id, airlineId: input.validatingAirlineId ?? null, ticketNumber,
        ...v, supplierRef, notes: optionalText(input.notes, 'notes', 500), now, userId: actor.userId,
      };
      if (!before) {
        const seq = (this.deps.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM booking_price_item WHERE booking_id = ?').get(bookingId) as { n: number }).n;
        this.deps.db
          .prepare(`INSERT INTO booking_price_item (id, booking_id, seq, passenger_id, supplier_id, validating_airline_id, ticket_number, fare_minor, taxes_minor,
                      service_fee_minor, discount_minor, cost_currency_code, cost_minor, supplier_reference, notes, created_at, created_by, updated_at, updated_by)
                    VALUES (@id, @bookingId, @seq, @passengerId, @supplierId, @airlineId, @ticketNumber, @fareMinor, @taxesMinor, @serviceFeeMinor, @discountMinor,
                      @costCurrency, @costMinor, @supplierRef, @notes, @now, @userId, @now, @userId)`)
          .run({ ...row, id: this.deps.newId(), bookingId, seq });
      } else {
        this.deps.db
          .prepare(`UPDATE booking_price_item SET passenger_id=@passengerId, supplier_id=@supplierId, validating_airline_id=@airlineId, ticket_number=@ticketNumber,
                      fare_minor=@fareMinor, taxes_minor=@taxesMinor, service_fee_minor=@serviceFeeMinor, discount_minor=@discountMinor,
                      cost_currency_code=@costCurrency, cost_minor=@costMinor, supplier_reference=@supplierRef, notes=@notes, updated_at=@now, updated_by=@userId,
                      row_version=row_version+1 WHERE id=@id`)
          .run({ ...row, id: itemId });
      }
      // Cost is recorded in the audit trail, but only readable there by audit.view holders (not agents).
      this.deps.audit.append(actorOf(actor), {
        action: before ? 'booking.price_updated' : 'booking.price_added', entityType: 'booking', entityId: bookingId,
        before: before ? { fareMinor: before.fare_minor, taxesMinor: before.taxes_minor, serviceFeeMinor: before.service_fee_minor, discountMinor: before.discount_minor, costMinor: before.cost_minor, costCurrency: before.cost_currency_code } : undefined,
        after: { passengerId: row.passengerId, supplierId: row.supplierId, ...v }, metadata: { itemId },
      });
      this.touch(actor, bookingId);
    });
    return this.get(actor, bookingId);
  }

  removePriceItem(actor: Actor, bookingId: string, itemId: string): BookingDto {
    requirePermission(this.deps, actor, 'booking.edit', 'bookings.removePriceItem');
    tx(this.deps, () => {
      const b = this.accessible(actor, bookingId);
      assertPreIssue(b.status, 'Changing prices');
      const r = this.deps.db.prepare('DELETE FROM booking_price_item WHERE id = ? AND booking_id = ?').run(itemId, bookingId);
      if (r.changes === 0) throw new DomainError(ErrorCode.NOT_FOUND, 'Price item not found');
      this.deps.audit.append(actorOf(actor), { action: 'booking.price_removed', entityType: 'booking', entityId: bookingId, metadata: { itemId } });
      this.touch(actor, bookingId);
    });
    return this.get(actor, bookingId);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────
  reserve(actor: Actor, id: string, rowVersion: number, ticketingDeadlineAt?: string | null): BookingDto {
    requirePermission(this.deps, actor, 'booking.reserve', 'bookings.reserve');
    tx(this.deps, () => {
      const b = this.accessible(actor, id);
      this.assertVersion(b, rowVersion);
      const to = bookingTransition(b.status, 'RESERVE');
      const pax = (this.deps.db.prepare(`SELECT COUNT(*) AS n FROM booking_passenger WHERE booking_id = ?`).get(id) as { n: number }).n;
      const segs = (this.deps.db.prepare(`SELECT COUNT(*) AS n FROM flight_segment WHERE booking_id = ? AND status <> 'CANCELLED'`).get(id) as { n: number }).n;
      if (!pax) throw new DomainError(ErrorCode.VALIDATION, 'Add at least one passenger', { reason: 'NO_PASSENGERS' });
      if (!segs) throw new DomainError(ErrorCode.VALIDATION, 'Add at least one flight segment', { reason: 'NO_SEGMENTS' });
      this.setStatus(actor, b, to, null, { ticketing_deadline_at: optionalText(ticketingDeadlineAt, 'ticketingDeadlineAt', 30) ?? b.ticketing_deadline_at });
    });
    return this.get(actor, id);
  }

  release(actor: Actor, id: string, rowVersion: number): BookingDto {
    requirePermission(this.deps, actor, 'booking.reserve', 'bookings.release');
    tx(this.deps, () => {
      const b = this.accessible(actor, id);
      this.assertVersion(b, rowVersion);
      this.setStatus(actor, b, bookingTransition(b.status, 'RELEASE'), null);
    });
    return this.get(actor, id);
  }

  discard(actor: Actor, id: string, rowVersion: number, reason: string): BookingDto {
    requirePermission(this.deps, actor, 'booking.discard', 'bookings.discard');
    tx(this.deps, () => {
      const b = this.accessible(actor, id);
      this.assertVersion(b, rowVersion);
      const to = bookingTransition(b.status, 'DISCARD');
      // BR-PAY-04: deposits must be refunded or moved on-account first.
      if (this.customerPositions(id).some((p) => p.balanceMinor !== 0)) {
        throw new DomainError(ErrorCode.CONFLICT, 'Refund or move the customer deposit before discarding', { reason: 'OPEN_BALANCE' });
      }
      this.setStatus(actor, b, to, requiredText(reason, 'reason', 500));
    });
    return this.get(actor, id);
  }

  /**
   * Records that the ticket(s) were issued EXTERNALLY and books the money side
   * (BR-BKG-01/02): creates one ticket record per priced passenger and posts
   * the customer invoice, an optional discount credit note and one supplier
   * bill per (supplier, currency) — all in ONE transaction with the status change.
   */
  issue(actor: Actor, id: string, input: { rowVersion: number; issueDate?: string | null; saleExchangeRate?: string | null; costExchangeRates?: Record<string, string> | null }): BookingDto {
    requirePermission(this.deps, actor, 'booking.issue', 'bookings.issue');
    const date = input.issueDate ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    const overrides = { ...(input.costExchangeRates ?? {}), ...(input.saleExchangeRate ? { __sale: input.saleExchangeRate } : {}) };
    if (Object.keys(overrides).length) requirePermission(this.deps, actor, 'finance.override_rate', 'bookings.issue.overrideRate');
    tx(this.deps, () => {
      const b = this.accessible(actor, id);
      this.assertVersion(b, input.rowVersion);
      const to = bookingTransition(b.status, 'ISSUE');
      const db = this.deps.db;
      const core = this.company.core();
      const rateCache = new Map<string, string>();
      const rateFor = (currency: string, override?: string | null): string => {
        if (currency === core.baseCurrency) return '1';
        if (override) return parseRate(override);
        const cached = rateCache.get(currency);
        if (cached) return cached;
        const r = this.currencies.rateOn(currency, date);
        if (!r) throw new DomainError(ErrorCode.RATE_REQUIRED, `Enter an exchange rate for ${currency} on ${date} first`, { currency, date });
        rateCache.set(currency, r);
        return r;
      };
      const saleRate = rateFor(b.sale_currency_code, input.saleExchangeRate);
      const baseUnit = this.currencies.minorUnitOf(core.baseCurrency);
      const toBase = (cur: string, minor: number): number | null => {
        try {
          const rate = cur === b.sale_currency_code ? saleRate : rateFor(cur, input.costExchangeRates?.[cur]);
          return convertMinor(minor, this.currencies.minorUnitOf(cur), rate, baseUnit);
        } catch {
          return null;
        }
      };
      const passengers = db.prepare(`SELECT id FROM booking_passenger WHERE booking_id = ? AND status = 'ACTIVE' ORDER BY seq`).all(id) as { id: string }[];
      const segments = db.prepare(`SELECT id, marketing_airline_id FROM flight_segment WHERE booking_id = ? AND status <> 'CANCELLED' ORDER BY seq`).all(id) as { id: string; marketing_airline_id: string }[];
      const items = db.prepare('SELECT * FROM booking_price_item WHERE booking_id = ? ORDER BY seq').all(id) as ItemRow[];
      assertIssuable({
        hasCustomer: true, activePassengerIds: passengers.map((p) => p.id), activeSegmentCount: segments.length, items: items.map(toItem),
        canZeroPrice: hasAny(actor, 'booking.zero_price'), canSellBelowCost: hasAny(actor, 'booking.sell_below_cost'), toBase,
        saleCurrency: b.sale_currency_code,
      });
      const now = this.deps.clock.now().toISOString();
      const issued: (PriceItem & { ticketId: string })[] = [];
      const insTicket = db.prepare(`INSERT INTO ticket (id, booking_id, passenger_id, ticket_number, validating_airline_id, supplier_id, status, issue_date, created_at, updated_at)
                                    VALUES (?, ?, ?, ?, ?, ?, 'ISSUED', ?, ?, ?)`);
      const insTs = db.prepare('INSERT INTO ticket_segment (ticket_id, segment_id) VALUES (?, ?)');
      for (const i of items) {
        const ticketId = this.deps.newId();
        if (i.ticket_number && db.prepare('SELECT 1 FROM ticket WHERE ticket_number = ?').get(i.ticket_number)) {
          throw fieldError('ticketNumber', 'DUPLICATE_TICKET', `Ticket ${i.ticket_number} already exists`);
        }
        insTicket.run(ticketId, id, i.passenger_id, i.ticket_number, i.validating_airline_id ?? b.airline_id ?? segments[0]!.marketing_airline_id, i.supplier_id, date, now, now);
        for (const s of segments) insTs.run(ticketId, s.id);
        db.prepare('UPDATE booking_price_item SET ticket_id = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(ticketId, now, i.id);
        issued.push({ ...toItem(i), ticketId });
      }
      const plan = planIssue(id, issued);
      const docs: string[] = [];
      const base = { docDate: date, customerId: b.customer_id, bookingId: id };
      if (plan.invoiceLines.length) {
        docs.push(this.posting.post(actor, { ...base, docType: 'CUSTOMER_INVOICE', currency: b.sale_currency_code, exchangeRate: saleRate, lines: plan.invoiceLines, description: `${b.booking_no}` }).docNo);
      }
      if (plan.discountLines.length) {
        docs.push(this.posting.post(actor, { ...base, docType: 'CUSTOMER_CREDIT_NOTE', currency: b.sale_currency_code, exchangeRate: saleRate, lines: plan.discountLines, reasonCode: 'DISCOUNT', description: `${b.booking_no}` }).docNo);
      }
      for (const bill of plan.bills) {
        const refs = [...new Set(items.filter((i) => i.supplier_id === bill.supplierId && i.supplier_reference).map((i) => i.supplier_reference))].join(', ');
        const posted = this.posting.post(actor, {
          docType: 'SUPPLIER_BILL', docDate: date, supplierId: bill.supplierId, bookingId: id, currency: bill.currency,
          exchangeRate: rateFor(bill.currency, input.costExchangeRates?.[bill.currency]), lines: bill.lines, description: `${b.booking_no}`,
        });
        if (refs) db.prepare('UPDATE fin_document SET external_reference = ? WHERE id = ? AND external_reference IS NULL').run(refs, posted.id);
        docs.push(posted.docNo);
      }
      const terms = (db.prepare('SELECT payment_terms_days FROM customer WHERE id = ?').get(b.customer_id) as { payment_terms_days: number }).payment_terms_days;
      this.setStatus(actor, b, to, null, { issue_date: date, due_date: addDays(date, terms), sale_exchange_rate: saleRate });
      this.deps.audit.append(actorOf(actor), {
        action: 'booking.issued', entityType: 'booking', entityId: id,
        metadata: { issueDate: date, tickets: issued.length, documents: docs },
      });
      this.reindex(id);
    });
    return this.get(actor, id);
  }

  setTicketNumber(actor: Actor, bookingId: string, ticketId: string, ticketNumber: string): BookingDto {
    requirePermission(this.deps, actor, ['booking.issue', 'booking.edit'], 'bookings.setTicketNumber');
    tx(this.deps, () => {
      this.accessible(actor, bookingId);
      const t = this.deps.db.prepare('SELECT t.*, a.ticket_prefix FROM ticket t LEFT JOIN airline a ON a.id = t.validating_airline_id WHERE t.id = ? AND t.booking_id = ?').get(ticketId, bookingId) as
        { ticket_number: string | null; ticket_prefix: string | null } | undefined;
      if (!t) throw new DomainError(ErrorCode.NOT_FOUND, 'Ticket not found');
      if (t.ticket_number) throw new DomainError(ErrorCode.CONFLICT, 'The ticket number is already recorded', { reason: 'TICKET_NUMBER_SET' });
      const n = normalizeTicketNumber(ticketNumber, t.ticket_prefix);
      if (!n) throw fieldError('ticketNumber', 'REQUIRED', 'Ticket number is required');
      if (this.deps.db.prepare('SELECT 1 FROM ticket WHERE ticket_number = ?').get(n)) throw fieldError('ticketNumber', 'DUPLICATE_TICKET', 'This ticket number already exists');
      this.deps.db.prepare('UPDATE ticket SET ticket_number = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(n, this.deps.clock.now().toISOString(), ticketId);
      this.deps.db.prepare('UPDATE booking_price_item SET ticket_number = ? WHERE ticket_id = ?').run(n, ticketId);
      this.deps.audit.append(actorOf(actor), { action: 'ticket.number_recorded', entityType: 'ticket', entityId: ticketId, after: { ticketNumber: n }, metadata: { bookingId } });
      this.reindex(bookingId);
    });
    return this.get(actor, bookingId);
  }

  /**
   * Price change after issue (BR-BKG-04): an extra invoice or a credit note for
   * the difference, with a reason — never an edit of the original document.
   */
  adjustSale(actor: Actor, bookingId: string, input: { ticketId?: string | null; kind: 'INCREASE' | 'DECREASE'; lineType?: 'FARE' | 'TAXES' | 'SERVICE_FEE' | 'CHANGE_FEE' | null; amountMinor: number; reason: string; date?: string | null }): BookingDto {
    requirePermission(this.deps, actor, 'booking.adjust_price', 'bookings.adjustSale');
    const date = input.date ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    tx(this.deps, () => {
      const b = this.accessible(actor, bookingId);
      if (b.status !== 'ISSUED' && b.status !== 'PARTIALLY_CANCELLED') throw new DomainError(ErrorCode.CONFLICT, 'Only issued bookings can be adjusted', { reason: 'NOT_ISSUED' });
      const t = input.ticketId ? this.ticketRow(bookingId, input.ticketId) : null;
      const reason = requiredText(input.reason, 'reason', 500);
      const line: DocumentLineDraft = {
        lineType: input.kind === 'INCREASE' ? (input.lineType ?? 'FARE') : 'DISCOUNT', amountMinor: input.amountMinor, bookingId,
        passengerId: t?.passenger_id ?? null, ticketId: t?.id ?? null, description: reason,
      };
      if (input.kind === 'DECREASE') {
        const net = this.netSale(bookingId, t?.id ?? null);
        if (input.amountMinor > net) throw new DomainError(ErrorCode.VALIDATION, 'The reduction exceeds the net sale', { reason: 'OVER_ALLOCATION', netMinor: net });
      }
      const rate = this.rateForDoc(b.sale_currency_code, date, b.sale_exchange_rate);
      const doc = this.posting.post(actor, {
        docType: input.kind === 'INCREASE' ? 'CUSTOMER_INVOICE' : 'CUSTOMER_CREDIT_NOTE', docDate: date, customerId: b.customer_id, bookingId,
        currency: b.sale_currency_code, exchangeRate: rate, reasonCode: 'PRICE_ADJUSTMENT', description: reason, lines: [line],
      });
      this.deps.audit.append(actorOf(actor), { action: 'booking.sale_adjusted', entityType: 'booking', entityId: bookingId, metadata: { kind: input.kind, amountMinor: input.amountMinor, document: doc.docNo, reason } });
      this.touch(actor, bookingId);
    });
    return this.get(actor, bookingId);
  }

  /** Cost change after issue: extra supplier bill (cost or penalty) or supplier credit note. */
  adjustCost(actor: Actor, bookingId: string, input: { ticketId: string; kind: 'INCREASE' | 'DECREASE'; lineType?: 'PURCHASE_COST' | 'SUPPLIER_PENALTY' | null; amountMinor: number; reason: string; date?: string | null; externalReference?: string | null }): BookingDto {
    requirePermission(this.deps, actor, 'booking.adjust_price', 'bookings.adjustCost');
    requirePermission(this.deps, actor, 'booking.enter_cost', 'bookings.adjustCost');
    const date = input.date ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    tx(this.deps, () => {
      const b = this.accessible(actor, bookingId);
      if (b.status !== 'ISSUED' && b.status !== 'PARTIALLY_CANCELLED') throw new DomainError(ErrorCode.CONFLICT, 'Only issued bookings can be adjusted', { reason: 'NOT_ISSUED' });
      const t = this.ticketRow(bookingId, input.ticketId);
      const reason = requiredText(input.reason, 'reason', 500);
      const cur = this.costCurrency(t.id) ?? this.company.core().baseCurrency;
      if (input.kind === 'DECREASE' && input.amountMinor > this.netCost(t.id, t.supplier_id)) {
        throw new DomainError(ErrorCode.VALIDATION, 'The reduction exceeds the net cost', { reason: 'OVER_ALLOCATION' });
      }
      const doc = this.posting.post(actor, {
        docType: input.kind === 'INCREASE' ? 'SUPPLIER_BILL' : 'SUPPLIER_CREDIT_NOTE', docDate: date, supplierId: t.supplier_id, bookingId, currency: cur,
        exchangeRate: this.rateForDoc(cur, date, null), reasonCode: 'COST_ADJUSTMENT', description: reason,
        lines: [{ lineType: input.kind === 'INCREASE' ? (input.lineType ?? 'PURCHASE_COST') : 'PURCHASE_RETURN', amountMinor: input.amountMinor, bookingId, passengerId: t.passenger_id, ticketId: t.id, description: reason }],
      });
      if (input.externalReference) this.deps.db.prepare('UPDATE fin_document SET external_reference = ? WHERE id = ? AND external_reference IS NULL').run(optionalText(input.externalReference, 'externalReference', 60), doc.id);
      this.deps.audit.append(actorOf(actor), { action: 'booking.cost_adjusted', entityType: 'booking', entityId: bookingId, metadata: { kind: input.kind, document: doc.docNo, reason } });
      this.touch(actor, bookingId);
    });
    return this.get(actor, bookingId);
  }

  /**
   * BR-BKG-03: moving a ticket to another supplier credits the old supplier for
   * the ticket's net cost and bills the new one. Payments made to the old
   * supplier stay with it (its balance becomes a credit to recover or use).
   */
  changeSupplier(actor: Actor, bookingId: string, input: { ticketId: string; newSupplierId: string; costMinor: number; costCurrency: string; reason: string; date?: string | null }): BookingDto {
    requirePermission(this.deps, actor, 'booking.change_supplier', 'bookings.changeSupplier');
    requirePermission(this.deps, actor, 'booking.enter_cost', 'bookings.changeSupplier');
    const date = input.date ?? this.company.today();
    this.posting.assertBackdateAllowed(actor, date);
    tx(this.deps, () => {
      const b = this.accessible(actor, bookingId);
      if (b.status !== 'ISSUED' && b.status !== 'PARTIALLY_CANCELLED') throw new DomainError(ErrorCode.CONFLICT, 'Only issued bookings can change supplier', { reason: 'NOT_ISSUED' });
      const t = this.ticketRow(bookingId, input.ticketId);
      if (t.supplier_id === input.newSupplierId) throw fieldError('newSupplierId', 'SAME_SUPPLIER', 'Choose a different supplier');
      this.assertRef('supplier', input.newSupplierId, 'newSupplierId');
      const reason = requiredText(input.reason, 'reason', 500);
      const oldCur = this.costCurrency(t.id) ?? this.company.core().baseCurrency;
      const oldNet = this.netCost(t.id, t.supplier_id);
      if (oldNet > 0) {
        this.posting.post(actor, {
          docType: 'SUPPLIER_CREDIT_NOTE', docDate: date, supplierId: t.supplier_id, bookingId, currency: oldCur, exchangeRate: this.rateForDoc(oldCur, date, null),
          reasonCode: 'SUPPLIER_CHANGE', description: reason, lines: [{ lineType: 'PURCHASE_RETURN', amountMinor: oldNet, bookingId, passengerId: t.passenger_id, ticketId: t.id }],
        });
      }
      this.currencies.minorUnitOf(input.costCurrency);
      if (input.costMinor > 0) {
        this.posting.post(actor, {
          docType: 'SUPPLIER_BILL', docDate: date, supplierId: input.newSupplierId, bookingId, currency: input.costCurrency,
          exchangeRate: this.rateForDoc(input.costCurrency, date, null), reasonCode: 'SUPPLIER_CHANGE', description: reason,
          lines: [{ lineType: 'PURCHASE_COST', amountMinor: input.costMinor, bookingId, passengerId: t.passenger_id, ticketId: t.id }],
        });
      }
      this.deps.db.prepare('UPDATE ticket SET supplier_id = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?').run(input.newSupplierId, this.deps.clock.now().toISOString(), t.id);
      this.deps.audit.append(actorOf(actor), { action: 'booking.supplier_changed', entityType: 'booking', entityId: bookingId, before: { supplierId: t.supplier_id }, after: { supplierId: input.newSupplierId }, metadata: { ticketId: t.id, reason } });
      this.touch(actor, bookingId);
    });
    return this.get(actor, bookingId);
  }

  // ── Derived financial positions ─────────────────────────────────────────
  customerPositions(bookingId: string): CustomerPositionDto[] {
    const rows = this.deps.db
      .prepare(`SELECT jl.currency_code AS cur,
                  SUM(CASE WHEN d.doc_type IN ('CUSTOMER_INVOICE','CUSTOMER_CREDIT_NOTE','OPENING_BALANCE') THEN jl.debit_minor - jl.credit_minor ELSE 0 END) AS charged,
                  SUM(CASE WHEN d.doc_type IN ('CUSTOMER_RECEIPT','CUSTOMER_REFUND','BALANCE_APPLICATION') THEN jl.credit_minor - jl.debit_minor ELSE 0 END) AS paid,
                  SUM(jl.debit_minor - jl.credit_minor) AS bal
                FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id JOIN fin_document d ON d.id = je.document_id
                WHERE jl.booking_id = ? AND jl.account_code = '1200' GROUP BY jl.currency_code ORDER BY jl.currency_code`)
      .all(bookingId) as { cur: string; charged: number; paid: number; bal: number }[];
    return rows.map((r) => ({ currency: r.cur, chargedMinor: r.charged, paidMinor: r.paid, balanceMinor: r.bal, settlement: settlementStatus(r.charged, r.bal) }));
  }

  supplierPositions(bookingId: string): SupplierPositionDto[] {
    const rows = this.deps.db
      .prepare(`SELECT jl.supplier_id AS sid, s.name, jl.currency_code AS cur,
                  SUM(CASE WHEN d.doc_type IN ('SUPPLIER_BILL','SUPPLIER_CREDIT_NOTE','OPENING_BALANCE') THEN jl.credit_minor - jl.debit_minor ELSE 0 END) AS billed,
                  SUM(CASE WHEN d.doc_type IN ('SUPPLIER_PAYMENT','SUPPLIER_REFUND','BALANCE_APPLICATION') THEN jl.debit_minor - jl.credit_minor ELSE 0 END) AS paid,
                  SUM(jl.credit_minor - jl.debit_minor) AS bal
                FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id JOIN fin_document d ON d.id = je.document_id
                JOIN supplier s ON s.id = jl.supplier_id
                WHERE jl.booking_id = ? AND jl.account_code = '2100' GROUP BY jl.supplier_id, jl.currency_code ORDER BY s.name`)
      .all(bookingId) as { sid: string; name: string; cur: string; billed: number; paid: number; bal: number }[];
    return rows.map((r) => ({ supplierId: r.sid, supplierName: r.name, currency: r.cur, billedMinor: r.billed, paidMinor: r.paid, balanceMinor: r.bal, settlement: settlementStatus(r.billed, r.bal) }));
  }

  /** Net sale (sale currency) on the booking or one ticket. */
  netSale(bookingId: string, ticketId: string | null): number {
    return (this.deps.db
      .prepare(`SELECT COALESCE(SUM(jl.credit_minor - jl.debit_minor), 0) AS v FROM journal_line jl JOIN ledger_account la ON la.code = jl.account_code
                WHERE jl.booking_id = ? AND la.account_class IN ('REVENUE','CONTRA_REVENUE') AND jl.account_code <> '4210' AND (? IS NULL OR jl.ticket_id = ?)`)
      .get(bookingId, ticketId, ticketId) as { v: number }).v;
  }

  /** Net ticket cost (supplier currency) still carried with one supplier. */
  netCost(ticketId: string, supplierId: string): number {
    return (this.deps.db
      .prepare(`SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0) AS v FROM journal_line jl
                WHERE jl.ticket_id = ? AND jl.supplier_id = ? AND jl.account_code IN ('5100','5110')`)
      .get(ticketId, supplierId) as { v: number }).v;
  }

  costCurrency(ticketId: string): string | null {
    return (this.deps.db.prepare(`SELECT currency_code FROM journal_line WHERE ticket_id = ? AND account_code = '5100' LIMIT 1`).get(ticketId) as { currency_code: string } | undefined)?.currency_code ?? null;
  }

  rateForDoc(currency: string, date: string, fallback: string | null): string {
    const core = this.company.core();
    if (currency === core.baseCurrency) return '1';
    const r = this.currencies.rateOn(currency, date) ?? fallback;
    if (!r) throw new DomainError(ErrorCode.RATE_REQUIRED, `Enter an exchange rate for ${currency} on ${date} first`, { currency, date });
    return r;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  /** Loads a booking the caller may see; others read as NOT_FOUND (no existence leak). */
  accessible(actor: Actor, id: string): BookingRow {
    const r = this.deps.db.prepare('SELECT * FROM booking WHERE id = ?').get(id) as BookingRow | undefined;
    if (!r || (!hasAny(actor, 'booking.view_all') && r.sales_agent_id !== actor.userId && r.created_by !== actor.userId)) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Booking not found');
    }
    return r;
  }

  ticketRow(bookingId: string, ticketId: string): { id: string; passenger_id: string; supplier_id: string; status: TicketStatus; ticket_number: string | null } {
    const t = this.deps.db.prepare('SELECT id, passenger_id, supplier_id, status, ticket_number FROM ticket WHERE id = ? AND booking_id = ?').get(ticketId, bookingId) as
      { id: string; passenger_id: string; supplier_id: string; status: TicketStatus; ticket_number: string | null } | undefined;
    if (!t) throw fieldError('ticketId', 'NOT_FOUND', 'Ticket not found');
    return t;
  }

  setStatus(actor: Actor, b: BookingRow, to: BookingStatus, reason: string | null, extra: Record<string, string | null> = {}): void {
    const sets = Object.keys(extra).map((k) => `${k} = @${k}`);
    this.deps.db
      .prepare(`UPDATE booking SET status = @to, ${sets.length ? `${sets.join(', ')},` : ''} updated_at = @now, updated_by = @userId, row_version = row_version + 1 WHERE id = @id`)
      .run({ ...extra, to, now: this.deps.clock.now().toISOString(), userId: actor.userId, id: b.id });
    this.history(actor, b.id, b.status, to, reason);
    this.deps.audit.append(actorOf(actor), { action: 'booking.status_changed', entityType: 'booking', entityId: b.id, before: { status: b.status }, after: { status: to }, metadata: reason ? { reason } : undefined });
  }

  reindex(id: string): void {
    const db = this.deps.db;
    const b = db.prepare('SELECT b.*, c.full_name, c.customer_no FROM booking b JOIN customer c ON c.id = b.customer_id WHERE b.id = ?').get(id) as BookingRow & { full_name: string; customer_no: string };
    const pax = db.prepare('SELECT given_name, surname, name_ar FROM booking_passenger WHERE booking_id = ?').all(id) as { given_name: string; surname: string; name_ar: string | null }[];
    const tickets = db.prepare('SELECT ticket_number FROM ticket WHERE booking_id = ? AND ticket_number IS NOT NULL UNION SELECT ticket_number FROM booking_price_item WHERE booking_id = ? AND ticket_number IS NOT NULL').all(id, id) as { ticket_number: string }[];
    indexForSearch(db, 'booking', id, [b.booking_no, b.primary_pnr, b.full_name, b.customer_no, b.contact_name, ...pax.flatMap((p) => [`${p.given_name} ${p.surname}`, p.name_ar]), ...tickets.map((t) => t.ticket_number)], [b.contact_mobile, b.contact_whatsapp]);
  }

  private touch(actor: Actor, id: string): void {
    this.deps.db.prepare('UPDATE booking SET updated_at = ?, updated_by = ?, row_version = row_version + 1 WHERE id = ?').run(this.deps.clock.now().toISOString(), actor.userId, id);
    this.reindex(id);
  }

  private history(actor: Actor, bookingId: string, from: string | null, to: string, reason: string | null): void {
    this.deps.db
      .prepare('INSERT INTO booking_status_history (id, booking_id, from_status, to_status, changed_at, changed_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(this.deps.newId(), bookingId, from, to, this.deps.clock.now().toISOString(), actor.userId, reason);
  }

  private assertVersion(b: BookingRow, rowVersion: number): void {
    if (b.row_version !== rowVersion) throw new DomainError(ErrorCode.STALE_RECORD, 'The booking was changed by someone else; reload it');
  }

  private assertRef(table: 'airline' | 'supplier', id: string | null | undefined, field: string): void {
    if (!id) return;
    const r = this.deps.db.prepare(`SELECT is_active FROM ${table} WHERE id = ?`).get(id) as { is_active: number } | undefined;
    if (!r) throw fieldError(field, 'NOT_FOUND', `${table} not found`);
    if (r.is_active !== 1) throw fieldError(field, 'ARCHIVED_READ_ONLY', `The ${table} is archived`);
  }

  private tickets(bookingId: string, viewCost: boolean, saleCurrency: string, paxName: Map<string, string>): TicketDto[] {
    const rows = this.deps.db
      .prepare(`SELECT t.*, s.name AS supplier_name, a.name_en AS airline_name FROM ticket t JOIN supplier s ON s.id = t.supplier_id
                LEFT JOIN airline a ON a.id = t.validating_airline_id WHERE t.booking_id = ? ORDER BY t.created_at, t.id`)
      .all(bookingId) as { id: string; ticket_number: string | null; passenger_id: string; supplier_id: string; supplier_name: string; validating_airline_id: string | null; airline_name: string | null; status: TicketDto['status']; issue_date: string; notes: string | null; row_version: number }[];
    const sale = this.deps.db.prepare(`SELECT COALESCE(SUM(jl.credit_minor - jl.debit_minor), 0) AS v FROM journal_line jl JOIN ledger_account la ON la.code = jl.account_code
                                       WHERE jl.ticket_id = ? AND la.account_class IN ('REVENUE','CONTRA_REVENUE') AND jl.account_code <> '4210'`);
    const cost = this.deps.db.prepare(`SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0) AS v, MAX(jl.currency_code) AS cur FROM journal_line jl
                                       WHERE jl.ticket_id = ? AND jl.account_code IN ('5100','5110','5200')`);
    return rows.map((t) => {
      const c = viewCost ? (cost.get(t.id) as { v: number; cur: string | null }) : null;
      return {
        id: t.id, ticketNumber: t.ticket_number, passengerId: t.passenger_id, passengerName: paxName.get(t.passenger_id) ?? '', supplierId: t.supplier_id,
        supplierName: t.supplier_name, validatingAirlineId: t.validating_airline_id, airlineName: t.airline_name, status: t.status, issueDate: t.issue_date,
        notes: t.notes, saleMinor: (sale.get(t.id) as { v: number }).v, saleCurrency, costMinor: c ? c.v : null, costCurrency: c ? c.cur : null, rowVersion: t.row_version,
      };
    });
  }

  private estimateProfit(b: BookingRow, items: ItemRow[]): number | null {
    const core = this.company.core();
    const date = b.issue_date ?? this.company.today();
    const toBase = (cur: string, minor: number): number | null => {
      const rate = cur === core.baseCurrency ? '1' : this.currencies.rateOn(cur, date);
      return rate ? convertMinor(minor, this.currencies.minorUnitOf(cur), rate, this.currencies.minorUnitOf(core.baseCurrency)) : null;
    };
    let total = 0;
    for (const i of items) {
      const s = toBase(b.sale_currency_code, saleTotal(toItem(i)));
      const c = i.cost_minor === null || !i.cost_currency_code ? null : toBase(i.cost_currency_code, i.cost_minor);
      if (s === null || c === null) return null;
      total += s - c;
    }
    return total;
  }

  hasAttention(bookingId: string): boolean {
    return !!this.deps.db
      .prepare(`SELECT 1 FROM schedule_change WHERE booking_id = ? AND superseded_by_id IS NULL AND notification_status IN ('NOT_NOTIFIED','NOTIFICATION_FAILED') LIMIT 1`)
      .get(bookingId);
  }

  refundStatus(bookingId: string): RefundStatusDto {
    const db = this.deps.db;
    if (db.prepare(`SELECT 1 FROM cancellation_request WHERE booking_id = ? AND overall_status = 'OPEN' LIMIT 1`).get(bookingId)) return 'PENDING';
    const t = db.prepare('SELECT status FROM ticket WHERE booking_id = ?').all(bookingId) as { status: TicketStatus }[];
    if (!t.length) return 'NONE';
    const refunded = t.filter((x) => x.status === 'REFUNDED' || x.status === 'VOIDED').length;
    const partial = t.some((x) => x.status === 'PARTIALLY_REFUNDED');
    if (refunded === t.length) return 'REFUNDED';
    if (refunded > 0 || partial) return 'PARTIALLY_REFUNDED';
    return 'NONE';
  }

  scheduleChanges(bookingId: string | null, filter: { attentionOnly?: boolean; from?: string; to?: string } = {}): ScheduleChangeDto[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (bookingId) { where.push('sc.booking_id = ?'); params.push(bookingId); }
    if (filter.attentionOnly) where.push(`sc.superseded_by_id IS NULL AND sc.notification_status IN ('NOT_NOTIFIED','NOTIFICATION_FAILED')`);
    if (filter.from) { where.push('substr(sc.changed_at, 1, 10) >= ?'); params.push(filter.from); }
    if (filter.to) { where.push('substr(sc.changed_at, 1, 10) <= ?'); params.push(filter.to); }
    const rows = this.deps.db
      .prepare(`SELECT sc.*, b.booking_no, fs.origin_iata, fs.destination_iata, fs.flight_number, a.iata_code AS airline_code, u.display_name AS by_name,
                       c.full_name AS customer_name, b.contact_mobile
                FROM schedule_change sc JOIN booking b ON b.id = sc.booking_id JOIN flight_segment fs ON fs.id = sc.segment_id
                JOIN airline a ON a.id = fs.marketing_airline_id JOIN customer c ON c.id = b.customer_id LEFT JOIN app_user u ON u.id = sc.changed_by
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sc.changed_at DESC LIMIT 500`)
      .all(...params) as {
        id: string; booking_id: string; booking_no: string; segment_id: string; severity: 'MINOR' | 'MAJOR'; changed_at: string; by_name: string | null;
        notification_status: ChangeNotificationStatus; confirmation_note: string | null; customer_response: ScheduleChangeDto['customerResponse'];
        superseded_by_id: string | null; origin_iata: string; destination_iata: string; flight_number: string; airline_code: string | null;
        customer_name: string; contact_mobile: string; row_version: number;
      }[];
    const fields = this.deps.db.prepare('SELECT field_name, old_value, new_value FROM schedule_change_field WHERE change_id = ? ORDER BY field_name');
    return rows.map((r) => ({
      id: r.id, bookingId: r.booking_id, bookingNo: r.booking_no, segmentId: r.segment_id,
      segmentLabel: `${r.airline_code ?? ''}${r.flight_number} ${r.origin_iata}→${r.destination_iata}`, severity: r.severity,
      fields: (fields.all(r.id) as { field_name: string; old_value: string | null; new_value: string | null }[]).map((f) => ({ field: f.field_name, oldValue: f.old_value, newValue: f.new_value })),
      changedAt: r.changed_at, changedBy: r.by_name, notificationStatus: r.notification_status, confirmationNote: r.confirmation_note,
      customerResponse: r.customer_response, superseded: r.superseded_by_id !== null,
      requiresAttention: requiresAttention(r.notification_status, r.superseded_by_id !== null),
      customerName: r.customer_name, contactMobile: r.contact_mobile, rowVersion: r.row_version,
    }));
  }

  cancellations(bookingId: string, paxName?: Map<string, string>): CancellationDto[] {
    const db = this.deps.db;
    const rows = db.prepare(`SELECT cr.*, b.booking_no, u.display_name AS by_name FROM cancellation_request cr JOIN booking b ON b.id = cr.booking_id
                             LEFT JOIN app_user u ON u.id = cr.requested_by WHERE cr.booking_id = ? ORDER BY cr.requested_at`).all(bookingId) as {
      id: string; request_no: string; booking_id: string; booking_no: string; cancel_type: CancellationDto['cancelType']; scope: CancellationDto['scope'];
      overall_status: CancellationDto['overallStatus']; supplier_status: CancellationDto['supplierStatus']; customer_status: CancellationDto['customerStatus'];
      expected_supplier_refund_minor: number | null; expected_currency_code: string | null; reason: string; requested_at: string; by_name: string | null;
      closed_at: string | null; notes: string | null; row_version: number;
    }[];
    const items = db.prepare(`SELECT ci.ticket_id, t.ticket_number, p.given_name || ' ' || p.surname AS n FROM cancellation_item ci JOIN ticket t ON t.id = ci.ticket_id
                              JOIN booking_passenger p ON p.id = t.passenger_id WHERE ci.cancellation_request_id = ?`);
    const docs = db.prepare('SELECT id, doc_no, doc_type, total_minor, currency_code FROM fin_document WHERE cancellation_request_id = ? ORDER BY created_at');
    return rows.map((r) => ({
      id: r.id, requestNo: r.request_no, bookingId: r.booking_id, bookingNo: r.booking_no, cancelType: r.cancel_type, scope: r.scope,
      overallStatus: r.overall_status, supplierStatus: r.supplier_status, customerStatus: r.customer_status,
      tickets: (items.all(r.id) as { ticket_id: string; ticket_number: string | null; n: string }[]).map((i) => ({ ticketId: i.ticket_id, ticketNumber: i.ticket_number, passengerName: paxName?.get(i.ticket_id) ?? i.n })),
      expectedSupplierRefund: r.expected_supplier_refund_minor !== null && r.expected_currency_code ? { currency: r.expected_currency_code, minor: r.expected_supplier_refund_minor } : null,
      reason: r.reason, requestedAt: r.requested_at, requestedBy: r.by_name, closedAt: r.closed_at, notes: r.notes,
      documents: (docs.all(r.id) as { id: string; doc_no: string; doc_type: string; total_minor: number; currency_code: string }[]).map((d) => ({ id: d.id, docNo: d.doc_no, docType: d.doc_type, totalMinor: d.total_minor, currency: d.currency_code })),
      rowVersion: r.row_version,
    }));
  }

  notifications(bookingId: string): NotificationDto[] {
    return (this.deps.db.prepare(`SELECT n.*, u.display_name AS by_name FROM notification n LEFT JOIN app_user u ON u.id = n.created_by WHERE n.booking_id = ? ORDER BY n.created_at DESC, n.rowid DESC`).all(bookingId) as {
      id: string; channel: NotificationDto['channel']; delivery_mode: NotificationDto['deliveryMode']; status: NotificationDto['status']; recipient_address: string;
      recipient_name: string | null; body: string; note: string | null; error_message: string | null; booking_id: string | null; schedule_change_id: string | null;
      created_at: string; by_name: string | null;
    }[]).map((n) => ({
      id: n.id, channel: n.channel, deliveryMode: n.delivery_mode, status: n.status, recipientAddress: n.recipient_address, recipientName: n.recipient_name,
      body: n.body, note: n.note, errorMessage: n.error_message, bookingId: n.booking_id, scheduleChangeId: n.schedule_change_id, createdAt: n.created_at, createdBy: n.by_name,
    }));
  }
}

function toItem(i: ItemRow): PriceItem {
  return {
    id: i.id, passengerId: i.passenger_id, supplierId: i.supplier_id, ticketNumber: i.ticket_number, fareMinor: i.fare_minor, taxesMinor: i.taxes_minor,
    serviceFeeMinor: i.service_fee_minor, discountMinor: i.discount_minor, costCurrency: i.cost_currency_code, costMinor: i.cost_minor,
  };
}

function snapshot(s: SegmentRow): SegmentSnapshot {
  return Object.fromEntries(SEGMENT_SNAPSHOT_COLUMNS.map((c) => [c, (s as unknown as Record<string, string | null>)[c] ?? null])) as SegmentSnapshot;
}

function routeOf(segs: { origin_iata: string; destination_iata: string }[]): string {
  const parts = [segs[0]!.origin_iata];
  for (const s of segs) {
    if (parts[parts.length - 1] !== s.origin_iata) parts.push(`/${s.origin_iata}`);
    parts.push(s.destination_iata);
  }
  return parts.join('→').replace(/→\//g, ' / ');
}

function rowToPassenger(r: PassengerRow): PassengerInput & { givenName: string; surname: string } {
  return {
    paxType: r.pax_type, title: r.title, givenName: r.given_name, surname: r.surname, nameAr: r.name_ar, gender: r.gender, dateOfBirth: r.date_of_birth,
    nationality: r.nationality, passportNo: r.passport_no, passportExpiry: r.passport_expiry, idDocumentType: r.id_document_type,
    idDocumentNo: r.id_document_no, frequentFlyerNo: r.frequent_flyer_no, mobile: r.mobile, notes: r.notes,
  };
}

/** Audit keeps passenger identity numbers masked (Phase 2 masking rule). */
function auditPassenger(p: PassengerInput): Record<string, unknown> {
  return { ...p, passportNo: maskIdentifier(p.passportNo ?? null), idDocumentNo: maskIdentifier(p.idDocumentNo ?? null), dateOfBirth: p.dateOfBirth ? p.dateOfBirth.slice(0, 4) : null };
}

function passengerDto(p: PassengerRow, viewIdentity: boolean): PassengerDto {
  return {
    id: p.id, seq: p.seq, paxType: p.pax_type, title: p.title, givenName: p.given_name, surname: p.surname, nameAr: p.name_ar, gender: p.gender,
    dateOfBirth: viewIdentity ? p.date_of_birth : null, nationality: p.nationality,
    passportNo: viewIdentity ? p.passport_no : maskIdentifier(p.passport_no), passportExpiry: p.passport_expiry, idDocumentType: p.id_document_type,
    idDocumentNo: viewIdentity ? p.id_document_no : maskIdentifier(p.id_document_no), frequentFlyerNo: p.frequent_flyer_no, mobile: p.mobile,
    notes: p.notes, status: p.status, identityMasked: !viewIdentity, rowVersion: p.row_version,
  };
}

export { isTicketClosed };
