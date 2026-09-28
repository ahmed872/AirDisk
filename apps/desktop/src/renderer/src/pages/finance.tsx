import { useState } from 'react';
import type { CurrencyDto, CustomerDto, ExchangeRateDto, ExpenseCategoryDto, MoneyAccountDto, PageDto, ReportDto, SupplierDto } from '@airdesk/contracts';
import { call } from '../api';
import { Alert, ConfirmDialog, EmptyState, LoadError, Modal, PageHeader, StatusBadge, useLoader } from '../components';
import { isTKey, useI18n, type TKey } from '../i18n';
import { CustomerPicker, SupplierSelect, useSuppliers } from '../lookups';
import { CurrencySelect, MoneyInput, useMoney } from '../money';
import { useFmt } from '../prefs';
import { DocumentPrint } from '../print';
import { PaymentDialog, type PayKind } from './payments';

type Can = (p: string) => boolean;
type Tab = 'customer' | 'supplier' | 'expenses' | 'treasury' | 'rates' | 'categories';
interface OpenRow { bookingId: string | null; bookingNo: string | null; currency: string; openMinor: number; dueDate: string | null }

const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
const todayIso = () => new Date().toISOString().slice(0, 10);

export function FinancePage({ can }: { can: Can }) {
  const { t } = useI18n();
  const tabs: { id: Tab; label: TKey; visible: boolean }[] = [
    { id: 'customer', label: 'receivePayments', visible: can('payment.customer.receive') || can('payment.customer.refund') },
    { id: 'supplier', label: 'supplierPayments', visible: can('payment.supplier.pay') || can('payment.supplier.record_refund') },
    { id: 'expenses', label: 'expensesTab', visible: can('expense.view') || can('expense.create') },
    { id: 'treasury', label: 'treasury', visible: can('treasury.view') || can('treasury.manage_accounts') },
    { id: 'rates', label: 'rates', visible: can('finance.exchange_rates') },
    { id: 'categories', label: 'categories', visible: can('expense.category.manage') },
  ];
  const visible = tabs.filter((x) => x.visible);
  const [tab, setTab] = useState<Tab>(visible[0]?.id ?? 'customer');
  return (
    <div className="page" data-testid="page-finance">
      <PageHeader title={t('navFinance')} />
      <div className="tabs" role="tablist">
        {visible.map((x) => <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? 'active' : ''} onClick={() => setTab(x.id)} data-testid={`fin-tab-${x.id}`}>{t(x.label)}</button>)}
      </div>
      {tab === 'customer' && <PartyPayments party="CUSTOMER" can={can} />}
      {tab === 'supplier' && <PartyPayments party="SUPPLIER" can={can} />}
      {tab === 'expenses' && <Expenses can={can} />}
      {tab === 'treasury' && <Treasury can={can} />}
      {tab === 'rates' && <Rates />}
      {tab === 'categories' && <Categories />}
    </div>
  );
}

function PartyPayments({ party, can }: { party: 'CUSTOMER' | 'SUPPLIER'; can: Can }) {
  const { t } = useI18n();
  const m = useMoney();
  const { date } = useFmt();
  const suppliers = useSuppliers();
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: PayKind; currency: string; items: OpenRow[] } | null>(null);
  const partyId = party === 'CUSTOMER' ? customer?.id ?? null : supplierId;
  const partyName = party === 'CUSTOMER' ? customer?.fullName ?? '' : suppliers.find((s: SupplierDto) => s.id === supplierId)?.name ?? '';
  const open = useLoader(() => (partyId ? call<OpenRow[]>('payments.openItems', { party, partyId }) : Promise.resolve([] as OpenRow[])), [partyId, party]);
  const rows = open.data ?? [];
  const currencies = [...new Set([...rows.map((r) => r.currency), m.base])];
  const payKind: PayKind = party === 'CUSTOMER' ? 'receive' : 'paySupplier';
  const refundKind: PayKind = party === 'CUSTOMER' ? 'refundCustomer' : 'supplierRefund';
  const canPay = party === 'CUSTOMER' ? can('payment.customer.receive') : can('payment.supplier.pay');
  const canRefund = party === 'CUSTOMER' ? can('payment.customer.refund') : can('payment.supplier.record_refund');
  return (
    <section className="card section">
      {party === 'CUSTOMER'
        ? <>{customer ? <p><strong>{customer.fullName}</strong> <span className="ltr muted">{customer.customerNo}</span> <button className="link" onClick={() => setCustomer(null)}>{t('edit')}</button></p> : <CustomerPicker value={null} onPick={setCustomer} canCreate={false} />}</>
        : <div className="grid"><SupplierSelect label={t('pickSupplier')} value={supplierId} onChange={setSupplierId} suppliers={suppliers} testId="fin-supplier" /></div>}
      {open.error && <LoadError error={open.error} onRetry={open.reload} />}
      {partyId && rows.length === 0 && !open.loading && <EmptyState text={t('noOpenItems')} />}
      {rows.length > 0 && (
        <table data-testid="open-items">
          <thead><tr><th>{t('recordNo')}</th><th>{t('currency')}</th><th>{t('dueDate')}</th><th className="num">{t('openBalance')}</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}><td className="ltr">{r.bookingNo ?? t('onAccount')}</td><td className="ltr">{r.currency}</td><td className="ltr">{date(r.dueDate)}</td>
              <td className={`num ltr ${r.openMinor > 0 ? 'due-text' : 'credit-text'}`}>{m.fmt(r.openMinor, r.currency)}</td></tr>
          ))}</tbody>
        </table>
      )}
      {partyId && (
        <div className="actions">
          {currencies.map((c) => (
            <span key={c} className="actions tight">
              {canPay && <button className="primary" onClick={() => setDialog({ kind: payKind, currency: c, items: rows.filter((r) => r.currency === c && r.bookingId && r.openMinor > 0) })} data-testid={`fin-pay-${c}`}>{t(party === 'CUSTOMER' ? 'recordPayment' : 'paySupplier')} ({c})</button>}
              {canRefund && rows.some((r) => r.currency === c && r.openMinor < 0) && <button onClick={() => setDialog({ kind: refundKind, currency: c, items: rows.filter((r) => r.currency === c && r.bookingId && r.openMinor < 0).map((r) => ({ ...r, openMinor: -r.openMinor })) })}>{t(party === 'CUSTOMER' ? 'refundCustomer' : 'supplierRefund')} ({c})</button>}
            </span>
          ))}
        </div>
      )}
      {dialog && partyId && (
        <PaymentDialog kind={dialog.kind} partyId={partyId} partyName={partyName} currency={dialog.currency}
          items={dialog.items.map((r) => ({ bookingId: r.bookingId!, bookingNo: r.bookingNo!, openMinor: r.openMinor }))}
          canOnAccount={can('payment.accept_overpayment') && (dialog.kind === 'receive' || dialog.kind === 'paySupplier')}
          onDone={() => open.reload()} onClose={() => setDialog(null)} />
      )}
    </section>
  );
}

function Expenses({ can }: { can: Can }) {
  const { t } = useI18n();
  const m = useMoney();
  const { date } = useFmt();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayIso());
  const [creating, setCreating] = useState(false);
  const list = useLoader(() => (can('report.expenses') ? call<ReportDto>('reports.run', { report: 'expenses', from, to }) : Promise.resolve(null)), [from, to]);
  return (
    <section className="card section">
      <div className="toolbar">
        <label className="inline">{t('from')}<input type="date" className="ltr" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="inline">{t('to')}<input type="date" className="ltr" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {can('expense.create') && <button className="primary" onClick={() => setCreating(true)} data-testid="new-expense">+ {t('newExpense')}</button>}
      </div>
      {list.data && (list.data.rows.length === 0 ? <EmptyState text={t('emptyList')} /> : (
        <table data-testid="expenses-table">
          <thead><tr><th>{t('date')}</th><th>{t('document')}</th><th>{t('expenseCategory')}</th><th>{t('description')}</th><th className="num">{t('amount')}</th></tr></thead>
          <tbody>{list.data.rows.map((r, i) => (
            <tr key={i}><td className="ltr">{date(String(r.date))}</td><td className="ltr">{r.doc_no}</td><td>{r.category_ar} / {r.category_en}</td><td>{r.description}</td><td className="num ltr">{m.fmt(Number(r.amount), String(r.currency))}</td></tr>
          ))}</tbody>
          <tfoot><tr><th colSpan={4}>{t('total')}</th><th className="num ltr">{m.fmt(list.data.totals?.base ?? 0, m.base)}</th></tr></tfoot>
        </table>
      ))}
      {creating && <ExpenseDialog onClose={() => setCreating(false)} onDone={() => { setCreating(false); list.reload(); }} />}
    </section>
  );
}

function ExpenseDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t, locale, errorMessage } = useI18n();
  const m = useMoney();
  const cats = useLoader(() => call<ExpenseCategoryDto[]>('expenseCategories.list', {}), []);
  const accounts = useLoader(() => call<MoneyAccountDto[]>('moneyAccounts.list', {}), []);
  const [v, setV] = useState({ categoryId: '', currency: m.base, amount: null as number | null, accountId: '', method: 'CASH', reference: '', description: '', date: '' });
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<import('@airdesk/contracts').DocumentDto | null>(null);
  const usable = (accounts.data ?? []).filter((a) => a.currencyCode === v.currency);
  const accountId = v.accountId || usable[0]?.id || '';
  const categoryId = v.categoryId || cats.data?.[0]?.id || '';
  const save = async () => {
    try {
      setDoc(await call('expenses.create', { categoryId, currency: v.currency, amountMinor: v.amount, moneyAccountId: accountId, paymentMethod: v.method, reference: v.reference || null, description: v.description, date: v.date || null }));
      onDone();
    } catch (e) { setError(errorMessage(e)); }
  };
  if (doc) return <DocumentPrint doc={doc} onClose={onClose} />;
  return (
    <Modal wide title={t('newExpense')} onClose={onClose} testId="expense-dialog"
      footer={<><button className="primary" disabled={!v.amount || !accountId || !v.description} onClick={save} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid">
        <label>{t('expenseCategory')}<select value={categoryId} onChange={(e) => setV({ ...v, categoryId: e.target.value })} data-testid="exp-category">{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{locale === 'ar' ? c.nameAr : c.nameEn}</option>)}</select></label>
        <CurrencySelect label={t('currency')} value={v.currency} onChange={(c) => setV({ ...v, currency: c, accountId: '' })} />
        <MoneyInput label={t('amount')} value={v.amount} currency={v.currency} onChange={(a) => setV({ ...v, amount: a })} testId="exp-amount" required />
        <label>{t('moneyAccount')}<select value={accountId} onChange={(e) => setV({ ...v, accountId: e.target.value })}>{usable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>{t('method')}<select value={v.method} onChange={(e) => setV({ ...v, method: e.target.value })}>{['CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'WALLET', 'OTHER'].map((x) => <option key={x} value={x}>{t(x as TKey)}</option>)}</select></label>
        <label>{t('date')}<input type="date" className="ltr" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></label>
        <label>{t('reference')}<input className="ltr" value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></label>
        <label className="span-all">{t('description')}<input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} data-testid="exp-description" /></label>
      </div>
    </Modal>
  );
}

function Treasury({ can }: { can: Can }) {
  const { t, errorMessage } = useI18n();
  const m = useMoney();
  const list = useLoader(() => call<MoneyAccountDto[]>('moneyAccounts.list', { includeInactive: true }), []);
  const [edit, setEdit] = useState<MoneyAccountDto | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card section">
      {can('treasury.manage_accounts') && <div className="actions"><button className="primary" onClick={() => setEdit('new')} data-testid="new-account">+ {t('newAccount')}</button></div>}
      {error && <Alert kind="error">{error}</Alert>}
      <table data-testid="accounts-table">
        <thead><tr><th>{t('name')}</th><th>{t('accountType')}</th><th>{t('currency')}</th><th>{t('bankName')}</th><th className="num">{t('balanceNow')}</th><th>{t('status')}</th><th /></tr></thead>
        <tbody>{(list.data ?? []).map((a) => (
          <tr key={a.id}><td>{a.name}</td><td>{t(`${a.accountType}_T` as TKey)}</td><td className="ltr">{a.currencyCode}</td><td>{a.bankName ?? ''}</td>
            <td className="num ltr">{a.balanceMinor === null ? '—' : m.fmt(a.balanceMinor, a.currencyCode)}</td><td><StatusBadge status={a.isActive ? 'ACTIVE' : 'ARCHIVED'} /></td>
            <td className="row-actions">{can('treasury.manage_accounts') && <>
              <button onClick={() => setEdit(a)}>{t('edit')}</button>
              <button onClick={async () => { try { await call('moneyAccounts.setActive', { id: a.id, active: !a.isActive }); list.reload(); } catch (e) { setError(errorMessage(e)); } }}>{a.isActive ? t('archive') : t('restoreRecord')}</button>
            </>}</td></tr>
        ))}</tbody>
      </table>
      {edit && <AccountDialog account={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); list.reload(); }} />}
    </section>
  );
}

function AccountDialog({ account, onClose, onDone }: { account: MoneyAccountDto | null; onClose: () => void; onDone: () => void }) {
  const { t, errorMessage } = useI18n();
  const m = useMoney();
  const [v, setV] = useState({ name: account?.name ?? '', accountType: account?.accountType ?? 'CASH', currencyCode: account?.currencyCode ?? m.base, bankName: account?.bankName ?? '', accountRef: account?.accountRef ?? '', notes: account?.notes ?? '' });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await call('moneyAccounts.save', { ...(account ? { id: account.id, rowVersion: account.rowVersion } : {}), ...v, bankName: v.bankName || null, accountRef: v.accountRef || null, notes: v.notes || null });
      onDone();
    } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <Modal title={account ? account.name : t('newAccount')} onClose={onClose} testId="account-dialog"
      footer={<><button className="primary" disabled={!v.name} onClick={save} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid">
        <label>{t('name')}<input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} data-testid="acc-name" /></label>
        <label>{t('accountType')}<select value={v.accountType} onChange={(e) => setV({ ...v, accountType: e.target.value as never })}>{['CASH', 'BANK', 'WALLET', 'CARD_CLEARING'].map((x) => <option key={x} value={x}>{t(`${x}_T` as TKey)}</option>)}</select></label>
        <CurrencySelect label={t('currency')} value={v.currencyCode} onChange={(c) => setV({ ...v, currencyCode: c })} testId="acc-currency" />
        <label>{t('bankName')}<input value={v.bankName} onChange={(e) => setV({ ...v, bankName: e.target.value })} /></label>
        <label>{t('accountRef')}<input className="ltr" value={v.accountRef} onChange={(e) => setV({ ...v, accountRef: e.target.value })} /></label>
      </div>
    </Modal>
  );
}

function Rates() {
  const { t, locale, errorMessage } = useI18n();
  const m = useMoney();
  const rates = useLoader(() => call<ExchangeRateDto[]>('currency.rates', {}), []);
  const [v, setV] = useState({ currencyCode: m.active.find((c) => c.code !== m.base)?.code ?? 'USD', rateDate: todayIso(), rate: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    try { await call('currency.setRate', v); setMsg({ ok: true, text: t('saved') }); rates.reload(); } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); }
  };
  const toggle = async (c: CurrencyDto) => {
    try { await call('currency.setActive', { currencyCode: c.code, active: !c.isActive }); m.reload(); } catch (e) { setMsg({ ok: false, text: errorMessage(e) }); }
  };
  return (
    <section className="card section">
      {msg && <Alert kind={msg.ok ? 'ok' : 'error'}>{msg.text}</Alert>}
      <h3>{t('currencies')}</h3>
      <div className="chips">{m.currencies.map((c) => (
        <button key={c.code} className={`chip ${c.isActive ? 'on' : ''}`} disabled={c.code === m.base} onClick={() => toggle(c)} title={c.isActive ? t('deactivate') : t('activate')}>
          {c.code} — {locale === 'ar' ? c.nameAr : c.nameEn}
        </button>
      ))}</div>
      <h3>{t('setRate')}</h3>
      <p className="hint">{t('rateHistoryNote')} · 1 X = ? {m.base}</p>
      <div className="grid">
        <label>{t('currency')}<select value={v.currencyCode} onChange={(e) => setV({ ...v, currencyCode: e.target.value })} data-testid="rate-currency">{m.active.filter((c) => c.code !== m.base).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></label>
        <label>{t('rateDate')}<input type="date" className="ltr" value={v.rateDate} onChange={(e) => setV({ ...v, rateDate: e.target.value })} /></label>
        <label>{t('rate')}<input className="ltr num" value={v.rate} onChange={(e) => setV({ ...v, rate: e.target.value })} data-testid="rate-value" /></label>
        <div className="actions"><button className="primary" disabled={!v.rate} onClick={save} data-testid="save-rate">{t('save')}</button></div>
      </div>
      <table>
        <thead><tr><th>{t('currency')}</th><th>{t('rateDate')}</th><th className="num">{t('rate')}</th><th>{t('user')}</th></tr></thead>
        <tbody>{(rates.data ?? []).map((r) => <tr key={`${r.currencyCode}${r.rateDate}`}><td className="ltr">{r.currencyCode}</td><td className="ltr">{r.rateDate}</td><td className="num ltr">{r.rate}</td><td>{r.createdBy}</td></tr>)}</tbody>
      </table>
    </section>
  );
}

function Categories() {
  const { t, locale, errorMessage } = useI18n();
  const list = useLoader(() => call<ExpenseCategoryDto[]>('expenseCategories.list', { includeArchived: true }), []);
  const accounts = useLoader(() => call<{ code: string; nameAr: string; nameEn: string }[]>('expenseCategories.accounts', {}), []);
  const [edit, setEdit] = useState<ExpenseCategoryDto | 'new' | null>(null);
  const [v, setV] = useState({ code: '', nameAr: '', nameEn: '', accountCode: '6190' });
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ExpenseCategoryDto | null>(null);
  const open = (c: ExpenseCategoryDto | 'new') => { setEdit(c); setV(c === 'new' ? { code: '', nameAr: '', nameEn: '', accountCode: '6190' } : { code: c.code, nameAr: c.nameAr, nameEn: c.nameEn, accountCode: c.accountCode }); };
  const save = async () => {
    try { await call('expenseCategories.save', { ...(edit !== 'new' && edit ? { id: edit.id, rowVersion: edit.rowVersion } : {}), ...v }); setEdit(null); list.reload(); } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <section className="card section">
      <div className="actions"><button className="primary" onClick={() => open('new')} data-testid="new-category">+ {t('newCategory')}</button></div>
      {error && <Alert kind="error">{error}</Alert>}
      <table>
        <thead><tr><th>{t('roleCode')}</th><th>{t('nameAr')}</th><th>{t('nameEn')}</th><th>{t('ledgerAccount')}</th><th>{t('status')}</th><th /></tr></thead>
        <tbody>{(list.data ?? []).map((c) => (
          <tr key={c.id}><td className="ltr">{c.code}</td><td>{c.nameAr}</td><td>{c.nameEn}</td><td className="ltr">{c.accountCode}</td><td><StatusBadge status={c.status} />{c.isSystem && <span className="badge muted">{t('systemRole')}</span>}</td>
            <td className="row-actions"><button onClick={() => open(c)}>{t('edit')}</button><button onClick={() => setConfirm(c)}>{c.status === 'ACTIVE' ? t('archive') : t('restoreRecord')}</button></td></tr>
        ))}</tbody>
      </table>
      {edit && (
        <Modal title={edit === 'new' ? t('newCategory') : edit.nameEn} onClose={() => setEdit(null)}
          footer={<><button className="primary" onClick={save} data-testid="save">{t('save')}</button><button onClick={() => setEdit(null)}>{t('cancel')}</button></>}>
          <div className="grid">
            <label>{t('roleCode')}<input className="ltr" value={v.code} disabled={edit !== 'new' && edit.isSystem} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} /></label>
            <label>{t('nameAr')}<input value={v.nameAr} onChange={(e) => setV({ ...v, nameAr: e.target.value })} /></label>
            <label>{t('nameEn')}<input className="ltr" value={v.nameEn} onChange={(e) => setV({ ...v, nameEn: e.target.value })} /></label>
            <label>{t('ledgerAccount')}<select value={v.accountCode} onChange={(e) => setV({ ...v, accountCode: e.target.value })}>{(accounts.data ?? []).map((a) => <option key={a.code} value={a.code}>{a.code} — {locale === 'ar' ? a.nameAr : a.nameEn}</option>)}</select></label>
          </div>
        </Modal>
      )}
      {confirm && <ConfirmDialog title={confirm.nameEn} text={t('confirmArchive')} confirmLabel={confirm.status === 'ACTIVE' ? t('archive') : t('restoreRecord')} onClose={() => setConfirm(null)}
        onConfirm={async () => { await call('expenseCategories.setActive', { id: confirm.id, active: confirm.status !== 'ACTIVE' }); list.reload(); }} />}
    </section>
  );
}

export { isTKey };
export type { PageDto };
