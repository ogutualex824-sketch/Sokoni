# `sellerAuthorizeHandover` — design, then implementation (this slice)

**Status:** design settled against traced existing state/authority vocabularies; implemented and
certified in this same slice, per explicit instruction. No deploy. No r1 touch.
**Date:** 2026-09-03 · Extends `docs/SELLER_ACCEPTANCE_PICKUP_PIN_TRACE.md`,
`docs/ORDER_PIN_DISPATCH_AUTHORIZATION_TRACE.md`, `docs/TRACKING_EXPERIENCE_AUDIT.md`.

---

## The one finding that changes the plan: the proposed step 2 would regress a LIVE path

The recommended order's step 2 was *"pickup-PIN issuance moves from rider-claim trigger to
seller-authorization trigger."* Read literally against the actual code, this is unsafe:

`functions/delivery-pin.js`'s `deliveryPinOnAccept` issues **one** PIN, on the `driver_accepted`
transition, and writes **one** hash field: `deliveryPinHash`. `functions/delivery-complete.js`'s
`completeDeliveryWithPin` — **live, enforcing, today** — reads that exact same field:

```js
if (!d.deliveryPinHash) {
  throw new HttpsError("failed-precondition", "No delivery PIN was issued for this delivery.");
}
```

There is only one PIN today, serving both the not-yet-enforcing "pickup" shadow stage and the
live "delivery" completion stage — `deliveryVerifyShadow` says so explicitly: *"Shadow verifies
the Phase-0 deliveryPin for both until distinct pickup/delivery codes land at cutover."*

If issuance moved to fire only when a seller calls a new callable that has no UI yet, every real
delivery would have `deliveryPinHash` unset until a seller acts — and `completeDeliveryWithPin`
would reject every completion attempt with `failed-precondition` in the meantime. That is a live
regression on the exactly-once, money-adjacent completion path this session has repeatedly been
told not to touch casually, for a page (seller authorization) that does not have a button yet.

**Corrected design: add a second, independent PIN. Do not move the first one.** This is exactly
what the shadow module's own comment already names as the target ("distinct pickup/delivery
codes... at cutover") — a cutover to two codes, not a relocation of the existing one.
`deliveryPinOnAccept`, `deliveryVerifyShadow`, `getMyDeliveryPin`, and `completeDeliveryWithPin`
are **untouched** by this slice. A new `pickupPinHash` field, issued by the new callable, is
added alongside the existing `deliveryPinHash` — same document, same collection, independent
secret, independent lockout counter (the codebase already learned this lesson once — Phase 0's
shadow counter was deliberately split from the completion counter for the identical reason: a
new path must never be able to exhaust or interfere with the live one's attempt budget).

---

## State vocabulary — traced, not invented

`functions/fulfilment-lifecycle.js` is the existing canonical-status authority (built to fix a
real four-vocabulary divergence). Its ladder already contains:

```
... → assigned → picked_up → in_transit → delivered → completed → returned
```

**`picked_up` already exists** as the canonical stage immediately after `assigned` — it is not
invented for this slice. `functions/order-advance-authority.js`'s `STAGE_ACTORS` already lists
`picked_up: ['rider', 'admin']` — a rider (or admin) is already the authorized actor for that
*order*-level transition, via the existing `orderAdvance` callable, independent of this slice.

**Seller authorization is therefore modeled as a gating FACT, not a new status value:**
`handoverAuthorizedAt` / `handoverAuthorizedBy` on the `packageRequests` document (and mirrored
onto `orders`, matching the existing `deliveryPinIssued` mirror pattern in `delivery-pin.js`).
This keeps the canonical ladder exactly as it is — no new state to teach `isRiderActive`,
`LABELS`, `resolveStage`, or any of the five vocabularies `fulfilment-lifecycle.js` already
reconciles — while still making the who/when of custody transfer a durable, audited fact.

The resulting chain:

```
assigned              (canonical, existing — unchanged by this slice)
  ↓
handoverAuthorizedAt/By SET     ← NEW: sellerAuthorizeHandover (a fact, not a new status)
  ↓ (issues pickupPinHash, independent of deliveryPinHash)
rider enters pickup PIN         ← NEW: completePickupWithPin
  ↓ (verified — server-side, constant-time, own attempt counter)
picked_up             (canonical, existing — order-advance-authority already authorizes rider/admin here)
  ↓
in_transit            (canonical, existing — unchanged by this slice)
```

No money path is touched: `onOrderStatusChange` (the sole wallet-crediting trigger, traced in the
companion doc) gates the rider payout strictly on `toStatus === "delivered"` and rider
auto-assignment strictly on `toStatus === "confirmed"` — confirmed by reading the function's
actual dispatch logic this pass, not assumed. Writing `picked_up` reaches only the existing
notification-copy dictionary (`smsTemplates`, index.js:2280 — already has a `picked_up` entry,
buyer-only, no PIN referenced) — a beneficial side effect (the buyer already gets told when their
order is picked up), not a new hazard. Also confirmed: `deliveryPinOnAccept` is the **only**
Firestore trigger bound to `packageRequests` writes anywhere in `functions/` (checked, not
assumed) — so a `picked_up` status write on that collection fires nothing else.

---

## Authority — reuse, not a new vocabulary

`functions/delivery-authority.js` already exists to be the one place delivery-operation authority
is decided (its own header explains why: a second, hand-rolled check next to it previously drifted
from `fulfilment-scan.js`'s vocabulary and caused a real bug). Its `OPERATION_ACTORS` map already
encodes exactly this principle for the adjacent operation: *"dispatch — offering a job to riders is
the SELLER's decision... they are handing over custody."* Authorizing **this specific, already-
assigned** rider for handover is the same custody-transfer decision, later in the timeline. Adding
one entry:

```js
authorizeHandover: ['seller', 'admin'],
```

reuses `resolveActor`/`assertMayPerform` unchanged — no new authority module, no second ownership
vocabulary. Ownership is resolved from the `packageRequests` doc's `sellerUid`/`sellerId`/
`merchantId` (already-defined `SELLER_FIELDS`) or the linked order's.

---

## What is implemented in this slice

**`functions/delivery-pin.js`** — additive only: exports `_gen6`/`_hash` (already private helpers)
via `exports._h`, mirroring `delivery-complete.js`'s own `exports._h` convention, so the new module
reuses the exact same PIN-generation and HMAC logic rather than duplicating it. No other line in
this file changes — `deliveryPinOnAccept`'s trigger condition, `deliveryVerifyShadow`, and
`getMyDeliveryPin` are byte-for-byte unchanged.

**`functions/delivery-authority.js`** — one new entry in `OPERATION_ACTORS` (`authorizeHandover`),
one added case in the error-message ternary. Nothing else changes.

**`functions/seller-handover.js`** (new) — three callables, each following
`delivery-complete.js`'s proven pattern (assignment/ownership checked before any secret,
transactional, fail-closed on a missing HMAC secret, constant-time compare, audited):

- **`sellerAuthorizeHandover`** — seller-only (via `delivery-authority.assertMayPerform`), requires
  a rider already assigned (`driver_accepted`/`rider_assigned` — reads the same assignment fields
  `claimAvailableDelivery` writes; does not touch or re-run that transaction). Idempotent: a
  second call when already authorized returns `{alreadyAuthorized:true}` and does **not** mint a
  new PIN, so a re-tap can never invalidate a code already told to the rider. On first call:
  generates a PIN via `delivery-pin.js`'s `_h._gen6()`, stores `pickupPinHash` (HMAC, keyed,
  `delivery-pin.js`'s `_h._hash()`) + `handoverAuthorizedAt/By` + `pickupVerifyAttempts:0` on the
  `packageRequests` doc, mirrors the authorization fact onto `orders`, and writes the plaintext
  `pickupPin` onto the **existing** `deliveryPins/{orderId}` document (same deny-by-default
  collection the delivery PIN already lives in — zero new rules surface, which matters: live rules
  have ~596 bytes of headroom per `reference_rules_compiled_size_ceiling`).
- **`getMyPickupPin`** — mirrors `getMyDeliveryPin` exactly, but for the **seller**: proves the
  caller is the order's seller, explicitly refuses the assigned rider (same anti-self-read
  invariant as the buyer/delivery-PIN pair), reads `deliveryPins/{orderId}.pickupPin`. "Not yet
  authorized" returns `{issued:false}`, not an error — same discipline as `getMyDeliveryPin`.
- **`completePickupWithPin`** — rider-only (assignment checked before the PIN, same anti-oracle
  ordering as `completeDeliveryWithPin`), requires `pickupPinHash` to exist
  (`failed-precondition` — "handover not yet authorized" — if the seller hasn't acted), fails
  closed on a missing HMAC secret (this now gates a real transition, so it gets the same
  no-fallback treatment as the completion path, not the shadow path's constant fallback), **own**
  `pickupVerifyAttempts` counter with its own 5-attempt lockout (isolated from
  `deliveryVerifyAttempts`, for the exact reason the shadow layer's counter was already isolated).
  On success: writes `packageRequests.status = 'picked_up'` (canonical, existing — guarded by
  `fulfilment-lifecycle.index()`, comparing stage order rather than `canAdvance()`'s equal-allowed
  semantics, so a replay does not re-stamp `pickedUpAt` and an order already further along is left
  alone, not regressed — matching `_completeDelivery`'s "already delivered is inert" discipline)
  and mirrors onto `orders.status`. Touches no wallet, no escrow — verified above that `picked_up`
  triggers no money logic anywhere in `onOrderStatusChange`.

**`functions/index.js`** — three new exports, alongside the existing Phase 0/Phase 1 delivery-PIN
exports, per the "re-export by name or it isn't deployed" rule.

**`scripts/test-seller-handover.js`** (new) — isolated unit certification (stubbed
firebase-admin/functions, in-memory transactional Firestore — the pattern already used for
`test-convertprtopo-fix.js` and the premium-messaging certs this session), covering:
authorization denial for a non-seller/non-owning-seller, denial before a rider is assigned,
idempotency (second authorize call does not rotate the PIN), pickup-PIN reveal denies the rider
and a non-seller, `completePickupWithPin` denies an unassigned rider, denies before authorization
exists, enforces the 5-attempt lockout with its own counter (proven independent of
`deliveryVerifyAttempts`), fails closed on a missing HMAC secret, and on success advances
`packageRequests`/`orders` to `picked_up` without writing anything to a wallet collection —
asserted by inspecting the full in-memory store after the call, not merely trusting the return
value.

## What this slice does NOT do

Does not modify `claimAvailableDelivery` or its transaction. Does not modify
`deliveryPinOnAccept`, `deliveryVerifyShadow`, `getMyDeliveryPin`, or `completeDeliveryWithPin`.
Does not add any seller-facing UI button (`seller-delivery.html` is unchanged in this slice — the
callable exists and is certified; wiring a button to it is a follow-up, matching how Phase 0/
Phase 1 shipped backend-first). Does not touch `firestore.rules` (the new collections/fields used
are the existing `packageRequests`/`orders`/`deliveryPins` — no new rule needed; `deliveryPins`
already denies all client reads). Does not retire `proofPin` (still queued as its own later
cleanup). Does not deploy. Does not touch `C:/temp/sok-r1`.

## Related

`docs/SELLER_ACCEPTANCE_PICKUP_PIN_TRACE.md` · `docs/ORDER_PIN_DISPATCH_AUTHORIZATION_TRACE.md` ·
`docs/TRACKING_EXPERIENCE_AUDIT.md` · `functions/fulfilment-lifecycle.js` (status canonicalization,
reused not re-derived) · `functions/order-advance-authority.js` (order-stage authority, unchanged,
already correct for `picked_up`) · `functions/delivery-authority.js` (delivery-operation authority,
one addition) · `functions/delivery-pin.js` / `functions/delivery-complete.js` (the pattern this
slice follows and the helpers it reuses)
