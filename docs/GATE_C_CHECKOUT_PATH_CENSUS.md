# Gate C — Checkout Path Census (read-only)

**Status:** CENSUS ONLY — no code changed, no rules changed, nothing deployed
**Step 4:** consumed as a closed authority; **not reopened**
**Date:** 2026-09-14
**Related:** [[DELIVERY_STEP4_PRICING_CONVERGENCE]]
**Closed by:** [[GATE_C_CHECKOUT_QUOTE_CERTIFICATION]] — 113 assertions, GREEN, not deployed

---

## Verdict

> **The browser computes the delivery fee and the server charges it.** The Step 4 quote authority
> is never reached from the checkout path. The only server-side control is a clamp to
> `[0, 5000]` — not a recomputation, not a validation against any authority.

This is the defect Gate C exists to close, confirmed by **reachability**, not inference.

---

## 1. The path, end to end

| Step | Location | What happens |
|---|---|---|
| 1 | `checkout.html:1595` | loads `sokoni-delivery-pricing.js` — the browser pricing engine (`shareTarget 0.82`) |
| 2 | `checkout.html:3733` | `SokoniDeliveryPricing.calculate({ vehicleType, distanceKm, durationMin, weightKg, parcelSize, isRural, timestamp })` |
| 3 | **`checkout.html:3742`** | **`deliveryFee = result.customerPaysFee;`** ← browser number becomes the fee |
| 4 | `checkout.html:1977` | that value lands in a module-scoped `let deliveryFee = 0` |
| 5 | `checkout.html:2123` | `baseTotal = subtotal + deliveryFee + _platformFee - promoSaving` |
| 6 | `checkout.html:2681` | `deliveryFee` is sent to the server in the request payload |
| 7 | **`functions/index.js:2342`** | `const { cartItems, deliveryFee, … } = request.data` ← **server accepts it from the client** |
| 8 | **`functions/index.js:2485`** | `safeDeliveryFee = Math.max(0, Math.min(5000, Math.round(Number(deliveryFee) || 0)))` |
| 9 | `functions/index.js` | `serverTotal = serverSubtotal + safeDeliveryFee` — the amount actually charged |

**Step 8 is the entire server-side defence: a range clamp.** Any value the browser sends between
0 and 5000 is accepted verbatim and charged. Nothing recomputes the fee, and nothing compares it
to an authoritative figure.

---

## 2. The authority is not reachable from here

| Check | Result |
|---|---|
| `checkout.html` references the delivery quote authority | **NO** |
| `createCheckoutSession` calls `_dqa.*` | **NO** |
| a callable exposing a server delivery quote to the browser | **NONE EXISTS** |

`checkout.html` mentions `quoteId` exactly once, and it is a comment stating the current design
intent verbatim:

> *"(Option A — no quoteId coupling, by design). The UI NEVER computes the final …"*

So the absence of coupling is **deliberate in the current design**, not an oversight — which is
precisely what Gate C changes. `createMultiShopCheckoutQuote` exists but prices goods, not
delivery: `multishop-checkout-quote.js` contains no `deliveryFee`, no `vehicleType`, and no
reference to the delivery authority.

---

## 3. Browser-controlled fields that reach the server

From `functions/index.js:2342`:

```js
const { cartItems, deliveryFee, promoCode, redeemLoyalty, fulfillmentType } = request.data || {};
```

* **`deliveryFee`** — the authoritative money field, client-supplied, clamp-only
* `fulfillmentType` — `'pickup'` zeroes the fee client-side (`checkout.html:1996`)
* **`vehicleType`** — chosen in the browser and fed to the client pricing engine. It is **not**
  sent to `createCheckoutSession`, so the server has no vehicle to validate even if it wanted to.
  The Step 4 vehicle-selection authority is therefore also unreached.

---

## 4. A SECOND browser pricing formula

`checkout.html:3759`, the fallback when the pricing engine fails to load:

```js
deliveryFee = Math.round(80 + zone.distanceKm * 15);
```

A third rate table — `KES 80 + 15/km` — invented inline, agreeing with neither
`sokoni-delivery-pricing.js` (0.82 share) nor `delivery-hub.js` (0.88) nor the approved v1 policy.
It activates precisely when script loading fails, so it is the *least* observed path and the most
likely to go unnoticed.

---

## 5. What must NOT be disturbed

The comment at `checkout.html:2694` documents a live money-safety guard that is correct and
directional:

> *"NEVER charge more than we quoted … Guard that one direction only. If the server wants MORE than
> we quoted, reconcile … and require a second, informed tap. The opposite case … charges LESS than
> quoted, harms nobody, and must keep working — a symmetric 'totals must match' check would break
> it."*

A naive "displayed total must equal authoritative total" assertion in Gate C would break this
asymmetry. The requirement is **displayed charge equals the authoritative quote**, with the
existing under-charge tolerance preserved.

Also untouched: promo, loyalty redemption, the platform fee, the Impact contribution, and the
IntaSend/STK rails.

---

## 6. Implementation scope implied (NOT authorised by this census)

1. a **server callable** returning an authoritative quote — none exists today
2. `checkout.html` requests it and **displays** it; the client engine is demoted to an estimate or
   removed from the money path
3. the purchase references **`quoteId` + `pricingVersion`** instead of sending a fee
4. `createCheckoutSession` resolves the pinned quote and **stops accepting `deliveryFee`**
5. the `80 + 15/km` fallback is removed — a fallback price is an invented price
6. `vehicleType` is validated by the selection authority rather than trusted

## 7. Certification this will require

Per the agreed standard — **per-guard sabotage, not happy-path**:

* removing each browser-facing guard produces a **detectable failed case**
* a tampered `deliveryFee`, `vehicleType`, `quoteId` or `pricingVersion` in the client submission
  is **rejected**, proven by execution rather than by the guard's presence in source
* **reachability**: prove the served page actually calls the authority — the failure mode here was
  never a missing guard, it was a path that never called one
* a not-yet-in-force or drifted policy refuses at checkout exactly as it does at settlement
* the under-charge asymmetry at `checkout.html:2694` still works

---

## 8. Step 4 reopening check

**No defect in the Step 4 authority was found by this census.** The authority is sound; it is
simply not called. Nothing here is a Step 4 reopening question.
