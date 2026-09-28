import { DomainError, ErrorCode, assertIsoDate } from '@airdesk/domain';
import type { LedgerSummaryDto, TrialBalanceRowDto } from '@airdesk/contracts';
import type { CompanyService } from './company-service';
import { requirePermission, type Actor, type ServiceDeps } from './context';

/**
 * Financial figures for ANY date range, computed only from the immutable
 * journal (owner decision Q11). Because posted rows never change, re-running
 * the same query later returns the same numbers (historically reproducible).
 * Definitions: Phase 0 §04-3 and §04-8.
 */
export class LedgerQueryService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly company: CompanyService,
  ) {}

  summary(actor: Actor, from: string, to: string): LedgerSummaryDto {
    requirePermission(this.deps, actor, 'report.profit', 'ledger.summary');
    return this.computeSummary(from, to);
  }

  computeSummary(from: string, to: string): LedgerSummaryDto {
    assertIsoDate(from, 'from');
    assertIsoDate(to, 'to');
    if (from > to) throw new DomainError(ErrorCode.VALIDATION, '"from" must not be after "to"');
    const db = this.deps.db;
    const flow = (where: string, expr: string) =>
      (db.prepare(`SELECT COALESCE(SUM(${expr}), 0) AS v FROM v_journal WHERE entry_date BETWEEN ? AND ? AND ${where}`).get(from, to) as { v: number }).v;
    const cr = 'credit_base_minor - debit_base_minor';
    const dr = 'debit_base_minor - credit_base_minor';

    const sales = flow(`account_class IN ('REVENUE','CONTRA_REVENUE')`, cr);
    const purchases = flow(`account_class IN ('COST','CONTRA_COST')`, dr);
    const expenses = flow(`account_class = 'EXPENSE'`, dr);
    const otherIncome = flow(`account_class = 'OTHER'`, cr);
    const collections = flow(`account_code = '1110' AND doc_type IN ('CUSTOMER_RECEIPT','CUSTOMER_REFUND')`, dr);
    const supplierPayments = flow(`account_code = '1110' AND doc_type IN ('SUPPLIER_PAYMENT','SUPPLIER_REFUND')`, cr);

    // Point-in-time balances as of `to`, per party and currency; credits are shown separately, never netted into receivables.
    const balances = (account: string, party: string, sign: string) =>
      db
        .prepare(
          `SELECT ${party} AS party, currency_code, SUM(${sign}) AS bal FROM v_journal
           WHERE account_code = ? AND entry_date <= ? GROUP BY ${party}, currency_code`,
        )
        .all(account, to) as { bal: number }[];
    const split = (rows: { bal: number }[]) => ({
      positive: rows.reduce((s, r) => s + Math.max(0, r.bal), 0),
      negative: rows.reduce((s, r) => s + Math.max(0, -r.bal), 0),
    });
    const ar = split(balances('1200', 'customer_id', dr));
    const ap = split(balances('2100', 'supplier_id', cr));

    const grossProfit = sales - purchases;
    return {
      from,
      to,
      baseCurrency: this.company.core().baseCurrency,
      sales,
      purchases,
      grossProfit,
      expenses,
      otherIncome,
      netProfit: grossProfit - expenses + otherIncome,
      collections,
      supplierPayments,
      receivables: ar.positive,
      customerCredits: ar.negative,
      payables: ap.positive,
      supplierCredits: ap.negative,
    };
  }

  trialBalance(actor: Actor, asOf: string): TrialBalanceRowDto[] {
    requirePermission(this.deps, actor, 'report.profit', 'ledger.trialBalance');
    assertIsoDate(asOf, 'asOf');
    return (
      this.deps.db
        .prepare(
          `SELECT la.code, la.name_ar, la.name_en, la.account_class,
             COALESCE(SUM(j.debit_base_minor), 0) AS d, COALESCE(SUM(j.credit_base_minor), 0) AS c
           FROM ledger_account la LEFT JOIN v_journal j ON j.account_code = la.code AND j.entry_date <= ?
           GROUP BY la.code ORDER BY la.code`,
        )
        .all(asOf) as { code: string; name_ar: string; name_en: string; account_class: string; d: number; c: number }[]
    ).map((r) => ({ accountCode: r.code, nameAr: r.name_ar, nameEn: r.name_en, accountClass: r.account_class, debitBaseMinor: r.d, creditBaseMinor: r.c }));
  }
}
