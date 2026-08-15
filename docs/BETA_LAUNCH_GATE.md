# SOKONI Beta Launch Gate — Monday

**Scope rule:** an item belongs on this board only if it can stop a beta user from
**signing up, selling, buying, paying, receiving an order, or safely using the marketplace.**
Everything else is Post-Beta / R1.1 — explicitly, so the backlog cannot quietly become a blocker.

Status verified 2026-08-15 against live production, not against memory.

---

## 🔴 BLOCKER — must close before real buyers

### B1. Product checkout charges the client-computed amount

`initiateSTKPush` enforces server-recomputed pricing only for `_enforcedCategories = ["subscription"]`.
**`product` is not in that list**, and the checkout branch does not route through
`createCheckoutSession` / `createPaymentIntent`.

A crafted client can pay **less than catalogue price while stock still decrements**.

This was recorded in `RELEASE_ROADMAP.md` as *"acceptable pre-launch (≈zero buyer traffic) — close
before real buyers."* **Monday is real buyers.** The precondition that made it acceptable expires at
launch.

**Fix:** mint `paymentIntents/{ref}` with a server-recomputed amount (re-read catalogue prices +
`deliveryConfig`, as `darajaSTKPush` did), then add `"product"` to `_enforcedCategories`.
**Deploy the client FIRST** — adding the category before the client ships breaks product payments
outright.

*Verified open: `functions/index.js:6315`.*

---

## 🟢 IN — verified working

| Area | Evidence |
|---|---|
| Core marketplace, category/search | live |
| Merchant onboarding | `smartPosDispatch` redeployed 2026-08-15, `run.invoker` intact |
| Seller + provider role flows | role authority live (`e66d77a4` + 7 CFs) |
| Payments / checkout | keyless IntaSend collector live — **subject to B1** |
| Inventory / product uploads | transactional, floored at zero, `inventoryVersion` |
| Delivery / order flow | live |
| Follow / Shop / Add-to-Cart / Toast | live: `sokoni-toast.css` 8372B, `sokoni-social.js` 43695B, `sokoni-minishop.js` 83949B, `sokoni-ui.js` 52313B all HTTP 200 |
| Subscription authority | deployed 2026-08-15; paid-merchant FREE defect **fixed in production** |
| Free-trial creation + automatic cutoff | deployed; creation verified, cutoff is a post-launch checkpoint (see C1) |
| Upgrade / downgrade / cancel | `subUpgradeWithProration`, `subDowngrade`, `subCancel` deployed 2026-08-15 |
| P0 security fixes | deployed (`e0464ec`) |
| Invariant + regression gates | invariant `critical=0 high=0 info=3`; 75/75, 54/54, 22/22, 16/16, 9/9, 14/14, census clean |

---

## 🟡 POST-LAUNCH PRODUCTION CHECKPOINT — not a launch blocker

### C1. Automatic trial expiry — 2026-08-20T00:39:38Z

Requires **elapsed time**, not engineering. It is after Monday, so it does not gate the beta.

Run `node scripts/gate-subscription-invariants.js --live` and `snapshot-trial-state.js` after the
boundary. Expected: `trialing → expired`, `expiredFrom: "trial"`, `trial: false`, entitlement
recomputed, no premium. Audit delta `subscriptionAuditLog +0 / entitlementAuditLog +1`.

**Do not manually expire the trial to close this early.** The scheduler is the thing being tested.

---

## ⚪ OUT — Post-Beta / R1.1

Removed from the launch path. None of these can stop a beta user transacting.

Step 4 performance/async states · Step 4 six-section IA redesign · Step 4 visual-system work ·
Subscription Centre UI · plan-comparison UI · recommendation engine · premium analytics / R1.1 ·
rules hardening (explicitly deferred on the compiled-size ceiling) · KYC `storage.rules`
(*unless beta enables document upload*) · bank completion percentage · provider
commercial/subscription-gate redesign

**Deliberately deferred with a date:** the `subscriptionAuditLog` design decision — revisit
**after 2026-08-20**. Changing it now would contaminate the temporal experiment.

**Do not touch:**
- The 8 unconsumed payment intents — they represent money not yet charged.
- Retired subscription tombstones (`SOK-GL58F7`, `SOK-E7J2Y8`) — evidence, not clutter.

---

## ⚠️ Launch-day operational risks

**R1 — Live was deployed from a dirty working tree.** `version.json` reports
`commit 8290102`, `branch rc/combined`, **`dirtyWorkingTree: true`**. The live bytes are therefore
not guaranteed to be reproducible from any commit, which weakens rollback: "redeploy `8290102`" may
not reproduce what is currently serving. Before Monday, deploy once from a **clean** tree so the
launch baseline is reproducible.

**R2 — The Firebase CLI cannot currently deploy indexes.** `firebase deploy --only firestore:indexes`
also validates rules, and rules sit at the compiled-size ceiling (HTTP 400). Use
`gcloud firestore indexes composite create` and verify `READY` before shipping dependent functions.
This will bite anyone who adds an index during launch week.

**R3 — Divergent worktrees.** Live runs `rc/combined`; the main checkout is on
`fix/algolia-batch-poisoning` with 39 uncommitted changes; subscription work is on
`rc/identity-verification-1-3` in a separate worktree. Confirm which tree Monday ships from.

---

## Gate

```
SOKONI BETA — GO when:
├── Core marketplace works                      ✅
├── Merchant onboarding works                   ✅
├── Payments work                               ⚠️  blocked on B1
├── Orders/delivery work                        ✅
├── Seller/provider roles work                  ✅
├── Security P0s closed                         ✅
├── Subscription authority deployed             ✅
├── Paid entitlement correct                    ✅
├── Free trial correctly represented            ✅
├── Cancellation/upgrade/downgrade deployed     ✅
├── Automated regression green                  ✅
└── No known P0/P1 beta blocker                 ❌  B1 open
```

**One blocker stands between the current state and GO.**
