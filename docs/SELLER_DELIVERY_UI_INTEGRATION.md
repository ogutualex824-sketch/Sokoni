# Seller handover / pickup-PIN — UI integration (seller-delivery.html + driver.html)

**Status:** designed against the existing tracking surfaces (not a new interface), implemented,
certified. No deploy. No r1 touch.
**Date:** 2026-09-03 · Closes the user-facing half of
`docs/SELLER_AUTHORIZE_HANDOVER_DESIGN.md`.

---

## Why these two files, not a new page

Per instruction, this integrates into the existing tracking experience rather than creating another
delivery interface. `seller-delivery.html` already renders the assigned-rider card
(`docs/TRACKING_EXPERIENCE_AUDIT.md`, `docs/SELLER_ACCEPTANCE_PICKUP_PIN_TRACE.md`) — the seller
side lands there. The rider side does **not** belong on `delivery-tracking.html`: tracing where the
already-live, already-certified delivery-completion PIN is actually entered found it is
`driver.html`'s `_drvCompleteDelivery`, not the tracking page — `completeDeliveryWithPin` has zero
call sites in `delivery-tracking.html`. The new pickup-PIN entry follows the same, already-correct
precedent, in the same file, next to it.

## seller-delivery.html — Authorize Handover / Show Pickup PIN

Added to `_buildCard(d)`: once a rider is assigned and the delivery hasn't already passed pickup,
show **Authorize Handover** (calls `sellerAuthorizeHandover`) if `handoverAuthorizedAt` is absent
from the snapshot, or **Show Pickup PIN** (calls `getMyPickupPin` on demand — the plaintext isn't in
the snapshot, by design) once it's present. The card doesn't need to be patched by hand after
authorizing: `_loadActive`'s live `onSnapshot` listener already re-renders every card on any
`packageRequests` change, so `handoverAuthorizedAt` appearing flips the button state automatically.

**Real bug found and fixed in the same file, not a new one introduced by this slice:**
`_loadActive`'s status filter (`where('status','in',[...])`) never included `picked_up`. The moment
a rider completed `completePickupWithPin`, the delivery would have silently vanished from the
seller's Active tab — exactly the failure class `fulfilment-lifecycle.js`'s own header describes
(a status the reader doesn't recognize is treated as absent, not as `unknown`-but-still-there).
Added `picked_up` to the filter and to the `badgeCls`/`statusLabel` maps. Confirms, again, that
reusing the canonical `picked_up` value (rather than inventing a new one) was the right call — both
`track.html` and `delivery-tracking.html` were independently found to already have `picked_up`
label/timeline entries waiting for a real writer (see the tracking audit) before this slice existed.

## driver.html — pickup-PIN entry replaces the old self-declare button

`_deliveryActionBtns(req)`'s `driver_accepted` branch used to render a single-tap **"I'm at the
Seller"** button that wrote `packageRequests.status = 'driver_at_seller'` directly from the client
(`_drvUpdateDelivery`) — no PIN, no seller gate, exactly the trust shape this whole feature exists
to close. That branch is now:

- **no `handoverAuthorizedAt` yet** → a disabled waiting message, not a button. The same live
  listener (`listenDriverDeliveryRequests`) that already re-renders this card on every
  `packageRequests` change means the rider's screen updates on its own the moment the seller
  authorizes — no polling added.
- **`handoverAuthorizedAt` present** → a PIN input + **Confirm Pickup**, wired to a new
  `window._drvCompletePickup`, calling `completePickupWithPin` — mirrors `_drvCompleteDelivery`'s
  exact shape (validate format client-side, call the server, surface the server's own error message
  on failure, never fall back to a direct write). Touches no earnings/trip-count state — pickup is
  a custody event, not a payout one, and the certification below asserts that directly.

`driver_at_seller`/`picked_up` both still get a plain **Start Delivery** button
(`_drvUpdateDelivery(dRef,'in_transit')`, unverified) — left alone deliberately. That transition is
logistics-only (advisory, matches how `arriving`/`halfway` sub-states are already treated elsewhere
in this codebase) — custody itself was already proven by the pickup PIN before this point, so
gating it too would add friction without adding security.

**A second, pre-existing, adjacent bug fixed opportunistically:** the delivery-completion PIN input
(`in_transit` branch, feeding `completeDeliveryWithPin`) had `maxlength="4"` — but the real,
enforced PIN is 6 digits (`_gen6()`, `deliveryPinVersion:6`, unchanged since this session's earlier
work). A rider physically could not type the 6th digit. Fixed to `maxlength="6"` alongside adding
the same-length pickup-PIN input, since both now sit in the same function and the mismatch would
otherwise ship inconsistently. This is a **live, degrading, pre-existing UI defect**, not something
introduced by this slice — flagged clearly here rather than silently folded into "UI polish."

---

## A separate, real finding this trace surfaced — NOT fixed here, logged per instruction

Tracing `driver.html`'s existing `_drvUpdateDelivery` pattern surfaced a second, independent
occurrence of it: `sokoni-delivery.js`, a **client-side SDK module loaded by `checkout.html`,
`seller.html`, AND `delivery-tracking.html`** (all real, linked, production pages) that exposes
`driverAcceptDelivery`/`driverArrivedAtSeller`/`driverPickedUp`/`driverDelivered` — each a **direct,
unauthenticated-by-PIN Firestore client write** to `packageRequests.status`. Checked, not assumed:

- `firestore.rules` (`packageRequests` match block, `allow update`) **currently permits** the
  assigned driver to write `status` (among a few other keys) directly — confirmed by reading the
  rule, not inferred from the client code alone.
- `driverAcceptDelivery`/`driverArrivedAtSeller`/`driverPickedUp` **are actually called**, from
  `delivery-tracking.html` (lines ~1272/1290/1300) — real, live call sites, not orphaned exports.
  `driverDelivered` (the one that also sets `payoutDue:true`) has **no call site anywhere** — dead
  code, per this session's now-familiar "producer with no consumer" pattern.
- **Does not release money.** No Firestore trigger is bound to `packageRequests` writes for these
  transitions (only `deliveryPinOnAccept`, keyed specifically to the `driver_accepted` transition,
  confirmed earlier this session) and `orders.status` — the only field `onOrderStatusChange`'s
  payout logic watches — is untouched by this path. So this is a **custody/display-integrity gap**
  (a rider can fake "arrived"/"picked up" on `packageRequests`-based tracking views without any
  verification), not a **financial** one — the money-releasing transition remains correctly closed
  to the client, exactly as `delivery-complete.js`'s header already documents.

This slice does **not** touch `sokoni-delivery.js`, `delivery-tracking.html`'s three call sites, or
`firestore.rules`. It only stops `driver.html`'s own dashboard from offering the equivalent
unverified button for the pickup transition, replacing it with the gated flow. The underlying
permission and the parallel path through `delivery-tracking.html` remain live. This is the same
category of gap as the already-logged `proofPin` finding — **queue it alongside that cleanup**, not
as part of this slice; do not let it block or expand the current one, per standing instruction to
keep discoveries separate.

---

## Certification

`scripts/test-seller-handover-ui.js` — new, **20/20**, static (comment-stripped source assertions,
same convention as `scripts/test-convertprtopo-fix.js`): the active-list query and label maps
include `picked_up`; `_buildCard` branches correctly on `handoverAuthorizedAt`; both new callables
are actually invoked from the right handlers with real error handling; the old unverified
"I'm at the Seller" self-declare call is confirmed **gone** from the `driver_accepted` branch
specifically (isolated from the still-legitimate `driver_at_seller`/`picked_up` branch, which
correctly keeps calling `_drvUpdateDelivery` for the non-custody `in_transit` step); the 6-digit
`maxlength` fix is present and no `maxlength="4"` remains; `_drvCompletePickup` touches no
earnings/trip-count state; neither file references `proofPin`.

Both pages headless-browser-loaded against a local static server (matching the pattern already used
for the premium-messaging client transplant this session): **0 console errors** on
`seller-delivery.html` (auth-gated, as expected) and `driver.html` (correctly redirects to the login
gate when unauthenticated; the reported failed sub-requests are pre-existing CDN/local-server
artifacts of the unauthenticated load, not new errors — confirmed the referenced local files exist
in the repo).

Not certified: a real, signed-in, end-to-end run (seller authorizes → PIN shown → rider enters it →
card flips to Start Delivery) — that requires either the Firestore emulator (unavailable in this
environment, same limitation noted for `test-delivery-authorization.js`/`test-delivery-sequence.js`)
or real production credentials. Static + isolated-unit certification is what's available here; say
so rather than claim more.

## What this slice does NOT do

Does not touch `sokoni-delivery.js`, `delivery-tracking.html`, or `firestore.rules` — the
client-writable custody-status finding above is logged, not fixed. Does not retire `proofPin` (still
queued separately). Does not modify `functions/seller-handover.js` or any other backend file from
the prior slice. Does not deploy. Does not touch `C:/temp/sok-r1`.

## Related

`docs/SELLER_AUTHORIZE_HANDOVER_DESIGN.md` · `docs/TRACKING_EXPERIENCE_AUDIT.md` ·
`docs/SELLER_ACCEPTANCE_PICKUP_PIN_TRACE.md` · `functions/seller-handover.js` (the backend this
wires to, untouched) · `sokoni-delivery.js` / `delivery-tracking.html` (the separate, logged,
unfixed finding)
