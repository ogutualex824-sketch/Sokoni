# Void / Return / Refund / Replacement — audit and authority graph (2026-10-01)

**Status: AUDIT COMPLETE — implementation of money-moving parts STOPPED** under the brief's §22 stop
conditions. Several refund authorities compete. No safe M-PESA refund executor exists today, and the
fee policy is unresolved. Read-only audits ran on 2026-10-01 against live archives and served rules
`f259c0b5`. Evidence is in `scratchpad/void-audit/`.
**Related:** [[SECURITY_PRIVACY_GAP_CENSUS_2026-10-01]] · [[SOKONI_FINAL_SECURITY_PRIVACY_COMPLIANCE_CERTIFICATION]] · ADR-026 (refund cases) · ADR-032/033 (IntaSend refund)

## 1. Audit matrix

| Surface | Existing authority (live unless noted) | Existing action | Missing piece | Minimal fix | Deploy surface |
|---|---|---|---|---|---|
| Merchant V2 Sales | none native. Route `sales-control` opens the POS overlay `sokoni-pos-sales.js` | read-only list of `posRetailSales` | native page, case queue, open sale/order/booking | new route + module (sokoni-aa's Supply pattern) reading canonical records | hosting |
| Shop sale | `posCompleteCheckout` 00024-zit | create sale, deduct stock, post ledger/liability | tier + product ownership (sokoni-70's 4aa2227); idempotency replay is not shop-scoped; tax comes from the client | ship 4aa2227; scope the replay key | functions |
| Shop void | `posVoidSale` (unpushed `slice/realtime-control-plane`) | — | approval chain not live; no liability/claim/daily-summary reversal | deploy approvals + `posVoidSale`, then add reversals | functions |
| Shop return/refund | `posProcessRefund` 00013-joj (admin-only in practice; status read outside the txn; no dedup; voided not refused; **no money**) · `refundPOSPayment` (amount from the browser) · `pos.js` client refund/void · refund cases (unpushed) | label only | request → approve → execute; partial quantities; money reversal | refund cases are the gate; one executor built from `posProcessRefund`'s txn core; per-line refunded-quantity ledger | functions + hosting |
| Buyer order | rules let the buyer set `cancelled` from **any** state; `my-orders.html` read-only | list, track | per-state actions; a server cancel for paid orders | buyer cancel only from `pending_payment` (rules); paid → callable request | rules + functions + hosting |
| Merchant order | `orderAdvance` (timeline); the seller can set `refunded`/`cancelled` by rule | advance | approve queue; return/refund request | detail sheet in merchant-v2 (now owned here) → refund case | hosting + functions + rules |
| Online refund | `initiateRefund` (**a buyer call can debit the seller**) · `refundToWallet` (admin mints any amount) · `fosSubmitRefund`/`fosApproveRefund` (wrong IntaSend endpoint; seller debit skipped) · dispute automation (false "refund issued" message) · `refundPayment` (label) | none sound | one executor that reverses the seller credit on the rail it was credited | refund cases + one executor keyed on `payments/{apiRef}` | functions |
| Online return | `returns-engine` (refuses checkout orders; `markReturnProcessed` has no ownership check); `returns.html` (dead: `processReturn` does not exist) | dead | everything | fold returns into the refund case (with optional line/quantity) | functions + hosting |
| Replacement | none | — | everything | model as an approved return plus a new order linked to the original | — |
| Inventory return | POS: `posProcessRefund`/`posVoidSale` (increment + `inventoryVersion`). Online: **none** | — | online restock; dedup; void/refund mutual exclusion | inside the executor txn, floored at 0, with an operation id | functions |
| Seller settlement | webhook credits **at payment** to `wallets.availableBalance` (cents); `settleOrder` credits `wallets.balance` (shillings), gated by sokoni-70's 788416b; `reverseSettledOrder` reverses shillings only | — | reversal on the **cents** rail for webhook-paid orders | executor reverses by `payments.walletCreditedTo/walletCreditCents` + `commissionLedger` (or follows the PIN-release rail once sokoni-70 ships it) | functions |
| Provider booking | `providerCompleteBooking` txn = the single credit point; `_disburseHeldFunds` = refund/forfeit | confirm/decline/start/complete/cancel/no-show | PIN entry in the provider UI; AdminOS release lever | **fixed on port/booking-pin-on-shell-gate 6a9dd40**: in-txn PIN and status checks, paid decline refunds, trigger-inert order copy | functions + hosting |
| Booker booking | none (profile reads legacy `bookings`) | affected-booking refund card | providerBookings list, cancel, PIN view | page reading `customerUid` → `providerCancelBooking` + `getMyBookingPin` | hosting |
| AdminOS | refunds tab lists `refundRequests` and calls `processRefund` (contract mismatch, always fails); disputes = label only; `adminGetBookings` read-only | broken | case queue, transaction timeline, booking release | point the tab at the refund-case list; remove the broken `processRefund` call; read-only transaction/booking timeline | hosting |

## 2. Authority graph (today → canonical target)

| | SHOP SALE | ONLINE ORDER | BOOKING |
|---|---|---|---|
| Who creates | `posCompleteCheckout` | checkout (client write) → webhook marks it paid | `bookingCreateService` |
| Who owns | shop (`merchantId`) | buyer (`uid`/`buyerUid`) + seller (`sellerUid`, buyer-written) | customer (`customerUid`) + provider (`providerId`) |
| Who can view | shop staff · AdminOS (none today) | buyer · seller · AdminOS | customer · provider · AdminOS (read-only) |
| Who can change state | server callables; **today also `pos.js` in the browser** | **today: buyer cancel (any state) and seller set any status by rule** → target: callables only | provider-ops callables (+ in-txn checks, 6a9dd40) |
| Who requests a refund | cashier / buyer → refund case (target) | buyer / merchant → refund case (target) | customer → `customerRequestRefund` / cancel policy |
| Who approves | owner/manager (`refund` capability) → refund case | owner/manager or AdminOS on escalation → refund case | policy in `_disburseHeldFunds`; AdminOS lever (missing) |
| Who executes money | **missing** → ONE executor | **missing** (four competing) → ONE executor | `_disburseHeldFunds` (SOKONI wallet credit, not an IntaSend reversal) |
| Who restores inventory | executor txn (from `posProcessRefund` core) | **none** → executor txn | n/a |
| Who settles | cash/M-PESA direct + liability/ledger at sale | webhook at payment (cents) → PIN release (sokoni-70, owner decided) / `settleOrder` (gated) | `providerCompleteBooking` (single credit point) |
| Who audits | `pos.refund` audit / refund case history | refund case history + `adminAudit` | `entBookingAudit` + provider payouts |

## 3. Stop conditions that hold (brief §22)

1. **Competing refund authorities.** At least five are live, from four lineages. A buyer's call can debit a seller (`initiateRefund`), and an admin can mint any amount (`refundToWallet`).
2. **No safe M-PESA executor.** An IntaSend refund is a B2C payout with no terminal chargeback state. EKOQ6P0 is open: never post another. `invoice_id` is not persisted, and nothing consumes `reversal_event`.
3. **Refund fee policy unresolved.** ADR-033 says the buyer bears the fee; the code says no separate fee.
4. **The canonical record (refund cases) is unpushed and undeployed.** Its executor handles cash only. The merchant-identity anchor is unverified for marketplace payments.
5. **Webhook settlement is moving to PIN release** (sokoni-70's next unit). The reversal rail depends on it.

## 4. What was done today (not deployed)

- **Bookings** (`port/booking-pin-on-shell-gate` 6a9dd40):
  - a second provider credit via the orders mirror, removed
  - the PIN-bypass race and completion/cancel races, closed
  - paid declines now refunded
  - PIN encrypted at rest
  - tests: race 10/0, mirror-inert 3/0, at-rest 8/0
- **Order settlement:** sokoni-70's gate (788416b) stops live `settleOrder` paying an unpaid or self-dealt order. Every `onOrderStatusChange` deploy must carry it.
- **Seller payout readiness** is admin-approved only (functions 2070d1e, hosting 6f0a576 + Payout approvals view 54b8b33).

## 5. Owner decisions needed before any money-moving refund is built

1. **One refund authority:** confirm refund cases (request → owner/manager approve) as the only record, and one server executor.
2. **Retire or neutralise**, each in its own gated slice:
   - `initiateRefund`'s buyer-triggered seller debit
   - `refundToWallet`
   - `fosSubmitRefund` auto-approve
   - the false "refund issued" notices
   - the AdminOS `processRefund` button
3. **M-PESA refunds:** resolve the EKOQ6P0 chargeback with IntaSend, then decide the rail. Options are the IntaSend chargeback (B2C) or a SOKONI wallet credit with a later withdrawal.
4. **Refund fee:** who pays the IntaSend refund charge (ADR-033)?
5. **Replacement:** is it in scope now, modelled as an approved return plus a new linked order?
6. **Partial returns** (line/quantity): required for online orders now, or POS only?

## 6. Safe next steps that move no money (can proceed on approval)

- **Rules (via sokoni-32's release):**
  - the buyer may cancel only from `pending_payment`
  - the seller may not set `refunded`/`cancelled`/`paid` (seller blocklist already in the candidate)
- **Merchant V2 Sales page:** read-only, over `posRetailSales` + the shop's orders + bookings, with Open links and visible state. No action buttons until the executor exists.
- **Merchant order detail sheet:** state and timeline; "Request refund" only once refund cases are live.
- **AdminOS:**
  - remove the broken `processRefund` button from the refunds tab
  - add a read-only transaction timeline (order → payment → settlement → refund state)
- **Booker bookings page:** list `providerBookings` by `customerUid`, cancel via `providerCancelBooking`, PIN view via `getMyBookingPin`. These already exist server-side on the PIN branch.
