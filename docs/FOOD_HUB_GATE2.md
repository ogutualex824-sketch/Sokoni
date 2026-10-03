# Food Hub Gate 2: Menu, Drinks and Kitchen

**Date:** 2026-10-03 · **Owner:** sokoni-5b · **Status:** built and tested. **NOT deployed. Food Hub is NOT user-ready.**

Related: [[Food Hub]] · [[Food Hub Gate 1]] · [[Capability Engine]] · [[Business Workspace]] · [[Products]] · [[Inventory]] · [[Orders]] · [[shopOffers]]

| Part | Branch @ commit | Deploy unit |
|---|---|---|
| Server: `foodMenu` + module switch | `feat/food-gate2-menu-on-5dc505e` @ `f606a97`, `1e5c64f` (on the capability line) | new function `foodMenu`; `service-capabilities` rides the providerDispatch release |
| merchant-v2 Menu / Drinks / Kitchen | `hosting/food-gate2-merchant-ui-on-fbdcd33` @ `1dfeb16` (on the support-button branch, off live `72dca56`) | hosting |
| Buyer menu page | `hosting/food-gate2-public-menu-on-df0ddbd` @ `fd1aaf7` (on the food containment + S1 line) | hosting |

## Authority map (census, 2026-10-03)

| Concern | Canonical authority | Class | Gate 2 decision |
|---|---|---|---|
| Product records | `products/{id}`, written by the client (`sokoni-merchant-data.js`); served rules protect only `noAdminFields` | CLIENT-AUTHORITATIVE | Menu items **are** products. `foodMenu` is the server writer for menu items and uses the same id derivation. No `foodMenuProducts` collection. |
| Stock | `products.stock` / `inventoryVersion`; sale transactions; `merchantAdjustStock` | CANONICAL | Never written by the menu. Opening stock goes through `merchantAdjustStock`. Dishes are **unmetered**, meaning absent stock, not zero. |
| Availability | `shared/sellability.availabilityOf`: `outOfStock` flag, `status`, `isVisible` | CANONICAL (`outOfStock` had **no writer**) | `setAvailability` writes `outOfStock` plus `menu.availability`. |
| Archive | `sellability.tombstonePatch` (`status 'archived'`, `isVisible false`) | CANONICAL; merchant-v2 Products still hard-deletes (**finding**) | `archive` writes the tombstone only. |
| Price tiers | No tier model. `salePrice` (flash) and `wholesalePrice` (b2b) exist. | — | The menu edits the base `price` only. Tiers are not invented. |
| Staff | `merchant-identity.resolveActor` (owner / manager / cashier / staff) | CANONICAL for merchant-v2 | Edits: owner and manager. Availability: also cashier. Read: everyone. **No `kitchen` role exists**, so none was invented. |
| Food modules | `service-capabilities.MERCHANT_MODULES` via `workspaceFor` | CANONICAL (merchant-v2 never consumed it before) | menu and drinks are `implemented:true`. Kitchen stays `NOT_IMPLEMENTED` (`FOOD_ORDERS_PENDING`). |
| Plan lock | `productCounters` + `resolveMaxProducts` (the same counter the `withinProductLimit` rule reads) | CANONICAL | Checked before create; a refusal writes nothing. |
| Orders / status | `orders/{id}`. The seller changes status by **direct write** (rules :380-384). No seller callable, no transition graph. | CLIENT-AUTHORITATIVE (**finding**) | Kitchen performs **no** status mutation (Gate 3 dependency). |
| KDS | `pos-completeness` kds* (dispatch-only), `pos-kds.html`, `kitchen-display.html` | LEGACY / FAKE (rule-denied) | Not reused. |
| `foodMenus` / `foodOrders` / `sokoni-food.js` | rules :541-560; hard-coded `RESTAURANTS` / `MENUS` | FAKE / CLIENT-AUTHORITATIVE (contained) | Not reused. **Finding:** the `foodMenus` rule is still open. |
| Offers | `shopOffers` (`shop-offers.js`, `listingId` = productId), **not on any live lineage** | Branch-only | Menu items are products, so `listingId` = menu item id with no adapter (Gate 4). |
| Tax / levy | Per-seller VAT (`etims`); POS `taxTotal` is client-supplied; no levy anywhere | — | No tax fields added. The levy stays off and per-business (Gate 5). |
| Storefront | `store.html` shows **drafts and archived items**, and injects `category` unescaped (**finding**) | LEGACY | The food page reads `foodMenu {op:'public'}` instead (published + listed + shop gate). |

## What was built

**`functions/food-menu.js`, callable `foodMenu`.**
- **Ops:** `load`, `modules`, `saveSections`, `saveItem`, `setStatus`, `setAvailability`, `archive`, `reorder`, `public`.
- **Sections:**
  - stored at `shops/{shopId}.menu.sections`. The served rules keep `shops` owner updates to an allow-list that excludes `menu`, so only the server writes them;
  - kinds are `food` and `drinks`;
  - a section holding live items cannot be removed.
- **Items:** `products/{id}`.
  - Server-set fields:
    - `shopId`, plus `sellerUid` = the shop owner, even when a manager creates the item;
    - `status:'draft'` on creation;
    - `menu {sectionId, kind, sortOrder, availability, availableAgainAt, prepMinutes}`;
    - `category` = the section name, which existing storefronts group by;
    - `variants [{id, name, price}]` and `revision`.
  - Browser-supplied owner, status, salePrice, commission, stock and approval fields are ignored.
- **Drinks:** the same product in a drinks section. The Drinks view is a filter of one list.
- **`modules`:** the shop owner's workspace module states, readable by any staff member. `providerDispatch` answers per *caller*, and a manager's own account has no business.
- **`public`:**
  - only a shop that passes `shopEligibility` and holds an approved food workspace;
  - only published, listed items, with `availabilityOf` state;
  - `orderable:false`, `ordering:'NOT_OPEN'`.

**merchant-v2.**
- **Module:** `sokoni-merchant-food.js` is one module with three views.
- **Routes:** `menu`, `drinks` and `kitchen` sit in a **Food business** group.
  - They are hidden by default and revealed only by `foodMenu {op:'modules'}`.
  - A typed `#menu` URL renders the server's own explanation.
- **Behaviour:**
  - reload after every server answer;
  - a success toast only after the server's ok;
  - every server string escaped.
- **Photos:** the existing `SokoniMerchantData.attachProductImages`.
- **Opening stock:** `merchantAdjustStock`.
- **Kitchen:** the board (NEW / PREPARING / READY / HANDED OFF) with `—` counts and the dependency stated. No orders and no demo tickets.

**Buyer page.**
- `food-menu.html?shop=<id>` renders the real published menu, read-only, with no cart, add or pay control.
- Anything else leaves the "Ordering opens soon" containment in place.

## Evidence

| Suite | Result |
|---|---|
| `scripts/test-food-menu.js`: REAL handler + REAL `resolveActor` + REAL `workspaceFor` on an in-memory Firestore | **47/0**; BASE `5dc505e` fails at load (no authority) |
| `scripts/sabotage-food-menu.js` | **16/16**, each caught by its named row. The first run missed one (the approval gate was masked by an absent module map); fixed with row S-4b. |
| `scripts/test-merchant-food-ui.js`: REAL module in a vm DOM + shell source | **19/0**; base fails at load |
| `scripts/sabotage-merchant-food-ui.js` | **7/7** |
| `scripts/test-food-public-menu.js` | **12/0**; sabotage **4/4** |
| `test-service-capabilities` | **15/0**. B-6 updated: menu and drinks are now AVAILABLE, which is the intended change. |
| `test-business-workspace` / `test-tech-service-profile` | 30/0 · 18/0 |
| `test-merchant-routes` / `test-merchant-support-button` | 64/0 · 9/0 |
| `test-merchant-capability` | 44/2. Both failures already exist on live `72dca56`; their lists now also name the v1-withheld food routes. |
| `test-food-containment` / `test-food-s1-entry` | 7/0 · 14/0 |
| Browser suites (`test-merchant-route-gate`, `-overlays`) and emulator suites | **UNPROVEN**: memory is below the 512 MB floor |

**Security matrix (all PROVEN by rows, each asserting that nothing was written):**
- a stranger edits a menu (S-1);
- business B publishes or archives A's item (S-2, S-16);
- B acts as shop A (S-3);
- a pending business gets a menu (S-4);
- a stale module map gets through (S-4b);
- a non-food business gets a menu (S-5);
- a cashier edits the menu (S-6);
- staff change availability (S-8);
- an unknown role gets access (S-10);
- the plan limit is ignored (S-12);
- a forged price (P-1) or forged owner/status/stock/commission fields (P-2) are accepted;
- path-like ids are accepted (S-13).

## Findings (not fixed in Gate 2, owners named)

1. **Product fields are unprotected on the served rules** (`products/{id}`: `price`, `status`, `stock`, `salePrice`, `shopId`). The owner can still write directly; the server authority does not remove that path. Rules lane.
2. **A seller can write any order status directly**, including `paid`, `confirmed` and `refunded` (rules :380-384, no transition graph). This inflates GMV analytics on `paid` and auto-assigns a rider on `confirmed`. Gate 3 / order authority.
3. **`store.html` lists draft and archived products and injects `category` unescaped** (stored XSS). Gate 5 storefront.
4. **merchant-v2 Products hard-deletes** (`deleteDoc`), against the tombstone invariant.
5. **The `foodMenus/{restaurantId}` rule is still open** (owner write, public read) with no reader. Rules lane: close it.
6. **`pos-kds.html` and `kitchen-display.html` are FAKE.** Their reads and writes are rule-denied, so they are dead screens.
7. **No `kitchen` staff role** exists in `resolveActor`. Owner decision if kitchen staff need their own role (Gate 3).

## Gate 3 handoff contract

| Contract | Value |
|---|---|
| **Menu item identity** | `products/{id}` with `menu != null`; id `prd_<shopId>_<djb2>`. One record for food and drinks. |
| **Seller / business identity** | `products.shopId` + `products.sellerUid` (the shop owner) = Gate 1's `shops/{uid}`. Approval and category come from `workspaceFor(owner)`. |
| **Price source** | `products.price` (base) and `variants[i].price`, read **server-side** at order creation. Never a browser total. `salePrice` is honoured only where the checkout authority already does. |
| **Inventory reference** | Metered items have `stock` and decrement in the order transaction (floored, `inventoryVersion` +1). Unmetered dishes have no `stock` and are always sellable unless flagged. |
| **Availability state** | `sellability.availabilityOf(product, shop).sellable` must be true at order time. `outOfStock` is the merchant's flag. |
| **Kitchen order contract** | A food order must carry the shop (`shopId` / `sellerUid` set by the **server**), lines `{productId, variantId?, qty, unitPrice}` and `fulfilment` (pickup/delivery). The kitchen lists **paid** food orders only. |
| **Order status authority** | **Missing.** Gate 3 must add a server callable with a transition graph (e.g. accepted → preparing → ready → handed_off), checking the actor via `resolveActor`, valid transitions and order ownership. Then close the direct seller status write in the rules. Until then Kitchen stays `NOT_IMPLEMENTED`. |
| **Storefront projection** | `foodMenu {op:'public'}`: published + listed + shop-eligible + approved food workspace. Gate 3 turns `orderable` on only for `sellable` items once ordering opens. |
| **Offer reference point** | `shopOffers.qualifyingListingIds[]` / `items[].listingId` = the menu item's product id. No adapter is needed (Gate 4). |
| **Tax / levy** | No per-item tax fields. VAT stays per seller (`etims`). The catering levy is applied only by the transaction authority, per business and off by default (Gate 5). |

## Deployment (not done)

Deploy only after all of these:
1. the webhook P0 release and the food containment;
2. Gate 1 (`applicationLifecycle`) and the providerDispatch release carrying Slice 0, the module switch and this branch's `service-capabilities`;
3. a scoped `--only functions:foodMenu` from this lineage, at or above the 512 MB floor;
4. the hosting assembly order: support button, then the food UI; the public menu on the food line.
