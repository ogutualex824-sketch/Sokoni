# Gate C — Checkout Consumes the Authoritative Server Quote

**Status:** GREEN — 113 assertions, 0 failed, 0 blocked
**Suite:** `scripts/certify-gate-c-checkout-quote.js`
**Date:** 2026-09-14
**Deployed:** NO. Certification only; deployment is a separate decision that has not been taken.
**Related:** [[GATE_C_CHECKOUT_PATH_CENSUS]] · [[DELIVERY_STEP4_PRICING_CONVERGENCE]] · [[DELIVERY_RAIL_CONVERGENCE]]

---

## What changed

The census proved the browser computed the delivery fee and the server charged it, behind nothing
but `clamp(0…5000)`. Gate C gives the browser a way to **ask** and takes away its ability to
**tell**.

| Layer | Before | After |
|---|---|---|
| price origin | `sokoni-delivery-pricing.js` in the browser (share 0.82) | `requestDeliveryQuote` → Step 4 authority |
| what the purchase carries | `deliveryFee` (a number) | `deliveryQuoteId` (an id) |
| server defence | a range clamp | resolve the **stored** quote, revalidate, refuse |
| fallback when scripts fail | `80 + 15/km`, a third rate card | none — a fallback price is an invented price |
| vehicle | chosen in a `<select>`, fed to the client pricer | chosen by the selection authority, displayed |

### Files

| File | Role |
|---|---|
| `functions/delivery-quote-endpoint.js` | **new** — `requestDeliveryQuote` callable; persists to `deliveryQuotes/{id}`; `resolveQuoteForCheckout`; `assertNoCheckoutPricing` |
| `functions/index.js` | `createCheckoutSession` destructures `deliveryQuoteId` (not `deliveryFee`), refuses pricing fields, resolves the stored quote; `requestDeliveryQuote` exported |
| `checkout.html` | requests the server quote, sends the id, displays the chosen vehicle; client pricer, its script tag and the fallback removed |
| `scripts/certify-gate-c-checkout-quote.js` | **new** — the certification suite |

No change to `functions/delivery-quote-authority.js`, `functions/vehicle-selection-authority.js`,
`platformConfig/deliveryPricing`, or any payment rail. **Step 4 was not reopened.**

---

## Why the quote is persisted

A returned-but-unstored quote cannot be verified later: a forged `quoteId` would be
indistinguishable from a real one, and checkout would be trusting the client again by a longer
route. Every issued quote is written server-side and checkout resolves the **stored** figures.

It is bound to the buyer and single-use, because a quote is an offer to one account for one order —
without binding, a cheap quote could be harvested and replayed against a dearer cart.

---

## How this suite avoids the trap it exists to close

The failure the census found was **not a missing guard**. `delivery-quote-authority.js`,
`assertNoClientPricing` and the vehicle authority all existed while the browser was setting the
price. A suite asserting their *existence* would have passed against the defective code.

So the suite **loads the real `functions/index.js` and executes the real handlers.**
`admin.firestore()` is replaced — before that load — with an in-memory store that records every
path it is asked for. Reachability is then a fact about an execution trace, not an inference:

```
R1-6  CHECKOUT READ THE STORED QUOTE — the execution trace proves the path reaches the authority
```

Two details that would otherwise have made the instrument lie:

* `admin.firestore` is a **getter on the prototype**. Plain assignment throws in strict mode and
  fails **silently** in sloppy mode — a stub can look installed while every call goes to the real
  backend. It is installed with `defineProperty` and then *proved* to have taken effect before
  anything is loaded.
* Every source assertion runs on **comment-stripped** text. The Gate C comments quote the very
  patterns being searched for, so an unstripped check would match its own documentation (`B7-8`
  is the control for exactly this).

---

## Coverage

| # | Required property | Assertions |
|---|---|---|
| 1 | normal checkout reaches the server authority | `R1-1…R1-8` — by execution trace, with a control that the trace is not vacuous |
| 2 | the authoritative quote determines the charge | `Q2-1…Q2-9` — including **covariance**: move the stored figure and the charge moves by exactly the same amount |
| 3 | a forged browser `deliveryFee` is rejected | `P3-1…P3-C` — all 9 forbidden fields, individually; plus a control that the same payload without them succeeds |
| 4 | a forged `quoteId` is rejected | `K4-1…K4-C` — unknown, absent, non-string, another buyer's, already used, expired |
| 5 | a stale/wrong `pricingVersion` is rejected | `V5-1…V5-C` — plus policy revision, not-yet-in-force, and policy absent |
| 6 | a forged vehicle cannot bypass suitability | `W6-0…W6-11` — smallest-suitable checked against an **independently computed** expectation |
| 7 | the old fallback is unreachable/removed | `B7-1…B7-8` |
| 8 | the under-charge path still works | `U9-0…U9-6` — the live guard expression is *extracted from source and evaluated* |
| 9 | removing each guard produces a detectable failure | `X10-1…X10-R` |
| 10 | reachability, not existence | see above, and `X10-7` |

### The under-charge tolerance

The guard at `checkout.html` is one-directional by design and must stay that way:

```js
if (stkAmount > _quoted + 1) { /* stop, reconcile, require a second informed tap */ }
```

The suite does not re-type that condition — it extracts it from the file and evaluates it over a
matrix. Over-charge stops; equal, one-shilling rounding, and any under-charge proceed. `X10-9`
replaces it with a symmetric `stkAmount !== _quoted` and proves the legitimate under-charge then
breaks — which is why the naive "displayed total equals authoritative total" invariant was not
used.

### Sabotage

Server guards are neutralised **on the live call path** (the call sites are property lookups, so
rebinding the export sabotages the running code), the hostile input is replayed, and the guard is
only credited if the input now gets through. Browser guards are sabotaged as **text**, re-run
through the same detector functions the live assertions used.

Nothing is ever written to disk, so a killed run cannot strand a mutation for the next suite to
adopt as its baseline. `X10-R` re-proves every guard after restoration.

`X10-7` is the one worth reading: restoring the client pricing engine inside `calcDelivery` left
`requestDeliveryQuote` in the file, so an existence check stayed green. The detector was replaced
with a reachability chain — the helper wraps the callable, `calcDelivery` calls the helper, the
inputs call `calcDelivery`.

---

## Defect found by the suite, and fixed

**The default checkout would have been refused.** `checkout.html` sent the `<select>` value
(default `moto`). The selection authority picks the smallest class that fits and refuses anything
larger — a 1 kg parcel selects `ebike`, so a requested `motorcycle` returned
`requested_vehicle_oversized`. Every option in that list except one refused, and the buyer had no
way to know which.

Relaxing the authority was not an option — it is approved Step 4 work, and refusing an
unnecessarily large class is precisely what stops a customer buying van economics for a letter.
The fix is on the browser: **the page no longer asserts a vehicle class.** It describes the
shipment, the authority chooses, and the chosen class and its stated reason are displayed
read-only.

This is the value of running the legitimate path: a hostile-only suite would have been green while
no real customer could check out.

---

## Residuals — proven, deliberately NOT changed under this gate

**RES-1 — the post-payment delivery-hub rail still writes its own fee.**
`checkout.html` calls `SokoniDelivery.createOrderDelivery()` *after* payment and patches
`orders/{id}.deliveryFee` with `delivery-hub.js`'s browser-computed figure (`DRIVER_SHARE 0.88`).

* It does **not** affect what the buyer is charged — that is now the server quote.
* It **does** leave a non-authoritative fee on the order record and on the created delivery.
* The delivery is created with **no pinned `deliveryQuote`**, so `dispatch.js` settlement refuses
  it. Fail-closed, not mispaid — but the rider cannot be settled for it either.

Binding the created delivery to the quote is its own gate and has not been opened.

**RES-2 — the Parcel Size control is inert.** `deliverySize` is not sent to the quote request.
Dimensions would refuse anyway (`vehicle_selection_insufficient_data`) because SOKONI has not yet
declared volume capacities — the held item from Step 4. Left as-is.

---

## Running it

```bash
node scripts/certify-gate-c-checkout-quote.js
```

Exit `0` green, `1` any failure or blocked assertion, `2` crash or watchdog. No credentials, no
network, no emulator — and nothing it does can deploy anything.
