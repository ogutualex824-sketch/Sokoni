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
