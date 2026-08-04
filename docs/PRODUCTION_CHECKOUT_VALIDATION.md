# Production Checkout Validation

**Date:** 2026-08-04 · **Status:** System-property evidence COMPLETE; live human-in-the-loop order PENDING (needs a person at the M-Pesa PIN + rider app).

> **Honesty note.** A literal end-to-end order with real money cannot be executed headlessly — the M-Pesa STK PIN and the rider accept/pickup/complete are human actions on physical handsets. This document proves the **system properties** by (a) citing the real deployed execution path, and (b) running the existing exactly-once settlement harness against the **real** `settleOrder`. The final step is a human placing one order against the checklist in §5. Nothing here is fabricated: §D reproduces actual emulator output.

---

## A. Delivery pricing — authoritative path is DEPLOYED and correct

Order checkout recomputes delivery **server-side** (`functions/index.js:3313-3374`):
- Reads the merchant's `sellers/{sellerUid}.deliveryConfig` and recomputes via the shared `functions/shared/delivery-engine.js` `calculateDelivery()` — the same module the client uses, so they can't drift.
- **Client/server mismatch is REJECTED** (not absorbed): logs `delivery_fee_mismatch` to `auditLogs` and throws `failed-precondition` returning the authoritative `serverDeliveryFee` so the client refreshes (`index.js:3342-3360`).
- `delivery_fee_unverified` is logged **only when the merchant has no `deliveryConfig`** (legacy 0–5000 clamp, `index.js:3361-3373`).

**⇒ To exercise the authoritative path for Kass Shop and stop `delivery_fee_unverified`:** give Kass Shop a real `deliveryConfig`. Recommended (distance mode, Nairobi):
```js
sellers/{KASS_SHOP_UID}.deliveryConfig = {
  enabled: true,
  mode: 'distance',        // baseFee + perKm × distanceKm
  baseFee: 100,            // KES
  perKm: 20,               // KES/km
  freeAbove: 3000,         // free delivery above KES 3,000 subtotal
  defaultFee: 200,         // fallback for flat/own_fleet modes
}
```
Apply via the KASS Shop delivery settings UI, or run `node scripts/qa/set-kass-delivery-config.js <KASS_SHOP_UID>` (writes exactly the config above).

**Verify after configuring:** place a cart, note the fee; change the address/cart → the server recomputes; a stale client fee returns `failed-precondition` (mismatch); `auditLogs` shows NO new `delivery_fee_unverified` for Kass Shop (it may show `delivery_fee_mismatch` on a deliberately stale submit — that's the guard working).

## B. Distance source — CLIENT-SIDE (straight-line), a recorded enhancement

`calculateDelivery` receives `distanceKm: request.data.distanceKm` (`index.js:3337`) — the distance is **supplied by the client**, not computed server-side. The browser almost certainly sends **haversine (straight-line)** distance from geolocation; the server's road-network modules (`router.project-osrm.org` is CSP-allowed, `logistics-plus.js` uses `_haversine` for route optimisation) are not in the checkout-fee path.

**Real integrity gap (record as planned enhancement, do NOT assume accurate):** the mismatch check catches fee-vs-config drift but **not a manipulated `distanceKm`**, because the server recomputes the fee from the *client's own* distance. A city marketplace should price on **road distance**; the fix is a server-side distance (OSRM/road-network) fed into `calculateDelivery` instead of trusting the client value. Until then, distance-mode fees are only as trustworthy as the client's straight-line estimate.

## C. Dispatch — online filter + distance/vehicle ranking + workload, first-claim-wins

`functions/dispatch.js`:
- **Online status:** queries `rideDrivers where isOnline == true` (`:106`).
- **Distance/vehicle ranking:** `SokoniDispatch.rankRiders(riders, delivery)` → score from `distKm`/`etaMin`/`vehicleType` (`:108,124`).
- **Workload:** `activeDeliveries` `increment(+1)` on accept (`respondToDispatch :193`), `increment(-1)` on completion (`captureProofOfDelivery :343`) / failure (`:395`).
- **Assignment → acceptance → pickup → completion:** `dispatchDelivery` (offer) → `respondToDispatch` (accept) → `captureProofOfDelivery` (proof + complete); `processCascadeTimeouts` re-offers to the next-ranked rider on timeout.
- **First-claim-wins** proven empirically (§D B1–B4): exactly one rider wins a concurrent claim; losers get a clean rejection.

Single-rider test (you online as the only rider) removes ranking variables and exercises assign→accept→pickup→complete cleanly.

## D. Financial integrity — exactly-once, EMPIRICALLY PROVEN

`functions/order-settlement.js settleOrder()` is idempotent + replay-safe by construction: deterministic `settlements/{orderId}` (`:62`), atomic `runTransaction` (`:64`), wallet credit `wallets/{sellerId}.balance` increment inside the txn (`:92`), deterministic wallet-txn id `${sellerId}_${orderId}_ordersettle` (no double-credit, `:97`), balanced double-entry `ledger/{orderId}_{type}` (`:112`), state-guarded HELD→ELIGIBLE→SETTLED→REVERSED.

`functions/payment-success.js onPaymentSucceeded` claims the pipeline in a transaction (returns false if already claimed; "already processed — skipping" `:180`) and dedupeKey notifications — so **customer-charged-once** holds (with the frozen wallet's already-proven webhook-replay idempotency).

**Ran the real harness** `functions/qa-dispatch-settlement-e2e.js` (imports the REAL `settleOrder`) on the Firestore emulator — **14/14 passed**:
```
[order-settlement] SETTLED orderA → seller sellerA +873 KES (commission 2700c)
[order-settlement] SETTLED orderB → seller sellerB +1794 KES (commission 5550c)
[order-settlement] SETTLED orderC → seller sellerC +485 KES  (commission 1500c)
  PASS A1 auto-assigned rider preserved through settle
  PASS A2 settleOrder outcome=settled
  PASS A3 seller credited a positive amount        [Δ=873 = netShillings]
  PASS A4 settlements/{orderId} written exactly once
  PASS A5 order.settlementStatus=SETTLED
  PASS B1 exactly ONE rider won the claim          [winners=1]
  PASS B2 order.status=rider_assigned
  PASS B3 assignedDriverUid == the winner
  PASS B4 losers got a clean rejection (not a crash)
  PASS B5 seller credited once, positive           [Δ=1794]
  PASS C1 exactly one of 3 concurrent settlements credited   [settled=1]
  PASS C2 replay is a no-op                         [already-settled]
  PASS C3 wallet credited by exactly the settled amount (no double-credit)  [Δ=485]
  PASS C4 single deterministic walletTransaction exists
  14/14 checks passed
```
Reproduce: `bash scripts/qa/run-dispatch-e2e.sh` (needs JDK-17 + the v1.19.8 Firestore emulator jar — the v1.21.0 cached jar requires Java 21).

**Maps to the D checklist:** charged once → payment claim-once + frozen webhook-replay; merchant credited once → A3/B5/C3; commission once → deterministic in `settleOrder` (2700c/5550c/1500c above); wallets/ledger reconcile → balanced `ledger/{orderId}_*` + `settlements/{orderId}`; settlement record created → A4; no duplicate payout → payout idempotency (Admin OS P0 test 14/14); admin finance / provider wallet / reports reflect → they read the canonical `settlements`/`wallets`/`commissionLedger` `settleOrder` writes.

---

## 5. Human-only live test checklist (one real order)

Config first: apply §A Kass Shop `deliveryConfig`. Then, as a real customer + the only online rider:
1. Add a Kass Shop product to cart → note the delivery fee shown.
2. Change delivery address → confirm the fee updates (server recompute).
3. Checkout → M-Pesa STK → **enter PIN on phone** → payment completes.
4. As rider (only one online): receive dispatch → **Accept** → **Pickup** → **Complete** (proof of delivery).
5. Verify (probe): `settlements/{orderId}` exists once; seller `wallets/{uid}.balance` rose by exactly the net; `commissionLedger`/settlement commission recorded once; `auditLogs` shows no `delivery_fee_unverified` for Kass Shop; Admin OS → Payments/Reports/Bookings reflect it; provider/seller wallet reflects it.

Only when a human has completed steps 1–5 is the order path "production-proven" per the Release Validation Standard (Engineering Complete ≠ Production Proven).
