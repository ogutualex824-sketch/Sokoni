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

### 2. Inventory anti-drift gate  ✅ **DONE**

`scripts/gate-inventory-writers.js` + `scripts/test-gate-inventory-writers.js`
(**PASS 39 / FAIL 0**). Wired into `firebase.json` hosting predeploy and `ci-gates.sh`.
It is a pure static scan — no emulator, unlike `gate-inventory.js` — so it runs
unconditionally rather than being scoped to changed paths.

- [x] Match `updateDoc` / `setDoc` calls targeting `products/{id}` — **not** bare
      `stock:` keys. Structural: it locates a write CALL, resolves the TARGET to a
      collection, resolves the PAYLOAD, and only then asks whether an authority field
      (`stock` · `sold` · `inventoryVersion` · `stockQty`) is written. An error message
      containing the word cannot match — proven against the real
      `functions/inventory-engine.js` text that produced the original false positive.
- [x] Distinguish legitimate product create/update payloads — a `{name, price, images}`
      create carries no authority field and is invisible to the gate.
- [x] Mutation-prove by restoring the `pushStock` absolute write **and** its queue.
      Both retired forms are reconstructed and detected, plus the `seller-wiring`
      increment form and `SokoniDB.updateProductStock`. A *renamed* replay queue is
      caught at its write site, which is the only place a queue can do harm.

**Corrections to this item as written.** Two of its assumptions were wrong:

- *"the three legitimate server writers"* — there are **eight server files, 14 write
  sites**. The "three" came from my own earlier `sold:` grep and was never verified.
  The register is now **derived** (`--derive` mode), not assumed.
- The gate keys on **file + site count**, not function name. Name attribution was wrong
  on 8 of 15 sites because the writes sit inside anonymous `runTransaction` callbacks,
  and a key that breaks under refactoring makes the gate fail for the wrong reason.

**A blind spot the gate found in itself.** The first matcher understood only
`collection('products').doc(id)`. `warehouse-scanner.html:818` writes canonical stock
through ``db.doc(`products/${product.id}`)`` — a path-form template literal — and was
invisible. Fixing that surfaced two more client writers. Path and concatenated forms are
now covered and regression-tested.

**Declared blind spots** (a gate that cannot see a construct cannot certify its absence,
so these fail as REVIEW rather than passing quietly): a runtime-built collection name;
a write reaching Firestore through an un-registered helper wrapper; and source-only
analysis, which cannot distinguish a reachable writer from dead code.

### 2c. Writer inventory — **the 20-site figure was an undercount**

Running the inventory closed two of the gate's declared blind spots and changed the
answer. `5c03b57` reported **20 sites / 12 files**. The true figure is **30 sites / 16
files**, and the gap was not more writers of the same kind — it was a *class* of writer
the detector could not see.

**Root cause: the gate treated "I cannot read this payload" as "this payload is safe."**
That is the swallowed-denial defect in detector form — the same mistake Step 1B fixed in
`_posSyncCanonicalStock`, reappearing in the tool built to police it. Three payload shapes
were silently dropped:

| shape | example | hidden writer |
|---|---|---|
| spread | `{ ...product, sellerUid }` | `sokoni-db.js:614 saveProduct` |
| function result | `.set(canonical, {merge})` | `sokoni-inventory.js:513 saveProduct` |
| `Object.assign` | `Object.assign({}, patch, {…})` | `seller.js:4275 _persistStockToFirestore` |

A helper-derived collection (`productsCol().doc(id)`) was also invisible; helper-body
resolution now covers it. And one **false** positive was removed: `sokoni-sync.js` writes
`userSync/{uid}/products/{id}`, a per-user subcollection, which an "anywhere in the ref"
match wrongly read as canonical.

**The distinction that makes the inventory usable: authoring vs transactional.**

- **Authoring** — a seller *setting* the stock of their own product. This is how stock
  comes to exist at all; it is legitimate by design, not a duplicate authority.
- **Transactional** — stock mutated as a *side effect* of a sale, reservation or sync.
  This is the class that must have exactly one writer, and the class `pushStock` belonged
  to.

Nine authoring sites across four files are now registered as their own tier. Notably
`seller.js:4275` is the well-built one: it bumps `inventoryVersion`, stamps
`lastStockSource: 'seller-edit'`, and rolls back the local cache on failure rather than
reporting a false success.

> **Residual hazard, recorded not fixed.** Authoring writes are still *absolute* client
> writes. A seller edit landing concurrently with a sale can overwrite the sale's
> deduction — last-write-wins. That is a real convergence problem, but it is **not** the
> pushStock defect and must not be folded into it: retiring an authoring path would remove
> the only way a seller can set stock.

**Current register — 30 sites / 16 files:**

| tier | sites / files | meaning |
|---|---|---|
| SERVER | 15 / 8 | canonical by architecture |
| CLIENT | 1 / 1 | the single sanctioned transactional client writer |
| AUTHORING | 9 / 4 | seller-owned stock edits — legitimate, absolute |
| QUARANTINE | 5 / 3 | known client-side defects, ratchet-down only |

**Remaining blind spots, unchanged and still declared:** a runtime-assembled collection
name (reported, never passed); source-not-behaviour, so reachability is measured per
writer rather than inferred; and the per-file count key, which traps *growth* but not
*substitution* of one writer for another in the same file.

### 2b. Quarantined client-side writers — **3 files, 5 sites, OPEN**

The gate found genuine third-party writers. They are recorded in `QUARANTINE`, which is
**not** an allow-list: the count may only fall, and the gate prints *"QUARANTINE is not a
pass"* on every run. None of these is fixed.

| file | sites | what it does |
|---|---|---|
| `sokoni-wap-definitions.js` | 2 | `wap.register('inventory.reserve'/'inventory.release')` writes canonical `products/{id}.stock` **from the browser** |
| `warehouse-scanner.html` | 2 | cycle count + adjustment write an **absolute** `stockQty`, computed client-side |
| `pos-boss.js` | 1 | `marketplace.pushProducts` publishes an absolute `stockQty` from local POS state |

> **`sokoni-wap-definitions.js` is the significant one.** It duplicates
> `_svcInventoryReserve` / `_svcInventoryRelease` in `functions/wap.js:759-760` — the same
> operation implemented on both sides of the trust boundary, which is the pushStock defect
> class exactly. It is *not* the pushStock overwrite bug: the write is transactional and
> guarded against going negative. But it bumps **no `inventoryVersion`**, so every
> `onSnapshot` listener and the `indexProductUpdate` movement trail miss the change.
> Reachability **measured, not assumed**: loaded by `wap.html`, precached by
> `service-worker.js`.

**Field divergence, noted not fixed.** `functions/pos-retail.js` and
`functions/pos-retail-engine.js` mirror sales to `soldCount`, while `functions/index.js`,
`pos-marketplace-sync.js`, `pos-zero-friction.js` and now `pos.js` use `sold`. Analytics
reconciliation reads one of them. This is a convergence item, not a Step 1B/P0-2 item.

#### Disposition — what each quarantined writer needs

**1. `sokoni-wap-definitions.js` — the WAP engine runs on BOTH sides of the boundary.**
This is worse than a duplicated handler, and the reachability trace is the reason:

```
wap.html:468        imports sokoni-wap-definitions.js  → registers the handlers
wap.html:780        wap.start(defId, …)                → executes steps IN THE BROWSER
sokoni-wap.js:536   this._handlers.get(stepDef.handler)→ the client inventory.reserve
sokoni-wap.js:80    INSTANCES = 'workflowInstances'    → persists instance state
functions/wap.js:39 COLL.INSTANCES = "workflowInstances"   ← the SAME collection
functions/wap.js:118 wapAdvanceWorkflow = onDocumentUpdated(`${COLL.INSTANCES}/{id}`)
functions/wap.js:759 _dispatchHandler("inventory.reserve") → _svcInventoryReserve
```

So a browser-executed step **persists the instance, which fires the server executor on the
same instance**. Two engines advance one workflow. Same-step double execution is mitigated
only by ordering — the client marks a step `running` and awaits the persist
(`sokoni-wap.js:439-441`) *before* invoking the handler (`:451`), so the server's
`_findReadySteps` sees it claimed. That is a timing-dependent mitigation, **not** an
idempotency key, and it does not stop the two engines racing on *subsequent* steps.

*Exposure is currently narrow:* `marketplace_order` is startable only from the admin
dropdown at `wap.html:288`. No production path starts it automatically.

**Correct disposition: the browser should not execute inventory steps at all** — the
server implementation already exists. Making the client write bump `inventoryVersion`
would be the wrong fix: it would legitimise a client inventory authority. This is an
architectural change to the WAP engine, so under RC freeze it is **flagged, not done**.

**2. `warehouse-scanner.html`** — a physical count legitimately supersedes the running
total, so this is closer to *authoring* than to the pushStock class. It needs the same
treatment `functions/pos-completeness.js` gets server-side (that path exists), plus an
`inventoryVersion` bump. Convert, do not simply delete — deleting removes cycle counting.

**3. `pos-boss.js`** — a merchant-initiated publish of documents it owns
(`products/pos_{biz}_{id}`), not a sale side effect. Lowest risk of the three. It should
route through the same publish path as the rest of the catalogue rather than writing an
absolute `stockQty` from local POS state.

None of the three is fixed. All three remain OPEN.

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
writer* — two named paths, verified.

**Status after P0-2 — and this is the part not to get wrong.** The gate does **not**
promote that to the platform-wide sentence. It answers a narrower question:

> *can a retired client-side inventory writer reappear without the repository gate
> detecting it, while legitimate server writers remain allowed?* — **No.**

That is a statement about **future drift**, enforced going forward. It is not a statement
that only one writer exists today. In fact the gate proved the opposite: it found **three
client-side writers across five sites** (§2b), all still open. The honest wording is now:

> Canonical `products/{id}` stock has one sanctioned writer per path — server-side
> Cloud Functions, and `_posSyncCanonicalStock` on the client — plus **five quarantined
> client-side writes that are known defects**, and a gate that prevents a sixth.

The unqualified *"the platform has exactly one inventory writer"* still requires the
repo-wide **writer inventory**, and the gate's own declared blind spots are precisely why
it cannot substitute for one: a runtime-built collection name, a write behind an
unregistered helper, and dead-vs-reachable code are all invisible to source analysis.
Retire the overclaim only when the quarantine reaches zero *and* the inventory is complete.

**Status after the writer inventory (§2c).** The inventory ran and *moved the answer
further away*, which is the outcome to trust rather than the reassuring one. The gate's
20 sites were an undercount; the real figure is 30 across 16 files, because the detector
was silently dropping payloads it could not read. The claim is now:

> Canonical `products/{id}` stock is written by **15 server sites** (canonical by
> architecture), **one** sanctioned client transactional writer, **nine** seller-authoring
> sites that are legitimate but absolute, and **five quarantined client-side defects**.
> A gate prevents a sixth from appearing unnoticed.

That is a *census with a ratchet*, not a single-writer proof — and it is the strongest
statement the evidence supports. The honest summary of this phase: **the inventory found
that the previous inventory was wrong.** Any future claim of completeness should assume
the same is true of this one until a differently-shaped check disagrees.
