import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT,
  ChartOfAccounts,
  DOC_TYPES,
  DOC_TYPE_META,
  ErrorCode,
  GROSS_PROFIT_CLASSES,
  buildJournal,
  journalTotals,
  mirrorJournal,
  planReversal,
  priceDocument,
  validateJournal,
  type DocumentDraft,
  type JournalLineDraft,
} from '../src';

const chart = new ChartOfAccounts();
const pricing = { baseCurrency: 'EGP', minorUnitOf: (c: string) => (c === 'KWD' ? 3 : 2) };
const posting = { baseCurrency: 'EGP', expenseAccountFor: () => ACCOUNT.EXP_RENT };
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_ERROR';
};
const journalOf = (draft: DocumentDraft) => buildJournal(priceDocument(draft, pricing), posting);
const DATE = '2026-09-01';
const inv = (amount: number, extra: Partial<DocumentDraft> = {}): DocumentDraft => ({
  docType: 'CUSTOMER_INVOICE', docDate: DATE, currency: 'EGP', customerId: 'C1', bookingId: 'B1',
  lines: [{ lineType: 'FARE', amountMinor: amount }], ...extra,
});
const bill = (amount: number): DocumentDraft => ({
  docType: 'SUPPLIER_BILL', docDate: DATE, currency: 'EGP', supplierId: 'S1', bookingId: 'B1',
  lines: [{ lineType: 'PURCHASE_COST', amountMinor: amount }],
});
const receipt = (amount: number): DocumentDraft => ({
  docType: 'CUSTOMER_RECEIPT', docDate: DATE, currency: 'EGP', customerId: 'C1', moneyAccountId: 'M1', paymentMethod: 'CASH',
  lines: [{ lineType: 'SETTLEMENT', amountMinor: amount, bookingId: 'B1' }],
});
const supplierPayment = (amount: number): DocumentDraft => ({
  docType: 'SUPPLIER_PAYMENT', docDate: DATE, currency: 'EGP', supplierId: 'S1', moneyAccountId: 'M1', paymentMethod: 'CASH',
  lines: [{ lineType: 'SETTLEMENT', amountMinor: amount, bookingId: 'B1' }],
});

/** Gross profit of a set of journal lines, straight from Phase 0 §04-3. */
function grossProfit(lines: JournalLineDraft[]): number {
  return lines
    .filter((l) => GROSS_PROFIT_CLASSES.includes(chart.get(l.accountCode)!.accountClass))
    .reduce((s, l) => s + (l.side === 'CREDIT' ? l.baseAmountMinor : -l.baseAmountMinor), 0);
}
const balanceOf = (lines: JournalLineDraft[], account: string) =>
  lines.filter((l) => l.accountCode === account).reduce((s, l) => s + (l.side === 'DEBIT' ? l.baseAmountMinor : -l.baseAmountMinor), 0);

describe('validateJournal', () => {
  const ok: JournalLineDraft[] = [
    { accountCode: ACCOUNT.RECEIVABLE, side: 'DEBIT', currency: 'EGP', amountMinor: 100, baseAmountMinor: 100, dims: { customerId: 'C1' } },
    { accountCode: ACCOUNT.TICKET_SALES, side: 'CREDIT', currency: 'EGP', amountMinor: 100, baseAmountMinor: 100, dims: {} },
  ];

  it('accepts a balanced entry', () => expect(() => validateJournal(ok, chart)).not.toThrow());

  it('rejects unbalanced, single-line, negative, empty, unknown-account and missing-dimension entries', () => {
    expect(code(() => validateJournal([ok[0]!, { ...ok[1]!, baseAmountMinor: 90 }], chart))).toBe(ErrorCode.UNBALANCED_ENTRY);
    expect(code(() => validateJournal([ok[0]!], chart))).toBe(ErrorCode.UNBALANCED_ENTRY);
    expect(code(() => validateJournal([ok[0]!, { ...ok[1]!, amountMinor: -100 }], chart))).toBe(ErrorCode.INVALID_AMOUNT);
    expect(code(() => validateJournal([ok[0]!, { ...ok[1]!, amountMinor: 0, baseAmountMinor: 0 }], chart))).toBe(ErrorCode.INVALID_AMOUNT);
    expect(code(() => validateJournal([ok[0]!, { ...ok[1]!, accountCode: '9999' }], chart))).toBe(ErrorCode.UNKNOWN_ACCOUNT);
    expect(code(() => validateJournal([{ ...ok[0]!, dims: {} }, ok[1]!], chart))).toBe(ErrorCode.MISSING_DIMENSION);
  });

  it('mirroring twice is the identity and swaps totals', () => {
    expect(mirrorJournal(mirrorJournal(ok))).toEqual(ok);
    const t = journalTotals(mirrorJournal([ok[0]!, { ...ok[1]!, baseAmountMinor: 90 }]));
    expect(t).toEqual({ debitBaseMinor: 90, creditBaseMinor: 100 });
  });
});

describe('document validation & pricing', () => {
  it('enforces party, cash and line-type rules', () => {
    expect(code(() => priceDocument({ ...receipt(100), customerId: null }, pricing))).toBe(ErrorCode.VALIDATION);
    expect(code(() => priceDocument({ ...receipt(100), moneyAccountId: null }, pricing))).toBe(ErrorCode.VALIDATION);
    expect(code(() => priceDocument({ ...inv(100), moneyAccountId: 'M1', paymentMethod: 'CASH' }, pricing))).toBe(ErrorCode.VALIDATION);
    expect(code(() => priceDocument({ ...inv(100), lines: [{ lineType: 'PURCHASE_COST', amountMinor: 1 }] }, pricing))).toBe(ErrorCode.VALIDATION);
    expect(code(() => priceDocument({ ...inv(100), supplierId: 'S1' }, pricing))).toBe(ErrorCode.VALIDATION);
    expect(code(() => priceDocument({ ...inv(100), lines: [] }, pricing))).toBe(ErrorCode.VALIDATION);
    expect(code(() => priceDocument({ ...inv(100), docDate: '2026-02-30' }, pricing))).toBe(ErrorCode.VALIDATION);
  });

  it('BR-IMM-04: amounts are strictly positive — a negative payment is impossible', () => {
    expect(code(() => priceDocument(receipt(-500), pricing))).toBe(ErrorCode.INVALID_AMOUNT);
    expect(code(() => priceDocument(receipt(0), pricing))).toBe(ErrorCode.INVALID_AMOUNT);
    expect(code(() => priceDocument(receipt(1.5), pricing))).toBe(ErrorCode.INVALID_AMOUNT);
  });

  it('forces rate 1 in base currency and requires a rate otherwise', () => {
    expect(priceDocument(inv(100), pricing).exchangeRate).toBe('1');
    expect(code(() => priceDocument({ ...inv(100), exchangeRate: '2' }, pricing))).toBe(ErrorCode.INVALID_RATE);
    expect(code(() => priceDocument({ ...inv(100), currency: 'USD' }, pricing))).toBe(ErrorCode.RATE_REQUIRED);
  });

  it('converts per line and sums line bases (journals always balance)', () => {
    const doc = priceDocument(
      { ...inv(1), currency: 'USD', exchangeRate: '0.5', lines: [1, 1, 1].map((a) => ({ lineType: 'FARE' as const, amountMinor: a })) },
      pricing,
    );
    expect(doc.lines.map((l) => l.baseAmountMinor)).toEqual([1, 1, 1]);
    expect(doc.totalBaseMinor).toBe(3);
    expect(doc.totalMinor).toBe(3);
  });

  it('refuses document types whose posting rules belong to later phases', () => {
    for (const t of DOC_TYPES.filter((d) => !DOC_TYPE_META[d].supported)) {
      expect(code(() => priceDocument({ ...inv(1), docType: t, customerId: null, bookingId: null }, pricing))).toBe(ErrorCode.UNSUPPORTED_DOCUMENT);
    }
  });
});

describe('posting rules', () => {
  it('every supported document type yields a valid, balanced journal', () => {
    const drafts: DocumentDraft[] = [
      inv(1000),
      { ...inv(1000), docType: 'CUSTOMER_CREDIT_NOTE', lines: [{ lineType: 'SALE_RETURN', amountMinor: 1000 }] },
      receipt(1000),
      { ...receipt(1000), docType: 'CUSTOMER_REFUND' },
      bill(900),
      { ...bill(900), docType: 'SUPPLIER_CREDIT_NOTE', lines: [{ lineType: 'PURCHASE_RETURN', amountMinor: 900 }] },
      supplierPayment(900),
      { ...supplierPayment(900), docType: 'SUPPLIER_REFUND' },
      { docType: 'EXPENSE', docDate: DATE, currency: 'EGP', moneyAccountId: 'M1', paymentMethod: 'CASH', lines: [{ lineType: 'EXPENSE', amountMinor: 50, expenseCategoryId: 'E1' }] },
      { docType: 'MONEY_TRANSFER', docDate: DATE, currency: 'EGP', reasonCode: 'ACCOUNT_TRANSFER', moneyAccountId: 'M1', counterMoneyAccountId: 'M2', lines: [{ lineType: 'TRANSFER', amountMinor: 50 }] },
      { docType: 'BALANCE_APPLICATION', docDate: DATE, currency: 'EGP', customerId: 'C1', lines: [{ lineType: 'APPLICATION', amountMinor: 50, bookingId: 'B1' }] },
      { docType: 'OPENING_BALANCE', docDate: DATE, currency: 'EGP', reasonCode: 'OPENING_DEBIT', customerId: 'C1', lines: [{ lineType: 'OPENING', amountMinor: 50 }] },
    ];
    for (const d of drafts) expect(() => validateJournal(journalOf(d), chart)).not.toThrow();
    expect(drafts.map((d) => d.docType).sort()).toEqual(DOC_TYPES.filter((t) => DOC_TYPE_META[t].supported).sort());
  });

  it('maps line types to the Phase 0 accounts', () => {
    const j = journalOf({
      ...inv(0),
      lines: [
        { lineType: 'FARE', amountMinor: 100 },
        { lineType: 'SERVICE_FEE', amountMinor: 10 },
        { lineType: 'CANCELLATION_FEE', amountMinor: 5 },
      ],
    });
    expect(j.filter((l) => l.side === 'CREDIT').map((l) => l.accountCode)).toEqual([ACCOUNT.TICKET_SALES, ACCOUNT.SERVICE_FEES, ACCOUNT.CANCELLATION_FEES]);
    expect(j.filter((l) => l.side === 'DEBIT').every((l) => l.accountCode === ACCOUNT.RECEIVABLE && l.dims.customerId === 'C1')).toBe(true);
  });

  it('Cases A/B/C: GP = 400 regardless of payments; receivable 5,500; payable 5,100', () => {
    const base = [...journalOf(inv(1_050_000)), ...journalOf(bill(1_010_000))];
    expect(grossProfit(base)).toBe(40_000);
    const caseB = [...base, ...journalOf(receipt(500_000))];
    expect(grossProfit(caseB)).toBe(40_000);
    expect(balanceOf(caseB, ACCOUNT.RECEIVABLE)).toBe(550_000);
    const caseC = [...base, ...journalOf(supplierPayment(500_000))];
    expect(grossProfit(caseC)).toBe(40_000);
    expect(-balanceOf(caseC, ACCOUNT.PAYABLE)).toBe(510_000);
    const caseA = [...base, ...journalOf(receipt(1_050_000)), ...journalOf(supplierPayment(1_010_000))];
    expect(grossProfit(caseA)).toBe(40_000);
    expect(balanceOf(caseA, ACCOUNT.CASH)).toBe(40_000);
  });

  it('INV-5 (property): settlement documents never touch revenue, cost or expense accounts', () => {
    const settlementTypes = ['CUSTOMER_RECEIPT', 'CUSTOMER_REFUND', 'SUPPLIER_PAYMENT', 'SUPPLIER_REFUND'] as const;
    fc.assert(
      fc.property(fc.constantFrom(...settlementTypes), fc.array(fc.integer({ min: 1, max: 1e9 }), { minLength: 1, maxLength: 5 }), (docType, amounts) => {
        const isCustomer = docType.startsWith('CUSTOMER');
        const j = journalOf({
          docType, docDate: DATE, currency: 'EGP', moneyAccountId: 'M1', paymentMethod: 'CASH',
          customerId: isCustomer ? 'C1' : null, supplierId: isCustomer ? null : 'S1',
          lines: amounts.map((amountMinor, i) => ({ lineType: 'SETTLEMENT' as const, amountMinor, bookingId: i % 2 ? `B${i}` : null })),
        });
        expect(grossProfit(j)).toBe(0);
        expect(j.every((l) => [ACCOUNT.CASH, ACCOUNT.RECEIVABLE, ACCOUNT.PAYABLE].includes(l.accountCode as never))).toBe(true);
        validateJournal(j, chart);
      }),
    );
  });

  it('Case H: USD payable settled at a new rate books realised FX below gross profit', () => {
    const usdBill = journalOf({ ...bill(20_000), currency: 'USD', exchangeRate: '50.50' });
    const usdPay = journalOf({
      ...supplierPayment(20_000), currency: 'USD', exchangeRate: '51.00',
      lines: [{ lineType: 'SETTLEMENT', amountMinor: 20_000, bookingId: 'B1', carryingBaseMinor: 1_010_000 }],
    });
    validateJournal(usdPay, chart);
    const fx = usdPay.find((l) => l.accountCode === ACCOUNT.FX)!;
    expect(fx).toMatchObject({ side: 'DEBIT', baseAmountMinor: 10_000, currency: 'EGP' });
    const all = [...journalOf(inv(1_050_000)), ...usdBill, ...usdPay];
    expect(grossProfit(all)).toBe(40_000);
    const usdPayable = all.filter((l) => l.accountCode === ACCOUNT.PAYABLE).reduce((s, l) => s + (l.side === 'CREDIT' ? l.amountMinor : -l.amountMinor), 0);
    expect(usdPayable).toBe(0);
  });

  it('a FX gain is credited', () => {
    const j = journalOf({
      ...receipt(20_000), currency: 'USD', exchangeRate: '51',
      lines: [{ lineType: 'SETTLEMENT', amountMinor: 20_000, carryingBaseMinor: 1_010_000 }],
    });
    expect(j.find((l) => l.accountCode === ACCOUNT.FX)).toMatchObject({ side: 'CREDIT', baseAmountMinor: 10_000 });
  });

  it('Case D/E/G: cancellation with fees nets to GP 200 and cash 200 once settled', () => {
    const lines = [
      ...journalOf(inv(1_050_000)), ...journalOf(bill(1_010_000)), ...journalOf(receipt(1_050_000)), ...journalOf(supplierPayment(1_010_000)),
      ...journalOf({ ...inv(0), docType: 'CUSTOMER_CREDIT_NOTE', lines: [{ lineType: 'SALE_RETURN', amountMinor: 1_050_000 }] }),
      ...journalOf({ ...inv(0), lines: [{ lineType: 'CANCELLATION_FEE', amountMinor: 50_000 }] }),
      ...journalOf({ ...bill(0), docType: 'SUPPLIER_CREDIT_NOTE', lines: [{ lineType: 'PURCHASE_RETURN', amountMinor: 1_010_000 }] }),
      ...journalOf({ ...bill(0), lines: [{ lineType: 'SUPPLIER_PENALTY', amountMinor: 30_000 }] }),
      ...journalOf({ ...receipt(1_000_000), docType: 'CUSTOMER_REFUND' }),
      ...journalOf({ ...supplierPayment(980_000), docType: 'SUPPLIER_REFUND' }),
    ];
    expect(grossProfit(lines)).toBe(20_000);
    expect(balanceOf(lines, ACCOUNT.CASH)).toBe(20_000);
    expect(balanceOf(lines, ACCOUNT.RECEIVABLE)).toBe(0);
    expect(balanceOf(lines, ACCOUNT.PAYABLE)).toBe(0);
  });
});

describe('planReversal', () => {
  const original = { id: 'D1', docType: 'CUSTOMER_RECEIPT' as const, docDate: DATE, isReversal: false, reversedById: null };
  const j = journalOf(receipt(500_000));

  it('mirrors the journal so the pair nets to zero (INV-7)', () => {
    const rev = planReversal(original, j, { reversalDate: '2026-09-05', reason: 'Cheque bounced' });
    for (const acc of [ACCOUNT.CASH, ACCOUNT.RECEIVABLE]) expect(balanceOf([...j, ...rev], acc)).toBe(0);
  });

  it('refuses double reversal, reversing a reversal, missing reason and back-dating', () => {
    expect(code(() => planReversal({ ...original, reversedById: 'D2' }, j, { reversalDate: DATE, reason: 'again' }))).toBe(ErrorCode.ALREADY_REVERSED);
    expect(code(() => planReversal({ ...original, isReversal: true }, j, { reversalDate: DATE, reason: 'undo' }))).toBe(ErrorCode.CANNOT_REVERSE_REVERSAL);
    expect(code(() => planReversal(original, j, { reversalDate: DATE, reason: ' ' }))).toBe(ErrorCode.VALIDATION);
    expect(code(() => planReversal(original, j, { reversalDate: '2026-08-31', reason: 'early' }))).toBe(ErrorCode.VALIDATION);
  });
});
