# Subscription lapse — does anything destroy business data?

**Date:** 2026-09-02. Read-only audit. Nothing changed.
**Question asked:** on non-payment, is data deleted or orphaned, or is the account merely
reduced to Free?

---

## The policy is already implemented

`functions/sub-billing.js:618`:

```js
updates = { ...updates, status: S.EXPIRED, expiredAt: now(),
            features: PLANS[`${sub.hubType}_free`]?.features || {} };
```

On expiry the subscription's **features are replaced with the Free plan's features**. The
same pattern appears at lines 398, 779 and 785. Line 732 states the intent in words:
*"In grace past graceEnd → EXPIRED (downgrade to free)"*.

**No deletion.** `sub-billing.js` and `subscription-core.js` contain **no** `.delete()`,
`deleteDoc`, `recursiveDelete` or `bulkDelete` call. Products, shop, orders, history,
analytics and customers are untouched by lapse — the account is restricted, not destroyed.

Status lifecycle: `TRIALING → ACTIVE → PAST_DUE → GRACE → EXPIRED → CANCELLED`.

## Finding 1 — three hubTypes have no `_free` plan

`PLANS[`${hubType}_free`]` resolves to `undefined` for:

| hubType | on expiry |
|---|---|
| `enterprise` | `features = {}` |
| `property_agent` | `features = {}` |
| `service_provider` | `features = {}` |

`getFeatures()` returns `features || {}` and consumers read individual keys, so an absent key
is falsy — **`{}` denies everything**. That is *harsher* than Free, and it contradicts the
stated policy of reducing an account to the Free plan rather than to nothing.

It is a restriction, not data loss. But `service_provider` is a real hub, so this would bite
the first provider whose subscription lapses.

## Finding 2 — one production row would hit exactly that path

Production `subscriptions`: **4 rows**.

| dimension | values |
|---|---|
| status | `active` 2, **`superseded` 2** |
| hubType | `seller` 3, **`null` 1** |
| planId | `seller_free` 2, `seller_basic` 1, **`starter` 1** |

Accounts on the three hubTypes above: **0**. So Finding 1 is currently unexploited.

But the row with **`hubType: null`** and **`planId: 'starter'`** resolves
`PLANS['null_free']` → `undefined` → **`{}`**. `starter` is not in the `PLANS` catalogue
either. One production subscription would be reduced to zero features on expiry rather than
to Free.

## Finding 3 — `superseded` is a status the code does not define

`sub-billing.js:39` defines six statuses:

```js
const S = { TRIALING:'trialing', ACTIVE:'active', PAST_DUE:'past_due',
            GRACE:'grace', EXPIRED:'expired', CANCELLED:'cancelled' };
```

Production carries a **seventh**: `superseded`, on 2 of 4 rows — half the table.

Queries that enumerate statuses explicitly (`where('status','in',[ACTIVE, TRIALING, GRACE,
PAST_DUE, EXPIRED])` at line 299; the six separate counts at 543–549) **do not match it**.
A `superseded` row is invisible to those paths. Whether that is intended — a tombstone for a
replaced subscription — or a vocabulary that drifted, is not established here.

## What this does NOT establish

- Whether any code **outside** the subscription modules deletes business data on lapse. Only
  `sub-billing.js` and `subscription-core.js` were searched for delete calls.
- Whether `{}` is uniformly deny across every consumer. It is deny for the read pattern
  observed (`features.x` on a missing key); a consumer defaulting a missing key to a
  permissive value would fail open, and none was audited.
- Whether `superseded` is deliberate.

## Suggested remedies, none applied

1. Add `_free` plans for `enterprise`, `property_agent`, `service_provider`, **or** make the
   fallback resolve to a defined minimal plan instead of `{}`. The `|| {}` is the defect
   shape: an absent catalogue entry silently becomes maximum restriction.
2. Decide what a `null` hubType / `starter` plan should downgrade to.
3. Establish whether `superseded` belongs in `S`, and whether the status queries should
   include it.

None of these is urgent on today's data — 0 accounts on the affected hubTypes — but each is
a case where the system does something stricter than the written policy, silently.

---

# Slice 2 — the three gaps, audited (2026-09-02)

Read-only investigation plus two new, **unwired** files. `sub-billing.js` and
`subscription-core.js` are unmodified.

## Gap 3 first: `superseded` is not a subscription status at all

**No subscription code writes it.** `grep superseded functions/*.js` finds only
`admin-invitations.js` (a different field, `supersededBy`, on invitations) and comments.

The two production rows carrying it also carry **`mergedAt`, `mergedFrom`, `merchantId`** —
they are artifacts of an **account merge**, not of the billing lifecycle. The fourth row
carries `migratedAt` / `migratedFrom` with `planId: 'starter'`, a plan absent from the
catalogue.

So `superseded` cannot be "classified in the lifecycle" from inside this codebase, because
nothing here produces it. Classifying it would mean deciding what the merge process meant —
a question for whoever owns that migration. What *can* be said: the six-status enum is not
exhaustive of production, and the status queries at `sub-billing.js:299` and 543–549 do not
match these rows, so **half the subscription table is invisible to them.**

## The larger finding neither gap named

**Entitlements are read from the subscription DOCUMENT, not from the plan catalogue.**

`subscription-core.js` builds its canonical object from `d.features` (lines 113, 130, 148),
and `getFeatures()` returns `.features || {}`. There is **no PLANS-by-planId fallback
anywhere** in the resolution chain.

And **none of the four production subscription documents has a `features` field at all.**

What makes paying subscribers work is the fast path in `sub-engine.js:631` —
`users/{uid}.subscription.{hubType}.features`, a cache written by `sub-billing.js` at lines
335, 400, 636 and 783. That cache **is** the entitlement store.

Which sharpens the reported gap: the `|| {}` at line 618 does not merely land on the
subscription document. Line 636 writes it straight into the user cache the feature gate
actually reads. The empty set goes exactly where it does the most damage.

## Gaps 1 and 2 — fixed by making them unshippable, not by guessing

`functions/free-entitlement.js` (**new, unwired**) resolves a hubType to its Free
entitlement and returns `{ outcome, catalogueGap, planId, features, reason }`. It never
throws — it runs inside expiry sweeps where a throw strands the rest of the batch — and it
never returns a bare `{}` that a caller cannot distinguish from a legitimately sparse tier.

`scripts/verify-free-plan-coverage.js` (**new, NOT in the predeploy chain**) fails when any
hubType has nowhere safe to land:

```
  hubTypes : 12
    OK   buyer, car_dealer, driver, freelancer, hotel, pharmacy,
         recruiter, restaurant, seller
    GAP  enterprise, property_agent, service_provider
  FAIL — 3 hubType(s) have no Free tier          exit 1
```

**Why a guard instead of a default.** Free tiers are hub-specific and share **zero** keys —
`seller_free` caps `listings_limit`, `buyer_free` caps `wishlist_limit`, `restaurant_free`
caps `menu_items`. The intersection across all 11 free plans is **empty**, so there is no
generic baseline to derive. Inventing one would be a product decision disguised as a bug
fix, and a wrong entitlement granted silently is the same class of defect as a wrong one
denied silently.

`HUB_FREE_ALIAS` exists and is **deliberately empty**: an alias says what a merchant keeps
when they stop paying, so adding one should require someone to say so.

## Deliberately not done

- **The guard is not wired into predeploy.** It currently FAILS, so adding it would block
  every deploy until the three tiers are defined. That is the operator's call, not a side
  effect of an audit.
- **`sub-billing.js` is unmodified.** Replacing the four `|| {}` sites is a change to a live
  billing file and belongs in its own reviewed change, after the tiers exist.
- **No Free tier was invented** for `enterprise`, `property_agent` or `service_provider`.
- **`superseded` was not assigned a meaning.**

## What needs a decision

1. Define `enterprise_free`, `property_agent_free`, `service_provider_free` — **or** alias
   each to an existing hub's Free tier.
2. Decide what `hubType: null` / `planId: 'starter'` downgrades to.
3. Establish what the merge process meant by `superseded`, and whether the status queries
   should include it.
