# 04 — Financial Transaction Model

Covers deliverable item **E**, report section **6. Financial Model**.
This is the most important document of Phase 0. Every number the product shows must be
explainable from this page.

---

## 1. Principles

1. **Accrual basis.** Revenue and cost are recognised when the ticket is issued
   (BR-FIN-05). Cash is tracked separately and never drives profit.
2. **Documents describe business events; the journal records their effect.** Each
   posted `fin_document` creates exactly one balanced, sealed `journal_entry`.
3. **Double entry, invisible to users.** Users see *Sale, Purchase, Payment, Refund,
   Expense*. Debits/credits exist so that invariants (trial balance = 0, sub-ledger =
   control account, cash = Σ cash documents) can be proven automatically.
4. **Immutable.** Documents and journal lines are never updated or deleted. Corrections
   are reversals or adjustments.
5. **All amounts positive**; the document type decides direction.
6. **Everything carries dimensions** (customer, supplier, booking, ticket, money account,
   expense category) so any report is a `GROUP BY` over the journal.

## 2. Document types

| Doc type | Business meaning | Prefix | Party | Cash? |
|---|---|---|---|---|
| `CUSTOMER_INVOICE` | Sale: customer now owes us (issue, extra charge, cancellation fee, reissue difference) | INV | Customer | — |
| `CUSTOMER_CREDIT_NOTE` | Customer owes us less: cancellation/return, discount after issue, price reduction | CRN | Customer | — |
| `CUSTOMER_RECEIPT` | Money received from customer | RCT | Customer | in |
| `CUSTOMER_REFUND` | Money paid back to customer | RFD | Customer | out |
| `SUPPLIER_BILL` | Purchase: we now owe supplier (ticket cost, supplier penalty, reissue difference) | BIL | Supplier | — |
| `SUPPLIER_CREDIT_NOTE` | We owe supplier less: returned ticket, supplier price correction | SCN | Supplier | — |
| `SUPPLIER_PAYMENT` | Money paid to supplier | SPY | Supplier | out |
| `SUPPLIER_REFUND` | Money received back from supplier | SRF | Supplier | in |
| `EXPENSE` | Operating expense (paid) | EXP | — | out |
| `MONEY_TRANSFER` | Cash ↔ bank ↔ wallet, owner capital in / drawings out | TRF | — | both |
| `BALANCE_APPLICATION` | Move a party's balance between bookings / on-account (no cash, no P&L) | APL | Customer or Supplier | — |
| `OPENING_BALANCE` | Go-live balances of customers, suppliers, money accounts | OPB | any | — |
| `FX_ADJUSTMENT` | Standalone realised FX correction (rare; normally embedded in settlement) | FXA | any | — |

Every type supports a **reversal** (same type, `is_reversal = 1`, mirror journal,
mandatory reason). Reversal is for *errors* (wrong amount typed, bounced cheque);
business changes use the adjustment types.

## 3. Chart of accounts (system, fixed codes)

| Code | Account | Class | Dimension |
|---|---|---|---|
| 1110 | Cash & bank | Asset | money account |
| 1200 | Accounts receivable – customers | Asset | customer (+ booking) |
| 2100 | Accounts payable – suppliers | Liability | supplier (+ booking) |
| 3100 | Opening balance equity | Equity | — |
| 3200 | Owner capital & drawings | Equity | — |
| 4100 | Ticket sales | Revenue | booking, ticket |
| 4110 | Sales returns & cancellations | Contra-revenue | booking, ticket |
| 4120 | Discounts allowed | Contra-revenue | booking |
| 4200 | Service & change fees | Revenue | booking |
| 4210 | Cancellation fees | Revenue | booking |
| 5100 | Ticket purchase cost | Cost | booking, ticket, supplier |
| 5110 | Purchase returns (supplier credits) | Contra-cost | booking, ticket, supplier |
| 5200 | Supplier penalties & charges | Cost | booking, supplier |
| 61xx | Operating expenses (one per category: rent, salaries, internet, utilities, bank charges, office, transport, other) | Expense | category |
| 7100 | Realised FX gain/loss | Other | — |
| 7200 | Rounding differences | Other | — |

Contra accounts keep *gross sales* and *returns* separately visible in reports.

**Definitions used by every report:**
- **Net Sales** = Σ(credit − debit) on 4100, 4110, 4120, 4200, 4210
- **Net Purchase Cost** = Σ(debit − credit) on 5100, 5110, 5200
- **Gross Profit** = Net Sales − Net Purchase Cost
- **Operating Expenses** = Σ(debit − credit) on 61xx
- **Other** = Σ(credit − debit) on 7100, 7200
- **Net Profit** = Gross Profit − Operating Expenses + Other
- **Customer Receivable** = Σ(debit − credit) on 1200 (as of a date)
- **Supplier Payable** = Σ(credit − debit) on 2100 (as of a date)
- **Collections** (cash basis) = receipts − customer refunds in period
- **Cash position** = Σ(debit − credit) on 1110 per money account

## 4. Posting rules

`Dr` = debit, `Cr` = credit. `[c,b]` = customer + booking dimensions, `[s,b]` =
supplier + booking, `[m]` = money account.

| # | Document | Journal | Effect |
|---|---|---|---|
| P1 | CUSTOMER_INVOICE (fare / taxes) | Dr 1200[c,b] / Cr 4100 | receivable ↑, sales ↑ |
| P1a | … service/change fee line | Dr 1200[c,b] / Cr 4200 | |
| P1b | … cancellation fee line | Dr 1200[c,b] / Cr 4210 | |
| P2 | CUSTOMER_CREDIT_NOTE (return) | Dr 4110 / Cr 1200[c,b] | receivable ↓, net sales ↓ |
| P2a | … discount line | Dr 4120 / Cr 1200[c,b] | |
| P3 | CUSTOMER_RECEIPT | Dr 1110[m] / Cr 1200[c,b or on-account] | cash ↑, receivable ↓ — **no P&L** |
| P4 | CUSTOMER_REFUND | Dr 1200[c,b] / Cr 1110[m] | cash ↓, customer credit ↓ — **no P&L** |
| P5 | SUPPLIER_BILL (ticket cost) | Dr 5100 / Cr 2100[s,b] | payable ↑, cost ↑ |
| P5a | … supplier penalty line | Dr 5200 / Cr 2100[s,b] | |
| P6 | SUPPLIER_CREDIT_NOTE | Dr 2100[s,b] / Cr 5110 | payable ↓, net cost ↓ |
| P7 | SUPPLIER_PAYMENT | Dr 2100[s,b or on-account] / Cr 1110[m] | cash ↓, payable ↓ — **no P&L (BR-FIN-03)** |
| P8 | SUPPLIER_REFUND | Dr 1110[m] / Cr 2100[s,b] | cash ↑, supplier credit ↓ — **no P&L** |
| P9 | EXPENSE | Dr 61xx / Cr 1110[m] | cash ↓, expense ↑ |
| P10 | MONEY_TRANSFER | Dr 1110[to] / Cr 1110[from]; capital: Dr 1110 / Cr 3200; drawings: Dr 3200 / Cr 1110 | no P&L |
| P11 | BALANCE_APPLICATION | Dr 1200[c, on-account] / Cr 1200[c, b] (or AP mirror) | moves open items only |
| P12 | OPENING_BALANCE | Dr 1200 or 1110 / Cr 3100; Dr 3100 / Cr 2100 | |
| P13 | Settlement at a different FX rate | extra line Dr/Cr 7100 for the base difference | realised FX |
| R | Reversal of any of the above | identical lines with debit ↔ credit swapped | |

Payments are **allocated** by splitting their AR/AP line across booking dimensions
(`booking_id`); the unallocated part carries `booking_id = NULL` ("on account"). No
separate allocation table is needed and allocations are as immutable as everything else;
re-allocation is a `BALANCE_APPLICATION`.

## 5. Worked examples — the acceptance cases

Amounts in EGP (base currency). All examples were executed against the draft schema
(see [03-database-schema.md §6](03-database-schema.md)).

### Case A — fully paid on both sides
| Step | Doc | Journal |
|---|---|---|
| Issue | INV 10,500 | Dr AR 10,500 / Cr Sales 10,500 |
| | BIL 10,100 | Dr Cost 10,100 / Cr AP 10,100 |
| Customer pays | RCT 10,500 | Dr Cash / Cr AR |
| Pay supplier | SPY 10,100 | Dr AP / Cr Cash |

**Result:** Sales 10,500 · Cost 10,100 · **Gross profit 400** · AR 0 · AP 0 · Cash +400.

### Case B — customer partially paid
INV 10,500; BIL 10,100; RCT 5,000.
**Result:** Gross profit **400** (unchanged by payment) · Customer paid 5,000 ·
**Customer receivable 5,500**.

### Case C — supplier partially paid
INV 10,500; BIL 10,100; SPY 5,000.
**Result:** **Supplier payable 5,100** · Gross profit **remains 400** (test asserts GP
before and after the supplier payment are identical).

### Brief §8 — instalments
INV 10,500; RCT 5,000; RCT 2,000; RCT 1,000; RCT 2,500 → 4 independent receipts,
paid 10,500, remaining 0. Nothing overwritten.

### Cases D, E, G — cancellation with fees, full refunds both sides
Start from Case A (all settled). Customer cancels. Airline/supplier refunds all but a
**300** penalty. Office charges a **500** cancellation fee.

| Step | Doc | Journal |
|---|---|---|
| Customer credit note | CRN 10,500 | Dr Sales returns 10,500 / Cr AR 10,500 |
| Office fee | INV 500 (CANCELLATION_FEE) | Dr AR 500 / Cr Cancellation fees 500 |
| Supplier credit note | SCN 10,100 | Dr AP 10,100 / Cr Purchase returns 10,100 |
| Supplier penalty | BIL 300 (SUPPLIER_PENALTY) | Dr Supplier penalties 300 / Cr AP 300 |
| *State now* | | AR = −10,000 (we owe customer) · AP = −9,800 (supplier owes us) |
| Customer refund (Case D) | RFD 10,000 | Dr AR / Cr Cash |
| Supplier refund (Case E) | SRF 9,800 | Dr Cash / Cr AP |

**Result:** Net sales 500 · Net cost 300 · **Gross profit 200** · AR 0 · AP 0 ·
**Cash +200 = gross profit** (a fully settled booking always satisfies cash = GP; this
is an automated invariant). Original documents untouched.

Period view (BR-FIN-06): if issue was in September and cancellation in October,
September still shows GP +400 and October shows −400 + 500 − 300 = **−200**.

### Case F — partial customer refund
Customer paid 10,500; office agrees to reduce the price by 1,000 (e.g. downgraded seat,
no supplier change): CRN 1,000 (DISCOUNT) → AR −1,000 → RFD 1,000.
**Result:** Net sales 9,500 · GP −600 (= 9,500 − 10,100) · AR 0.
Partial *passenger* refund (1 of 2 passengers cancels) uses the Case D pattern with lines
limited to that passenger's ticket.

### Case H — multiple currencies
Base EGP. Customer invoiced EGP 10,500. Supplier bills **USD 200 @ 50.50** = EGP 10,100
(frozen). Supplier paid USD 200 from the USD bank when the rate is **51.00** = EGP 10,200.

| Doc | Journal (txn / base) |
|---|---|
| BIL USD 200 @ 50.50 | Dr Cost USD 200 / EGP 10,100 · Cr AP USD 200 / EGP 10,100 |
| SPY USD 200 @ 51.00 | Dr AP USD 200 / EGP 10,100 · **Dr FX loss EGP 100** · Cr USD bank USD 200 / EGP 10,200 |

**Result:** USD payable = 0 in USD · **Gross profit 400** (FX does not touch GP) · Net
profit includes FX loss 100. Cross-currency settlement (customer pays EGP against a USD
invoice) uses an explicit, user-confirmed rate on the receipt and the same FX line.

### Case I — multiple passengers
One booking, 3 passengers (2 ADT + 1 CHD), one invoice with 3 FARE lines (each with
`passenger_id` and `ticket_id`), one bill with 3 cost lines. Profit is reportable per
passenger/ticket; partial cancellation of one passenger touches only their lines.

### Case J — multiple segments
Round trip or multi-city: segments 1..n linked to tickets via `ticket_segment`. Pricing is
per ticket (not per segment — airlines price the journey). A schedule change on segment 2
is tracked on segment 2 only; financials unaffected unless a reissue follows.

### Case K — booking modified after payment
Customer fully paid 10,500. Fare increases by 300 at reissue, supplier charges 250 more,
office adds 50 change fee:
INV 350 (FARE-difference 300 + CHANGE_FEE 50) → AR 350; BIL 250 → AP +250.
GP = 400 + 350 − 250 = **500**. Original invoice unchanged; the booking shows the
adjustment trail. Price *decrease* = Case F.

### Case L — supplier changed after booking creation
Issued with Supplier S1 (BIL 10,100), 4,000 already paid to S1. Office rebooks through S2
at 10,000:
SCN to S1 10,100; BIL from S2 10,000.
**Result:** GP **500**; payable to S2 = 10,000; **S1 now owes us 4,000** (credit
balance) → UI warns: "4,000 paid to S1 must be refunded or used for other purchases".
Booking payable is shown **per supplier**, never netted across suppliers.
Before issue (DRAFT/RESERVED) the supplier is a plain field edit (audited).

### Case M — unauthorised financial action
A Sales Agent (no `payment.customer.reverse`) invokes *reverse receipt* → the service
layer rejects with `FORBIDDEN` **before** any write; an `auth.permission_denied` audit
row is written; journal row count is unchanged. Tests also call the IPC command directly
(bypassing UI) to prove enforcement is server-side.

## 6. Multi-currency design

| Element | Decision |
|---|---|
| Base currency | One per installation, chosen at setup, frozen after first posting. |
| Transaction currency | Per document; money accounts are single-currency. |
| Rate | Default from `exchange_rate` (latest on/before doc date); user may override with permission `finance.override_rate`; the used rate is frozen on the document. |
| Stored | txn amount, rate, base amount on document, lines, and journal lines. |
| Balances | Per party **per currency** (a customer can owe USD 200 and EGP 1,000 simultaneously). Reports can show txn currency or base. |
| Settlement | Same-currency settlement clears the txn balance; the base difference goes to 7100. |
| Cross-currency receipt | Receipt in EGP applied to a USD booking: user confirms the conversion rate; the AR line is in USD (clearing USD), the cash line in EGP; FX difference to 7100. |
| Unrealised FX | Not posted in v1. An "open foreign balances at today's rate" report shows exposure. |
| Rate edits | Allowed (audited) and never retroactive. |

## 7. Rounding

- Conversion `base = round_half_up(txn × rate)` at posting, per line; the document base
  total is the sum of line base amounts (not an independent conversion), so journal
  entries always balance.
- If a settlement leaves a residual ≤ 1 minor unit per currency after FX, it is posted to
  7200 automatically; anything larger requires a user decision.

## 8. Dashboard & report metric definitions

| Metric | Definition | Basis |
|---|---|---|
| Sales (period) | Net Sales for documents dated in period | accrual |
| Collections (period) | Σ receipts − Σ customer refunds dated in period | cash |
| Purchases (period) | Net Purchase Cost dated in period | accrual |
| Gross profit (period) | Sales − Purchases | accrual |
| Expenses (period) | Σ 61xx | as paid (v1) |
| Net profit (period) | GP − Expenses + Other | |
| Customer receivables | Σ positive customer balances **as of period end**; credits shown separately | point in time |
| Supplier payables | Σ positive supplier balances as of period end; supplier credits separately | point in time |
| Outstanding payments | Count/amount of bookings with customer remaining > 0 | point in time |
| Bookings | Count of bookings issued in period | |
| Cancelled / refunded | Count of cancellation requests closed in period, by type (VOID/REFUND) | |
| Upcoming departures | Active segments departing in the next N days (default 3) | |
| Changes requiring attention | Schedule changes in NOT_NOTIFIED / NOTIFICATION_FAILED (see BR-SCH-03) | |

Periods are computed in the company timezone. *This Week* starts on the day configured in
settings (default Saturday for EG/SA).

## 9. Aging

- **Open item** = (party, booking, currency) with a non-zero balance; on-account balances
  are listed separately as "unapplied".
- **Age** = as-of date − `booking.due_date` (issue date + party payment terms; terms
  default 0 → due on issue).
- Buckets from setting `aging.buckets` (default `[0, 7, 30, 60]` →
  *Current* (not yet due / day 0), *1–7*, *8–30*, *31–60*, *60+*). Changing buckets
  changes presentation only, never data.
- Within a booking, later debits (e.g. reissue fee) age with the booking (documented
  simplification; FIFO-by-document refinement possible later without schema change).

## 10. Invariants (automated, run in tests and in the in-app integrity check)

| ID | Invariant |
|---|---|
| INV-1 | Every journal entry: Σ debit_base = Σ credit_base, ≥ 2 lines, sealed. |
| INV-2 | Trial balance over all lines = 0. |
| INV-3 | Σ document line amounts = document total; Σ line base = document base total. |
| INV-4 | Σ customer sub-ledger balances = account 1200 total; same for 2100 and 1110. |
| INV-5 | Recording any payment/refund document never changes Gross Profit (property test). |
| INV-6 | For a fully settled booking (AR = 0 and AP = 0 in all currencies), cash effect = gross profit (base, excluding FX). |
| INV-7 | Every document either is not reversed or has exactly one mirror reversal whose journal nets to zero with it. |
| INV-8 | No document dated ≤ lock date was created after the lock was set (audit-log cross-check). |
| INV-9 | Audit hash chain verifies from genesis to head. |
| INV-10 | A receipt/payment allocation never pushes a (party, booking, currency) balance past zero into credit; any excess is on-account and was explicitly approved as an overpayment. |
