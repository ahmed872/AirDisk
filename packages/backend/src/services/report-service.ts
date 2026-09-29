import { DomainError, ErrorCode, agingBucket, assertIsoDate, normalizeSearchText } from '@airdesk/domain';
import type { AgingRowDto, DashboardMetricsDto, ReportColumnDto, ReportDto, SearchHitDto, StatementDto, StatementLineDto } from '@airdesk/contracts';
import type { BookingService } from './booking-service';
import type { CompanyService } from './company-service';
import { hasAny, requirePermission, type Actor, type ServiceDeps } from './context';
import type { LedgerQueryService } from './ledger-query-service';
import { searchClause } from './masterdata-support';

export const REPORT_IDS = [
  'sales', 'purchases', 'profit', 'receivables', 'payables', 'supplier_volume', 'expenses', 'refunds', 'cancellations', 'flight_changes',
  'employee_activity', 'collections', 'cash_book',
] as const;
export type ReportId = (typeof REPORT_IDS)[number];

const REPORT_PERMISSION: Record<ReportId, string> = {
  sales: 'report.sales', purchases: 'report.purchases', profit: 'report.profit', receivables: 'report.receivables', payables: 'report.payables',
  supplier_volume: 'report.supplier_performance', expenses: 'report.expenses', refunds: 'report.refunds', cancellations: 'report.refunds',
  flight_changes: 'report.schedule_changes', employee_activity: 'report.employee_activity', collections: 'report.receivables',
  cash_book: 'treasury.view',
};

const col = (key: string, label: string, type: ReportColumnDto['type'] = 'text'): ReportColumnDto => ({ key, label, type });

/**
 * Every report, statement and dashboard figure is computed from the immutable
 * journal (Phase 0 §04-3/§04-8) — never from stored balances and never from
 * cash as a proxy for revenue. Money in reports is base-currency minor units
 * unless a column says otherwise.
 */
export class ReportService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly company: CompanyService,
    private readonly ledger: LedgerQueryService,
    private readonly bookings: BookingService,
  ) {}

  // ── Statements (§15/§16) ────────────────────────────────────────────────
  statement(actor: Actor, party: 'CUSTOMER' | 'SUPPLIER', partyId: string, from: string, to: string): StatementDto[] {
    requirePermission(this.deps, actor, 'report.statements', 'statements.get');
    if (party === 'SUPPLIER') requirePermission(this.deps, actor, 'supplier.view_financial', 'statements.supplier');
    assertRange(from, to);
    const db = this.deps.db;
    const p = party === 'CUSTOMER'
      ? (db.prepare('SELECT full_name AS name, customer_no AS no FROM customer WHERE id = ?').get(partyId) as { name: string; no: string } | undefined)
      : (db.prepare('SELECT name, supplier_no AS no FROM supplier WHERE id = ?').get(partyId) as { name: string; no: string } | undefined);
    if (!p) throw new DomainError(ErrorCode.NOT_FOUND, 'Not found');
    const account = party === 'CUSTOMER' ? '1200' : '2100';
    const partyCol = party === 'CUSTOMER' ? 'customer_id' : 'supplier_id';
    // Party-normal sign: customer balance = debit − credit (they owe us); supplier = credit − debit (we owe them).
    const sign = party === 'CUSTOMER' ? 1 : -1;
    const currencies = (db.prepare(`SELECT DISTINCT currency_code FROM journal_line WHERE account_code = ? AND ${partyCol} = ? ORDER BY currency_code`).all(account, partyId) as { currency_code: string }[]).map((r) => r.currency_code);
    return currencies.map((currency) => {
      const opening = sign * (db.prepare(`SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0) AS v FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
                                          WHERE jl.account_code = ? AND jl.${partyCol} = ? AND jl.currency_code = ? AND je.entry_date < ?`).get(account, partyId, currency, from) as { v: number }).v;
      const rows = db
        .prepare(`SELECT je.entry_date, d.id AS doc_id, d.doc_no, d.doc_type, d.is_reversal, d.description, b.booking_no,
                         SUM(jl.debit_minor) AS debit, SUM(jl.credit_minor) AS credit
                  FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id JOIN fin_document d ON d.id = je.document_id
                  LEFT JOIN booking b ON b.id = COALESCE(d.booking_id, jl.booking_id)
                  WHERE jl.account_code = ? AND jl.${partyCol} = ? AND jl.currency_code = ? AND je.entry_date BETWEEN ? AND ?
                  GROUP BY d.id ORDER BY je.entry_date, d.created_at, d.doc_no`)
        .all(account, partyId, currency, from, to) as { entry_date: string; doc_id: string; doc_no: string; doc_type: string; is_reversal: number; description: string | null; booking_no: string | null; debit: number; credit: number }[];
      let running = opening;
      const totals = { chargesMinor: 0, paymentsMinor: 0, refundsMinor: 0, adjustmentsMinor: 0 };
      const lines: StatementLineDto[] = rows.map((r) => {
        const effect = sign * (r.debit - r.credit);
        running += effect;
        const t = r.doc_type;
        if (r.is_reversal) totals.adjustmentsMinor += effect;
        else if (t === 'CUSTOMER_INVOICE' || t === 'SUPPLIER_BILL') totals.chargesMinor += effect;
        else if (t === 'CUSTOMER_RECEIPT' || t === 'SUPPLIER_PAYMENT') totals.paymentsMinor += -effect;
        else if (t === 'CUSTOMER_REFUND' || t === 'SUPPLIER_REFUND') totals.refundsMinor += effect;
        else totals.adjustmentsMinor += effect;
        return { date: r.entry_date, docId: r.doc_id, docNo: r.doc_no, docType: r.doc_type, description: r.description, bookingNo: r.booking_no, debitMinor: r.debit, creditMinor: r.credit, balanceMinor: running };
      });
      return { party, partyId, partyName: p.name, partyNo: p.no, currency, from, to, openingMinor: opening, closingMinor: running, totals, lines };
    });
  }

  // ── Aging (§13/§14) ─────────────────────────────────────────────────────
  aging(actor: Actor, party: 'CUSTOMER' | 'SUPPLIER', asOf: string): AgingRowDto[] {
    requirePermission(this.deps, actor, party === 'CUSTOMER' ? 'report.receivables' : 'report.payables', `aging.${party.toLowerCase()}`);
    assertIsoDate(asOf, 'asOf');
    const db = this.deps.db;
    const account = party === 'CUSTOMER' ? '1200' : '2100';
    const partyCol = party === 'CUSTOMER' ? 'customer_id' : 'supplier_id';
    const sign = party === 'CUSTOMER' ? 1 : -1;
    const items = db
      .prepare(`SELECT jl.${partyCol} AS pid, jl.booking_id, jl.currency_code AS cur, SUM(jl.debit_minor - jl.credit_minor) AS bal,
                       COALESCE(b.due_date, b.issue_date, MIN(je.entry_date)) AS due
                FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id LEFT JOIN booking b ON b.id = jl.booking_id
                WHERE jl.account_code = ? AND je.entry_date <= ? GROUP BY jl.${partyCol}, jl.booking_id, jl.currency_code HAVING bal <> 0`)
      .all(account, asOf) as { pid: string; booking_id: string | null; cur: string; bal: number; due: string }[];
    const names = party === 'CUSTOMER'
      ? db.prepare('SELECT full_name AS name, customer_no AS no FROM customer WHERE id = ?')
      : db.prepare('SELECT name, supplier_no AS no FROM supplier WHERE id = ?');
    const rows = new Map<string, AgingRowDto>();
    for (const i of items) {
      const key = `${i.pid}|${i.cur}`;
      let row = rows.get(key);
      if (!row) {
        const n = names.get(i.pid) as { name: string; no: string };
        row = { partyId: i.pid, partyName: n.name, partyNo: n.no, currency: i.cur, currentMinor: 0, d1to7Minor: 0, d8to30Minor: 0, d31to60Minor: 0, d60PlusMinor: 0, totalMinor: 0, creditMinor: 0 };
        rows.set(key, row);
      }
      const bal = sign * i.bal;
      // Credits are shown separately, never netted into ageing buckets. Amounts owed on account
      // (e.g. opening balances) age from their first entry date.
      if (bal < 0) {
        row.creditMinor += -bal;
      } else {
        const bucket = agingBucket(i.due, asOf);
        if (bucket === 'CURRENT') row.currentMinor += bal;
        else if (bucket === 'D1_7') row.d1to7Minor += bal;
        else if (bucket === 'D8_30') row.d8to30Minor += bal;
        else if (bucket === 'D31_60') row.d31to60Minor += bal;
        else row.d60PlusMinor += bal;
      }
    }
    for (const r of rows.values()) r.totalMinor = r.currentMinor + r.d1to7Minor + r.d8to30Minor + r.d31to60Minor + r.d60PlusMinor;
    return [...rows.values()].sort((a, b) => b.totalMinor - a.totalMinor || a.partyName.localeCompare(b.partyName));
  }

  // ── Reports (§23) ───────────────────────────────────────────────────────
  run(actor: Actor, id: ReportId, from: string, to: string): ReportDto {
    requirePermission(this.deps, actor, REPORT_PERMISSION[id], `reports.${id}`);
    assertRange(from, to);
    const base = this.company.core().baseCurrency;
    const out = (columns: ReportColumnDto[], rows: ReportDto['rows'], totals: ReportDto['totals'] = null, notes: string[] = []): ReportDto => ({ id, from, to, baseCurrency: base, columns, rows, totals, notes });
    const db = this.deps.db;
    // Users without booking.view_all only see their own bookings (bound parameter, never interpolated).
    const own = hasAny(actor, 'booking.view_all') ? '' : 'AND (b.sales_agent_id = @me OR b.created_by = @me)';
    const me = actor.userId;
    const sum = (rows: ReportDto['rows'], keys: string[]) => Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s + (Number(r[k]) || 0), 0)]));

    switch (id) {
      case 'sales': {
        const rows = db.prepare(`SELECT je.entry_date AS date, d.doc_no, d.doc_type, b.booking_no, c.full_name AS customer, t.ticket_number,
                                        p.given_name || ' ' || p.surname AS passenger, jl.currency_code AS currency,
                                        SUM(jl.credit_minor - jl.debit_minor) AS amount, SUM(jl.credit_base_minor - jl.debit_base_minor) AS base
                                 FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id JOIN fin_document d ON d.id = je.document_id
                                 JOIN ledger_account la ON la.code = jl.account_code LEFT JOIN booking b ON b.id = jl.booking_id
                                 LEFT JOIN customer c ON c.id = d.customer_id LEFT JOIN ticket t ON t.id = jl.ticket_id
                                 LEFT JOIN booking_passenger p ON p.id = t.passenger_id
                                 WHERE la.account_class IN ('REVENUE','CONTRA_REVENUE') AND je.entry_date BETWEEN @from AND @to ${own}
                                 GROUP BY d.id, jl.ticket_id ORDER BY je.entry_date, d.doc_no`).all({ from, to, ...(own ? { me } : {}) }) as ReportDto['rows'];
        return out([col('date', 'date', 'date'), col('doc_no', 'document', 'code'), col('doc_type', 'type', 'code'), col('booking_no', 'booking', 'code'), col('customer', 'customer'),
          col('passenger', 'passenger'), col('ticket_number', 'ticket', 'code'), col('currency', 'currency', 'code'), col('amount', 'amount', 'money'), col('base', 'baseAmount', 'money')],
        rows, sum(rows, ['base']));
      }
      case 'purchases': {
        const rows = db.prepare(`SELECT je.entry_date AS date, d.doc_no, d.doc_type, s.name AS supplier, b.booking_no, t.ticket_number, d.external_reference,
                                        jl.currency_code AS currency, SUM(jl.debit_minor - jl.credit_minor) AS amount, SUM(jl.debit_base_minor - jl.credit_base_minor) AS base
                                 FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id JOIN fin_document d ON d.id = je.document_id
                                 JOIN ledger_account la ON la.code = jl.account_code LEFT JOIN supplier s ON s.id = d.supplier_id
                                 LEFT JOIN booking b ON b.id = jl.booking_id LEFT JOIN ticket t ON t.id = jl.ticket_id
                                 WHERE la.account_class IN ('COST','CONTRA_COST') AND je.entry_date BETWEEN ? AND ?
                                 GROUP BY d.id, jl.ticket_id ORDER BY je.entry_date, d.doc_no`).all(from, to) as ReportDto['rows'];
        return out([col('date', 'date', 'date'), col('doc_no', 'document', 'code'), col('doc_type', 'type', 'code'), col('supplier', 'supplier'), col('booking_no', 'booking', 'code'),
          col('ticket_number', 'ticket', 'code'), col('external_reference', 'reference', 'code'), col('currency', 'currency', 'code'), col('amount', 'amount', 'money'), col('base', 'baseAmount', 'money')],
        rows, sum(rows, ['base']));
      }
      case 'profit': {
        const s = this.ledger.computeSummary(from, to);
        const rows = db.prepare(`SELECT b.booking_no, c.full_name AS customer, b.issue_date,
                                        SUM(CASE WHEN la.account_class IN ('REVENUE','CONTRA_REVENUE') THEN jl.credit_base_minor - jl.debit_base_minor ELSE 0 END) AS sales,
                                        SUM(CASE WHEN la.account_class IN ('COST','CONTRA_COST') THEN jl.debit_base_minor - jl.credit_base_minor ELSE 0 END) AS cost
                                 FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id JOIN ledger_account la ON la.code = jl.account_code
                                 JOIN booking b ON b.id = jl.booking_id JOIN customer c ON c.id = b.customer_id
                                 WHERE la.account_class IN ('REVENUE','CONTRA_REVENUE','COST','CONTRA_COST') AND je.entry_date BETWEEN ? AND ?
                                 GROUP BY b.id ORDER BY b.booking_no`).all(from, to) as { booking_no: string; customer: string; issue_date: string | null; sales: number; cost: number }[];
        const withGp = rows.map((r) => ({ ...r, gross_profit: r.sales - r.cost }));
        return out([col('booking_no', 'booking', 'code'), col('customer', 'customer'), col('issue_date', 'issueDate', 'date'), col('sales', 'sales', 'money'), col('cost', 'purchases', 'money'), col('gross_profit', 'grossProfit', 'money')],
          withGp, { sales: s.sales, purchases: s.purchases, grossProfit: s.grossProfit, expenses: s.expenses, otherIncome: s.otherIncome, netProfit: s.netProfit, collections: s.collections, supplierPayments: s.supplierPayments });
      }
      case 'receivables':
      case 'payables': {
        const aging = this.aging(actor, id === 'receivables' ? 'CUSTOMER' : 'SUPPLIER', to);
        const rows = aging.map((a) => ({ party_no: a.partyNo, party: a.partyName, currency: a.currency, current: a.currentMinor, d1_7: a.d1to7Minor, d8_30: a.d8to30Minor, d31_60: a.d31to60Minor, d60_plus: a.d60PlusMinor, total: a.totalMinor, credit: a.creditMinor }));
        return out([col('party_no', 'number', 'code'), col('party', id === 'receivables' ? 'customer' : 'supplier'), col('currency', 'currency', 'code'), col('current', 'agingCurrent', 'money'),
          col('d1_7', 'aging1_7', 'money'), col('d8_30', 'aging8_30', 'money'), col('d31_60', 'aging31_60', 'money'), col('d60_plus', 'aging60Plus', 'money'), col('total', 'outstanding', 'money'), col('credit', 'creditBalance', 'money')],
        rows, null, ['amountsInTransactionCurrency']);
      }
      case 'supplier_volume': {
        const rows = db.prepare(`SELECT s.supplier_no, s.name AS supplier,
                   (SELECT COUNT(*) FROM fin_document d JOIN journal_entry je ON je.document_id = d.id WHERE d.supplier_id = s.id AND d.doc_type = 'SUPPLIER_BILL' AND d.is_reversal = 0 AND je.entry_date BETWEEN @from AND @to) AS transactions,
                   (SELECT COALESCE(SUM(jl.debit_base_minor - jl.credit_base_minor), 0) FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
                     WHERE jl.supplier_id = s.id AND jl.account_code IN ('5100','5110','5200') AND je.entry_date BETWEEN @from AND @to) AS purchases,
                   (SELECT COALESCE(SUM(jl.debit_base_minor - jl.credit_base_minor), 0) FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id JOIN fin_document d ON d.id = je.document_id
                     WHERE jl.supplier_id = s.id AND jl.account_code = '2100' AND d.doc_type IN ('SUPPLIER_PAYMENT','SUPPLIER_REFUND') AND je.entry_date BETWEEN @from AND @to) AS payments,
                   (SELECT COALESCE(SUM(jl.credit_base_minor - jl.debit_base_minor), 0) FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
                     WHERE jl.supplier_id = s.id AND jl.account_code = '2100' AND je.entry_date <= @to) AS outstanding,
                   (SELECT COALESCE(SUM(jl.credit_base_minor - jl.debit_base_minor), 0) FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
                     JOIN ledger_account la ON la.code = jl.account_code JOIN ticket t ON t.id = jl.ticket_id
                     WHERE t.supplier_id = s.id AND la.account_class IN ('REVENUE','CONTRA_REVENUE') AND je.entry_date BETWEEN @from AND @to) AS related_sales
                 FROM supplier s ORDER BY purchases DESC, s.name`).all({ from, to }) as { supplier_no: string; supplier: string; transactions: number; purchases: number; payments: number; outstanding: number; related_sales: number }[];
        const data = rows.filter((r) => r.transactions || r.purchases || r.payments || r.outstanding).map((r) => ({ ...r, gross_profit: r.related_sales - r.purchases }));
        return out([col('supplier_no', 'number', 'code'), col('supplier', 'supplier'), col('transactions', 'transactions', 'number'), col('purchases', 'purchaseVolume', 'money'),
          col('payments', 'payments', 'money'), col('outstanding', 'outstanding', 'money'), col('gross_profit', 'relatedGrossProfit', 'money')], data, sum(data, ['transactions', 'purchases', 'payments', 'outstanding', 'gross_profit']));
      }
      case 'expenses': {
        const rows = db.prepare(`SELECT je.entry_date AS date, d.doc_no, ec.name_ar AS category_ar, ec.name_en AS category_en, d.description, d.payment_method, ma.name AS account,
                                        d.payment_reference, d.currency_code AS currency, jl.debit_minor - jl.credit_minor AS amount, jl.debit_base_minor - jl.credit_base_minor AS base,
                                        u.display_name AS created_by, d.is_reversal
                                 FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id JOIN fin_document d ON d.id = je.document_id
                                 JOIN expense_category ec ON ec.id = jl.expense_category_id LEFT JOIN money_account ma ON ma.id = d.money_account_id
                                 LEFT JOIN app_user u ON u.id = d.created_by
                                 WHERE d.doc_type = 'EXPENSE' AND jl.expense_category_id IS NOT NULL AND je.entry_date BETWEEN ? AND ? ORDER BY je.entry_date, d.doc_no`).all(from, to) as ReportDto['rows'];
        return out([col('date', 'date', 'date'), col('doc_no', 'document', 'code'), col('category_ar', 'categoryAr'), col('category_en', 'categoryEn'), col('description', 'description'),
          col('payment_method', 'method', 'code'), col('account', 'account'), col('payment_reference', 'reference', 'code'), col('currency', 'currency', 'code'), col('amount', 'amount', 'money'),
          col('base', 'baseAmount', 'money'), col('created_by', 'user')], rows, sum(rows, ['base']));
      }
      case 'refunds': {
        const rows = db.prepare(`SELECT d.doc_date AS date, d.doc_no, d.doc_type, COALESCE(c.full_name, s.name) AS party, b.booking_no, d.currency_code AS currency,
                                        CASE WHEN d.is_reversal = 1 THEN -d.total_minor ELSE d.total_minor END AS amount,
                                        CASE WHEN d.is_reversal = 1 THEN -d.total_base_minor ELSE d.total_base_minor END AS base, ma.name AS account
                                 FROM fin_document d LEFT JOIN customer c ON c.id = d.customer_id LEFT JOIN supplier s ON s.id = d.supplier_id
                                 LEFT JOIN booking b ON b.id = d.booking_id LEFT JOIN money_account ma ON ma.id = d.money_account_id
                                 WHERE d.doc_type IN ('CUSTOMER_REFUND','SUPPLIER_REFUND') AND d.doc_date BETWEEN ? AND ? ORDER BY d.doc_date, d.doc_no`).all(from, to) as ReportDto['rows'];
        const cust = rows.filter((r) => r.doc_type === 'CUSTOMER_REFUND').reduce((s, r) => s + Number(r.base), 0);
        const sup = rows.filter((r) => r.doc_type === 'SUPPLIER_REFUND').reduce((s, r) => s + Number(r.base), 0);
        return out([col('date', 'date', 'date'), col('doc_no', 'document', 'code'), col('doc_type', 'type', 'code'), col('party', 'party'), col('booking_no', 'booking', 'code'),
          col('account', 'account'), col('currency', 'currency', 'code'), col('amount', 'amount', 'money'), col('base', 'baseAmount', 'money')], rows, { customerRefunds: cust, supplierRefunds: sup });
      }
      case 'cancellations': {
        const rows = db.prepare(`SELECT cr.request_no, substr(cr.requested_at, 1, 10) AS requested, b.booking_no, c.full_name AS customer, cr.cancel_type, cr.scope,
                                        cr.overall_status, cr.supplier_status, cr.customer_status, substr(cr.closed_at, 1, 10) AS closed,
                                        (SELECT COALESCE(SUM(CASE WHEN jl.account_code = '4110' THEN jl.debit_base_minor - jl.credit_base_minor END), 0) FROM fin_document d
                                           JOIN journal_entry je ON je.document_id = d.id JOIN journal_line jl ON jl.entry_id = je.id WHERE d.cancellation_request_id = cr.id) AS sale_returned,
                                        (SELECT COALESCE(SUM(CASE WHEN jl.account_code = '4210' THEN jl.credit_base_minor - jl.debit_base_minor END), 0) FROM fin_document d
                                           JOIN journal_entry je ON je.document_id = d.id JOIN journal_line jl ON jl.entry_id = je.id WHERE d.cancellation_request_id = cr.id) AS fees,
                                        (SELECT COALESCE(SUM(CASE WHEN jl.account_code = '5110' THEN jl.credit_base_minor - jl.debit_base_minor END), 0) FROM fin_document d
                                           JOIN journal_entry je ON je.document_id = d.id JOIN journal_line jl ON jl.entry_id = je.id WHERE d.cancellation_request_id = cr.id) AS cost_returned,
                                        (SELECT COALESCE(SUM(CASE WHEN jl.account_code = '5200' THEN jl.debit_base_minor - jl.credit_base_minor END), 0) FROM fin_document d
                                           JOIN journal_entry je ON je.document_id = d.id JOIN journal_line jl ON jl.entry_id = je.id WHERE d.cancellation_request_id = cr.id) AS penalties
                                 FROM cancellation_request cr JOIN booking b ON b.id = cr.booking_id JOIN customer c ON c.id = b.customer_id
                                 WHERE cr.requested_at >= @from AND cr.requested_at < date(@to, '+1 day') ${own} ORDER BY cr.requested_at`).all({ from, to, ...(own ? { me } : {}) }) as Record<string, number | string>[];
        const viewCost = hasAny(actor, 'booking.view_cost');
        const data: ReportDto['rows'] = rows.map((r) => ({ ...r, net_impact: viewCost ? Number(r.fees) - Number(r.sale_returned) + Number(r.cost_returned) - Number(r.penalties) : null, cost_returned: viewCost ? Number(r.cost_returned) : null, penalties: viewCost ? Number(r.penalties) : null }));
        return out([col('request_no', 'request', 'code'), col('requested', 'date', 'date'), col('booking_no', 'booking', 'code'), col('customer', 'customer'), col('cancel_type', 'type', 'code'),
          col('overall_status', 'status', 'code'), col('supplier_status', 'supplierSide', 'code'), col('customer_status', 'customerSide', 'code'), col('closed', 'closedAt', 'date'),
          col('sale_returned', 'saleReturned', 'money'), col('fees', 'cancellationFees', 'money'), col('cost_returned', 'costReturned', 'money'), col('penalties', 'supplierPenalties', 'money'),
          col('net_impact', 'netImpact', 'money')], data, null);
      }
      case 'flight_changes': {
        // Users without booking.view_all only see changes on their own records (same rule as everywhere else).
        const changes = this.bookings.scheduleChanges(null, { from, to }).filter((c) => {
          if (!own) return true;
          try { this.bookings.accessible(actor, c.bookingId); return true; } catch { return false; }
        });
        const rows = changes.map((c) => ({
          changed_at: c.changedAt.slice(0, 16).replace('T', ' '), booking_no: c.bookingNo, segment: c.segmentLabel, severity: c.severity,
          changes: c.fields.map((f) => `${f.field}: ${f.oldValue ?? '—'} → ${f.newValue ?? '—'}`).join('; '), customer: c.customerName, status: c.notificationStatus,
          attention: c.requiresAttention ? 1 : 0, changed_by: c.changedBy,
        }));
        return out([col('changed_at', 'date', 'date'), col('booking_no', 'booking', 'code'), col('segment', 'segment', 'code'), col('severity', 'severity', 'code'), col('changes', 'changes'),
          col('customer', 'customer'), col('status', 'notificationStatus', 'code'), col('changed_by', 'user')], rows, { attention: rows.reduce((s, r) => s + r.attention, 0) });
      }
      case 'employee_activity': {
        const rows = db.prepare(`SELECT u.username, u.display_name AS name,
                   (SELECT COUNT(*) FROM booking b WHERE b.created_by = u.id AND b.booking_date BETWEEN @from AND @to) AS bookings_created,
                   (SELECT COUNT(*) FROM booking_status_history h WHERE h.changed_by = u.id AND h.to_status = 'ISSUED' AND substr(h.changed_at, 1, 10) BETWEEN @from AND @to) AS bookings_issued,
                   (SELECT COUNT(*) FROM ticket t JOIN booking b ON b.id = t.booking_id WHERE b.sales_agent_id = u.id AND t.issue_date BETWEEN @from AND @to) AS tickets,
                   (SELECT COALESCE(SUM(jl.credit_base_minor - jl.debit_base_minor), 0) FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
                      JOIN ledger_account la ON la.code = jl.account_code JOIN booking b ON b.id = jl.booking_id
                      WHERE b.sales_agent_id = u.id AND la.account_class IN ('REVENUE','CONTRA_REVENUE') AND je.entry_date BETWEEN @from AND @to) AS sales,
                   (SELECT COUNT(*) FROM fin_document d WHERE d.created_by = u.id AND d.doc_type = 'CUSTOMER_RECEIPT' AND d.is_reversal = 0 AND d.doc_date BETWEEN @from AND @to) AS receipts,
                   (SELECT COALESCE(SUM(CASE WHEN d.is_reversal = 1 THEN -d.total_base_minor ELSE d.total_base_minor END), 0) FROM fin_document d
                      WHERE d.created_by = u.id AND d.doc_type = 'CUSTOMER_RECEIPT' AND d.doc_date BETWEEN @from AND @to) AS collected,
                   (SELECT COUNT(*) FROM audit_log a WHERE a.user_id = u.id AND substr(a.occurred_at, 1, 10) BETWEEN @from AND @to) AS actions
                 FROM app_user u ORDER BY sales DESC, u.username`).all({ from, to }) as ReportDto['rows'];
        return out([col('username', 'username', 'code'), col('name', 'name'), col('bookings_created', 'bookingsCreated', 'number'), col('bookings_issued', 'bookingsIssued', 'number'),
          col('tickets', 'tickets', 'number'), col('sales', 'sales', 'money'), col('receipts', 'receipts', 'number'), col('collected', 'collected', 'money'), col('actions', 'auditedActions', 'number')],
        rows, sum(rows, ['bookings_created', 'bookings_issued', 'tickets', 'sales', 'receipts', 'collected']));
      }
      case 'collections': {
        const rows = db.prepare(`SELECT d.doc_date AS date, d.doc_no, d.doc_type, c.full_name AS customer, b.booking_no, d.payment_method, ma.name AS account, d.payment_reference,
                                        d.currency_code AS currency, CASE WHEN d.doc_type = 'CUSTOMER_REFUND' OR d.is_reversal = 1 THEN -d.total_minor ELSE d.total_minor END AS amount,
                                        CASE WHEN d.doc_type = 'CUSTOMER_REFUND' OR d.is_reversal = 1 THEN -d.total_base_minor ELSE d.total_base_minor END AS base,
                                        u.display_name AS received_by
                                 FROM fin_document d JOIN customer c ON c.id = d.customer_id LEFT JOIN booking b ON b.id = d.booking_id
                                 LEFT JOIN money_account ma ON ma.id = d.money_account_id LEFT JOIN app_user u ON u.id = d.created_by
                                 WHERE d.doc_type IN ('CUSTOMER_RECEIPT','CUSTOMER_REFUND') AND d.doc_date BETWEEN ? AND ? ORDER BY d.doc_date, d.doc_no`).all(from, to) as ReportDto['rows'];
        return out([col('date', 'date', 'date'), col('doc_no', 'document', 'code'), col('doc_type', 'type', 'code'), col('customer', 'customer'), col('booking_no', 'booking', 'code'),
          col('payment_method', 'method', 'code'), col('account', 'account'), col('payment_reference', 'reference', 'code'), col('currency', 'currency', 'code'),
          col('amount', 'amount', 'money'), col('base', 'baseAmount', 'money'), col('received_by', 'user')], rows, sum(rows, ['base']));
      }
      case 'cash_book': {
        // Per money account: opening balance, every movement in the period with a running balance, closing balance.
        const accounts = db.prepare('SELECT id, name, currency_code FROM money_account ORDER BY name').all() as { id: string; name: string; currency_code: string }[];
        const openingOf = db.prepare(`SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0) AS v FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
                                      WHERE jl.account_code = '1110' AND jl.money_account_id = ? AND je.entry_date < ?`);
        const movements = db.prepare(`SELECT je.entry_date AS date, d.doc_no, d.doc_type, d.reason_code, COALESCE(c.full_name, s.name, d.description) AS party, d.payment_reference,
                                             jl.debit_minor AS money_in, jl.credit_minor AS money_out
                                      FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id JOIN fin_document d ON d.id = je.document_id
                                      LEFT JOIN customer c ON c.id = d.customer_id LEFT JOIN supplier s ON s.id = d.supplier_id
                                      WHERE jl.account_code = '1110' AND jl.money_account_id = ? AND je.entry_date BETWEEN ? AND ?
                                      ORDER BY je.entry_date, d.created_at, d.doc_no, jl.line_no`);
        const rows: ReportDto['rows'] = [];
        for (const a of accounts) {
          const opening = (openingOf.get(a.id, from) as { v: number }).v;
          const lines = movements.all(a.id, from, to) as { date: string; doc_no: string; doc_type: string; reason_code: string | null; party: string | null; payment_reference: string | null; money_in: number; money_out: number }[];
          if (opening === 0 && lines.length === 0) continue;
          let balance = opening;
          rows.push({ date: from, account: a.name, currency: a.currency_code, doc_no: null, doc_type: 'OPENING', party: null, reference: null, money_in: null, money_out: null, balance });
          for (const l of lines) {
            balance += l.money_in - l.money_out;
            rows.push({ date: l.date, account: a.name, currency: a.currency_code, doc_no: l.doc_no, doc_type: l.doc_type, party: l.party, reference: l.payment_reference, money_in: l.money_in || null, money_out: l.money_out || null, balance });
          }
        }
        return out([col('date', 'date', 'date'), col('account', 'account'), col('doc_no', 'document', 'code'), col('doc_type', 'type', 'code'), col('party', 'party'),
          col('reference', 'reference', 'code'), col('currency', 'currency', 'code'), col('money_in', 'moneyIn', 'money'), col('money_out', 'moneyOut', 'money'), col('balance', 'runningBalance', 'money')],
        rows, null, ['amountsInTransactionCurrency']);
      }
      default: {
        const never: never = id;
        throw new DomainError(ErrorCode.VALIDATION, `Unknown report ${String(never)}`);
      }
    }
  }

  // ── Dashboard (§22) ─────────────────────────────────────────────────────
  dashboard(actor: Actor, from: string, to: string): DashboardMetricsDto {
    requirePermission(this.deps, actor, ['dashboard.operational', 'dashboard.financial'], 'dashboard.metrics');
    assertRange(from, to);
    const db = this.deps.db;
    const base = this.company.core().baseCurrency;
    let operational: DashboardMetricsDto['operational'] = null;
    if (hasAny(actor, 'dashboard.operational')) {
      const scope = hasAny(actor, 'booking.view_all') ? '' : 'AND (b.sales_agent_id = @me OR b.created_by = @me)';
      const q = (sql: string) => (db.prepare(sql).get({ from, to, me: actor.userId, today: this.company.today() }) as { n: number }).n;
      const soon = new Date(`${this.company.today()}T00:00:00Z`);
      soon.setUTCDate(soon.getUTCDate() + 3);
      operational = {
        bookingsCreated: q(`SELECT COUNT(*) AS n FROM booking b WHERE b.booking_date BETWEEN @from AND @to ${scope}`),
        bookingsIssued: q(`SELECT COUNT(*) AS n FROM booking b WHERE b.issue_date BETWEEN @from AND @to ${scope}`),
        ticketsIssued: q(`SELECT COUNT(*) AS n FROM ticket t JOIN booking b ON b.id = t.booking_id WHERE t.issue_date BETWEEN @from AND @to ${scope}`),
        cancellations: q(`SELECT COUNT(*) AS n FROM cancellation_request cr JOIN booking b ON b.id = cr.booking_id WHERE cr.requested_at >= @from AND cr.requested_at < date(@to, '+1 day') ${scope}`),
        upcomingDepartures: (db.prepare(`SELECT COUNT(*) AS n FROM flight_segment fs JOIN booking b ON b.id = fs.booking_id WHERE fs.status <> 'CANCELLED'
                                          AND b.status IN ('RESERVED','ISSUED','PARTIALLY_CANCELLED') AND fs.departure_date BETWEEN @today AND @soon ${scope}`)
          .get({ today: this.company.today(), soon: soon.toISOString().slice(0, 10), me: actor.userId }) as { n: number }).n,
        changesRequiringAttention: q(`SELECT COUNT(*) AS n FROM schedule_change sc JOIN booking b ON b.id = sc.booking_id WHERE sc.superseded_by_id IS NULL
                                      AND sc.notification_status IN ('NOT_NOTIFIED','NOTIFICATION_FAILED') ${scope}`),
        openRefundRequests: q(`SELECT COUNT(*) AS n FROM cancellation_request cr JOIN booking b ON b.id = cr.booking_id WHERE cr.overall_status = 'OPEN' ${scope}`),
      };
    }
    let financial: DashboardMetricsDto['financial'] = null;
    if (hasAny(actor, 'dashboard.financial')) {
      const s = this.ledger.computeSummary(from, to);
      const refunds = (type: string) => (db.prepare(`SELECT COALESCE(SUM(CASE WHEN is_reversal = 1 THEN -total_base_minor ELSE total_base_minor END), 0) AS v FROM fin_document WHERE doc_type = ? AND doc_date BETWEEN ? AND ?`).get(type, from, to) as { v: number }).v;
      financial = {
        sales: s.sales, collections: s.collections, purchases: s.purchases, grossProfit: s.grossProfit, expenses: s.expenses, netProfit: s.netProfit,
        receivables: s.receivables, payables: s.payables, customerRefunds: refunds('CUSTOMER_REFUND'), supplierRefunds: refunds('SUPPLIER_REFUND'),
      };
    }
    return { from, to, baseCurrency: base, operational, financial };
  }

  // ── Global search (§29) ─────────────────────────────────────────────────
  search(actor: Actor, query: string): SearchHitDto[] {
    const q = normalizeSearchText(query);
    if (q.length < 2) return [];
    const db = this.deps.db;
    const hits: SearchHitDto[] = [];
    const run = (type: SearchHitDto['type'], permission: string, sql: string, map: (r: Record<string, string | null>) => SearchHitDto) => {
      if (!hasAny(actor, permission)) return;
      const clause = searchClause(type, query);
      if (!clause) return;
      const rows = db.prepare(sql.replace('@@', clause.sql)).all(...clause.params) as Record<string, string | null>[];
      hits.push(...rows.map(map));
    };
    run('customer', 'customer.view', `SELECT id, full_name, customer_no, primary_mobile FROM customer WHERE id IN (@@) ORDER BY is_active DESC, full_name LIMIT 8`,
      (r) => ({ type: 'customer', id: r.id!, title: r.full_name!, subtitle: `${r.customer_no} · ${r.primary_mobile}` }));
    if (hasAny(actor, 'booking.view')) {
      const clause = searchClause('booking', query);
      if (clause) {
        const scope = hasAny(actor, 'booking.view_all') ? '' : 'AND (b.sales_agent_id = ? OR b.created_by = ?)';
        const rows = db.prepare(`SELECT b.id, b.booking_no, b.primary_pnr, b.status, c.full_name FROM booking b JOIN customer c ON c.id = b.customer_id
                                 WHERE b.id IN (${clause.sql}) ${scope} ORDER BY b.booking_date DESC LIMIT 10`)
          .all(...clause.params, ...(scope ? [actor.userId, actor.userId] : [])) as { id: string; booking_no: string; primary_pnr: string | null; status: string; full_name: string }[];
        hits.push(...rows.map((r) => ({ type: 'booking' as const, id: r.id, title: `${r.booking_no}${r.primary_pnr ? ` · ${r.primary_pnr}` : ''}`, subtitle: `${r.full_name} · ${r.status}` })));
      }
    }
    run('supplier', 'supplier.view', `SELECT id, name, supplier_no FROM supplier WHERE id IN (@@) ORDER BY is_active DESC, name LIMIT 5`,
      (r) => ({ type: 'supplier', id: r.id!, title: r.name!, subtitle: r.supplier_no ?? null }));
    run('airline', 'airline.view', `SELECT id, name_en, iata_code FROM airline WHERE id IN (@@) ORDER BY is_active DESC, name_en LIMIT 5`,
      (r) => ({ type: 'airline', id: r.id!, title: r.name_en!, subtitle: r.iata_code ?? null }));
    if (hasAny(actor, ['booking.view', 'airport.manage'])) {
      const clause = searchClause('airport', query);
      if (clause) {
        const rows = db.prepare(`SELECT iata_code, name_en, city_en, country_code FROM airport WHERE iata_code IN (${clause.sql}) ORDER BY is_active DESC, name_en LIMIT 5`).all(...clause.params) as { iata_code: string; name_en: string; city_en: string | null; country_code: string }[];
        hits.push(...rows.map((r) => ({ type: 'airport' as const, id: r.iata_code, title: `${r.iata_code} · ${r.name_en}`, subtitle: `${r.city_en ?? ''} ${r.country_code}` })));
      }
    }
    return hits;
  }
}

function assertRange(from: string, to: string): void {
  assertIsoDate(from, 'from');
  assertIsoDate(to, 'to');
  if (from > to) throw new DomainError(ErrorCode.VALIDATION, '"from" must not be after "to"', { reason: 'INVALID_RANGE' });
}
