# 08 — Edge Cases Catalogue

Covers deliverable item **H**. Every row becomes at least one automated test (`EC-xxx`)
in the phase that delivers the feature. "Expected" is the binding behaviour.

## 1. Accounting (the brief's Cases A–M)

| ID | Case | Expected |
|---|---|---|
| EC-A | Sale 10,500 · cost 10,100 · fully paid both sides | GP 400, AR 0, AP 0, cash +400 |
| EC-B | … customer paid 5,000 | GP 400, AR 5,500 |
| EC-C | … supplier paid 5,000 | AP 5,100, GP 400 (unchanged by payment) |
| EC-D | Customer refund after cancellation | CRN + RFD; original INV/RCT untouched; AR returns to 0 |
| EC-E | Supplier refund | SCN + SRF; AP returns to 0 |
| EC-F | Partial customer refund (price reduction or one of N passengers) | CRN for the part only; GP recomputed from documents |
| EC-G | Office cancellation fee 500 + supplier penalty 300 | GP of cancelled booking = 200; cash = 200 once settled |
| EC-H | Supplier bills USD, customer pays EGP; rate moves | GP in base at issue rates; realised FX in Net Profit only; USD balance clears in USD |
| EC-I | 3 passengers, mixed ADT/CHD/INF | Per-ticket lines; per-passenger cancel possible |
| EC-J | Multi-city 4 segments, one ticket covering all | Schedule change isolated to its segment; pricing per ticket |
| EC-K | Price change after full payment (+/−) | Extra INV or CRN; never an edit; history visible |
| EC-L | Supplier changed after partial supplier payment | SCN old + BIL new; old supplier credit balance flagged; payables shown per supplier |
| EC-M | Agent attempts reverse/refund/supplier payment/lock via direct IPC | FORBIDDEN before any write; `auth.permission_denied` audited; journal unchanged |

## 2. Payments & balances

| ID | Case | Expected |
|---|---|---|
| EC-P01 | Payment exceeds booking remaining | Blocked unless user routes excess on-account with `payment.accept_overpayment` |
| EC-P02 | Zero or negative amount | Rejected at contract layer and by DB CHECK |
| EC-P03 | One receipt paying three bookings + remainder on account | One RCT, 4 AR lines; each booking remaining correct |
| EC-P04 | Deposit on RESERVED booking, then booking discarded | Discard blocked until deposit refunded or applied on-account |
| EC-P05 | Deposit on RESERVED booking, then issued | Deposit reduces remaining immediately after issue |
| EC-P06 | Bounced cheque | Reversal of RCT with reason; AR restored; receipt marked REVERSED in lists/prints |
| EC-P07 | Reverse a receipt that was partly refunded | Blocked; refund reversal first |
| EC-P08 | Double-click on "Save payment" / retry after timeout | Idempotent command id → exactly one receipt |
| EC-P09 | Two users edit the same booking | Optimistic lock: second save gets "changed by X", no silent overwrite |
| EC-P10 | Customer with credit on one booking and debt on another | Customer balance nets; aging shows both; apply-balance moves credit |
| EC-P11 | Supplier pre-funded (top-up) before any purchase | SPY on-account; supplier shows credit; later bills consume it via apply-balance |
| EC-P12 | Receipt into a USD money account with EGP currency selected | Rejected (money account currency must match) |
| EC-P13 | Rounding: 3 instalments of 3,500.00 on 10,500.00; conversions with repeating decimals | No residual; FX residual ≤ 1 minor unit goes to 7200 |
| EC-P14 | Receipt dated in a locked period | Rejected with clear message |
| EC-P15 | Backdated receipt older than N days in open period | Requires `finance.backdate` |
| EC-P16 | Credit limit exceeded at issue | Warning (or block if configured) |

## 3. Bookings, passengers, tickets, segments

| ID | Case | Expected |
|---|---|---|
| EC-B01 | Issue without supplier/cost | Blocked (BR-BKG-01) |
| EC-B02 | Sale below cost | Requires `booking.sell_below_cost` + reason |
| EC-B03 | Zero-priced ticket (award/staff) | Requires `booking.zero_price`; INV not posted if 0, flag shown |
| EC-B04 | Duplicate ticket number | Rejected (unique index) with link to the other booking |
| EC-B05 | Ticket number added after issue | Allowed; "missing ticket no." badge until filled |
| EC-B06 | Infant without seat, child fare | pax_type drives labels only; prices entered per ticket |
| EC-B07 | Passenger name correction after issue | Allowed with audit; warning that airlines may require reissue |
| EC-B08 | Reissue (date change): new ticket, fare difference + change fee | Old ticket EXCHANGED, new ticket linked, INV/BIL for differences |
| EC-B09 | Booking contains tickets from two suppliers | Two BIL documents; payables per supplier |
| EC-B10 | Ticketing deadline passes on RESERVED booking | Alert; auto-transition only to "expired" flag, never auto-discard with deposits |
| EC-B11 | Change customer of an issued booking | Permissioned: reverse INV under old customer, re-post under new; receipts must be moved first |
| EC-B12 | Arrival next day (+1) / overnight flights | arrival_date ≥ departure_date check; displayed with +1 |
| EC-B13 | Airport without known timezone | Local times stored; UTC NULL; excluded from "departing in N hours" precision alerts but listed by date |
| EC-B14 | Same PNR used on two bookings | Warning, not block (split PNRs happen) |
| EC-B15 | Segment cancelled by airline (not by customer) | Schedule change of kind CANCELLED, MAJOR; may lead to refund workflow |

## 4. Refunds & cancellations

| ID | Case | Expected |
|---|---|---|
| EC-R01 | Void inside void window | VOID type; zero penalty default; reported separately |
| EC-R02 | Supplier refund amount differs from expectation | Actual amount posted; difference shown; no memo value posted |
| EC-R03 | Supplier rejects refund (non-refundable) | Supplier side REJECTED; customer credit only if office decides (goodwill → cost to office) |
| EC-R04 | Customer refunded before supplier confirms | Requires `refund.customer_before_supplier`; exposure visible in "pending supplier refunds" report |
| EC-R05 | Refund cash exceeding customer credit | Blocked unless explicit override permission |
| EC-R06 | Cancellation in a later month than issue | Later month absorbs reversal; issue month unchanged; booking-lifetime report shows net |
| EC-R07 | Partial cancellation of one segment on a multi-segment ticket | Supplier-confirmed amounts; ticket PARTIALLY_REFUNDED |
| EC-R08 | Refund in a different currency than the sale | Rate confirmed; FX difference to 7100 |
| EC-R09 | Withdraw a request after supplier submission | Only if supplier status still SUBMITTED; audited |
| EC-R10 | Cancellation fee larger than amount paid | Customer ends owing the difference (positive AR) |

## 5. Currency & dates

| ID | Case | Expected |
|---|---|---|
| EC-C01 | Change base currency after first posting | Rejected (trigger) |
| EC-C02 | Edit an exchange rate used by posted documents | Allowed (audited); posted documents unchanged; reports unchanged |
| EC-C03 | Missing rate for doc date | User must enter a rate; never silently use 1 |
| EC-C04 | KWD (3 decimals) | Minor unit 3 respected in inputs, storage, rounding, printing |
| EC-C05 | "Today" near midnight / PC clock in another timezone | Business date from company timezone |
| EC-C06 | PC clock moved backwards | Warning when now < last audit timestamp; audit keeps monotonic sequence |
| EC-C07 | DST transitions (e.g. Egypt summer time) | Flight local times unaffected; UTC derivation via IANA tz |
| EC-C08 | Report period "This Week" | Week start from settings (default Saturday) |

## 6. Data entry & search

| ID | Case | Expected |
|---|---|---|
| EC-S01 | Mobile typed as `٠١٠٠١٢٣٤٥٦٧`, `01001234567`, `+20 100 123 4567`, `00201001234567` | All normalise to `+201001234567` |
| EC-S02 | Search "احمد" finds "أحمد", "أَحْمَد" | Letter folding + diacritic stripping |
| EC-S03 | Search customer by last 4–7 digits of phone | Trigram / suffix match |
| EC-S04 | Search by passenger Latin name while customer name is Arabic | Both indexed |
| EC-S05 | Search input containing `"`, `*`, `NEAR`, `OR` | Treated as literal text (escaped) |
| EC-S06 | 2-character search | LIKE prefix fallback |
| EC-S07 | Duplicate customer (same mobile) | Warning with link, not block |
| EC-S08 | Very long notes / names with emoji / mixed bidi | Stored and displayed correctly; printing wraps |
| EC-S09 | Export cell starting with `=` | Escaped (formula-injection safe) |

## 7. System, backup & security

| ID | Case | Expected |
|---|---|---|
| EC-X01 | Power loss during a payment save | Either fully committed or absent (WAL + FULL sync); verified by kill-process test |
| EC-X02 | Disk full during backup | Backup marked FAILED, partial file deleted, DB untouched, user alerted |
| EC-X03 | Restore of corrupted / truncated file | Rejected at hash or integrity check; current DB untouched |
| EC-X04 | Restore of backup from newer app version | Rejected with explanation |
| EC-X05 | Restore of backup from older version | Migrated on a temp copy first, then swapped |
| EC-X06 | Restore of another company's backup | Warning showing company name/installation id; requires typed confirmation |
| EC-X07 | App crash mid-restore | Marker file → on next start complete or roll back to safety backup |
| EC-X08 | Data folder on network drive | Refused at setup and at startup |
| EC-X09 | Two app instances on one PC | Single-instance lock; second instance focuses the first |
| EC-X10 | Audit log row edited externally | Hash chain verification fails; integrity report flags from which row |
| EC-X11 | Brute-force login | Lockout after 5 attempts; audited |
| EC-X12 | Last admin disables themself | Rejected |
| EC-X13 | Session idle while a form is open | Screen lock; form preserved; re-auth resumes |
| EC-X14 | Unsealed journal entry found at startup | Integrity alert (indicates a bug); blocks posting until support resolves |
