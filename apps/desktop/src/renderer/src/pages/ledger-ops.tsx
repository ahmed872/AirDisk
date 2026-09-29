import { useEffect, useState } from 'react';
import type { CustomerDto, DocumentDto, MoneyAccountDto } from '@airdesk/contracts';
import { call } from '../api';
import { Alert, EmptyState, LoadError, Modal, useLoader } from '../components';
import { isTKey, useI18n, type TKey } from '../i18n';
import { CustomerPicker, SupplierSelect, useSuppliers } from '../lookups';
import { CurrencySelect, MoneyInput, useMoney } from '../money';
import { useFmt } from '../prefs';
import { DocumentPrint } from '../print';

type Can = (p: string) => boolean;
const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
const todayIso = () => new Date().toISOString().slice(0, 10);

function DocTable({ docs, onOpen, showParty }: { docs: DocumentDto[]; onOpen: (d: DocumentDto) => void; showParty?: boolean }) {
  const { t, locale } = useI18n();
  const m = useMoney();
  const { date } = useFmt();
  return (
    <table data-testid="ledger-docs">
      <thead><tr><th>{t('date')}</th><th>{t('document')}</th><th>{t('type')}</th>{showParty && <th>{t('openingTarget')}</th>}<th>{t('moneyAccount')}</th><th className="num">{t('amount')}</th><th /></tr></thead>
      <tbody>{docs.map((d) => (
        <tr key={d.id} className={d.isReversal || d.reversedByNo ? 'muted' : ''}>
          <td className="ltr">{date(d.docDate)}</td>
          <td className="ltr">{d.docNo}{d.reversedByNo ? ` ↩ ${d.reversedByNo}` : ''}</td>
          <td>{d.reasonCode && isTKey(`kind_${d.reasonCode}`) ? t(`kind_${d.reasonCode}` as TKey) : d.reasonCode === 'OPENING_DEBIT' ? t('side_OWED_TO_OFFICE') : d.reasonCode === 'OPENING_CREDIT' ? t('side_OWED_BY_OFFICE') : t(d.isReversal ? 'reversalOf' : 'documents')}</td>
          {showParty && <td>{d.customerName ?? d.supplierName ?? ''}</td>}
          <td>{d.moneyAccountName ?? ''}{d.counterMoneyAccountName ? ` ${locale === 'ar' ? '←' : '→'} ${d.counterMoneyAccountName}` : ''}</td>
          <td className="num ltr">{m.fmt(d.totalMinor, d.currency)}</td>
          <td className="row-actions"><button onClick={() => onOpen(d)}>{t('print')}</button></td>
        </tr>
      ))}</tbody>
    </table>
  );
}

/** Go-live balances (Phase 0 P12): what was owed / held before the office started using AirDesk. */
export function OpeningBalances() {
  const { t } = useI18n();
  const list = useLoader(() => call<DocumentDto[]>('openingBalances.list', {}), []);
  const [creating, setCreating] = useState(false);
  const [printing, setPrinting] = useState<DocumentDto | null>(null);
  return (
    <section className="card section" data-testid="opening-balances">
      <p className="hint">{t('openingHint')}</p>
      <div className="actions"><button className="primary" onClick={() => setCreating(true)} data-testid="new-opening">+ {t('newOpeningBalance')}</button></div>
      {list.error && <LoadError error={list.error} onRetry={list.reload} />}
      {list.data && (list.data.length === 0 ? <EmptyState text={t('emptyList')} /> : <DocTable docs={list.data} showParty onOpen={async (d) => setPrinting(await call<DocumentDto>('documents.get', { id: d.id }))} />)}
      {creating && <OpeningDialog onClose={() => setCreating(false)} onDone={() => list.reload()} />}
      {printing && <DocumentPrint doc={printing} onClose={() => setPrinting(null)} />}
    </section>
  );
}

function OpeningDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t, errorMessage } = useI18n();
  const m = useMoney();
  const suppliers = useSuppliers();
  const accounts = useLoader(() => call<MoneyAccountDto[]>('moneyAccounts.list', {}), []);
  const [target, setTarget] = useState<'CUSTOMER' | 'SUPPLIER' | 'MONEY_ACCOUNT'>('CUSTOMER');
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState('');
  const [side, setSide] = useState<'OWED_TO_OFFICE' | 'OWED_BY_OFFICE'>('OWED_TO_OFFICE');
  const [currency, setCurrency] = useState(m.base);
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(todayIso());
  const [rate, setRate] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocumentDto | null>(null);
  const account = (accounts.data ?? []).find((a) => a.id === accountId);
  const cur = target === 'MONEY_ACCOUNT' ? account?.currencyCode ?? m.base : currency;
  const targetId = target === 'CUSTOMER' ? customer?.id : target === 'SUPPLIER' ? supplierId : accountId;
  const save = async () => {
    try {
      setDoc(await call<DocumentDto>('openingBalances.record', {
        target, targetId, side: target === 'MONEY_ACCOUNT' ? 'OWED_TO_OFFICE' : side, currency: cur, amountMinor: amount, date: date || null,
        exchangeRate: cur !== m.base && rate ? rate : null, notes: notes || null,
      }));
      onDone();
    } catch (e) { setError(errorMessage(e)); }
  };
  if (doc) return <DocumentPrint doc={doc} onClose={onClose} />;
  return (
    <Modal wide title={t('newOpeningBalance')} onClose={onClose} testId="opening-dialog"
      footer={<><button className="primary" disabled={!targetId || !amount} onClick={save} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid">
        <label>{t('openingTarget')}
          <select value={target} onChange={(e) => setTarget(e.target.value as never)} data-testid="opening-target">
            {(['CUSTOMER', 'SUPPLIER', 'MONEY_ACCOUNT'] as const).map((x) => <option key={x} value={x}>{t(`target_${x}`)}</option>)}
          </select>
        </label>
        {target === 'CUSTOMER' && <div className="span-all">{customer ? <p><strong>{customer.fullName}</strong> <button className="link" onClick={() => setCustomer(null)}>{t('edit')}</button></p> : <CustomerPicker value={null} onPick={setCustomer} canCreate={false} />}</div>}
        {target === 'SUPPLIER' && <SupplierSelect label={t('supplier')} value={supplierId} onChange={setSupplierId} suppliers={suppliers} testId="opening-supplier" />}
        {target === 'MONEY_ACCOUNT' && (
          <label>{t('moneyAccount')}
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} data-testid="opening-account">
              <option value="" />
              {(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currencyCode})</option>)}
            </select>
          </label>
        )}
        {target !== 'MONEY_ACCOUNT'
          ? <label>{t('balanceSide')}
              <select value={side} onChange={(e) => setSide(e.target.value as never)} data-testid="opening-side">
                <option value="OWED_TO_OFFICE">{t('side_OWED_TO_OFFICE')}</option>
                <option value="OWED_BY_OFFICE">{t('side_OWED_BY_OFFICE')}</option>
              </select>
            </label>
          : <p className="hint">{t('cashHeld')}</p>}
        {target !== 'MONEY_ACCOUNT' && <CurrencySelect label={t('currency')} value={currency} onChange={setCurrency} testId="opening-currency" />}
        <MoneyInput label={t('amount')} value={amount} currency={cur} onChange={setAmount} testId="opening-amount" required />
        <label>{t('date')}<input type="date" className="ltr" value={date} onChange={(e) => setDate(e.target.value)} data-testid="opening-date" /></label>
        {cur !== m.base && <label>{t('rate')}<input className="ltr num" value={rate} onChange={(e) => setRate(e.target.value)} placeholder={`1 ${cur} = ? ${m.base}`} /></label>}
        <label className="span-all">{t('notes')}<input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

/** Transfers between money accounts and owner capital / drawings (Phase 0 P10). */
export function TransfersSection({ can, onChanged }: { can: Can; onChanged: () => void }) {
  const { t } = useI18n();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayIso());
  const [kind, setKind] = useState<'ACCOUNT_TRANSFER' | 'OWNER' | null>(null);
  const [printing, setPrinting] = useState<DocumentDto | null>(null);
  const list = useLoader(() => call<DocumentDto[]>('treasury.transfers', { from, to }), [from, to]);
  return (
    <section className="section" data-testid="transfers">
      <h3>{t('transfers')}</h3>
      <div className="toolbar">
        <label className="inline">{t('from')}<input type="date" className="ltr" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="inline">{t('to')}<input type="date" className="ltr" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {can('treasury.transfer') && <button className="primary" onClick={() => setKind('ACCOUNT_TRANSFER')} data-testid="new-transfer">{t('newTransfer')}</button>}
        {can('treasury.transfer') && can('treasury.owner_movements') && <button onClick={() => setKind('OWNER')} data-testid="owner-movement">{t('ownerMovement')}</button>}
      </div>
      {list.data && (list.data.length === 0 ? <EmptyState text={t('emptyList')} /> : <DocTable docs={list.data} onOpen={async (d) => setPrinting(await call<DocumentDto>('documents.get', { id: d.id }))} />)}
      {kind && <TransferDialog owner={kind === 'OWNER'} onClose={() => setKind(null)} onDone={() => { list.reload(); onChanged(); }} />}
      {printing && <DocumentPrint doc={printing} onClose={() => setPrinting(null)} />}
    </section>
  );
}

function TransferDialog({ owner, onClose, onDone }: { owner: boolean; onClose: () => void; onDone: () => void }) {
  const { t, errorMessage } = useI18n();
  const m = useMoney();
  const accounts = useLoader(() => call<MoneyAccountDto[]>('moneyAccounts.list', {}), []);
  const [kind, setKind] = useState<'ACCOUNT_TRANSFER' | 'OWNER_CAPITAL' | 'OWNER_DRAWING'>(owner ? 'OWNER_CAPITAL' : 'ACCOUNT_TRANSFER');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocumentDto | null>(null);
  const all = (accounts.data ?? []).filter((a) => a.isActive);
  const source = all.find((a) => a.id === fromId);
  const currency = (source ?? all.find((a) => a.id === toId))?.currencyCode ?? m.base;
  const needsFrom = kind !== 'OWNER_CAPITAL';
  const needsTo = kind !== 'OWNER_DRAWING';
  const toChoices = all.filter((a) => a.id !== fromId && (!source || a.currencyCode === source.currencyCode));
  useEffect(() => { if (toId && !toChoices.some((a) => a.id === toId)) setToId(''); }, [fromId]);
  const save = async () => {
    try {
      setDoc(await call<DocumentDto>('treasury.transfer', {
        kind, fromAccountId: needsFrom ? fromId : null, toAccountId: needsTo ? toId : null, amountMinor: amount, date: date || null,
        reference: reference || null, notes: notes || null,
      }));
      onDone();
    } catch (e) { setError(errorMessage(e)); }
  };
  if (doc) return <DocumentPrint doc={doc} onClose={onClose} />;
  return (
    <Modal wide title={owner ? t('ownerMovement') : t('newTransfer')} onClose={onClose} testId="transfer-dialog"
      footer={<><button className="primary" disabled={!amount || (needsFrom && !fromId) || (needsTo && !toId)} onClick={save} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid">
        {owner && (
          <label>{t('type')}
            <select value={kind} onChange={(e) => setKind(e.target.value as never)} data-testid="transfer-kind">
              <option value="OWNER_CAPITAL">{t('kind_OWNER_CAPITAL')}</option>
              <option value="OWNER_DRAWING">{t('kind_OWNER_DRAWING')}</option>
            </select>
          </label>
        )}
        {needsFrom && (
          <label>{t('fromAccount')}
            <select value={fromId} onChange={(e) => setFromId(e.target.value)} data-testid="transfer-from">
              <option value="" />
              {all.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currencyCode}){a.balanceMinor !== null ? ` — ${m.fmt(a.balanceMinor, a.currencyCode)}` : ''}</option>)}
            </select>
          </label>
        )}
        {needsTo && (
          <label>{t('toAccount')}
            <select value={toId} onChange={(e) => setToId(e.target.value)} data-testid="transfer-to">
              <option value="" />
              {(needsFrom ? toChoices : all).map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currencyCode})</option>)}
            </select>
          </label>
        )}
        <MoneyInput label={t('amount')} value={amount} currency={currency} onChange={setAmount} testId="transfer-amount" required />
        <label>{t('date')}<input type="date" className="ltr" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>{t('reference')}<input className="ltr" value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} /></label>
        <label className="span-all">{t('notes')}<input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} /></label>
      </div>
      {source && source.balanceMinor !== null && <p className="hint">{t('available')}: <span className="ltr">{m.fmt(source.balanceMinor, source.currencyCode)}</span></p>}
    </Modal>
  );
}

export interface OpenRow { bookingId: string | null; bookingNo: string | null; currency: string; openMinor: number; dueDate: string | null }

/** Uses a party's credit (on account or on a record) to settle their other records (Phase 0 P11). */
export function ApplyCreditDialog({ party, partyId, partyName, currency, rows, onClose, onDone }: {
  party: 'CUSTOMER' | 'SUPPLIER'; partyId: string; partyName: string; currency: string; rows: OpenRow[]; onClose: () => void; onDone: () => void;
}) {
  const { t, errorMessage } = useI18n();
  const m = useMoney();
  const sources = rows.filter((r) => r.currency === currency && r.openMinor < 0);
  const [sourceKey, setSourceKey] = useState(sources[0]?.bookingId ?? '');
  const source = sources.find((r) => (r.bookingId ?? '') === sourceKey) ?? sources[0];
  const available = source ? -source.openMinor : 0;
  const targets = rows.filter((r) => r.currency === currency && r.openMinor > 0 && r.bookingId && r.bookingId !== source?.bookingId);
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  useEffect(() => {
    let left = available;
    const next: Record<string, number> = {};
    for (const r of targets) { const a = Math.min(left, r.openMinor); if (a > 0) next[r.bookingId!] = a; left -= a; }
    setAlloc(next);
  }, [sourceKey]);
  const total = Object.values(alloc).reduce((s, v) => s + v, 0);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocumentDto | null>(null);
  const save = async () => {
    try {
      setDoc(await call<DocumentDto>('balances.apply', {
        party, partyId, currency, fromBookingId: source?.bookingId ?? null,
        allocations: Object.entries(alloc).filter(([, v]) => v > 0).map(([bookingId, amountMinor]) => ({ bookingId, amountMinor })),
      }));
      onDone();
    } catch (e) { setError(errorMessage(e)); }
  };
  if (doc) return <DocumentPrint doc={doc} onClose={onClose} />;
  return (
    <Modal wide title={`${t('applyCredit')} — ${partyName}`} onClose={onClose} testId="apply-credit-dialog"
      footer={<><button className="primary" disabled={total <= 0 || total > available} onClick={save} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      <p className="hint">{t('applyCreditHint')}</p>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid">
        <label>{t('creditSource')}
          <select value={source?.bookingId ?? ''} onChange={(e) => setSourceKey(e.target.value)} data-testid="credit-source">
            {sources.map((r) => <option key={r.bookingId ?? ''} value={r.bookingId ?? ''}>{r.bookingNo ?? t('onAccount')} — {m.fmt(-r.openMinor, currency)}</option>)}
          </select>
        </label>
        <p>{t('available')}: <strong className="ltr">{m.fmt(available, currency)}</strong></p>
      </div>
      {targets.length === 0 ? <EmptyState text={t('noOpenItems')} /> : (
        <table>
          <thead><tr><th>{t('recordNo')}</th><th className="num">{t('openBalance')}</th><th className="num">{t('allocate')}</th></tr></thead>
          <tbody>{targets.map((r) => (
            <tr key={r.bookingId}>
              <td className="ltr">{r.bookingNo}</td>
              <td className="num ltr">{m.fmt(r.openMinor, currency)}</td>
              <td><MoneyInput label="" value={alloc[r.bookingId!] ?? 0} currency={currency} onChange={(v) => setAlloc({ ...alloc, [r.bookingId!]: Math.min(v ?? 0, r.openMinor) })} /></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {total > available && <Alert kind="error">{t('exceedsAvailable')}</Alert>}
    </Modal>
  );
}

