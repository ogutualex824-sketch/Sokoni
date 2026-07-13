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
