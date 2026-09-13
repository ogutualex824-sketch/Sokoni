# Step 4 — Delivery Pricing Convergence

**Status:** CENSUS ONLY — no pricing edited, no formula changed, nothing deployed
**Verdict:** 🔴 **RED** — conflicting authoritative money rails exist, and the one that priced
production runs in the browser
**Date:** 2026-09-13
**Related:** [[DELIVERY_RAIL_CONVERGENCE]] · [[DELIVERY_STEP2_IDENTITY_RECONCILIATION]]

---

## 1. Three pricing authorities, three different answers

| # | Source | Runs | Rider share | Vehicle rates |
|---|---|---|---|---|
| 1 | `sokoni-delivery-pricing.js` v2.0 | **BROWSER ONLY** | `shareTarget: 0.82` | moto 100+18/km · car 220+38/km · van 450+58/km · truck 800+85/km |
| 2 | `delivery-hub.js` | **BROWSER ONLY** | `DRIVER_SHARE 0.88` | boda 150+35/km · car 400+60/km · van 2500+110/km · truck 5000+150/km |
| 3 | `index.js:8562` webhook | server | `driverNet = fee × 0.8` | **no table — fee is a residual** |

The same vehicle class is priced differently by #1 and #2 — a van is **450 + 58/km** in one and
**2500 + 110/km** in the other, a 5.5× difference in base fare. Rider share is **82% / 88% / 80%**
depending on which path ran.

---

## 2. Which authority actually priced production — measured, not assumed

Of 13 `packageRequests`, **5 carry a real fee** and 8 carry `deliveryFee: 0`.

```
fee=220  driverNet=180  ratio 0.8181  riderSharePct=82   source=undefined
fee=237  driverNet=194  ratio 0.8186  riderSharePct=82   source=undefined
fee=237  driverNet=194  ratio 0.8186  riderSharePct=82   source=undefined
fee=220  driverNet=180  ratio 0.8181  riderSharePct=82   source=undefined
fee=220  driverNet=180  ratio 0.8181  riderSharePct=82   source=undefined
fee=0    driverNet=0                  source=webhookIntasend | merchant_ready | backfill   ×8
```

**The arithmetic identifies the author exactly:**

| | fee × 0.82 | fee × 0.80 | stored |
|---|---|---|---|
| 220 | 180.4 → **180** ✅ | 176 ❌ | **180** |
| 237 | 194.34 → **194** ✅ | 190 ❌ | **194** |

The persisted `driverNet` matches **authority #1 (0.82)** and is incompatible with the server
webhook's `× 0.8`. **Production's rider payouts were computed in the browser.**

### The server does not price — it recovers

`index.js:8562`:

```js
const _delivery = Math.max(0, Math.round(amount - _subtotal));
```

The delivery fee is derived as a **residual of what the customer paid**, not from any formula. The
client computes the fee, the customer pays `subtotal + fee`, and the server subtracts to recover
the number the client chose. When `amount == subtotal` the residual is `0` — which is why **8 of
13 records carry `deliveryFee: 0` and `driverNet: 0`.**

**A client that changes its pricing table changes what SOKONI pays riders.** There is no
server-side recalculation, validation, or bound.

---

## 3. The pricing contract fields do not exist on the canonical rail

`pricingVersion`, `quoteId`, `riderFeeKES`, `platformCut` are named in the served ruleset — but
only on `match /deliveries/{deliveryId}`, which protects them on create:

```
allow create: … && !request.resource.data.keys()
                     .hasAny(['pricingVersion','quoteId','riderFeeKES','platformCut']);
```

`deliveries` holds **0 documents**. On `packageRequests` — the canonical rail with all 13 records —
**none of those four fields exists on any document.**

So the immutable-quote contract is enforced on a rail nobody uses, and absent from the rail that
carries the money. **`quoteId` / `pricingVersion` do not currently form a pricing contract at all.**

---

## 4. Field origin map

| Field | Origin | Authoritative? |
|---|---|---|
| `deliveryFee` | client calc → paid amount → server residual | ❌ client-determined |
| `driverNet` | `fee × 0.82` (client engine) on the 5 priced records; `fee × 0.8` in the webhook | ❌ two formulas, disagree |
| `commissionPct` | `5` literal, webhook | ✅ server literal |
| `riderSharePct` | client engine, persisted as data | ❌ client-determined |
| `pricingBreakdown`, `distanceKm`, `durationMin`, `isPeakHour`, `isSurging`, `subsidyKES` | client engine (5/13) | ❌ client-supplied |
| `sokoniTotalCut`, `sellerNet`, `commissionAmt`, `deliveryComm` | 5/13 only | ⚠️ unverified |
| `riderFeeKES`, `platformCut`, `quoteId`, `pricingVersion` | **absent everywhere** | — |

---

## 5. Lifecycle questions

**Can the same delivery be priced differently at different stages?** Yes, structurally. The client
prices at checkout; the webhook recomputes `driverNet` at `× 0.8` on its own path. A delivery
created by one path and updated by the other would carry two incompatible payout bases. No
guard prevents this — nothing pins a delivery to the formula that priced it, because
`pricingVersion` is not written.

**Which functions recalculate money later?** `dispatch.js:392` writes
`totalEarnings: increment(delivery.driverNet || 0)` at completion — it **trusts the persisted
`driverNet`**, whatever produced it. That is the point where a client-computed number becomes a
rider's credited earnings.

**Does cancellation / rejection / reassignment change the basis?** Cannot be established — the
lifecycle has never executed in production (`riderEarnings`, `driverEarnings`, `payouts` all **0**,
and no delivery has ever had a rider assigned). This must be certified by fixture in Step 6, not
inferred.

**Client paths capable of determining authoritative money:** `checkout.html`,
`delivery-tracking.html`, `earnings.html`, `developer-portal.html` (all load
`sokoni-delivery-pricing.js`), plus `delivery.html`, `delivery-tracking.html`, `driver.html` (load
`delivery-hub.js`). Seven served pages, two disagreeing tables.

**Existing duplicate/retry/idempotency certification for delivery pricing:** none found. The
courier suite (`test-courier-delivery-authority.js`) covers a *server catalogue / server quote /
server-authored record* design — which is the intended target architecture, not what the
`packageRequests` rail does today, and it cannot run without an emulator.

---

## 6. Verdict

🔴 **RED.** Two browser pricing tables disagree with each other and with the server; the server has
no pricing formula at all, only a payment residual; the authority that demonstrably priced
production runs in the browser and is **not requireable by any Cloud Function** (the file is absent
from `functions/` despite its header advertising server use); and the immutable-quote fields exist
only on an empty rail.

**This is not a convergence problem — it is a missing server pricing authority.**

### What must be true before any pricing implementation gate opens

1. a **server-side** pricing module that Cloud Functions can actually require, under `functions/`
2. one canonical vehicle-rate table, reconciled against `vehicle-classes.js` (the V-2 vocabulary —
   note `tuktuk` and `ebike` appear in the pricing engine and need classification)
3. one canonical rider share, chosen deliberately — **82 / 88 / 80 is a commercial decision, not an
   engineering one**
4. `quoteId` + `pricingVersion` written on `packageRequests` at creation, pinning each delivery to
   the formula that priced it
5. the client reduced to a **display estimate**, with the server recalculating the charged fee
6. a rule that a persisted `driverNet` may only be written by the server

**None of this is authorised by this document.** Note also the Step 2 dependency: any producer
schema change to `packageRequests` — including `quoteId`/`pricingVersion` — remains behind the
separate producer-contract gate, exactly as `shopId` does.

### Risk note

The exposure is currently **theoretical, not realised**: the 5 priced records total KES 1,134 in
fees, no rider has ever been assigned, and no earning or payout has ever been created. The defect
is real and the money path is unsound, but nothing has been mispaid, because nothing has been paid.
