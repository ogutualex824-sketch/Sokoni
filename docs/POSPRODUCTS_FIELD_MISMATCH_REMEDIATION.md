# `posProducts` — field-mismatch remediation (step 1 of the migration graph)

**Status:** re-verified against current source, implemented, certified 21/21. No migration, no
collection rename, no `seller.js` writer change, no deploy, no r1 touch.
**Date:** 2026-09-03 · Implements step 1 of `docs/POSPRODUCTS_MIGRATION_GRAPH.md` exactly as that
graph ordered it: *"Fix the field-name mismatches first, independent of any migration decision."*
Steps 2 (the `seller.js` writer's fate) and 4 (convergence/migration) are **not** touched here.

---

## One simplification the graph implied but did not spell out — checked, not assumed

Re-reading `seller.js:1065-1070` directly: the marketplace mirror writes `sellerId`, `tenantId`,
`status`, `stockLevel` — and **no `merchantId`, no `branchId` at all**. `posUpsertProduct`
(`pos-inventory-pro.js:1633`) writes `merchantId`, `branchId`, `active` (boolean), `stockQty` — and
**no `status` field at all**.

So every consumer that scopes its query by `merchantId` (#2, #3, #4, #5, #9 in the graph) can
**only ever match `posUpsertProduct` documents** — the `seller.js` schema was never reachable there
in the first place, regardless of any other field. That collapses the fix for those five from "merge
two schemas" to "use `posUpsertProduct`'s real field names": `stockQty` not `qty`/`quantity`,
`active == true` not `status == 'active'`. Single query, no dual-schema logic, no widened read.

Only the two consumers with **no** `merchantId` scope (#10 `self-heal.js`, #11 `pos-inventory.js`)
genuinely see both writers, and only those two got dual-schema handling — and there it is forced by
Firestore itself, not by preference: a single filter cannot compare two different field names, and a
query may carry only one inequality/`!=` clause, so each needs two queries/listeners merged.

## What changed, per consumer

| # | file | before | after | why this shape |
|---|---|---|---|---|
| 2 | `bi-advanced.js` `inventoryHealth` | in-memory `d.qty ?? d.quantity ?? 0` → every product read as 0 stock | `d.stockQty ?? d.stockLevel ?? 0` | in-memory read; query already merchantId+branchId scoped |
| 3 | `business-bootstrap.js` bootstrap fetch | `.where('status','==','active')` — matched **zero** documents from either writer | `.where('active','==',true)` | merchantId-scoped → only `posUpsertProduct` reachable → its field is `active` |
| 4 | `business-bootstrap.js` `getIncrementalSync` | same | same | same |
| 5 | `business-health-score.js` `_scoreInventory` | `.where('qty','<=',5)` + in-memory `p.qty` — low-stock always 0 | `.where('stockQty','<=',5)` + `p.stockQty` | merchantId-scoped. The sibling `expiresAt` query is **left as-is with a comment** — see below |
| 9 | `release-readiness.js` inventory gate | in-memory `qty ?? quantity` → `invalid` always 0 → score always 100 | `stockQty` | merchantId-scoped; the gate now actually gates |
| 10 | `self-heal.js` `checkInventoryIntegrity` | `.where('qty','<',0)` — unscoped, matched nothing | two queries: `stockQty < 0` **and** `stockLevel < 0`, merged by doc id | **unscoped** → both writers relevant; Firestore cannot do this in one filter |
| 11 | `pos-inventory.js` catalogue listener | `.where('status','!=','deleted')` — `!=` excludes documents missing the field, so every `posUpsertProduct` product was invisible to the POS app's own sync | second listener `.where('active','==',true)`, both feeding the same IndexedDB store, both unsubscribed on stop | unscoped; only one `!=` per query allowed; `posDeleteProduct` is a soft-delete (`active:false`, never a Firestore delete), and a doc leaving the `active==true` result set fires `removed` — exactly the semantics the store needs |
| 8 | `procurement.js` `getProcurementForecast` | looked up `${branchId}_${productId}` doc ids, then keyed results by a `d.productId` **field that no writer sets** | plain `productId` ids, keyed by `s.id` | `posUpsertProduct`'s doc id is the plain productId (or `p_<idemKey>`), never composite, and the document never carries its own id as a field — verified by reading the writer, not the reader |
| 12 | `pos-sync.js` delta fetch | `.where('branchId','==',branchId)` — excludes `seller.js`-mirrored docs | **unchanged, deliberately** | not a bug: a marketplace mirror has no `branchId` because it has no branch — it does not belong in a branch-scoped POS inventory sync. The graph listed it as the inverse of #11; on inspection it is correctly scoped, not mis-scoped |

## Two things that look like field mismatches and are not — stated plainly

**`expiresAt` (#5).** Neither writer has ever set any expiry field. Renaming the query would point
it at a field that still doesn't exist. This metric is structurally 0 until product-expiry tracking
is actually built, not because the query spells the field wrong. Left as-is, with a comment saying
so, rather than "fixed" cosmetically.

**`procForecast` has no writer — a NEW finding, deeper than the graph went.** `getProcurementForecast`
reads `procForecast` *first*, and returns an empty `reorderList` if that's empty — before it ever
reaches the `posProducts` lookup fixed above. Grepping `functions/` for `procForecast` finds exactly
three references: the module's own header comment, this read, and `getProcurementDashboard`'s
reorder-alerts read. **Nothing writes it, anywhere.** So this function — and the dashboard's
reorder-alerts panel — is inert end to end for a reason the field fix does not touch. The fix is
still correct and still worth having (independent defect; holds the moment a forecast generator
exists), but it does **not** make the feature work. Building a forecast writer is a materially larger
piece of work than a field-name correction and is not attempted here. Recorded in the function's
header comment and here; not silently folded into "fixed."

## Certification

`scripts/test-posproducts-field-fixes.js` — **21/21.** The four backend fixes are **executed**
against the real shipped functions (stubbed `firebase-admin`/`firebase-functions`; an in-memory
Firestore that reproduces the actual defect-relevant semantics — range and `!=` operators exclude
documents missing the field, `FieldPath.documentId()` `in` queries match on id), with one shared
fixture carrying both writer schemas (`stockQty`/`active` vs `stockLevel`/`status`, with and without
`merchantId`). Each assertion states what the *pre-fix* value would have been (always 0, always 100,
always empty) so a regression is legible, not just a number. `bi-advanced.js` and
`business-bootstrap.js` are certified by comment-stripped source inspection rather than execution —
their auth guards (`_assertMerchantOrAdmin`, `_assertMerchantAccess`) do their own Firestore reads and
were not worth re-implementing for this suite; said so rather than claimed executed. `pos-inventory.js`
(client) is source-inspected. No regression in `test-convertprtopo-fix.js`, `test-procurement.js`,
or `test-seller-handover.js`.

Three modules gained a test-only `exports._h` hook (`_scoreInventory`, `checkInventoryIntegrity`,
`_runDomainCheck`) — the same convention `delivery-complete.js` and `seller-handover.js` already use,
so the suite exercises the shipped function rather than a reimplementation.

## What this slice does NOT do

Does not touch `seller.js`'s mirror writer (graph step 2 — a decision, still open). Does not migrate,
rename, or converge `posProducts` toward `tenants/{t}/inventory_products` (graph step 4). Does not
touch `posProductIndex`. Does not build a `procForecast` writer. Does not touch `pos-sync.js`. Does
not deploy. Does not touch `C:/temp/sok-r1`.

## Related

`docs/POSPRODUCTS_MIGRATION_GRAPH.md` (the graph this implements step 1 of) ·
`functions/pos-inventory-pro.js` (`posUpsertProduct`/`posDeleteProduct` — the reference schema, read
directly) · `seller.js:1065` (the second writer, read directly) ·
`docs/adr/ADR-018c-purchase-order-batch-disposition.md` (same defect shape, found first in
`posBatches`)
