# r1 release-stack matrix — the 34-commit production delta

**Status:** 📋 READ-ONLY RECONCILIATION. No cherry-pick, merge, or deploy performed.
**Date:** 2026-09-03 · **Branch:** `release/r1-pos-printer-fn` (worktree `C:/temp/sok-r1`)
**Production:** `d592d8f` / v632 (confirmed live via `mysokoni.co.ke/version.json`)
**r1 tip:** `8fc3673` — 34 commits ahead of deployed production
**Certification runs in this document were executed directly against r1's checked-out code**
(`C:/temp/sok-r1`), today, not assumed from commit messages.

---

## Part 1 — r1's ADR-018 vs this branch's ADR-018

Read in full (`docs/adr/ADR-018-legacy-retirement-graph.md` at commit `d627355`, r1 branch).
**Neither version supersedes the other — they're complementary, and a reconciled version should
merge both.** From here on, per your instruction, cite records as `branch@commit:path`, not by
number alone.

| | `release/multishop-checkout-certified@1f89550:docs/adr/ADR-018-...md` (this branch, "18b") | `release/r1-pos-printer-fn@d627355:docs/adr/ADR-018-...md` (r1, "18a/18b/18c") |
|---|---|---|
| method | Cloud Logging invocation counts, 30-day window, code-caller `git grep` | **live Firestore row counts** (8 collections queried directly against production, with `users`=89/`products`=108/`posDevices`=33/`branches`=3/`zzNoSuchCollection`=0 as controls) + reachability-by-module tracing |
| scope | `posSendPurchaseOrder` only | all 8 `pos*` inventory/procurement collections at once (`posSuppliers`, `posSerials`, `posWarehouses`, `posWarehouseStock`, `posProductIndex`, bare `purchaseOrders`, `posPurchaseOrders`, `posBatches`) |
| numbering | 18b = `posSendPurchaseOrder` retirement | **18a** = the 5 clean collections; **18b** = bare `purchaseOrders`/Model D handler (same handler this branch calls 18b — **independent convergence, same verdict: zero callers, safe to retire**); **18c** = `posPurchaseOrders`+`posBatches`, blocked |
| status | Accepted, 18b executed and committed | "READ-ONLY GRAPH — retirement NOT authorised... as a single slice" |

**What r1's ADR-018 has that this branch's analysis didn't:**
- Real production **row counts** (stronger than invocation logs — proves zero documents ever
  written, not just zero calls in 30 days) with a real negative control (`zzNoSuchCollection`).
- Explicit self-correction of a reachability false-positive (misattributed `createPurchaseOrder`'s
  export before catching it was `procurement.createPurchaseOrder`, not `pos-inventory-pro.js`'s) —
  the same conclusion this branch's `ADR-018c` also reached independently, so both analyses agree
  here.
- A clean three-way split (18a/18b/18c) with per-slice certification requirements already stated.

**What this branch's `ADR-018`/`ADR-018c` has that r1's doesn't:**
- **The `pos-suppliers.js` client-side direct-write finding.** r1's document analyzes
  `posReceiveErpUpdate` and the dispatcher handlers as the writers to `posPurchaseOrders`, but does
  not mention that `pos-suppliers.js` (a live, real client app) *also* writes directly to that
  collection via an unmediated Firestore `.set()`. This is a real gap in r1's writer inventory.
- **The served-Firestore-rules verification.** This branch's work fetched the actual served
  ruleset and proved the client write above is denied in production. r1's document doesn't address
  whether any of the writes it discusses are rules-permitted or denied.
- **The specific field-name mismatches in the `posBatches` readers.** r1's Finding 2 describes each
  reader's *error-handling* behavior (try/catch vs none) but not *why* they'd return nothing even if
  called — this branch traced `getExecutiveDashboard`/`getInventoryHealthScore` querying
  `expiresAt`/`consumed` against a real schema that uses `expiryDate`/`status`, and
  `posGetInventoryAlerts` querying `merchantId` against a schema that only has `sellerId`.
- **A real, current invocation attempt** — `getPOSInventoryIntelligence`'s one live 2026-08-15 call,
  which 500'd, plausibly on a missing composite index (`sellerId` not covered by the deployed
  index). r1's document is evidence-graph-only; it doesn't report any live invocation attempts.

**Recommendation (not executed):** a reconciled ADR-018 should keep r1's row-count method and
18a/18b/18c split as the primary structure, and fold in this branch's three additions above,
verbatim — none of them contradict r1's conclusions, they extend the writer/reader inventory r1's
own document says is the blocking question for 18c.

---

## Part 2 — the 34-commit feature matrix

**Baseline for every row:** none of the 34 commits are ancestors of `d592d8f` — by construction,
every row is "commit not yet deployed." The useful distinction, per your framing, is whether
production already runs *an older variant* of the same file/capability, or nothing at all. Checked
per file via `git cat-file -e d592d8f:<path>`, not assumed.

**Certification evidence below was run today, in `C:/temp/sok-r1`, against the actual checked-out
code — not read off commit messages.**

| Feature | Source commit(s) on r1 | Present in current production? | Production version | Certification evidence (run today) | Hosting / Functions / both | External dependency | Remaining blocker | Release status |
|---|---|---|---|---|---|---|---|---|
| **Recovered rails** (boost expiry, 48h commission rail, pickup handover) | `fe37a91`(ADR-015 base)`, 1ef8382, d9010ec, 5c8fb6f` | Partially — `functions/index.js` gains 5 new exports (`expireBoosts`, `getCommissionBalance`, `getSellerRestriction`, `pickupHandover`, `sweepCommissionDue`) not present in `d592d8f` at all | **absent** (new exports) | `test-pickup-handover.js` 21/0, `test-commission-collection.js` 59/0, `test-boost-ranking.js` 33/33, `test-c2b-commission-caller.js` 18/0 | Functions only | `mpesa-c2b` production caller for the commission rail (test notes: transport/signature/allowlist behavior is explicitly out of scope, only the code path from "applied" onward is proven) | live-caller path unverified beyond the unit level |
| **Tenant authority** | `f026fac, 8f8938a, c5ff85b, 04f3026` (+ new `functions/tenant-authority.js`) | file is new; the *functions it binds* (`pos-inventory-pro.js`, `inventory-ai.js`, `procurement.js`, `inventory-engine.js`) are already live | **older, unbound variant is what's deployed** | `test-tenant-authority.js` 46/0 — **script's own output states**: "NOT DEPLOYED — the Functions deploy is a separate, unauthorised gate, so the unbound resolver is still what production runs until then" | Functions only | none found | authorized Functions deploy |
| **POS document authority** | `888f0ef` | modifies existing `pos-inventory-pro.js` handlers | **older, unbound variant deployed** | `test-pos-inventory-doc-authority.js` 45/0 | Functions only | none found | authorized Functions deploy |
| **Procurement authority (Model C disposition)** | `c5ff85b, af7525f, 7ec2360, ae97419` | modifies existing `functions/procurement.js` (190 lines) | **older, unbound variant deployed** | `test-procurement-tenant-authority.js` 64/0 | Functions only | none found | authorized Functions deploy |
| **Merchant authority** | `5189365, fcff2cb, 5cf2f02` (+ new `functions/merchant-authority.js`) | file is new; touches `merchant-v2.html` (23 lines, via the Supplier Hub commit, see below) | **absent** (new file) | `test-merchant-authority.js` 40/0 | Both (Functions + `merchant-v2.html`) | none found | authorized deploy, both hosting + Functions |
| **Warehouse authority** | `7788661, 1678d33, 145ca5a, 3cd5eac` (+ new `functions/warehouse-authority.js`) | file is new | **absent** | `test-warehouse-authority.js` 42/0 | Functions only | none found | authorized Functions deploy |
| **Warehouse management UI** | `311daed` | touches `inventory.html` (218 lines) | **absent as a UI surface** | `test-warehouse-ui.js` 30/0 — **script's own note**: "page RENDERING is not exercised here — a live check on a served page is still required" | Hosting (+ reads the Functions-side warehouse authority) | none found | live-page render check, then authorized hosting deploy |
| **Supplier Hub** | `3b9ccbc` | new file `sokoni-merchant-supplier-hub.js` (511 lines), touches `merchant-v2.html` + `sokoni-merchant-routes.js` | **absent** | `test-supplier-hub.js` 36/0 — **script's own note**: "`getPurchaseOrders`, `getInventoryForecast` and `createAutoReorderPO` are NOT DEPLOYED, and the tenant inventory collections hold zero rows. Supplier Hub ships showing empty and unavailable states until that is authorised." | Both | depends on the tenant-authority-bound `pos-inventory-pro.js` ops it calls | those ops are not deployed; ships in a deliberately-empty state until they are |
| **Receipt bridge** | `101b946, 8100c1e, 5bd32ac` (+ new `functions/receipt-bridge.js`) | file is new | **absent** | `test-receipt-bridge.js` 53/0 | Functions only | none found | authorized Functions deploy |
| **ADR-017 (inventory authority debt) + resurrection gate** | `59d2225, af38694` (+ new `scripts/gate-authority-resurrection.js`, modifies the 8 `functions/inventory-{fraud,health,import,pricing,recall,simulate,webhooks,workflows}.js`) | those 8 files exist in production at an older baseline, without the ~26-28 line fix each gets here | **older, pre-fix variant deployed** | `test-adr017-authority.js` 63/0 **+ the master gate itself, run live**: `node scripts/gate-authority-resurrection.js` → *"16 modules, 106 handlers, 85 bound, 4 exempt, 0 FROZEN DEBT — positive controls 8/8 · negative controls 4/4 — GATE PASSED"* | Functions only | none found | authorized Functions deploy |
| **18a — legacy POS inventory handler retirement** | `8fc3673, d627355` | `pos-inventory-pro.js` still has the pre-retirement handlers live (449 lines this commit removes) | **older, larger variant deployed** (handlers present, per r1's own ADR-018: zero live rows/callers) | `test-retire-18a.js` 46/0 | Functions only | none found | authorized Functions deploy |
| **18b — bare `purchaseOrders`/Model D retirement** (r1's numbering — same target this branch calls "18b") | covered within r1's `ADR-018` graph, not yet a separate execution commit on r1 | `posSendPurchaseOrder` still exported in production | **older variant deployed, unretired on r1's own branch too** | see `docs/adr/ADR-018-legacy-retirement-graph.md@1f89550` (this branch) — **already executed there**, 20/20 | Functions only | none | **this branch has already done this specific retirement** (`2539aad`) — a candidate for direct reconciliation rather than re-doing it on r1 |
| **18c — `posPurchaseOrders` / `posBatches` disposition** | not executed on either branch | both collections' handlers/readers live as-is | current, unbound variant deployed | this branch: `docs/POS_18C_DISCOVERY.md`, `ADR-018c` (disposition recorded, not executed) · r1: `ADR-018-...md@d627355` (graph, not executed) | Functions only | see Part 1 — needs the ERP-webhook and BI-reader product decisions on both accounts | **blocked on both branches**, same open questions |

---

## Part 3 — KASS AI, re-anchored to production

**No new evidence needed — the original audit already measured live production directly**
(`gcloud functions describe`, Cloud Logging, `curl` against `mysokoni.co.ke`), which *is* r1's
deployed code, not this branch's. Confirmed today: `exports.kass` and `exports.sokoniChat` exist
at essentially the same lines in r1's `functions/index.js` tip (`883`/`1641` vs this branch's
`859`/`1617` — offset by unrelated intervening code, not a functional difference). The finding
stands unchanged:

- `sokoniChat` (customer widget): **BROKEN IN PRODUCTION** — built, deployed, correctly routed,
  fails on every real call because the Anthropic account behind `ANTHROPIC_API_KEY` has exhausted
  its credit balance. Not a deployment gap. No code change indicated.
- Six `kass-*.html` role pages: wrong SDK method (`httpsCallable` against an `onRequest` fn),
  currently non-impacting (unreachable from real navigation).

Classification preserved exactly as before; full detail in `docs/KASS_AI_AVAILABILITY_AUDIT.md`.

## Part 4 — premium messaging, and the branch it's actually on

**Correction to the previous framing:** premium messaging (`9fe09e2`) is **not** on r1's lineage
either (`git merge-base --is-ancestor 9fe09e2 release/r1-pos-printer-fn` → false). It exists only
on `release/multishop-checkout-certified` — the evidence/work branch, per the new policy. It is
real, committed, built-but-undeployed work, but it is not part of the 34-commit production delta.
It belongs in a "must be explicitly reconciled into r1" bucket of its own, not the r1 stack table
above.

---

## Part 5 — what this reconciliation does NOT do

- Does not merge, cherry-pick, or deploy anything.
- Does not decide how `release/multishop-checkout-certified`'s independent work (premium
  messaging, 18b's `posSendPurchaseOrder` retirement, the 18c disposition record, the KASS AI audit
  itself as a *document*) gets reconciled into r1. That's a real decision — this branch's 18b
  retirement and r1's own (not-yet-executed) "18b" target the identical thing with the identical
  verdict, which argues for reusing this branch's already-certified commit rather than re-doing the
  work on r1, but that's a recommendation, not an action taken here.
- Does not resolve the ADR-018 filename collision. Both versions remain, at their own paths, on
  their own branches.
- Does not change either branch's function export count. This branch: 1508. r1: 1519 (measured
  today, `d592d8f`: 1514, `8fc3673`: 1519).

## Related

`docs/RELEASE_LINEAGE_RECONCILIATION.md` (the branch-topology finding this matrix builds on) ·
`docs/RELEASE_STACK_LEDGER.md` · `docs/adr/ADR-018c-purchase-order-batch-disposition.md`
