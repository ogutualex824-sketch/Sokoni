# Delivery Pricing Policy — decisions required from SOKONI

**Status:** TEMPLATE ONLY — nothing written to production, no values chosen by engineering
**Target document:** `platformConfig/deliveryPricing` (does not exist; `platformConfig` is empty)
**Schema source:** `functions/delivery-quote-authority.js` — regenerate with
`node scripts/gen-delivery-pricing-policy-template.js`
**Related:** [[DELIVERY_STEP4_PRICING_CONVERGENCE]]

---

## Why this document exists

The quote authority **refuses to price anything** until this policy exists and is explicitly
approved. That is deliberate: the defect being removed is that a browser decided what SOKONI paid
riders, and replacing a browser's guess with an engineer's guess would be the same mistake wearing
a server hat.

Every value below is a **commercial decision**. None has a defensible engineering default.

**Current production behaviour:** every new delivery is created `pricingBlocked` — visibly
unpriced. That is the correct fail-closed state and should remain until these values are approved.

---

## How the numbers are used

```
operating economics  ->  rider gross  ->  dynamic SOKONI share  ->  customer charge
```

The rider's earning is computed FIRST, from what the trip costs them plus their time. SOKONI's
share is the remainder, and it is constrained to **16–25%** (already set, in code). The share
**moves** with distance and demand — a single fixed percentage is the legacy defect
(0.82 / 0.88 / 0.80) under a new name.

So these values do not set a price directly. They set **what a rider must be made whole for**, and
the customer charge follows from that.

---

## 1. Identity and approval

| Field | Decision |
|---|---|
| `policyVersion` | **REQUIRED** — e.g. `"P1"`. Bumping it is the declared way policy changes; a quote is pinned to the version that priced it and **cannot settle under a different one**. |
| `status` | **REQUIRED** — must be the literal string `"approved"`. `"draft"`, `"pending"`, `"retired"` and even `"APPROVED"` are all refused. |
| `effectiveFrom` | **REQUIRED** — ISO date. |
| `approvedBy` | **REQUIRED** — who approved these commercial values. |

---

## 2. Share curve — how SOKONI's cut moves

| Field | Decision | Meaning |
|---|---|---|
| `shareCurve.distanceWeight` | **REQUIRED** | How much of the 16→25% movement is driven by route length |
| `shareCurve.demandWeight` | **REQUIRED** | How much is driven by demand/supply scarcity |
| `shareCurve.saturationKm` | **REQUIRED** | Route length at which the distance factor is maxed out |
| `shareCurve.demandSaturationIndex` | **REQUIRED** | Demand index at which the demand factor is maxed out (must be > 1) |

**Constraint enforced in code:** `distanceWeight + demandWeight` must equal **exactly 1**. If they
do not, the blend silently rescales the whole band and moves every rider's pay without anyone
changing the band.

*Worked meaning:* with weights 0.5/0.5 and `saturationKm: 20`, a 20 km trip in a balanced market
lands near the middle of the band; a 2 km trip in a balanced market sits near 16%. **These numbers
are an illustration of the mechanism, not a recommendation.**

---

## 3. Per-vehicle-class economics

Required for **all seven priced classes**: `motorcycle`, `bicycle`, `ebike`, `tuktuk`, `car`,
`van`, `truck`.

| Field | Decision | Notes |
|---|---|---|
| `energyUnitLabel` | **REQUIRED** | `"litre"` or `"kWh"`. Stated, never inferred — `ebike` is electric |
| `energyCostKESPerUnit` | **REQUIRED** | KES per litre / per kWh. Major units, max 2 decimal places |
| `efficiencyKmPerUnit` | **REQUIRED** | km per litre / per kWh. Must be > 0 |
| `maintenanceKESPerKm` | **REQUIRED** | Wear + servicing provision, KES per km |
| `riderTimeKESPerMinute` | **REQUIRED** | **What a rider must earn per minute of their time** |

**`riderTimeKESPerMinute` is the most consequential number in this document.** It is the floor on
rider earnings — everything else only covers their costs. It may legitimately differ per class
(a van driver's hour is not a boda rider's hour).

**Declared per class deliberately.** One blended figure would silently subsidise one class out of
another class's riders. A class with no declared economics **refuses** rather than borrowing
another's numbers.

**Do NOT give economics to** `pickup`, `suv`, `lorry`, `trailer`, `tractor` — these are unpriced
classes and refuse by design.

---

## 4. Demand index

| Field | Decision |
|---|---|
| `economics.demandIndex.source` | **REQUIRED** — where the live demand/supply figure comes from |

`1.0` means balanced supply and demand. The caller supplies the live value per quote; this field
records **what system produces it**, so a figure that moves rider pay is attributable.

> ⚠️ No demand-index source currently exists in the platform. If one has not been built, the honest
> options are to name the system that will provide it, or to set `demandWeight: 0` and
> `distanceWeight: 1` so the curve does not depend on a signal nobody produces. The second is a
> commercial choice, not an engineering fallback.

---

## 5. Explicitly NOT used

These appeared in test fixtures and in the retired browser code. **None is an approved value:**

| Value | Where it came from |
|---|---|
| distance 0.6 / demand 0.4, 20 km saturation | my own first draft — invented to demonstrate arithmetic |
| KES 195/litre, 40 km/litre, KES 2.50/km, KES 6.00/minute | test fixture, labelled `FIXTURE-ONLY` |
| rider share 0.82 | `sokoni-delivery-pricing.js` — the browser authority being removed |
| rider share 0.88 | `delivery-hub.js` — the second browser authority |
| rider share 0.80 | the webhook's `driverNet = fee * 0.8` |

The fixture values live in `scripts/test-delivery-quote-authority.js`, which `loadPolicy` cannot
read — it reads Firestore. They cannot reach production by any path.

---

## 6. After the values are supplied

1. write `platformConfig/deliveryPricing` with `status: "approved"` — its own authorized gate
2. re-run `node scripts/test-delivery-quote-authority.js`
3. confirm a live quote issues and lands inside the 16–25% band across representative routes
4. **then** Gate C — convert checkout to consume the server quote

**Gate C must not run before this policy exists.** The authority refuses without it, so a
quote-driven checkout would have no fee and could not complete a purchase.
