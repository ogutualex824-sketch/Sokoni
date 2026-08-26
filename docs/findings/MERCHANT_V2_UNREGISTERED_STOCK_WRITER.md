# merchant-v2's product writer can write `products.stock` outside the single writer

**Status:** OPEN — **deliberately NOT registered** · **Pre-existing** · **Found:** 2026-08-26
**Blocks:** hosting deploy (`gate-inventory-writers` → GATE FAILED)

Related: [[project_merchant_product_writer_2b0]] · [[project_product_limit_integrity]] ·
[[PRINT_BRIDGE_E2E_CHECKLIST]]

---

The inventory-writers gate refuses the hosting deploy:

```
VIOLATION — inventory authority write in an unregistered file:
  merchant-v2.html:1800  fn=writeProduct     writes [?]
  merchant-v2.html:1795  fn=runTransaction   writes [?]
```

The question the gate poses is *"is this an approved authority that merely needs registering, or a
real violation?"* It was answered before touching the gate. **It is a real violation.**

## Four things, each checked

**1. It is a raw Firestore write, not routed through a registered writer.**

```js
var ref  = m.fs.doc(window.firebaseDB, 'products', o.id);
var data = Object.assign({}, o.data, { updatedAt: m.fs.serverTimestamp() });
… tx.set(ref, data)                       // create
… m.fs.setDoc(ref, data, { merge: true }) // update
```

**2. It can carry `stock`.** `SokoniMerchantData._productFields()` allowlists
`name, price, costPrice, sku, category, description, status, lowStockThreshold, **stock**`. So a
product write through the authority reaches this adapter with `stock` in the payload.

This directly contradicts `sokoni-merchant-data.js`'s own header, which states the module *"has no
stock-writing function at all — not one. Inventory movement is `products.stock` inside a
transaction with `inventoryVersion`."* The prose and the allowlist disagree, and the allowlist is
what executes.

**3. It writes stock WITHOUT the invariant.** The payload is `o.data` plus `updatedAt`. There is no
`inventoryVersion: increment(1)`, and no floor-at-zero. The standing rule is that stock deductions
write `stock` + `updatedAt` + `inventoryVersion` **together, atomically**. The `create` path uses a
transaction, but for idempotency (claim-the-same-doc-on-replay), not for stock authority. The
`update` path is a plain `setDoc(..., {merge:true})` — no transaction at all.

**4. It is pre-existing, and not a side-effect of the print work.** `merchant-v2.html` appears
**nowhere** in the register (`SERVER`/`CLIENT`/`AUTHORING`/`QUARANTINE`) — it was never registered,
rather than newly falling out. Measured against baseline `0b8e46a`: `writeProduct` references
**1 → 1**, and the print-bridge diff adds **0** product or stock writes.

## Why it is NOT being registered

Registering it would record a raw `products.stock` write, performed outside a transaction on the
update path and without `inventoryVersion`, as an approved authority. That is not registration —
it is **hiding an architectural violation behind a green gate**, which is precisely what the gate's
own message warns against:

> *If this genuinely IS a new authority, that is an architectural decision: add it to the register
> with a reason. **Do not weaken the detector.***

Adding a `QUARANTINE` entry is equally wrong here: quarantine records *known client defects that are
not yet fixed* and explicitly *"is not a pass"* — the gate still fails on quarantined sites, so it
would not unblock the deploy either, and it would imply the defect had been triaged when it has
only just been found.

## What the fix looks like — its own slice, with its own proof

Not attempted here; the print bridge is frozen and this is unrelated to it.

1. **Drop `stock` from `_productFields` on the UPDATE path.** Creating a product with an opening
   figure is a declaration; changing it later is inventory movement and belongs to the single
   writer. This is the smallest change that makes the prose true.
2. Then decide whether product **create** may set an opening stock at all, or whether it must be
   `null` with the first movement supplying it. `null` is consistent with the existing "never
   render unknown stock as 0" rule.
3. Only after the writer genuinely cannot touch stock authority, register `merchant-v2.html` as a
   product-metadata writer, with the reason.

## Consequence today

`gate-inventory-writers` fails, so `test-inventory --gate` fails, so **hosting cannot deploy**.
The printer-host panel therefore cannot reach production and the five-ones physical test cannot
run — on a blocker that predates the print bridge entirely.
