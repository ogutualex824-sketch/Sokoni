# Tracking experience audit — buyer, seller, "premium" (read-only)

**Status:** 📋 READ-ONLY AUDIT + DESIGN. No code changed, no deploy, no r1 touch.
**Date:** 2026-09-03 · Extends the PIN workstream (`docs/ORDER_PIN_DISPATCH_AUTHORIZATION_TRACE.md`,
`docs/SELLER_ACCEPTANCE_PICKUP_PIN_TRACE.md`).

**Important caveat, stated up front rather than assumed away:** no file, function, or route in this
repository is literally named "premium tracking." Per the instruction not to assume it exists just
because *a* page exists, this audit treats **`delivery-tracking.html`** as the strongest candidate
(1,660 lines vs. `track.html`'s 491; it's what `seller-delivery.html`'s "Track Live" button opens;
it's linked from `checkout.html`, `my-orders.html`, `profile.html`, `admin.html`,
`sokoni-chat-composer.js`'s delivery cards, and has its own E2E spec) — **but this is an inference,
not a confirmed identification.** If "premium tracking" means something else, this audit is against
the wrong page and needs redirecting.

---

## `delivery-tracking.html` audited against the 5-state framework

| state | verdict | evidence |
|---|---|---|
| **BUILT** | ✅ | 1,660 lines, reads `packageRequests` directly (6 call sites: status card, rider position, ETA, map), not a stub |
| **CERTIFIED** | 🟡 **partial** | `scripts/test-map-engine-ratchet.js` covers it, but only for one narrow property — that it doesn't introduce a *new, competing* map/GPS engine (8/8 passing, run this pass). It does **not** certify this page's own order/tracking correctness — no test asserting "the right order's data appears," "the right rider's position is shown," or any of the states/negative-controls requested below was found for this page specifically |
| **ON R1** | ✅, **with an unreconciled 29-line drift** | confirmed present at `8fc3673`; diffed against the evidence branch's copy — 29 lines differ, not examined further in this pass (flagged, not resolved) |
| **DEPLOYED** | ✅ | live production check, this pass: `GET /delivery-tracking.html?ref=X` → `301` → `/delivery-tracking?ref=X` → `200` |
| **LIVE VERIFIED** | 🟡 **page loads; functional correctness not exercised** | confirmed the route resolves and serves real content (200, not an error page) — did **not** drive it with a real order/delivery/rider to confirm the map/timeline/rider position actually render correctly end to end. That needs either seeded test data or a real order, neither attempted here |

**One related finding surfaced by the map-engine-ratchet run, not part of this delivery flow but
worth flagging while it was in front of me:** the test's own output notes
*"`sokoni-gip-dispatch.markDelivered` sets `otpVerified` from a client argument on
`gipDispatch/{jobId}`. No payout path today — REVIEW during convergence."* A **different** dispatch
system (`gipDispatch`, not `packageRequests`) accepting a client-asserted OTP-verified flag is
exactly the failure shape this whole PIN workstream exists to prevent — not investigated further
here (out of scope, a different collection/flow entirely), flagged for whoever next touches that
system.

---

## "Same authoritative state" — verified, not assumed

Traced what each of the three views actually reads:

| view | reads |
|---|---|
| buyer (`track.html`) | `orders/{orderId}` directly (client SDK) for status/summary; **`getMyDeliveryPin`** (the secure callable, not a direct field read) for the PIN specifically — confirmed using the correct, already-proven-secure pattern |
| seller (`seller-delivery.html`) | `packageRequests` directly (6 call sites) |
| "premium" (`delivery-tracking.html`) | `packageRequests` directly (6 call sites) |

**Two different collections, not one** — but not a divergence in the sense this session has flagged
elsewhere (incompatible schemas, orphaned writers). Every writer traced across both PIN documents
writes `orders` and `packageRequests` **together, in the same transaction or the same operation**:
`claimAvailableDelivery` updates both atomically in one transaction; `pos-marketplace-sync.js`'s
"mark ready" handler writes both in the same handler (not transactional between the two, but
sequential in the same function, best-effort on the second write). So `orders` (buyer-facing
summary) and `packageRequests` (operational/dispatch detail) are two projections kept in sync by
common writers, not two competing sources of truth — **this is a reasonable split, not a defect**,
based on what's been traced. It has not been proven that they can never drift (a write that
succeeds to one and fails to the other was not specifically tested), which is exactly the shape the
negative-control list below should cover once this becomes a certified slice.

Neither `seller-delivery.html` nor `delivery-tracking.html` was found reading `.proofPin` or any
plaintext PIN field directly — both display status/position, never the secret itself.

---

## What full certification would need to check — outlined, not written

Per the requested list, mapped to what would actually prove it (this section is design output, not
executed — per "before changing code, trace and design"):

| requirement | what would prove it |
|---|---|
| order created → appears in tracking | seed an order, confirm `track.html`'s `orders/{id}` read returns it |
| seller marks ready → pool state visible | after `pos-marketplace-sync.js`'s ready handler, confirm `packageRequests/{DEL<id>}.status === 'awaiting_rider'` and that both seller/premium views reflect it |
| rider claims → assigned rider appears | after `claimAvailableDelivery`, confirm `packageRequests.assignedRiderName/Phone` populate and both `seller-delivery.html`/`delivery-tracking.html` render them |
| rider location updates → map follows correct rider/order | requires asserting the map subscribes to `rideDrivers/{riderId}` where `riderId` matches **this** order's `assignedDriverUid` — not just "a" rider |
| handover authorized → pickup PIN stage appears | depends on `sellerAuthorizeHandover` existing first (not yet built, per the companion trace) |
| pickup PIN verified → custody state changes | depends on the custody/`picked_up` state decision (open question, per the companion trace) |
| delivery completed → completion PIN + settlement path | already provable today — `delivery-complete.js` + `onOrderStatusChange`, already traced and already certified in part (`test-delivery-pin-buyer-path.js`, 20/20) |
| **negative controls** — wrong order id / wrong buyer / wrong seller / unassigned rider / stale-or-foreign GPS | none of these currently have a dedicated test found for the tracking *pages* specifically (as opposed to the callables, which are covered — `getMyDeliveryPin` already denies a non-buyer, confirmed earlier this session). The map/GPS-subscription negative case ("a rider's location leaking onto an order they're not assigned to") was not found tested anywhere |

---

## What this audit does NOT do

Does not confirm "premium tracking" is actually `delivery-tracking.html` — flagged as an inference
needing your confirmation. Does not write the certification suite outlined above. Does not resolve
the 29-line r1 drift. Does not touch the `gipDispatch`/`otpVerified` finding. Does not implement
`sellerAuthorizeHandover` or the custody-state decision (both still open, per the companion trace).
Does not touch `C:/temp/sok-r1`.

## Related

`docs/ORDER_PIN_DISPATCH_AUTHORIZATION_TRACE.md` · `docs/SELLER_ACCEPTANCE_PICKUP_PIN_TRACE.md` ·
`scripts/test-map-engine-ratchet.js` (existing, narrow coverage) · ADR-0017 (map/GPS engine
convergence — referenced by the ratchet, not itself audited here)
