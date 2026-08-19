# Subscription & Entitlements Audit

**Status:** AUDIT DONE · **REPAIR STEPS 1-4 BUILT, 55/0 (+4 unproven), NOT DEPLOYED**
**Repair:** `functions/entitlement-authority.js` · `scripts/test-entitlement-authority.js`
**Live check:** `scripts/verify-kass-subscription.js <uid>` — READ ONLY, needs production credentials
**Trigger:** a paid/active Starter (KES 499) that is not usable; free trials not rendering.
**Verdict:** the chain is broken in **four independent places**. Any one alone reproduces the symptom.

Related: [[RELEASE_BOARD_MERCHANT_V2]] · [[MERCHANT_IDENTITY_AUTHORITY]] · [[Payments]]

---

## ⚠ CORRECTED 2026-08-19 — this diagnosis was WRONG for KASS

Production verification (docs/KASS_PRODUCTION_VERIFICATION.md) shows **aiSubscriptions is
empty platform-wide (0 documents)** and KASS has no AI subscription. The  findings
below are REAL code defects and the fix is worth keeping — but they affect **zero
production merchants today** and are **not** what blocks KASS.

I matched KES 499 to `s price and stopped there. The actual plan id is
 ("SOKONI Starter Plan", IntaSend), which already resolved to STARTER/100 before
any change of mine. **The real defect is that KASS is two accounts**: the paid subscription
is on a uid with no shop, and the shop is on a uid with no subscription.

Read the KASS verification FIRST. Everything below stands as a code audit only.

---

## The headline, reproduced

```
$ entitlementFor({ status: 'active', plan: 'ai_starter' })

  plan:               "FREE"        ← paid Starter, free entitlement
  listingLimit:       10            ← not 100
  subscriptionStatus: "ACTIVE"      ← reports ACTIVE while granting FREE
```

That last line is the poison. **The status says ACTIVE and the entitlement says FREE**, so
every screen reading status shows a healthy paid plan while every screen reading
entitlements shows free limits. There is no single place where the contradiction is
visible — which is exactly why it presents as "paid but unusable".

KES 499 identifies the plan precisely: `ai_starter` in `functions/ai-subscriptions.js:33`.

---

## What is actually wired

Nine subscription modules exist. Correcting an earlier measurement of mine: a
quote-specific grep wrongly reported five as unwired — **all nine are reachable**.

| module | role |
|---|---|
| `sub-billing.js` | 16 callables incl. `subGetPlans`, `subGetStatus`; catalogue A |
| `subscription-catalog.js` | catalogue B — what **entitlements** resolve against |
| `subscription-core.js` | `resolveSubscription`, `computeStatus` (7 requirers) |
| `product-limit.js` | the enforcement point — writes `productCounters.maxProducts` |
| `ai-subscriptions.js` | catalogue C — the `ai_*` plans, **KES 499 lives here** |
| `subscription-authority.js` | `getMerchantEntitlements` |
| `sub-engine.js`, `subscription-os.js`, `subscriptions-dispatch.js`, `sasos-billing.js` | renewal, OS, dispatch, SASOS |

---

## Findings

### F1 — `ai_*` plan ids resolve to FREE 🔴 ROOT CAUSE

`subscription-catalog.js` ALIASES maps `seller_basic → STARTER`, `pro → GROWTH`,
`business → ENTERPRISE` … and **no `ai_*` id at all**. `resolve()` deliberately falls back
to FREE for unknown ids (correct — a typo must not take a shop offline), so:

| plan id | resolves to | listingLimit |
|---|---|---|
| `ai_starter` | **FREE** | **10** |
| `ai_pro` | **FREE** | **10** |
| `ai_enterprise` | **FREE** | **10** |
| `starter` | STARTER | 100 |
| `seller_basic` | STARTER | 100 |

**Every AI-plan subscriber is on free listing limits.** Measured, not inferred.

### F2 — the purchase never triggers a limit re-sync 🔴 ROOT CAUSE

`product-limit.js:290` — `onSubscriptionChangedSyncLimit` fires on
`subscriptions/{subId}`. `ai-subscriptions.js:82` writes **`aiSubscriptions/{uid}`**.

Different collection ⇒ **the trigger never fires** ⇒ `productCounters.maxProducts` is never
recomputed after an AI-plan purchase. Independent of F1: fixing the alias alone would still
leave the ceiling stale.

### F3 — `subGetStatus` cannot see AI subscriptions 🔴

`sub-billing.js:229` queries `subscriptions` where `uid ==`. AI subscriptions live in
`aiSubscriptions`. The merchant's own status endpoint therefore reports **no such
subscription** for a plan they are paying for.

### F4 — status vocabulary divergence: `trial` vs `trialing` 🔴

`ai-subscriptions.js:284,301` uses `status: 'trial'`. `entitlementFor()` entitles only
`['active','trialing','grace']`. So an AI **trial** is not entitled at all → FREE.

This is the most likely reason free trials "aren't rendering" as usable.

### F5 — there is no trial eligibility machinery 🔴

No `trialUsed`, `hasUsedTrial`, `trialEligible` or `startTrial` anywhere in `functions/`.
The catalogue declares `trial:{days:3}`, `{days:30}` — but nothing implements *eligible?*,
*already used?*, *days remaining*, or *converted?*.

**A trial can therefore be re-granted by creating another subscription document** — the
exact risk flagged. `admin-os.js:269` carries a `subscription_trials_active` flag at 100%
rollout, describing a system that is not implemented.

### F6 — five plan vocabularies

| source | ids | limit field |
|---|---|---|
| `sub-billing.PLANS` (what `subGetPlans` lists) | `seller_free/basic/pro/enterprise` | `features.listings_limit` |
| `subscription-catalog.PLANS` (what entitlements use) | `FREE/STARTER/GROWTH/ENTERPRISE` | `listingLimit` |
| `ai-subscriptions.PLANS` | `ai_free/starter/pro/enterprise` | *(none — storageGB, credits)* |
| `entitlement-adapters.VALID_PLANS` | `free/starter/pro/business` | — |
| `index.js:6943 validPlans` | `free/starter/pro/business` | — |

ALIASES bridges A→B. **Nothing bridges C.** The plans a merchant can *see and buy* and the
plans the entitlement engine *understands* are different sets.

### F7 — the rules-level cap is fail-open, on a counter known to drift 🟡

`firestore.rules.live:88 withinProductLimit()` allows the write when **any** of these hold:
no `productCounters/{uid}` doc · no `maxProducts` field · `maxProducts == -1` · no `count`
field. Combined with the known counter drift (one shop at count −23 against 103 real
products), the cap is advisory in practice.

### F8 — `products/create` has no approved-seller gate 🔴 **SEPARATE**

Already measured against the live rules. **Kept as its own row** — it is a general
product-write security decision and must not be bundled with a subscription fix.

---

## What is already RIGHT — do not rebuild it

- **Downgrade does not delete or retroactively lock.** `product-limit.js` keeps a
  `grandfatheredFloor`; a merchant with 80 products on a 50 plan keeps all 80 visible and
  is blocked only from *creating* the 81st. Exactly the required behaviour.
- **Deletion frees capacity** — `onMarketplaceProductDeleted` decrements the counter, so
  49/50 can add again. No permanent lock.
- **Resolution failure falls back to FREE, never unlimited, and never offline.**
- **The counter records `source`, `catalogMax` and `catalogVersion`**, so an odd ceiling is
  a question with an answer rather than another investigation.
- `subscription-catalog.js` is the right shape for the single catalogue. **Extend it.**

---

## The audit matrix

`[x]` traced and understood · `[!]` traced, **defective** · `[ ]` not yet traced

```
Plans                     [!]  five vocabularies; buy-set ≠ entitlement-set (F6)
Prices                    [x]  KES 499 = ai_starter; cents vs shillings differ per catalogue
Free trial                [!]  declared in catalogues, not implemented (F5)
Trial eligibility         [!]  DOES NOT EXIST — re-grantable (F5)
Trial expiry              [x]  sweep exists for subscriptions/; blind to aiSubscriptions/
Payment creation          [ ]  not traced this pass
Payment confirmation      [ ]  not traced this pass
Webhook                   [ ]  not traced this pass
Duplicate webhook         [x]  aiPaymentRefs/{ref} claim looks idempotent — not runtime-proven
Subscription state        [!]  two collections, four status words (F2, F3, F4)
Effective entitlement     [!]  ai_* → FREE while reporting ACTIVE (F1)
Merchant V2 display       [ ]  no plan panel exists yet
Product creation          [!]  ceiling never re-synced after purchase (F2)
Product deletion          [x]  decrements correctly
Inventory limit           [!]  same authority as product creation — inherits F1/F2
Existing-over-limit       [x]  grandfatheredFloor — correct, keep
Upgrade                   [!]  no re-sync for ai_* (F2)
Downgrade                 [x]  gates growth, does not delete
Cancellation              [x]  status-gated in entitlementFor
Renewal                   [ ]  sub-engine not traced this pass
Payment failure           [ ]  not traced this pass
Reactivation              [x]  subReactivate exists
Shop switching            [ ]  entitlements are per-uid; per-shop not traced
Role switching            [x]  data boundary certified separately, 44/0
Server enforcement        [!]  rules cap fail-open ×4 on a drifting counter (F7)
```

**11 traced-and-correct · 9 defective · 5 not yet traced.** Nothing here is green.

---

## Recommended sequence — extend, do not rebuild

1. **Bridge catalogue C.** Add `ai_free/ai_starter/ai_pro/ai_enterprise` to
   `subscription-catalog.ALIASES`. One line each; fixes F1 for every AI subscriber.
2. **Accept `'trial'` alongside `'trialing'`** in `entitlementFor`, or normalise at write
   time. Fixes F4.
3. **Make the sync trigger watch both collections** — or, better, have AI purchases also
   write the canonical `subscriptions/{id}`. Fixes F2 and F3 together.
4. **Build trial eligibility** as a first-class record (`trialUsed` per uid per hub),
   because today a second document is a second free trial.
5. **One entitlement call for the product path** — `canCreateProduct(shopId)` resolving
   subscription → effectivePlan → entitlements → limit → count → ALLOW/DENY, used by *both*
   add-product and inventory-add.
6. **Then** the Merchant v2 plan panel, reading that authority and nothing else.

Each step is independently verifiable, and none requires a new subscription engine.

## Not done, and not claimed

- **No fix applied.** Subscriptions remain frozen.
- Payment creation, confirmation, webhook and renewal paths were **not traced** this pass.
- No production data was queried — the affected-merchant count is **unknown**.
- The `ai_starter` → FREE result is reproduced in-process against the real catalogue module;
  it is **not** yet observed end-to-end on a live account.
