# Release-stack control ledger

**Purpose:** the single inventory of everything implemented-but-not-yet-in-one-authorized-release,
per the release-stack rule adopted 2026-09-03:

```
IMPLEMENT → CERTIFY → COMMIT → ADD TO RELEASE STACK → DO NOT DEPLOY
(repeat per slice)
... then: full regression → hosting verification → Functions export/capacity verification
         → release gate → ONE authorized deployment → production verification
```

**Governing distinction, never collapse it:** `BUILT ≠ CERTIFIED ≠ DEPLOYED ≠ VERIFIED LIVE`.
A row's "source exists" is not "the feature is live."

**Branch roles (decided 2026-09-03, see `docs/RELEASE_LINEAGE_RECONCILIATION.md` and
`docs/R1_RELEASE_STACK_MATRIX.md`):**
```
CURRENT RELEASE BRANCH   release/r1-pos-printer-fn        (carries the production lineage;
                                                             d592d8f is its ancestor, tip is 34
                                                             commits beyond it — see the matrix doc)
SOURCE/EVIDENCE BRANCH   release/multishop-checkout-certified   (this session's work: 18b/18c,
                                                             ADR-018/018c, KASS AI audit, this
                                                             ledger itself. FROZEN as a work/evidence
                                                             branch — not stacked toward deployment
                                                             until explicitly reconciled into r1)
PRODUCTION               d592d8f / v632   (UNCHANGED)
HEAD (this branch)       9f2dcb9
FUNCTION EXPORT COUNT    this branch: 1508 · r1 tip (8fc3673): 1519 · d592d8f (deployed): 1514
```

The rows below marked "verified this session" were gathered on the evidence branch before the
branch-role decision above and remain accurate as *evidence*, but per the new policy this branch is
not itself the thing being stacked toward deployment. The authoritative release-stack inventory for
what's actually ahead of production is `docs/R1_RELEASE_STACK_MATRIX.md`.

**Verification-status key**, applies per row, not per document:
- 🟢 **VERIFIED THIS SESSION** — traced with the same method as 18b/18c/KASS AI: real `git`
  ancestry checks, real file reads, and where relevant real Cloud Logging / live production probes.
- 🟡 **FROM PROJECT MEMORY, NOT RE-VERIFIED** — carried from a prior session's memory record.
  Memory is a snapshot in time; treat the status as a *lead to re-check*, not a current fact.
- 🔴 **DISCREPANCY FOUND** — the memory/user-supplied claim did not hold up under a cheap check
  performed this session (specified per row).

---

## Verified this session

| feature/module | source commit(s) | HEAD presence | hosting asset | Functions export/binding | production route | production response | deps/config | certification | deployment status |
|---|---|---|---|---|---|---|---|---|---|
| **KASS AI — customer widget** (`sokoniChat`) | pre-existing, not newly committed this session | 🟢 present | `kass-widget.js` on 104 pages incl. homepage | `exports.sokoniChat` (onRequest), `us-central1`, state `ACTIVE` | `/api/chat` → `sokoniChat` (`firebase.json`, confirmed) | 🟢 **live-probed**: `GET`→405, `POST` no-auth→401, both exact-match code | `ANTHROPIC_API_KEY` secret exists; **account credit exhausted** (see `docs/KASS_AI_AVAILABILITY_AUDIT.md`) | not applicable — pre-existing prod code | **BROKEN IN PRODUCTION** — 10/14 real calls in 30d = 500, root cause is billing, not code |
| **KASS AI — admin agent** (`kass`) | pre-existing | 🟢 present | `admin.html` embedded panel (correct raw-fetch wiring) | `exports.kass` (onRequest), `us-central1`, state `ACTIVE` | direct CF URL, no hosting rewrite | 🟡 not probed (would require an admin token) | same `ANTHROPIC_API_KEY` — likely shares the same exhausted-credit failure (inferred, not measured: 0 real requests in 30d) | n/a | **BUILT + DEPLOYED, availability unverified empirically** |
| **KASS AI — 6 role-page assistants** | pre-existing | 🟢 present | `kass-executive/manager/finance/seller/support/developer.html` | same `sokoniChat` export | none dedicated — pages call `httpsCallable('sokoniChat')`, **wrong protocol for an onRequest fn** | would fail regardless of billing state (protocol mismatch) | n/a | not applicable | **PARTIALLY DEPLOYED / BROKEN**, and effectively unreachable — only 3 of 6 linked, only from `vision-2030.html`, which itself is not linked from real nav (`sokoni-nav-engine.js` has zero references) |
| **Premium messaging — complete unit (server + client)** — `reactToMessage`, `addRiderToConversation`, `expireOldChatMessages`, composer, emoji panel, list filters, delivery/rider cards | `9fe09e2` (source) → transplanted as `96c3244` (server) then `86b4e43` (client, stacked on top) on r1's lineage | 🟢 **fully transplanted, certified, committed as one 2-commit unit** — see `docs/PREMIUM_MESSAGING_TRANSPLANT_RESULT.md` + `docs/PREMIUM_MESSAGING_CLIENT_TRANSPLANT_RESULT.md` | `chat.html`, `sokoni-chat-composer.js` (new), `sokoni-chat-engine.js` | `functions/messages.js` (+270, purely additive) + one `index.js` re-export | reachable via existing `messagesDispatch` (2 of 3 server fns) / new individual export (`expireOldChatMessages`); client wired through the same dispatcher pattern, confirmed correct | full r1 regression (gate) at each step + 39/39 isolated cert (server) + real headless-browser page load, 0 console errors (client) | none found | fast-forwarding `release/r1-pos-printer-fn`'s branch ref — blocked until `C:/temp/sok-r1`'s dirty 18b work is committed | **BUILT · CERTIFIED · ANCHORED (`86b4e43`, tag `pending-premium-messaging-r1`, parent chain `86b4e43`→`96c3244`→`8fc3673`) · NOT ON R1 · NOT DEPLOYED.** Not "missing," not "ready in production" — a real, verified, five-state status distinct from both. |
| **Legacy PO endpoint retirement (18b)** | `2539aad` | 🟢 present | n/a (backend only) | `posSendPurchaseOrder` export removed from `functions/index.js` | n/a | n/a | n/a | **20/20**, `scripts/test-retire-18b.js` | **COMMITTED, NOT DEPLOYED** |
| **ADR-018 index row** | `1f89550` | 🟢 present | docs only | n/a | n/a | n/a | n/a | n/a | doc-only, not a deploy unit |
| **18c discovery + disposition (ADR-018c)** | `44359df`, `a8c94dd` | 🟢 present | docs only | n/a | n/a | n/a | n/a | read-only investigation, no code | doc-only — **no retirement executed**, `posPurchaseOrders`/`posBatches` disposition recorded but not implemented |
| **Procurement "two systems" fix** (`inventory_purchaseOrders`/`inventory_suppliers` ↔ `procPurchaseOrders`/`procSuppliers` reconciliation) | `9acca68` (2026-07-13) | 🟢 present | `inventory.html` | `functions/procurement.js` (`procPurchaseOrders`, 11 call sites, confirmed this session while correcting the 18c doc) | not re-traced this session | not probed this session | not re-verified this session | unknown — not checked | 🟡 **status not established this session** — found while correcting a collection-name error in `docs/POS_18C_DISCOVERY.md`; needs its own HEAD-vs-production ancestry check before assuming it's live |

---

## RESOLVED this session — 18a and ADR-017 provenance

Full trace in `docs/RELEASE_LINEAGE_RECONCILIATION.md`. Summary: **both are real, committed, and
already sitting cleanly 34 commits ahead of deployed production — on `release/r1-pos-printer-fn`
(worktree `C:/temp/sok-r1`), not on this branch.** The earlier note attributing them to
`audit/employee-attribution` was wrong — corrected here. In fact **every** item in the "current
known stacked release" list (tenant/POS-inventory/POS-document/procurement/inventory-engine/
merchant/warehouse authorities, receipt bridge, ADR-017, 18a, warehouse management UI) maps onto a
specific commit in that same 34-commit chain — see the reconciliation doc for the full ordered
list. None of it needs its own separate trace; it's already accounted for as one block, on the
other branch. Not cherry-picked or merged — that decision is explicitly deferred.

Also found in that reconciliation: `docs/adr/ADR-018-legacy-retirement-graph.md` **exists on both
branches under the same path with unrelated content** — this branch's version (18b,
`posSendPurchaseOrder`) and r1's version (broader `pos*`/procurement graph, larger evidence base,
explicitly framed as "retirement NOT authorised... as a single slice"). Read r1's version before
extending this branch's ADR-018c any further — it may already answer the same questions.

## Still queued — not yet re-verified, not resolved by the 18a/ADR-017 trace

| feature/module | status |
|---|---|
| Procurement "two systems" fix (`9acca68`) | 🟡 found on this branch, not traced to deployment — separate from the r1 procurement-authority commits (`c5ff85b`, `af7525f`, `7ec2360`), which are a different effort on the other lineage |

---

## What this ledger does NOT yet do

- Does not decide which branch (`release/multishop-checkout-certified` or
  `release/r1-pos-printer-fn`) is the release-stack branch going forward, or how/whether they get
  reconciled. See `docs/RELEASE_LINEAGE_RECONCILIATION.md` — a provenance report, not a decision.
- Does not authorize deployment of anything. Production remains **d592d8f / v632**.
- Does not change the function export baseline. It remains **1508** (this branch only —
  `release/r1-pos-printer-fn`'s export count has not been measured in this ledger).
- Does not resolve the KASS AI Anthropic billing outage — that's a billing action, out of scope
  for a code/release-stack process.
- Does not resolve the `docs/adr/ADR-018-legacy-retirement-graph.md` filename collision between
  the two branches.

## Suggested next slice

The lineage question (which branch is "the" release stack) blocks adding further implementation
work to this ledger with any confidence — a new row added here today could turn out to belong to
the same "wrong branch" category 18a and ADR-017 were just found in. Resolve that before continuing
the remaining release work, per the agreed order: reconcile lineage → update ledger (done) → then
continue.
