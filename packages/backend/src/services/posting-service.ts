import {
  DOCUMENT_POST_PERMISSIONS,
  DOCUMENT_REVERSE_PERMISSIONS,
  DOC_TYPE_META,
  DomainError,
  ErrorCode,
  assertPeriodOpen,
  buildJournal,
  planReversal,
  priceDocument,
  validateJournal,
  type DocType,
  type DocumentDraft,
  type JournalLineDraft,
  type LineType,
  type PaymentMethod,
  type PricedDocument,
} from '@airdesk/domain';
import type { CompanyService } from './company-service';
import { actorOf, hasAny, requirePermission, tx, type Actor, type ServiceDeps } from './context';
import type { CurrencyService } from './currency-service';
import { readSetting } from './settings';

export interface PostedDocument {
  id: string;
  docNo: string;
  docType: DocType;
  docDate: string;
  isReversal: boolean;
  reversalOfId: string | null;
  reversedById: string | null;
  customerId: string | null;
  supplierId: string | null;
  bookingId: string | null;
  moneyAccountId: string | null;
  paymentMethod: PaymentMethod | null;
  currency: string;
  exchangeRate: string;
  totalMinor: number;
  totalBaseMinor: number;
  description: string | null;
  createdAt: string;
  createdBy: string;
  lines: { lineNo: number; lineType: LineType; amountMinor: number; baseAmountMinor: number; bookingId: string | null; ticketId: string | null; expenseCategoryId: string | null }[];
  journal: (JournalLineDraft & { lineNo: number })[];
}

interface DocRow {
  id: string; doc_type: DocType; doc_no: string; doc_date: string; is_reversal: number; reversal_of_id: string | null;
  customer_id: string | null; supplier_id: string | null; booking_id: string | null; cancellation_request_id: string | null;
  money_account_id: string | null; payment_method: PaymentMethod | null; payment_reference: string | null;
  currency_code: string; exchange_rate: string; total_minor: number; total_base_minor: number;
  reason_code: string | null; description: string | null; created_at: string; created_by: string;
}

/**
 * The only code path that writes financial documents and journal entries.
 * Each post is ONE transaction: number → document → lines → journal → seal
 * (the database re-checks balance on seal) → audit → idempotency record.
 *
 * Not exposed over IPC in Phase 1: later business commands (issue booking,
 * receive payment, …) call it after their own, stricter permission checks.
 */
export class PostingService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly company: CompanyService,
    private readonly currencies: CurrencyService,
  ) {}

  post(actor: Actor, draft: DocumentDraft, opts: { commandId?: string } = {}): PostedDocument {
    requirePermission(this.deps, actor, DOCUMENT_POST_PERMISSIONS[draft.docType] ?? [], `document.post:${draft.docType}`);
    if (opts.commandId) {
      const done = this.deps.db.prepare('SELECT result_json FROM command_log WHERE command_id = ?').get(opts.commandId) as { result_json: string } | undefined;
      if (done) return this.get((JSON.parse(done.result_json) as { documentId: string }).documentId);
    }
    this.assertBackdateAllowed(actor, draft.docDate);

    const id = tx(this.deps, () => {
      const core = this.company.core();
      assertPeriodOpen(draft.docDate, core.lockDate);
      const priced = priceDocument(draft, { baseCurrency: core.baseCurrency, minorUnitOf: (c) => this.currencies.minorUnitOf(c) });
      this.assertReferences(priced);
      const journal = buildJournal(priced, { baseCurrency: core.baseCurrency, expenseAccountFor: (cid) => this.expenseAccount(cid) });
      validateJournal(journal, this.deps.chart);

      const docId = this.insertDocument(actor, priced, journal, { isReversal: false, reversalOfId: null });
      if (opts.commandId) {
        this.deps.db
          .prepare('INSERT INTO command_log (command_id, command, user_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(opts.commandId, `document.post:${draft.docType}`, actor.userId, JSON.stringify({ documentId: docId }), this.deps.clock.now().toISOString());
      }
      return docId;
    });
    return this.get(id);
  }

  reverse(actor: Actor, input: { documentId: string; reversalDate: string; reason: string }): PostedDocument {
    const original = this.row(input.documentId);
    requirePermission(this.deps, actor, DOCUMENT_REVERSE_PERMISSIONS[original.doc_type], `document.reverse:${original.doc_type}`);
    this.assertBackdateAllowed(actor, input.reversalDate);

    const id = tx(this.deps, () => {
      assertPeriodOpen(input.reversalDate, this.company.core().lockDate);
      const current = this.get(input.documentId);
      const journal = planReversal(
        { id: current.id, docType: current.docType, docDate: current.docDate, isReversal: current.isReversal, reversedById: current.reversedById },
        current.journal,
        { reversalDate: input.reversalDate, reason: input.reason },
      );
      validateJournal(journal, this.deps.chart);
      const priced: PricedDocument = {
        docType: current.docType,
        docDate: input.reversalDate,
        currency: current.currency,
        exchangeRate: current.exchangeRate,
        customerId: current.customerId,
        supplierId: current.supplierId,
        bookingId: current.bookingId,
        moneyAccountId: current.moneyAccountId,
        paymentMethod: current.paymentMethod,
        paymentReference: original.payment_reference,
        cancellationRequestId: original.cancellation_request_id,
        reasonCode: 'REVERSAL',
        description: input.reason.trim(),
        totalMinor: current.totalMinor,
        totalBaseMinor: current.totalBaseMinor,
        lines: current.lines.map((l) => ({
          lineType: l.lineType, amountMinor: l.amountMinor, baseAmountMinor: l.baseAmountMinor,
          bookingId: l.bookingId, ticketId: l.ticketId, expenseCategoryId: l.expenseCategoryId,
        })),
      };
      return this.insertDocument(actor, priced, journal, { isReversal: true, reversalOfId: current.id, originalNo: current.docNo, reason: input.reason.trim() });
    });
    return this.get(id);
  }

  get(documentId: string): PostedDocument {
    const d = this.row(documentId);
    const reversedBy = this.deps.db.prepare('SELECT id FROM fin_document WHERE reversal_of_id = ?').get(documentId) as { id: string } | undefined;
    const lines = this.deps.db
      .prepare('SELECT line_no, line_type, amount_minor, base_amount_minor, booking_id, ticket_id, expense_category_id FROM fin_document_line WHERE document_id = ? ORDER BY line_no')
      .all(documentId) as { line_no: number; line_type: LineType; amount_minor: number; base_amount_minor: number; booking_id: string | null; ticket_id: string | null; expense_category_id: string | null }[];
    const journal = this.deps.db
      .prepare(
        `SELECT jl.* FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id WHERE je.document_id = ? ORDER BY jl.line_no`,
      )
      .all(documentId) as {
        line_no: number; account_code: string; customer_id: string | null; supplier_id: string | null; money_account_id: string | null;
        booking_id: string | null; ticket_id: string | null; expense_category_id: string | null; currency_code: string;
        debit_minor: number; credit_minor: number; debit_base_minor: number; credit_base_minor: number;
      }[];
    return {
      id: d.id,
      docNo: d.doc_no,
      docType: d.doc_type,
      docDate: d.doc_date,
      isReversal: d.is_reversal === 1,
      reversalOfId: d.reversal_of_id,
      reversedById: reversedBy?.id ?? null,
      customerId: d.customer_id,
      supplierId: d.supplier_id,
      bookingId: d.booking_id,
      moneyAccountId: d.money_account_id,
      paymentMethod: d.payment_method,
      currency: d.currency_code,
      exchangeRate: d.exchange_rate,
      totalMinor: d.total_minor,
      totalBaseMinor: d.total_base_minor,
      description: d.description,
      createdAt: d.created_at,
      createdBy: d.created_by,
      lines: lines.map((l) => ({
        lineNo: l.line_no, lineType: l.line_type, amountMinor: l.amount_minor, baseAmountMinor: l.base_amount_minor,
        bookingId: l.booking_id, ticketId: l.ticket_id, expenseCategoryId: l.expense_category_id,
      })),
      journal: journal.map((j) => {
        const debit = j.debit_minor > 0 || j.debit_base_minor > 0;
        return {
          lineNo: j.line_no,
          accountCode: j.account_code,
          side: (debit ? 'DEBIT' : 'CREDIT') as 'DEBIT' | 'CREDIT',
          currency: j.currency_code,
          amountMinor: debit ? j.debit_minor : j.credit_minor,
          baseAmountMinor: debit ? j.debit_base_minor : j.credit_base_minor,
          dims: {
            customerId: j.customer_id, supplierId: j.supplier_id, moneyAccountId: j.money_account_id,
            bookingId: j.booking_id, ticketId: j.ticket_id, expenseCategoryId: j.expense_category_id,
          },
        };
      }),
    };
  }

  private row(documentId: string): DocRow {
    const d = this.deps.db.prepare('SELECT * FROM fin_document WHERE id = ?').get(documentId) as DocRow | undefined;
    if (!d) throw new DomainError(ErrorCode.NOT_FOUND, 'Document not found', { documentId });
    return d;
  }

  private insertDocument(
    actor: Actor,
    doc: PricedDocument,
    journal: JournalLineDraft[],
    rev: { isReversal: boolean; reversalOfId: string | null; originalNo?: string; reason?: string },
  ): string {
    const db = this.deps.db;
    const now = this.deps.clock.now().toISOString();
    const docId = this.deps.newId();
    const docNo = this.nextNumber(doc.docType, doc.docDate);
    db.prepare(
      `INSERT INTO fin_document (id, doc_type, doc_no, doc_date, is_reversal, reversal_of_id, customer_id, supplier_id, booking_id,
         cancellation_request_id, money_account_id, payment_method, payment_reference, currency_code, exchange_rate, total_minor,
         total_base_minor, reason_code, description, created_at, created_by)
       VALUES (@id, @docType, @docNo, @docDate, @isReversal, @reversalOfId, @customerId, @supplierId, @bookingId, @cancellationRequestId,
         @moneyAccountId, @paymentMethod, @paymentReference, @currency, @exchangeRate, @totalMinor, @totalBaseMinor, @reasonCode,
         @description, @now, @userId)`,
    ).run({
      id: docId, docType: doc.docType, docNo, docDate: doc.docDate, isReversal: rev.isReversal ? 1 : 0, reversalOfId: rev.reversalOfId,
      customerId: doc.customerId ?? null, supplierId: doc.supplierId ?? null, bookingId: doc.bookingId ?? null,
      cancellationRequestId: doc.cancellationRequestId ?? null, moneyAccountId: doc.moneyAccountId ?? null,
      paymentMethod: doc.paymentMethod ?? null, paymentReference: doc.paymentReference ?? null, currency: doc.currency,
      exchangeRate: doc.exchangeRate, totalMinor: doc.totalMinor, totalBaseMinor: doc.totalBaseMinor,
      reasonCode: doc.reasonCode ?? null, description: doc.description ?? null, now, userId: actor.userId,
    });
    const insLine = db.prepare(
      `INSERT INTO fin_document_line (id, document_id, line_no, line_type, booking_id, passenger_id, ticket_id, expense_category_id,
         description, amount_minor, base_amount_minor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    doc.lines.forEach((l, i) =>
      insLine.run(this.deps.newId(), docId, i + 1, l.lineType, l.bookingId ?? null, l.passengerId ?? null, l.ticketId ?? null,
        l.expenseCategoryId ?? null, l.description ?? null, l.amountMinor, l.baseAmountMinor),
    );
    const entryId = this.deps.newId();
    db.prepare('INSERT INTO journal_entry (id, document_id, entry_date, created_at) VALUES (?, ?, ?, ?)').run(entryId, docId, doc.docDate, now);
    const insJl = db.prepare(
      `INSERT INTO journal_line (id, entry_id, line_no, account_code, customer_id, supplier_id, money_account_id, booking_id, ticket_id,
         expense_category_id, currency_code, debit_minor, credit_minor, debit_base_minor, credit_base_minor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    journal.forEach((j, i) => {
      const d = j.side === 'DEBIT';
      insJl.run(
        this.deps.newId(), entryId, i + 1, j.accountCode, j.dims.customerId ?? null, j.dims.supplierId ?? null, j.dims.moneyAccountId ?? null,
        j.dims.bookingId ?? null, j.dims.ticketId ?? null, j.dims.expenseCategoryId ?? null, j.currency,
        d ? j.amountMinor : 0, d ? 0 : j.amountMinor, d ? j.baseAmountMinor : 0, d ? 0 : j.baseAmountMinor,
      );
    });
    // The database trigger re-validates balance here (defence in depth).
    db.prepare('UPDATE journal_entry SET is_sealed = 1 WHERE id = ?').run(entryId);

    this.deps.audit.append(actorOf(actor), {
      action: rev.isReversal ? 'document.reversed' : 'document.posted',
      entityType: 'fin_document',
      entityId: docId,
      after: {
        docNo, docType: doc.docType, docDate: doc.docDate, currency: doc.currency, exchangeRate: doc.exchangeRate,
        totalMinor: doc.totalMinor, totalBaseMinor: doc.totalBaseMinor, customerId: doc.customerId ?? null,
        supplierId: doc.supplierId ?? null, bookingId: doc.bookingId ?? null, moneyAccountId: doc.moneyAccountId ?? null,
      },
      metadata: rev.isReversal ? { reversalOfId: rev.reversalOfId, originalNo: rev.originalNo, reason: rev.reason } : undefined,
    });
    return docId;
  }

  /** Gap-free per document type and year, allocated inside the posting transaction. */
  private nextNumber(docType: DocType, docDate: string): string {
    const year = docDate.slice(0, 4);
    const prefix = DOC_TYPE_META[docType].prefix;
    const db = this.deps.db;
    db.prepare('INSERT OR IGNORE INTO document_sequence (sequence_key, period_key, prefix, next_value) VALUES (?, ?, ?, 1)').run(docType, year, prefix);
    const row = db.prepare('SELECT prefix, next_value FROM document_sequence WHERE sequence_key = ? AND period_key = ?').get(docType, year) as { prefix: string; next_value: number };
    db.prepare('UPDATE document_sequence SET next_value = next_value + 1 WHERE sequence_key = ? AND period_key = ?').run(docType, year);
    return `${row.prefix}-${year}-${String(row.next_value).padStart(6, '0')}`;
  }

  /** Also called by business commands BEFORE their write transaction (denials must be audited outside it). */
  assertBackdateAllowed(actor: Actor, docDate: string): void {
    const days = readSetting(this.deps.db, 'finance.backdate_days');
    const today = this.company.today();
    const limit = new Date(`${today}T00:00:00Z`);
    limit.setUTCDate(limit.getUTCDate() - days);
    if (docDate < limit.toISOString().slice(0, 10) && !hasAny(actor, 'finance.backdate')) {
      requirePermission(this.deps, actor, 'finance.backdate', 'document.backdate');
    }
  }

  private assertReferences(doc: PricedDocument): void {
    const db = this.deps.db;
    const exists = (table: string, id: string | null | undefined, label: string) => {
      if (id && !db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) throw new DomainError(ErrorCode.NOT_FOUND, `${label} not found`, { id });
    };
    exists('customer', doc.customerId, 'Customer');
    exists('supplier', doc.supplierId, 'Supplier');
    exists('booking', doc.bookingId, 'Booking');
    for (const l of doc.lines) exists('booking', l.bookingId, 'Booking');
    if (doc.moneyAccountId) {
      const ma = db.prepare('SELECT currency_code, is_active FROM money_account WHERE id = ?').get(doc.moneyAccountId) as { currency_code: string; is_active: number } | undefined;
      if (!ma) throw new DomainError(ErrorCode.NOT_FOUND, 'Money account not found');
      if (ma.is_active !== 1) throw new DomainError(ErrorCode.VALIDATION, 'Money account is inactive');
      if (ma.currency_code !== doc.currency) {
        throw new DomainError(ErrorCode.CURRENCY_MISMATCH, 'The money account currency must match the document currency (BR-PAY-05)', {
          account: ma.currency_code, document: doc.currency,
        });
      }
    }
  }

  private expenseAccount(categoryId: string): string {
    const r = this.deps.db.prepare('SELECT ledger_account_code, is_active FROM expense_category WHERE id = ?').get(categoryId) as { ledger_account_code: string; is_active: number } | undefined;
    if (!r) throw new DomainError(ErrorCode.NOT_FOUND, 'Expense category not found', { categoryId });
    if (r.is_active !== 1) throw new DomainError(ErrorCode.VALIDATION, 'Expense category is inactive');
    return r.ledger_account_code;
  }
}
