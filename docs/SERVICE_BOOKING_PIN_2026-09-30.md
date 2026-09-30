# Service booking money + PIN YAKO NI BOOKING YAKO (2026-09-30)

**Status:** BUILT + PROVEN LOCALLY (emulator 14/0) · **NOT DEPLOYED** · deployment needs a port onto the live `providerDispatch` lineage (§5).
Owner ask: booking money goes to the provider's **business** wallet, never the buyer's; SOKONI commission deducted; release in real time after a successful service; the booking carries a PIN — "PIN YAKO NI BOOKING YAKO" — given to the provider **only after** the service, so the money stays refundable and secure; bookings recorded in orders as service bookings; all IntaSend payment methods; the PIN is what moves money into SOKONI's commission (AdminOS / super admin) and the provider's business wallet.

Related: [[COMMERCIAL_CONVERGENCE_2026-09-30]] · [[ENTERTAINMENT_BOOKINGS]] · [[BOOKING_LIFECYCLE_CONTRACT]]

## 1 · What already existed (census, read-only)

| piece | where | state |
|---|---|---|
| booking payment is **held**, never credited on payment | live `webhookIntasend` (`00068-del`) → `booking-payment-sweep.holdServiceBookingPayment`, keyed on the intent's `resourceType: providerBooking` — **rail-agnostic** (any IntaSend method that confirms the intent) | live |
| booking intent priced by the server from the booking snapshot (`price + fee`) | `payment-purposes.service_booking` | live |
| settlement: commission via the one engine, provider **business wallet** `wallets/{providerId}` credited net, `providerPayouts` row (what AdminOS aggregates as service commission) | `provider-ops._settlementMath / _settlementWrites` | live (on provider completion — **no customer confirmation**) |
| booking PIN: server-generated, HMAC-hashed, buyer-only secret, attempt limits, audit, "PIN YAKO NI BOOKING YAKO" phrase | `entertainment-bookings.js` + `shared/ent-booking-identity.js` | built on c4, **entertainment hub only**, not deployed |
| refunds go to the customer only on cancellation / no-show policy | `provider-ops._disburseHeldFunds` | live |

The gap: a provider could complete a paid booking and be paid **without** the customer confirming the service — the PIN existed only for entertainment and only as a show-up step.

## 2 · What changed (functions branch)

* **Every paid service booking** gets the envelope + PIN (the entertainment-only skip is removed; the hub now only decides the commission rate).
* **The PIN releases the money.** `provider-ops.settleOnPinRelease` — one transaction: booking `completed` + `settled` (`settledTrigger: 'pin_release'`), SOKONI commission on `providerPayouts`, provider business wallet credited net of commission (+ the booking fee, which passes through), slot released. Idempotent.
* **No PIN, no payout.** `providerCompleteBooking` on a `paid_held` booking refuses without the PIN ("PIN YAKO NI BOOKING YAKO…"); with a PIN it verifies and releases. Unpaid bookings complete as before.
* **`serviceBookingPin`** callable (new): `getMyBookingPin` (buyer only; issued once the payment is held) and `verifyBookingPin` (provider only).
* **Orders mirror**: `orders/{bookingId}` with `type: 'service_booking'`, buyer / provider, `escrow.held → released | refunded`, `commissionKES`, `providerNetKES`, `gatewayChargesKES` (IntaSend's charge = `payments.amount − netAmount`) — admin.html's orders view and its escrow bar see service bookings beside product orders.
* The buyer's wallet is never touched by a release; refunds keep their existing policy paths.

## 3 · Client (hosting branch)

* Booking payment screen: the PIN explained **before** paying ("You pay SOKONI, not the provider… give the PIN only after the service is done… refundable"); a **card / other methods** button appears only when the server enables `service_booking` in hosted checkout and a method is proven.
* After payment: the PIN is shown large with the phrase and the rule; status reads "held safely until you give the provider your PIN".
* Provider dashboard: **Complete** on a paid booking asks for the customer's 4-digit PIN; success toast "payment released to your business wallet".

## 4 · Proof (`scripts/test-service-booking-pin-e2e.js`, Firestore emulator, real modules) — 14/0

Envelope + PIN hash for a non-entertainment booking · buyer reads the PIN, provider cannot · order mirror escrow.held KES 2,000 · complete without PIN refused, nothing moves · wrong PIN refused + counted · correct PIN: completed/settled, business wallet +KES 1,600 (KES 2,000 − 20% Free-plan provider rate), `providerPayouts.commission` 40,000 cents, buyer wallet untouched · replay pays nothing twice, PIN is single-use · mirror shows released 1,600, commission 400, gateway charge KES 30.
Regressions: `test-entertainment-bookings` 95/0 (contract rewritten: PIN now releases **and** completes; every paid service booking gets a PIN) · `test-healthcare-payment-convergence` 40/0 (stub gained `getProviderPlanRate` — a pass-2 interface change) · booking-hold-expiry, ent-availability, ent-communications, ent-journeys, reputation, notify, communication-engine all green.

## 5 · Deployment — NOT ready from this branch (lineage gate)

`providerDispatch` is live from `candidate/providerdispatch-shell-gate` (`providerdispatch-00050-rur`, 2026-09-30 02:07): its reachable code carries ~850 lines this branch lacks (business-workspace, business-capabilities, business-scope, approval-remediation, availability, onboarding) and that lineage has **no** `entertainment-bookings.js` / `ent-booking-identity.js`. Deploying `providerDispatch` from here would regress the live workspace. The correct change is a **port onto that lineage**: `provider-ops.settleOnPinRelease` + the PIN gate, plus `entertainment-bookings.js`, `shared/ent-booking-identity.js`, `service-booking-pin.js` and their exports (`serviceBookingPin`, `entBookingOnProviderBooking`), content-diffed against the live archive, then one function at a time.

## 6 · Open — owner decisions / facts, not code

* **Customer pays the transaction charges**: today IntaSend deducts its charge from what SOKONI receives and settlement credits the provider from the booking price, so SOKONI absorbs the charge (now recorded per order as `gatewayChargesKES`). Moving it to the customer needs either IntaSend's customer-bears-charges account setting (unproven here) or a server-priced fee line on the intent with an owner-approved fee table. Not invented.
* **All IntaSend methods**: the rail is ready; enabling card etc. for bookings is `config/hostedCheckout.purposes += 'service_booking'` plus a proven method in `config/intasendCapability` — a production config write.
* **PIN expiry window**: the shared identity rules expire an unused PIN 12 h after the booking end; a customer who gives the PIN later cannot release it — the money stays held (safe) and needs a support path. Consider lengthening for services.
