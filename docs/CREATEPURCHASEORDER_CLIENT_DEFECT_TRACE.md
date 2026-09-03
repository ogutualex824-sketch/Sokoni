# `SokoniInventory.createPurchaseOrder` client defect — trace and design

**Status:** 📋 READ-ONLY TRACE. No code changed, no deploy, no r1 touch.
**Date:** 2026-09-03 · Extends r1's own trace (`docs/defects/DEFECT-inventory-createPurchaseOrder-missing.md`
at `8fc3673`, read but not modified — `C:/temp/sok-r1` untouched) with the specific comparisons
requested: which candidate is intended, whether it preserves procurement authority, and why the
call exists at all.

---

## The chain, as requested

```
inventory.html requisition -> PO conversion   convertPRtoPO() — inventory.html:4546-4564
        ↓
exact payload shape                           { status:'draft', supplierId, items, totalAmount,
        ↓                                       requisitionId, expectedDate } — see below, mismatched
        ↓                                       against what the intended backend needs
intended callable/API                          httpsCallable('createPurchaseOrder') —
        ↓                                       ALREADY correctly used elsewhere on this SAME page
        ↓
canonical procurement handler                  functions/procurement.js:322, exports via
        ↓                                       index.js: createPurchaseOrder = procurement.createPurchaseOrder
        ↓
current live/r1 implementation                 identical defect confirmed present on both branches
        ↓                                       (independently re-verified, not assumed from r1's doc)
why the client calls a nonexistent method       a sibling function on the SAME page was already
                                                 fixed to call this correctly; this one was not —
                                                 evidenced below, not guessed
```

## Independent re-verification (not copied from r1's trace)

| check | evidence-branch result |
|---|---|
| `inventory.html` calls `SokoniInventory.createPurchaseOrder` | **1** occurrence, line 4558 |
| `sokoni-inventory.js` defines `createPurchaseOrder` | **0** — it exports `createPO` (line 1348) |
| `SokoniInventoryV2` (`sokoni-inventory-v2.js`) — the module the requisition itself actually uses (`SokoniInventoryV2.updateRequisition`, line 4540/4559) — has any PO-creation method | **0** — checked, r1's trace didn't cover this module; ruled out as a third candidate |

## Exact payload the broken call sends

`inventory.html:4550-4557`:
```js
const poData = {
  status: 'draft', supplierId: pr.supplierId || '', items: pr.items,
  totalAmount: pr.totalEstimate || 0, requisitionId: id, expectedDate: pr.deliveryDate || '',
};
await SokoniInventory.createPurchaseOrder(poData);
```

---

## Which candidate is actually intended — settled by a working sibling on the same page

`inventory.html` has a **second, already-fixed** function creating purchase orders, `submitPO()`
(line 2912), with a header comment (lines 2890-2911) describing the exact same "two purchase-order
systems that had never met" history this session already found in commit `9acca68`. It is currently
**correct and working**:

```js
const call = n => firebase.functions().httpsCallable(n);
const created = await call('createPurchaseOrder')(payload);   // line 2955
```

with payload:
```js
{ merchantId, supplierId, branchId: warehouseId, expectedDelivery, notes,
  items: _poLines.map(l => ({ productId, sku, name, qty, unitCost })) }
```

**This settles which candidate is intended**, by direct evidence rather than inference: the same
page already migrated its other PO-creation path to `httpsCallable('createPurchaseOrder')`, and its
own comment explicitly cites the reason — *"Totals and VAT are computed by the server (the client's
figures are not trusted — CLAUDE.md)."* `convertPRtoPO` is the one call site that was not carried
along with that fix.

## The four comparison questions, answered with evidence

**1. Which one is actually intended for this UI?**
`httpsCallable('createPurchaseOrder')` — the canonical procurement backend. Confirmed by the
working sibling function on the identical page, not assumed.

**2. Does it expect `procPurchaseOrders` or another model?**
`procPurchaseOrders` — `functions/procurement.js:401`,
`db.collection('procPurchaseOrders').doc(poId).set(poData)` (already traced in full during the
`inventoryReceivePO` ADR this session).

**3. Does it preserve supplier/VAT/approval/idempotency behavior?**
Yes, by construction — it's the same function already fully audited: supplier existence +
ownership + active-status validation (`procurement.js:333-341`), server-computed VAT
(`subtotal`/`vatAmount`/`total`), a deterministic idempotent PO id
(`_deterministicId(merchantId|supplierId|Date.now(), 'po')`), transactional sequential PO
numbering, and `approvedBy`/`approvedAt` fields for the approval workflow. None of this exists on
the alternative (`SokoniInventory.createPO`, client-direct write, no VAT, no dedup, no supplier
validation — established during the `inventoryReceivePO`/`posProducts` traces).

**4. Would fixing the client bypass any existing procurement authority?**
**Only if the wrong candidate were chosen.** Reverting to `SokoniInventory.createPO` would bypass
the canonical procurement authority entirely, and would additionally **break a certified,
currently-passing test**: `scripts/test-procurement.js` explicitly asserts `createPO(` is absent
from `inventory.html` (r1's trace already established this; re-confirming the stakes here). Using
`httpsCallable('createPurchaseOrder')` — the intended candidate — bypasses nothing; it *is* the
procurement authority, already proven safe by the sibling `submitPO` call site.

---

## Two gaps a mechanical fix would still need to close — found in this pass, not in r1's

Simply swapping the method name is **not** sufficient, beyond the invocation-pattern change r1
already flagged:

1. **`merchantId` is absent from `convertPRtoPO`'s payload entirely.** `createPurchaseOrder`
   requires it (`procurement.js:329`, `if (!merchantId) _err(...)`). `submitPO` resolves it via
   `_merchantId()` (line 2933) before building its payload; `convertPRtoPO` has no equivalent call.
2. **Item field names don't match.** The requisition's items (built in `savePR()`, line
   4467-4468) are shaped `{productId, productName, qty, costPrice}`. The working `submitPO` call
   sends `{productId, sku, name, qty, unitCost}`. Whether `procurement.js`'s internal
   `_validateItems()` tolerates both naming variants was **not checked in this pass** — flagged as
   the one open question before implementation, not assumed either way.

## One thing that is *not* a gap — checked, not assumed

The requisition's `supplierId` (from the `pr-supplier` dropdown, `inventory.html:4428-4430`) is
populated from `_allSuppliers`, the same list `submitPO`'s `po-supplier` dropdown uses — both
sourced from `SokoniInventory.getSuppliers()`, which reads `procSuppliers` (confirmed by this
page's own comment at line 2318: *"Read from `procSuppliers` — the collection the procurement
Cloud Functions actually validate against... One supplier list."*). **The supplier model is already
unified.** A fixed `convertPRtoPO` would not hit a "supplier not found" error on that account —
this part of the two-systems problem was already resolved elsewhere on this page.

---

## Why the client is calling a nonexistent method — evidenced, not guessed

Both `submitPO` and `convertPRtoPO` create a purchase order on the same page. `submitPO` was
migrated to the canonical `httpsCallable('createPurchaseOrder')` pattern as part of the same
history that unified the supplier model (`9acca68`'s "two purchase-order systems" fix,
per that commit's own message, already read in full this session). `convertPRtoPO` was not
migrated in that same pass — it still reaches for a `SokoniInventory.*` module call, matching the
*pre-fix* convention (`SokoniInventory.createPO()`), but with the *post-fix* method name
(`createPurchaseOrder`) substituted in without also substituting the invocation pattern. That
combination — old call shape, new name — is what evaluates to `undefined` today.

## What this trace does NOT do

Does not change `inventory.html`, `procurement.js`, or any test. Does not confirm whether
`_validateItems()` accepts `productName`/`costPrice` as aliases for `name`/`unitCost` — the one
remaining check before implementation. Does not touch `C:/temp/sok-r1`.

## Related

`docs/defects/DEFECT-inventory-createPurchaseOrder-missing.md` (r1, `8fc3673` — the trace this
extends) · `docs/adr/ADR-INVENTORYRECEIVEPO-disposition.md` (the same `procPurchaseOrders` capability
audit this trace reuses) · commit `9acca68` (the prior "two PO systems" fix `submitPO` already
benefited from)
