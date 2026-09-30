# Product timestamp writer census — who creates `products/{id}` and what chronology it carries

**Date:** 2026-09-30 · **Scope:** read-only; no code, rules, index or production change · **Why:** the catalogue readers need an index-free "newest first" key. Document id is not one (11 / 97 live ids are `Date.now()`-style; 86 are labels). `uploadedAt` is the candidate; this census says whether every writer can be trusted to stamp it.
**Related:** [[HOME_PICKED_FOR_YOU_INVENTORY_SYNC]] (§4c–4d) · [[RELEASE_GATE_LIVE_CATALOGUE]] · [[Marketplace]]

---

## 1 · The seven questions, answered

| Question | Answer |
|---|---|
| Every production product writer | **No server code creates a top-level `products` document.** All creation is in the browser, gated by the served rule `products` `allow create` (`isActive && isAuthed && isSeller && sellerUid == auth.uid && validPrice && noAdminFields && noBase64Image && withinProductLimit`). The rule requires **no timestamp**. Writers below. |
| Writes `uploadedAt`? | seller.js (single + CSV): `Date.now()`. seller-wiring.js upsert: cached value or `Date.now()`. **merchant-v2: never. sokoni-inventory: never.** |
| Writes `createdAt`? | seller.js: `serverTimestamp()`. **merchant-v2: always `serverTimestamp()`** (adapter `merchant-v2.html:2206`). sokoni-inventory: **never** (its canonicaliser whitelists fields and drops it). seller-wiring: never. |
| Can either be null / missing? | Yes. merchant-v2 → `uploadedAt` missing. sokoni-inventory → **both missing** (only `updatedAt` as an ISO string). seller-wiring's upsert can be the creating write (id from car-hub / ministore localStorage) → `createdAt` missing. |
| Server or browser authoritative for the time? | **Browser** for `uploadedAt` everywhere it exists (`Date.now()` on the client clock). Server (`serverTimestamp`) only for `createdAt` on seller.js and merchant-v2. Nothing server-side asserts either. |
| Can existing products be repaired without inventing history? | Today nothing needs repair: **97 / 97 live products carry `uploadedAt`** (96 numbers, 1 Timestamp on `QATEST100`, a QA test product). For a future gap: merchant-v2 rows have a server `createdAt`; sokoni-inventory ids `prod_<base36 ms><4 rand>` encode the creation millisecond; seller.js / car-hub / ministore ids embed `Date.now()`. `updatedAt` is an upper bound only. merchant-v2 `prd_` ids are hashes and carry no time. |
| Can any writer create a product with neither usable field? | **Yes: `sokoni-inventory.js:513` (and its offline replay at :1158)**, reachable from `inventory.html` / `inv-products.html`, admitted by the rule because it sets `sellerUid`. `pos-boss.js:279` and `admin.html:2780` would too, but their creates are denied (no `sellerUid`). |

## 2 · Writers (verified against source)

| # | Writer | Trigger | `uploadedAt` | `createdAt` | Id shape | Live today |
|---|---|---|---|---|---|---|
| 1 | `sokoni-merchant-data.js:449` `createProduct` → adapter `merchant-v2.html:2194-2219` (`tx.set`, create-only) | merchant-v2 Products form — **the canonical merchant path** | **absent** | `serverTimestamp()` | `prd_{shopId}_{hash}` (no time) | **0** products with `prd_` ids in the live catalogue |
| 2 | `seller.js:1008` `setDoc` | seller.html "List product" | `Date.now()` | `serverTimestamp()` | 13-digit ms | 11 (uploadedAt == createdAt on all 11) |
| 3 | `seller.js:2057` `writeBatch` | seller.html CSV bulk | `Date.now()` (parse time) | `serverTimestamp()` | `Date.now()+i` | included above |
| 4 | `sokoni-inventory.js:513` / `:1158` `set(canonical, {merge:true})` | inventory.html, inv-products.html save / duplicate | **absent** | **absent** (dropped by `_toCanonical`) | `prod_<base36 ms><rand4>` | **0** `prod_` ids live |
| 5 | `seller-wiring.js:137` `setDoc(…, {merge:true})` upsert | wraps seller.js add; `_syncLocalProducts()` on every auth on ~293 pages | cached or `Date.now()` | absent | whatever the cache holds | see §3 |
| 6–8 | pos-boss.js:279, admin.html:2780 (rule-denied creates), sokoni-db.js:623 `saveProduct` (no caller) | — | absent | absent | — | none |

The 86 labelled live products (`VP#`, `TC#`, `ALC#`, `CAR#`, …) all carry a numeric `uploadedAt` (2026-06-11 → 2026-07-23) and no `createdAt`; they are seed/import rows, not products of writers 1 or 4.

## 3 · One more finding: `uploadedAt` can be rewritten after the fact

`seller-wiring.js:55` builds `uploadedAt: product.uploadedAt || Date.now()` and `:137` upserts with merge on **every sign-in**, stripping only price/cost/delivery/stock/outOfStock/sold/sellerUid on existing docs. A product that reached the seller's `localStorage.sellerProducts` cache without `uploadedAt` (category.js fills that cache from Firestore; merchant-v2 rows have none) gets **`uploadedAt` = the seller's login time**. Under `orderBy('uploadedAt', 'desc')` that product would jump to "newest". This is a browser writer inventing chronology; it must be closed before `uploadedAt` becomes the ordering authority.

## 4 · Evidence review — does the census close the writer gap?

No, not yet. Three gaps stand between "97 / 97 have it today" and "every product will have a truthful `uploadedAt`":

1. **merchant-v2 never stamps it** (canonical path, 0 live rows so far, so the gap has not yet bitten).
2. **sokoni-inventory stamps nothing** (reachable, admitted by the rule).
3. **seller-wiring can overwrite it with a login time**.

And no writer is server-authoritative: every `uploadedAt` is a client clock.

## 5 · What "canonical creation → server-authoritative `uploadedAt`" would take (for decision, not applied)

| Piece | Where | Size | Gate |
|---|---|---|---|
| a. Readers order by `uploadedAt` desc, `limit(200)` | `sokoni-db.js`, `sokoni-recommendations.js` | 2 lines | hosting |
| b. merchant-v2 writer stamps `uploadedAt` from the same server timestamp it already stamps for `createdAt` | `merchant-v2.html` adapter (`data.uploadedAt = data.createdAt`) | 1 line | hosting |
| c. sokoni-inventory canonicaliser keeps a server `createdAt` and stamps `uploadedAt` | `sokoni-inventory.js` `_toCanonical` | ~4 lines | hosting |
| d. seller-wiring never invents `uploadedAt` on an existing doc (strip it with the other server-owned fields when the doc exists) | `seller-wiring.js:119-121` | 1 line | hosting |
| e. Server authority: either a rule `request.resource.data.uploadedAt == request.time` on create (rules gate, separate authorization; note `Date.now()` client stamps would then be refused and writers 2–3 must switch to `serverTimestamp()`), **or** an `onCreate` trigger that sets `uploadedAt` from `createdAt`/`request.time` when absent (functions gate) | rules or functions | small, but its own gate | rules / functions |
| f. Backfill for future gaps only (none needed today): `createdAt` → id-decoded ms → refuse | script, admin, one-shot | n/a | production write, separate authorization |

The **smallest** repair that makes the readers correct on today's data is **a alone** (97 / 97 carry the field; QATEST100's Timestamp value sorts first under desc by Firestore type order and is a QA row). The smallest repair that stays correct as products are created is **a + b + c + d** (hosting only, four files). **e** is what makes the timestamp server-authoritative and is a separate gate either way.

## 6 · Not in scope, recorded separately

The live Home listener fails once on the missing `__name__ DESC` index and Home continues on `/api/catalogue` (one-shot, CDN-cacheable): a pre-existing architecture finding with its own repair, not to be folded into the ordering change ([[HOME_PICKED_FOR_YOU_INVENTORY_SYNC]] §4c).
