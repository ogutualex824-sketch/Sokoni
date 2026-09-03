# r1 release candidate manifest — frozen classification

**Status:** 📋 FROZEN EVIDENCE SNAPSHOT. No merge, cherry-pick, or deploy performed.
**Date:** 2026-09-03 · **Evaluated against:** `release/r1-pos-printer-fn` commit `8fc3673` —
**the pure committed tree only.**

## Methodology — how contamination from the dirty worktree was excluded

`C:/temp/sok-r1` currently has an uncommitted, in-progress edit (`functions/pos-retail.js`,
removing `sendPurchaseOrder`) and was **not touched, read from for certification, or interacted
with in any way** for this manifest — no checkout, reset, restore, stash, commit, stage, rebase,
or cherry-pick, and no test run against its disk state either. Instead: a **separate, new**
worktree was created at the exact commit `8fc3673` (`git worktree add <scratchpad-path> 8fc3673
--detach`), `node_modules` was copied in (a read-only copy *from* `C:/temp/sok-r1`, which modifies
nothing there), the full certification suite was re-run against that clean tree, and the temporary
worktree was then removed. `C:/temp/sok-r1` itself was verified untouched before and after
(`git worktree list` shows it unchanged at `8fc3673`, still on `release/r1-pos-printer-fn`).

Every certification number below is from that clean run, and was identical to the earlier run
against the dirty worktree — the in-progress edit doesn't touch any of the files these particular
tests exercise, but this removes any doubt rather than asserting that from inference.

---

## Classification key

- **ON R1 + certified** — committed on `8fc3673`, has a passing certification test.
- **ON R1 + uncertified** — committed, no certification test found.
- **NOT ON R1** — absent from `8fc3673` entirely, not an ancestor.
- **IN PROGRESS in another worktree** — uncommitted, actively being edited in `C:/temp/sok-r1`
  right now (not run, not touched — observed only via `git diff` in that worktree last session).
- **PRODUCTION ALREADY HAS IT** — `d592d8f` (deployed) already contains this, at least as an
  older/unenforced variant.
- **EXTERNAL OPERATIONAL BLOCKER** — not a code or deployment problem; something outside the
  repo (a third-party account, a billing state) is what's actually blocking it.

Where an item is genuinely two things at once (built-and-tested but also blocked by something
external, or production has an older variant while r1 has the certified fix), both are stated —
forcing a single label onto a two-part fact would lose the fact.

---

## The manifest

| # | Feature | Classification | Evidence |
|---|---|---|---|
| 1 | Recovered rails (`expireBoosts`, 48h commission receivable, `pickupHandover`) | **ON R1 + certified** | new exports vs. `d592d8f` (1514→1519); `test-pickup-handover.js` 21/0, `test-commission-collection.js` 59/0, `test-boost-ranking.js` 33/33, `test-c2b-commission-caller.js` 18/0 — all re-run clean |
| 2 | Tenant authority (`functions/tenant-authority.js` + 4 binding commits) | **ON R1 + certified** · production has **no** tenant-scoping on these callables at all (not "older variant" — the concept doesn't exist there yet) | `test-tenant-authority.js` 46/0 — the script's own output states the unbound resolver is still what production runs |
| 3 | POS document authority | **ON R1 + certified** | `test-pos-inventory-doc-authority.js` 45/0 |
| 4 | Procurement authority (Model C) | **ON R1 + certified** | `test-procurement-tenant-authority.js` 64/0 |
| 5 | Merchant authority (`functions/merchant-authority.js`) | **ON R1 + certified** | `test-merchant-authority.js` 40/0 |
| 6 | Warehouse authority (`functions/warehouse-authority.js`) | **ON R1 + certified** | `test-warehouse-authority.js` 42/0 |
| 7 | Warehouse management UI (`inventory.html`) | **ON R1 + certified**, scope caveat: the test's own note says live page-render is not exercised by the unit suite | `test-warehouse-ui.js` 30/0 |
| 8 | Supplier Hub (`sokoni-merchant-supplier-hub.js`) | **ON R1 + certified**, ships in a deliberately empty state until its underlying ops deploy | `test-supplier-hub.js` 36/0 — script's own note: dependent ops "are NOT DEPLOYED, and the tenant inventory collections hold zero rows" |
| 9 | Receipt bridge (`functions/receipt-bridge.js`) | **ON R1 + certified** | `test-receipt-bridge.js` 53/0 |
| 10 | ADR-017 fix (8 `inventory-{fraud,health,import,pricing,recall,simulate,webhooks,workflows}.js`) | **PRODUCTION ALREADY HAS an older, unfixed variant** of these 8 files · the fix itself is **ON R1 + certified** | files confirmed present at `d592d8f` (older baseline); `test-adr017-authority.js` 63/0 |
| 11 | Authority resurrection gate (`scripts/gate-authority-resurrection.js`) | **ON R1 + certified** — this *is* the certification instrument for #2–10 | run clean on the pure committed tree: *"16 modules, 106 handlers, 85 bound, 4 exempt, 0 FROZEN DEBT — positive controls 8/8 · negative controls 4/4 — GATE PASSED"* |
| 12 | 18a — legacy POS inventory handler retirement | **ON R1 + certified** · production still runs the pre-retirement, larger `pos-inventory-pro.js` | `test-retire-18a.js` 46/0 |
| 13 | 18b — bare `purchaseOrders`/Model D retirement (r1's own numbering) | **NOT ON R1's committed tree** (r1's `ADR-018` only *recommends* it, no execution commit exists yet) · **IN PROGRESS in another worktree** — `C:/temp/sok-r1` has an uncommitted edit removing exactly this, right now | not run, not touched, per the hard boundary — observed via `git diff --stat` last session only |
| 13a | *(context, not a manifest item)* The identical retirement, same target, same zero-caller verdict | already **ON `release/multishop-checkout-certified`**, committed and certified (`2539aad`, `test-retire-18b.js` 20/20) | useful corroboration, per your framing — **not release evidence for r1** until independently committed and verified there |
| 14 | 18c — `posPurchaseOrders`/`posBatches` disposition | **NOT ON R1** (no execution exists anywhere) — blocked, not merely absent: r1's own `ADR-018` states retirement is "NOT authorised... as a single slice" pending product decisions on the ERP webhook and the 4 BI readers | `docs/adr/ADR-018-...md@d627355` (r1) + `ADR-018c` (evidence branch) — same open questions on both |
| 15 | Premium messaging server functions (`reactToMessage`, `addRiderToConversation`, `expireOldChatMessages`) | **STATUS: BUILT · CERTIFIED · ANCHORED · NOT ON R1 · NOT DEPLOYED.** Five distinct, independently-true states — not "missing" (it exists, tagged and verified) and not "ready in production" (it isn't on the release branch's ref at all yet). Updated 2026-09-03 — surgically transplanted, certified, committed. See `docs/PREMIUM_MESSAGING_TRANSPLANT_RESULT.md`. Committed as `96c3244` in an isolated detached-HEAD worktree, parent exactly `8fc3673`, purely additive (271 insertions, 0 deletions). Full r1 certification suite (gate + 16 scripts) re-run clean; a new isolated test (39/39) covers all three functions' own logic directly. **`release/r1-pos-printer-fn`'s branch ref was deliberately NOT moved** — `C:/temp/sok-r1` has unrelated in-progress work (18b) and moving the ref would disrupt that dirty worktree. The commit is anchored by tag `pending-premium-messaging-r1` so it isn't lost, ready to fast-forward once that worktree is clean. | `96c3244` (tag: `pending-premium-messaging-r1`), parent `8fc3673` — not yet reachable from any branch |
| 15a | Premium messaging client (`chat.html` composer/filter/reaction UI changes) | **NOT transplanted in this slice** — deliberately deferred; `chat.html`/`sokoni-chat-engine.js` are byte-identical to r1's base already (per the patch plan), so this is a separate, lower-risk port not attempted here | `9fe09e2`, evidence branch only |
| 16 | KASS AI — `sokoniChat` (customer widget) | **PRODUCTION ALREADY HAS IT** (deployed, correctly routed, identical code on both branches — predates the branch split) **+ EXTERNAL OPERATIONAL BLOCKER** (Anthropic account credit exhausted) | `docs/KASS_AI_AVAILABILITY_AUDIT.md` — live-probed, 10/14 real 30-day requests = 500, root cause captured verbatim from stderr |
| 17 | KASS AI — `kass` (admin agent) + 6 role pages | **PRODUCTION ALREADY HAS IT** (deployed) · role pages additionally: wrong SDK method, but effectively unreachable (no real nav path) | same audit |

---

## What this manifest establishes, plainly

- **12 of the 17 items are ON R1 + certified** — real, tested, committed work sitting cleanly
  ahead of production, not deployed yet.
- **1 item (ADR-017) is a fix layered on top of an older variant production already runs** — the
  clean "older variant" case your framing anticipated.
- **1 item (18b) is not yet committed anywhere on r1** — it's mid-edit in the dirty worktree right
  now, corroborated by (but not equivalent to) an already-certified retirement on the evidence
  branch.
- **1 item (18c) is genuinely blocked**, not missing — the same open product questions exist on
  both branches.
- **1 item (premium messaging) doesn't belong to either production-adjacent lineage** and needs
  its own assessment before joining the r1 stack.
- **KASS AI is fully deployed and is not a deployment-scope item at all** — its only path forward
  is the operational one you named: restore Anthropic credit → live-probe `/api/chat` → verify.

## What this manifest does NOT do

- Does not merge, cherry-pick, stage, or commit anything, on either branch.
- Does not touch `C:/temp/sok-r1` — confirmed untouched before and after this work
  (`git worktree list` unchanged).
- Does not decide the order in which "NOT ON R1" or "IN PROGRESS" items get taken onto r1. That's
  the next decision, explicitly deferred per your instruction: "only after this manifest is frozen
  should we start taking the remaining missing items onto r1, one certified commit at a time."

## Related

`docs/R1_RELEASE_STACK_MATRIX.md` (the fuller per-commit trace this manifest classifies) ·
`docs/RELEASE_LINEAGE_RECONCILIATION.md` (the branch-topology finding) ·
`docs/KASS_AI_AVAILABILITY_AUDIT.md` · `docs/RELEASE_STACK_LEDGER.md`
