# inventoryReceivePO — read-only trace

**Status:** 📋 READ-ONLY TRACE. No code changed, no deploy, no r1 touch.
**Date:** 2026-09-03 · **Verdict: NOT a clean retire — REWRITE/CONVERGE.**
Real reachable caller + real actively-written target collection both exist; deleting it outright
would remove a live (if unexercised) UI path with no replacement.

---

## The three claimed defects — verified against the actual source

`functions/inventory-engine.js:439-515`, `exports.inventoryReceivePO`:

1. **Wrong/disconnected procurement collection.** Reads the PO from
   `tenants/{tenantId}/inventory_purchaseOrders` (line 448). The canonical procurement engine
   (`functions/procurement.js`) creates and reads POs at **`procPurchaseOrders`** (top-level, not
   tenant-scoped) — a completely different collection, confirmed while correcting the 18c discovery
   doc earlier this session (11 call sites in `procurement.js`). `inventoryReceivePO` cannot ever
   see a PO created through the procurement engine, and vice versa — they are two disconnected
   systems that happen to both be called "purchase orders."
2. **Random movement ID.** `const mvRef = tenantCol(tenantId, 'inventory_movements').doc();` (line
   463) — no argument, so Firestore assigns a random auto-ID on every call. The file's own top
   comment claims *"All mutations are idempotent"* (line 4) — this line makes that false for this
   function specifically: a retried call (network blip, double-tap, client retry logic) creates a
   **second** movement document and a **second** increment.
3. **Blind `increment(qty)`, no idempotency guard.** Lines 470-472: `available`, `onHand`, and
   `incoming` are all mutated via `FieldValue.increment(...)` with **no prior check** that this
   exact item/PO combination was already applied. Combined with defect #2, there is nothing in this
   function that would detect or prevent a duplicate receipt from double-counting stock.

All three confirmed by direct read, not assumed from the prior framing.

---

## Callers and reachability — this is NOT an orphan

| | |
|---|---|
| Export | `functions/index.js:10564` (evidence branch) / `:10637` (r1) — `exports.inventoryReceivePO = inventoryEngine.inventoryReceivePO;`, a **standalone onCall**, not behind a dispatcher |
| Frontend caller | `sokoni-inventory.js:845` — `await _callCF('inventoryReceivePO', {...})` |
| Loaded by | `inventory.html`, `inv-dashboard.html`, `inv-product.html`, `inv-products.html`, `inv-ai.html` |
| Navigation | **`inventory.html` is a real, linked seller-role menu item** — `sokoni-nav-engine.js:246`: `{ i:'📋', l:'Inventory', h:'inventory.html', cat:'core' }`. Not an orphan page like several other zero-traffic surfaces found this session. |

## Production invocation evidence (30-day Cloud Logging window, same method as the rest of this session)

```
inventoryReceivePO: state ACTIVE (deployed) — 0 request-log entries in 30d.
  Only cloudaudit.googleapis.com/{activity,system_event} + run.googleapis.com/varlog/system
  entries present, all from the 2026-08-22 redeploy — deployment/startup lifecycle only.
```

**Control, for contrast, not because it changes the verdict:** the *canonical* path this should
arguably converge toward — `procurement.receiveGoods` (wired to the receipt bridge, see below) —
**also shows zero real invocations in the same window.** This is not "broken legacy vs. heavily-used
canonical" — it's "broken legacy vs. correct-but-also-currently-unexercised canonical." Neither
path has proven itself in production yet.

## `inventory_purchaseOrders` — a real, actively-written collection (not dead)

Two real creators found, not just `inventoryReceivePO` as a reader:

- **Server:** `functions/inventory-workflows.js:58` — `db.collection(...'inventory_purchaseOrders').add({...})`.
- **Client, direct write:** `sokoni-inventory.js:807` (`create`), `:821` (`update`), `:1164` (a
  queued-write retry path) — `col('inventory_purchaseOrders').doc(po.id).set(po)`. This is an
  unmediated client Firestore write, the same shape as the `pos-suppliers.js` writer investigated in
  18c. **Whether the served Firestore rules actually permit this write was not re-verified in this
  pass** — flagged, not assumed either way, consistent with the standing rule established in 18c
  not to substitute the repo's rules file for what's actually served.
- Additional readers: `functions/inventory-v2.js:786`, `functions/inventory-health.js`,
  `functions/inventory-simulate.js` all reference the collection.

**This means the collection itself is not a retirement candidate** — real code, on both server and
client, creates and expects documents there. `inventoryReceivePO` is the *receive* half of a real,
if apparently rarely-exercised, feature — not a dead orphan writing into a void.

## The "obvious competing receipt path" — confirmed, precisely

`functions/receipt-bridge.js` (already built and certified on r1: **53/0**, per the 34-commit
matrix) is wired directly into `procurement.js`'s own `receiveGoods`:

```
functions/procurement.js:64   const receiptBridge = require('./receipt-bridge');
functions/procurement.js:699  receiptEventId = receiptBridge.receiptEventIdFor(poId, receiptKey)
functions/procurement.js:721  if (existing.exists && existing.data().status === receiptBridge.APPLIED) ...
functions/procurement.js:765  receiptBridge.stageReceipt(db, batch, {...})
functions/procurement.js:783  const effect = await receiptBridge.applyInventoryEffect(db, tenantId, receiptEventId)
```

`receipt-bridge.js`'s own doc comments state exactly the property `inventoryReceivePO` is missing:
*"Per-line idempotency is claimed by reading the movement document INSIDE the transaction: if it
exists the line has already been applied and its level is not incremented again... ALL READS BEFORE
ANY WRITE, per ADR-013."* It writes to the **same** target collections
(`tenants/{tid}/inventory_levels`, `tenants/{tid}/inventory_movements`) that `inventoryReceivePO`
writes to — correctly, transactionally, idempotently.

So: two functions independently perform "apply a PO receipt to canonical inventory levels."
`procurement.receiveGoods` → `receiptBridge.applyInventoryEffect` does it correctly, already exists,
already certified. `inventoryReceivePO` does the same job against a disconnected PO collection,
without the idempotency guarantee, and has never been observed to run successfully in production.

---

## Verdict: NOT a clean retire

Unlike 18a/18b (zero callers, zero rows, zero everything), `inventoryReceivePO` has:
- a real, reachable frontend caller on a real, linked navigation page,
- a real target collection that real code (server + client) actively writes to.

**Deleting it outright would remove a live UI action** ("receive purchase order" somewhere in the
inventory pages) **with nothing put in its place.** That is a product regression, not a cleanup,
even though the handler itself is buggy and unused so far.

**The disposition question, precisely stated:** does `inventory_purchaseOrders` (the tenant-scoped,
simpler PO model that `inventoryReceivePO`/`inventory-workflows.js`/`sokoni-inventory.js` use)
deserve to keep existing as its own lifecycle, parallel to `procPurchaseOrders`
(`procurement.js`'s fuller engine) — in which case `inventoryReceivePO` should be **rewritten** to
borrow the receipt-bridge's idempotency pattern against its own collection — or should it be
**converged** onto `procPurchaseOrders`/`receiveGoods` entirely, retiring the
`inventory_purchaseOrders` PO model (and its client/server writers) as a whole? That is a product/
architecture decision this trace does not make — it establishes the evidence the decision needs,
per the read-only scope requested.

## What this trace does NOT do

Does not change any code. Does not touch `C:/temp/sok-r1`. Does not decide rewrite vs. converge.
Does not verify whether `sokoni-inventory.js`'s client write to `inventory_purchaseOrders` is
actually rules-permitted in production — flagged as open, not assumed.

## Related

`docs/adr/ADR-018c-purchase-order-batch-disposition.md` (the `procPurchaseOrders`/`posPurchaseOrders`
collection-name findings this trace builds on) · `docs/R1_RELEASE_STACK_MATRIX.md` (receipt bridge
certification, 53/0) · `docs/RELEASE_STACK_LEDGER.md`
