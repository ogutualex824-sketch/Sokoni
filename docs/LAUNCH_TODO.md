# SOKONI — Launch TODO (current release candidate)

> **Scope:** the operational to-do for the undeployed candidate on `rc/combined`.
> It supersedes nothing. Standing standards live in [[LAUNCH_READINESS]]
> (*Engineering Complete ≠ Production Proven*), the checklist in [[LAUNCH_CHECKLIST]],
> and the historical record in [[LAUNCH_CERTIFICATION]].
>
> **Rule for this document:** nothing is marked DONE without evidence, and no
> `SKIP` / `ENV` / "not runtime verified" is ever recorded as `PASS`.

---

## State

```
LIVE       8290102     ← carries a known production checkout P0 (see P0-3)
CANDIDATE  rc/combined HEAD   ← 0e13db2 + Step 1B; all commits reviewed + mutation-tested
TREE       clean
DEPLOYED   nothing from the candidate
WORKTREE   C:/temp/sokoni-follow-rc      (a second worktree C:/temp/sokoni-beta also exists)
```

> The candidate is named by branch, not by SHA, because it advances. The **deploy** is what
> gets pinned to one exact SHA, and the combined gate must pass against that same SHA.

**No deployment until the combined gate passes against one exact SHA.**

---

## P0 — money / inventory

### 1. `pushStock` — legacy absolute inventory authority  ✅ **DONE — Step 1B**

> **Evidence:** `scripts/test-pos-canonical-stock.js` → **PASS 53 / FAIL 0**, function
> lifted verbatim from `pos.js` and run against a mock Firestore. Full matrix below green,
> plus 7 negative controls (every removal detector fires on the replayed retired code) and
> 5 mutation proofs (each guard proven load-bearing). Files: `pos.js`, `pos-omni.js`,
> `pos-modules.js`. **Not deployed** — ships with the candidate.
>
> One correction to the audit above: `pos-modules.js` loads *after* `pos-omni.js`
> (`pos.html:1562` → `1587`) and overwrote `window.PosOmni`, so the implementation that
> actually ran in production was the bare `updateDoc` at `pos-modules.js:410` — the one
> with **no** offline queue and **no** error handling. Both are retired.

`PosOmni.pushStock` writes an **absolute** local stock level to canonical
`products/{id}`: no transaction, no `inventoryVersion`, no `sold`, no flooring, sourced
from IndexedDB, with an offline queue that **replays a stale absolute value**.

Race: canonical 10 → buyer orders 3 → server sets 7 → POS pushes local 9 → **the 3-unit
sale is erased.**

*Audit complete.* The correct path already exists and already runs on every sale:

```
pos.js:1207  adjustStock(item.id, -item.qty, 'sale:'+txn.id)
   → pos-db.js:252  _posSyncCanonicalStock(id, delta, reason)
   → runTransaction: stock = max(0, stock+delta), inventoryVersion+1, lastStockSource
```

So `pushStock` is **redundant, not load-bearing**. `pos-v2.html` does not call it (it uses
`posCompleteCheckout` with an idempotency key). Only the legacy `pos.js` terminal does.

**Step 1B change set — no scope expansion:**

- [x] Remove the `PosOmni.pushStock` call at `pos.js:1357`
- [x] Retire `pushStock`, `_queuePush`, `_pendingPushIds`, `_flushPendingPushes` in
      `pos-omni.js` **and** `pos-modules.js` (two implementations, same global)
- [x] Add `sold` atomically inside `_posSyncCanonicalStock`'s transaction — *classified by
      reason*: `sale:` increments, `refund:`/`void:`/`rollback:` reverse,
      `purchase_order:`/manual correction leave it alone. Receiving stock is not a sale.
      Written as a floored absolute inside the transaction rather than `increment(qty)`,
      because `sold` must not be able to go negative on a reversal.
- [x] Replace the swallowed `catch (_) {}` with an observable failure — every call returns
      a classified outcome (`synced`/`denied`/`failed`/`deferred`/`unavailable`/
      `not-canonical`/`skipped`), emits `pos:canonical-stock`, records to `PosHealth`, and
      toasts the cashier on a denial (throttled 1/min). The sale is still never blocked.

**Two things the change set did not list, both required to keep it honest:**

- [x] `_posSyncCanonicalStock` now resolves the canonical doc via `marketplaceId || id`.
      It previously used the local id only, so marketplace-linked rows — the exact class
      `pushStock` existed to serve — would have silently stopped converging. Removing a
      defect must not remove a capability.
- [x] `PosOmni.getStatus()` drops `pushCount` / `lastPush`. A permanent `0` reads as
      "pushes happen and none succeeded", which is not what is true.

> **The swallowed denial is a correctness defect, not a logging gap.** A cashier or
> branch till whose uid is not the product's `sellerUid` is denied by
> `firestore.rules:936`, and today that looks identical to success — the merchant
> believes the marketplace converged. Same class as a success toast before the write
> lands.

**Regression matrix — all green in `scripts/test-pos-canonical-stock.js`:**

| scenario | expected | result |
|---|---|---|
| sale qty 1 | stock −1, sold +1 | ✅ |
| sale qty 3 | stock −3, sold +3 (one transaction, not three) | ✅ |
| multi-line | exact aggregate delta | ✅ |
| refund / void | stock +qty, `sold` reversed | ✅ |
| receive (`purchase_order:`) | stock +qty, **`sold` unchanged** | ✅ |
| rollback | original delta reversed | ✅ |
| stock 0 | stays 0 | ✅ |
| stock 2, sale qty 5 | floors at 0, existing oversell contract | ✅ |
| `sold` on over-reversal | floors at 0, never negative | ✅ |
| concurrent marketplace sale | no stale absolute overwrite | ✅ |
| retry | no duplicate mutation | ✅ — *by construction* |
| permission deny | explicit failure, never false success | ✅ |
| offline / no db / non-canonical | reported distinctly, never as success | ✅ |

> **On "retry".** A delta write is *not* idempotent, so this line is satisfied by there
> being **no replay path at all** — not by an idempotency key. The offline queue was
> removed rather than converted, because a queue that re-sends a delta double-counts it.
> Offline is reported as `deferred`; canonical reconcile is the recovery path. If a replay
> queue is ever wanted, it needs a deterministic key first — that is not this change.

### 2. Inventory anti-drift gate  ← **NEXT** (now unblocked)

- [ ] Match `updateDoc` / `setDoc` calls targeting `products/{id}` — **not** bare
      `stock:` object keys
- [ ] Distinguish legitimate product create/update payloads (`_trimPayload` is one)
- [ ] Mutation-prove by restoring the `pushStock` absolute write **and** its queue

> A first attempt at this grepped `stock:` keys and flagged **14 files**, nearly all
> false positives. It was reverted, not shipped. Write it *after* the fix.

**Step 1B leaves two pieces to reuse rather than reinvent** — see
`scripts/test-pos-canonical-stock.js`:

- the **negative-control pattern**: the retired source is replayed through every detector
  and each must fire, so a rule that matches nothing fails loudly instead of reading green;
- the **mutation harness**: `pushStock`'s absolute write is already reconstructed there
  (proof M2, `7 → 9`), which is exactly the mutation this gate has to catch repo-wide.

The gate must also allow the three writers that are *legitimate*: the canonical server
paths (`functions/pos-marketplace-sync.js`, `functions/pos-zero-friction.js`,
`functions/index.js`) and the single client writer `_posSyncCanonicalStock`.

### 3. Live checkout P0 — fixed in candidate, **still live on production**

`ffea917` + `adadf05`. `checkout.html` referenced an unbound `qty`, throwing
`ReferenceError` on every non-empty cart and aborting the summary render.
Before/after: **6/6 threw → 0/6**. Ships with the candidate.

---

## P1 — merchant → buyer synchronisation

- [ ] `sellerProducts` writer/reader trace: `seller.js` (55 refs), `realtime.js`,
      `sokoni-sync.js`, `sokoni-seller-products.js`, POS writers
- [ ] `ministore.html:952` — "delete" rewrites localStorage only; reaches Firestore
      solely via the dynamically-injected `seller-wiring.js` patch (reachability
      measured for checkout, **not** for this path)
- [ ] Pin the sync scenarios: create · price · stock · hide · archive · delete ·
      reopen · POS sale → buyer · marketplace sale → merchant · stale cache cannot
      resurrect · stale CDN cannot delete · cross-tab convergence

**Invariant:** `products/{id}` → canonical catalogue/API → Home / Shop / Marketplace /
Detail. `localStorage.sellerProducts` is offline cache **only**, never a second
authority.

---

## P1 — remaining

- [ ] **18+ SKU audit** — `productId → ageRestricted → reason → evidence → owner`, then
      verify on Home, Shop, Detail, Add-to-Cart, Buy-Now, direct `?id=` links
- [ ] **Reviews** — authenticated submit → reload → approved visible; pending private;
      `ratingsSummary` count matches approved reviews
- [ ] **Follow** — follow → reload → second device → unfollow → refollow; Firestore doc
      is the verdict; no duplicate follow documents
- [ ] **Analytics** — canonical event identity → exactly-once → server aggregate →
      dashboard. Orders must reconcile with inventory and analytics: if 6 units sold,
      analytics cannot say 5 and inventory cannot say 4

---

## Combined gate (before Deploy A)

Every line `PASS`, `PAGE ERRORS 0`, `CRITICAL 0`, `HIGH 0`, `foreignBrowsersAtStart=0`,
`GATE_EXIT=0`, and a real `PASS n / FAIL 0` table — never a wrapper exit code.

`CART · CHECKOUT · PAYMENT INTEGRITY · INVENTORY SINGLE AUTH · POS INVENTORY SYNC ·
CATALOGUE AUTHORITY · SELLABILITY · 18+ ENFORCEMENT · REVIEWS · FOLLOW · MARKETPLACE
SYNC · ANALYTICS RECONCILIATION · FIRESTORE RULES · PRODUCT REVALIDATION · TOMBSTONES ·
SW/ASSET INTEGRITY · MOBILE 390 · TABLET 844 · DESKTOP 1440`

Then: single deploy authority → exact SHA → verify live SHA + assets → 12-minute
stability → re-verify same SHA still live → authenticated checkout / inventory / Follow /
sync verification.

---

## Standing constraints

- **No App Check bypass.** The localhost failure is an unregistered debug bootstrap
  token, gated to `IS_LOCALHOST` in `firebase.js`. **There is no demonstrated production
  auth defect — do not change `firebase.js`.**
- **No resurrection** of `_decrementStock` or `SokoniDB.updateProductStock()`.
- **Do not delete POS capability** to make a test green.
- **One writer at a time:** caller → authority → classify → change → regression → gate →
  commit. Every guard mutation-tested.
- **After each commit, read the actual file contents**, not just the diff stat — a
  corrupted CHANGELOG once shipped behind a clean-looking commit message.

## Correction owed

`0e13db2`'s message claims *"inventory has exactly one writer."* That holds for the
**buyer checkout path only** — `pushStock` was already a counterexample when it was
written. The platform-wide claim is earned by the repo-wide sweep in P0-2, not by
Step 1B. Correct the wording when that sweep passes.

**Status after Step 1B.** The counterexample is now removed, so the pair of commits earns
*the buyer checkout path and the POS terminal each have exactly one canonical inventory
writer* — two named paths, verified. It still does **not** earn the unqualified
platform-wide sentence: nothing yet proves no *third* writer exists elsewhere in the repo.
That remains P0-2's to prove, and the wording stays scoped until it does.
