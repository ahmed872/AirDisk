import { ErrorCode } from '@airdesk/domain';
import { describe, expect, it } from 'vitest';
import { runIntegrityChecks } from '../src';
import { actor, auditActions, bookingFinancials, count, doc, fixtures, ready, userWithRoles } from './helpers';

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
  return 'NO_ERROR';
};

async function world() {
  const base = await ready();
  const f = fixtures(base.env, base.admin.userId);
  const cash = f.moneyAccount('EGP');
  const post = base.env.backend.svc.posting;
  return { ...base, f, cash, post, db: base.env.backend.svc.deps.db };
}

describe('Phase 0 regression scenarios through the real posting service', () => {
  it('Case A — fully paid both sides: GP 400, AR 0, AP 0', async () => {
    const { env, f, cash, post, admin } = await world();
    const c = f.customer(), s = f.supplier(), b = f.booking(c);
    post.post(admin, doc.invoice(c, b, 1_050_000));
    post.post(admin, doc.bill(s, b, 1_010_000));
    post.post(admin, doc.receipt(c, b, cash, 1_050_000));
    post.post(admin, doc.supplierPayment(s, b, cash, 1_010_000));
    expect(bookingFinancials(env, b)).toMatchObject({ sales: 1_050_000, cost: 1_010_000, gp: 40_000, ar: 0, ap: 0 });
  });

  it('Case B — customer paid 5,000: receivable 5,500, GP still 400', async () => {
    const { env, f, cash, post, admin } = await world();
    const c = f.customer(), s = f.supplier(), b = f.booking(c);
    post.post(admin, doc.invoice(c, b, 1_050_000));
    post.post(admin, doc.bill(s, b, 1_010_000));
    post.post(admin, doc.receipt(c, b, cash, 500_000));
    expect(bookingFinancials(env, b)).toMatchObject({ gp: 40_000, paid: 500_000, ar: 550_000 });
  });

  it('Case C — supplier paid 5,000: payable 5,100, GP unchanged by the payment (BR-FIN-03)', async () => {
    const { env, f, cash, post, admin } = await world();
    const c = f.customer(), s = f.supplier(), b = f.booking(c);
    post.post(admin, doc.invoice(c, b, 1_050_000));
    post.post(admin, doc.bill(s, b, 1_010_000));
    const before = bookingFinancials(env, b).gp;
    post.post(admin, doc.supplierPayment(s, b, cash, 500_000));
    expect(bookingFinancials(env, b)).toMatchObject({ gp: 40_000, supplierPaid: 500_000, ap: 510_000 });
    expect(bookingFinancials(env, b).gp).toBe(before);
    const summary = env.backend.svc.ledger.computeSummary('2026-09-01', '2026-09-30');
    expect(summary.expenses).toBe(0); // the supplier payment is NOT an expense
  });

  it('Brief §8 — four instalments are four independent receipts, nothing overwritten', async () => {
    const { env, f, cash, post, admin, db } = await world();
    const c = f.customer(), b = f.booking(c);
    post.post(admin, doc.invoice(c, b, 1_050_000));
    const nos = [500_000, 200_000, 100_000, 250_000].map((a) => post.post(admin, doc.receipt(c, b, cash, a)).docNo);
    expect(nos).toEqual(['RCT-2026-000001', 'RCT-2026-000002', 'RCT-2026-000003', 'RCT-2026-000004']);
    expect(bookingFinancials(env, b)).toMatchObject({ paid: 1_050_000, ar: 0 });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM fin_document WHERE doc_type = 'CUSTOMER_RECEIPT'`).get() as { n: number }).n).toBe(4);
  });

  it('Cases D/E/G — cancellation with office fee 500 and supplier penalty 300: GP 200, cash 200, period view', async () => {
    const { env, f, cash, post, admin } = await world();
    const c = f.customer(), s = f.supplier(), b = f.booking(c);
    post.post(admin, doc.invoice(c, b, 1_050_000));
    post.post(admin, doc.bill(s, b, 1_010_000));
    post.post(admin, doc.receipt(c, b, cash, 1_050_000));
    post.post(admin, doc.supplierPayment(s, b, cash, 1_010_000));
    // Cancellation in the NEXT month (clock is 2026-09-28; move to October so dates are current).
    env.clock.set('2026-10-06T09:00:00.000Z');
    post.post(admin, doc.creditNote(c, b, 1_050_000, '2026-10-05'));
    post.post(admin, doc.invoice(c, b, 50_000, '2026-10-05', 'CANCELLATION_FEE'));
    post.post(admin, doc.supplierCredit(s, b, 1_010_000, '2026-10-05'));
    post.post(admin, doc.bill(s, b, 30_000, '2026-10-05', 'SUPPLIER_PENALTY'));
    expect(bookingFinancials(env, b)).toMatchObject({ gp: 20_000, ar: -1_000_000, ap: -980_000 });
    post.post(admin, doc.refund(c, b, cash, 1_000_000, '2026-10-06'));
    post.post(admin, doc.supplierRefund(s, b, cash, 980_000, '2026-10-06'));
    expect(bookingFinancials(env, b)).toMatchObject({ sales: 50_000, cost: 30_000, gp: 20_000, ar: 0, ap: 0 });
    const cashBal = (env.backend.svc.deps.db.prepare(`SELECT balance_minor FROM v_money_account_balance WHERE money_account_id = ?`).get(cash) as { balance_minor: number }).balance_minor;
    expect(cashBal).toBe(20_000); // INV-6: settled booking → cash == gross profit
    const sep = env.backend.svc.ledger.computeSummary('2026-09-01', '2026-09-30');
    const oct = env.backend.svc.ledger.computeSummary('2026-10-01', '2026-10-31');
    expect(sep.grossProfit).toBe(40_000); // September is not restated (BR-FIN-06)
    expect(oct.grossProfit).toBe(-20_000);
    expect(oct.collections).toBe(-1_000_000); // refunds reduce collections, cash basis
  });

  it('Case F/K — price decrease after full payment is a credit note + refund; increase is an extra invoice', async () => {
    const { env, f, cash, post, admin } = await world();
    const c = f.customer(), s = f.supplier(), b = f.booking(c);
    post.post(admin, doc.invoice(c, b, 1_050_000));
    post.post(admin, doc.bill(s, b, 1_010_000));
    post.post(admin, doc.receipt(c, b, cash, 1_050_000));
    post.post(admin, doc.invoice(c, b, 35_000, '2026-09-10', 'CHANGE_FEE'));
    post.post(admin, doc.bill(s, b, 25_000, '2026-09-10'));
    expect(bookingFinancials(env, b)).toMatchObject({ gp: 50_000, ar: 35_000 });
    post.post(admin, doc.creditNote(c, b, 35_000, '2026-09-11', 'DISCOUNT'));
    expect(bookingFinancials(env, b)).toMatchObject({ gp: 15_000, ar: 0 });
  });

  it('Case L — supplier changed after a partial supplier payment: per-supplier balances are correct', async () => {
    const { env, f, cash, post, admin, db } = await world();
    const c = f.customer(), s1 = f.supplier(), s2 = f.supplier(), b = f.booking(c);
    post.post(admin, doc.invoice(c, b, 1_050_000));
    post.post(admin, doc.bill(s1, b, 1_010_000));
    post.post(admin, doc.supplierPayment(s1, b, cash, 400_000));
    post.post(admin, doc.supplierCredit(s1, b, 1_010_000, '2026-09-05'));
    post.post(admin, doc.bill(s2, b, 1_000_000, '2026-09-05'));
    expect(bookingFinancials(env, b).gp).toBe(50_000);
    const bal = (sid: string) => (db.prepare('SELECT balance_minor FROM v_supplier_balance WHERE supplier_id = ?').get(sid) as { balance_minor: number }).balance_minor;
    expect(bal(s1)).toBe(-400_000); // S1 now owes us what we had paid
    expect(bal(s2)).toBe(1_000_000);
  });

  it('Case H — USD supplier bill, paid at a new rate: GP 400, USD payable 0, FX loss 100 below GP', async () => {
    const { env, f, post, admin, db } = await world();
    const c = f.customer(), s = f.supplier('USD'), b = f.booking(c);
    const usdBank = f.moneyAccount('USD');
    post.post(admin, doc.invoice(c, b, 1_050_000));
    post.post(admin, { ...doc.bill(s, b, 20_000), currency: 'USD', exchangeRate: '50.50' });
    post.post(admin, {
      ...doc.supplierPayment(s, b, usdBank, 20_000, '2026-09-20'), currency: 'USD', exchangeRate: '51.00',
      lines: [{ lineType: 'SETTLEMENT', amountMinor: 20_000, bookingId: b, carryingBaseMinor: 1_010_000 }],
    });
    expect(bookingFinancials(env, b).gp).toBe(40_000);
    const usd = db.prepare(`SELECT balance_minor FROM v_supplier_balance WHERE supplier_id = ? AND currency_code = 'USD'`).get(s) as { balance_minor: number };
    expect(usd.balance_minor).toBe(0);
    const summary = env.backend.svc.ledger.computeSummary('2026-09-01', '2026-09-30');
    expect(summary).toMatchObject({ grossProfit: 40_000, otherIncome: -10_000, netProfit: 30_000 });
  });

  it('a foreign-currency document without a rate is refused (never assumes 1)', async () => {
    const { f, post, admin } = await world();
    const c = f.customer(), b = f.booking(c);
    expect(codeOf(() => post.post(admin, { ...doc.invoice(c, b, 100), currency: 'USD' }))).toBe(ErrorCode.RATE_REQUIRED);
  });

  it('expenses reduce net profit, not gross profit', async () => {
    const { env, f, cash, post, admin } = await world();
    post.post(admin, {
      docType: 'EXPENSE', docDate: '2026-09-15', currency: 'EGP', moneyAccountId: cash, paymentMethod: 'CASH',
      lines: [{ lineType: 'EXPENSE', amountMinor: 300_000, expenseCategoryId: f.expenseCategory('RENT') }],
    });
    expect(env.backend.svc.ledger.computeSummary('2026-09-01', '2026-09-30')).toMatchObject({ grossProfit: 0, expenses: 300_000, netProfit: -300_000 });
  });

  it('the whole ledger passes every integrity invariant after the scenarios', async () => {
    const { env, f, cash, post, admin } = await world();
    const c = f.customer(), s = f.supplier(), b = f.booking(c);
    post.post(admin, doc.invoice(c, b, 1_050_000));
    post.post(admin, doc.bill(s, b, 1_010_000));
    const r = post.post(admin, doc.receipt(c, b, cash, 500_000));
    post.reverse(admin, { documentId: r.id, reversalDate: '2026-09-28', reason: 'Cheque bounced' });
    const report = runIntegrityChecks(env.backend.svc.deps.db, env.backend.svc.deps.audit, env.clock);
    expect(report.checks.filter((x) => !x.ok)).toEqual([]);
    const tb = env.backend.svc.ledger.trialBalance(admin, '2026-12-31');
    expect(tb.reduce((s2, x) => s2 + x.debitBaseMinor, 0)).toBe(tb.reduce((s2, x) => s2 + x.creditBaseMinor, 0));
  });
});

describe('posting rules enforced by the service', () => {
  it('reversal restores the receivable, keeps the original, and cannot be repeated or reversed', async () => {
    const { env, f, cash, post, admin } = await world();
    const c = f.customer(), b = f.booking(c);
    post.post(admin, doc.invoice(c, b, 1_050_000));
    const r = post.post(admin, doc.receipt(c, b, cash, 500_000));
    const rev = post.reverse(admin, { documentId: r.id, reversalDate: '2026-09-28', reason: 'Cheque bounced' });
    expect(rev).toMatchObject({ isReversal: true, reversalOfId: r.id, totalMinor: 500_000, description: 'Cheque bounced' });
    expect(post.get(r.id).reversedById).toBe(rev.id);
    expect(bookingFinancials(env, b)).toMatchObject({ paid: 0, ar: 1_050_000 });
    expect(codeOf(() => post.reverse(admin, { documentId: r.id, reversalDate: '2026-09-28', reason: 'again' }))).toBe(ErrorCode.ALREADY_REVERSED);
    expect(codeOf(() => post.reverse(admin, { documentId: rev.id, reversalDate: '2026-09-28', reason: 'undo' }))).toBe(ErrorCode.CANNOT_REVERSE_REVERSAL);
    expect(auditActions(env)).toContain('document.reversed');
  });

  it('Case M — a sales agent can receive a payment but cannot reverse it; nothing is written', async () => {
    const { env, f, cash, post, adminSession } = await world();
    const c = f.customer(), b = f.booking(c);
    const agent = actor(env, await userWithRoles(env, adminSession, 'agent', ['SALES_AGENT']));
    const r = post.post(agent, doc.receipt(c, b, cash, 100_000, '2026-09-28'));
    const docsBefore = count(env, 'fin_document');
    const linesBefore = count(env, 'journal_line');
    expect(codeOf(() => post.reverse(agent, { documentId: r.id, reversalDate: '2026-09-28', reason: 'pocket it' }))).toBe(ErrorCode.FORBIDDEN);
    expect(codeOf(() => post.post(agent, doc.refund(c, b, cash, 100_000, '2026-09-28')))).toBe(ErrorCode.FORBIDDEN);
    expect(codeOf(() => post.post(agent, doc.supplierPayment(f.supplier(), b, cash, 1, '2026-09-28')))).toBe(ErrorCode.FORBIDDEN);
    expect(count(env, 'fin_document')).toBe(docsBefore);
    expect(count(env, 'journal_line')).toBe(linesBefore);
    expect(auditActions(env).filter((a) => a === 'auth.permission_denied').length).toBeGreaterThanOrEqual(3);
  });

  it('backdating beyond the allowed window needs finance.backdate', async () => {
    const { env, f, cash, post, adminSession } = await world();
    const c = f.customer(), b = f.booking(c);
    const agent = actor(env, await userWithRoles(env, adminSession, 'agent', ['SALES_AGENT']));
    expect(codeOf(() => post.post(agent, doc.receipt(c, b, cash, 100, '2026-09-01')))).toBe(ErrorCode.FORBIDDEN);
    expect(() => post.post(agent, doc.receipt(c, b, cash, 100, '2026-09-26'))).not.toThrow();
  });

  it('nothing can be posted into a locked period (service and database)', async () => {
    const { env, f, cash, post, admin, adminSession, db } = await world();
    const c = f.customer(), b = f.booking(c);
    const lock = await env.call('company.setLockDate', { lockDate: '2026-09-15' }, adminSession);
    expect(lock.ok).toBe(true);
    expect(codeOf(() => post.post(admin, doc.receipt(c, b, cash, 100, '2026-09-15')))).toBe(ErrorCode.PERIOD_LOCKED);
    expect(() => post.post(admin, doc.receipt(c, b, cash, 100, '2026-09-16'))).not.toThrow();
    expect(() =>
      db.prepare(`INSERT INTO fin_document (id, doc_type, doc_no, doc_date, customer_id, currency_code, exchange_rate, total_minor, total_base_minor, created_at, created_by)
                  VALUES ('X', 'CUSTOMER_INVOICE', 'X', '2026-09-01', ?, 'EGP', '1', 1, 1, 'now', ?)`).run(c, admin.userId),
    ).toThrow(/locked financial period/);
    const unlockNoReason = await env.call('company.setLockDate', { lockDate: '2026-09-01' }, adminSession);
    expect(!unlockNoReason.ok && unlockNoReason.error.code).toBe(ErrorCode.VALIDATION);
    const unlock = await env.call('company.setLockDate', { lockDate: '2026-09-01', reason: 'Correct a mistyped receipt' }, adminSession);
    expect(unlock.ok).toBe(true);
    expect(auditActions(env)).toEqual(expect.arrayContaining(['period.locked', 'period.unlocked']));
  });

  it('posted documents and journal lines are immutable at the database level', async () => {
    const { f, cash, post, admin, db } = await world();
    const c = f.customer(), b = f.booking(c);
    const r = post.post(admin, doc.receipt(c, b, cash, 500_000));
    expect(() => db.prepare('UPDATE fin_document SET total_minor = 1 WHERE id = ?').run(r.id)).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM fin_document WHERE id = ?').run(r.id)).toThrow(/cannot be deleted/);
    expect(() => db.prepare('UPDATE journal_line SET debit_minor = 1').run()).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM journal_entry').run()).toThrow(/cannot be deleted/);
    expect(() => db.prepare('DELETE FROM customer WHERE id = ?').run(c)).toThrow(/never deleted/);
  });

  it('money account currency must match the document currency (BR-PAY-05)', async () => {
    const { f, post, admin } = await world();
    const c = f.customer(), b = f.booking(c);
    const usd = f.moneyAccount('USD');
    expect(codeOf(() => post.post(admin, doc.receipt(c, b, usd, 100)))).toBe(ErrorCode.CURRENCY_MISMATCH);
  });

  it('document types scheduled for later phases are refused', async () => {
    const { cash, post, admin } = await world();
    expect(
      codeOf(() => post.post(admin, { docType: 'FX_ADJUSTMENT', docDate: '2026-09-28', currency: 'EGP', lines: [{ lineType: 'FX', amountMinor: 1 }], moneyAccountId: cash })),
    ).toBe(ErrorCode.UNSUPPORTED_DOCUMENT);
  });

  it('idempotent commands: the same commandId never posts twice', async () => {
    const { f, cash, post, admin, env } = await world();
    const c = f.customer(), b = f.booking(c);
    const a = post.post(admin, doc.receipt(c, b, cash, 100), { commandId: '01JCMD00000000000000000001' });
    const again = post.post(admin, doc.receipt(c, b, cash, 100), { commandId: '01JCMD00000000000000000001' });
    expect(again.id).toBe(a.id);
    expect(count(env, 'fin_document')).toBe(1);
  });

  it('base currency is frozen once documents exist', async () => {
    const { env, f, cash, post, admin, adminSession } = await world();
    const c = f.customer(), b = f.booking(c);
    const profile = (await env.call<Record<string, unknown> & { rowVersion: number }>('company.get', {}, adminSession)).data!;
    const { baseCurrencyFrozen: _frozen, financialLockDate: _lock, logoBase64: _logo, rowVersion, ...editable } = profile;
    const beforePosting = await env.call('company.update', { profile: { ...editable, baseCurrencyCode: 'SAR' }, rowVersion }, adminSession);
    expect(beforePosting.ok).toBe(true);
    const back = (await env.call<{ rowVersion: number }>('company.get', {}, adminSession)).data!;
    await env.call('company.update', { profile: { ...editable, baseCurrencyCode: 'EGP' }, rowVersion: back.rowVersion }, adminSession);
    post.post(admin, doc.receipt(c, b, cash, 100));
    const latest = (await env.call<{ rowVersion: number }>('company.get', {}, adminSession)).data!;
    const after = await env.call('company.update', { profile: { ...editable, baseCurrencyCode: 'USD' }, rowVersion: latest.rowVersion }, adminSession);
    expect(!after.ok && after.error.code).toBe(ErrorCode.BASE_CURRENCY_FROZEN);
    const stale = await env.call('company.update', { profile: editable, rowVersion: 1 }, adminSession);
    expect(!stale.ok && stale.error.code).toBe(ErrorCode.STALE_RECORD);
  });
});
