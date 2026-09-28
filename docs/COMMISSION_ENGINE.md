# SOKONI — COMMISSION ENGINE

**Version:** 2.0 · **Status:** CANONICAL · **Effective:** 2026-07-13
**Governed by:** [[PLATFORM_CONSTITUTION]] · [[FINANCIAL_TRANSACTION_STANDARD]]
**Enforced by:** `scripts/verify-commission-single-source.js` — a deploy-blocking CI gate.

> There is **one** Commission Engine. There is **one** place a commission rate may be defined.
> Every payment, webhook, settlement, refund, ledger entry, invoice, analytics report and seller
> dashboard obtains its rate from that one engine. This is not a convention — the deploy fails if
> it is violated.

---

## Why this document exists

The platform once had **nine** commission tables and **two** engines. They disagreed, and which one
applied depended on which payment rail a customer happened to use:

> A KES 10,000 legal consultation cost **KES 500** on the Daraja rail and **KES 1,200** on the
> FinOS rail. Eight of nine overlapping hubs were priced differently. Nobody chose that.

It stayed invisible for a long time because every copy looked authoritative on its own. Worse, the
FinOS engine had been settling at **zero commission for its entire life** — one missing `db`
argument, silently swallowed. The platform earned nothing on that rail and nobody noticed.

Consolidation is therefore not a tidiness exercise. It is the only way the number is knowable.

---

## The one authority

| Layer | File | Role |
|---|---|---|
| **Config** | `functions/commission-config.js` | The ONLY place a rate may be defined |
| **Engine** | `functions/finos-utils.js` → `calculateCommission(db, opts)` | The ONLY place a rate is computed |
| **Adapter** | `functions/index.js` → `_resolveCommission()` | Shape converter for `commissionLedger`. Not an engine. |
| **Client** | `sokoni-commission-rates.js` (generated) → `SokoniCommission.pct()` | **Display only.** Never computes settlement. |
| **Preview** | `previewCommission` (callable) | The only sanctioned source of a commission figure for a client |

`calculateCommission(db, opts)` — **`db` is required.** Omitting it once cost the platform every
shilling of commission on the FinOS rail; it now throws a named `TypeError` that forbids defaulting
to zero.

---

## Resolution order

```
1. Commission Rules      commissionRules/{id}          (tiers, caps, holidays, entity overrides)
2. Revenue Configuration revenueConfig/seller_{uid}
                         revenueConfig/hub_{hub}
                         revenueConfig/global
3. Category default      commission-config.js RATES
4. Plan adjustment       subscription plan discount    (SEE ROLLOUT — off by default)
5. Validate              floors, caps, minimums
   ↓
Final effective rate → Settlement → Ledger → Invoice → Analytics
```

Steps 1–3 produce the **base rate**. Step 4 adjusts it. Step 5 makes it safe.

The final percentage returned by the engine is the **only** value used for payments, settlements,
ledgers, invoices, dashboards and analytics. No page may reconstruct it.

---

## Rates

Rates are per **category**, and both vocabularies resolve — hub names *and* category names —
because callers historically held both and neither knew which.

The values are the **hub rates**: the only rates ever actually charged, and the ones sellers were
shown. Adopting the rival table's rates would have been a silent price rise (legal 5% → 12%,
marketplace 3% → 10%).

See `functions/commission-config.js` for the table. Each entry records its provenance.

### Current schedule: owner-confirmed 2026-09-28

This replaces the previous schedule outright. It is specified, row by row, in `scripts/test-commission-schedule.js`.
Related: [[Payments]] · [[SmartPOS]] · [[Marketplace]] · [[Events]] · [[KASS]]

| Transaction | SOKONI rate | Authority entry |
|---|---|---|
| Online product sales (merchant keeps 85%) | 15% | `marketplace` (aliases `product`, `products`, `shopping`, `b2b`) and the online lane `resolveMarketplaceRate` |
| Food ordered online | 15% | `food_delivery` (`food`, `restaurant`) |
| Digital products | 10% | `digital_products` |
| POS / Till / Quick Charge | 5% | **`pos`** (`till`, `quick_charge`) and the POS lane `resolvePosRate` |
| Event tickets | 5% | `event_tickets`; event sales and settlement read it through `shared/commercial-policy` |
| BnB / hotel bookings | 15% | `hotel` (`bnb`) |
| Healthcare bookings | 12% | `healthcare` |
| Healthcare product sales | 15% | `healthcare_products` (`pharmacy`) |
| Home services | 14% | `home_services` |
| Car rental | 16% | `car_rental` (`car-rental`, which the car pages send) |
| Entertainment bookings | 5% | `entertainment_bookings` |
| Legal bookings | 5% | `legal` |
| Other service bookings | 5% | `services` (`fitness`, `insurance`) |
| Education | 15% | `education` |
| Car Hub vehicle sales | KES 2,000 flat | `vehicles` (`car_hub`, `car_dealer`) |
| SOKONI's own subscription plans | 100% | `subscriptions` |
| Delivery (SOKONI's share) | 17–25%, dynamic | `delivery-quote-authority` `SHARE_MIN_PCT` 17 / `SHARE_MAX_PCT` 25 |

**POS is decoupled from online sales.** POS used to be priced through `ALIASES.pos → marketplace`, so raising online
sales to 15% would have tripled every till sale. POS now has its own `pos` key at 5%, and `_is48hCommission` accepts
the `pos` category, so the till keeps its 48-hour settlement term.

**Not reached by this schedule yet** (reported to the owner; nothing was guessed):
- **Provider bookings.** Home services, other services, and car rental booked through a provider are priced by the
  provider's subscription plan in compatibility mode (`provider-hub.commissionArgsForHub` → `subscriptionRole`:
  20 / 15 / 10 / 7 / 5%), not by the table. Retiring that mode changes every provider's price, which is an owner
  decision. Healthcare and entertainment bookings already use the table. KASS states no rate for the plan-priced types.
- **Merchant-sold subscriptions / packages (15%).** No payment flow sends a package category yet.
- **Property.**
  - Long-term rent is a subscription business with no commission on rent; the client-side 2% "rent commission" on
    `landlord.html` was removed.
  - A property / land sale is KES 5,000 flat, but no code distinguishes a sale from rent yet, so `property` (2%) is
    unchanged.
  - BnB is `hotel`.
- `default` (5%, unknown categories), `hub` (legacy flat 12% delivery split), `jobs` 15%, `classifieds` 8% and `ppv`
  15% are outside the confirmed table and unchanged.

---

## Plan adjustments — capability shipped, policy OFF

**The engine can apply subscription commission discounts. Whether it does is an operator decision.**

> Engineering delivers capability. Business decides when capability becomes policy.
> Do not activate subscription commission discounts merely because the implementation exists.

### The switch fails closed

`revenueConfig/plan_adjustments`:

```json
{
  "enabled": false,
  "maxDiscountPct": 50,
  "minEffectivePct": 0.5,
  "allowZero": false,
  "plans": {
    "seller_pro": { "enabled": true, "label": "Pro Plan Discount" }
  }
}
```

If the document is **absent**, **unreadable**, or `enabled` is not exactly `true`, **no seller
receives an adjustment**. A deleted config, an empty database, a fresh environment — every one of
them means "no discounts", never "all discounts".

That is deliberate. `FINANCIAL_TRANSACTION_STANDARD.md` F6/P0-7 records what self-activating
financial behaviour costs: a fallback that fired on a blank config value gave stock away in
production. **A capability that activates itself is a live weapon.**

### The discount is not defined here

The Subscription Engine already carries it. `sub-billing.js`'s plan catalog defines
`features.commission_discount_pct` (basic 2, pro 5, enterprise 10) and `subscription-core` surfaces
it in the canonical `features` map. The Commission Engine **consumes** that value. Defining a second
plan table would be the duplication the constitution forbids.

### Relative, not points

```
effective = base × (1 − discount/100)     marketplace 3%, enterprise (15% off) → 2.55%
```

Taken as **points**, a `pro` seller (5) on a 3% base would pay `3 − 5 = 0%`, and enterprise would go
negative. Those values were authored when the base was ~15%. The UI labels the field
*"Commission discount (%)"*. Points-off remains available, but only when an operator asks for it
explicitly via `deltaPct`.

### Safety — a plan discounts; it never inverts

| Guarantee | Enforced by |
|---|---|
| Never negative commission | clamped to ≥ 0, unconditionally |
| Never zero unless configured | floored at `minEffectivePct` (0.5%) unless `allowZero: true` |
| Never exceeds the cap | `maxDiscountPct`, hard-capped at 50% in code — config may tighten, never loosen |
| Never raises commission | a "discount" that would increase the rate is clamped to the base |
| Expired subscriptions get nothing | status recomputed from dates by the Subscription Engine |
| Unlisted / unknown plans get nothing | per-plan allowlist — this is what makes a limited rollout limited |

---

## Rollout phases

| Phase | State | Config |
|---|---|---|
| **1 — Engineering complete** | Mechanism deployed. **Zero pricing change.** | absent, or `enabled: false` |
| **2 — Internal validation** | Enabled in dev/staging only. Validate the whole money path. | `enabled: true` in the non-prod project |
| **3 — Limited rollout** | Only the intended tiers, listed and enabled. | `enabled: true` + a short `plans` map |
| **4 — General availability** | All intended tiers. Update pricing pages, dashboards, docs. | `enabled: true` + the full `plans` map |

**Phase 1 is the current state.** Verified in production: the document is absent.

### Operator control — no deployment required

```bash
node scripts/plan-discount-rollout.js status
node scripts/plan-discount-rollout.js disable                 # instant rollback
node scripts/plan-discount-rollout.js enable
node scripts/plan-discount-rollout.js add-plan seller_pro --label "Pro Plan Discount"
node scripts/plan-discount-rollout.js add-plan business --delta -1
node scripts/plan-discount-rollout.js remove-plan seller_pro
```

Takes effect within 60 seconds (the engine caches the document for one minute). Enabling,
disabling, increasing, decreasing or suspending a discount **never** requires a deploy.

---

## The canonical breakdown

`previewCommission` returns it. **Every seller-facing screen renders this. No page rebuilds it.**

```
Base Rate        3%      Base rate (marketplace)
Plan Benefit    −0.15    Pro Plan Discount          (absent while the rollout is off)
Final Commission 2.85%
Reason          "Pro Plan Discount"
Rule Applied    default | <ruleId>
```

---

## Audit

Every financial record retains enough to reproduce the rate **years later**:

`baseRate` · `planId` · `planName` · `planStatus` · `planAdjustment` · `adjustmentType` ·
`planApplied` · `planSkipped` · `planSource` · `ruleId` · `ruleSource` · `reason` ·
`calculatedAt` · `engineVersion`

`planSkipped` matters more than it looks: while the rollout is off it records
`rollout_disabled`, so a settlement can **prove the discount was switched off at the time** —
rather than leaving it ambiguous whether the seller simply had no plan.

---

## Engineering rules

- The client **never** calculates commission.
- The client **never** selects commission.
- The client **never** overrides commission.
- The client **only** displays the breakdown the server returned.

`commissionPct` has been removed from the client `PLANS` tables. The drift guard fails the deploy
if a client-side plan rate reappears.

---

## The guard

`scripts/verify-commission-single-source.js` — runs in `firebase.json` predeploy for **both**
functions and hosting, and in `package.json`'s `predeploy` / `deploy:*` scripts.

It fails the deploy on:

1. a deleted table returning (`HUB_COMMISSION_DEFAULTS`, `DEFAULT_COMMISSION_RATES`, …)
2. a stale generated client snapshot
3. a new hub→number map near the word "commission"
4. a bare-literal rate (`platformFeeRate = 0.03`) — five of these were hiding inside hub
   purchase handlers, which is why no audit of the "tables" ever found them
5. a magic fallback (`|| 10`) on a commission lookup
6. a client-side plan commission rate

[[PLATFORM_CONSTITUTION]] · [[FINANCIAL_TRANSACTION_STANDARD]] · [[Payment Engine]] ·
[[Subscription Engine]] · [[Finance Engine]]
