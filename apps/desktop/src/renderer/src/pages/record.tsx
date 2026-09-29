import { useState } from 'react';
import type { BookingDto, CancellationDto, DocumentDto, PassengerDto, PriceItemDto, ScheduleChangeDto, SegmentDto } from '@airdesk/contracts';
import { call } from '../api';
import { Alert, ConfirmDialog, LoadError, Modal, useLoader } from '../components';
import { isTKey, useI18n, type FieldIssue, type TKey } from '../i18n';
import { AirlineSelect, AirportInput, SupplierSelect, useAirlines, useSuppliers } from '../lookups';
import { CurrencySelect, MoneyInput, useMoney } from '../money';
import { useFmt } from '../prefs';
import { DocumentPrint, RecordPrint } from '../print';
import { PaymentDialog, type PayKind } from './payments';
import { AttachmentsSection } from './attachments';

type Can = (p: string) => boolean;
type Dialog =
  | { k: 'header' } | { k: 'passenger'; p: PassengerDto | null } | { k: 'segment'; s: SegmentDto | null } | { k: 'price'; passenger: PassengerDto; item: PriceItemDto | null }
  | { k: 'ticketed' } | { k: 'discard' } | { k: 'pay'; kind: PayKind; supplierId?: string; supplierName?: string; currency: string }
  | { k: 'doc'; doc: DocumentDto } | { k: 'cancelDoc'; doc: DocumentDto } | { k: 'print' } | { k: 'ticketNo'; ticketId: string; current?: string | null } | { k: 'reissue'; ticketId: string }
  | { k: 'cancelReq' } | { k: 'supplierConfirm'; c: CancellationDto } | { k: 'customerCredit'; c: CancellationDto } | { k: 'cxNote'; c: CancellationDto; action: 'reject' | 'nothing' | 'withdraw' }
  | { k: 'notify'; change: ScheduleChangeDto } | { k: 'confirmChange'; change: ScheduleChangeDto } | { k: 'adjust'; mode: 'sale' | 'cost' | 'supplier' };

const statusClass: Record<string, string> = { DRAFT: 'muted', RESERVED: 'warn', ISSUED: 'ok', PARTIALLY_CANCELLED: 'warn', CANCELLED: 'bad', VOIDED: 'bad', DISCARDED: 'muted' };

/**
 * The office's record of an airline transaction made OUTSIDE AirDesk. The
 * employee enters the existing PNR / ticket numbers / flights, the supplier,
 * the purchase cost and the customer price, then confirms that the ticket was
 * issued (externally) so the sale and purchase are recorded in the ledger.
 */
export function RecordPage({ id, can, onBack }: { id: string; can: Can; onBack: () => void }) {
  const { t, errorMessage } = useI18n();
  const m = useMoney();
  const { date, dateTime } = useFmt();
  const rec = useLoader(() => call<BookingDto>('bookings.get', { id }), [id]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  if (rec.error) return <div className="page"><button onClick={onBack}>← {t('navTickets')}</button><LoadError error={rec.error} onRetry={rec.reload} /></div>;
  const b = rec.data;
  if (!b) return <div className="page">{t('loading')}</div>;
  const pre = b.status === 'DRAFT' || b.status === 'RESERVED';
  const live = b.status === 'ISSUED' || b.status === 'PARTIALLY_CANCELLED';
  const closed = b.status === 'DISCARDED' || b.status === 'VOIDED' || b.status === 'CANCELLED';
  const refresh = (text?: string) => { setDialog(null); if (text) setNotice({ ok: true, text }); rec.reload(); };
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); refresh(t('saved')); } catch (e) { setNotice({ ok: false, text: errorMessage(e) }); }
  };
  const pos = b.customer.find((p) => p.currency === b.saleCurrency);
  const total = pos ? pos.chargedMinor : b.quote.saleTotalMinor;
  const paid = pos ? pos.paidMinor : 0;
  const remaining = pos ? pos.balanceMinor : b.quote.saleTotalMinor;
  const attention = b.scheduleChanges.filter((c) => c.requiresAttention);
  const openCx = b.cancellations.filter((c) => c.overallStatus === 'OPEN');

  return (
    <div className="page record" data-testid="page-record">
      <div className="page-header">
        <div>
          <button className="link" onClick={onBack}>← {t('navTickets')}</button>
          <h1>{t('ticketRecord')} <span className="ltr">{b.bookingNo}</span> <span className={`badge ${statusClass[b.status]}`} data-testid="record-status" data-status={b.status}>{t(`st_${b.status}` as TKey)}</span></h1>
          <p className="muted">{b.customerName} · <span className="ltr">{b.contactMobile}</span>{b.pnr && <> · PNR <strong className="ltr">{b.pnr}</strong></>}{b.refundStatus !== 'NONE' && <> · <span className="badge warn">{t(`rf_${b.refundStatus}` as TKey)}</span></>}</p>
        </div>
        <div className="actions tight">
          <button onClick={() => setDialog({ k: 'print' })} data-testid="print-record">{t('print')}</button>
          {can('booking.edit') && !closed && <button onClick={() => setDialog({ k: 'header' })} data-testid="edit-header">{t('edit')}</button>}
        </div>
      </div>
      {notice && <Alert kind={notice.ok ? 'ok' : 'error'}>{notice.text}</Alert>}
      {pre && <Alert kind="info">{t('scopeNote')}</Alert>}
      {attention.length > 0 && <div className="alert danger-banner" role="alert" data-testid="schedule-banner">⚠ {t('scheduleChangedBanner')} — {t('needsAttention')} ({attention.length})</div>}

      <div className="record-grid">
        <section className="card section">
          <h2>{t('passengers')}</h2>
          {b.passengers.some((p) => p.identityMasked) && <p className="hint">{t('identityMaskedNote')}</p>}
          <table data-testid="passengers-table">
            <thead><tr><th>#</th><th>{t('name')}</th><th>{t('paxType')}</th><th>{t('passportNo')}</th><th>{t('status')}</th><th /></tr></thead>
            <tbody>{b.passengers.map((p) => (
              <tr key={p.id}>
                <td>{p.seq}</td><td className="ltr">{p.title ?? ''} {p.givenName} {p.surname}{p.nameAr ? <span className="muted"> · {p.nameAr}</span> : null}</td>
                <td>{t(p.paxType)}</td><td className="ltr">{p.passportNo ?? ''}</td><td>{p.status === 'CANCELLED' ? <span className="badge bad">{t('st_CANCELLED')}</span> : ''}</td>
                <td className="row-actions">
                  {can('booking.edit') && !closed && <button onClick={() => setDialog({ k: 'passenger', p })}>{t('edit')}</button>}
                  {can('booking.edit') && pre && <button className="danger" onClick={() => act(() => call('bookings.removePassenger', { bookingId: b.id, passengerId: p.id }))}>×</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
          {can('booking.edit') && pre && <button onClick={() => setDialog({ k: 'passenger', p: null })} data-testid="add-passenger">+ {t('addPassenger')}</button>}
        </section>

        <section className="card section">
          <h2>{t('flights')}</h2>
          <table data-testid="segments-table">
            <thead><tr><th>{t('flightNumber')}</th><th>{t('origin')}</th><th>{t('destination')}</th><th>{t('departure')}</th><th>{t('arrival')}</th><th>{t('cabin')}</th><th /></tr></thead>
            <tbody>{b.segments.map((s) => (
              <tr key={s.id} className={s.scheduleAttention ? 'attention' : ''}>
                <td className="ltr">{s.airlineCode}{s.flightNumber}{s.scheduleChanged && <span className="badge warn" title={t('scheduleChangedBanner')}>!</span>}</td>
                <td className="ltr">{s.origin}</td><td className="ltr">{s.destination}</td>
                <td className="ltr">{date(s.departureDate)} {s.departureTime}</td><td className="ltr">{date(s.arrivalDate)} {s.arrivalTime}</td>
                <td>{t(s.cabinClass)}{s.status === 'CANCELLED' ? ` · ${t('st_CANCELLED')}` : ''}</td>
                <td className="row-actions">
                  {can('booking.edit') && !closed && (pre || can('schedule.change')) && <button onClick={() => setDialog({ k: 'segment', s })} data-testid="edit-segment">{t('edit')}</button>}
                  {can('booking.edit') && pre && <button className="danger" onClick={() => act(() => call('bookings.removeSegment', { bookingId: b.id, segmentId: s.id }))}>×</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
          {can('booking.edit') && pre && <button onClick={() => setDialog({ k: 'segment', s: null })} data-testid="add-segment">+ {t('addFlight')}</button>}
        </section>
      </div>

      <section className="card section">
        <h2>{t('pricing')} <span className="muted small ltr">({b.saleCurrency})</span></h2>
        <table data-testid="pricing-table">
          <thead><tr><th>{t('passenger')}</th><th>{t('supplierSource')}</th><th>{t('ticketNumber')}</th><th className="num">{t('fare')}</th><th className="num">{t('taxes')}</th>
            <th className="num">{t('serviceFee')}</th><th className="num">{t('discount')}</th><th className="num">{t('customerPrice')}</th><th className="num">{t('purchaseCost')}</th><th /></tr></thead>
          <tbody>{b.passengers.filter((p) => p.status === 'ACTIVE' || b.priceItems.some((i) => i.passengerId === p.id)).map((p) => {
            const i = b.priceItems.find((x) => x.passengerId === p.id) ?? null;
            return (
              <tr key={p.id}>
                <td className="ltr">{p.givenName} {p.surname}</td>
                <td>{i?.supplierName ?? '—'}</td>
                <td className="ltr">{i?.ticketNumber ?? ''}</td>
                <td className="num ltr">{i ? m.fmt(i.fareMinor, b.saleCurrency) : ''}</td>
                <td className="num ltr">{i ? m.fmt(i.taxesMinor, b.saleCurrency) : ''}</td>
                <td className="num ltr">{i ? m.fmt(i.serviceFeeMinor, b.saleCurrency) : ''}</td>
                <td className="num ltr">{i && i.discountMinor ? m.fmt(i.discountMinor, b.saleCurrency) : ''}</td>
                <td className="num ltr"><strong>{i ? m.fmt(i.saleTotalMinor, b.saleCurrency) : ''}</strong></td>
                <td className="num ltr">{!i ? '' : i.costMinor !== null ? m.fmt(i.costMinor, i.costCurrency ?? b.saleCurrency) : <span className="muted">{i.costEntered ? t('costEnteredHidden') : t('costMissing')}</span>}</td>
                <td className="row-actions">{pre && can('booking.edit') && <button onClick={() => setDialog({ k: 'price', passenger: p, item: i })} data-testid="set-price">{i ? t('edit') : t('setPrice')}</button>}</td>
              </tr>
            );
          })}</tbody>
          <tfoot><tr><th colSpan={7}>{t('totalCustomer')}</th><th className="num ltr" data-testid="quote-total">{m.fmt(b.quote.saleTotalMinor, b.saleCurrency)}</th>
            <th className="num ltr">{b.quote.costTotals?.map((c) => m.fmt(c.minor, c.currency)).join(' + ') ?? ''}</th><th /></tr></tfoot>
        </table>
        {b.quote.estimatedProfitBaseMinor !== null && pre && <p>{t('estimatedProfit')}: <strong className="ltr">{m.fmt(b.quote.estimatedProfitBaseMinor, m.base)}</strong></p>}
        {pre && (
          <div className="actions">
            {can('booking.issue') && <button className="primary" onClick={() => setDialog({ k: 'ticketed' })} data-testid="confirm-ticketed">{t('confirmTicketed')}</button>}
            {can('booking.reserve') && b.status === 'DRAFT' && <button onClick={() => act(() => call('bookings.reserve', { id: b.id, rowVersion: b.rowVersion }))} data-testid="mark-reserved">{t('markReserved')}</button>}
            {can('booking.reserve') && b.status === 'RESERVED' && <button onClick={() => act(() => call('bookings.release', { id: b.id, rowVersion: b.rowVersion }))}>{t('releaseReservation')}</button>}
            {can('booking.discard') && <button className="danger" onClick={() => setDialog({ k: 'discard' })}>{t('discardDraft')}</button>}
          </div>
        )}
      </section>

      {b.tickets.length > 0 && (
        <section className="card section">
          <h2>{t('tickets')}</h2>
          <table data-testid="tickets-table">
            <thead><tr><th>{t('ticketNumber')}</th><th>{t('passenger')}</th><th>{t('airline')}</th><th>{t('supplierSource')}</th><th>{t('issueDate')}</th><th>{t('status')}</th><th className="num">{t('customerPrice')}</th><th className="num">{t('purchaseCost')}</th><th /></tr></thead>
            <tbody>{b.tickets.map((x) => (
              <tr key={x.id} className={x.status === 'EXCHANGED' ? 'muted' : ''} data-ticket={x.status}>
                <td className="ltr">{x.ticketNumber ?? (x.status === 'ISSUED' && (can('booking.issue') || can('booking.edit')) ? <button className="link" onClick={() => setDialog({ k: 'ticketNo', ticketId: x.id })}>{t('recordTicketNumber')}</button> : '—')}
                  {x.ticketNumber && x.status !== 'EXCHANGED' && can('booking.adjust_price') && <button className="link small" onClick={() => setDialog({ k: 'ticketNo', ticketId: x.id, current: x.ticketNumber })} data-testid="correct-ticket-number">{t('correct')}</button>}
                  {x.exchangedFromNumber && <div className="small muted">{t('replaces')} {x.exchangedFromNumber}</div>}</td>
                <td className="ltr">{x.passengerName}</td><td>{x.airlineName}</td><td>{x.supplierName}</td><td className="ltr">{date(x.issueDate)}</td>
                <td><span className={`badge ${x.status === 'ISSUED' ? 'ok' : 'warn'}`}>{t(`tk_${x.status}` as TKey)}</span></td>
                <td className="num ltr">{m.fmt(x.saleMinor, x.saleCurrency)}</td><td className="num ltr">{x.costMinor === null ? '—' : m.fmt(x.costMinor, x.costCurrency ?? m.base)}</td>
                <td className="row-actions">{x.status === 'ISSUED' && can('booking.reissue') && (b.status === 'ISSUED' || b.status === 'PARTIALLY_CANCELLED') &&
                  <button onClick={() => setDialog({ k: 'reissue', ticketId: x.id })} data-testid="reissue-ticket">{t('reissue')}</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}

      {!pre && (
        <div className="record-grid">
          <section className="card section" data-testid="customer-account">
            <h2>{t('customerAccount')}</h2>
            <div className="money-summary">
              <div><span>{t('total')}</span><strong className="ltr" data-testid="acc-total">{m.fmt(total, b.saleCurrency)}</strong></div>
              <div><span>{t('paid')}</span><strong className="ltr" data-testid="acc-paid">{m.fmt(paid, b.saleCurrency)}</strong></div>
              <div className={remaining > 0 ? 'due' : remaining < 0 ? 'credit' : ''}><span>{remaining < 0 ? t('pay_CREDIT') : t('remaining')}</span><strong className="ltr" data-testid="acc-remaining">{m.fmt(Math.abs(remaining), b.saleCurrency)}</strong></div>
            </div>
            {pos && <p><span className={`badge ${pos.settlement === 'PAID' ? 'ok' : pos.settlement === 'CREDIT' ? 'warn' : 'bad'}`} data-testid="settlement">{t(`pay_${pos.settlement}` as TKey)}</span></p>}
            <div className="actions">
              {can('payment.customer.receive') && remaining > 0 && <button className="primary" onClick={() => setDialog({ k: 'pay', kind: 'receive', currency: b.saleCurrency })} data-testid="record-payment">{t('recordPayment')}</button>}
              {can('payment.customer.refund') && remaining < 0 && <button onClick={() => setDialog({ k: 'pay', kind: 'refundCustomer', currency: b.saleCurrency })} data-testid="refund-customer">{t('refundCustomer')}</button>}
            </div>
          </section>
          {b.suppliers && (
            <section className="card section" data-testid="supplier-account">
              <h2>{t('supplierAccount')}</h2>
              {b.suppliers.map((sp) => (
                <div key={`${sp.supplierId}${sp.currency}`} className="supplier-line">
                  <strong>{sp.supplierName}</strong>
                  <div className="money-summary compact">
                    <div><span>{t('billed')}</span><strong className="ltr">{m.fmt(sp.billedMinor, sp.currency)}</strong></div>
                    <div><span>{t('paid')}</span><strong className="ltr">{m.fmt(sp.paidMinor, sp.currency)}</strong></div>
                    <div className={sp.balanceMinor > 0 ? 'due' : sp.balanceMinor < 0 ? 'credit' : ''}><span>{t('remaining')}</span><strong className="ltr" data-testid="sup-remaining">{m.fmt(sp.balanceMinor, sp.currency)}</strong></div>
                  </div>
                  <div className="actions tight">
                    {can('payment.supplier.pay') && sp.balanceMinor > 0 && <button onClick={() => setDialog({ k: 'pay', kind: 'paySupplier', supplierId: sp.supplierId, supplierName: sp.supplierName, currency: sp.currency })} data-testid="pay-supplier">{t('paySupplier')}</button>}
                    {can('payment.supplier.record_refund') && sp.balanceMinor < 0 && <button onClick={() => setDialog({ k: 'pay', kind: 'supplierRefund', supplierId: sp.supplierId, supplierName: sp.supplierName, currency: sp.currency })}>{t('supplierRefund')}</button>}
                  </div>
                </div>
              ))}
            </section>
          )}
          {b.profit && (
            <section className="card section" data-testid="profit-box">
              <h2>{t('profitBox')}</h2>
              <div className="money-summary">
                <div><span>{t('netSales')}</span><strong className="ltr">{m.fmt(b.profit.netSalesBaseMinor, m.base)}</strong></div>
                <div><span>{t('netCost')}</span><strong className="ltr">{m.fmt(b.profit.netCostBaseMinor, m.base)}</strong></div>
                <div className={b.profit.grossProfitBaseMinor < 0 ? 'due' : 'credit'}><span>{t('grossProfit')}</span><strong className="ltr" data-testid="gross-profit">{m.fmt(b.profit.grossProfitBaseMinor, m.base)}</strong></div>
              </div>
            </section>
          )}
        </div>
      )}

      {live && (can('booking.adjust_price') || can('booking.change_supplier') || can('refund.request')) && (
        <section className="card section">
          <h2>{t('moreActions')}</h2>
          <div className="actions">
            {can('refund.request') && <button onClick={() => setDialog({ k: 'cancelReq' })} data-testid="request-cancellation">{t('requestCancellation')}</button>}
            {can('booking.adjust_price') && <button onClick={() => setDialog({ k: 'adjust', mode: 'sale' })}>{t('adjustSale')}</button>}
            {can('booking.adjust_price') && can('booking.enter_cost') && <button onClick={() => setDialog({ k: 'adjust', mode: 'cost' })}>{t('adjustCost')}</button>}
            {can('booking.change_supplier') && can('booking.enter_cost') && <button onClick={() => setDialog({ k: 'adjust', mode: 'supplier' })}>{t('changeSupplier')}</button>}
          </div>
        </section>
      )}

      {b.cancellations.length > 0 && (
        <section className="card section" data-testid="cancellations">
          <h2>{t('cancellations')}</h2>
          {b.cancellations.map((c) => (
            <div key={c.id} className="cx">
              <p><strong className="ltr">{c.requestNo}</strong> · {t(`ct_${c.cancelType}` as TKey)} · <span className="badge">{t(`cs_${c.overallStatus}` as TKey)}</span> · {c.reason}</p>
              <p>{t('supplierSide')}: <span className="badge" data-testid="cx-supplier">{t(`cs_${c.supplierStatus}` as TKey)}</span> · {t('customerSide')}: <span className="badge" data-testid="cx-customer">{t(`cs_${c.customerStatus}` as TKey)}</span>
                {c.expectedSupplierRefund && <> · {t('expectedSupplierRefund')}: <span className="ltr">{m.fmt(c.expectedSupplierRefund.minor, c.expectedSupplierRefund.currency)}</span></>}</p>
              <p className="small">{c.tickets.map((x) => `${x.passengerName} ${x.ticketNumber ?? ''}`).join('، ')}</p>
              {c.overallStatus === 'OPEN' && can('refund.manage') && (
                <div className="actions tight">
                  {c.supplierStatus === 'PENDING' && <button onClick={() => act(() => call('cancellations.submit', { id: c.id, rowVersion: c.rowVersion }))} data-testid="cx-submit">{t('submitToSupplier')}</button>}
                  {(c.supplierStatus === 'PENDING' || c.supplierStatus === 'SUBMITTED') && <button onClick={() => setDialog({ k: 'supplierConfirm', c })} data-testid="cx-confirm-supplier">{t('confirmSupplier')}</button>}
                  {c.supplierStatus === 'SUBMITTED' && <button onClick={() => setDialog({ k: 'cxNote', c, action: 'reject' })}>{t('rejectSupplier')}</button>}
                  {c.customerStatus === 'PENDING' && <button onClick={() => setDialog({ k: 'customerCredit', c })} data-testid="cx-credit-customer">{t('creditCustomer')}</button>}
                  {c.customerStatus === 'PENDING' && <button onClick={() => setDialog({ k: 'cxNote', c, action: 'nothing' })}>{t('customerNothing')}</button>}
                  {['PENDING', 'SUBMITTED'].includes(c.supplierStatus) && c.customerStatus === 'PENDING' && <button className="danger" onClick={() => setDialog({ k: 'cxNote', c, action: 'withdraw' })}>{t('withdraw')}</button>}
                </div>
              )}
            </div>
          ))}
          {openCx.length === 0 && b.profit && <p>{t('financialImpact')}: <strong className="ltr">{m.fmt(b.profit.grossProfitBaseMinor, m.base)}</strong></p>}
        </section>
      )}

      {b.scheduleChanges.length > 0 && (
        <section className="card section" data-testid="schedule-changes">
          <h2>{t('scheduleChanges')}</h2>
          <table>
            <thead><tr><th>{t('date')}</th><th>{t('segment')}</th><th>{t('severity')}</th><th>{t('changes')}</th><th>{t('notification')}</th><th /></tr></thead>
            <tbody>{b.scheduleChanges.map((c) => (
              <tr key={c.id} className={c.requiresAttention ? 'attention' : ''}>
                <td className="ltr">{dateTime(c.changedAt)}</td><td className="ltr">{c.segmentLabel}</td><td><span className={`badge ${c.severity === 'MAJOR' ? 'bad' : ''}`}>{t(c.severity)}</span></td>
                <td>{c.fields.map((f) => <div key={f.field} className="small"><span className="muted">{f.field}</span>: <s className="ltr">{f.oldValue ?? '—'}</s> → <strong className="ltr">{f.newValue ?? '—'}</strong></div>)}</td>
                <td><span className={`badge ${c.requiresAttention ? 'bad' : 'ok'}`} data-testid="change-status">{t(`ns_${c.notificationStatus}` as TKey)}</span>{c.superseded && <span className="muted small"> ({t('archived')})</span>}</td>
                <td className="row-actions">
                  {can('schedule.notify') && !c.superseded && c.notificationStatus !== 'MANUALLY_CONFIRMED' && <button onClick={() => setDialog({ k: 'notify', change: c })} data-testid="notify-customer">{t('notifyCustomer')}</button>}
                  {can('schedule.confirm') && c.notificationStatus !== 'MANUALLY_CONFIRMED' && <button onClick={() => setDialog({ k: 'confirmChange', change: c })}>{t('confirmWithCustomer')}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
          {b.notifications.length > 0 && (
            <>
              <h3>{t('notificationsHistory')}</h3>
              <ul className="plain small">{b.notifications.map((n) => <li key={n.id}><span className="ltr">{dateTime(n.createdAt)}</span> · {t(n.channel)} · {n.status === 'SENT' ? t('outcomeSent') : t('outcomeFailed')} · {n.createdBy}{n.note ? ` · ${n.note}` : ''}</li>)}</ul>
            </>
          )}
        </section>
      )}

      <AttachmentsSection bookingId={b.id} canEdit={can('booking.edit')} />

      {b.documents.length > 0 && (
        <section className="card section">
          <h2>{t('documents')}</h2>
          <table data-testid="documents-table">
            <thead><tr><th>{t('date')}</th><th>{t('document')}</th><th>{t('type')}</th><th className="num">{t('amount')}</th><th>{t('user')}</th><th /></tr></thead>
            <tbody>{b.documents.map((d) => (
              <tr key={d.id} className={d.reversedByNo ? 'struck' : ''}>
                <td className="ltr">{date(d.docDate)}</td><td className="ltr">{d.docNo}{d.isReversal && <span className="muted"> ↺ {d.reversalOfNo}</span>}</td>
                <td>{isTKey(`docType_${d.docType}`) ? t(`docType_${d.docType}` as TKey) : d.docType}{d.reversedByNo && <span className="badge muted">{t('reversed')}</span>}</td>
                <td className="num ltr">{m.fmt(d.totalMinor, d.currency)}</td><td>{d.createdBy}</td>
                <td className="row-actions">
                  <button onClick={() => setDialog({ k: 'doc', doc: d })}>{t('print')}</button>
                  {!d.isReversal && !d.reversedByNo && ['CUSTOMER_RECEIPT', 'CUSTOMER_REFUND', 'SUPPLIER_PAYMENT', 'SUPPLIER_REFUND'].includes(d.docType)
                    && (can('payment.customer.reverse') || can('payment.supplier.reverse')) && <button className="danger" onClick={() => setDialog({ k: 'cancelDoc', doc: d })}>{t('cancelDocument')}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}

      <section className="card section">
        <h2>{t('statusHistory')}</h2>
        <ul className="plain small">{b.statusHistory.map((h, i) => <li key={i}><span className="ltr">{dateTime(h.changedAt)}</span> · {h.fromStatus ? `${t(`st_${h.fromStatus}` as TKey)} → ` : ''}{t(`st_${h.toStatus}` as TKey)} · {h.changedBy}{h.reason ? ` · ${h.reason}` : ''}</li>)}</ul>
        <p className="muted small">{t('createdBy')}: {b.createdBy} · <span className="ltr">{dateTime(b.createdAt)}</span> · {t('updatedAt')}: <span className="ltr">{dateTime(b.updatedAt)}</span>{b.updatedBy ? ` (${b.updatedBy})` : ''}</p>
      </section>

      {dialog?.k === 'header' && <HeaderDialog b={b} onClose={() => setDialog(null)} onSaved={() => refresh(t('saved'))} />}
      {dialog?.k === 'passenger' && <PassengerDialog b={b} p={dialog.p} onClose={() => setDialog(null)} onSaved={() => refresh(t('saved'))} />}
      {dialog?.k === 'segment' && <SegmentDialog b={b} s={dialog.s} onClose={() => setDialog(null)} onSaved={() => refresh(t('saved'))} />}
      {dialog?.k === 'price' && <PriceDialog b={b} passenger={dialog.passenger} item={dialog.item} canCost={can('booking.enter_cost')} onClose={() => setDialog(null)} onSaved={() => refresh(t('saved'))} />}
      {dialog?.k === 'ticketed' && <TicketedDialog b={b} onClose={() => setDialog(null)} onSaved={() => refresh(t('saved'))} />}
      {dialog?.k === 'discard' && <ConfirmDialog title={t('discardDraft')} text={t('confirmArchive')} confirmLabel={t('discardDraft')} danger withReason onClose={() => setDialog(null)}
        onConfirm={async (reason) => { await call('bookings.discard', { id: b.id, rowVersion: b.rowVersion, reason: reason ?? '—' }); refresh(t('saved')); }} />}
      {dialog?.k === 'pay' && (
        <PaymentDialog kind={dialog.kind} partyId={dialog.supplierId ?? b.customerId} partyName={dialog.supplierName ?? b.customerName} currency={dialog.currency}
          items={[{ bookingId: b.id, bookingNo: b.bookingNo, openMinor: dialog.kind === 'receive' ? Math.max(0, remaining)
            : dialog.kind === 'refundCustomer' ? Math.max(0, -remaining)
              : Math.abs(b.suppliers?.find((s) => s.supplierId === dialog.supplierId && s.currency === dialog.currency)?.balanceMinor ?? 0) }]}
          summary={dialog.kind === 'receive' ? { totalMinor: total, paidMinor: paid, remainingMinor: remaining } : null}
          canOnAccount={can('payment.accept_overpayment') && (dialog.kind === 'receive' || dialog.kind === 'paySupplier')}
          onDone={() => rec.reload()} onClose={() => setDialog(null)} />
      )}
      {dialog?.k === 'doc' && <DocumentPrint doc={dialog.doc} onClose={() => setDialog(null)} />}
      {dialog?.k === 'print' && <RecordPrint record={b} onClose={() => setDialog(null)} />}
      {dialog?.k === 'cancelDoc' && <ConfirmDialog title={`${t('cancelDocument')} ${dialog.doc.docNo}`} text={t('cancelDocumentText')} confirmLabel={t('cancelDocument')} danger withReason onClose={() => setDialog(null)}
        onConfirm={async (reason) => { await call('documents.cancel', { id: dialog.doc.id, reason: reason ?? '' }); refresh(t('saved')); }} />}
      {dialog?.k === 'reissue' && <ReissueDialog b={b} ticketId={dialog.ticketId} canCost={can('booking.enter_cost')} onClose={() => setDialog(null)} onSaved={() => refresh(t('saved'))} />}
      {dialog?.k === 'ticketNo' && <TicketNumberDialog bookingId={b.id} ticketId={dialog.ticketId} current={dialog.current ?? null} onClose={() => setDialog(null)} onSaved={() => refresh(t('saved'))} />}
      {dialog?.k === 'cancelReq' && <CancelRequestDialog b={b} onClose={() => setDialog(null)} onSaved={() => refresh(t('saved'))} />}
      {dialog?.k === 'supplierConfirm' && <CxAmountsDialog b={b} c={dialog.c} side="supplier" onClose={() => setDialog(null)} onSaved={() => refresh(t('saved'))} />}
      {dialog?.k === 'customerCredit' && <CxAmountsDialog b={b} c={dialog.c} side="customer" onClose={() => setDialog(null)} onSaved={() => refresh(t('saved'))} />}
      {dialog?.k === 'cxNote' && (
        <ConfirmDialog title={t(dialog.action === 'reject' ? 'rejectSupplier' : dialog.action === 'nothing' ? 'customerNothing' : 'withdraw')} text={t('note')}
          confirmLabel={t('save')} withReason danger={dialog.action === 'withdraw'} onClose={() => setDialog(null)}
          onConfirm={async (note) => {
            const cmd = dialog.action === 'reject' ? 'cancellations.rejectSupplier' : dialog.action === 'nothing' ? 'cancellations.customerNotApplicable' : 'cancellations.withdraw';
            await call(cmd as never, { id: dialog.c.id, rowVersion: dialog.c.rowVersion, ...(dialog.action === 'withdraw' ? { reason: note ?? '—' } : { note: note ?? '—' }) });
            refresh(t('saved'));
          }} />
      )}
      {dialog?.k === 'notify' && <NotifyDialog b={b} change={dialog.change} onClose={() => setDialog(null)} onSaved={() => refresh(t('saved'))} />}
      {dialog?.k === 'confirmChange' && <ConfirmDialog title={t('confirmWithCustomer')} text={t('note')} confirmLabel={t('save')} withReason onClose={() => setDialog(null)}
        onConfirm={async (note) => { await call('schedule.setStatus', { id: dialog.change.id, rowVersion: dialog.change.rowVersion, status: 'MANUALLY_CONFIRMED', note }); refresh(t('saved')); }} />}
      {dialog?.k === 'adjust' && <AdjustDialog b={b} mode={dialog.mode} onClose={() => setDialog(null)} onSaved={() => refresh(t('saved'))} />}
    </div>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────────

function useSave(onSaved: () => void) {
  const { errorMessage, fieldIssues } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null); setIssues([]);
    try { await fn(); onSaved(); } catch (e) { setError(errorMessage(e)); setIssues(fieldIssues(e)); } finally { setBusy(false); }
  };
  const err = (f: string) => issues.find((i) => i.field === f)?.message;
  return { error, busy, run, err };
}

function FieldErr({ msg }: { msg: string | undefined }) {
  return msg ? <span className="field-error">{msg}</span> : null;
}

function HeaderDialog({ b, onClose, onSaved }: { b: BookingDto; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const suppliers = useSuppliers();
  const airlines = useAirlines();
  const [v, setV] = useState({ pnr: b.pnr ?? '', supplierId: b.defaultSupplierId, airlineId: b.airlineId, saleCurrency: b.saleCurrency, contactName: b.contactName, contactMobile: b.contactMobile, contactWhatsapp: b.contactWhatsapp ?? '', notes: b.notes ?? '' });
  const pre = b.status === 'DRAFT' || b.status === 'RESERVED';
  const { error, busy, run, err } = useSave(onSaved);
  return (
    <Modal wide title={t('ticketRecord')} onClose={onClose} testId="header-dialog"
      footer={<><button className="primary" disabled={busy} onClick={() => run(() => call('bookings.update', { id: b.id, rowVersion: b.rowVersion, patch: { ...v, pnr: v.pnr || null, contactWhatsapp: v.contactWhatsapp || null, notes: v.notes || null, ...(pre ? {} : { saleCurrency: undefined }) } }))} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid">
        <label>{t('pnr')}<input className="ltr code" value={v.pnr} maxLength={8} onChange={(e) => setV({ ...v, pnr: e.target.value.toUpperCase() })} data-testid="h-pnr" /><span className="hint">{t('pnrHint')}</span><FieldErr msg={err('pnr')} /></label>
        <SupplierSelect label={t('supplierSource')} value={v.supplierId} onChange={(x) => setV({ ...v, supplierId: x })} suppliers={suppliers} />
        <AirlineSelect label={t('airline')} value={v.airlineId} onChange={(x) => setV({ ...v, airlineId: x })} airlines={airlines} />
        <CurrencySelect label={t('saleCurrency')} value={v.saleCurrency} onChange={(x) => setV({ ...v, saleCurrency: x })} disabled={!pre} />
        <label>{t('contactName')}<input value={v.contactName} onChange={(e) => setV({ ...v, contactName: e.target.value })} /></label>
        <label>{t('contactMobile')}<input className="ltr" value={v.contactMobile} onChange={(e) => setV({ ...v, contactMobile: e.target.value })} /></label>
        <label>{t('whatsapp')}<input className="ltr" value={v.contactWhatsapp} onChange={(e) => setV({ ...v, contactWhatsapp: e.target.value })} /></label>
        <label className="span-all">{t('notes')}<textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></label>
      </div>
    </Modal>
  );
}

function PassengerDialog({ b, p, onClose, onSaved }: { b: BookingDto; p: PassengerDto | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [v, setV] = useState({
    paxType: p?.paxType ?? 'ADT', title: p?.title ?? '', givenName: p?.givenName ?? '', surname: p?.surname ?? '', nameAr: p?.nameAr ?? '',
    gender: p?.gender ?? '', dateOfBirth: p?.dateOfBirth ?? '', nationality: p?.nationality ?? '', passportNo: p && !p.identityMasked ? p.passportNo ?? '' : '',
    passportExpiry: p?.passportExpiry ?? '', frequentFlyerNo: p?.frequentFlyerNo ?? '', mobile: p?.mobile ?? '', notes: p?.notes ?? '',
  });
  const pre = b.status === 'DRAFT' || b.status === 'RESERVED';
  const { error, busy, run, err } = useSave(onSaved);
  const nul = (x: string) => (x.trim() === '' ? null : x);
  const save = () => run(() => call('bookings.savePassenger', {
    bookingId: b.id, passengerId: p?.id ?? null,
    passenger: { paxType: v.paxType, title: nul(v.title), givenName: v.givenName, surname: v.surname, nameAr: nul(v.nameAr), gender: nul(v.gender), dateOfBirth: nul(v.dateOfBirth),
      nationality: nul(v.nationality), passportNo: nul(v.passportNo), passportExpiry: nul(v.passportExpiry), frequentFlyerNo: nul(v.frequentFlyerNo), mobile: nul(v.mobile), notes: nul(v.notes) },
  }));
  return (
    <Modal wide title={p ? t('passenger') : t('addPassenger')} onClose={onClose} testId="passenger-dialog"
      footer={<><button className="primary" disabled={busy} onClick={save} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <form className="grid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>{t('paxType')}<select value={v.paxType} disabled={!pre} onChange={(e) => setV({ ...v, paxType: e.target.value as never })}>{(['ADT', 'CHD', 'INF'] as const).map((x) => <option key={x} value={x}>{t(x)}</option>)}</select></label>
        <label>{t('givenName')}<input className="ltr" value={v.givenName} disabled={!pre} onChange={(e) => setV({ ...v, givenName: e.target.value })} data-testid="p-given" /><FieldErr msg={err('givenName')} /></label>
        <label>{t('surname')}<input className="ltr" value={v.surname} disabled={!pre} onChange={(e) => setV({ ...v, surname: e.target.value })} data-testid="p-surname" /><FieldErr msg={err('surname')} /></label>
        <label>{t('nameAr')}<input value={v.nameAr} onChange={(e) => setV({ ...v, nameAr: e.target.value })} /></label>
        <label>{t('gender')}<select value={v.gender} onChange={(e) => setV({ ...v, gender: e.target.value })}><option value="">—</option><option value="M">{t('male')}</option><option value="F">{t('female')}</option></select></label>
        <label>{t('dateOfBirth')}<input type="date" className="ltr" value={v.dateOfBirth} onChange={(e) => setV({ ...v, dateOfBirth: e.target.value })} /><FieldErr msg={err('dateOfBirth')} /></label>
        <label>{t('nationality')}<input className="ltr code" maxLength={2} value={v.nationality} onChange={(e) => setV({ ...v, nationality: e.target.value.toUpperCase() })} /><FieldErr msg={err('nationality')} /></label>
        <label>{t('passportNo')}<input className="ltr code" value={v.passportNo} placeholder={p?.identityMasked ? p.passportNo ?? '' : ''} onChange={(e) => setV({ ...v, passportNo: e.target.value.toUpperCase() })} /><FieldErr msg={err('passportNo')} /></label>
        <label>{t('passportExpiry')}<input type="date" className="ltr" value={v.passportExpiry} onChange={(e) => setV({ ...v, passportExpiry: e.target.value })} /></label>
        <label>{t('frequentFlyer')}<input className="ltr" value={v.frequentFlyerNo} onChange={(e) => setV({ ...v, frequentFlyerNo: e.target.value })} /></label>
        <label>{t('mobile')}<input className="ltr" value={v.mobile} onChange={(e) => setV({ ...v, mobile: e.target.value })} /></label>
        <label className="span-all">{t('notes')}<input value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></label>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function SegmentDialog({ b, s, onClose, onSaved }: { b: BookingDto; s: SegmentDto | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const airlines = useAirlines();
  const pre = b.status === 'DRAFT' || b.status === 'RESERVED';
  const [v, setV] = useState({
    airlineId: s?.airlineId ?? b.airlineId ?? '', flightNumber: s?.flightNumber ?? '', origin: s?.origin ?? '', destination: s?.destination ?? '',
    departureDate: s?.departureDate ?? '', departureTime: s?.departureTime ?? '', arrivalDate: s?.arrivalDate ?? '', arrivalTime: s?.arrivalTime ?? '',
    cabinClass: s?.cabinClass ?? 'ECONOMY', bookingClass: s?.bookingClass ?? '', departureTerminal: s?.departureTerminal ?? '', arrivalTerminal: s?.arrivalTerminal ?? '',
    baggage: s?.baggage ?? '', seat: s?.seat ?? '', status: s?.status ?? 'CONFIRMED', notes: s?.notes ?? '',
  });
  const [reason, setReason] = useState('');
  const { error, busy, run, err } = useSave(onSaved);
  const nul = (x: string) => (x.trim() === '' ? null : x);
  const save = () => run(() => call('bookings.saveSegment', {
    bookingId: b.id, segmentId: s?.id ?? null, reason: nul(reason),
    segment: { ...v, bookingClass: nul(v.bookingClass), departureTerminal: nul(v.departureTerminal), arrivalTerminal: nul(v.arrivalTerminal), baggage: nul(v.baggage), seat: nul(v.seat), notes: nul(v.notes),
      arrivalDate: v.arrivalDate || v.departureDate },
  }));
  return (
    <Modal wide title={s ? t('editFlight') : t('addFlight')} onClose={onClose} testId="segment-dialog"
      footer={<><button className="primary" disabled={busy} onClick={save} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {!pre && <Alert kind="warn">{t('changeReasonHint')}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      <form className="grid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <AirlineSelect label={t('airline')} value={v.airlineId || null} onChange={(x) => setV({ ...v, airlineId: x ?? '' })} airlines={airlines} testId="s-airline" />
        <label>{t('flightNumber')}<input className="ltr code" value={v.flightNumber} maxLength={5} onChange={(e) => setV({ ...v, flightNumber: e.target.value })} data-testid="s-flight" /><FieldErr msg={err('flightNumber')} /></label>
        <AirportInput label={t('origin')} value={v.origin} onChange={(x) => setV({ ...v, origin: x })} testId="s-origin" />
        <AirportInput label={t('destination')} value={v.destination} onChange={(x) => setV({ ...v, destination: x })} testId="s-destination" />
        <label>{t('departureDate')}<input type="date" className="ltr" value={v.departureDate} onChange={(e) => setV({ ...v, departureDate: e.target.value, arrivalDate: v.arrivalDate || e.target.value })} data-testid="s-dep-date" /><FieldErr msg={err('departureDate')} /></label>
        <label>{t('departureTime')}<input type="time" className="ltr" value={v.departureTime} onChange={(e) => setV({ ...v, departureTime: e.target.value })} data-testid="s-dep-time" /><FieldErr msg={err('departureTime')} /></label>
        <label>{t('arrivalDate')}<input type="date" className="ltr" value={v.arrivalDate} onChange={(e) => setV({ ...v, arrivalDate: e.target.value })} data-testid="s-arr-date" /><FieldErr msg={err('arrivalDate')} /></label>
        <label>{t('arrivalTime')}<input type="time" className="ltr" value={v.arrivalTime} onChange={(e) => setV({ ...v, arrivalTime: e.target.value })} data-testid="s-arr-time" /><FieldErr msg={err('arrivalTime')} /></label>
        <label>{t('cabin')}<select value={v.cabinClass} onChange={(e) => setV({ ...v, cabinClass: e.target.value as never })}>{(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'] as const).map((x) => <option key={x} value={x}>{t(x)}</option>)}</select></label>
        <label>{t('bookingClassLabel')}<input className="ltr code" maxLength={1} value={v.bookingClass} onChange={(e) => setV({ ...v, bookingClass: e.target.value.toUpperCase() })} /></label>
        <label>{t('terminal')} ({t('departure')})<input className="ltr" value={v.departureTerminal} onChange={(e) => setV({ ...v, departureTerminal: e.target.value })} /></label>
        <label>{t('baggage')}<input value={v.baggage} onChange={(e) => setV({ ...v, baggage: e.target.value })} placeholder="23kg" /></label>
        <label>{t('seatLabel')}<input className="ltr" value={v.seat} onChange={(e) => setV({ ...v, seat: e.target.value })} /></label>
        {!pre && <label>{t('status')}<select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value as never })}><option value="CONFIRMED">OK</option><option value="WAITLISTED">WL</option><option value="CANCELLED">{t('st_CANCELLED')}</option></select></label>}
        {!pre && <label className="span-all">{t('changeReason')}<input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="s-reason" /></label>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function PriceDialog({ b, passenger, item, canCost, onClose, onSaved }: { b: BookingDto; passenger: PassengerDto; item: PriceItemDto | null; canCost: boolean; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const m = useMoney();
  const suppliers = useSuppliers();
  const airlines = useAirlines();
  const [v, setV] = useState({
    supplierId: item?.supplierId ?? b.defaultSupplierId, airlineId: item?.validatingAirlineId ?? b.airlineId, ticketNumber: item?.ticketNumber ?? '',
    fare: item?.fareMinor ?? null as number | null, taxes: item?.taxesMinor ?? 0 as number | null, fee: item?.serviceFeeMinor ?? 0 as number | null, discount: item?.discountMinor ?? 0 as number | null,
    costCurrency: item?.costCurrency ?? b.saleCurrency, cost: item?.costMinor ?? null as number | null, supplierReference: item?.supplierReference ?? '', notes: item?.notes ?? '',
  });
  const [costTouched, setCostTouched] = useState(false);
  const { error, busy, run, err } = useSave(onSaved);
  const sale = (v.fare ?? 0) + (v.taxes ?? 0) + (v.fee ?? 0) - (v.discount ?? 0);
  const save = () => run(() => call('bookings.savePriceItem', {
    bookingId: b.id, itemId: item?.id ?? null,
    item: {
      passengerId: passenger.id, supplierId: v.supplierId, validatingAirlineId: v.airlineId, ticketNumber: v.ticketNumber || null, fareMinor: v.fare ?? 0,
      taxesMinor: v.taxes ?? 0, serviceFeeMinor: v.fee ?? 0, discountMinor: v.discount ?? 0, supplierReference: v.supplierReference || null, notes: v.notes || null,
      ...(canCost && (costTouched || !item?.costEntered) ? { costCurrency: v.costCurrency, costMinor: v.cost } : {}),
    },
  }));
  return (
    <Modal wide title={`${t('priceFor')}: ${passenger.givenName} ${passenger.surname}`} onClose={onClose} testId="price-dialog"
      footer={<><strong className="grow">{t('customerPrice')}: <span className="ltr" data-testid="price-total">{m.fmt(sale, b.saleCurrency)}</span></strong><button className="primary" disabled={busy} onClick={save} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid">
        <SupplierSelect label={t('supplierSource')} value={v.supplierId} onChange={(x) => setV({ ...v, supplierId: x })} suppliers={suppliers} testId="pr-supplier" />
        <AirlineSelect label={t('airline')} value={v.airlineId} onChange={(x) => setV({ ...v, airlineId: x })} airlines={airlines} />
        <label>{t('ticketNumber')}<input className="ltr code" value={v.ticketNumber} onChange={(e) => setV({ ...v, ticketNumber: e.target.value })} data-testid="pr-ticket" /><span className="hint">{t('ticketNumberHint')}</span><FieldErr msg={err('ticketNumber')} /></label>
      </div>
      <p className="hint">{t('supplierSourceHint')}</p>
      <h3>{t('customerPrice')}</h3>
      <div className="grid">
        <MoneyInput label={t('fare')} value={v.fare} currency={b.saleCurrency} onChange={(x) => setV({ ...v, fare: x })} testId="pr-fare" required />
        <MoneyInput label={t('taxes')} value={v.taxes} currency={b.saleCurrency} onChange={(x) => setV({ ...v, taxes: x })} testId="pr-taxes" />
        <MoneyInput label={t('serviceFee')} value={v.fee} currency={b.saleCurrency} onChange={(x) => setV({ ...v, fee: x })} testId="pr-fee" />
        <MoneyInput label={t('discount')} value={v.discount} currency={b.saleCurrency} onChange={(x) => setV({ ...v, discount: x })} testId="pr-discount" />
      </div>
      {canCost ? (
        <>
          <h3>{t('purchaseCost')}</h3>
          {item?.costEntered && item.costMinor === null && !costTouched && <p className="hint">{t('costEnteredHidden')}</p>}
          <div className="grid">
            <CurrencySelect label={t('costCurrency')} value={v.costCurrency} onChange={(x) => { setCostTouched(true); setV({ ...v, costCurrency: x }); }} />
            <MoneyInput label={t('purchaseCost')} value={v.cost} currency={v.costCurrency} onChange={(x) => { setCostTouched(true); setV({ ...v, cost: x }); }} testId="pr-cost" required />
            <label>{t('supplierReference')}<input className="ltr" value={v.supplierReference} onChange={(e) => setV({ ...v, supplierReference: e.target.value })} /></label>
          </div>
        </>
      ) : <p className="hint">{t('noPermission')}: {t('purchaseCost')}</p>}
    </Modal>
  );
}

function TicketedDialog({ b, onClose, onSaved }: { b: BookingDto; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [issueDate, setIssueDate] = useState('');
  const { error, busy, run } = useSave(onSaved);
  return (
    <Modal title={t('confirmTicketed')} onClose={onClose} testId="ticketed-dialog"
      footer={<><button className="primary" disabled={busy} onClick={() => run(() => call('bookings.issue', { id: b.id, rowVersion: b.rowVersion, issueDate: issueDate || null }))} data-testid="confirm">{t('confirmTicketed')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      <p>{t('confirmTicketedText')}</p>
      <p className="hint">{t('scopeNote')}</p>
      <label>{t('issueDate')}<input type="date" className="ltr" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></label>
      {error && <Alert kind="error">{error}</Alert>}
    </Modal>
  );
}

/**
 * Records a reissue/exchange that the airline or consolidator already made:
 * new ticket number, new flight details, and the money differences only.
 */
function ReissueDialog({ b, ticketId, canCost, onClose, onSaved }: { b: BookingDto; ticketId: string; canCost: boolean; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const ticket = b.tickets.find((x) => x.id === ticketId)!;
  const costCur = ticket.costCurrency ?? b.saleCurrency;
  const active = b.segments.filter((s) => s.status !== 'CANCELLED');
  const [v, setV] = useState({ number: '', fare: null as number | null, fee: null as number | null, cost: null as number | null, penalty: null as number | null, reference: '', reason: '', date: '' });
  const [flights, setFlights] = useState<Record<string, { departureDate: string; departureTime: string; arrivalDate: string; arrivalTime: string; flightNumber: string }>>(
    () => Object.fromEntries(active.map((s) => [s.id, { departureDate: s.departureDate, departureTime: s.departureTime, arrivalDate: s.arrivalDate, arrivalTime: s.arrivalTime, flightNumber: s.flightNumber }])),
  );
  const { error, busy, run, err } = useSave(onSaved);
  const changed = active.filter((s) => {
    const f = flights[s.id]!;
    return f.departureDate !== s.departureDate || f.departureTime !== s.departureTime || f.arrivalDate !== s.arrivalDate || f.arrivalTime !== s.arrivalTime || f.flightNumber !== s.flightNumber;
  });
  const save = () => run(() => call('bookings.reissue', {
    bookingId: b.id, ticketId, rowVersion: b.rowVersion, newTicketNumber: v.number.trim() || null, reason: v.reason, date: v.date || null,
    fareDifferenceMinor: v.fare ?? 0, changeFeeMinor: v.fee ?? 0, additionalCostMinor: v.cost ?? 0, supplierPenaltyMinor: v.penalty ?? 0,
    externalReference: v.reference.trim() || null,
    segments: changed.map((s) => ({
      segmentId: s.id,
      segment: {
        airlineId: s.airlineId, operatingAirlineId: s.operatingAirlineId, origin: s.origin, destination: s.destination, cabinClass: s.cabinClass,
        bookingClass: s.bookingClass, departureTerminal: s.departureTerminal, arrivalTerminal: s.arrivalTerminal, baggage: s.baggage, seat: s.seat,
        airlineLocator: s.airlineLocator, status: s.status, notes: s.notes, ...flights[s.id]!,
      },
    })),
  }));
  const set = (id: string, patch: Partial<(typeof flights)[string]>) => setFlights({ ...flights, [id]: { ...flights[id]!, ...patch } });
  return (
    <Modal wide title={`${t('reissue')} — ${ticket.ticketNumber ?? ticket.passengerName}`} onClose={onClose} testId="reissue-dialog"
      footer={<><button className="primary" disabled={busy || !v.reason.trim()} onClick={save} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      <p className="hint">{t('reissueHint')}</p>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid">
        <label>{t('newTicketNumber')}<input className="ltr code" value={v.number} maxLength={20} onChange={(e) => setV({ ...v, number: e.target.value })} data-testid="ri-number" /><FieldErr msg={err('newTicketNumber')} /></label>
        <label>{t('date')}<input type="date" className="ltr" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></label>
        <MoneyInput label={t('fareDifference')} value={v.fare} currency={b.saleCurrency} onChange={(x) => setV({ ...v, fare: x })} testId="ri-fare" />
        <MoneyInput label={t('lt_CHANGE_FEE')} value={v.fee} currency={b.saleCurrency} onChange={(x) => setV({ ...v, fee: x })} testId="ri-fee" />
        {canCost && <MoneyInput label={t('additionalCost')} value={v.cost} currency={costCur} onChange={(x) => setV({ ...v, cost: x })} testId="ri-cost" />}
        {canCost && <MoneyInput label={t('lt_SUPPLIER_PENALTY')} value={v.penalty} currency={costCur} onChange={(x) => setV({ ...v, penalty: x })} testId="ri-penalty" />}
        {canCost && <label>{t('supplierReference')}<input className="ltr" value={v.reference} maxLength={60} onChange={(e) => setV({ ...v, reference: e.target.value })} /></label>}
        <label className="span-all">{t('changeReason')}<input value={v.reason} maxLength={500} onChange={(e) => setV({ ...v, reason: e.target.value })} data-testid="ri-reason" /></label>
      </div>
      <h3>{t('flightsAfterReissue')}</h3>
      <table>
        <thead><tr><th>{t('route')}</th><th>{t('flightNumber')}</th><th>{t('departureDate')}</th><th>{t('departureTime')}</th><th>{t('arrivalDate')}</th><th>{t('arrivalTime')}</th></tr></thead>
        <tbody>{active.map((s) => {
          const f = flights[s.id]!;
          return (
            <tr key={s.id} className={changed.includes(s) ? 'changed' : ''}>
              <td className="ltr">{s.origin} → {s.destination}</td>
              <td><input className="ltr code compact" value={f.flightNumber} maxLength={5} onChange={(e) => set(s.id, { flightNumber: e.target.value })} /></td>
              <td><input type="date" className="ltr" value={f.departureDate} onChange={(e) => set(s.id, { departureDate: e.target.value })} data-testid={`ri-dep-${s.seq}`} /></td>
              <td><input type="time" className="ltr" value={f.departureTime} onChange={(e) => set(s.id, { departureTime: e.target.value })} /></td>
              <td><input type="date" className="ltr" value={f.arrivalDate} onChange={(e) => set(s.id, { arrivalDate: e.target.value })} data-testid={`ri-arr-${s.seq}`} /></td>
              <td><input type="time" className="ltr" value={f.arrivalTime} onChange={(e) => set(s.id, { arrivalTime: e.target.value })} /></td>
            </tr>
          );
        })}</tbody>
      </table>
    </Modal>
  );
}

function TicketNumberDialog({ bookingId, ticketId, current, onClose, onSaved }: { bookingId: string; ticketId: string; current: string | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [n, setN] = useState('');
  const [reason, setReason] = useState('');
  const { error, busy, run } = useSave(onSaved);
  return (
    <Modal title={current ? `${t('correctTicketNumber')} — ${current}` : t('recordTicketNumber')} onClose={onClose} testId="ticket-number-dialog"
      footer={<><button className="primary" disabled={busy || !n || (!!current && !reason.trim())} onClick={() => run(() => call('bookings.setTicketNumber', { bookingId, ticketId, ticketNumber: n, ...(current ? { correctionReason: reason } : {}) }))} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      <label>{t('ticketNumber')}<input className="ltr code" value={n} onChange={(e) => setN(e.target.value)} data-testid="tn-value" /><span className="hint">{t('ticketNumberHint')}</span></label>
      {current && <label>{t('changeReason')}<input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} data-testid="tn-reason" /></label>}
      {error && <Alert kind="error">{error}</Alert>}
    </Modal>
  );
}

function CancelRequestDialog({ b, onClose, onSaved }: { b: BookingDto; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const liveTickets = b.tickets.filter((x) => x.status === 'ISSUED' || x.status === 'PARTIALLY_REFUNDED');
  const [type, setType] = useState<'REFUND' | 'VOID' | 'NON_REFUNDABLE'>('REFUND');
  const [ids, setIds] = useState<string[]>(liveTickets.map((x) => x.id));
  const [reason, setReason] = useState('');
  const [expected, setExpected] = useState<number | null>(null);
  const cur = b.tickets[0]?.costCurrency ?? b.saleCurrency;
  const { error, busy, run } = useSave(onSaved);
  return (
    <Modal wide title={t('requestCancellation')} onClose={onClose} testId="cancel-request-dialog"
      footer={<><button className="primary" disabled={busy || !reason || !ids.length} onClick={() => run(() => call('cancellations.request', {
        bookingId: b.id, cancelType: type, ticketIds: ids, reason, expectedSupplierRefundMinor: expected, expectedCurrency: expected !== null ? cur : null,
      }))} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid">
        <label>{t('cancelType')}<select value={type} onChange={(e) => setType(e.target.value as never)} data-testid="cx-type">{(['REFUND', 'VOID', 'NON_REFUNDABLE'] as const).map((x) => <option key={x} value={x}>{t(`ct_${x}` as TKey)}</option>)}</select></label>
        <label className="span-all">{t('reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="cx-reason" /></label>
        {type !== 'NON_REFUNDABLE' && <MoneyInput label={t('expectedSupplierRefund')} value={expected} currency={cur} onChange={setExpected} />}
      </div>
      <fieldset className="roles-picker"><legend>{t('tickets')}</legend>
        {liveTickets.map((x) => <label key={x.id} className="check"><input type="checkbox" checked={ids.includes(x.id)} onChange={() => setIds(ids.includes(x.id) ? ids.filter((i) => i !== x.id) : [...ids, x.id])} />{x.passengerName} <span className="ltr muted">{x.ticketNumber ?? ''}</span></label>)}
      </fieldset>
    </Modal>
  );
}

function CxAmountsDialog({ b, c, side, onClose, onSaved }: { b: BookingDto; c: CancellationDto; side: 'supplier' | 'customer'; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const m = useMoney();
  const tickets = b.tickets.filter((x) => c.tickets.some((ct) => ct.ticketId === x.id));
  const [amounts, setAmounts] = useState<Record<string, number | null>>(Object.fromEntries(tickets.map((x) => [x.id, side === 'customer' ? x.saleMinor : x.costMinor])));
  const [penalties, setPenalties] = useState<Record<string, number | null>>({});
  const [fee, setFee] = useState<number | null>(null);
  const { error, busy, run } = useSave(onSaved);
  const save = () => run(() => side === 'supplier'
    ? call('cancellations.confirmSupplier', { id: c.id, rowVersion: c.rowVersion, lines: tickets.map((x) => ({ ticketId: x.id, returnMinor: amounts[x.id] ?? 0, penaltyMinor: penalties[x.id] ?? 0 })) })
    : call('cancellations.creditCustomer', { id: c.id, rowVersion: c.rowVersion, cancellationFeeMinor: fee ?? 0, lines: tickets.map((x) => ({ ticketId: x.id, returnMinor: amounts[x.id] ?? 0 })) }));
  return (
    <Modal wide title={t(side === 'supplier' ? 'confirmSupplier' : 'creditCustomer')} onClose={onClose} testId="cx-amounts-dialog"
      footer={<><button className="primary" disabled={busy} onClick={save} data-testid="save">{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <table>
        <thead><tr><th>{t('ticket')}</th><th className="num">{side === 'customer' ? t('customerPrice') : t('purchaseCost')}</th><th>{side === 'customer' ? t('returnedSale') : t('returnedCost')}</th>{side === 'supplier' && <th>{t('supplierPenalty')}</th>}</tr></thead>
        <tbody>{tickets.map((x) => {
          const cur = side === 'customer' ? x.saleCurrency : x.costCurrency ?? b.saleCurrency;
          return (
            <tr key={x.id}>
              <td className="ltr">{x.passengerName} {x.ticketNumber ?? ''}</td>
              <td className="num ltr">{m.fmt(side === 'customer' ? x.saleMinor : x.costMinor, cur)}</td>
              <td><MoneyInput label="" value={amounts[x.id] ?? null} currency={cur} onChange={(v) => setAmounts({ ...amounts, [x.id]: v })} testId="cx-return" /></td>
              {side === 'supplier' && <td><MoneyInput label="" value={penalties[x.id] ?? null} currency={cur} onChange={(v) => setPenalties({ ...penalties, [x.id]: v })} testId="cx-penalty" /></td>}
            </tr>
          );
        })}</tbody>
      </table>
      {side === 'customer' && <div className="grid"><MoneyInput label={t('cancellationFee')} value={fee} currency={b.saleCurrency} onChange={setFee} testId="cx-fee" /></div>}
    </Modal>
  );
}

function NotifyDialog({ b, change, onClose, onSaved }: { b: BookingDto; change: ScheduleChangeDto; onClose: () => void; onSaved: () => void }) {
  const { t, locale } = useI18n();
  const draft = useLoader(() => call<{ body: string; recipient: string; whatsapp: string | null }>('notifications.draft', { changeId: change.id, locale }), [change.id, locale]);
  const [channel, setChannel] = useState<'WHATSAPP' | 'SMS' | 'EMAIL' | 'PHONE_CALL'>('WHATSAPP');
  const [body, setBody] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const { error, busy, run } = useSave(onSaved);
  const text = body ?? draft.data?.body ?? '';
  const to = recipient ?? draft.data?.recipient ?? b.contactMobile;
  const record = (outcome: 'SENT' | 'FAILED') => run(() => call('notifications.record', { bookingId: b.id, scheduleChangeId: change.id, channel, recipient: to, body: text, outcome, note: note || null }));
  const wa = `https://wa.me/${to.replace(/[^\d]/g, '')}?text=${encodeURIComponent(text)}`;
  return (
    <Modal wide title={`${t('notifyCustomer')} — ${change.segmentLabel}`} onClose={onClose} testId="notify-dialog"
      footer={<>
        <button className="primary" disabled={busy || !text} onClick={() => record('SENT')} data-testid="notify-sent">{t('outcomeSent')}</button>
        <button disabled={busy || !text} onClick={() => record('FAILED')} data-testid="notify-failed">{t('outcomeFailed')}</button>
        <button onClick={onClose}>{t('cancel')}</button>
      </>}>
      <Alert kind="info">{t('providerNotConfigured')}</Alert>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid">
        <label>{t('channel')}<select value={channel} onChange={(e) => setChannel(e.target.value as never)} data-testid="notify-channel">{(['WHATSAPP', 'SMS', 'EMAIL', 'PHONE_CALL'] as const).map((x) => <option key={x} value={x}>{t(x)}</option>)}</select></label>
        <label>{t('contactMobile')}<input className="ltr" value={to} onChange={(e) => setRecipient(e.target.value)} /></label>
        <label className="span-all">{t('message')}<textarea rows={7} value={text} onChange={(e) => setBody(e.target.value)} data-testid="notify-body" /></label>
        <label className="span-all">{t('note')}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {channel === 'WHATSAPP' && <p><a href={wa} target="_blank" rel="noreferrer">{t('openWhatsApp')}</a></p>}
    </Modal>
  );
}

function AdjustDialog({ b, mode, onClose, onSaved }: { b: BookingDto; mode: 'sale' | 'cost' | 'supplier'; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const suppliers = useSuppliers();
  const live = b.tickets.filter((x) => x.status === 'ISSUED' || x.status === 'PARTIALLY_REFUNDED');
  const [ticketId, setTicketId] = useState(live[0]?.id ?? '');
  const [kind, setKind] = useState<'INCREASE' | 'DECREASE'>('INCREASE');
  const [lineType, setLineType] = useState('FARE');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [newSupplier, setNewSupplier] = useState<string | null>(null);
  const tk = live.find((x) => x.id === ticketId);
  const [costCurrency, setCostCurrency] = useState(tk?.costCurrency ?? b.saleCurrency);
  const cur = mode === 'sale' ? b.saleCurrency : mode === 'cost' ? tk?.costCurrency ?? b.saleCurrency : costCurrency;
  const { error, busy, run } = useSave(onSaved);
  const save = () => run(() => mode === 'sale'
    ? call('bookings.adjustSale', { bookingId: b.id, ticketId: ticketId || null, kind, lineType: kind === 'INCREASE' ? lineType : null, amountMinor: amount, reason })
    : mode === 'cost'
      ? call('bookings.adjustCost', { bookingId: b.id, ticketId, kind, lineType: kind === 'INCREASE' ? (lineType === 'SUPPLIER_PENALTY' ? 'SUPPLIER_PENALTY' : 'PURCHASE_COST') : null, amountMinor: amount, reason })
      : call('bookings.changeSupplier', { bookingId: b.id, ticketId, newSupplierId: newSupplier, costMinor: amount ?? 0, costCurrency, reason }));
  return (
    <Modal wide title={t(mode === 'sale' ? 'adjustSale' : mode === 'cost' ? 'adjustCost' : 'changeSupplier')} onClose={onClose} testId="adjust-dialog"
      footer={<><button className="primary" disabled={busy || !reason || (mode !== 'supplier' && !amount)} onClick={save}>{t('save')}</button><button onClick={onClose}>{t('cancel')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid">
        <label>{t('ticket')}<select value={ticketId} onChange={(e) => setTicketId(e.target.value)}>{live.map((x) => <option key={x.id} value={x.id}>{x.passengerName} {x.ticketNumber ?? ''}</option>)}</select></label>
        {mode !== 'supplier' && <label>{t('type')}<select value={kind} onChange={(e) => setKind(e.target.value as never)}><option value="INCREASE">{t('increase')}</option><option value="DECREASE">{t('decrease')}</option></select></label>}
        {mode === 'sale' && kind === 'INCREASE' && <label>{t('lineItem')}<select value={lineType} onChange={(e) => setLineType(e.target.value)}>{['FARE', 'TAXES', 'SERVICE_FEE', 'CHANGE_FEE'].map((x) => <option key={x} value={x}>{t(`lt_${x}` as TKey)}</option>)}</select></label>}
        {mode === 'cost' && kind === 'INCREASE' && <label>{t('lineItem')}<select value={lineType} onChange={(e) => setLineType(e.target.value)}><option value="PURCHASE_COST">{t('lt_PURCHASE_COST')}</option><option value="SUPPLIER_PENALTY">{t('lt_SUPPLIER_PENALTY')}</option></select></label>}
        {mode === 'supplier' && <SupplierSelect label={t('newSupplier')} value={newSupplier} onChange={setNewSupplier} suppliers={suppliers.filter((s) => s.id !== tk?.supplierId)} />}
        {mode === 'supplier' && <CurrencySelect label={t('costCurrency')} value={costCurrency} onChange={setCostCurrency} />}
        <MoneyInput label={mode === 'supplier' ? t('newCost') : t('amount')} value={amount} currency={cur} onChange={setAmount} />
        <label className="span-all">{t('reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      </div>
    </Modal>
  );
}
