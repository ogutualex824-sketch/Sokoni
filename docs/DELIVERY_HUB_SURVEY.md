# Consumer 2/4 survey — `delivery-hub.js` `_calcFee()`

**Date:** 2026-08-02 · **Status:** survey complete. **No implementation.**
**Conclusion: logistics scheduling, NOT merchant pricing. Do not extend the core engine.**

Related: [[Delivery Engine]] · [[ADR-010]] · [[Canonical Data Model]]

---

## What `_calcFee` actually computes

```js
function _calcFee(distKm, vehicleType, weight, urgency) {
  const v    = VEHICLES[vehicleType] || VEHICLES.boda;
  const kmCh = Math.round(distKm * v.perKm);
  const wSur = Math.round((v.base + kmCh) * (WEIGHT_SURCHARGE[weight] || 0));
  return Math.round((v.base + kmCh + wSur) * (URGENCY_MULT[urgency] || 1));
}
```

`WEIGHT_SURCHARGE = { light:0, medium:0.1, heavy:0.25, bulk:0.4 }`
`URGENCY_MULT     = { standard:1, express:1.3, urgent:1.6 }`

## The classification

The three disputed inputs are **selected by the customer at dispatch time**, not configured by a
merchant:

| input | who chooses it | when |
|---|---|---|
| `vehicle` | customer / dispatcher | per parcel |
| `weight` | the parcel itself | per parcel |
| `urgency` | customer | per parcel |

Merchant delivery configuration answers a different question — *"what does this merchant charge to
bring their goods to you?"* — and its inputs (`mode`, `defaultFee`, `perKm`, `freeAbove`,
`serviceZones`, `operatingHours`) are set **once, by the merchant, in advance**.

**These are two prices, not one price with more parameters.** A parcel courier quote and a shop's
delivery policy coincide only in that both scale with distance.

## Verdict

**Higher-level adjustment layer. The core engine is not extended.**

Adding `vehicle`/`weight`/`urgency` to `calculateDelivery()` would put courier fleet economics into
the function that prices a bookshop's flat KES 150 delivery — every merchant-facing consumer would
then carry parameters that can never apply to it. That is how a shared engine becomes a union of
everything anyone ever needed.

## The overlap that IS real

`_calcFee`'s `base + km × perKm` **is** the engine's `distance` mode, arithmetically identical. So the
courier layer should *compose* the engine rather than duplicate it:

```
courierQuote(cfg, order) = calculateDelivery({mode:'distance', baseFee:v.base, perKm:v.perKm}, order)
                           × (1 + weightSurcharge) × urgencyMultiplier
```

One distance calculation, owned by the engine; the multipliers stay in the courier layer where the
vehicle table already lives. This keeps the "four implementations of distance pricing" problem from
regrowing while refusing to smuggle logistics into merchant configuration.

**Not implemented pending approval of this classification.**
