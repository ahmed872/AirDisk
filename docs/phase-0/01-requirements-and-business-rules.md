# 01 — Requirements Analysis, Functional Requirements & Business Rules

Covers deliverable items **A** (requirements analysis), **B** (unclear / conflicting rules),
report sections **2. Functional Requirements** and **3. Business Rules**.

---

## 1. Requirements analysis (A)

### 1.1 What the product really is

AirDesk is an **agency back-office system** with three tightly coupled cores:

| Core | Question it answers | Primary users |
|---|---|---|
| **Operations** (bookings, passengers, segments, tickets, schedule changes) | *What did we sell, to whom, for which flight, and has anything changed?* | Sales agents |
| **Sub-ledgers** (customers, suppliers, money accounts) | *Who owes whom, how much, since when?* | Sales agents, accountants |
| **Profitability** (sales, costs, expenses, FX) | *Did we make money, where, and from which supplier?* | Managers, owners |

The hardest and most valuable part is **not** the booking UI; it is guaranteeing that the
three cores always agree. The architecture is therefore built around a single, immutable,
double-entry **journal** from which every balance and every report is derived (see
[04-financial-model.md](04-financial-model.md)).

### 1.2 Actors

| Actor | Description |
|---|---|
| Sales Agent | Creates customers & bookings, issues tickets, takes customer payments, handles schedule-change calls. Speed-critical. |
| Accountant | Supplier payments, expenses, reconciliations, statements, financial reports, period locks. |
| Manager | Dashboards, reports, approvals (price adjustments, refunds), operational oversight. |
| Admin | Users, roles, company settings, backups/restore. Usually the owner. |
| Customer (external) | Payer; receives receipts, statements and schedule-change messages. Not a system user. |
| Passenger (external) | Traveller; may or may not be the customer. |
| Supplier (external) | Consolidator / sub-agent / airline from whom tickets are bought. |
| System | Scheduled jobs: automatic backups, ticketing-deadline alerts, integrity checks. |

### 1.3 Key analysis findings

1. **Customer ≠ Passenger.** A company or a father pays (customer) for several travellers
   (passengers). Receivables belong to the customer; tickets belong to passengers. The
   requirement lists "Passenger Name(s)" on the booking and "Customer" separately — the
   model keeps them as distinct entities.
2. **Supplier ≠ Airline** (explicit in the brief). A supplier *may* be an airline; this is a
   nullable link `supplier.airline_id`, never an assumption.
3. **Sale ≠ Cash, Purchase ≠ Payment.** Every financial concept in §7 of the brief maps to
   a distinct document type and a distinct ledger account; the separation is structural,
   not a reporting convention.
4. **Nothing financial is ever edited.** Price changes, supplier changes, cancellations,
   discounts and bounced payments are all *new* documents (adjustments or reversals). This
   single rule satisfies §10, §18, §19 and §28 of the brief simultaneously.
5. **Money needs a home.** "Cash collected" is meaningless without knowing *where* the cash
   went (drawer, bank, wallet). A minimal **money-account (treasury)** concept is required
   even though the brief does not name it. Transfers between accounts and owner
   withdrawals must not look like expenses.
6. **Go-live needs opening balances.** A real office already has customers who owe money
   and suppliers who are owed. Without opening-balance documents the product cannot be
   adopted mid-year. Added to scope.
7. **Refunds are slow and asynchronous.** Airlines/suppliers confirm refund amounts days
   or weeks after cancellation, and offices sometimes refund customers first. Cancellation
   is therefore a *workflow* with separate supplier-side and customer-side states, not a
   single button.
8. **Flight times are airport-local.** "28 Sep 18:00" means 18:00 in the departure
   airport's timezone. Storing it as UTC would corrupt it. Stored as local date + local
   time + airport; UTC derived only for sorting and alerts.
9. **Multi-workstation is the biggest open architectural question.** Most offices have
   2–6 PCs. A per-PC local database would fragment the books; SQLite on a shared network
   folder corrupts data. See Unresolved Question Q1.

---

## 2. Functional requirements

IDs are stable and are referenced by tests (`FR-xxx`). *Phase* = roadmap phase that
delivers it (see [12-roadmap-risks-questions.md](12-roadmap-risks-questions.md)).

### 2.1 Customers (Phase 2)
| ID | Requirement |
|---|---|
| FR-CUS-01 | Create/edit customer: name (Arabic + optional Latin), type (individual/corporate), primary mobile (mandatory), secondary mobile, WhatsApp, email, national ID/passport data, notes, payment terms, optional credit limit. |
| FR-CUS-02 | Mobile numbers are normalised to E.164 using the company's default country; the raw input is also kept. Arabic-Indic digits (٠-٩) are accepted. |
| FR-CUS-03 | Duplicate warning (not block) when the mobile or name matches an existing customer. |
| FR-CUS-04 | Customers are deactivated, never deleted. |
| FR-CUS-05 | Customer profile shows: bookings, documents, balance per currency, open items with aging, statement with running balance, notifications history. |
| FR-CUS-06 | Saved traveller profiles per customer for fast re-booking. |
| FR-CUS-07 | Identity data (passport/national ID) visible only with `customer.view_identity`. |

### 2.2 Suppliers & airlines (Phase 2)
| ID | Requirement |
|---|---|
| FR-SUP-01 | Supplier CRUD: name, contact person, phone, email, address, default currency, payment terms, notes, optional "this supplier is airline X" link. |
| FR-SUP-02 | Supplier profile: total purchases, total payments, outstanding payable (per currency), statement, performance KPIs. |
| FR-SUP-03 | Suppliers are deactivated, never deleted. |
| FR-AIR-01 | Airline CRUD: name (ar/en), IATA/ICAO code, ticket prefix, contacts, notes. Seeded list shipped with the product. |
| FR-AIR-02 | Airport reference list (IATA, city, country, IANA timezone) shipped with the product; editable. |

### 2.3 Bookings & tickets (Phase 3)
| ID | Requirement |
|---|---|
| FR-BKG-01 | Booking holds: booking no., customer, PNR(s), passengers (1..n), flight segments (1..n), tickets (0..n per passenger), default supplier, sale currency, sales agent, booking/issue/due dates, contact snapshot, notes. |
| FR-BKG-02 | Statuses per the booking state machine ([05-state-machines.md](05-state-machines.md)). |
| FR-BKG-03 | **Issue** posts the customer invoice and supplier bill(s) atomically. Prices are entered per passenger/ticket (fare, optional taxes, optional service fee); totals are computed, not typed twice. |
| FR-BKG-04 | Fast path: one screen from "new booking" to "issued + first payment", fully keyboard operable. |
| FR-BKG-05 | After issue, financial values are read-only; changes happen via *Adjust price*, *Change supplier*, *Reissue/exchange*, *Cancel/refund* commands, each producing documents. |
| FR-BKG-06 | Booking financial panel (permission-filtered): sale, cost, gross profit, customer paid, customer remaining, supplier paid, supplier remaining (per supplier). All derived from the journal. |
| FR-BKG-07 | Ticket numbers unique system-wide; may be entered after issue ("missing ticket no." is flagged). |
| FR-BKG-08 | Reservation holds with ticketing deadline + alert. |
| FR-BKG-09 | Selling below cost requires `booking.sell_below_cost` and a reason. |

### 2.4 Payments & balances (Phase 4)
| ID | Requirement |
|---|---|
| FR-PAY-01 | Customer receipt: date, amount, currency, money account, method, reference, received-by (current user), notes, allocation to one or more bookings and/or "on account". Printable receipt with company branding. |
| FR-PAY-02 | Unlimited instalments; each is an independent immutable document. |
| FR-PAY-03 | Overpayment beyond a booking's remaining balance requires explicit choice: keep as customer credit (on account) — needs `payment.accept_overpayment`. |
| FR-PAY-04 | Supplier payment: same structure, allocated to supplier bookings or on account (pre-funding / top-up). |
| FR-PAY-05 | Reversal of a receipt/payment (bounced cheque, data-entry error) by a mirror document with mandatory reason. Original remains visible. |
| FR-PAY-06 | *Apply balance*: move an on-account credit to a booking (or between bookings of the same party). |
| FR-PAY-07 | Customer and supplier statements with opening balance, running balance, closing balance, date range, per currency; print/export. |

### 2.5 Cancellations, voids, refunds, reissues (Phase 5)
| ID | Requirement |
|---|---|
| FR-REF-01 | Cancellation request (full/partial by passenger, segment or ticket), type VOID / REFUND / NON_REFUNDABLE. |
| FR-REF-02 | Supplier side: submit → confirm actual refund amount and supplier penalty (posts supplier credit note + penalty bill) or reject. |
| FR-REF-03 | Customer side: post customer credit note and office cancellation fee; then cash refund(s) as separate documents. |
| FR-REF-04 | Crediting the customer before the supplier confirms requires `refund.customer_before_supplier`. |
| FR-REF-05 | Net financial impact panel per cancellation (fee revenue − supplier penalty − lost margin). |
| FR-REF-06 | Reissue/exchange: new ticket linked to the old one; additional fare difference and change fees posted as new invoice/bill lines. |

### 2.6 Schedule changes & notifications (Phase 7)
| ID | Requirement |
|---|---|
| FR-SCH-01 | Editing any schedule field of an issued booking's segment creates a schedule-change event with before/after snapshot, changed fields, user, timestamp, severity. |
| FR-SCH-02 | Booking and segment show ⚠️ *Flight schedule changed* until the change is resolved. |
| FR-SCH-03 | Notification status per change: Not Notified / Customer Notified / Notification Failed / Manually Confirmed, with who/when/note. |
| FR-SCH-04 | "Notify" composes a message from a template (ar/en) and sends through a channel adapter. Phase 7 ships **manual channels**: WhatsApp click-to-chat, copy-to-clipboard, phone-call log. Provider adapters (WhatsApp Business API, SMS, SMTP) plug into the same interface later. |
| FR-SCH-05 | Every notification attempt is recorded: channel, recipient, body snapshot, status, error, sent at/by. |
| FR-SCH-06 | Dashboard list of changes requiring attention; flight-changes report. |

### 2.7 Expenses & treasury (Phase 6)
| ID | Requirement |
|---|---|
| FR-EXP-01 | Expense: date, category, amount, currency, description, money account, method, reference, created by. Reversal instead of delete. |
| FR-EXP-02 | Expense categories are configurable; each maps to an expense ledger account. |
| FR-TRS-01 | Money accounts (cash, bank, wallet, card clearing), each single-currency. |
| FR-TRS-02 | Transfers between money accounts; owner capital/withdrawals; none of these are expenses. |
| FR-TRS-03 | Opening balances for customers, suppliers and money accounts at go-live. |
| FR-TRS-04 | Financial lock date: no document dated on/before it; moving it back requires `finance.lock_period` and is audited. |

### 2.8 Dashboard & reports (Phase 8)
| ID | Requirement |
|---|---|
| FR-DSH-01 | KPI tiles from brief §14 with period selector (Today, Yesterday, This Week, This Month, Last Month, Custom). Point-in-time KPIs (receivables, payables) show "as of end of period". |
| FR-DSH-02 | Tiles are permission-filtered (a sales agent never receives profit numbers from the backend). |
| FR-RPT-01 | Report framework: declarative report definitions with parameters, columns, permissions; generic viewer with date filter, search, sort, totals, export (XLSX, CSV, PDF) and print. |
| FR-RPT-02 | Reports from brief §15 (Sales, Purchases, Profit, Receivables, Payables, Supplier Performance, Customer/Supplier Statement, Expenses, Refunds/Cancellations, Flight Changes, Employee Activity). |
| FR-RPT-03 | Aging with configurable buckets (default Current, 1–7, 8–30, 31–60, 60+). |

### 2.9 Platform (Phases 1, 9, 10)
| ID | Requirement |
|---|---|
| FR-SEC-01 | Local user accounts, Argon2id hashing, lockout, idle screen lock, RBAC with custom roles. |
| FR-AUD-01 | Append-only, hash-chained audit log for every sensitive action (list in [06-security-and-permissions.md](06-security-and-permissions.md)). |
| FR-CUR-01 | Multi-currency: transaction currency, frozen exchange rate, frozen base amount on every document. |
| FR-BAK-01 | Manual + automatic backups, validation, history, safe restore ([10-backup-restore.md](10-backup-restore.md)). |
| FR-SET-01 | Company settings (white label): names, logo, contacts, tax/registration numbers, base currency, country, timezone, document footers, numbering prefixes. Nothing company-specific hard-coded. |
| FR-SRC-01 | Global search (Ctrl+K) across customers, mobiles, PNRs, ticket numbers, booking numbers, suppliers, airlines, passenger names; < 150 ms at 100k bookings. |
| FR-I18N-01 | Arabic (RTL) default and English; per-user language; all strings externalised. |
| FR-DSK-01 | Windows 10/11 x64 installer; offline-first; uninstall preserves data unless explicitly chosen. |

---

## 3. Business rules

Rules are normative. Each has an ID referenced by tests (`BR-xxx`).

### 3.1 Financial separation
| ID | Rule |
|---|---|
| BR-FIN-01 | **Gross Profit = Net Sales − Net Purchase Cost**, computed from revenue/cost ledger accounts only. Cash movements never enter the calculation. |
| BR-FIN-02 | **Net Profit = Gross Profit − Operating Expenses ± Other items** (realised FX, rounding). |
| BR-FIN-03 | A supplier payment settles a payable; it is **never** an expense and never reduces profit. |
| BR-FIN-04 | A customer receipt settles a receivable; it is **never** revenue. Profit is never computed from cash collected. |
| BR-FIN-05 | Revenue and cost are recognised on the booking's **issue date** (ticket issuance), not on reservation or payment date. *(Default; see Q2.)* |
| BR-FIN-06 | Reports for a period show documents **dated in that period**. A cancellation in October of a September sale reduces October's figures; September is not restated. A separate *booking-lifetime* view shows each booking's cumulative profit. |
| BR-FIN-07 | Customer receivable = Σ invoices − Σ credit notes − Σ receipts + Σ refunds (per customer, per currency, optionally per booking). Supplier payable is symmetric. |
| BR-FIN-08 | Balances may legitimately be negative: a negative customer balance is a customer credit (we owe them); a negative supplier balance is a supplier credit (they owe us). |

### 3.2 Immutability & audit
| ID | Rule |
|---|---|
| BR-IMM-01 | Posted financial documents, their lines and journal entries cannot be updated or deleted (application rule **and** database triggers). |
| BR-IMM-02 | Corrections are made by (a) a full **reversal** document mirroring the original, or (b) an **adjustment** document (credit note / debit note / supplementary bill) for the difference. Every reversal/adjustment requires a reason. |
| BR-IMM-03 | A document can be reversed at most once; a reversal cannot itself be reversed (post a new correct document instead). |
| BR-IMM-04 | All amounts stored are strictly positive; direction comes from the document type. A "negative payment" is impossible by construction; money going back to a customer is a `CUSTOMER_REFUND`. |
| BR-IMM-05 | Master data (customers, suppliers, bookings' non-financial fields) may be edited; every edit writes before/after to the audit log. |
| BR-IMM-06 | Nothing may be dated on or before the financial lock date. |

### 3.3 Payments
| ID | Rule |
|---|---|
| BR-PAY-01 | Each receipt/payment is allocated to bookings and/or "on account" in the same transaction; allocations sum exactly to the document total. |
| BR-PAY-02 | Allocation to a booking may not exceed that booking's remaining balance for that party; any excess must be explicitly routed on-account (overpayment), which requires `payment.accept_overpayment`. |
| BR-PAY-03 | Receipts may be taken on RESERVED bookings (deposits); they sit as a credit on the booking until issue. |
| BR-PAY-04 | A booking cannot be DISCARDED while it still carries a non-zero party balance; the deposit must first be refunded or moved on-account. |
| BR-PAY-05 | A money account is single-currency. A receipt's money account currency must equal the receipt currency. |
| BR-PAY-06 | Received-by/paid-by is always the authenticated user; it cannot be typed. |

### 3.4 Bookings
| ID | Rule |
|---|---|
| BR-BKG-01 | A booking may not be issued without: customer, ≥1 active passenger, ≥1 segment, a supplier for every priced ticket, sale amount > 0 (unless `booking.zero_price`), cost ≥ 0. |
| BR-BKG-02 | Issuing posts one `CUSTOMER_INVOICE` and one `SUPPLIER_BILL` per supplier, atomically with the status change. |
| BR-BKG-03 | Changing the supplier after issue = supplier credit note to the old supplier + new bill to the new supplier. Payments already made to the old supplier stay with the old supplier (their balance becomes a credit to be refunded or used). The user is warned. |
| BR-BKG-04 | Price change after issue = customer debit (extra invoice) or credit note for the difference, with reason; never an edit. |
| BR-BKG-05 | The notification contact (name + mobile) is snapshotted on the booking at creation and editable with audit; it defaults from the customer. |

### 3.5 Cancellations & refunds
| ID | Rule |
|---|---|
| BR-REF-01 | Cancellation never edits the original invoice/bill. It posts: customer credit note (returned sale), optional office cancellation fee invoice, supplier credit note (returned cost), optional supplier penalty bill. |
| BR-REF-02 | Cash refunds are separate documents (`CUSTOMER_REFUND`, `SUPPLIER_REFUND`) and are limited by the party's credit balance unless explicitly overridden with permission. |
| BR-REF-03 | Expected supplier refunds are memo values only; nothing is posted until the supplier confirms. |
| BR-REF-04 | VOID = cancellation within the supplier's void window, normally with zero penalty; reported separately from refunds. |

### 3.6 Currency
| ID | Rule |
|---|---|
| BR-CUR-01 | The base currency is chosen at setup and frozen once the first document is posted. |
| BR-CUR-02 | Every document stores transaction currency, exchange rate, and base amount at posting time. Later rate-table edits never change posted documents. |
| BR-CUR-03 | Rounding to minor units happens once, at posting, half-up. Report totals are sums of stored base amounts, never re-conversions. |
| BR-CUR-04 | Party balances are tracked per currency. Settling a foreign-currency balance at a different rate produces a realised FX gain/loss line (account 7100), which affects Net Profit but not Gross Profit. *(Default; see Q3.)* |

### 3.7 Schedule changes
| ID | Rule |
|---|---|
| BR-SCH-01 | Schedule edits on DRAFT/RESERVED bookings are ordinary edits (audited); on ISSUED or later they always create a schedule-change event. |
| BR-SCH-02 | Severity MAJOR if: date change, flight-number change, airport change, segment cancelled, or time shift ≥ configurable threshold (default 60 min); else MINOR. |
| BR-SCH-03 | A change "requires attention" while its status is NOT_NOTIFIED or NOTIFICATION_FAILED. Optional setting: MAJOR changes also require MANUALLY_CONFIRMED. |
| BR-SCH-04 | A newer change on the same segment supersedes the older one for attention purposes; history is kept. |

---

## 4. Unclear or conflicting rules and proposed resolutions (B)

Items marked **⚠ needs owner decision** are repeated in the Unresolved Questions list;
everything else has been resolved by engineering judgement and is binding unless you
say otherwise.

| # | Topic | Issue in the brief | Resolution |
|---|---|---|---|
| B1 | Sales agent vs. sensitive financials | Agents create bookings (which requires entering purchase cost) but "should not necessarily see sensitive financial data". | Split permissions: `booking.enter_cost` (type cost while drafting/issuing) vs. `booking.view_cost` and `booking.view_profit` (see cost/profit after issue, in lists, reports, dashboard). Default Sales Agent: enter ✔, view ✘. **⚠ needs owner decision (Q5)** |
| B2 | "Amount paid / remaining" on a booking vs. customer-level payments | Payments are listed as booking attributes but also as customer transactions. | Payments belong to the customer and are **allocated** to bookings. Booking paid/remaining are derived from allocations. |
| B3 | "Payment greater than allowed amount" | What is "allowed" is undefined. | Allowed = booking remaining balance. Excess requires explicit on-account routing + permission (BR-PAY-02). |
| B4 | When does a sale happen? | Booking date vs. ticket issue vs. travel date. | Issue date (BR-FIN-05). **⚠ confirm (Q2)** |
| B5 | Gross vs. net (agent) revenue presentation | The brief wants Sales, Purchases, Gross Profit — i.e. gross presentation. Tax rules in some markets treat agents on a net/commission basis. | Store both sides (gross); net margin is derivable. Tax treatment deferred to Q4. |
| B6 | Cancellation in a later period | Should the original month's profit change? | No (BR-FIN-06); booking-lifetime view provided in addition. |
| B7 | Refunds before supplier confirmation | Not specified; common in practice and risky. | Allowed only with `refund.customer_before_supplier`. **⚠ confirm (Q6)** |
| B8 | Expenses: paid vs. owed | Expense fields include "payment method", implying paid expenses. Unpaid bills (rent due) would need an expense-payable account. | v1: expenses are recorded when paid (always has a money account). Accrued/unpaid expenses deferred. Documented limitation. |
| B9 | Money that is not an expense | Owner withdrawals, bank-to-cash transfers, loans. | Treasury transfers & owner capital/drawings documents (account 3200). Never counted as expenses. |
| B10 | Multi-currency method | Brief asks not to assume. | Per-document rate snapshot + per-currency party balances + realised FX on settlement; no unrealised revaluation in v1. **⚠ confirm (Q3)** |
| B11 | Notification recipient | Customer or passenger? | Default: booking contact (snapshot from customer). Agent can pick the passenger's mobile instead; the actual recipient is recorded. |
| B12 | Walk-in customers | Must every sale have a customer record? | Yes (receivables need an owner), but quick-create needs only name + mobile. |
| B13 | Customer credit limit | Not in brief, but implied by "outstanding balance". | Optional per customer; exceeding it warns, blocking only with a setting. |
| B14 | Discounts | Not mentioned. | Discount at issue = simply a lower sale price. Discount after issue = credit note line DISCOUNT (account 4120). |
| B15 | Supplier = airline financially | "Don't link airline to supplier finance unless it is the supplier." | Supplier record optionally references an airline; balances live only on the supplier. |
| B16 | Deleting records | "No silent deletion." | Financial: never. Master data with history: deactivate. DRAFT bookings with no documents: may be discarded (status) and purged. |
| B17 | Multiple PCs | "Local database" + "office". | **⚠ needs owner decision (Q1)**; architecture keeps a LAN server mode possible. |
| B18 | Tax / e-invoicing | "Tax information" appears only as a white-label field. | Tax fields stored; tax computation & e-invoicing out of scope until Q4 answered. |
| B19 | Other travel products | Hotels, visas, insurance, Umrah packages are common agency revenue. | Out of scope for v1; the document/line model is product-agnostic so a `service_item` can be added without touching the ledger. **⚠ confirm (Q10)** |
