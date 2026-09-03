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

**Baseline at ledger creation:**
```
PRODUCTION            d592d8f / v632   (UNCHANGED throughout this document's construction)
SOURCE BRANCH         release/multishop-checkout-certified
HEAD                  a8c94dd
FUNCTION EXPORT COUNT 1508   (grep -c '^exports\.' functions/index.js — measured 2026-09-03)
```

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
| **Premium messaging** (composer, filters, delivery cards, reactions) | `9fe09e2` | 🟢 present, ahead of production | `messages.html` + `sokoni-chat-engine.js` | Firestore-direct (no new CF found in a quick pass) | linked from `sokoni-nav-engine.js` / `shared-header.js` — real nav | not probed this pass | none found blocking | not established this session | **BUILT + COMMITTED, NOT DEPLOYED** — `9acca68`→`9fe09e2` not reachable from `d592d8f` (`git merge-base --is-ancestor 9fe09e2 d592d8f` → false) |
| **Legacy PO endpoint retirement (18b)** | `2539aad` | 🟢 present | n/a (backend only) | `posSendPurchaseOrder` export removed from `functions/index.js` | n/a | n/a | n/a | **20/20**, `scripts/test-retire-18b.js` | **COMMITTED, NOT DEPLOYED** |
| **ADR-018 index row** | `1f89550` | 🟢 present | docs only | n/a | n/a | n/a | n/a | n/a | doc-only, not a deploy unit |
| **18c discovery + disposition (ADR-018c)** | `44359df`, `a8c94dd` | 🟢 present | docs only | n/a | n/a | n/a | n/a | read-only investigation, no code | doc-only — **no retirement executed**, `posPurchaseOrders`/`posBatches` disposition recorded but not implemented |
| **Procurement "two systems" fix** (`inventory_purchaseOrders`/`inventory_suppliers` ↔ `procPurchaseOrders`/`procSuppliers` reconciliation) | `9acca68` (2026-07-13) | 🟢 present | `inventory.html` | `functions/procurement.js` (`procPurchaseOrders`, 11 call sites, confirmed this session while correcting the 18c doc) | not re-traced this session | not probed this session | not re-verified this session | unknown — not checked | 🟡 **status not established this session** — found while correcting a collection-name error in `docs/POS_18C_DISCOVERY.md`; needs its own HEAD-vs-production ancestry check before assuming it's live |

---

## Named in this session but NOT yet re-verified — the queue

These are carried from **project memory**, not fresh evidence. Two of them already failed a
cheap check (ancestry against this HEAD) and are flagged 🔴 rather than silently accepted.

| feature/module | memory's last-known status | HEAD presence (this session) | next check needed |
|---|---|---|---|
| **Legacy retirement 18a** | commits `8fc3673` "retire legacy POS inventory handlers", `d627355` "map legacy inventory retirement dependencies" | 🔴 **DISCREPANCY** — `git merge-base --is-ancestor 8fc3673 HEAD` and same for `d627355` both return **false**. Neither commit is an ancestor of `release/multishop-checkout-certified` HEAD. They exist on a different lineage (seen earlier this session on `audit/employee-attribution`, worktree `C:/temp/sok-empaudit`). | Before treating 18a as "part of the stack," confirm whether it needs to be cherry-picked/merged onto this branch, or whether it was never meant to be — do not assume it's already here. |
| **ADR-017 (inventory authority debt)** | commit `59d2225` "fix: close ADR-017 inventory authority debt" | 🔴 **DISCREPANCY** — `git merge-base --is-ancestor 59d2225 HEAD` returns **false**. Not present in this branch. No `docs/adr/ADR-017-*.md` file exists in the current tree either. | Same as above — locate which branch/worktree actually holds this and decide whether it belongs in the stack. |
| Tenant authority (`merchantId` boundary) | 🟡 P1 open defect — 8+ callables take caller-supplied `merchantId` with no ownership binding | not checked this session | re-run the same caller-graph + live-probe method used for KASS AI |
| POS inventory authority | 🟡 various — canonical model is `tenants/{tid}/inventory_*` (ADR-015); `pos*` collections are the ones just audited in 18c and found largely inert | overlaps directly with 18c findings this session | no new check needed beyond 18c; already covered |
| POS document authority | 🟡 not detailed in this pass | not checked | needs its own trace |
| Procurement authority | 🟡 partially touched — see `9acca68` row above | partially checked (found, not traced) | finish the trace: is it deployed, does `inventory.html` still call it, what's the current caller graph |
| Inventory engine authority | 🟡 ADR-015, `sokoni-inventory-v2.js` → `inventoryCreateBatch` etc. (touched in 18c as a contrast case, not audited itself) | touched, not audited | own trace |
| Merchant authority | 🟡 multiple open items in memory (`project_merchant_auth_boundary`, live defect: shell guard inert) | not checked this session | own trace |
| Warehouse authority / Warehouse management UI | 🟡 commits exist on this branch touching "warehouse" (`0fb5d4b` Logistics+ Sprint 4.4 includes Warehouse; `0830f57` consolidation) — not the same thing as `pos-inventory-pro.js`'s `posWarehouses`, which 18c already covers | some commits confirmed present via `git log HEAD -i --grep=warehouse`; not traced to a deploy/route level | own trace — and clarify this is a *different* warehouse surface than 18c's `posWarehouses` |
| Receipt bridge / Receipt Contract | 🟡 memory: "LOCKED 113/0; global is SokoniReceiptDoc; not deployed" | `git log HEAD -i --grep=receipt` shows real receipt-related commits present (e.g. `fd06114` receipt truncation fix) but the specific "Receipt Contract"/bridge commit was not identified this session | own trace — locate the specific commit(s), confirm HEAD presence and deployment status |

---

## What this ledger does NOT yet do

- Does not cover every item the user's original "current known stacked release" list named
  (tenant/POS inventory/POS document/procurement/inventory engine/merchant/warehouse
  authorities, receipt bridge) at KASS-AI depth. Those are queued above, not audited.
- Does not authorize deployment of anything. Production remains **d592d8f / v632**.
- Does not change the function export baseline. It remains **1508**.
- Does not resolve the KASS AI Anthropic billing outage — that's a billing action, out of scope
  for a code/release-stack process.

## Suggested next slice

Given the 🔴 discrepancies found (18a and ADR-017 are *not* on this branch, contrary to how they
were named), the next cheap, high-value step is resolving **where** that work actually lives before
adding more items to the queue above — otherwise the ledger inherits the same "I assumed it was
already here" gap it exists to prevent.
