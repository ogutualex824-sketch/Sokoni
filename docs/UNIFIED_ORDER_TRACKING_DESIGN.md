# Unified order tracking / map — field trace + design

**Status:** read/design-first, per instruction — trace done before any page was touched; this
document also records the resulting minimal implementation once the trace showed what was actually
needed. No deploy. No r1 touch.
**Date:** 2026-09-03 · Extends `docs/TRACKING_EXPERIENCE_AUDIT.md`,
`docs/SELLER_DELIVERY_UI_INTEGRATION.md`.

**Headline, found before designing anything: the authoritative, order-centric tracking projection
the user asked for already exists.** It was designed once, correctly, inside
`delivery-tracking.html`/`sokoni-delivery.js`, under the name "ONE LOCATION TRUTH." It is not
consumed by all three roles, and — the real gap — it is barely *produced* by the rider's actual
app. This slice converges the missing consumer and adds the missing producer; it does not invent a
new projection.

---

## Field trace — what's actually written where, checked by reading writers not readers

### `packageRequests/{pkgId}` — the shared delivery record

| field(s) | written by | meaning |
|---|---|---|
| `orderId` | `pos-marketplace-sync.js` (creation) | the order this delivery belongs to |
| `sellerUid` | creation | seller identity |
| `assignedDriverUid` / `riderId` / `assignedRiderId` | `claimAvailableDelivery` (index.js:7472) | rider identity — three spellings, all read by `delivery-authority.js`'s `RIDER_FIELDS` |
| `status` | many (creation=`awaiting_rider`, claim=`driver_accepted`, `completePickupWithPin`=`picked_up`, `completeDeliveryWithPin`=`delivered`, `driver.html`/`sokoni-delivery.js` client writes=`driver_at_seller`/`in_transit`) | delivery-stage status — **six spellings across the codebase**, reconciled for canonical ordering by `fulfilment-lifecycle.js`, not by this collection itself |
| `driverLat` / `driverLng` | **intended:** any rider client, via `SokoniDelivery.updateDriverPosition()`. **actual, before this slice:** only `delivery-tracking.html`'s own `_startRiderPush` (15s interval, only while a rider has that page open with `role==='rider'`) | live rider position — see "ONE LOCATION TRUTH" below |
| `driverLocUpdatedAt` | same as above | ISO-string freshness timestamp for the position |
| `pickupCoords` / `sellerCoords` | creation (from the seller's registered location) | origin |
| `deliveryCoords` / `dropoffCoords` / `buyerCoords` | creation (from the order's delivery address) | destination |
| `handoverAuthorizedAt` / `handoverAuthorizedBy` | `sellerAuthorizeHandover` (prior slice) | custody-authorization fact |
| `pickupPinHash` / `deliveryPinHash` | `sellerAuthorizeHandover` / `deliveryPinOnAccept` | the two independent PIN stages (prior slices) |
| `deliveryFee`, `vehicleType`, `deliveryAddress`, `buyerName`, `buyerPhone` | creation | display fields, unrelated to tracking mechanics |

### `orders/{orderId}`

| field(s) | written by | meaning |
|---|---|---|
| `sellerUid`/`sellerId`/`vendorId`, `buyerUid`/`userId`/`uid`, `assignedDriverUid`/`riderId` | various, already fully traced in the PIN-workstream docs | party identity |
| `status`, `deliveryStatus`, `timelineStage` | multiple writers, by design disagree — `fulfilment-lifecycle.js`'s `resolveStage()` already exists specifically to reconcile these three by taking whichever is furthest along | delivery-stage status, order-side |
| `deliveryRef` | creation | the linked `packageRequests` doc id — this is the join key between the two collections |
| `handoverAuthorizedAt`/`By`, `pickedUpAt`, `deliveredAt` | mirrored from the callables (prior slices) | mirrors, for pages that read `orders` directly (`track.html`) |

### `rideDrivers/{riderId}` — a DIFFERENT, rider-scoped collection, not order-scoped

| field(s) | written by | meaning |
|---|---|---|
| `lat`/`lng` (NOT `driverLat`/`driverLng` — different field names, different collection) | `SokoniDB.setDriverOnline()` — driver.html's shift-online toggle and its `startGPSTracking` throttled watch callback | the rider's CURRENT position, independent of any specific delivery — feeds `dispatch.js`'s rider-matching and fleet/admin views |
| `isOnline`, `status`, `vehicleType` | same | fleet availability, not delivery state |

**`rideDrivers` is legitimately a different concern** — dispatch-time rider availability and fleet
monitoring, not per-order tracking. It correctly has restrictive rules (rider/admin-readable, not
buyer-readable) because a buyer has no business seeing every online rider's live position, only the
one assigned to their order. The defect is not that `rideDrivers` exists — it's that
`seller-delivery.html` reads *this* collection for its per-order mini-map instead of the per-order
mirror meant for exactly this purpose (below).

---

## "ONE LOCATION TRUTH" — already designed, credited not reinvented

`delivery-tracking.html` (lines 716-735) already states the exact invariant this slice was asked to
establish, verbatim in its own header comment:

> *"the rider's position that the buyer sees is the driverLat/driverLng mirror on the canonical
> delivery record (packageRequests/deliveries). The buyer is already authorised to read that
> document and already receives it over the existing onSnapshot, so no new collection, no new
> listener and no relaxed read rule is involved."*

And `sokoni-delivery.js`'s `updateDriverPosition()` (the function that performs the mirror write)
states the same reasoning independently: the dedicated GPS collections
(`driverLocations`/`deliveryLocations`) have rules that only admit the rider/admin/a `viewers` array
nothing ever populates, so a buyer's subscription to them always failed silently. Mirroring the
position onto the document the buyer is *already* authorized to read and *already* subscribed to
was the fix — no new collection, no rules change.

**This is precisely the design the current request asks for.** The work here is convergence, not
invention.

## The two real gaps, traced not assumed

1. **The producer gap.** `driver.html` — the rider's actual, primary app, containing the
   claim/pickup/complete flow this session already built — **never calls
   `SokoniDelivery.updateDriverPosition()` or writes `driverLat`/`driverLng` at all** (checked: zero
   matches in the file, and `sokoni-delivery.js` isn't even loaded there). The only writer of the
   canonical mirror is `delivery-tracking.html`'s own rider-side push, which only runs if a rider
   happens to have that specific page open with `role==='rider'` — not the normal flow. In practice
   the "ONE LOCATION TRUTH" mirror is close to unfed.
2. **The consumer gap.** `seller-delivery.html`'s mini-map subscribes to `rideDrivers/{riderId}`
   directly (a per-rider, not per-order, collection) instead of reading the `driverLat`/`driverLng`
   mirror already present on every `packageRequests` snapshot it already holds. This is the exact
   "duplicated seller-specific tracking record" risk flagged — a second, independent read path that
   can show a different position than the buyer's map for the same order (different rider-location
   collection entirely, no relationship enforced between them beyond both eventually being written
   by the same physical device).

`track.html` was also checked: it currently renders no live map at all (zero references to
`driverLat`, `packageRequests`, or `SokoniTracking`). Whether `track.html` or `delivery-tracking.html`
is "the" buyer tracking destination remains the open identity question already flagged in
`docs/TRACKING_EXPERIENCE_AUDIT.md` — out of scope to resolve here. Since `delivery-tracking.html`
is the stronger-evidence candidate and already correctly consumes the canonical mirror, the buyer
leg of "same coordinates" is judged adequately served once the producer gap (①) is closed; building
a live map onto `track.html` from scratch is a separate, larger undertaking, not attempted in this
slice.

---

## What this slice implements — the minimal convergence, not a new system

**`driver.html`** — the existing throttled GPS watch (`SokoniDB.startGPSTracking`'s `onUpdate`
callback, already firing at most once per 5s, already the one loop `_drvGpsActive` guards against
duplication) gains one additional, additive write: when the rider has an active delivery
(`_drvActiveDeliveryRef`, set/cleared alongside the existing `_showDrvDelivery`/`_clearDrvDelivery`
lifecycle), it also writes `driverLat`/`driverLng`/`driverLocUpdatedAt` onto that delivery's
`packageRequests` document — same field names, same shape `sokoni-delivery.js`'s
`updateDriverPosition()` already writes, so every existing consumer of the mirror (`delivery-tracking.html`)
needs no change at all. **No new geolocation watcher, no new interval** — this rides the one GPS loop
that already exists, per the ADR-0017 "no competing map/GPS engine" discipline this codebase already
enforces (`scripts/test-map-engine-ratchet.js`). The existing `rideDrivers` write in the same
callback is untouched — dispatch/fleet views still get exactly what they got before.

**`seller-delivery.html`** — `_initMiniMap(d)` no longer opens a second, per-card `rideDrivers`
Firestore listener. It reads `d.driverLat`/`d.driverLng` directly off the `packageRequests` snapshot
item that `_renderActive()` already has (the same live listener that drives the card's status badge
and rider name) — the same field, same source, same event stream `delivery-tracking.html`'s buyer
map reads. **This is the strongest form of the "same coordinates" invariant available**: there is no
longer a second async subscription that could ever show a different number — seller and buyer read
the identical document field from the identical write. A missing/absent position (rider hasn't
pushed yet) renders an explicit "Waiting for rider location…" placeholder rather than a blank map or
stale marker.

## What this slice deliberately does not do

Does not touch `rideDrivers`, `dispatch.js`, or any fleet/admin-facing consumer of it — that
collection's purpose and rules are correct as they are. Does not build a live map onto `track.html`
— flagged as a separate, larger, unresolved item (see "the open identity question" above). Does not
touch `firestore.rules` — both `driver.html` and `delivery-tracking.html` write `packageRequests` as
the assigned rider, already permitted by the existing rule (the SAME rule this session's
`SELLER_DELIVERY_UI_INTEGRATION.md` flagged as *also* permitting the unverified
`driver_at_seller`/`in_transit` self-declare writes — that finding is unchanged and still queued
separately; this slice adds a position write under the *same* existing permission, not a new one).
Does not touch `functions/seller-handover.js`, `functions/delivery-pin.js`, or any backend from the
prior slices. Does not deploy. Does not touch `C:/temp/sok-r1`.

## Related

`docs/TRACKING_EXPERIENCE_AUDIT.md` (the premium-tracking-identity question this slice does not
resolve) · `docs/SELLER_DELIVERY_UI_INTEGRATION.md` (the `sokoni-delivery.js`/`driver.html`
client-write authority finding, unchanged) · `sokoni-delivery.js` (`updateDriverPosition` — the
already-correct helper whose field shape this slice mirrors in `driver.html` directly, since that
module isn't loaded there) · `functions/fulfilment-lifecycle.js` (status reconciliation, unchanged)
