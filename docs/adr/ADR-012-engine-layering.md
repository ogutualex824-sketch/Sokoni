# ADR-012 — Merchant pricing must not depend on logistics

**Date:** 2026-08-02 · **Status:** Accepted

Related: [[ADR-011]] · [[Delivery Hub Survey]] · [[Platform Constitution]]

---

## Context

`delivery-hub.js` prices couriers with `_calcFee(distance, vehicle, weight, urgency)`. The delivery
engine prices merchant delivery with `mode`, `defaultFee`, `perKm`, `freeAbove`, `serviceZones`.
Both scale with distance, which makes them look like one function with more parameters.

They are not. The inputs differ in **who supplies them and when**:

| | chosen by | when |
|---|---|---|
| merchant config | the merchant | once, in advance |
| vehicle · weight · urgency | customer / the parcel | per dispatch |

## Decision

**Two layers, with a one-way dependency.**

```
Merchant Delivery Engine     pickup · free · flat · distance · zones · free-above
        ▲
        │  logistics MAY consume merchant pricing
        │  merchant pricing MUST NEVER consume logistics
        │
Dispatch / Logistics Engine  vehicle · weight · urgency · courier assignment ·
                             fleet optimisation · ETA
```

The logistics layer composes the merchant engine's distance calculation and applies its own
multipliers. The merchant engine gains nothing.

## Why the direction matters

Adding `vehicle`/`weight`/`urgency` to `calculateDelivery()` would put courier fleet economics inside
the function that prices a bookshop's flat KES 150 delivery. **Every merchant-facing consumer would
then carry parameters that can never apply to it** — and that is how a shared engine becomes a union
of everything anyone ever needed, which is the state this programme spent weeks undoing.

The distance arithmetic (`base + km × perKm`) is genuinely shared and belongs to the merchant engine,
so composing it prevents "four implementations of distance pricing" from regrowing.

## Consequences

- The delivery engine's public surface stays small enough to hold in one's head.
- Fleet changes cannot regress merchant checkout pricing.
- A future logistics engine has one dependency edge to respect, and it is stated here.
