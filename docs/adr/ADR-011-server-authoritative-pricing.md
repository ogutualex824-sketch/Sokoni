# ADR-011 — The server prices; the client displays

**Date:** 2026-08-02 · **Status:** Accepted · **Enforced by:** `verify-server-delivery-authority.js`, `verify-delivery-engine-sync.js`

Related: [[ADR-010]] · [[ADR-012]] · [[Delivery Engine]] · [[Payment Trust]]

---

## Context

`functions/index.js` recomputed the item subtotal server-side but accepted `request.data.deliveryFee`
from the client, clamping it to `0..5000`.

The clamp reads like validation. It is not. **Inside that range the client decided what delivery
cost**, and the only defence was that the figure could not be made arbitrarily large. A bounded lie is
still a lie.

## Decision

**Every component of a charge is computed by the server. The client displays; it does not price.**

For delivery specifically:

1. Load the merchant's `deliveryConfig`.
2. Recompute with the **shared** delivery engine — the same module the client uses, so the two cannot
   drift.
3. On mismatch: **reject**, audit, and return the authoritative figure so the client can refresh.
4. Proceed only when both agree.

### Reject, never substitute

Silently swapping in the server's figure would charge a total **the customer never saw**. A rejection
that returns `serverDeliveryFee` lets the client refresh and re-confirm honestly. This is the same
principle as ADR-010's refusal to mutate financial records after payment.

### Unconfigured merchants are visible, not trusted

Where a merchant has no `deliveryConfig`, the server has nothing to recompute *from*. The legacy clamp
applies and the gap is recorded as `delivery_fee_unverified`. **This is a temporary state with an exit
condition, not an exemption:** the legacy path disappears merchant-by-merchant as configuration
coverage approaches 100%, and it must never be reintroduced as a fallback once configs exist.

## Consequences

- A merchant changing their fee mid-session causes a rejection, not a wrong charge. Correct, and the
  message must say so plainly ("Delivery fee is out of date. Please refresh your cart.").
- The engine must exist in two *places* — Firebase uploads only `functions/`, so
  `require('../…')` deploys green and throws on the first checkout. It must never become two
  *engines*: divergent copies would make the server reject **every** order. A hash-comparison gate
  runs in predeploy.
- `delivery_fee_unverified` volume is the migration burndown metric.

## Alternatives rejected

| alternative | why not |
|---|---|
| keep clamping | the client still sets the price |
| substitute silently | charges an amount the customer never agreed to |
| require config, reject everyone else | breaks every existing merchant at once |
| server-only, no shared engine | two implementations of one price — the original defect |
