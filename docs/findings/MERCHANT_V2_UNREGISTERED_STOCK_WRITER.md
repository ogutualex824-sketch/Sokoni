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

---

## The "does anything rely on it?" proof — and it inverts the expected answer

Before deleting `stock` from `_productFields`, the question was whether the Products editor
legitimately relies on create/update to establish stock. **It does — and not only at create.**

`sokoni-merchant-products.js:1474` renders a real, editable field:

```js
fld('stock', 'Stock', 'type="number" inputmode="numeric" min="0" step="1"', p.stock)
```

The chain is live from keystroke to document:

```
"Stock" input (:1474)
  → data-pf="stock" → captureForm() → S.editor.values.stock
  → fieldsFromForm()      FORM_KEYS = [name, price, costPrice, stock, sku, category, description, status]
                          NUMERIC   = { price:1, costPrice:1, stock:1 }
  → createProduct(product) / updateProduct(patch)
  → _productFields()      allowlists out.stock
  → merchant-v2 writeProduct adapter
  → create: tx.set(ref, data)                    transaction, but for REPLAY idempotency
    edit:   setDoc(ref, data, { merge: true })   no transaction at all
       ↑ neither carries inventoryVersion, neither floors at zero
```

### This contradicts the module's own header, twice

`sokoni-merchant-products.js` states:

> *"Still absent, deliberately: no stock adjustment (Inventory owns that)"* — line 18
> *"This surface shows stock as a READ and offers no way to change it. The two must not merge."* — lines 37–38

Both are false as written. The surface offers a numeric Stock input and writes it. The prose
describes the intended design; the code implements a different one. **The prose is not the
authority — `fld('stock', …)` is.**

### Therefore the fix is NOT deletion

Removing `stock` from `_productFields` would leave a visible, editable "Stock" field in the
Products editor that silently stops saving. A merchant would type a figure, press save, see
"Changes saved.", and the shelf count would not move — a fabricated success, and a worse defect
than the one being fixed.

The correction has to be deliberate, and it has at least three parts:

1. Decide whether product **create** may declare an opening stock. If yes, it needs an explicit
   adapter into the inventory authority — a transactional write carrying `inventoryVersion` — not
   a field smuggled through the metadata writer.
2. **Edit must stop writing stock through this path** regardless. Changing stock on an existing
   product is inventory movement, and `merchantAdjustStock` already owns it.
3. The editor's Stock field must then either disappear from edit mode, or route to the inventory
   authority and *say so*. Whichever is chosen, the module header must be corrected — it currently
   documents a design the code does not implement, and a future reader trusting it would be
   misled exactly as this investigation nearly was.

### Scope

None of this belongs in the print bridge. It is an inventory-authority slice with its own proof
obligation, and it is now the sole remaining blocker between the frozen printer implementation and
a hosting deploy.
