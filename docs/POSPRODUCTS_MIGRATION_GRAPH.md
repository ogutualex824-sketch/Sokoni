# `posProducts` — consumer migration graph (read-only)

**Status:** 📋 READ-ONLY GRAPH. No code changed, no migration, no deploy, no r1 touch.
**Date:** 2026-09-03 · Per instruction: **not a collection rename.** `posProductIndex` (barcode
uniqueness) is a separate concern and is explicitly out of scope here, as already decided.

---

## Headline finding — this is not one collection with 11 clean readers

Before the per-consumer graph: `posProducts` currently has **at least two structurally
incompatible writers**, plus a third, entirely separate canonical collection that a bridge exists
specifically to paper over. The migration question is not "redirect 11 readers to a replacement" —
it's "which of two live, incompatible schemas is the reader even written for," and in several cases
the honest answer is **neither, correctly**.

### Two writers, three field vocabularies

| | `posUpsertProduct` (server, `functions/pos-inventory-pro.js:1565`) | `seller.js` mirror (client, direct write, `seller.js:1065`) |
|---|---|---|
| reachable via | `smartPosDispatch` dispatcher (`_h` registry) — authenticated, `_assertMerchantAccess`-guarded, transactional, idempotent | unmediated client `setDoc`, wrapped in a swallow-everything `catch` (`/* POS mirror is best-effort */`) |
| stock field | **`stockQty`** | **`stockLevel`** |
| identity field | **`merchantId`** | **`sellerId`** (also writes `tenantId`) |
| active/status | **`active: <boolean>`**, no `status` field at all | **`status: 'active'` (string)**, no `active` field |
| `branchId` | always present | **absent** |
| doc ID | plain `productId`, or `p_<idempotencyKey>` | `newProduct.id` (the marketplace product's own ID) |
| purpose, per its own header comment | "Phase 0 pilot blocker" fix — *the only thing in the platform that could create a `posProducts` document* until this was built | mirrors a marketplace `products` listing into POS visibility, "best-effort," errors silently swallowed |

**A third collection is also in play:** `pos.js:259-261`'s own comment: *"a shop whose products
live in the canonical `products` collection (marketplace / seller dashboard) showed a BLANK POS"*
— `pos.js` had to build `_seedCatalogueFromCanonical()` specifically because sellers who never
touch the POS app directly (only list via the marketplace) have products in `products`, not
`posProducts`, and nothing else bridges that gap.

### Consequence, confirmed per consumer below, not asserted in the abstract

Multiple readers query fields that **only one** of the two writers populates — meaning, depending
on *which writer touched a given document last*, a reader may or may not see it, with no error,
no logged warning, just a query that returns fewer rows than the merchant's real catalogue. This is
the same field-mismatch defect shape found repeatedly elsewhere this session (`getExecutiveDashboard`
et al. in 18c) — here it's systemic across at least 6 of the consumers below.

---

## Per-consumer graph

| # | Consumer | Read/Write | Exact fields used | Matches which writer? | Production caller/use | Safe migration note |
|---|---|---|---|---|---|---|
| 1 | `functions/pos-inventory-pro.js` — `posUpsertProduct`/`posDeleteProduct` | **WRITE** (canonical creator) | `merchantId`, `branchId`, `name`, `nameLower`, `category`, `price`, `active`, `unit`, `costPrice`, `salePrice`, `vatRate`, `reorderPoint`, `sku`, `barcode`, `brand`, `supplier`, `stockQty` | — (this *is* the reference schema) | reachable via `smartPosDispatch`; the checkout's actual read path (`pos-zero-friction`) depends on exactly this shape | **do not touch without also updating the checkout read path** — `price`/`stockQty` are load-bearing for real sales |
| 2 | `functions/bi-advanced.js` — `getBranchPerformanceComparison` (`inventoryHealth` metric) | READ | `merchantId`, `branchId`, `qty ?? quantity` ⚠️, `reorderPoint` | **neither** — real field is `stockQty`; this always reads 0 | standalone-exported BI function | fix the field name before any migration — currently silently reports every product as out-of-stock |
| 3 | `functions/business-bootstrap.js` — bootstrap fetch (line 150) | READ | `merchantId`, `status=='active'` ⚠️ | **seller.js writer only** — `posUpsertProduct` docs have no `status` field and are invisible to this query | called on merchant session bootstrap — a real, likely-frequent path | must be fixed regardless of migration — currently excludes every POS-app-created product from the merchant's own bootstrap fetch |
| 4 | `functions/business-bootstrap.js` — `getIncrementalSync` (line 501) | READ | `merchantId`, `status=='active'` ⚠️, `updatedAt` range | same as #3 | incremental sync path | same fix needed as #3 |
| 5 | `functions/business-health-score.js` | READ | `merchantId`, `sku`, `qty` ⚠️, `expiresAt` ⚠️ | **neither cleanly** — `qty` matches neither writer (`stockQty`/`stockLevel`); `expiresAt` doesn't exist in either writer's shape at all | merchant health-score computation | this metric is likely permanently near-zero regardless of real inventory state |
| 6 | `functions/marketing-engine.js` | READ | `name`, `price`, `category` (doc-ID lookup, not a filtered query) | **both** — these three fields are common to both writers | product-recommendation engine (collaborative + Claude Haiku fallback) | the one consumer with no field-mismatch risk, because it only reads fields both writers agree on |
| 7 | `functions/procurement.js` — `receiveGoods` (evidence branch only) | **WRITE** | `stockQty` via `FieldValue.increment`, doc ID `${branchId}_${productId}` ⚠️ | **neither** — that composite ID scheme matches no real `posProducts` document ID | **already removed on r1** (`8fc3673`'s `procurement.js` comment: *"The legacy writes are GONE: posProducts (a batch.update against a collection holding..."*) — confirmed fixed upstream, not a live defect on the release lineage | no action needed here — r1 already resolved this one via the receipt-bridge rewrite |
| 8 | `functions/procurement.js` — `getProcurementForecast` | READ | doc-ID batch lookup on `${branchId}_${productId}` ⚠️ | **neither** — same composite-ID mismatch as #7, **still present on r1** (this is a read, the write in #7 was removed, but the read wasn't) | reorder-forecast feature | live gap on r1: this forecast function's `posProducts` lookup can never match a real document; not caught by the receipt-bridge fix because it's a different function |
| 9 | `functions/release-readiness.js` | READ | `merchantId`, `qty ?? quantity` ⚠️ | **neither** | a release gate ("no posProducts should have qty < 0") | inert gate — always reports 0 negative-qty products regardless of real data, since the field it checks doesn't exist |
| 10 | `functions/self-heal.js` — `checkInventoryIntegrity` | READ | `qty < 0` ⚠️ (no merchant scoping visible) | **neither** | automated integrity check | inert for the same reason as #9 |
| 11 | `pos-inventory.js` (client, IndexedDB sync) | READ (realtime listener) | `status != 'deleted'` ⚠️ | **seller.js writer only** — Firestore `!=` excludes documents missing the field entirely, so `posUpsertProduct`-created products are **structurally invisible** to this listener | live `onSnapshot` listener feeding local IndexedDB | confirmed severe: a product added through the POS app's own catalogue screen may never appear in this same app's own offline sync |
| 12 | `pos-sync.js` — delta fetch | READ | `branchId` | **`posUpsertProduct` writer only** — `seller.js`-mirrored docs have no `branchId` and are excluded | delta/incremental sync | inverse of #11: seller-mirrored products are invisible here |
| 13 | `seller.js` (marketplace listing flow) | **WRITE** (the second writer) | see table above | — | client-side, best-effort, errors silently swallowed | this is the writer that needs the most scrutiny before any migration decision — direct client write, unverified rules permission, incompatible schema with the "canonical" server writer |
| 14 | `sokoni-reconcile.js` | READ + WRITE | queries `sellerUid` ⚠️ (a third identity-field name, matching neither writer's `merchantId` nor `sellerId` exactly — though likely intended to alias `sellerId`), also `setDoc`s reconciliation records back | **ambiguous** — needs its own dedicated read before trusting either direction | a reconciliation/repair tool — by nature, expects to see drift | should probably be the one place that's allowed to normalize field names, not migrated away |

*(14 real consumers found, not 11 — the difference is `pos.js`'s bridging comment and `sokoni-reconcile.js`'s dual role, which weren't obviously "consumers" until read closely. Reported as found, not forced to match the expected count.)*

---

## Safe migration order — evidence-based, not assumed

Given the schema fragmentation is worse than a single collection needing a redirect, the order that
does not risk making anything worse:

1. **Fix the field-name mismatches first, independent of any migration decision.** #2, #3, #4, #5,
   #9, #10, #11, #12 are all reading fields that don't exist on the documents they're querying —
   this is a correctness bug today, on the *current* schema, regardless of whether `posProducts`
   is ever migrated anywhere. Fixing these doesn't require deciding a canonical replacement first.
2. **Decide `seller.js`'s mirror write's fate before anything else architectural.** It's the writer
   producing the incompatible schema and the unverified-rules-permission client write. Until this
   is resolved, any "canonical schema" decision is fighting a live second writer that will keep
   producing drift.
3. **`getProcurementForecast`'s composite-ID lookup (#8)** is a live gap on r1 specifically — worth
   its own small, targeted fix (correct ID scheme) independent of the broader migration.
4. **Only after 1-3**, decide whether `posProducts` converges toward `tenants/{t}/inventory_products`
   (the ADR-015 canonical collection) or stays its own model — the same "does the target represent
   real capability the source doesn't" comparison method used for the `inventoryReceivePO` ADR
   should be applied here too, not assumed from the collection names alone.

## What this graph does NOT do

Does not decide a canonical replacement. Does not touch `posProductIndex` (already correctly
protected — barcode uniqueness is unrelated to this schema-fragmentation problem). Does not fix any
of the field-mismatch defects found. Does not touch `C:/temp/sok-r1`. No code changed anywhere.

## Related

`docs/adr/ADR-INVENTORYRECEIVEPO-disposition.md` (the comparison method this graph's step 4 reuses) ·
`docs/adr/ADR-018c-purchase-order-batch-disposition.md` (the same field-mismatch defect shape,
found first in the `posBatches` readers)
