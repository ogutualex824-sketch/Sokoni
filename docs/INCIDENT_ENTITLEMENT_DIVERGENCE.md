# Incident — Subscription Entitlement Divergence

**Date:** 2026-07-24
**Status:** Implementation complete · Deployment blocked · Runtime certification pending
**Classification:** Entitlement authority divergence — **not** an upload-limit enforcement bug

## The sentence to keep

> The 13 uploads were correct. The upload guard was right. The display was reading
> a different authority.

That reclassifies the incident. Treated as a cosmetic UI defect — "the dashboard
shows the wrong number" — the obvious fix is to correct the number on screen,
which would have left two competing authorities in place and the same divergence
free to reappear anywhere else either one is read.

## Root cause

Two independent subscription authorities existed:

```
AUTHORITATIVE   subscriptions/{uid} → subscription-core → subscription-catalog
                                      STARTER listingLimit = 100
                                      canPublishProduct → 13 allowed   CORRECT

LEGACY UI       users/{uid}.subscription.seller → sokoni-subscription.js
                                      never written by the payment path
                                      → FREE_DEFAULTS.listings_limit = 10  DISPLAYED
```

`webhookIntasend` (`functions/index.js:6744`) activated the subscription in
`subscriptions/{uid}` and nothing else. The seller UI read
`users/{uid}.subscription.seller` (`sokoni-subscription.js:79`), a mirror only
`sub-billing.js:335` maintains — a subsystem the IntaSend webhook never invokes.
Finding nothing at its read location, the client fell back to its hard-coded free
allowance.

**It was not a stale cache** (the document was never written at all), **not skipped
backend validation** (`canPublishProduct` ran and was correct), and the uploads
beyond 10 were legitimate: STARTER allows 100.

Contributing factor: the canonical FREE limit is *also* 10, so the wrong answer
looked plausible. `verify-listing-limit-single-source` reports **57 declarations
across 10 files**; four are client-side and every one hard-codes 10 for free. None
could see a subscription, so all agreed on the wrong answer — which made the bug
look consistent rather than flaky.

## Customer impact

- Subscription payment succeeded.
- Upload entitlement was correctly upgraded server-side.
- Product uploads beyond the free tier succeeded **as designed**.
- Dashboard continued displaying the free-tier allowance.

No merchant was wrongly blocked and no revenue was lost. The harm was trust: a
merchant who had paid for 100 was shown 10.

## Resolution

Single entitlement authority — `functions/subscription-authority.js`, resolving
through `subscription-core` + `subscription-catalog`, adding no eleventh table:

- `getMerchantEntitlements()` — callable; the contract every screen consumes
- `materialiseEntitlements()` — persists `entitlements/{uid}`, writes the
  transitional mirror, records `entitlementAuditLog`
- `onSubscriptionChangedSyncEntitlements` — recomputes on any `subscriptions/{uid}` write
- `webhookIntasend` awaits materialisation on payment completion
- `sokoni-authority.js` — client SDK returning **null when unknown**, never a
  fabricated allowance

Verification tooling, in place **before** deployment:

- `scripts/verify-entitlement-consistency.js` — split-authority detector
- `scripts/audit-callable-invokers.js --probe` — callable reachability

Migration and mirror-retirement conditions: `docs/ENTITLEMENT_MIGRATION.md`.

## Remaining work — operational, not engineering

1. Resolve Cloud Run capacity, or reduce the new function count.
   `verify-architecture` reports **1598 exports against a 1480 hard budget**. The
   overage predates this change (1581) but this adds 2. Not neutral: it makes the
   eventual consolidation harder.
2. Deploy the updated functions.
3. Execute a real payment.
4. Verify materialisation, callable accessibility, dashboard values, upload
   enforcement, and the consistency gate.

## Success criteria — two milestones, deliberately separate

Conflating these would either rush the billing-writer migration or leave the
incident log misleading. They are different work on different timescales.

### Milestone 1 — incident resolved (merchants no longer see the wrong limit)

1. Dashboard shows the merchant's actual plan.
2. `getMerchantEntitlements()` matches the catalogue.
3. `verify-entitlement-consistency.js <uid>` passes.
4. `audit-callable-invokers.js getMerchantEntitlements --probe` returns 401, not 403.
5. Product #100 is accepted (STARTER).
6. **Product #101 is rejected by the authoritative entitlement path.**

Criterion 6 is the one most likely to be skipped and the most important to keep:
it is the only check proving the limit is *enforced* rather than *displayed*. The
incident existed precisely because those were different systems. Criteria 1–5 can
all pass while enforcement is absent.

### Milestone 2 — duplicate authority eliminated (technical debt cleared)

7. No client reads `users/{uid}.subscription.*` for entitlement decisions.
8. `verify-listing-limit-single-source` passes — no file declares its own limits.
9. The transitional mirror in `subscription-authority.js` is deleted.

Milestone 2 is the staged migration in `ENTITLEMENT_MIGRATION.md`, ending with
`sub-billing.js` because it owns real billing state. The mirror is **deliberately
load-bearing** until then — retiring it early would reintroduce the incident for
every screen not yet migrated.

## Lessons

**A correct component can still produce a wrong system.** Every part here worked:
the webhook activated the subscription, the catalogue held the right limits, the
guard enforced them, the client rendered what it read. The defect lived in the
space between them, which no single-component test could see.

**Agreement is not correctness.** Four client tables agreed on 10 — because none
could see a subscription. Consensus among stale copies looks exactly like a
verified answer, which is why `verify-entitlement-consistency.js` compares against
a deterministic catalogue reference rather than taking a majority.

**Design for uncertainty.** `SokoniAuthority` returns null rather than inventing a
free allowance. A blank limit prompts a support ticket; a confidently wrong "10"
does not. Preferring visible uncertainty over a plausible default is what turns a
silent failure into a reported one.

**Every business decision should have exactly one authoritative implementation.**
Subscription status, upload limits, commissions, pricing, inventory — wherever a
rule exists in more than one place, each duplicate is another point at which the
system can diverge. A single authority with read-only consumers is easier to verify
and to evolve than several implementations expected to stay synchronised. Expecting
synchronisation is the assumption that failed here.

This is not aspirational in this codebase; it is already demonstrated. Compare:

| Business rule | Authorities | Guard | Status |
|---|---|---|---|
| Commission | 1 (`functions/commission-config.js`) | `verify-commission-single-source` | **PASSES** — "exactly one commission table, and every consumer reads it" |
| Listing limits | 10 (57 declarations) | `verify-listing-limit-single-source` | **FAILS** — this incident |

Same pattern, opposite maturity. Commission proves the model works at SOKONI's
scale; entitlements are what it looks like when the same rule is left duplicated.
The guard is what holds the line afterwards — without one, a single-source
refactor decays back into duplicates the next time somebody needs a limit and does
not know where the canonical one lives.

Candidates worth auditing next, by the same method: pricing, inventory ceilings,
and anything else where two subsystems each hold a table of the same business fact.
