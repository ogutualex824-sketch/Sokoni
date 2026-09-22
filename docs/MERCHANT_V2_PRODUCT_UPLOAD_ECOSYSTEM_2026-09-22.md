# Merchant V2 ↔ Premium Product Upload ↔ POS ecosystem

**Date:** 2026-09-22 · **HEAD at authorization:** `10acec6` (actual working HEAD was `bdb24af`;
the brief's ref was two commits behind) · **Status:** AUDIT + two connections. **NOT DEPLOYED.**

Related: [[MERCHANT_V2_POS_ECOSYSTEM_MAP_2026-09-22]] ·
[[KRA_MERCHANT_V2_POS_QUICKPAY_MAP_2026-09-22]] · [[POSPRODUCTS_MIGRATION_GRAPH]]

---

## 0. The headline — the premium uploader already existed, unreachable

The brief asked to import seller.html's upload page into a new Merchant V2 uploader. **The
direction is inverted.** Measured:

| | `sokoni-merchant-products.js` | `seller.html` |
|---|---|---|
| `*HTML` form families defined | **26** | **0** |
| `categoryHTML` `bulkHTML` `ownershipHTML` `foodHTML` `digitalHTML` `kebsHTML` `aiWriteHTML` | all present | none |
| plus | specs, variants, warranty, barcode, scanner, shot list, media checks, studio report, business context | — |

Every form family the brief names exists **only** in the premium editor. seller.html's higher
raw word-counts for "kebs"/"digital"/"ownership" were incidental prose in a large monolith, not
form families — which is why mention-counting was abandoned as a proxy.

**And it was already registered in the shell.** `merchant-v2.html` loads
`sokoni-merchant-products.js` (line 848) and `sokoni-listing-studio.js` (862), and declares a
full `MODULES.products` entry with `scope`, `db`, `shopName`, `adjustStock`, `entitlement`,
`canPublish`, `storage`, `go`, `onToast`.

**It was mounted by nothing.** The `products` ROUTE was `kind:'seller' sec:'products'`, so the
shell iframed `seller.html#products`; `renderModule()` runs only for `kind:'native'`. A
3,132-line editor, loaded on every page view, reachable by no one — the same shape as the twelve
roster callables.

The fix was one route field. No uploader was built, ported or duplicated.

---

## 1. Canonical authorities — and a correction to §1 of the brief

§1 stated *"the existing catalogue evidence says `posProducts` is the shared catalogue
model."* **The certified writer says the opposite, in its own header.**

```
CANONICAL              products/{id}
  ↓ PROJECTION 1       tenants/{sellerUid}/inventory_products/{id}   back-office Inventory
  ↓ PROJECTION 2       posProducts/{id}                              POS checkout catalogue
```

`sokoni-merchant-data.js` — `PRODUCT_MIRRORS = ['inventory','pos']`. Two deliberate departures
from the seller.js code it replaced, both stated there:

- the projections are **pure functions**, so the field mapping is certifiable on its own —
  "the same class of defect as posRetailSales, where writer and reader disagreed about field
  names and POS sales silently vanished from reporting";
- the old mirrors were `.catch(function(){})` fire-and-forget, which turns a failed mirror into
  a reported success. Each mirror's outcome is now **returned**, so the UI can say *"created,
  but not yet at the till"* instead of an unqualified success. A mirror failure never fails the
  create — the canonical record is the revenue path and is already committed — but it is never
  hidden.

This agrees with `POSPRODUCTS_MIGRATION_GRAPH.md` (*"posProducts is no longer the collection a
sale is priced or stocked from"*) and with `posCompleteCheckout`, which prices and stocks from
`products/{id}` at four call sites and has **zero** references to `posProducts`.

The POS projection writes `sellerId` — which is exactly what the **served** ruleset keys
`posProducts` ownership on, so this writer's mirror lands on the readable side of that gate.

| Authority | Answer |
|---|---|
| Canonical product record | `products/{id}` |
| Canonical service record | **see §4 — not yet expressible** |
| Canonical upload/editor | `sokoni-merchant-products.js` + `sokoni-listing-studio.js`, writing through `SokoniMerchantData`'s certified writer |
| Canonical owner | `auth.uid → users/{uid} → sellerUid → activeShopId → shop`, resolved by the shell and passed as `scope` |
| Canonical inventory | `products/{id}.stock`, corrections via `merchantAdjustStock` |
| Canonical POS availability | the `posProducts` projection |

---

## 2. What was connected

**(a) Merchant V2 → the canonical editor.** `products` route `kind:'seller'` → `kind:'native'`.
The chip registry's `owner` moved with it (`seller` → `native`), which the contract validator
demanded — otherwise the chip gate would grep seller.html for handlers that now live in the
module. Those bars are `planned`, so no handler is named or searched for yet.

**(b) AI authoring — a control with no authority behind it.** The module calls
`ctx.callAiMetadata({ imageUrl, category })`; the shell's ctx **never provided it**, so the AI
writer reported *"not available in this workspace"* — an honest degradation, and a dead feature.

`generateProductMetadata` (`functions/media-engine.js`, exported `index.js:10351`) takes
`{ imageUrl, category, language }` — **the same shape, not an adapted one**. Auth-gated,
rate-limited 30/uid/day. Now bound.

Checked against the alternative: `inventoryAiIdentifyProduct` requires `data.image` (bytes) plus
a tenantId — a contract that would have needed fetching and re-encoding to fit. It was **not**
used; wiring a mismatched contract would have turned an honest "unavailable" into a runtime
`invalid-argument`.

AI assists and decides nothing: the module fills only fields the merchant left blank
(*"Only fill what the merchant has not written"*), and the submission still goes through the
same certified writer. AI determines no ownership, price, payment state, tax liability,
inventory or authorization.

**Every ctx key the editor consumes is now supplied** — 10/10, asserted, with a control proving
the detector found keys to check. §3's rule (a field that exists in the form but is silently
discarded is not complete) is now enforced rather than assumed.

---

## 3. Ownership and permissions (§18, §19)

The editor resolves nothing itself. `scope` comes from the shell's already-resolved chain, and
every mutation goes through the certified writer, which owns the ownership check, validation,
the publication gate and idempotency — proven independently of the UI, so a defect in the write
path cannot arrive hidden inside a UI conversion.

"Anybody can upload" therefore means **any authorized seller/staff role with permission**, on
the shop the server resolves — not an arbitrary client-supplied `shopId`. The editor never
sends one.

Stock is deliberately not writable here: an opening quantity is handed to `merchantAdjustStock`
so it is transactional, floored, versioned and recorded as a movement. Adjusting an existing
product's stock is Inventory's job and the editor routes there.

---

## 4. THE SERVICE GAP — the one thing that blocks "one upload for products and services"

**The canonical create path cannot currently express a service.** `productProjections` hardcodes
`unit: 'pcs'` on the POS mirror and carries **no** `trackStock` / `trackInventory` flag at all.
A service created through this path would project to POS as a stocked, piece-priced product.

This is not fixed here, deliberately. The service shape — `posProducts` row, `trackStock:false`,
`unit`, `variablePrice` — is defined by `sokoni-catalogue-model.js`, which is **foreign and
uncommitted**. §30 forbids copying, reimplementing or modifying it without handoff, and
inventing a second service shape is the duplication this whole workstream exists to prevent.

It also interacts with a finding already recorded: that model places services in `posProducts`,
which is a **projection**, not the canonical record — so a service written only there has no
`products/{id}` row and `posCompleteCheckout` cannot settle it.

**The convergence answer, for that owner to accept or reject:** a service should be a canonical
`products/{id}` row carrying its non-stocked flag and unit, projecting into `posProducts` like
any other product. That keeps one catalogue, one writer, one settlement path — and makes
"Printing — per page, trackStock:false" sellable at the till, which it is not today.

---

## 5. Downstream reach — what is proven and what is not

| Link | State |
|---|---|
| Merchant V2 → premium editor | **PROVEN in-browser**: module + studio loaded, opens at `#products`, does NOT iframe seller.html, renders its own content |
| Editor → canonical `products/{id}` | **PROVEN by code**: writes only through the certified writer |
| Canonical → `posProducts` / inventory projections | **PROVEN by code**: declared mirrors, outcomes returned |
| Projections → POS / Till picker | **UNPROVEN** — no create performed, no authenticated session |
| Upload → Quick Pay | **NOT RUN** — the Quick Pay service path does not exist yet (§4, foreign workstream) |
| Upload → Marketplace channel availability | **UNPROVEN** — channel flags not traced in this pass |
| Upload → KRA | per the KRA map: tax determination exists, POS/till never enter the eTIMS lifecycle |
| Upload → realtime | **NOT RUN** — no two-device run |

**"Universal upload" is not declared.** The UI renders and every control is bound; that the
canonical record reaches all three stores and is then selectable downstream needs an
authenticated merchant and the emulators, and no create was performed.

---

## 6. No duplicate authority (§27)

Asserted, each with a control: no `posServices`, `merchantProducts`, `merchantV2Products`,
`premiumProducts` or `productSuppliers` in any file this work touched. No second upload engine —
the one that existed was connected, not replaced. No second inventory, barcode or KRA product
authority. `seller.html` is untouched and still reachable at its own route.

---

## 7. Tests

`test-merchant-ecosystem-convergence.js` **124/0**, 10 UNPROVEN, 2 NOT RUN —
§11e covers canonical authority, projections, route kind, all 7 named form families, ctx
completeness, AI contract match, and the no-duplicate check.
`test-merchant-v2-ecosystem-runtime.js` **131/0**, 3 UNPROVEN — includes the in-browser proof
that Products mounts natively and does not iframe seller.html.
`test-merchant-actions.js` 31/0 · `test-merchant-ecosystem.js` 119/0.

`test-merchant-routes.js` 76/2 — the same two pre-existing failures (the `offers` literal in its
`FOUNDER_SIDEBAR` spec). It dropped 77→76 passes because `products` is no longer a seller route,
so the "seller sec exists" assertion no longer applies. Expected.

A stale fixture was repaired: `test-merchant-actions.js` planted `products.owner = 'native'` as
its contradiction case, which stopped being a contradiction the moment products became native.
The wrong owner is now **derived from the route's actual kind**, so it cannot go stale again.

---

## 8. Blockers

| | |
|---|---|
| **P-1** | The canonical create path cannot express a service (§4). Blocked on the foreign catalogue workstream's handoff |
| **P-2** | Services are modelled in `posProducts`, a projection — no canonical row, so the till cannot settle them |
| **P-3** | Channel availability (POS / Till / Quick Pay / Marketplace per-product flags) not traced |
| **P-4** | Bulk upload, scanner and media integrity present in the editor but their end-to-end persistence not exercised |
| **P-5** | No realtime proof for catalogue changes |

---

## 9. §3 field trace — eighteen controls rendered, then discarded

§3 forbids assuming a field is merely visual. Traced UI → normalisation → validation →
persistence: the editor collected **26 fields**; the certified writer persisted **9**.

The eighteen dropped:

`brand` · `condition` · `location` · `kebsCert` · `digitalUrl` · `digitalLicense` ·
`listingType` · `tags` · `deliveryCost` · `wholesalePrice` · `minWholesaleQty` · `specs` ·
`attributes` · `stockUnit` · `ownership` · `foodLicence` · `warranty` · `variants`

So `kebsHTML`, `foodHTML`, `digitalHTML`, `ownershipHTML`, the variants grid and the
specifications editor all rendered, captured and normalised — and evaporated at the whitelist.
`fieldsFromForm` assembled them correctly; `_productFields` never looked at them.

**Two of them are exactly what a service needs:** `listingType` (the Listing Studio's
product/service type picker) and `stockUnit` (the unit — "per page"). So the canonical path
could not express a service for a reason *upstream* of the catalogue-model question in §4.

### It was a regression, and this workstream introduced it

`seller.js:813-815` writes `kebsCert`, `location` and `deliveryCost` straight into the product
document. Moving Products from the seller iframe onto this writer therefore **lost live
compliance data** for anyone using Merchant V2. Not cosmetic, and not pre-existing.

### The repair

`_productFields` now carries all 26, normalised by the rules the file had already set for
itself rather than new ones:

- **empty is ABSENT for money, never 0** — a blank delivery cost must not become free
  delivery, the same reason a blank `costPrice` must not become a 100% margin;
- strings trimmed and bounded, as `name` / `sku` / `description` already were;
- structured records passed whole, because the parts of a policy travel together — sending a
  warranty's duration without its remedies is the defect the editor had already fixed on its
  own side;
- an explicitly emptied object passed through rather than skipped, so a merchant can REMOVE a
  record entered by mistake. The editor's comment states that contract; honouring it is this
  writer's half.

`_validate` gained `deliveryCost`, `wholesalePrice` and `minWholesaleQty`, because carrying a
field without validating it is only half of not discarding it.

Asserted in `test-merchant-ecosystem-convergence.js` §11e with three controls: the drop
detector must find a genuinely absent field, both sides must have actually parsed (26 vs 28),
and the three seller.js fields are named individually as regression parity.

### Still not proven

That these fields reach the POS and inventory **projections**. `productProjections` maps a
fixed subset and was deliberately not extended — widening a mirror without knowing each
consumer is the field-mapping divergence the writer's own header warns about, naming
`posRetailSales` as the precedent where writer and reader disagreed and POS sales silently
vanished from reporting.

---

## 10. Catalogue/Tender Handoff

**State at `d0443b8`+: NOT HANDED OFF.** All four files are untracked working copies:
`sokoni-catalogue-model.js`, `sokoni-pos-tender.js`, `sokoni-pos-pay-console.js`,
`functions/shared/pos-service-pricing.js`.

| | |
|---|---|
| Owner | the cart/tender/catalogue workstream (another agent) |
| Commit | **none yet** |
| Gate definition | **tracked in the git index**, not present on disk. A file on disk but untracked is a working copy that can change or vanish under us; building against it is building against a moving target |
| Audit command | `node scripts/audit-catalogue-handoff.js` |

The eighteen contract questions (§2 A–R) are implemented as **NOT RUN with their reason
printed**, so the audit is a command rather than a memory. When the commit lands they flip to
**UNPROVEN**, not PASS — landing a commit answers none of them, and a suite that went green on
arrival would be the "declared ready because it renders" failure the brief names. Each must be
replaced by a trace through UPLOAD → CANONICAL RECORD → PROJECTION → POS/TILL → QUICK PAY →
MARKETPLACE → INVENTORY → KRA → RECEIPT → REPORTING → REALTIME.

The audit also asserts what must hold **either side** of the handoff: d0443b8 field parity (26
collected, none dropped), the three seller.js regression fields, that `productProjections` has
**not** been widened ahead of the owner's consumer contracts, and that Products still opens the
canonical editor with no second uploader route.

**State at `000c75d`: HANDED OFF.** The four files are tracked; `catalogue.html` landed with them.
`node scripts/audit-catalogue-handoff.js` reports **9 passed, 0 failed, 18 UNPROVEN, 0 NOT RUN**.
A–E are adjudicated below; F–R remain UNPROVEN and are NOT answerable until B, C and E are settled.

### A–E adjudicated 2026-09-22 (handoff `000c75d`) — the canonical model, measured

Method: every row below was read out of the named file at the named line, or executed. Where the
answer needs the emulator or live data it is marked **UNPROVEN** and says what would settle it. No
row is PASS because the code looked plausible.

**Do not read F-1's `posProducts.price` finding as the answer to these.** F-1 established the
*pricing authority for a flash sale*. It says nothing about whether a service is a `posProducts`
row, and the two questions have different answers.

#### The four collections that all hold "a thing a merchant sells"

| Collection | Role | Ownership field | Created by |
|---|---|---|---|
| `posProducts` | what the POS sells from | `merchantId` (SOK- business id) | `posUpsertProduct` — `functions/pos-inventory-pro.js:1565`, on `_h` only, served through `smartPosDispatch` (zero new CFs) |
| `products` | the marketplace listing | `shopId` / `sellerUid` | `pos-marketplace-sync.js:209`, `admin-os.js:1040`, `pos-completeness.js:607` |
| `tenants/{t}/inventory_products` | CSV-import search index | tenant path | the CSV importer — **no bridge to `posProducts`** (`pos-inventory-pro.js:1521-1523`) |
| `productProjections` | mirror | — | deliberately **not widened** by this workstream |

**A. What is the canonical catalogue collection? — ANSWERED, and it is not one collection.**
`posProducts` is canonical **for the till**: the POS sells exclusively from it and
`getSetupStatus.inventoryReady` checks it. `products` is canonical **for the marketplace**, and
`business-bootstrap.js:1309-1322` records the live census — of 108 products, **103 carry
`products.shopId == the owner's uid` and ZERO carry a SOK- merchantId**. Both vocabularies are
real and the platform deliberately accepts both rather than swapping one for the other. A trace
that names a single canonical catalogue is wrong about the platform.

**B. How is PRODUCT distinguished from SERVICE? — FAIL: the discriminator has no server writer.**
`sokoni-catalogue-model.js:237,248` writes `trackStock: false` for a service and `true` for a
product, and `functions/shared/pos-service-pricing.js:12` reads exactly that. But
`posUpsertProduct` — the only server writer of `posProducts` — **never reads or writes
`trackStock`**, measured by fixed-string sweep of `functions/pos-inventory-pro.js` (`trackStock`,
`variablePrice`, `listingType`, `trackInventory` all absent). Its document is an explicit
whitelist, so the discriminator is not merely unset: passed through that writer it is
**discarded**. This is the `d0443b8` class of defect — a field rendered and then dropped — one
layer lower.

Consequence: a service can only exist on a path that bypasses `posUpsertProduct`, which is what
`catalogue.html:457` does (`setDoc(doc(db,'posProducts',id), next, {merge:true})`, straight from
the browser).

**C. What is the canonical non-stock/service flag? — FAIL, three fields, none reconciled.**
`trackStock` (the model, and `pos.js:3104` excluding low-stock alerts) · `trackInventory` (on
`products`) · `active` (what `posUpsertProduct` actually writes, a soft-delete boolean, not a
service flag). These are different fields on different collections, not spellings of one.
`trackStock !== false` means PRODUCT, so **absent keeps meaning product** — that default is correct
and every existing row relies on it.

**D. What is the canonical unit? — ANSWERED, with a vocabulary split.**
`unit` on `posProducts` has a real server writer: `posUpsertProduct` writes it, capped at 24
chars, **defaulting to `'pcs'`**. The model defaults a product to **`'piece'`**
(`sokoni-catalogue-model.js:249`) and requires a non-empty unit for a service
(`:210`). The `seller.js:1063` inventory mirror hardcodes `unit: 'pcs'`, as does
`sokoni-merchant-data.js:345,354`. (§10 also records `productProjections` hardcoding it; that one is
carried forward UNVERIFIED here.) So the field is canonical; its defaults are not agreed, and the
writers produce two spellings for one concept.

**E. How does variable pricing work? — FAIL at the boundary, correct inside it.**
`pos-service-pricing.js` models three never-conflated price sources — `catalogue`, `variable`,
`quick_charge` — and every line records which one it came from. That design is right. But
`posUpsertProduct` requires `price` (`_pcNum(..., { required: true })`) and never writes
`variablePrice`, so a variable-priced service **cannot be expressed through the canonical server
writer**. The model sets `price: 0` for a variable service (`:240`), and a `0` price on a row the
till reads as `prod.salePrice || prod.price` is indistinguishable from free.

#### Two field divergences that will misprice or hide stock

1. **`stock` vs `stockQty` — and the comment that describes it is WRONG.**
   `posUpsertProduct` writes **`stockQty`**, always present on create, and its own header
   (`pos-inventory-pro.js:1534`) says the till reads `prod.stockQty ?? prod.quantity`. **It does
   not.** `functions/pos-zero-friction.js:754` reads
   `prod.stock ?? prod.stockQty ?? prod.quantity ?? 9999` — `stock` takes PRECEDENCE, and
   `functions/index.js:9165` uses the same order. So the model writing `stock`
   (`sokoni-catalogue-model.js:252-256`) is *compatible*, not broken — my first reading of this,
   taken from that comment rather than from the reader, was wrong.

   **The fallback is the defect, and it is an INVENTORY-AUTHORITY defect, not a compatibility one**
   (owner classification, 2026-09-22). The model **deletes** `stock` when the field is left blank,
   on purpose — blank = UNMETERED, not zero, which is the correct invariant. But an absent
   authoritative stock figure reads at the till as **9999**, so the till behaves as though
   inventory were effectively unlimited. An unknown quantity is being DEFAULTED into a large
   concrete one, which is the same class as rendering an unknown metric as `0`: the honest
   value is "unmetered", and only the inventory authority may decide what that permits. Every
   service row created through this surface takes that path.

2. **`merchantId` holds two different kinds of value.** `posUpsertProduct` writes a SOK- business
   id. `catalogue.html:453` writes **`merchantId: uid`** — a uid. `catalogue.html:299` then reads
   back with `where('merchantId','==',uid)`, so the surface is self-consistent and **cannot see
   anything the canonical writer created**. This is the third instance of this exact confusion
   (F-1 found it in `createFlashSale`; `sokoni-merchant-flash.js:604` sends
   `merchantId: ctx.scope.sellerUid`).

#### The blocker A–E exposes, which is not a model question

The **served ruleset** guards `posProducts` on `sellerId`, not `merchantId`:

    firestore.rules:2536-2541,2553-2562
      claimsPosOwner() -> request.resource.data.sellerId == request.auth.uid   (create)
      isPosOwner()     -> resource.data.sellerId == request.auth.uid           (read/update/delete)

Neither writer produces `sellerId`. `posUpsertProduct` writes `merchantId`/`branchId` (it runs with
admin privileges, so rules do not apply to it); `catalogue.html` writes `merchantId: uid` and no
`sellerId` at all. Read from the repo's rule text, **every browser create, read and update from
`catalogue.html` against `posProducts` is denied**, and no document created by `posUpsertProduct` is
readable by that surface either.

**RESOLVED 2026-09-22 against the SERVED artifact — `scripts/test-served-posproducts-authorization.js`,
12 passed / 0 failed.** The verdict was UNPROVEN because repo text is not evidence. It is now proven,
and it is proven the only way that counts:

* **The served artifact was fetched, not read locally.** `GET /releases/cloud.firestore` ->
  ruleset **`ad2033ad-0d26-46d5-9646-1fa94554edc1`**, created `2026-09-19T22:59:34Z`, **156,680 B**.
  Its single file is named **`firestore.rules.build`** — production serves the BUILD, not the source,
  so `firestore.rules` was never the right thing to compare.
* **The served text was loaded into the emulator via `initializeTestEnvironment`**, never
  `emulators:exec`. It says exactly what the repo says: `claimsPosOwner()` /
  `isPosOwner()` on `sellerId`, ONE `match /posProducts/` block (checked — a second block would OR),
  and no alternate admit path.
* **A positive control ran first and still passes**: a create carrying `sellerId == uid` is ALLOWED,
  and reading it back is ALLOWED. Without that, every denial below would be indistinguishable from a
  dead harness or a ruleset that failed to compile — a rules expression error denies EVERYTHING and
  would have produced a perfect score.

Exercised against the served ruleset, with the real document shapes:

| Operation (as the surface actually issues it) | Result |
|---|---|
| CREATE `{merchantId: uid, trackStock: false, …}` — the `catalogue.html` shape | **DENIED** |
| READ a row the browser itself wrote | **DENIED** |
| UPDATE it · DELETE it | **DENIED** |
| READ a `posUpsertProduct` row (`merchantId: SOK-…`) | **DENIED** |
| UPDATE a `posUpsertProduct` row | **DENIED** |
| `LIST where(merchantId == uid)` — the query at `catalogue.html:299` | **DENIED** |
| READ / UPDATE a row carrying `sellerId == uid` | ALLOWED |
| `LIST where(sellerId == uid)` | ALLOWED |

**So `catalogue.html` cannot create, read, update, delete or list `posProducts` in production, and no
document the canonical server writer produced is client-readable at all.** The surface is not
misconfigured against one field; it is locked out of the collection.

**One detail that matters for how this is repaired.** The emulator reports
`Property sellerId is undefined on object` — an **evaluation error**, not a clean `false`. The guard
is reaching the right outcome by the wrong mechanism: it is not deciding "this caller is not the
owner", it is failing to evaluate because the field is absent. Any repair that adds `sellerId` must
be checked against BOTH paths, because a rule that errors and a rule that returns false are the same
denial today and can diverge tomorrow. See the standing rule: a broken expression reads as a working
guard.

**This gate is open under BOTH canonical-writer options.** Option 1 (`posUpsertProduct` learns the
fields) avoids the browser-WRITE question only; reads, updates, deletes and the list query above are
still denied, because they are governed by the same predicate. Option 2 makes this immediately
blocking, since it is what would certify the browser writer at all.

#### Verdicts

| | Question | Verdict |
|---|---|---|
| A | canonical catalogue collection | **PASS** — `posProducts` for the till, `products` for the marketplace; a single-collection answer is wrong |
| B | PRODUCT vs SERVICE | **FAIL** — `trackStock` has no server writer and is discarded by `posUpsertProduct` |
| C | canonical non-stock flag | **FAIL** — `trackStock` / `trackInventory` / `active` unreconciled |
| D | canonical unit | **PASS with a defect** — real writer, two default spellings (`pcs` / `piece`) |
| E | variable pricing | **FAIL** — not expressible through the canonical writer; `price: 0` is ambiguous |
| — | `posProducts` client access | **RESOLVED — DENIED** on the served ruleset `ad2033ad`, 12/0, positive-controlled |

**F–R are NOT answerable from this.** B, C and E fail at the model layer, so a channel, projection
or downstream trace written now would be describing a model the platform does not yet agree on.
The next unit is reconciling the discriminator and the stock field — not writing F–J.

### Unresolved questions for the owner

1. **Is a service a canonical `products/{id}` row, or a `posProducts/{id}` row?** The model
   places it in `posProducts`, which `posCompleteCheckout` does not read and whose client
   queries the served ruleset rejects. A service written only there cannot be settled.
2. **Which flag, on which collection?** `products` carries `trackInventory`; the model uses
   `trackStock`. These are different fields on different collections, not two spellings.
3. **What is `listingType` for?** The editor collects it and — since `d0443b8` — persists it.
   If it is the canonical product/service discriminator, the model should read it rather than
   introduce a second one.
4. **Does `productProjections` need `unit` and a stock flag?** It hardcodes `unit:'pcs'` and
   carries neither. This workstream did not widen it, on purpose.

---

## 11. Flash Sale (§7) — a correct engine behind a broken gate

**The canonical engine is shaped exactly as §7 asks.** `functions/marketing-engine.js` writes
`mktFlashSales/{saleId}` carrying a **`productId`** — a promotion layer over an existing
canonical item, not a second catalogue. It has `createFlashSale`, `getFlashSalePrice`,
`recordFlashSalePurchase` (atomic sold-count with auto-end on sell-through) and a scheduled
`concludeExpiredFlashSales`.

**Merchant V2's Flash Sale route does not use it.** `flash-sale` is `kind:'seller' sec:'flash'`
→ `seller.js launchFlashSale()` → **`localStorage.sokoniFlashSales`**, a per-device array. A
second, device-local flash-sale store.

### Why it was NOT wired, and this is the finding

Two independent defects, both measured:

**1. The merchant gate admits any string role claim.** `_requireMerchant` reads
`req.auth.token?.role ?? 0` and refuses when `role < 2`. SOKONI mints **string** role claims.
Executed rather than read:

```
role absent    -> refused
role 0 / 1     -> refused
role 2         -> ADMITTED
role 'buyer'   -> ADMITTED        Number('buyer') is NaN; every NaN comparison is false
role 'seller'  -> ADMITTED
role 'anything'-> ADMITTED
```

**2. `createFlashSale` never verifies the merchant.** `merchantId`, `productId` and
`originalPrice` all arrive in the payload and are validated for **shape only** — positive
numbers, `salePrice < originalPrice`, valid dates. There is no ownership resolution, no check
that the product belongs to the merchant, and no corroboration of `originalPrice` against the
real product price. `createdBy: uid` is recorded, so there is an audit trail — but no gate.

It is reachable: not exported by name, but live through the exported `commerceDispatch`.

### The bound — and it decides the urgency

`mktFlashSales` is read by **exactly one** consumer: `bi-advanced.js` (sold counts). **No
checkout path reads it** — the till, dispatch and payment orchestrator have zero references,
and `posCompleteCheckout` prices from canonical `products/{id}`.

So a forged flash sale **cannot currently change what anything sells for**. It pollutes BI
reporting. That is a reporting-integrity defect, not a money defect.

**It becomes a money defect the moment flash pricing is wired into checkout — which is exactly
what §7 asks for** ("promotional price", "receipt price", "KRA/tax calculation", "inventory
consequence"). So the gate and the ownership check must be repaired **before** Merchant V2 gets
a Flash Sale button, not after. Wiring first would put a merchant-facing control on a forgeable
authority and convert a contained reporting bug into a live pricing one.

**Not fixed here:** `marketing-engine.js` is a money-adjacent server file and the repair is a
gate change (numeric comparison → the canonical role authority) plus an ownership resolution.
That is its own reviewable unit, not a side effect of a navigation workstream.

---

## 12. Channel availability (§10) — P-3 answered

**The canonical model carries no per-product channel field.** Searched with a control (the
detector finds `lowStockThreshold`): no `posEnabled`, `showInPos`, `posVisible`,
`marketplaceVisible`, `showInMarketplace`, `sellChannels`, `availableOn` or `visibleIn` on a
product anywhere in the writer, the editor or the till. The `posEnabled` hits elsewhere are on
`sellers` documents (absent on every one of them), and `channels` in `analytics-engine.js` is a
sales-reporting dimension, not product visibility.

**The actual behaviour is the inverse of what §10 asks for.** `productProjections` hardcodes
`status: 'active'` on the POS mirror, so **every canonically-created product becomes
POS-visible unconditionally**. §10 asks that an internal POS item not be auto-published to the
marketplace; what happens is that every marketplace product is auto-projected into POS.

A merchant therefore cannot express "Product A: POS yes, Marketplace no". There is nothing to
configure.

**Adding a channel field is a canonical-model change and belongs in the catalogue handoff.**
Inventing one here would be the second model this workstream exists to avoid — and it would
have to agree with whatever the catalogue owner has already designed for services.
