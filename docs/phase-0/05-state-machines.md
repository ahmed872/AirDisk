# 05 — State Machines

Covers deliverable item **G**, report section **7. State Machines**.

Every state machine is implemented as a pure, table-driven function in the domain
package (`transition(state, event, context) → newState | DomainError`), unit-tested
exhaustively (every state × every event), and every accepted transition is audited.
Financial statuses such as "paid" are **derived** from the journal, never stored.

---

## 1. Booking

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> RESERVED : reserve (PNR on hold)
  DRAFT --> ISSUED : issue ⟹ post INV + BIL(s)
  RESERVED --> ISSUED : issue ⟹ post INV + BIL(s)
  RESERVED --> DRAFT : release hold
  DRAFT --> DISCARDED : discard
  RESERVED --> DISCARDED : discard / hold expired [party balance = 0]
  ISSUED --> VOIDED : void confirmed (all tickets) ⟹ post CRN + SCN
  ISSUED --> PARTIALLY_CANCELLED : cancellation confirmed (some pax/segments)
  ISSUED --> CANCELLED : cancellation confirmed (all)
  PARTIALLY_CANCELLED --> CANCELLED : remaining items cancelled
  CANCELLED --> [*]
  VOIDED --> [*]
  DISCARDED --> [*]
```

| State | Meaning | Financial effect | Editable |
|---|---|---|---|
| DRAFT | Being prepared | none | everything |
| RESERVED | Seats held, not ticketed; ticketing deadline tracked | none (deposits allowed as customer credit on the booking) | everything; deadline alerts |
| ISSUED | Ticketed; sale and cost recognised | INV + BIL posted | non-financial fields (audited); money only through adjustment commands; schedule edits create change events |
| PARTIALLY_CANCELLED | Some passengers/segments cancelled | cancellation documents posted for those items | as ISSUED |
| CANCELLED | Everything cancelled | cancellation documents posted | notes only; refunds/settlements still allowed |
| VOIDED | Voided within void window | mirror credit notes (± void fee) | notes only |
| DISCARDED | Abandoned before issue | none | none (may be purged if never had documents) |

Guards:
- `issue`: BR-BKG-01 checks; `booking.issue` permission; doc date not locked.
- `discard` from RESERVED: customer balance on this booking must be 0 (BR-PAY-04).
- `void`: all tickets in ISSUED status, `booking.void`; requires the supplier void to be
  confirmed (see §4).
- "Reissued/exchanged" is **not** a booking status: it is an event on ISSUED producing
  a new ticket (old ticket → EXCHANGED) and adjustment documents.
- "Completed/Travelled" is derived (all active segments departed), not stored.

Derived settlement badges (computed per currency from the journal):

| Customer side | Condition |
|---|---|
| UNPAID | charged > 0, paid = 0 |
| PARTIALLY_PAID | 0 < paid < charged |
| PAID | balance = 0 |
| CREDIT (refund due) | balance < 0 |

Supplier side analogously: UNPAID / PARTIALLY_PAID / PAID / SUPPLIER_CREDIT.

## 2. Ticket

```mermaid
stateDiagram-v2
  [*] --> ISSUED
  ISSUED --> VOIDED : void
  ISSUED --> EXCHANGED : reissue (new ticket created)
  ISSUED --> PARTIALLY_REFUNDED : some coupons refunded
  ISSUED --> REFUNDED : all coupons refunded
  PARTIALLY_REFUNDED --> REFUNDED
  ISSUED --> USED : all coupons flown (optional, manual or date-derived)
```
Terminal: VOIDED, EXCHANGED, REFUNDED, USED.

## 3. Financial document (receipt, payment, invoice, bill, expense …)

```mermaid
stateDiagram-v2
  [*] --> POSTED : create (atomic: doc + lines + sealed journal + audit)
  POSTED --> REVERSED : reversal document created (reason required)
  REVERSED --> [*]
```
- There is **no DRAFT financial document** persisted: the UI form is the draft; on save
  the document is posted atomically or not at all. This removes a whole class of
  "half-posted" bugs.
- `REVERSED` is derived (`EXISTS reversal WHERE reversal_of_id = id`); the original row
  is never touched.
- A reversal cannot be reversed; post a new correct document instead.
- Reversal of a receipt whose cash was already refunded is blocked (would double-count);
  the refund must be reversed first.

## 4. Cancellation / refund request

Two parallel sides plus an overall state, because suppliers and customers settle on
different timelines.

```mermaid
stateDiagram-v2
  state "Supplier side" as SS {
    [*] --> S_PENDING
    S_PENDING --> S_SUBMITTED : submit to supplier
    S_SUBMITTED --> S_CONFIRMED : confirm amounts ⟹ post SCN (+ penalty BIL)
    S_SUBMITTED --> S_REJECTED : supplier rejects (non-refundable)
    S_PENDING --> S_NOT_APPLICABLE : type = NON_REFUNDABLE
  }
  state "Customer side" as CS {
    [*] --> C_PENDING
    C_PENDING --> C_CREDITED : credit customer ⟹ post CRN (+ fee INV)
    C_PENDING --> C_NOT_APPLICABLE : nothing owed back
  }
```

| Overall | Rule |
|---|---|
| OPEN | Created; at least one side pending. |
| CLOSED | Both sides in a terminal state (CONFIRMED/REJECTED/NOT_APPLICABLE and CREDITED/NOT_APPLICABLE). Cash refunds may still follow; they are tracked by balances, not by this workflow. |
| WITHDRAWN | Customer changed their mind while both sides are still PENDING/SUBMITTED; nothing posted. |

Guards:
- `C_PENDING → C_CREDITED` while supplier side is not CONFIRMED requires
  `refund.customer_before_supplier` (Q6).
- `S_CONFIRMED` requires actual amounts; the difference vs. `expected_*` (memo) is shown.
- Cash refund to customer (`CUSTOMER_REFUND`) is limited to the customer's credit balance.
- Booking status moves to PARTIALLY_CANCELLED / CANCELLED / VOIDED when the request
  closes with posted documents.

## 5. Schedule change notification

```mermaid
stateDiagram-v2
  [*] --> NOT_NOTIFIED : schedule change recorded
  NOT_NOTIFIED --> CUSTOMER_NOTIFIED : notification sent / manual send confirmed
  NOT_NOTIFIED --> NOTIFICATION_FAILED : provider error / unreachable
  NOTIFICATION_FAILED --> CUSTOMER_NOTIFIED : retry succeeded
  NOT_NOTIFIED --> MANUALLY_CONFIRMED : agent spoke to customer (note required)
  NOTIFICATION_FAILED --> MANUALLY_CONFIRMED
  CUSTOMER_NOTIFIED --> MANUALLY_CONFIRMED : customer acknowledged
```
- *Requires attention* = NOT_NOTIFIED ∪ NOTIFICATION_FAILED (and CUSTOMER_NOTIFIED for
  MAJOR changes if setting `schedule_change.major_requires_confirmation` is on).
- A new change on the same segment sets `superseded_by_id` on the previous one; only the
  latest unresolved change per segment counts for attention.
- Optional `customer_response` (ACCEPTED / REQUESTED_CHANGE / REQUESTED_REFUND) can start a
  reissue or a cancellation request.

## 6. Notification (delivery attempt)

```mermaid
stateDiagram-v2
  [*] --> PENDING
  PENDING --> SENT : provider accepted / user confirms manual send
  SENT --> DELIVERED : provider delivery receipt (provider mode only)
  PENDING --> FAILED : provider error
  SENT --> FAILED : provider delivery failure
  PENDING --> CANCELLED : user cancels
```
Retries create a new notification row (full history of attempts).

## 7. User account

```mermaid
stateDiagram-v2
  [*] --> ACTIVE : created (must change password)
  ACTIVE --> LOCKED : N failed logins
  LOCKED --> ACTIVE : lock expires / admin unlocks
  ACTIVE --> DISABLED : admin disables
  DISABLED --> ACTIVE : admin re-enables
```
Users are never deleted (they are referenced by history). The last active Admin cannot be
disabled or lose the Admin role.

## 8. Financial period

`OPEN` ↔ `LOCKED` by moving `company_profile.financial_lock_date`. Moving it forward
(lock) requires `finance.lock_period`; moving it back (unlock) additionally requires a
reason and is highlighted in the audit report.

## 9. Backup / restore

See [10-backup-restore.md §5](10-backup-restore.md) for the restore state machine
(VALIDATING → READY → SAFETY_BACKUP → SWAPPING → VERIFYING → DONE | ROLLED_BACK), which is
crash-resumable through a marker file.
