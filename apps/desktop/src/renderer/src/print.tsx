import { useEffect, useState, type ReactNode } from 'react';
import type { BookingDto, CompanyProfileDto, DocumentDto, StatementDto } from '@airdesk/contracts';
import { call } from './api';
import { Modal } from './components';
import { isTKey, useI18n, type TKey } from './i18n';
import { useMoney } from './money';
import { useFmt } from './prefs';

/**
 * Printable documents. Company identity (names, logo, tax number, address,
 * invoice title/terms, footer) always comes from Company Settings — nothing
 * about the operating company is hard-coded. Print uses the OS dialog; "Save
 * PDF" asks the main process (user picks the location; audited).
 */
function useCompany(): CompanyProfileDto | null {
  const [c, setC] = useState<CompanyProfileDto | null>(null);
  useEffect(() => { call<CompanyProfileDto>('company.get').then(setC, () => setC(null)); }, []);
  return c;
}

export function PrintFrame({ title, fileName, onClose, children }: { title: string; fileName: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Modal wide title={title} onClose={onClose} testId="print-dialog"
      footer={<>
        <button className="primary" onClick={() => window.print()} data-testid="print">{t('print')}</button>
        <button onClick={async () => { const r = await window.airdesk.exportPdf(fileName); setMsg(r.ok ? t('saveToFileDone') : null); }} data-testid="save-pdf">{t('savePdf')}</button>
        <button onClick={onClose}>{t('close')}</button>
        {msg && <span className="muted">{msg}</span>}
      </>}>
      <div className="print-area">{children}</div>
    </Modal>
  );
}

function Letterhead({ company, docTitle }: { company: CompanyProfileDto | null; docTitle: string }) {
  const { locale } = useI18n();
  if (!company) return null;
  const name = locale === 'ar' ? company.tradeNameAr ?? company.legalNameAr : company.tradeNameEn ?? company.legalNameEn ?? company.legalNameAr;
  return (
    <header className="letterhead">
      <div>
        {company.logoBase64 && <img src={`data:${company.logoMime};base64,${company.logoBase64}`} alt="" className="letter-logo" />}
        <h2>{name}</h2>
        <div className="small">{locale === 'ar' ? company.addressAr : company.addressEn ?? company.addressAr}</div>
        <div className="small ltr">{[company.phonePrimary, company.email, company.website].filter(Boolean).join(' · ')}</div>
        {company.taxRegistrationNo && <div className="small">{locale === 'ar' ? 'الرقم الضريبي' : 'Tax no.'}: <span className="ltr">{company.taxRegistrationNo}</span></div>}
      </div>
      <h1 className="doc-title">{docTitle}</h1>
    </header>
  );
}

function Footer({ company }: { company: CompanyProfileDto | null }) {
  const { locale } = useI18n();
  const { dateTime } = useFmt();
  if (!company) return null;
  const terms = locale === 'ar' ? company.invoiceTermsAr : company.invoiceTermsEn ?? company.invoiceTermsAr;
  const footer = locale === 'ar' ? company.documentFooterAr : company.documentFooterEn ?? company.documentFooterAr;
  return (
    <footer className="doc-footer">
      {terms && <p className="small">{terms}</p>}
      {footer && <p className="small">{footer}</p>}
      <p className="small muted">{locale === 'ar' ? 'طُبع في' : 'Printed'} <span className="ltr">{dateTime(new Date().toISOString())}</span></p>
    </footer>
  );
}

const docTitleKey = (docType: string): TKey => (isTKey(`docType_${docType}`) ? (`docType_${docType}` as TKey) : 'documents');

/** Invoice / receipt / refund receipt / credit note / expense voucher for one document. */
export function DocumentPrint({ doc, onClose }: { doc: DocumentDto; onClose: () => void }) {
  const { t, locale } = useI18n();
  const m = useMoney();
  const { date } = useFmt();
  const company = useCompany();
  const isInvoice = doc.docType === 'CUSTOMER_INVOICE';
  const title = isInvoice && company ? (locale === 'ar' ? company.invoiceTitleAr : company.invoiceTitleEn) ?? t('invoice') : t(docTitleKey(doc.docType));
  const party = doc.customerName ?? doc.supplierName;
  return (
    <PrintFrame title={title} fileName={`${doc.docNo}`} onClose={onClose}>
      <Letterhead company={company} docTitle={title} />
      <table className="meta">
        <tbody>
          <tr><th>{t('number')}</th><td className="ltr">{doc.docNo}</td><th>{t('date')}</th><td className="ltr">{date(doc.docDate)}</td></tr>
          {party && <tr><th>{doc.customerName ? t('billTo') : t('supplier')}</th><td colSpan={3}>{party}</td></tr>}
          {doc.bookingNo && <tr><th>{t('recordNo')}</th><td className="ltr">{doc.bookingNo}</td><th>{t('currency')}</th><td className="ltr">{doc.currency}</td></tr>}
          {doc.paymentMethod && <tr><th>{t('method')}</th><td>{isTKey(doc.paymentMethod) ? t(doc.paymentMethod as TKey) : doc.paymentMethod}</td><th>{t('moneyAccount')}</th><td>{doc.moneyAccountName}</td></tr>}
          {doc.paymentReference && <tr><th>{t('reference')}</th><td colSpan={3} className="ltr">{doc.paymentReference}</td></tr>}
          {doc.isReversal && <tr><th>{t('reversalOf')}</th><td colSpan={3} className="ltr">{doc.reversalOfNo} — {doc.description}</td></tr>}
        </tbody>
      </table>
      <table className="lines">
        <thead><tr><th>#</th><th>{t('lineItem')}</th><th>{t('passenger')}</th><th>{t('ticketNumber')}</th><th className="num">{t('amount')}</th></tr></thead>
        <tbody>
          {doc.lines.map((l) => (
            <tr key={l.lineNo}>
              <td>{l.lineNo}</td>
              <td>{isTKey(`lt_${l.lineType}`) ? t(`lt_${l.lineType}` as TKey) : l.lineType}{l.description ? ` — ${l.description}` : ''}{l.expenseCategory ? ` — ${l.expenseCategory}` : ''}{l.bookingNo && !doc.bookingNo ? ` (${l.bookingNo})` : ''}</td>
              <td>{l.passengerName ?? ''}</td>
              <td className="ltr">{l.ticketNumber ?? ''}</td>
              <td className="num ltr">{m.fmt(l.amountMinor, doc.currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><th colSpan={4}>{t('total')}</th><th className="num ltr">{m.fmt(doc.totalMinor, doc.currency)}</th></tr></tfoot>
      </table>
      {doc.currency !== m.base && <p className="small">{t('rate')}: <span className="ltr">{doc.exchangeRate}</span> · {m.fmt(doc.totalBaseMinor, m.base)}</p>}
      <p className="small">{doc.createdBy ? `${t('user')}: ${doc.createdBy}` : ''}</p>
      <div className="signature">{t('signature')}: ____________________</div>
      <Footer company={company} />
    </PrintFrame>
  );
}

export function StatementPrint({ statement, onClose }: { statement: StatementDto; onClose: () => void }) {
  const { t } = useI18n();
  const m = useMoney();
  const { date } = useFmt();
  const company = useCompany();
  const title = t(statement.party === 'CUSTOMER' ? 'customerStatement' : 'supplierStatement');
  return (
    <PrintFrame title={title} fileName={`${statement.partyNo}-${statement.from}-${statement.to}`} onClose={onClose}>
      <Letterhead company={company} docTitle={title} />
      <StatementBody statement={statement} />
      <p className="small">{t('total')}: {m.fmt(statement.closingMinor, statement.currency)} · <span className="ltr">{date(statement.from)} – {date(statement.to)}</span></p>
      <Footer company={company} />
    </PrintFrame>
  );
}

export function StatementBody({ statement }: { statement: StatementDto }) {
  const { t } = useI18n();
  const m = useMoney();
  const { date } = useFmt();
  const c = statement.currency;
  return (
    <>
      <table className="meta">
        <tbody>
          <tr><th>{t('party')}</th><td>{statement.partyName} <span className="ltr muted">{statement.partyNo}</span></td><th>{t('currency')}</th><td className="ltr">{c}</td></tr>
          <tr><th>{t('period')}</th><td className="ltr">{date(statement.from)} – {date(statement.to)}</td><th>{t('opening')}</th><td className="ltr num">{m.fmt(statement.openingMinor, c)}</td></tr>
        </tbody>
      </table>
      <table className="lines" data-testid="statement-lines">
        <thead><tr><th>{t('date')}</th><th>{t('document')}</th><th>{t('type')}</th><th>{t('recordNo')}</th><th className="num">{t('debit')}</th><th className="num">{t('credit')}</th><th className="num">{t('runningBalance')}</th></tr></thead>
        <tbody>
          {statement.lines.map((l) => (
            <tr key={l.docId}>
              <td className="ltr">{date(l.date)}</td><td className="ltr">{l.docNo}</td><td>{isTKey(`docType_${l.docType}`) ? t(`docType_${l.docType}` as TKey) : l.docType}</td>
              <td className="ltr">{l.bookingNo ?? ''}</td><td className="num ltr">{l.debitMinor ? m.fmt(l.debitMinor, c) : ''}</td>
              <td className="num ltr">{l.creditMinor ? m.fmt(l.creditMinor, c) : ''}</td><td className="num ltr">{m.fmt(l.balanceMinor, c)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><th colSpan={6}>{t('closing')}</th><th className="num ltr">{m.fmt(statement.closingMinor, c)}</th></tr></tfoot>
      </table>
      <table className="meta">
        <tbody>
          <tr><th>{t('charges')}</th><td className="num ltr">{m.fmt(statement.totals.chargesMinor, c)}</td><th>{t('paymentsTotal')}</th><td className="num ltr">{m.fmt(statement.totals.paymentsMinor, c)}</td></tr>
          <tr><th>{t('refundsTotal')}</th><td className="num ltr">{m.fmt(statement.totals.refundsMinor, c)}</td><th>{t('adjustmentsTotal')}</th><td className="num ltr">{m.fmt(statement.totals.adjustmentsMinor, c)}</td></tr>
        </tbody>
      </table>
    </>
  );
}

/** Ticket record summary for the customer: passengers, flights, tickets, price and payment status (no cost). */
export function RecordPrint({ record, onClose }: { record: BookingDto; onClose: () => void }) {
  const { t } = useI18n();
  const m = useMoney();
  const { date } = useFmt();
  const company = useCompany();
  const pos = record.customer.find((p) => p.currency === record.saleCurrency);
  return (
    <PrintFrame title={t('bookingSummary')} fileName={record.bookingNo} onClose={onClose}>
      <Letterhead company={company} docTitle={t('bookingSummary')} />
      <table className="meta"><tbody>
        <tr><th>{t('recordNo')}</th><td className="ltr">{record.bookingNo}</td><th>PNR</th><td className="ltr">{record.pnr ?? '—'}</td></tr>
        <tr><th>{t('customerLabel')}</th><td>{record.customerName}</td><th>{t('contactMobile')}</th><td className="ltr">{record.contactMobile}</td></tr>
      </tbody></table>
      <h3>{t('passengers')}</h3>
      <table className="lines"><thead><tr><th>#</th><th>{t('name')}</th><th>{t('paxType')}</th><th>{t('ticketNumber')}</th></tr></thead>
        <tbody>{record.passengers.map((p) => (
          <tr key={p.id}><td>{p.seq}</td><td className="ltr">{p.title ?? ''} {p.givenName} {p.surname}</td><td>{t(p.paxType)}</td>
            <td className="ltr">{record.tickets.find((x) => x.passengerId === p.id)?.ticketNumber ?? record.priceItems.find((x) => x.passengerId === p.id)?.ticketNumber ?? ''}</td></tr>
        ))}</tbody></table>
      <h3>{t('flights')}</h3>
      <table className="lines"><thead><tr><th>{t('flightNumber')}</th><th>{t('origin')}</th><th>{t('destination')}</th><th>{t('departure')}</th><th>{t('arrival')}</th><th>{t('cabin')}</th><th>{t('baggage')}</th></tr></thead>
        <tbody>{record.segments.filter((s) => s.status !== 'CANCELLED').map((s) => (
          <tr key={s.id}><td className="ltr">{s.airlineCode}{s.flightNumber}</td><td className="ltr">{s.origin}</td><td className="ltr">{s.destination}</td>
            <td className="ltr">{date(s.departureDate)} {s.departureTime}</td><td className="ltr">{date(s.arrivalDate)} {s.arrivalTime}</td><td>{t(s.cabinClass)}</td><td>{s.baggage ?? ''}</td></tr>
        ))}</tbody></table>
      {pos && (
        <table className="meta"><tbody>
          <tr><th>{t('total')}</th><td className="num ltr">{m.fmt(pos.chargedMinor, pos.currency)}</td><th>{t('paid')}</th><td className="num ltr">{m.fmt(pos.paidMinor, pos.currency)}</td></tr>
          <tr><th>{t('remaining')}</th><td className="num ltr" colSpan={3}>{m.fmt(pos.balanceMinor, pos.currency)}</td></tr>
        </tbody></table>
      )}
      <Footer company={company} />
    </PrintFrame>
  );
}
