# Seller-acceptance / pickup-PIN state-machine trace

**Status:** 📋 READ-ONLY TRACE. No code changed, no deploy, no r1 touch.
**Date:** 2026-09-03 · Extends `docs/ORDER_PIN_DISPATCH_AUTHORIZATION_TRACE.md`.
**Headline: the rider-claim model does not need replacing — but the exact point in today's
timeline where seller control already exists is earlier than, and different from, where the
proposed flow wants a new authorization step. Visibility for the new step already exists; the
action does not. And a secondary, real finding: a vestigial 4-digit `proofPin` field is still
being written today, using the exact name of the field the completion-PIN fix was built to stop
exposing — confirmed not currently exploitable, but worth closing as debt.**

---

## The exact existing chain, traced state by state

```
1. MERCHANT marks a delivery order "ready"
   functions/pos-marketplace-sync.js:240 — action 'pos.dispatch.status', status:'ready'
   THIS is real, existing seller control — but it fires BEFORE any rider exists at all.
        ↓
2. packageRequests/{DEL<orderId>} is CREATED here, status: 'awaiting_rider'
   orders/{orderId}.status -> 'awaiting_rider'
   A 4-digit `proofPin` is generated and written to deliveryPins/{orderId} at THIS point
   (line 248: `String(Math.floor(1000 + Math.random() * 9000))`) — see the finding below.
        ↓
3. RIDER claims from the pool — functions/index.js:7472, claimAvailableDelivery
   Backend-enforced: rider must be an approved, non-suspended rideDrivers record (checked
   server-side, "never trust the UI" per its own comment). First-claim-wins, inside a
   transaction (packageRequests read+write serialised on the same document).
        ↓
4. ASSIGNMENT is written, atomically, same transaction:
   packageRequests: status -> 'driver_accepted', assignedRiderId/riderId/assignedDriverId/
                    assignedDriverUid all set, riderName, riderPhone stamped
   orders:          status -> 'rider_assigned', assignedDriverUid set
        ↓
5. SELLER VISIBILITY — already exists, confirmed live
   seller-delivery.html:395-413 already renders assignedRiderName/riderPhone, distance, ETA,
   and a live GPS mini-map (subscribed to rideDrivers/{riderId}) the MOMENT a rider is
   assigned. Linked from real seller navigation (sokoni-nav-engine.js:121).
        ↓
6. SELLER ACCEPTANCE / AUTHORIZATION — does not exist
   The only actions on that same card today (line 414-417) are "Track Live" and
   "Report Issue". No authorize/approve/confirm-handover action exists anywhere in this
   file or any other seller-facing surface searched.
        ↓
7. PICKUP PIN generation/reveal for THIS purpose — does not exist
   functions/delivery-pin.js (Phase 0) issues its 6-digit PIN on the driver_accepted
   transition itself (step 4 above) — i.e., automatically, the instant a rider claims,
   with no seller gate in between. Its own comment already names the target design
   ("Two-PIN stage... until distinct pickup/delivery codes land at cutover") but the
   pickup stage is not gated on anything seller-controlled today — it's shadow-only,
   fired by the rider's own claim.
        ↓
8. RIDER pickup verification — does not exist as an enforcing check
   deliveryVerifyShadow (Phase 0) accepts stage:'pickup' and records wouldAllow, but this is
   shadow telemetry only — nothing currently blocks a rider from proceeding without it.
        ↓
9. Custody state — does not exist as a distinct order/packageRequest status
   Nothing between 'driver_accepted'/'rider_assigned' and 'delivered' was found. There is no
   "picked_up"/"in_custody" status this session located as a real write target (see also
   DELIVERABLE_FROM in delivery-complete.js, which lists 'rider_assigned', 'picked_up',
   'in_transit' etc. as ACCEPTED completion-precondition states — but nothing in this
   codebase was found to actually WRITE 'picked_up' today; it's accepted as valid input to
   completion, not produced by any traced writer).
        ↓
10. EXISTING delivery completion — Phase 1, live, unchanged by anything here
    functions/delivery-complete.js — completeDeliveryWithPin / buyerConfirmDelivery, already
    fully traced in the companion document. Not touched by this trace.
        ↓
11. EXISTING settlement — onOrderStatusChange, already fully traced, unchanged.
```

---

## Where seller acceptance can be added, without replacing the rider-claim model

**The claim model (steps 1-4) is untouched by every option below** — this section is entirely
about inserting a gate *after* step 5 (seller visibility, already live) and *before* today's
automatic PIN issuance (step 7), not about who gets to claim a delivery.

**The recommended shape, evidenced by what already exists:**
- Add ONE new backend callable — call it, provisionally, `sellerAuthorizeHandover` — following
  `delivery-complete.js`'s exact proven pattern (assignment/ownership check before anything else,
  transactional, audit-logged), callable only by the **seller who owns the order** (checked against
  `order.sellerId`/`sellerUid`, mirroring how `delivery-complete.js` checks the buyer/rider).
- Add ONE new button to the existing `seller-delivery.html` rider card (next to "Track Live" /
  "Report Issue") — the visibility it needs (rider name, phone, live position) is already rendered
  on that exact card today.
- **Move Phase 0's pickup-PIN issuance from "fires automatically on `driver_accepted`" to "fires
  when `sellerAuthorizeHandover` succeeds."** This is the one real change to `delivery-pin.js`'s
  existing trigger semantics this trace surfaces — currently `deliveryPinOnAccept` listens for the
  `driver_accepted` transition directly; the pickup PIN would instead need to wait for a seller
  action that happens *after* that transition, which likely means either gating inside the new
  callable directly (recommended — keeps the trigger surface simpler) rather than adding a second
  Firestore-trigger hop.
- Keep the delivery-stage completion PIN (`delivery-complete.js`) **completely untouched** — this
  was already the plan in your message and nothing found here argues against it.

## A finding worth closing before or alongside this work — not a blocker, checked not assumed

`pos-marketplace-sync.js:270-273` still writes a **4-digit, unhashed `proofPin`** to
`deliveryPins/{orderId}` at "mark ready" time (step 2 above) — using the exact field name
`delivery-complete.js`'s own header identifies as the closed vulnerability ("driver.html compared
the typed PIN to `data.proofPin`"). Checked whether this is currently exploitable, not assumed
either way:

- `deliveryPins` has no Firestore rule (deny-by-default) — confirmed earlier this session — so no
  client, including the assigned rider, can read this document directly regardless of which fields
  it holds.
- `scripts/test-delivery-pin-unreachable.js` — **run this pass, 65/0 passing** — confirms
  `driver.html` renders no PIN from any payload and the old client-side comparison is gone.
- No currently-enforcing function (`completeDeliveryWithPin`, `deliveryVerifyShadow`) reads
  `.proofPin` for authorization anywhere — only `onOrderStatusChange`'s SMS-notification code reads
  it, and only as a fallback for messaging, never as an authority check
  (`_ps.data().pin || _ps.data().proofPin || null`).

**Conclusion: not currently exploitable, but genuinely stale** — a second, weaker (4-digit,
plaintext-generated) PIN is still being minted for every ready delivery order, unused by anything
that matters, alongside the real 6-digit HMAC one Phase 0 issues moments later on claim. Worth
removing as part of whichever slice touches this area next, since it's exactly the kind of
"producer with no legitimate consumer" shape this session has flagged as a recurring pattern
elsewhere (QR routes, `createPurchaseOrder`, `posProducts` writers).

## What this trace does NOT do

Does not implement `sellerAuthorizeHandover` or any UI. Does not decide the exact new order/
packageRequest status name for "custody transferred" (a real open question — nothing currently
writes `picked_up` despite it being accepted as valid completion-precondition input). Does not
remove the vestigial `proofPin` write. Does not touch `C:/temp/sok-r1`.

## Related

`docs/ORDER_PIN_DISPATCH_AUTHORIZATION_TRACE.md` (the companion trace this extends) ·
`functions/delivery-complete.js` (the pattern to reuse) · `functions/delivery-pin.js` (the trigger
whose timing this proposes changing) · `functions/pos-marketplace-sync.js` (origin of both the
`awaiting_rider` pool entry and the stale `proofPin` finding) · `seller-delivery.html` (existing
rider visibility, no existing authorization action)
