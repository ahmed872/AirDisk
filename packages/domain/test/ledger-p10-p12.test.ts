import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ACCOUNT, ChartOfAccounts, ErrorCode, GROSS_PROFIT_CLASSES, buildJournal, mirrorJournal, priceDocument, validateJournal, type DocumentDraft, type DocumentLineDraft, type JournalLineDraft } from '../src';

/** Phase 0 §04 posting rules P10 (money transfer), P11 (balance application), P12 (opening balance). */
const chart = new ChartOfAccounts();
const pricing = { baseCurrency: 'EGP', minorUnitOf: () => 2 };
const posting = { baseCurrency: 'EGP', expenseAccountFor: () => ACCOUNT.EXP_RENT };
const journalOf = (d: DocumentDraft) => {
  const j = buildJournal(priceDocument(d, pricing), posting);
  validateJournal(j, chart);
  return j;
};
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as { code?: string; details?: { reason?: string } }).code; }
  return 'NO_ERROR';
};
const net = (j: JournalLineDraft[], account: string, pick: (l: JournalLineDraft) => boolean = () => true) =>
  j.filter((l) => l.accountCode === account && pick(l)).reduce((s, l) => s + (l.side === 'DEBIT' ? l.baseAmountMinor : -l.baseAmountMinor), 0);
const profitOf = (j: JournalLineDraft[]) => j.filter((l) => GROSS_PROFIT_CLASSES.includes(chart.get(l.accountCode)!.accountClass) || chart.get(l.accountCode)!.accountClass === 'EXPENSE')
  .reduce((s, l) => s + (l.side === 'CREDIT' ? l.baseAmountMinor : -l.baseAmountMinor), 0);
const D = '2026-01-01';
const transfer = (kind: string, amount: number, extra: Partial<DocumentDraft> = {}): DocumentDraft => ({
  docType: 'MONEY_TRANSFER', docDate: D, currency: 'EGP', reasonCode: kind, moneyAccountId: 'CASH', lines: [{ lineType: 'TRANSFER', amountMinor: amount }], ...extra,
});
const opening = (side: 'OPENING_DEBIT' | 'OPENING_CREDIT', amount: number, extra: Partial<DocumentDraft>): DocumentDraft => ({
  docType: 'OPENING_BALANCE', docDate: D, currency: 'EGP', reasonCode: side, lines: [{ lineType: 'OPENING', amountMinor: amount }], ...extra,
});

describe('P10 money transfer', () => {
  it('moves money between accounts with no effect on profit or parties', () => {
    const j = journalOf(transfer('ACCOUNT_TRANSFER', 50_000, { counterMoneyAccountId: 'BANK' }));
    expect(net(j, ACCOUNT.CASH, (l) => l.dims.moneyAccountId === 'BANK')).toBe(50_000);
    expect(net(j, ACCOUNT.CASH, (l) => l.dims.moneyAccountId === 'CASH')).toBe(-50_000);
    expect(profitOf(j)).toBe(0);
  });
  it('records owner capital and drawings against 3200', () => {
    const cap = journalOf(transfer('OWNER_CAPITAL', 100_000));
    expect(net(cap, ACCOUNT.CASH)).toBe(100_000);
    expect(net(cap, ACCOUNT.OWNER)).toBe(-100_000);
    const draw = journalOf(transfer('OWNER_DRAWING', 30_000));
    expect(net(draw, ACCOUNT.CASH)).toBe(-30_000);
    expect(net(draw, ACCOUNT.OWNER)).toBe(30_000);
    expect(profitOf(cap) + profitOf(draw)).toBe(0);
  });
  it('a foreign-currency transfer leaves its source at the carrying value, balanced', () => {
    const d = transfer('ACCOUNT_TRANSFER', 10_000, { currency: 'USD', exchangeRate: '50', counterMoneyAccountId: 'BANK', lines: [{ lineType: 'TRANSFER', amountMinor: 10_000, carryingBaseMinor: 480_000 }] });
    const j = journalOf(d);
    expect(j.every((l) => l.baseAmountMinor === 480_000)).toBe(true);
  });
  it('rejects malformed transfers', () => {
    expect(code(() => journalOf(transfer('ACCOUNT_TRANSFER', 1, {})))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf(transfer('ACCOUNT_TRANSFER', 1, { counterMoneyAccountId: 'CASH' })))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf(transfer('GIFT', 1)))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf(transfer('OWNER_CAPITAL', 1, { customerId: 'C1' })))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf(transfer('OWNER_CAPITAL', 1, { counterMoneyAccountId: 'BANK' })))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf({ ...transfer('OWNER_CAPITAL', 1), lines: [{ lineType: 'TRANSFER', amountMinor: 1, bookingId: 'B1' }] }))).toBe(ErrorCode.VALIDATION);
  });
});

describe('P12 opening balances', () => {
  it('customer debt, customer advance, supplier payable, supplier advance and cash all balance against 3100', () => {
    const cases: [DocumentDraft, string, number][] = [
      [opening('OPENING_DEBIT', 70_000, { customerId: 'C1' }), ACCOUNT.RECEIVABLE, 70_000],
      [opening('OPENING_CREDIT', 5_000, { customerId: 'C1' }), ACCOUNT.RECEIVABLE, -5_000],
      [opening('OPENING_CREDIT', 90_000, { supplierId: 'S1' }), ACCOUNT.PAYABLE, -90_000],
      [opening('OPENING_DEBIT', 2_000, { supplierId: 'S1' }), ACCOUNT.PAYABLE, 2_000],
      [opening('OPENING_DEBIT', 25_000, { moneyAccountId: 'CASH' }), ACCOUNT.CASH, 25_000],
    ];
    for (const [d, account, expected] of cases) {
      const j = journalOf(d);
      expect(net(j, account)).toBe(expected);
      expect(net(j, ACCOUNT.OPENING_EQUITY)).toBe(-expected);
      expect(profitOf(j)).toBe(0);
      expect(j.filter((l) => l.accountCode !== ACCOUNT.OPENING_EQUITY).every((l) => (l.dims.bookingId ?? null) === null)).toBe(true);
    }
  });
  it('rejects ambiguous or impossible openings', () => {
    expect(code(() => journalOf(opening('OPENING_DEBIT', 1, {})))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf(opening('OPENING_DEBIT', 1, { customerId: 'C1', supplierId: 'S1' })))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf(opening('OPENING_CREDIT', 1, { moneyAccountId: 'CASH' })))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf({ ...opening('OPENING_DEBIT', 1, { customerId: 'C1' }), lines: [{ lineType: 'OPENING', amountMinor: 1, bookingId: 'B1' }] }))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf(opening('OPENING_DEBIT', 1, { customerId: 'C1', paymentMethod: 'CASH' })))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf({ ...opening('OPENING_DEBIT', 1, { customerId: 'C1' }), reasonCode: 'X' }))).toBe(ErrorCode.VALIDATION);
  });
});

describe('P11 balance application', () => {
  const apply = (extra: Partial<DocumentDraft>, lines: DocumentLineDraft[] = [{ lineType: 'APPLICATION', amountMinor: 30_000, bookingId: 'B2' }]): DocumentDraft => ({
    docType: 'BALANCE_APPLICATION', docDate: D, currency: 'EGP', lines, ...extra,
  });
  it('customer credit on account settles a record; party balance and profit are unchanged', () => {
    const j = journalOf(apply({ customerId: 'C1' }));
    expect(net(j, ACCOUNT.RECEIVABLE, (l) => l.dims.bookingId === null)).toBe(30_000);
    expect(net(j, ACCOUNT.RECEIVABLE, (l) => l.dims.bookingId === 'B2')).toBe(-30_000);
    expect(net(j, ACCOUNT.RECEIVABLE)).toBe(0);
    expect(profitOf(j)).toBe(0);
  });
  it('credit on one record moves to another record', () => {
    const j = journalOf(apply({ customerId: 'C1', bookingId: 'B1' }));
    expect(net(j, ACCOUNT.RECEIVABLE, (l) => l.dims.bookingId === 'B1')).toBe(30_000);
    expect(net(j, ACCOUNT.RECEIVABLE, (l) => l.dims.bookingId === 'B2')).toBe(-30_000);
  });
  it('supplier advance settles a record payable (mirror)', () => {
    const j = journalOf(apply({ supplierId: 'S1' }));
    expect(net(j, ACCOUNT.PAYABLE, (l) => l.dims.bookingId === 'B2')).toBe(30_000);
    expect(net(j, ACCOUNT.PAYABLE, (l) => l.dims.bookingId === null)).toBe(-30_000);
  });
  it('foreign currency: different carrying values realise FX in 7100', () => {
    const j = journalOf(apply({ customerId: 'C1', currency: 'USD', exchangeRate: '50' }, [{ lineType: 'APPLICATION', amountMinor: 10_000, bookingId: 'B2', sourceCarryingBaseMinor: 520_000, carryingBaseMinor: 490_000 }]));
    expect(net(j, ACCOUNT.FX)).toBe(-30_000);
  });
  it('rejects applications without a party, to the source record, or twice to one record', () => {
    expect(code(() => journalOf(apply({})))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf(apply({ customerId: 'C1', supplierId: 'S1' })))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf(apply({ customerId: 'C1', bookingId: 'B2' })))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf(apply({ customerId: 'C1' }, [{ lineType: 'APPLICATION', amountMinor: 1, bookingId: 'B2' }, { lineType: 'APPLICATION', amountMinor: 1, bookingId: 'B2' }])))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf(apply({ customerId: 'C1', moneyAccountId: 'CASH' })))).toBe(ErrorCode.VALIDATION);
    expect(code(() => journalOf(apply({ customerId: 'C1' }, [{ lineType: 'APPLICATION', amountMinor: 1, bookingId: null } as never])))).toBe(ErrorCode.VALIDATION);
  });
  it('generic documents cannot carry a receiving account', () => {
    expect(code(() => journalOf({ docType: 'CUSTOMER_INVOICE', docDate: D, currency: 'EGP', customerId: 'C1', counterMoneyAccountId: 'BANK', lines: [{ lineType: 'FARE', amountMinor: 1 }] }))).toBe(ErrorCode.VALIDATION);
  });
});

describe('P10–P12 properties', () => {
  it('every generated transfer/opening/application balances, never touches profit, and its mirror cancels it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e9 }), fc.integer({ min: 0, max: 7 }), (amount, pick) => {
        const drafts: DocumentDraft[] = [
          transfer('ACCOUNT_TRANSFER', amount, { counterMoneyAccountId: 'BANK' }), transfer('OWNER_CAPITAL', amount), transfer('OWNER_DRAWING', amount),
          opening('OPENING_DEBIT', amount, { customerId: 'C1' }), opening('OPENING_CREDIT', amount, { supplierId: 'S1' }), opening('OPENING_DEBIT', amount, { moneyAccountId: 'CASH' }),
          { docType: 'BALANCE_APPLICATION', docDate: D, currency: 'EGP', customerId: 'C1', lines: [{ lineType: 'APPLICATION', amountMinor: amount, bookingId: 'B9' }] },
          { docType: 'BALANCE_APPLICATION', docDate: D, currency: 'EGP', supplierId: 'S1', lines: [{ lineType: 'APPLICATION', amountMinor: amount, bookingId: 'B9' }] },
        ];
        const j = journalOf(drafts[pick]!);
        expect(profitOf(j)).toBe(0);
        const both = [...j, ...mirrorJournal(j)];
        for (const acc of new Set(j.map((l) => l.accountCode))) expect(net(both, acc)).toBe(0);
      }),
    );
  });
});
