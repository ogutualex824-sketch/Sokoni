# Gate A — is there a legitimate prior-period source for offer performance?

**Status:** BLOCKED on unavailable historical data · no trend implemented
**Date:** 2026-09-19 · **Gate:** A
**Evidence:** `scripts/test-offer-trend-source.js` — **32/0**

Nothing implemented. No synthetic baseline, no estimated prior period, no arrows.

---

## Verdict

**Blocked on two independent grounds, either of which alone is sufficient.**

1. **Nothing is keyed by offer.** Not for one period, let alone two.
2. **Where a metric *is* measured, the rollover destroys the prior period.** The window is
   set to zero; nothing writes yesterday's figure anywhere first.

The period *mechanism* is sound and authoritative. The offer *dimension*, and the *retained
history*, are what do not exist.

## A correction to an earlier reading

An initial pass concluded that views simply were not measured. **That was wrong**, and the
suite caught it. `functions/product-analytics.js` maintains a `productStats` document per
product with `viewsTotal / viewsToday / viewsWeek / viewsMonth`, deduped per viewer per day,
with a scheduled job maintaining the windows. Views are measured, carefully.

What it does *not* do is keep them:

```js
const upd = { viewsToday: 0, updatedAt: FV.serverTimestamp() };
if (isNewWeek)  upd.viewsWeek  = 0;
if (isNewMonth) upd.viewsMonth = 0;
```

No dated document is written first. No `viewsYesterday`. Today is knowable; yesterday is
gone — which is precisely the observation a trend needs.

**And this is a gap, not a convention.** The same file archives `productPriceHistory` and
retains `pricePrevious`, so the codebase plainly knows how to keep a prior value where
someone decided it mattered. Nobody decided it for views.

## Metric by metric

| the panel would show | measured? | prior period? | offer-keyed? |
|---|---|---|---|
| Views | yes, per **product** | **no — zeroed on rollover** | no |
| Offer opens | no | — | — |
| Added to order | search-scoped only | — | no |
| Purchased | not yet | **structurally yes** | yes |
| Revenue | per **shop**, per day | yes | **no** |
| Discount given | not yet | **structurally yes** | yes |

### The two that are structurally ready

`shopOfferRedemptions`, built in Gate P, carries `redeemedAt` as a **server timestamp** and
the discount actually given, and is **never zeroed** — so purchased and discount-given would
yield genuine comparable periods by query, with no new instrumentation. They are empty only
because the charge path is not yet wired, which is a parked gate rather than a missing
design.

### Why shop revenue cannot stand in

`shops/{shopId}/analytics/daily_YYYY-MM-DD` is real, authoritative and per-day — fed only
from exactly-once event points, with commission taken from the settlement engine rather than
a dashboard percentage. But it carries **no offer dimension**. Attributing a day's GMV to one
offer would be an inference presented as a measurement, which is the thing this gate exists
to refuse.

## The absence is a missing source, not a failed read

`ctx.offerStats` is read by the panel and supplied by nothing. Those are different states and
must not be conflated: a failed read means *"we could not look"*, which is recoverable and
worth retrying; no source means *"there is nothing to look at"*. Today it is the second.

## The panel may stay exactly as it is

With no stats it says so in words, and says explicitly that nothing is estimated. An absent
figure is skipped rather than coerced to `0`. A rate is omitted when its denominator is
absent or zero — a conversion with no views is not a small percentage, it is not a
percentage. **No trend arrow is rendered anywhere**, asserted, so this gate cannot be
"closed" later by quietly adding one.

## What would unblock each

| | needs |
|---|---|
| Purchased · discount given | the parked **P checkout integration**. Nothing else |
| Views | a dated archive at rollover — write the closing figure before zeroing. Then an **offer→listing attribution decision**, because a product view is not an offer view |
| Offer opens · added-to-order | instrumentation that does not exist; and a decision about whether an offer impression is worth the write volume |
| Per-offer revenue | an offer dimension on the settlement event, at the point commission is computed |

None of these is a trend calculation. Each is an **observation** that must exist first.

Related: [[Offer Persistence Architecture]] · [[project_payment_analytics_contract]]
