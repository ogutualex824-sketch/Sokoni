# Universal Catalogue / Uploader — dependency census

**Read-only census, 2026-09-29,** on branch `slice/c4-category-matrix` at `ec40b9b`, before any uploader code.
Owner's brief: one merchant-v2 catalogue engine plus a category capability matrix; reuse the release commits
`4f67b4b`, `911ec98`, `511836c` and `9e5609e`; never rebuild.

Related: [[DISPUTES_AND_REPORTS_AUTHORITY]], [[PRODUCT_OFFERS]], [[SHOP_AVAILABILITY_AUTHORITY]]

## 1. The four commits against this branch, file by file

None of the four is an ancestor of HEAD. Status is HEAD's content compared with the commit's.

| Commit | File | Status on HEAD |
|---|---|---|
| **4f67b4b** (99-category taxonomy + upload form, 09-09) | `sokoni-product-taxonomy.js` | **ABSENT** |
| | `scripts/build-product-taxonomy.js` | **ABSENT** |
| | `scripts/test-product-taxonomy-parity.js` | **ABSENT** |
| | `scripts/test-products-upload-form.js` | **ABSENT** |
| | `sokoni-merchant-products.js` | HEAD is **newer**: it has the Listing Studio (09-19) and already calls `SokoniProductTaxonomy` |
| | `sokoni-merchant-data.js` | diverged; HEAD lacks the taxonomy field handling (`FOOD_KEYS`, ownership keys) |
| | `merchant-v2.html` | diverged; HEAD lacks only the `sokoni-product-taxonomy.js` script tag (it already has `callAiMetadata`) |
| **911ec98** (media / photo writer, 08-20) | `sokoni-merchant-media.js` | **IDENTICAL** |
| | `sokoni-merchant-data.js` | diverged; HEAD **lacks `attachProductImages`** |
| | tests (`test-merchant-products-2c-media.js`, `cert-merchant-products-browser.js`, …) | ABSENT |
| **511836c** (product writer, 08-26) | `scripts/test-merchant-product-writer.js` | **IDENTICAL** |
| | writer (`writeProduct`, `_requireWriter`, `assertInScope`, `_writeMirrors`, `getProduct`) | **present** on HEAD (ported by `ffd608b`, "GATE W") |
| | `attachProductImages` | **ABSENT** |
| **9e5609e** (inventory lineage, 09-09) | `functions/merchant-inventory.js`, `functions/delivery-pin.js`, `test-merchant-adjust-stock.js` | **IDENTICAL** |
| | `functions/shop-employees.js` | HEAD is **newer** (+52/−10) |

**A fifth dependency is not in the brief:** `3f9f238` (warranty UI, 09-10) provides `SokoniWarrantyUI`, which HEAD's
product module calls three times. It is not an ancestor of HEAD. It is a pure UI module with no server calls.

**Why not a whole cherry-pick:** HEAD's `sokoni-merchant-products.js` is 841 lines **ahead** of `4f67b4b`, and
`merchant-v2.html` has diverged by more than 900 lines. Cherry-picking `4f67b4b`, `911ec98` or `511836c` would
conflict with, and could roll back, the newer Listing Studio, Media Studio and price-tag work (`e10d464`…`a091aab`).

**Smallest convergence path:** port only what is missing, verbatim, and name the source commit of each piece:
1. `sokoni-product-taxonomy.js`, `build-product-taxonomy.js`, the parity test and the upload-form test (from
   `4f67b4b`), plus the one script tag.
2. `attachProductImages` and its export (verbatim from `4f67b4b`'s data module, the latest in that lineage). Every
   helper it needs, the media module and the `putImage` Storage adapter already exist on HEAD. Today the photo
   upload **throws** (`sokoni-merchant-products.js:1530`).
3. The taxonomy field handling in the writer (from `4f67b4b`), reconciled against `d0443b8`'s field list.
4. `sokoni-warranty-ui.js` / `.css` and `test-warranty-surfaces.js` (from `3f9f238`), plus their script / link tags.
5. `9e5609e`: **nothing**. It is already identical, and HEAD is newer.

## 2. Two category axes, both real

| Axis | Authority | Size | Decides |
|---|---|---|---|
| **Business category** (who is selling) | `functions/business-category.js` | **31** canonical categories ← **105** business ids (`FROM_BUSINESS_ID`, 3 admin-review-only) + **73** professions | workspace, discovery, commission by transaction type |
| **Product category** (what is being sold) | `sokoni-product-taxonomy.js` (`4f67b4b`, generated from seller.html) | **99** categories in 20 groups | `kindOf` physical / service / digital; ownership; food licence; KEBS; 18+ |

The workspace already maps business category → profile → modules in `functions/business-workspace.js`: 6 profiles
and 26 modules. The uploader's **capability matrix belongs beside that**, keyed on the 31 canonical categories. The
test must resolve all 105 business ids and 73 professions through it. There must be no third registry.

## 3. Catalogue code on HEAD

- **Products surface:** `sokoni-merchant-products.js` (Listing Studio, Media Studio, Draft → Review → Publish,
  price tags, variants, availability).
- **Writer:** `sokoni-merchant-data.js` `createProduct` / `updateProduct` / `writeProduct`, through the merchant-v2
  `_mdb` adapter (client Firestore under rules), plus `_writeMirrors` projections.
- **Stock:** `functions/merchant-inventory.js` `merchantAdjustStock` (transactional, floored, versioned). Products
  hand the opening quantity to it.
- **"Remove" = HARD DELETE:** `sokoni-merchant-products.js:1364` → `SokoniMerchantData.deleteProduct` →
  `db.deleteProduct({id})`. There is no archive and no mirror clean-up, so `posProducts` / `inventory_products` are
  orphaned.
- **Offers:** `functions/product-offers.js` (T2b), with `acceptOffers` per product.
- **Other known issues:** `costPrice` is world-readable (rules and `/api/catalogue`), and cards read ratings from
  localStorage.

## 4. Proposed slices

| Slice | What | Notes |
|---|---|---|
| **U1** | Dependency port (§1, items 1–4) | Prove what came from each commit: its own tests run green on this branch. Photo upload stops throwing. |
| **U2** | Catalogue capability matrix (`shared/catalogue-capabilities`, UMD like shop-hours) | 31 categories × object types / fields / compliance / inventory / booking / quote / delivery / POS / marketing; a test over every business id and profession |
| **U3** | Object types in the Listing Studio driven by U2 | Only permitted types are shown; per-type fields |
| **U4** | Archive / Restore lifecycle replaces hard delete | Checkout, POS and marketing refuse archived items; mirrors follow |
| **U5** | Packages / bundles consuming component stock through `merchantAdjustStock` | Never a second counter |
| **U6** | Compliance states (declared → verified) | `costPrice` privacy (rules + API) |
| **U7** | Marketing and POS parity over the same object | |

## 5. U1 — what was ported, and what it found (2026-09-29)

| Ported | From | Proof on this branch |
|---|---|---|
| `sokoni-product-taxonomy.js`, `scripts/build-product-taxonomy.js` | `4f67b4b`, verbatim | `test-product-taxonomy-parity` **24/0** (the 99 categories still equal seller.html) · `test-products-upload-form` **66/0** |
| `attachProductImages` + export; the mirrors carry the real photo | `4f67b4b` (911ec98 / 511836c lineage), verbatim | `test-merchant-products-2c-media` **53/0** (3 BLOCKED, see below) |
| Writer rules: `isDigital` / `isService` derived from the taxonomy; food licence normalised; **ownership clamped to pending**; bulk / https-download / food-permit validation | `4f67b4b`, layered ON `d0443b8`'s newer allowlist (not replacing it) | U1 browser UB3, UB7 |
| **Stock authority:** `stock` out of the metadata write; `openingStockOf`; `createProduct` files opening stock through `merchantAdjustStock`; `updateProduct` refuses a stock patch; the projections carry the established count | `4f67b4b`, verbatim | `test-merchant-v2-products-2b` **59/0** (was **57/2** before the port); U1 browser UB5 |
| `sokoni-warranty-ui.js` / `.css` (policy builder); `functions/warranty-policy.js` (PURE: no Firestore, no network) | `3f9f238` / `8e1ce91`, verbatim | `test-warranty-policy` **45/0**; `test-warranty-surfaces` **55/7** (see below) |
| merchant-v2 loads the taxonomy and warranty modules before Products | `4f67b4b` / `3f9f238` tags | U1 browser UB8 |
| `9e5609e` | — | nothing to port; this branch is identical or newer |

**A real regression found and closed.** This branch's writer (from `d0443b8`) descended from a lineage that never
received `4f67b4b`'s stock-authority fix. The Products form wrote `stock` straight into the product document: an
untransacted shelf count with no movement record, bypassing `merchantAdjustStock`. The lineage's own test
(`test-merchant-v2-products-2b`) failed on this branch before the port and passes after it.

**Recorded deviation:** `4f67b4b`'s `updateProduct` also refused any `variants` patch. This branch's Listing Studio
(`7531e57`) edits variants, so that refusal is **not** ported. **UNPROVEN:** whether a per-variant quantity reaches a
till anywhere.

**BLOCKED, not failed:**
- `test-merchant-products-2c-media`: 3 checks need `storage.rules.deployed`, which means fetching the DEPLOYED Storage
  rules. That is a production read and needs classifying before it is run.
- `test-warranty-surfaces` H1–H8: the buyer's return panel on delivery-tracking.html calls `warrantyForOrder` /
  `requestReturn` from the returns chain (`12b56dd` pin-at-purchase, `c5f22c2` refunds via IntaSend) and
  `d4de4b8` (PIN handbook). That is a money chain and is **deliberately not ported** in an uploader slice.

**Not revived:** `cert-merchant-products-browser.js` and `test-merchant-v2-lazy-modules.js`. They exist only at
`911ec98`, and the lineage itself dropped them.
