# Entitlement migration — from ten plan tables to one authority

Companion to the 2026-07-24 incident: a paid STARTER merchant was shown a
10-product limit while the upload engine correctly accepted 13.

## The split that caused it

```
webhookIntasend ──▶ subscriptions/{uid} ──▶ subscription-core ──▶ subscription-catalog
                                                              STARTER listingLimit = 100
                                                              canPublishProduct → 13 OK

sub-billing.js  ──▶ users/{uid}.subscription.{hubType} ──▶ sokoni-subscription.js
                                                       never written by the payment path
                                                       → FREE_DEFAULTS = 10 displayed
```

The payment path fed one authority; the UI read the other. Neither was stale —
they were different systems.

## Target architecture

`functions/subscription-authority.js` is the only place entitlements are decided.
It resolves through `subscription-core` + `subscription-catalog` (the declared
canonical catalogue) and adds no table of its own.

```
getMerchantEntitlements(uid)
  → { active, plan, uploadLimit, uploadsUsed, uploadsRemaining, premium, expiresAt }
```

No screen may compute an upload limit. Clients call `SokoniAuthority`
(`sokoni-authority.js`), which returns **null when unknown** and never invents a
free allowance — fabricating one client-side is the failure being fixed.

## The mirror is transitional

`materialiseEntitlements()` also writes `users/{uid}.subscription.seller` so
existing screens correct themselves without being rewritten.

**This must not become permanent.** A derived copy that outlives its purpose is
two synchronised representations of one fact — the original problem renamed.

Delete the mirror block when all three hold:

1. No client reads `users/{uid}.subscription.*` for entitlements
   ```bash
   grep -rn "subscription\[" --include=*.js --include=*.html .
   grep -rn "FREE_DEFAULTS\|listings_limit" sokoni-*.js
   ```
2. `sokoni-subscription.js` is retired, or reads `SokoniAuthority`
3. `node scripts/verify-listing-limit-single-source.js` passes

## Staged migration — 57 declarations across 10 files

Ordered by blast radius. **One file per change, re-run the guard after each.**

| Stage | Files | Why this order |
|---|---|---|
| 1 — display only | `sokoni-revenue.js`, `subscription-billing.html`, `plans.html`, `subscriptions.html` | Wrong numbers here mislead; they gate nothing. Safest to move first. |
| 2 — client read paths | `sokoni-subscription.js`, `sokoni-subscriptions.js` | Replace local tables with `SokoniAuthority`. Unblocks mirror removal. |
| 3 — server readers | `functions/index.js` (`maxListings`), `sasos-core.js`, `subscription-os.js` | Read-side only; resolve through the catalogue. |
| 4 — billing writers | `functions/sub-billing.js` | **Last.** Owns real billing state; a mistake changes what merchants are charged or entitled to. |
| 5 — cleanup | remove duplicate constants; delete the mirror | Only once nothing reads them. |

Verify after every stage:
```bash
node scripts/verify-listing-limit-single-source.js
```

Do not attempt this in one pass. Ten live plan tables removed together is a
change nobody can review or safely roll back.

## Deployment constraints — check BEFORE deploying

Two **new** Cloud Run services are introduced:
`getMerchantEntitlements` (callable) and `onSubscriptionChangedSyncEntitlements`
(Firestore trigger).

- `verify-architecture` reports **CF export count 1598 against a HARD budget of
  1480** and says consolidate before deploying. The overage predates this change
  (1581 before), but this adds to it.
- This repository has a documented history of functions blocked by Cloud Run CPU
  quota. Confirm quota headroom before deploying.
- If quota is tight, `onSubscriptionChangedSyncEntitlements` can be dropped: the
  webhook already awaits `materialiseEntitlements` directly. The trigger is
  belt-and-braces covering non-webhook activation paths (admin edits, expiry
  sweeps), so dropping it narrows coverage rather than breaking the fix.

After deploying, the callable must be **reachable**, not merely created:
```bash
node scripts/audit-callable-invokers.js getMerchantEntitlements --probe
```
Expect `401` (reached the function, rejected unauthenticated). A `403` means the
Cloud Run service is missing `roles/run.invoker` for `allUsers` and the browser
cannot call it — see `CALLABLE_INVOKER_GAPS.md`.

## Production verification checklist

Not resolved until every line is observed. Baseline at the time of writing:
`entitlements/` and `entitlementAuditLog` are **empty** — nothing has exercised
this path.

| # | Check | Evidence |
|---|---|---|
| 1 | New subscription payment creates/updates `subscriptions/{uid}` | doc exists, `status: active`, correct `plan` |
| 2 | `materialiseEntitlements()` executes | log line, no error in webhook |
| 3 | `entitlements/{uid}` holds expected plan, limits, status | `plan: STARTER`, `uploadLimit: 100` |
| 4 | `users/{uid}.subscription.seller` updated (transition only) | `features.listings_limit: 100` |
| 5 | `getMerchantEntitlements()` agrees with `subscription-core` | same plan and limit from both |
| 6 | Dashboard shows **100**, not 10 | observed in browser |
| 7 | Product #14 uploads successfully | upload completes |
| 8 | Product #101 is rejected by `canPublishProduct` | blocked with upgrade prompt |
| 9 | `entitlementAuditLog` records the materialisation | doc with `reason: payment-complete` |

Item 8 is the one most likely to be skipped and the most important to keep: it is
the only check that proves the limit is *enforced* rather than merely *displayed*.
The incident began because those two were different systems.
