import type { DocumentDto, DocumentLineDto } from '@airdesk/contracts';
import type { Db } from '../db/driver';

interface Row {
  id: string; doc_no: string; doc_type: string; doc_date: string; currency_code: string; exchange_rate: string; total_minor: number;
  total_base_minor: number; customer_id: string | null; customer_name: string | null; supplier_id: string | null; supplier_name: string | null;
  booking_id: string | null; booking_no: string | null; cancellation_request_id: string | null; money_account_id: string | null;
  money_account_name: string | null; payment_method: string | null; payment_reference: string | null; external_reference: string | null;
  reason_code: string | null; description: string | null; is_reversal: number; reversal_of_no: string | null; reversed_by_no: string | null;
  created_at: string; created_by_name: string | null;
}

const BASE_SQL = `
  SELECT d.id, d.doc_no, d.doc_type, d.doc_date, d.currency_code, d.exchange_rate, d.total_minor, d.total_base_minor,
         d.customer_id, c.full_name AS customer_name, d.supplier_id, s.name AS supplier_name, d.booking_id, b.booking_no,
         d.cancellation_request_id, d.money_account_id, ma.name AS money_account_name, d.payment_method, d.payment_reference,
         d.external_reference, d.reason_code, d.description, d.is_reversal, o.doc_no AS reversal_of_no, r.doc_no AS reversed_by_no,
         d.created_at, u.display_name AS created_by_name
  FROM fin_document d
  LEFT JOIN customer c ON c.id = d.customer_id
  LEFT JOIN supplier s ON s.id = d.supplier_id
  LEFT JOIN booking b ON b.id = d.booking_id
  LEFT JOIN money_account ma ON ma.id = d.money_account_id
  LEFT JOIN fin_document o ON o.id = d.reversal_of_id
  LEFT JOIN fin_document r ON r.reversal_of_id = d.id
  LEFT JOIN app_user u ON u.id = d.created_by`;

/** Supplier-side documents reveal purchase cost; they are only shown to callers allowed to see cost. */
export const SUPPLIER_DOC_TYPES = ['SUPPLIER_BILL', 'SUPPLIER_CREDIT_NOTE', 'SUPPLIER_PAYMENT', 'SUPPLIER_REFUND'];

export function readDocuments(db: Db, where: string, params: unknown[], opts: { withLines?: boolean; limit?: number } = {}): DocumentDto[] {
  const rows = db.prepare(`${BASE_SQL} WHERE ${where} ORDER BY d.doc_date, d.created_at, d.doc_no ${opts.limit ? `LIMIT ${Math.floor(opts.limit)}` : ''}`).all(...params) as Row[];
  const lineStmt = db.prepare(
    `SELECT l.line_no, l.line_type, l.amount_minor, l.base_amount_minor, l.description, l.booking_id, b.booking_no, l.ticket_id,
            t.ticket_number, p.given_name || ' ' || p.surname AS passenger_name, l.expense_category_id,
            ec.name_ar AS cat_ar, ec.name_en AS cat_en
     FROM fin_document_line l
     LEFT JOIN booking b ON b.id = l.booking_id
     LEFT JOIN ticket t ON t.id = l.ticket_id
     LEFT JOIN booking_passenger p ON p.id = l.passenger_id
     LEFT JOIN expense_category ec ON ec.id = l.expense_category_id
     WHERE l.document_id = ? ORDER BY l.line_no`,
  );
  return rows.map((r) => ({
    id: r.id, docNo: r.doc_no, docType: r.doc_type, docDate: r.doc_date, currency: r.currency_code, exchangeRate: r.exchange_rate,
    totalMinor: r.total_minor, totalBaseMinor: r.total_base_minor, customerId: r.customer_id, customerName: r.customer_name,
    supplierId: r.supplier_id, supplierName: r.supplier_name, bookingId: r.booking_id, bookingNo: r.booking_no,
    cancellationRequestId: r.cancellation_request_id, moneyAccountId: r.money_account_id, moneyAccountName: r.money_account_name,
    paymentMethod: r.payment_method, paymentReference: r.payment_reference, externalReference: r.external_reference, reasonCode: r.reason_code,
    description: r.description, isReversal: r.is_reversal === 1, reversalOfNo: r.reversal_of_no, reversedByNo: r.reversed_by_no,
    createdAt: r.created_at, createdBy: r.created_by_name,
    lines: opts.withLines === false ? [] : (lineStmt.all(r.id) as {
      line_no: number; line_type: string; amount_minor: number; base_amount_minor: number; description: string | null; booking_id: string | null;
      booking_no: string | null; ticket_id: string | null; ticket_number: string | null; passenger_name: string | null;
      expense_category_id: string | null; cat_ar: string | null; cat_en: string | null;
    }[]).map((l): DocumentLineDto => ({
      lineNo: l.line_no, lineType: l.line_type, amountMinor: l.amount_minor, baseAmountMinor: l.base_amount_minor, description: l.description,
      bookingId: l.booking_id, bookingNo: l.booking_no, ticketId: l.ticket_id, ticketNumber: l.ticket_number, passengerName: l.passenger_name,
      expenseCategoryId: l.expense_category_id, expenseCategory: l.cat_en ? `${l.cat_ar} / ${l.cat_en}` : null,
    })),
  }));
}
