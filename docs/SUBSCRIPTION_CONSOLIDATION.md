# Subscription Consolidation — One Canonical Read/Enforce Seam

**Date:** 2026-07-12 · **Commit:** `bd53fb1` · **Status:** seam live (`subscriptionsDispatch` deployed)

## The problem (audited)
SOKONI had **five** independently-written subscription stores with conflicting keys, field names, timestamp types, and status vocabularies. The same account could hold 2–3 divergent records, and Systems 1 & 2 bypassed the `users.subscription` mirror that feature-gates read.

| # | System | Collection / key | Purpose | Status |
|---|--------|------------------|---------|--------|
| 1 | universal-onboarding.js | `accountSubscriptions/{subId}` | UEOE role plans (20 roles) | write-only, no reader |
| 2 | provider-onboarding.js | `providerSubscriptions/{uid}` | Provider hub | live |
| 3 | sub-engine.js / sub-billing.js | `subscriptions/{autoId}` (by `uid` field) | Cross-hub billing automation | live, full lifecycle |
| 4 | subscription-os.js | `aiSubscriptions/{uid}` + `subscriptions/{uid}` | AI/SASOS entitlements | live |
| 5 | sokoni-subscription.js | reads `users.subscription.{hubType}` | Client SDK | orphaned (0 callers) |

**Split-brain:** Systems 3 & 4 use the *same* `subscriptions` collection with *incompatible* doc keys (auto-id vs `{uid}`) → silent divergence.

## The fix — `functions/subscription-core.js` (non-breaking)
Rather than migrate 5 live writers (high risk), this is a **READ + ENFORCE seam** that normalizes whatever any writer produced into ONE canonical shape. **Zero edits to the 5 systems.**

- **Normalization** — timestamps (Firestore Timestamp | ISO | epoch) → epoch ms; status → one vocab (`trialing/active/grace/past_due/expired/cancelled`); cycle `annual→yearly`; features array→map; name conflicts (`renewalDate|renewalAt|currentPeriodEnd → renewalAt/expiryAt`, `plan|tier → tier`, `commission|commissionRate → commissionRate`).
- **`resolveSubscription(uid, {role, hubType})`** — reads only the sources relevant to the role, in priority order, returns the first hit as canonical. **Status is recomputed from dates** so stale stored statuses can't mislead.
- **`resolveAll(uid)`** — every subscription across all stores (unified billing view).
- **Enforcement API (library — import directly, 0 new CF):** `getCommissionRate`, `assertWithinLimit`, `hasFeature`, `isActive`.
- **Client ops via `subscriptionsDispatch` (1 CF):** `getUnifiedSubscription`, `listMySubscriptions`, `checkFeature`, `checkLimit`.
- All queries **index-free** (single-field equality + in-memory filter).

## How to use it (the go-forward rule)
**Any code that needs to know a subscription's rate/limit/feature/status must call `subscription-core`, never read a raw collection.**

```js
const subCore = require('./subscription-core');

// commission for a completed provider booking
const rate = await subCore.getCommissionRate(uid, { role: 'provider' });

// gate a listing creation on the plan limit
await subCore.assertWithinLimit(uid, { role: 'merchant', hubType: 'merchant' }, 'listings', currentCount);

// feature flag
if (await subCore.hasFeature(uid, { role: 'provider' }, 'analytics')) { … }
```

**Done:** `provider-ops.js` commission now resolves through the seam (provider hub + UEOE can no longer disagree on the rate charged).

## Migration path (incremental, safe)
1. ✅ **Seam built + live** — canonical read/enforce available now.
2. **Point readers at the seam** — replace direct `.collection('providerSubscriptions'|'accountSubscriptions'|…)` reads with `subCore.resolveSubscription`. **Done so far:**
   - `provider-ops.js` commission (`bd53fb1`)
   - `sub-engine.js` `subCheckFeature` feature-gate (`3088589`) — now sees all 5 stores instead of only the mirror + `subscriptions`
   - `subscription-os.js` `_loadEntitlements` marketplace fallback (`b609d41`) — a marketplace plan in sub-engine/UEOE is no longer defaulted to free; AI/HMAC path untouched
   **Next readers:** any remaining direct-collection reads, and each new role-ops module.
3. **Unify writes last** — once all readers use the seam, converge writers onto one collection + `uid`-based key convention, and make `users.subscription` the authoritative mirror for all hubs. This is a data migration; do it only after readers are seam-only, behind a flag.
4. **Retire the orphan** — `sokoni-subscription.js` (System 5) has 0 callers; delete after confirming.

Related: [[DISPATCHER_REGISTRY]] · [[UEOE_GAP_ANALYSIS]] · [[project_sub_billing]]
