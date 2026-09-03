# 18c discovery — `posPurchaseOrders` ERP writer and `posBatches` BI/intelligence readers

**Status:** 📋 DISCOVERY ONLY — no retire/converge/redirect decision made here, per ADR-018.
**Date:** 2026-09-03 · **Scope:** read-only. No code changed. No deploy run.
**Companion to:** `docs/adr/ADR-018-legacy-retirement-graph.md` (18b), `docs/cf-invocation-census.json`

---

## Summary — the one-line version of each finding

- **`posReceiveErpUpdate`** (the "live ERP webhook writer"): **0** request-log entries in the
  30-day Cloud Logging window — the same pattern as the function retired in 18b. Its own
  documented creation path (`createAutoReorderPO`) has **zero found frontend callers** anywhere in
  the repo. The actual live purchase-order UI (`pos-suppliers.html`) bypasses the entire server
  engine and writes to the same collection name directly from the browser.
- **`posBatches`, the 4 BI/intelligence readers**: **none** show a single successful (`200`)
  production call in the 30-day window. Two (`getExecutiveDashboard`, `getInventoryHealthScore`)
  query field names (`expiresAt`, `consumed`) that **do not exist** on any document the real writer
  produces — their inventory-health numbers are architecturally guaranteed to read as empty,
  independent of traffic. A third (`getPOSInventoryIntelligence`) uses the correct field names but
  its one real invocation `500`'d, plausibly because the deployed composite index for `posBatches`
  doesn't cover the query's actual filter shape. The fourth (`posGetInventoryAlerts`) has zero code
  callers and its one real hit was a `401` — an external probe, not a merchant.

Every number below is measured this session (`gcloud logging read`, `git grep`, direct file reads),
not carried forward from any prior claim.

---

## A. `posPurchaseOrders` — the ERP writer

### A.1 What `posReceiveErpUpdate` is contractually supposed to write today

`functions/pos-integrations-api.js:510-553`. HTTP POST, API-key bearer auth
(`posApiKeys` collection, hashed keys, permission-scoped). Body: `{ type, sellerId, ...payload }`.

`_processErpUpdate` (`pos-integrations-api.js:710-751`) switches on `type`:

| type | implemented? | writes |
|---|---|---|
| `po_received` | yes | `posPurchaseOrders/{poId}`**`.update()`** — `status:'received', erpUpdateId, receivedAt`. **Requires `body.poId` to already reference an existing doc — this endpoint never creates a PO.** |
| `fulfilment_update` | yes | `orders/{orderId}.update()` — unrelated to `posPurchaseOrders`/`posBatches`, out of scope here |
| `stock_adjustment` | **stub** | loop body is empty except a comment `/* Note: batch.update requires doc ref — in production, fetch ref first */` — accepts the request, logs it to `posErpUpdates`, does nothing else |
| `price_update` | **stub** | same — comment says `/* In production: lookup product by sku, update price */`, no-op |

So even on its own terms, half of this endpoint's advertised contract (`stock_adjustment`,
`price_update`) was never finished. Only `po_received` and `fulfilment_update` do anything.

### A.2 Who can actually create a `posPurchaseOrders` document — the reachable creation graph

| creator | where | reachable how | creates? |
|---|---|---|---|
| `pos-inventory-pro.js` `createPurchaseOrder` | `functions/pos-inventory-pro.js:687` | **nowhere** — not in `index.js`, not in the `smartPosDispatch` `_h` registry. Its own in-file comment (line 685-686) confirms this was deliberate: *"standalone onCall only. Dispatcher handler removed — procurement.html calls the canonical procurement CF directly (verified)."* | dead code — genuinely unreachable, same shape as the export retired in 18b |
| `pos-inventory-pro.js` `createAutoReorderPO` | `pos-inventory-pro.js:1147` | **is** in the `_h` registry → callable via `smartPosDispatch({op:'createAutoReorderPO', ...})` | yes — `db.collection('posPurchaseOrders').add(poData)` from the `posReorderQueue` |
| `pos-suppliers.js` `createPurchaseOrder` (client) | `pos-suppliers.js:121-156` | called directly from `pos-suppliers.html` — **this is the live product UI** | writes to **local IndexedDB** (`sokoni_pos_suppliers_v2`, store `purchase_orders`) and separately fires `_sync('posPurchaseOrders', po.id, po)` → a raw, unmediated `firebase.firestore().collection('posPurchaseOrders').doc(id).set(data,{merge:true})` **from the browser**, no Cloud Function involved |

`git grep` for the six op-name strings used by the server engine
(`createPurchaseOrder`, `receivePurchaseOrder`, `updatePurchaseOrderStatus`, `getPurchaseOrders`,
`upsertSupplier`, `createAutoReorderPO`) across every `*.html`/`*.js` in the repo: **zero matches**
as an `op:` value anywhere. The only thing calling `smartPosDispatch` with an inventory-pro-shaped
op at all could not be found in the frontend tree searched.

### A.3 The client write vs. the repo's own rules file

`firestore.rules:2672-2675`:
```
match /posPurchaseOrders/{poId} {
  allow read:  if isAuthed() && (resource.data.sellerId == request.auth.uid || isAdmin());
  allow write: if false;
}
```
Same `allow write: if false` on `posBatches`, `posSuppliers`, `posReorderQueue`, `posWarehouses`,
`posSerials`, `posWarehouseStock`, `posStockValuation` (lines 2656-2684). If this is what's
**served**, `pos-suppliers.js`'s direct client write above is rejected on every attempt — silently,
because `_sync()` swallows the error (`.catch(() => {})`).

**I could not verify the served ruleset this session.** The repo has a read-only script for exactly
this (`scripts/verify-rules-release-parity.js`, fetches the live ruleset via the Firebase Rules API
and diffs against local — never writes rules), but running it requires a fresh
`gcloud auth print-access-token`, and generating/persisting that token was blocked by this
session's auto-mode permission classifier. Per standing project memory
(`reference_deployed_ruleset_authority`, `project_rules_repo_served_divergence`), the repo's
`firestore.rules` file is a **proposal artifact** — it has no commit provenance tying it to what's
actually live. **This is an open verification gap, not a "the client write is harmless" conclusion**
— it must be closed with the served ruleset before any 18c decision relies on it either way.

### A.4 Invocation evidence — same method as 18b, 30-day Cloud Logging window

```
posReceiveErpUpdate (possendpurchaseorder... service name: posreceiveerpupdate)
  12 log entries, ALL cloudaudit.googleapis.com/{activity,system_event} + run.googleapis.com/varlog/system
  (deployment/startup lifecycle from the 2026-08-22 redeploy)
  0 run.googleapis.com/requests entries — i.e. 0 real HTTP calls received
```
Control: `smartPosDispatch` (the consolidated 173-op dispatcher) shows **773** real request-log
entries in the same window — it is genuinely busy. But Cloud Functions v2 `onCall` doesn't log
request bodies by default, and the dispatcher only logs the `op` name on an **unhandled error**
(`console.error('[dispatch] op="'+op+'"...)`), never on success. A text search across all
`smartposdispatch` logs in the window for any of the six inventory-pro op names returned **zero
matches** — but because successful calls are silent by design, this is **not** proof those ops were
never called, only that no *failure* mentioning them was logged. This is a real measurement
limitation, stated as such rather than resolved either way.

### A.5 Provisioning — is there a real external ERP partner at all?

`posRegisterApiKey` (`functions/pos-integrations-api.js:103`) is the only way to mint a
write-permission API key. `git grep` finds it called from nowhere in `*.html`/`*.js` — there is no
merchant-facing self-serve UI. The CHANGELOG entry that shipped this module (`26549`) frames it as
completing an "Enterprise Certification Report (98/100)" milestone, not an integration event with a
named partner. Combined with zero invocation evidence, there is no found sign a real external ERP
has ever connected.

---

## B. `posBatches` — the 4 BI/intelligence readers

### B.1 The real schema — what the only reachable writer actually produces

`receivePurchaseOrder` (`pos-inventory-pro.js:756-870`, dispatcher-reachable, itself gated on a
`posPurchaseOrders` doc already existing) is the only live path that creates `posBatches` docs:

```
{ sellerId, productId, lotNumber, batchNumber, quantity, remaining, unitCost, totalCost,
  expiryDate: <Firestore Timestamp>, supplierId, warehouseId, purchaseOrderId, poNumber,
  status: 'active', expiryAlert: false, expired: false, createdBy, createdAt, updatedAt }
```
No `merchantId`. No `expiresAt`, `consumed`, `qty`, `costPrice`, or `remainingQty` field.

### B.2 Per-reader: query shape vs. real schema, and 30-day invocation evidence

| reader | queries `posBatches` on | matches B.1 schema? | 30-day evidence | frontend caller | linked from nav? |
|---|---|---|---|---|---|
| `getExecutiveDashboard` (`pos-bi.js:221`) | `sellerId`, `expiresAt <=`, `consumed == false` | **NO** — `expiresAt`/`consumed` don't exist on any real doc; the sub-query always returns empty | 0 requests (deploy/system logs only) | `pos-bi.html` | **yes** — linked from `pos.html`, `sokoni-nav-engine.js` |
| `getInventoryHealthScore` (`pos-bi.js:628`) | `sellerId`, `expiresAt <=`, `consumed == false` | **NO** — same mismatch. Own code comment (`pos-bi.js:687`): *"posBatches may not exist yet — gracefully degrade"* | 0 requests | `pos-bi.html` | yes |
| `getPOSInventoryIntelligence` (`pos-intelligence.js:38`) | `sellerId`, `status=='active'`, `expiryDate!=null`, `expiryDate<=` | **YES** — matches the real writer's fields | 2 requests, both 2026-08-15: one `204` (preflight), one **`500`**. Nothing since. `firestore.indexes.json` has a composite index on `posBatches (status ASC, expiryDate ASC)` but **not** `sellerId` — this query filters on all three, so the `500` is plausibly a missing-composite-index failure, not proof of real usage | `pos-inventory-intelligence.html` | **no** — not linked from anywhere found in the repo; an orphan page |
| `posGetInventoryAlerts` (`pos-intelligence.js:654`) | `merchantId`, `status=='active'`, `expiryDate<=` | **PARTIAL** — `status`/`expiryDate` correct, but the writer field is `sellerId`, not `merchantId` → this filter always excludes every real doc | 1 request, 2026-08-24: **`401` Unauthorized**. Nothing since | **none found** — zero code-level callers anywhere in the repo | n/a |

**No reader shows a single successful production call.** The closest thing to "used" is
`getPOSInventoryIntelligence`'s one attempt, and it failed server-side.

### B.3 Why "genuinely production-used" can be ruled out for all four, and why that's not the whole story

Per the classification the discovery was asked to establish:

- **Genuinely production-used** — none qualify; zero `200`s across all four in the window.
- **Merely deployed but unexercised** — `getExecutiveDashboard` and `getInventoryHealthScore` fit
  this on traffic alone, but B.2 shows they're worse than unexercised: even if called, their
  `posBatches` sub-query is a permanent no-op against the real schema. Traffic isn't the only
  reason they show nothing.
- **Already replaceable by canonical inventory data** — not established either way this pass.
  `sokoni-inventory-v2.js` (the ADR-015 canonical tenant-scoped model) has its own, separate
  `createBatch`/`getBatches` calling a *different* Cloud Function (`inventoryCreateBatch`, from the
  `inventoryV2` module) — it does not touch `posBatches` at all. Whether the canonical model
  carries equivalent expiry/health data has not been checked in this pass.
- **Dependent on fields that do not exist in the model** — confirmed, precisely, for three of the
  four: `getExecutiveDashboard` and `getInventoryHealthScore` on `expiresAt`/`consumed`;
  `posGetInventoryAlerts` on `merchantId`. `getPOSInventoryIntelligence` is the one exception —
  its fields are correct.

### B.4 The wider pattern: "purchase orders" and "batches" are 3-5 unrelated implementations by name only

Confirmed by direct reads, not inferred from naming alone:

1. **`functions/procurement.js` + `procurement.html`** — canonical PO lifecycle engine, collection
   `purchaseOrders` (no `pos` prefix). Real caller. This is the survivor from 18b/ADR-018.
2. **`functions/pos-inventory-pro.js` (+ `smartPosDispatch`)** — AVCO/FEFO-costed engine, collections
   `posPurchaseOrders`/`posBatches`. Internally consistent and server-correct where reachable, but
   its reachable creation op (`createAutoReorderPO`) has no found frontend caller (§A.2).
3. **`pos-suppliers.js` + `pos-suppliers.html`** — the actual live supplier/PO UI. Fully separate,
   client-side-only (IndexedDB + direct unmediated Firestore writes) implementation that happens to
   target the *same collection names* as #2 with none of its code, validation, or AVCO logic.
4. **`pos-inventory.js` + `pos-inventory.html`** — a third "batches" concept, entirely local
   (IndexedDB `sokoni_pos_v2`/`batches` store), never touches Firestore `posBatches` at all.
5. **`sokoni-inventory-v2.js`** — the ADR-015 canonical tenant-scoped model's own `createBatch`,
   calling the unrelated `inventoryCreateBatch` Cloud Function.

This matches the standing project memory note that the `pos-inventory-pro.js` family sits outside
where current product development is investing (`project_canonical_inventory_authority`,
"pos* INERT"). Both live UIs that plausibly *should* feed `posPurchaseOrders`/`posBatches`
(`pos-suppliers.html` for POs, `pos-inventory.html`/`sokoni-inventory-v2.js` for batches) instead
each maintain their own, disconnected implementation.

---

## What this discovery does and does not establish

**Does establish, with evidence:**
- `posReceiveErpUpdate` has the same zero-invocation signature as the function retired in 18b, and
  its documented creation path has no found frontend caller either.
- Two of the four `posBatches` readers query fields that do not exist on any real document —
  independent of whether they're ever called.
- A third reader's one real invocation failed, plausibly on a missing composite index.
- The fourth reader has zero code callers and its one real hit was an unauthenticated external
  probe.
- At least three structurally separate "purchase order" or "batch" implementations coexist under
  overlapping names, only one of which (`procurement.js`) has a confirmed live caller.

**Does not establish:**
- Whether the served Firestore ruleset actually blocks `pos-suppliers.js`'s client write to
  `posPurchaseOrders` — the read-only check to answer this exists (`verify-rules-release-parity.js`)
  but could not be run this session (blocked generating a fresh access token). **Close this before
  any decision that assumes the client write is either safe or already prevented.**
- Whether `sokoni-inventory-v2.js`'s canonical model can already serve what
  `getPOSInventoryIntelligence`/`posGetInventoryAlerts` are trying to compute, making them
  redundant rather than merely broken.
- Any retire/converge/redirect/compatibility-surface decision. That is the next step, per ADR-018,
  and is deliberately not made in this document.

No code was changed. No deploy was run. `functions/index.js` export count is unchanged at **1508**
(measured this session: `grep -c '^exports\.' functions/index.js`).
