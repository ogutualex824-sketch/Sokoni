# r1 release-stack matrix — the 34-commit production delta

**Status:** 📋 READ-ONLY RECONCILIATION. No cherry-pick, merge, or deploy performed.
**Date:** 2026-09-03, updated 2026-09-04 (Part 4b + Part 6 added — Till/QR re-anchored, the
four-way release classification), **updated again 2026-09-04** (Part 4c added — Till Approval
Automation + Unified Dashboard Profile, Parts 1-8, re-anchored) · **Branch:**
`release/r1-pos-printer-fn` (worktree `C:/temp/sok-r1`, confirmed still dirty and untouched by
every 2026-09-04 update, including this one)
**Production:** `d592d8f` / v632 (confirmed live via `mysokoni.co.ke/version.json`, re-checked
2026-09-04, this reconciliation pass)
**r1 tip:** `8fc3673` — unchanged since 2026-09-03, re-verified 2026-09-04 (this pass, both the
worktree HEAD and the branch ref) — 34 commits ahead of deployed production
**Certification runs cited from Parts 1-4 were executed directly against r1's checked-out code**
(`C:/temp/sok-r1`) on 2026-09-03, not assumed from commit messages. **Parts 4b/4c/6 (2026-09-04)
are read-only git/log synthesis** — ancestry checks, export counts, and a live production probe,
re-verified fresh each time; `C:/temp/sok-r1` was not entered or modified to produce any of them.

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

## Part 4b — SOKONI Till/QR (Q1-Q8), re-anchored to r1 (2026-09-04)

**Re-verified today, fresh, not carried over:** `git merge-base --is-ancestor <c> release/r1-pos-printer-fn`
returns false for all 8 commits (`db89663, 2ba7d00, 2d27454, 82212eb, 4d78f1c, 4df3e79, 2e5bee0,
584cfcc`). r1's tip is unchanged at `8fc3673` since this matrix was first written. Production is
unchanged, confirmed live via `mysokoni.co.ke/version.json` right now: `commit: d592d8f...`,
`cacheVersion: sokoni-...-v632`.

Same shape as premium messaging (Part 4): real, built, certified work — **170/170 across four
independent pure-core suites** (Q5 74/74, Q6 34/34, Q7 19/19, Q8 43/43), each with its own
negative + sabotage control, plus a served-page browser check for the one client-side surface —
that exists **only** on `release/multishop-checkout-certified`, not on r1's lineage. It is one
coherent feature (`docs/RELEASE_STACK_LEDGER.md`'s consolidated ⭐ row), not eight scattered ones.

**What it touches that r1 also has, and how that was kept safe:** `functions/index.js`'s
`webhookIntasend` (Q6/Q7) and `initiateSTKPush` (Q8) are both live functions r1 also carries
(unmodified there). Every edit to either was scoped, hunk-checked, and diffed to confirm it falls
only within that function's own line range — none of r1's independent work on the same file is
touched or at risk of a silent overwrite; reconciling this into r1 will be a real merge (both
sides have touched `functions/index.js`), not a fast-forward.

**Explicit instruction on record: Till/QR is not to be deployed independently of the eventual
mass release.** It belongs in the same "must be explicitly reconciled into r1" bucket as premium
messaging — a real merge decision, not an automatic one, given both branches have since diverged
further on shared files.

## Part 4c — Till Approval Automation + Unified Dashboard Profile (Parts 1-8), re-anchored to r1 (2026-09-04)

**Re-verified today, fresh, not carried over:** `git merge-base --is-ancestor <c> release/r1-pos-printer-fn`
returns false for all 8 commits (`c3b8de9, 1ebc58e, 230643a, 622d55a, acfd437, 7b49e34, ef62142,
2f1eed3`); all 8 confirmed reachable from this branch's own `HEAD` (`2f1eed3`). r1's tip is
unchanged at `8fc3673` (worktree HEAD and branch ref both re-checked, identical). Production is
unchanged, confirmed live right now: `commit: d592d8f...`, `cacheVersion: sokoni-...-v632`,
`branch: release/r1-pos-printer-fn`, `dirtyWorkingTree: true` (the live build's own dirty-path
list is unrelated to any of this work — five `scripts/*.js` probes, not present in this branch's
8 commits).

One coherent, linearly-chained feature — every commit's parent is the previous commit in the
list above, confirmed by direct `git log` parent inspection, not assumed from commit order:

| Part | What | Commit | Files (new or touched) |
|---|---|---|---|
| 1 | Till Approval Automation — auto-issue SOKONI Till on merchant approval | `c3b8de9` | `functions/application-lifecycle.js` (+55/-0, additive Till-issuance block + `QR_SIGNING_SECRET` binding) |
| 2 | Till & QR surface in Merchant V2 shell | `1ebc58e` | `merchant-v2.html` (**first commit of this file on this branch** — see divergence note below), `sokoni-merchant-till.js` (new), `sokoni-merchant-routes.js` (+13/-0, isolated from pre-existing unrelated dirty content in that file) |
| 3 | `merchantIdentity` — merchant-v2.html's missing core dependency | `230643a` | `functions/shop-employees.js` (+, new callable + `ROLE_CAPABILITIES`), `functions/index.js` (+2 exports), `scripts/test-merchant-identity.js` (new) |
| 4 | `getMyShopWorkspaces` — server-derived Switch Shop list | `622d55a` | `functions/shop-employees.js` (extended), `functions/index.js` (+1 export) |
| 5 | Shop switcher + profile dropdown in Merchant V2 header | `acfd437` | `sokoni-dashboard-profile.js`, `sokoni-dashboard-profile-core.js` (both new, shared component), `merchant-v2.html` (header wiring + sign-out fix) |
| 8 | KASS Shop Till backfill — dry-run verified against real production | `7b49e34` | `scripts/backfill-kass-shop-till-dryrun.js` (new, zero-write dry-run only) |
| 6 | Login Choose Shop — auto-enter or pick a workspace after sign-in | `ef62142` | `auth.js` (+65/-0, isolated from a pre-existing unrelated `_merchantEntry()` addition already dirty in that file), `choose-shop.html` (new) |
| 7 | Provider Dashboard — reuse of the shared identity widget | `2f1eed3` | `provider-dashboard.html` (+42/-1, sign-out fix + widget mount, zero collision with other dirty content — none present) |

**Certification, all re-confirmed clean this pass, re-run together:** Q5-derived Till pure core
(`scripts/test-sokoni-qr-payment.js`, extended in Part 1) **81/81** · Parts 3-4 pure core
(`functions/shop-employees.js` via `scripts/test-merchant-identity.js`) **23/23** · Parts 5-7
shared client-side pure core (`scripts/test-dashboard-profile-core.js`) **18/18** — each with its
own negative + sabotage control. Plus served-page browser checks for every client-facing surface
this workstream touches (`merchant-v2.html`'s header, `choose-shop.html`, `provider-dashboard.html`),
each independently confirmed against the real DOM/network log, not assumed from source review.
Part 8's `--execute` (the actual write) was never run — confirmed by the dry-run script's own
`action: dry-run-would-create` output and by re-reading `docs/KASS_SHOP_TILL_BACKFILL.md`, which
records the `--execute` path as explicitly deferred.

**What it touches that r1 also has, and how that was checked — two files, two different risk
profiles:**

- **`functions/index.js`** — this workstream adds exactly 4 exports, in two isolated,
  comment-marked hunks (`merchantIdentity`/`getMyShopWorkspaces` near line 10679;
  `getMySokoniTill`/`getSokoniTillActivity` — carried from the earlier Q5-Q8 programme's own
  extension of `sokoni-till.js`, re-confirmed present here — near line 12285), both purely
  additive, no line removed. `C:/temp/sok-r1`'s own uncommitted `functions/index.js` change sits
  at a third, non-overlapping location (line ~11504, a `posRetail` require). No line-range
  collision exists today, but the file has independently diverged on both branches beyond just
  these hunks (per Part 4b's finding for `webhookIntasend`/`initiateSTKPush`), so reconciling it
  is still a real merge, not a mechanical concatenation — re-diff at merge time, don't assume
  today's non-collision holds after further commits on either side.
- **`merchant-v2.html`** — a genuine **two-way content divergence**, confirmed by direct
  comparison, not assumed from the Part 2 commit message's own flag: r1's committed copy (`8fc3673`,
  4292 lines) contains the Supplier Hub feature (`SupplierHub`/`supplier-hub`, 2 references) that
  this branch's copy does not; this branch's copy (4388 lines, first committed here in Part 2) 
  contains this workstream's Till/QR module and header identity wiring (`SokoniMerchantTill`,
  `dash-identity`, 3 references) that r1's copy does not. Line-level diff: 123 lines only in this
  branch's version, 27 lines only in r1's version. r1's own worktree shows `merchant-v2.html` as
  **not dirty** — the divergence is entirely between two already-committed versions on two
  branches, not against any in-progress edit. **This is not a fast-forward or a clean auto-merge
  candidate** — it needs a deliberate three-way merge (common ancestor, then both features
  reconciled into one file) before either branch's copy can be called canonical.

**Explicit instruction on record, same as Till/QR: this workstream is not to be deployed
independently of the eventual mass release.** It belongs in the same "must be explicitly
reconciled into r1" bucket as premium messaging and Till/QR — a real merge decision for two files
(`functions/index.js`, `merchant-v2.html`), not an automatic one.

---

## Part 5 — what this reconciliation does NOT do

- Does not merge, cherry-pick, or deploy anything.
- Does not decide how `release/multishop-checkout-certified`'s independent work (premium
  messaging, **Till/QR (Q1-Q8)**, **Till Approval Automation + Unified Dashboard Profile
  (Parts 1-8)**, 18b's `posSendPurchaseOrder` retirement, the 18c disposition record, the KASS AI
  audit itself as a *document*) gets reconciled into r1. That's a real decision — this branch's
  18b retirement and r1's own (not-yet-executed) "18b" target the identical thing with the
  identical verdict, which argues for reusing this branch's already-certified commit rather than
  re-doing the work on r1, but that's a recommendation, not an action taken here.
- Does not resolve the ADR-018 filename collision. Both versions remain, at their own paths, on
  their own branches.
- Does not resolve the `merchant-v2.html` two-way content divergence found in Part 4c (Supplier
  Hub on r1 vs. Till/QR + header identity on this branch). Both versions remain, uncombined, on
  their own branches.
- Does not change either branch's function export count. This branch: **1519**, counted directly
  (`grep -c "^exports\." functions/index.js`) 2026-09-04 (this reconciliation pass) — was 1515
  before Parts 1-8 of the Till Approval Automation + Unified Dashboard Profile workstream added 4
  (`merchantIdentity`, `getMyShopWorkspaces`, plus the previously-uncounted `getMySokoniTill`/
  `getSokoniTillActivity` from the earlier Till/QR programme's own `sokoni-till.js` extension), and
  1511 before that session's original Till/QR work added its first 4
  (`mintSokoniTill`/`setSokoniTillStatus`/`mintDynamicSokoniQR`/`resolveSokoniQR`). r1: **1519**
  (worktree re-read directly this pass, `d592d8f`: 1514, `8fc3673`: 1519 — r1's tip is unchanged,
  so the figure still holds). **The two branches' export counts now coincide numerically
  (1519 = 1519) — this is a coincidence of count, not of content**: the two branches' added
  exports are entirely disjoint (this branch's are Till/QR + identity/workspace callables; r1's
  are the 34-commit authority/rails/Supplier-Hub programme) — a real merge will produce a total
  higher than either branch's current count, not 1519.
- Does not touch `C:/temp/sok-r1`, which remains dirty (`CHANGELOG.md`, `docs/adr/ADR-018-legacy-
  retirement-graph.md`, `docs/cf-invocation-census.json`, `functions/index.js`,
  `functions/pos-retail.js` modified; several untracked scripts under `scripts/`) — re-confirmed
  via `git status` this pass, identical file list to the 2026-09-03/earlier-2026-09-04 checks, no
  drift. That dirty state is itself part of Part 6's blocker list below, not resolved by this
  document.

---

## Part 6 — the four-way release classification (2026-09-04, updated for Part 4c)

Every item this document and its companions have inventoried, sorted into exactly one of four
buckets. Synthesis over the evidence already gathered in Parts 1-4c — no new certification runs
performed here, and `C:/temp/sok-r1` was not entered or modified to produce this (git-log/
merge-base checks only, all read-only). Where a fact needed re-checking (export counts,
production version, r1 tip, ancestry), it was re-verified today rather than carried forward — see
inline notes.

### A — ON R1, CERTIFIED (blocked only on the authorized deploy itself)

Part of r1's 34-commit lineage, already certified against r1's own checked-out code. All ten rows
below share **one single blocker**: an authorized Functions/Hosting deploy of r1's tip. Listed
individually only because their certification evidence is per-feature; the blocker is not.

| Feature | Certification | Caveat |
|---|---|---|
| Recovered rails (boost/commission/pickup) | 4 suites, each 0 failures: `test-pickup-handover.js` 21/0, `test-commission-collection.js` 59/0, `test-boost-ranking.js` 33/33, `test-c2b-commission-caller.js` 18/0 | live `mpesa-c2b` caller path unverified beyond unit level — see bucket D |
| Tenant authority | 46/0 | resolver stays unbound (old behaviour) until deployed |
| POS document authority | 45/0 | — |
| Procurement authority (Model C) | 64/0 | — |
| Merchant authority | 40/0 | needs Functions **+** hosting deploy together |
| Warehouse authority | 42/0 | — |
| Supplier Hub | 36/0 | ships in a deliberately-empty state until Tenant/Warehouse authority above is also live — a real dependency, not just co-scheduling |
| Receipt bridge | 53/0 | — |
| ADR-017 + resurrection gate | 63/0 + master gate PASSED (16 modules/106 handlers/85 bound/0 frozen debt) | — |
| 18a — legacy POS inventory handler retirement | 46/0 | — |

### B — CERTIFIED + ANCHORED, but NOT ON R1 (needs an explicit merge decision before it can ride the mass deploy)

| Feature | Where it lives | Certification | Merge note |
|---|---|---|---|
| Premium messaging | `86b4e43`→`96c3244`→`8fc3673` (anchored on r1's *parent* chain, tag `pending-premium-messaging-r1`, but not on r1's actual branch ref) | 39/39 + real headless-browser load, 0 console errors | fast-forward-shaped once `C:/temp/sok-r1`'s own dirty work is committed |
| **SOKONI Till/QR (Q1-Q8)** | `release/multishop-checkout-certified` only, 8 commits (`db89663` … `584cfcc`) | **170/170** across 4 pure-core suites + 1 served-page browser check | **real merge, not a fast-forward** — both branches have independently touched `functions/index.js`'s `webhookIntasend`/`initiateSTKPush`; reconciliation must diff both sides' hunks by hand, not auto-merge |
| **Till Approval Automation + Unified Dashboard Profile (Parts 1-8)** | `release/multishop-checkout-certified` only, 8 commits (`c3b8de9`→`1ebc58e`→`230643a`→`622d55a`→`acfd437`→`7b49e34`→`ef62142`→`2f1eed3`, one linear chain) | **81/81 + 23/23 + 18/18** (122/122) across 3 pure-core suites, each with its own negative + sabotage control, plus served-page browser checks on all 3 client-facing surfaces (`merchant-v2.html` header, `choose-shop.html`, `provider-dashboard.html`) | **real merge, not a fast-forward, on TWO files**: `functions/index.js` (4 new exports, currently non-overlapping with r1's own dirty hunk but the file has independently diverged elsewhere — see Part 4c) **and** `merchant-v2.html` (genuine two-way content split — r1 has Supplier Hub, this branch has Till/QR + header identity, neither is a superset of the other) — the second is the harder of the two, needing an actual three-way content merge, not a hunk-level diff |
| 18b — bare `purchaseOrders`/Model D retirement | `release/multishop-checkout-certified` (`2539aad`, 20/20) | 20/20 | r1 has reached the identical verdict but not executed it — recommend reusing this branch's commit rather than redoing the work (see Part 5) |

### C — UNRESOLVED (a decision is needed before the item can be sorted into A, B, or D)

| Item | What's blocking classification |
|---|---|
| ADR-018 filename collision | Two documents, same path, different branches, complementary content, neither supersedes — needs a merged/reconciled version before either branch's ADR-018 can be called canonical |
| 18c — `posPurchaseOrders`/`posBatches` disposition | Blocked on **both** branches identically — needs the ERP-webhook and BI-reader product decisions named in Part 1, not a certification gap |
| Warehouse management UI | 30/0 unit-passing, but the suite's own note says page **rendering** was never exercised live — needs a served-page check (the same class of gap Q8's browser check just caught for `pay-q.html`) before it can move to bucket A |
| POS Settlement Convergence (`retailSettlements/{txnId}`) | Architecture **ratified** by the platform owner but implementation is explicitly locked behind a stated trigger phrase ("Build the POS settlement implementation candidate") this conversation has never received, plus two named security-candidate dependencies with no confirmed landing status. Directly relevant to Till/QR: Q7 deliberately did not write into `posRetailSales`/`posSales` because of this exact lock — see `docs/POS_SETTLEMENT_CONVERGENCE_DESIGN.md`, `docs/POS_QR_PAID_STATE_INTEGRATION.md` §3 |

### D — OPERATIONAL BLOCKER (external dependency or an unpassed gate, not a code or design question)

| Blocker | Affects |
|---|---|
| **The authorized Functions/Hosting deploy itself** | Every row in bucket A (ten features) — the single dominant blocker across this whole document. Nothing in bucket A needs more code; it needs one authorized deployment event. |
| `mpesa-c2b` live production caller — transport/signature/allowlist behaviour unverified beyond the unit level | Recovered rails' commission-collection rail specifically (bucket A) |
| KASS AI customer widget (`sokoniChat`) — **broken in production right now** | Root cause is Anthropic account credit exhaustion (`ANTHROPIC_API_KEY`), a billing/operational fix, not a code change or a deploy — independent of everything else in this document |
| `C:/temp/sok-r1` itself dirty (uncommitted `CHANGELOG.md`, `docs/adr/ADR-018-...md`, `docs/cf-invocation-census.json`, `functions/index.js`, `functions/pos-retail.js`, several untracked scripts) | Blocks r1 from being a clean deploy source at all, and blocks the premium-messaging fast-forward (bucket B) — whoever owns that worktree needs to commit or discard it before anything else in bucket A/B can proceed |
| POS Settlement Convergence's Gate 1 (served-security verification via a "SAFE topology" — live auth matrix, `guard-no-rollback` pass, targeted callable deploy) | Blocks Gate 2 (already ratified) from becoming buildable — a prerequisite to the item in bucket C, not yet started |

## Related

`docs/RELEASE_LINEAGE_RECONCILIATION.md` (the branch-topology finding this matrix builds on) ·
`docs/RELEASE_STACK_LEDGER.md` · `docs/adr/ADR-018c-purchase-order-batch-disposition.md` ·
`docs/TILL_APPROVAL_AUTOMATION.md`, `docs/TILL_MERCHANT_V2_SURFACE.md`,
`docs/MERCHANT_IDENTITY_CALLABLE.md`, `docs/SWITCH_SHOP_WORKSPACES.md`,
`docs/MERCHANT_V2_HEADER_IDENTITY.md`, `docs/KASS_SHOP_TILL_BACKFILL.md`,
`docs/LOGIN_CHOOSE_SHOP.md`, `docs/PROVIDER_DASHBOARD_IDENTITY.md` (Part 4c's per-slice detail)
