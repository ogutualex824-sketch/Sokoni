# RES-1 — The Delivery Quote Is Carried, Not Re-Derived

**Status:** GREEN — 57 assertions, 0 failed, 0 blocked
**Suite:** `scripts/certify-res1-delivery-quote-binding.js`
**Date:** 2026-09-14
**Deployed:** NO. Certification only.
**Related:** [[GATE_C_CHECKOUT_QUOTE_CERTIFICATION]] · [[DELIVERY_STEP4_PRICING_CONVERGENCE]]

---

## Verdict

> Gate C made the **charge** authoritative. RES-1 makes the **rider's side of the same delivery**
> authoritative, by carrying the identical pin from checkout to the dispatch record.
>
> `checkout → session → order → packageRequests → settlement` — one quote, one delivery, one
> settlement.

---

## A correction to the Gate C RES-1 note

The Gate C record said the checkout-created delivery "carries no pinned `deliveryQuote`, so
dispatch settlement refuses it." The conclusion was right; the mechanism named was not, and the
census corrects it:

| Rail | Created by | Read by dispatch? |
|---|---|---|
| `deliveries` | `delivery-hub.js` in the **browser**, post-payment | **No — never** |
| `packageRequests` | `functions/index.js` webhook producer, server-side | **Yes** — every dispatch/settlement call |

So the browser's `deliveries` write is not what settlement refused; it is orphaned from settlement
altogether. The record settlement actually reads is `packageRequests`, and **that** producer was
the defect.

---

## The defect, precisely

The `packageRequests` producer called `_dqa.quote(...)` — a **second** quote, minted at webhook
time, for a delivery the buyer had already been charged for. Two failures in one:

1. **It priced a trip it could not describe.** The webhook has no routing leg
   (`_pm.routeDistanceKm` is undefined), so the authority correctly refused and **every**
   marketplace delivery was created `pricingBlocked` — the rider's record carried no earning at
   all, and settlement had nothing to pay from.
2. **Had it succeeded it would have been the wrong number.** A second derivation of the same job is
   a different figure. The rider would have been paid out of a quote nobody agreed to, and the
   platform's share would not have matched the one the buyer funded.

---

## What changed

| File | Change |
|---|---|
| `functions/delivery-quote-endpoint.js` | `resolveQuoteForCheckout` now also returns `pinned` — the settlement-shaped pin. New `pinnedFromStored`, and **`bindQuoteToOrderTx`** — the consumption writer. |
| `functions/delivery-quote-carry.js` | **new** — `findCarriedPin` / `deliveryPricingForOrder`. The producer's decision, extracted so it can be executed by a test. |
| `functions/index.js` | the session carries the pin; `verifyIntasendPayment` copies it from the **session** onto the order and consumes the quote in the same transaction; the producer calls the carry module instead of minting. The now-dead `_dqa` require is removed. |
| `scripts/test-delivery-quote-authority.js` | M4/M5 re-anchored to follow the chain (see below). |

`functions/dispatch.js` was **not changed** — the census confirmed it already settles via
`assertSettleable(delivery.deliveryQuote)` and does not read `driverNet`. Asserted (`S7-1…S7-3`),
not assumed.

### Why the producer became a module

Its decision is only reachable through a signature-verified IntaSend callback, which no test can
honestly drive. Extracted into `delivery-quote-carry`, it is ordinary code a suite can **execute** —
the difference between certifying that a guard exists and certifying that it runs. The webhook's
control flow is unchanged: it awaits the module and spreads the result exactly as before.

### Single-use is now real

Gate C's `resolveQuoteForCheckout` refuses a quote whose `status !== 'issued'`, and the Gate C suite
proved that check worked — **by writing the state itself.** Nothing in the codebase ever moved a
quote off `issued`, so the guard protected a state that could not occur and one quote could back any
number of orders. The check was certified; the *writer* was never asked for.

`bindQuoteToOrderTx` is that writer. It runs inside the transaction that creates the order — not at
session creation, because an abandoned or retried checkout must not burn the buyer's quote, exactly
as it must not burn their loyalty points. It is idempotent for the same order (a webhook replay is
harmless) and refuses any other.

---

## Coverage

| # | Property | Assertions |
|---|---|---|
| 1 | reachability — the pin really travels | `R1-1…R1-9`, by execution trace, with a control that the trace is not vacuous |
| 2 | **nothing downstream mints another quote** | `M2-1…M2-5` — the carry path issues no new `deliveryQuotes` document |
| 3 | covariance & integrity | `C3-1…C3-5` — every figure identical to the issued quote; a longer trip carries a different earning |
| 4 | tampering | `T4-1…T4-C` — conservation, band, version; each refuses with **no price written alongside** |
| 5 | missing / drifted, fail-closed preserved | `F5-1…F5-C` — no pin, no order, webhook-race fallback to the session, policy drift, policy absent |
| 6 | lifecycle — one quote, one order | `L6-1…L6-8` — consumed on order creation, idempotent for the same order, refused for another, foreign, unknown |
| 7 | settlement reads the pin and nothing else | `S7-1…S7-3` |
| 8 | per-guard sabotage | `X8-1…X8-R` |

### The decisive check

Equality of one figure could be coincidence. `M2-1` counts the `deliveryQuotes` collection across a
carry and requires it **unchanged** — the producer cannot be issuing anything. `C3-5` then moves the
trip and requires the rider's earning to move with it.

### A sabotage that was passing for the wrong reason

`X8-2` originally rebound `dqCarry.findCarriedPin`. `deliveryPricingForOrder` calls it **lexically**,
so the patch never reached the running code and the assertion passed whatever the product did — a
decorative check, which is worse than none. It was replaced with the property that is actually true
and actually checkable: the carry module never calls the quote **issuer** and holds **no money
literal**, so removing the refusal could only crash, never invent a figure (`X8-2a/b/c`).

### A Step 4 assertion that had to follow the code

`test-delivery-quote-authority` M4 asserted `_dqa.loadPolicy(` appears in `index.js`. RES-1 moved
that call one module along, so the assertion would have reported a regression for a change that made
the property stronger. M4/M5 now check the **chain** — index → carry → authority — and a new `M4b`
control proves the chain detector can fail. Neither was weakened, and the Step 4 authority itself was
not touched.

---

## Residual — RES-1b, and the correction to it

> **⚠ THE FINDING BELOW WAS WRONG, AND IS CORRECTED HERE. It is left in place rather than deleted,
> because a retracted finding that quietly disappears teaches nobody anything.**

**What this document originally claimed:**

> *RES-1b — a browser write still moves the SELLER's settlement. `checkout.html` patches
> `orders/{id}.deliveryFee` after payment with `delivery-hub.js`'s browser-computed figure, and
> `order-settlement._grossCents` computes the seller's gross as `total − deliveryFee`. A browser
> number therefore still moves the seller's settlement, in either direction.*

**Why it was wrong.** That was an **inference, not a finding**. A client producer was located
(`checkout.html`) and a server consumer was located (`_grossCents`), and the path between them was
assumed open without checking it. The rules census of 2026-09-14 evaluated the **deployed** ruleset
and found the buyer, seller and rider update branches permit only:

```
buyer   status, cancelReason, updatedAt, review
seller  status, sellerNote, readyAt, trackingNo, updatedAt
rider   status, driverNote, updatedAt, pickedUpAt, etaMin
```

`deliveryFee` is in none of them, and there is exactly one `match /orders/{orderId}` block, so no
second block unions a grant back in. **The browser write was refused every time** — and
`.catch(function(){})` swallowed the refusal, which is why it looked alive for as long as it did.

**The invariant held all along**, enforced at the rules layer rather than by the quote chain.

### What RES-1b actually became

A cleanup gate, closed 2026-09-14, certified by `scripts/certify-res1b-seller-settlement.js`
(29/29):

* the dead client write is **removed** — dead code aimed at a settlement field is a trap waiting for
  somebody to widen an allowlist while fixing something unrelated
* the success overlay now shows the **server-quoted** fee, or nothing at all, instead of
  `delivery-hub.js`'s browser figure on a different rate card
* the protection is **pinned at the live boundary**: the suite fetches the currently-deployed
  ruleset and submits test cases to the Firebase Rules engine, so it proves what production does
  rather than what the worktree's rules say — with a control that inverts one expectation and
  requires the engine to report FAILURE, so a SUCCESS is a real verdict
* the converse is proven too: a legitimate authoritative fee change **does** move the seller's gross

**The lesson worth keeping:** a producer plus a consumer is not a path. The layer in between has to
be checked, and checked where it actually runs.

---

## Running it

```bash
node scripts/certify-res1-delivery-quote-binding.js
```

Exit `0` green, `1` any failure or blocked assertion, `2` crash or watchdog. No credentials, no
network, no emulator.
