import { useEffect, useState } from 'react';
import type { DocumentDto, MoneyAccountDto } from '@airdesk/contracts';
import { call } from '../api';
import { Alert, Modal } from '../components';
import { useI18n, type TKey } from '../i18n';
import { CurrencySelect, MoneyInput, useMoney } from '../money';
import { DocumentPrint } from '../print';

export type PayKind = 'receive' | 'refundCustomer' | 'paySupplier' | 'supplierRefund';

const COMMAND: Record<PayKind, string> = {
  receive: 'payments.receive', refundCustomer: 'payments.refundCustomer', paySupplier: 'payments.paySupplier', supplierRefund: 'payments.supplierRefund',
};
const TITLE: Record<PayKind, TKey> = { receive: 'recordPayment', refundCustomer: 'refundCustomer', paySupplier: 'paySupplier', supplierRefund: 'supplierRefund' };
const METHODS = ['CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'WALLET', 'OTHER'] as const;

export interface OpenItem {
  bookingId: string;
  bookingNo: string;
  /** What can be allocated to this record (remaining balance, or credit for refunds). */
  openMinor: number;
}

/**
 * Money in/out. Every payment becomes an immutable document; "paid" and
 * "remaining" are always recomputed from the journal afterwards. Amounts can
 * only be allocated up to what is open; anything beyond must be explicitly
 * routed on-account (needs permission) — never guessed.
 */
export function PaymentDialog({ kind, partyId, partyName, currency: initialCurrency, items, summary, canOnAccount, onAccountDueMinor = 0, onDone, onClose }: {
  kind: PayKind; partyId: string; partyName: string; currency: string; items: OpenItem[];
  summary?: { totalMinor: number; paidMinor: number; remainingMinor: number } | null;
  /** What the party owes on account (e.g. an opening balance): paying it is not an overpayment. */
  canOnAccount: boolean; onAccountDueMinor?: number; onDone: (doc: DocumentDto) => void; onClose: () => void;
}) {
  const { t, errorMessage } = useI18n();
  const m = useMoney();
  const [currency, setCurrency] = useState(initialCurrency);
  const [accounts, setAccounts] = useState<MoneyAccountDto[]>([]);
  const [accountId, setAccountId] = useState('');
  const [method, setMethod] = useState<(typeof METHODS)[number]>('CASH');
  const [amount, setAmount] = useState<number | null>(items.length === 1 ? items[0]!.openMinor || null : null);
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<DocumentDto | null>(null);
  useEffect(() => {
    call<MoneyAccountDto[]>('moneyAccounts.list', {}).then((a) => setAccounts(a), () => setAccounts([]));
  }, []);
  const usable = accounts.filter((a) => a.currencyCode === currency && a.isActive);
  useEffect(() => { if (!usable.some((a) => a.id === accountId)) setAccountId(usable[0]?.id ?? ''); }, [usable, accountId]);
  // Default allocation: fill open items in order up to the amount.
  useEffect(() => {
    let left = amount ?? 0;
    const next: Record<string, number> = {};
    for (const i of items) {
      const a = Math.min(left, Math.max(0, i.openMinor));
      if (a > 0) next[i.bookingId] = a;
      left -= a;
    }
    setAlloc(next);
  }, [amount, items]);
  const allocated = Object.values(alloc).reduce((s, v) => s + v, 0);
  const onAccountMinor = Math.max(0, (amount ?? 0) - allocated);
  const overpaid = Math.max(0, onAccountMinor - onAccountDueMinor);
  const invalid = !amount || amount <= 0 || !accountId || allocated > (amount ?? 0) || (overpaid > 0 && !canOnAccount);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const doc = await call<DocumentDto>(COMMAND[kind] as never, {
        partyId, currency, amountMinor: amount, moneyAccountId: accountId, paymentMethod: method, reference: reference || null, notes: notes || null,
        date: date || null, allocations: Object.entries(alloc).filter(([, v]) => v > 0).map(([bookingId, amountMinor]) => ({ bookingId, amountMinor })),
        onAccountMinor,
      });
      setDone(doc);
      onDone(doc);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (done) return <DocumentPrint doc={done} onClose={onClose} />;
  return (
    <Modal wide title={`${t(TITLE[kind])} — ${partyName}`} onClose={onClose} testId="payment-dialog"
      footer={<><button className="primary" disabled={busy || invalid} onClick={submit} data-testid="pay-submit">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {summary && (
        <div className="money-summary" data-testid="pay-summary">
          <div><span>{t('total')}</span><strong className="ltr">{m.fmt(summary.totalMinor, currency)}</strong></div>
          <div><span>{t('paid')}</span><strong className="ltr">{m.fmt(summary.paidMinor, currency)}</strong></div>
          <div className={summary.remainingMinor > 0 ? 'due' : ''}><span>{t('remaining')}</span><strong className="ltr">{m.fmt(summary.remainingMinor, currency)}</strong></div>
        </div>
      )}
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid">
        <CurrencySelect label={t('currency')} value={currency} onChange={setCurrency} disabled={items.length > 0} testId="pay-currency" />
        <MoneyInput label={t('amount')} value={amount} currency={currency} onChange={setAmount} testId="pay-amount" required />
        <label>{t('moneyAccount')}
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} data-testid="pay-account">
            {usable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          {!usable.length && <span className="field-error">{t('noMoneyAccounts')}</span>}
        </label>
        <label>{t('method')}
          <select value={method} onChange={(e) => setMethod(e.target.value as never)} data-testid="pay-method">
            {METHODS.map((x) => <option key={x} value={x}>{t(x)}</option>)}
          </select>
        </label>
        <label>{t('reference')}<input className="ltr" value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} data-testid="pay-reference" /></label>
        <label>{t('paymentDate')}<input type="date" className="ltr" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="span-all">{t('notes')}<input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} /></label>
      </div>
      {items.length > 0 && (
        <>
          <h3>{t('allocateTo')}</h3>
          <table>
            <thead><tr><th>{t('recordNo')}</th><th className="num">{t('openBalance')}</th><th className="num">{t('allocate')}</th></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.bookingId}>
                  <td className="ltr">{i.bookingNo}</td>
                  <td className="num ltr">{m.fmt(i.openMinor, currency)}</td>
                  <td><AllocInput value={alloc[i.bookingId] ?? 0} max={i.openMinor} currency={currency} onChange={(v) => setAlloc({ ...alloc, [i.bookingId]: v })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {(() => {
        // Money going out of a cash box/wallet cannot exceed what it holds in real life: warn (the office may be entering payments out of order).
        const acc = usable.find((a) => a.id === accountId);
        const outflow = kind === 'refundCustomer' || kind === 'paySupplier';
        return outflow && acc && acc.balanceMinor !== null && (acc.accountType === 'CASH' || acc.accountType === 'WALLET') && (amount ?? 0) > acc.balanceMinor
          ? <Alert kind="warn">{t('cashWillBeNegative')}: <span className="ltr">{m.fmt(acc.balanceMinor, acc.currencyCode)}</span></Alert> : null;
      })()}
      {onAccountDueMinor > 0 && <p className="hint">{t('onAccountDue')}: <span className="ltr">{m.fmt(onAccountDueMinor, currency)}</span></p>}
      {onAccountMinor > 0 && (
        <Alert kind={overpaid === 0 ? 'ok' : canOnAccount ? 'warn' : 'error'}>{t('onAccount')}: <span className="ltr">{m.fmt(onAccountMinor, currency)}</span>{overpaid > 0 && !canOnAccount && ` — ${t('noPermission')}`}</Alert>
      )}
    </Modal>
  );
}

function AllocInput({ value, max, currency, onChange }: { value: number; max: number; currency: string; onChange: (v: number) => void }) {
  const m = useMoney();
  const [text, setText] = useState(m.toInput(value, currency));
  useEffect(() => {
    if (m.parse(text, currency) !== value) setText(m.toInput(value, currency));
    // Only re-sync when the value changes from outside (auto-allocation).
  }, [value, currency]);
  return (
    <input className="ltr num compact" value={text} onChange={(e) => {
      setText(e.target.value);
      const v = m.parse(e.target.value, currency);
      if (v !== null) onChange(Math.min(v, Math.max(0, max)));
    }} />
  );
}
