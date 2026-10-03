# P0 hotfix — ONE withdrawal gate on every payout mover (owner 2026-10-03)

Owner: ship AHEAD of r2; patch built ON THE LIVE ARCHIVE of each deployed function; scoped deploys; guard banners in the
log; serving revisions verified after; b2 re-runs its mutants on this tree before deploy.

## Functions in scope (live state at capture)
| function | live gen | serving revision | lineage |
|---|---|---|---|
| requestSellerPayout | 1790751875248535 | requestsellerpayout-00022-yuj | A (09-30) |
| processPayoutRetries | 1790751831114855 | processpayoutretries-00007-zil | A |
| processPendingPayouts | 1787386536342066 | processpendingpayouts-00013-beg | B (09-09) |
| autoScheduledPayouts | 1787386676153271 | autoscheduledpayouts-00005-lef | B |
| initiateSellerPayout | 1790728782656867 | initiatesellerpayout-00032-qiq | C |
| reconcilePayouts | 1787386683980387 | reconcilepayouts-00006-deq | B — **not changed, not deployed** (inspect/flag only) |

Re-check every generation immediately before launch; if any moved, STOP.

## Tree
Full tree `e67cd0c` (the processTypesenseQueue deploy tree) → baseline `7bfb539` pins `automation-engine`, `finos-utils`,
`subscription-core`, `notify` to the LIVE lineage-A bytes → hotfix `571b37b` adds `shared/withdrawal-gate.js` and the call
sites (18 lines). `commission-config.js` + `sokoni-commission-rates.js` = the full tree's own consistent pair (see below).

## Live vs proposed
- `wallet.js`, `finos.js`: byte-identical to live A and B before the patch.
- Closures (bdclosure) before the patch: wallet.js 13/13, finos.js 4/4, automation-engine.js 2/2 identical to live A; automation-engine.js identical to live B. `index.js` export wiring identical to live A and B.
- `initiateSellerPayout`: handler (59 lines), `_genRef`, `INTASEND_PRIVATE_KEY` byte-identical to lineage C.
- **The one deliberate non-live module: `commission-config.js`.** Lineage A's config (marketplace 3%) predates the current
  snapshot builder, which crashes on it (`MARKETPLACE_PLAN_RATES`), so the commission gate cannot pass with it. The full
  tree's config (marketplace 5%) is used instead because it is behaviour-neutral here: none of the five payout paths reads a
  commission rate (requestSellerPayout, processPayoutRetries, processPendingPayouts, autoScheduledPayouts, initiateSellerPayout
  — verified by call path; the finos-utils helpers they call — createLedgerEntry / settleHoldTxn / releaseHoldTxn /
  generateIdempotencyKey / intasendB2C — do not read rates), and every export the live finos-utils imports
  (MIN_COMMISSION_KES, PLAN_ADJUSTMENTS_DOC, applyPlanAdjustment, planRolloutEnabled, resolveRate) is present. Gate tooling
  was NOT pinned to an older era (that would weaken the gate).

## Gate (shared/withdrawal-gate.js)
Open only on `platformConfig/withdrawals { enabled: true }` (super-admin-only rule; no endpoint toggles it). Absent / false /
non-boolean / unreadable → closed. Closed: requestSellerPayout and initiateSellerPayout refuse (WITHDRAWALS_DISABLED);
the three scheduled movers return before touching any queue. reconcilePayouts untouched.

## Production queues (read-only census, 2026-10-03)
payouts = 0 docs; payoutRequests = 7 (paid 4, failed 2, rejected 1). No pending / processing / retry_scheduled — no existing
payout is affected by the schedulers pausing.

## Evidence on this tree
- Five gates: closure PASS · syntax PASS (1942 files) · commission single-source PASS · delivery sync PASS · payout 0 mismatches.
- `test-withdrawals-off` (acd8910): **9/10**. W1, W2, W4–W10 PASS (incl. the OPEN positive control and reconcile still running).
  **W3 FAILS by design here:** providerRequestPayout lives in providerDispatch (5b's lineage, NOT in this deploy). It moves no
  money itself (marks stray `pending` providerPayouts `requested`); its retirement ships with providerDispatch.

## Deploy (one at a time, scoped)
`--only functions:requestSellerPayout,functions:processPayoutRetries,functions:processPendingPayouts,functions:autoScheduledPayouts,functions:initiateSellerPayout`
Relative-hook config, live `.env` values, every gate banner in the log, env-parity per service, serving revision per
service after, rollback by name to the revisions above.
