# `seller.js` → `posProducts` mirror writer — retirement graph (read-only)

**Status:** 📋 READ-ONLY GRAPH. No code changed, no rules changed, no `posProducts` backend handler
touched, no deploy, no r1 touch.
**Date:** 2026-09-03 · Scoped specifically to the writer disposition decided in
`docs/POSPRODUCTS_SERVED_RULES_GATE.md` (Option C, retire). Does not open the broader 14-consumer
migration — that stays closed until this writer's fate is settled and executed.

---

## 1. The write — one site, one trigger, never kept in sync afterward

**Write site:** `seller.js:1065-1070`, inside `async function addProduct()` (starts line 709).
Confirmed by a full-file grep: `posProducts` appears at exactly two lines in `seller.js` — the write
itself (1065) and one comment (1029). No other function in the file references the collection.

**Trigger:** `seller.html`'s "🚀 Publish Product" button (`seller.html:947`,
`onclick="addProduct()"`) — the only trigger. Confirmed `seller.js` is loaded by exactly one HTML
file in the repo (`seller.html`), and `seller.js:4139` explicitly exports
`window.addProduct = addProduct`, matching the button's global-scope call.

**Never updated, never deleted.** Checked the file's other product-lifecycle functions directly,
not assumed:
- `saveEditProduct()` (`seller.js:1692`) — edits an existing product. Does **not** touch
  `posProducts` (confirmed: the collection name does not appear in its body).
- `deleteProduct` — patched externally by `seller-wiring.js` (see §2), which archives the
  canonical `products` doc; also does not touch `posProducts`.

So every mirror document, once created, is permanently frozen at its creation-time price/stock/name
— it never reflects a later edit. This is independent evidence for retirement beyond the rules
finding: even a hypothetical reader that *could* see these documents would be reading stale data by
design, not a maintained mirror.

---

## 2. Same-named functions elsewhere — checked individually, none touch `posProducts`

`addProduct` is not a unique name in this codebase. Traced each occurrence rather than assuming they
share behavior:

| file | relationship to `seller.js`'s `addProduct` | touches `posProducts`? |
|---|---|---|
| `digital-esoko-seller.html:407` | independent, page-local function (digital downloads: file upload, cover image, `dp_` id prefix) | no — confirmed by reading its full body; writes nothing resembling POS/inventory |
| `ministore.html:997` | independent, page-local function, **localStorage only** — no Firestore write in the base function at all | no |
| `seller-wiring.js` (`_patchSeller`, loaded on every page) | wraps `window.addProduct` globally to *additionally* write the canonical `products` collection after the original runs | no — read its `_writeProduct`/`_deleteProduct`/`_decrementStock` bodies in full; `posProducts` does not appear anywhere in this file |

So retiring `seller.js:1065-1070` cannot be confused with, or accidentally affect, either of the
other two `addProduct` implementations or the global wiring patch — they are structurally
unconnected to this collection.

---

## 3. Consumer census — every current reference, re-run this pass (not carried from memory)

Full repo grep for `posProducts`, current as of this commit. Classified by whether retiring the
`seller.js` writer changes anything for each:

### (a) Already structurally excluded — retirement changes nothing
`bi-advanced.js`, `business-bootstrap.js` (×2), `business-health-score.js`, `release-readiness.js`
— all scope their query by `merchantId`, a field the mirror writer never sets (established in
`docs/POSPRODUCTS_SERVED_RULES_GATE.md`). These have never been able to see a mirror document and
will not notice its absence.

### (b) A genuine dual-schema Admin-SDK consumer — explained, not broken
`self-heal.js`'s `checkInventoryIntegrity` (fixed in the field-mismatch slice to run
`stockQty < 0` **and** `stockLevel < 0` in parallel) is unscoped and *would* catch a
mirror-schema document with negative stock. Retiring the writer does not break this check — it
stops **new** `stockLevel`-schema documents from ever being created, so that half of the check
naturally stops finding anything over time as any existing legacy documents are cleaned up or age
out. The check itself needs no code change; it degrades gracefully to "finds nothing on that side,"
which is the correct behavior once there is no writer left to produce that schema.

### (c) Client consumers — already established as rules-blocked regardless of writer
`pos-inventory.js` (two listeners), `pos-sync.js` (delta fetch), `sokoni-reconcile.js` (repair
path) — per the served-rules gate, every client query on `posProducts` is rejected wholesale under
production rules (ownership keyed on `sellerId`, no client filters on it). These consumers cannot
read *either* schema today; retiring one writer does not change their (already-broken) status.

### (d) NEW finding this pass — `marketing-engine.js`, not previously examined this closely

The original migration graph characterized `marketing-engine.js` as "the one consumer with no
field-mismatch risk... reads only `name`/`price`/`category`." Re-reading it in full for this
retirement question found that characterization was **incomplete** — two callables,
`getCrossSellRecommendations` and `getUpsellRecommendations`, run their own queries with the
**same field-mismatch defect already fixed elsewhere**:

```js
.where('merchantId', '==', merchantId).where('status', '==', 'active')   // getCrossSellRecommendations, AI-match step
.where('merchantId', '==', merchantId).where('category', ...).where('status', '==', 'active')  // getUpsellRecommendations
```

`status` is the mirror's field, not the canonical writer's — so **these three queries currently
match only mirror-schema documents.** Retiring the writer would take them from "sometimes finds a
stale mirror doc" to "never finds anything," a real behavior change on paper.

**Checked whether this reaches a real user, not assumed either way:** grepped every `.html` page in
the repo for `getCrossSellRecommendations`/`getUpsellRecommendations` — **zero matches.** Neither
callable is invoked from any page anywhere. They are exported, dormant, reachable only from test/
census scripts. `getUpsellRecommendations` additionally throws `not-found` when its anchor
`posProducts.doc(productId)` lookup misses (`marketing-engine.js:488`) — but that failure mode
already exists today for the (almost certainly larger) set of canonical `products` that were never
mirrored to `posProducts` by either writer. Retirement does not introduce this failure mode; it
only removes one more way a lookup could have hit.

**Verdict: not a legitimate remaining consumer to protect** — no live caller exists, and the two
queries that would go quieter are on their own separate, still-unfixed field-mismatch bug that is
out of scope for this graph (it's a `marketing-engine.js` defect, not a mirror-retirement
consequence — flagged here as its own future item, not fixed).

### (e) Corroborating, non-consumer evidence
`scripts/qa/consistency-audit.js:48-49` already **asserts** `posProducts` should be empty for a
given seller ("legacy posProducts is empty (till reads canonical products)") — an existing QA
check independently treating the collection as legacy. `scripts/census-marketing-authority.js`'s
generated documentation independently states the same ("posProducts was empty for most
merchants"). Neither is a consumer; both are pre-existing signals pointing the same direction as
this graph's conclusion, found by a different author at a different time.

### (f) Explicitly out of scope, not conflated with this decision
`functions/procurement.js:695`'s `receiveGoods` still writes `posProducts` on **this** branch using
a composite `${branchId}_{productId}` doc id — already recorded in the original migration graph
(row #7) as resolved on `release/r1-pos-printer-fn` via the receipt-bridge rewrite, and separately,
that ID scheme matches no real document under *either* schema, so it cannot be mistaken for a
consumer of the mirror specifically. `functions/pos-inventory-pro.js` is the canonical writer, not
a consumer. `scripts/firestore-index-status.js` tracks index *existence*, not data — unaffected by
a writer stopping.

---

## 4. The canonical replacement — already live, already fed by this exact function

`seller.js:1008` (three lines above the mirror write, inside the **same** `addProduct()`) already
writes the canonical `products` collection: `await m.setDoc(m.doc(db,'products',newProduct.id),
fsProduct);` — awaited, primary, unconditional. The mirror write at 1065 is secondary,
fire-and-forget, wrapped in its own try/catch specifically so its failure can never affect this
primary write (`seller.js:1033-1035`'s own comment). Retiring lines 1065-1070 removes nothing the
primary listing path depends on — it was never depended on *by* the primary path, only ever
downstream of it.

Confirmed (in the served-rules gate) that the collection's intended real-world consumer — the
checkout — already reads canonical `products`, not `posProducts`
(`functions/pos-zero-friction.js:346-351`, `pos.js`). The replacement is not proposed; it is
already the live path.

---

## 5. `tenants/{uid}/inventory_products` sync — proven structurally independent, stays untouched

`seller.js:1063-1064` — the line immediately before the mirror write — performs the ADR-015
canonical inventory sync (`tenants/{sellerUid}/inventory_products/{id}`). Read both blocks
side by side:

```js
m.setDoc(m.doc(db, 'tenants', sellerUid, 'inventory_products', newProduct.id), _invProduct, { merge: true })
  .catch(function (e) { console.warn('[SOKONI] inventory sync (non-blocking):', e && e.message); });
m.setDoc(m.doc(db, 'posProducts', newProduct.id), { /* ... */ }, { merge: true })
  .catch(function () { /* POS mirror is best-effort */ });
```

Two independent statements, two independent `.catch()` handlers, no shared promise chain, no
control-flow dependency between them (removing the second does not touch the first's execution).
Both read from the same already-computed locals (`_invProduct`, `_sku`, `_img`, `_wh`) — deleting
the `posProducts` statement leaves every one of those locals still defined and still consumed by
the `inventory_products` write. **Removing the mirror write cannot affect this line by
construction**, not merely by intent.

---

## 6. Conclusion

No legitimate, live consumer depends on future writes from `seller.js`'s `posProducts` mirror.
Every current reader either (a) already structurally cannot see mirror documents, (b) degrades
gracefully to "finds nothing" without erroring, (c) is already blocked at the rules layer
regardless of this writer, or (d) has zero real callers today. The canonical replacement
(`products`) is not a future migration target — it is the same function's own primary, already-live
write, already the real consumer's read path. The retirement is safe to execute as its own slice.

## What this graph does NOT do

Does not remove `seller.js:1065-1070`. Does not touch `pos-inventory-pro.js`,
`pos-inventory.js`/`pos-sync.js`/`sokoni-reconcile.js`, or any other `posProducts` backend handler.
Does not fix `marketing-engine.js`'s own separate `status=='active'` field-mismatch bug (logged as
a distinct, future item — not conflated with this retirement). Does not touch `firestore.rules`.
Does not start the broader 14-consumer migration (graph step 4). Does not deploy. Does not touch
`C:/temp/sok-r1`.

## Related

`docs/POSPRODUCTS_SERVED_RULES_GATE.md` (the disposition this graph executes on) ·
`docs/POSPRODUCTS_MIGRATION_GRAPH.md` (the broader graph, still gated behind this) ·
`docs/POSPRODUCTS_FIELD_MISMATCH_REMEDIATION.md` (the self-heal.js dual-schema check this graph
explains rather than changes) · `functions/marketing-engine.js` (new, separate field-mismatch
finding, not fixed here) · `scripts/qa/consistency-audit.js` (independent corroborating evidence)
