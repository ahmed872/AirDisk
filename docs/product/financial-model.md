# AirDesk — Financial Model (as implemented)

The design is [Phase 0 §04](../phase-0/04-financial-model.md). It has not been rewritten; 1.0.0-rc.1 implements every posting rule except FX_ADJUSTMENT (reserved).

## 1. Principles

1. **Double entry in an immutable journal.** Every monetary fact is a numbered `fin_document` with lines, turned into a balanced `journal_entry` by pure posting rules. Documents and journal lines are never edited or deleted; mistakes are corrected with a **reversal** (mirror document) or an **adjustment** document.
2. **Balances are derived.** Customer, supplier and cash balances, a record's Total/Paid/Remaining, profit, statements, aging and every report are queries over `journal_line`. There are no balance columns.
3. **Profit is independent of cash.** Sales and cost are recognised when a ticket is recorded as issued; payments only move cash and receivables/payables. Paying a supplier never changes profit; collecting from a customer never changes profit.
4. **Money in minor units** (integers), per-currency decimals (EGP/SAR/USD 2, KWD/BHD/OMR 3). Rates are decimal strings; conversion is half-up once per line and the document base total is the sum of line base amounts.
5. **Multi-currency:** each document keeps its currency, the exchange rate used and the base amount. Later edits to the rate table never change posted documents. Settlements clear a balance at the base value it is carried at; the difference is realised FX (7100).

## 2. Chart of accounts (system)

| Code | Account | Class |
|---|---|---|
| 1110 | Cash & bank (per money account) | Asset |
| 1200 | Accounts receivable — customers (per customer, per record) | Asset |
| 2100 | Accounts payable — suppliers (per supplier, per record) | Liability |
| 3100 | Opening balance equity | Equity |
| 3200 | Owner capital & drawings | Equity |
| 4100 | Ticket sales · 4110 Sales returns · 4120 Discounts | Revenue / contra |
| 4200 | Service & change fees · 4210 Cancellation fees | Revenue |
| 5100 | Ticket purchase cost · 5110 Purchase returns · 5200 Supplier penalties | Cost / contra |
| 6110–6190 | Operating expenses (rent, salaries, telecom, utilities, bank, office, transport, other) | Expense |
| 7100 | Realised FX gain/loss · 7200 Rounding | Other |

## 3. Documents and posting rules

| Doc | Prefix | Posting (base currency) | Created by |
|---|---|---|---|
| Customer invoice | INV | Dr 1200[customer, record] / Cr 4100 (fare, taxes), 4200 (service/change fee), 4210 (cancellation fee) | Confirm ticketed; sale increase; reissue difference/change fee; cancellation fee |
| Customer credit note | CRN | Dr 4110 (sale return) or 4120 (discount) / Cr 1200 | Quote discount at issue; sale decrease; customer credit in a cancellation |
| Customer receipt | RCT | Dr 1110[account] / Cr 1200 per allocated record (or on account) | Payments |
| Customer refund | RFD | Dr 1200 / Cr 1110 | Cash back to a customer, limited to their credit |
| Supplier bill | BIL | Dr 5100 (cost) or 5200 (penalty) / Cr 2100[supplier, record] | Confirm ticketed (one per supplier & currency); cost increase; reissue; supplier penalty on cancellation; supplier change (new supplier) |
| Supplier credit note | SCN | Dr 2100 / Cr 5110 | Cost decrease; supplier refund confirmation; supplier change (old supplier) |
| Supplier payment | SPY | Dr 2100 / Cr 1110 | Payments to suppliers |
| Supplier refund | SRF | Dr 1110 / Cr 2100 | Money received back from a supplier, limited to their credit |
| Expense | EXP | Dr 61xx (category account) / Cr 1110 | Expenses |
| Money transfer | TRF | account→account: Dr 1110[to] / Cr 1110[from]; capital: Dr 1110 / Cr 3200; drawing: Dr 3200 / Cr 1110 | Treasury transfers, owner movements |
| Balance application | APL | customer: Dr 1200[source: on account or record] / Cr 1200[target record]; supplier mirror on 2100 | Apply credit |
| Opening balance | OPB | Dr 1200/2100/1110 or Cr 1200/2100 against 3100 | Go-live balances |
| FX adjustment | FXA | — | Reserved; refused with UNSUPPORTED_DOCUMENT |

Document numbers are gap-free per type and year (`INV-2026-000001`), allocated inside the posting transaction.

## 4. Business rules that protect the numbers

- **Allocation limits:** a receipt can only settle what is open on a record (deposits before issue are limited to the quoted price); any remainder must be routed on account explicitly, which needs `payment.accept_overpayment` unless it pays an on-account debt such as an opening balance. Refunds are limited to the party's credit. Applications are limited to the source credit and the target's open amount.
- **Transfers** cannot exceed the source account balance and require the same currency on both sides.
- **Price below cost / zero price** need their own permissions; a quote's discount cannot exceed fare + taxes + fees.
- **Cancellations** are two-sided (supplier result and customer result are recorded independently); returned amounts are limited to the net sale / net cost of the ticket **including its reissue chain**.
- **Reissue** posts only the fare difference/change fee and extra cost/penalty on the new ticket; the old ticket becomes EXCHANGED and its amounts stay where they were posted.
- **Backdating** beyond `finance.backdate_days` (default 3) needs `finance.backdate`; documents on or before the **financial lock date** are refused.
- **Reversals** are allowed for receipts, refunds, payments, expenses, transfers (owner movements need their permission), applications and opening balances. Invoices and bills are corrected by adjustments or the cancellation workflow.
- **Idempotency:** a repeated command id never posts twice.

## 5. Derived figures

| Figure | Definition |
|---|---|
| Record Total / Paid / Remaining | 1200 lines of the record: charged = invoices + credit notes + openings; paid = receipts + refunds + applications; remaining = balance. Badge: Unpaid / Partly paid / Paid / Credit. |
| Supplier position per record | 2100 lines per supplier & currency: billed, paid, balance. |
| Gross profit | Revenue + contra-revenue − cost − contra-cost (base currency), per record, per period or overall. |
| Net profit | Gross profit − expenses + other (FX, rounding). |
| Collections / supplier payments | Cash lines of receipts/refunds and supplier payments/refunds only (transfers, capital, openings excluded). |
| Receivables / payables | Positive party balances as of a date; credits reported separately, never netted. |
| Aging | Per open record by due date (issue date + customer payment terms); amounts owed on account age from their first entry; credits shown separately. Buckets: current, 1–7, 8–30, 31–60, 60+. |
| Statements | Per party and currency: opening balance before the period, every document in the period with running balance, closing balance. |

## 6. Verified by tests

Scenarios A–M (A full sale settled both sides; B–D partial and multiple customer/supplier payments; E cancellation with fees and two independent refunds; F partial refund and one-of-two passengers; G schedule change; H 3 passengers × 3 segments; I supplier different from airline; J expenses and net profit; K multi-currency with realised FX; L backup/restore of operational data; M unauthorized access by a Sales Agent), the Phase 0 property tests (every generated document balances; payments never change profit; reversal nets to zero), P10–P12 property tests, reissue and refund chain, opening balances, transfers, credit application in foreign currency (realised FX), and the integrity check after each scenario. Counts are in the final report.
