# Merchant Capability Map — seller.html → merchant.html

**Read-only census. Nothing was changed.** Regenerate:
`node scripts/census-merchant-capability-map.js`.
Companion to [[Merchant Consolidation Census]] (stage 1, `0792503`), which counted the routes; this
one opens them up and decides *how* each is consolidated.
Related: [[SmartPOS Merchant OS]] · [[POS Checkout Stock Authority]] · [[Role Authority]]

---

## The headline: this is not an extraction job

The plan assumed `seller.html` holds working merchant logic to lift into shared modules. It mostly
does not. **All eleven borrowed capabilities read their state from `localStorage`**, not from a
canonical source:

| route | section | device-local keys (uses in seller.js) | verdict |
|---|---|---|---|
| products | `products` | `sellerProducts` ×34, `sokoniStockAlerts` ×2 | **REBUILD** |
| receipts | `receipts` | `sokoniOrders` ×13 | **REBUILD** |
| staff | `team` | `sokoniEmployees` ×7, `sokoniEmployeeSession` ×2 | **REBUILD** |
| messages | `messages` | `sokoniMessages` ×5, `sokoniQA` ×3 | **REBUILD** |
| marketing | `marketing` | `sokoniCampaigns`/`sokoniAds`/`sokoniPromoCodes`/`sokoniOffers` ×5 each | **REBUILD** |
| flash-sale | `flash` | `sokoniFlashSales` ×5 | **REBUILD** |
| kra-tax | `tax` | `kraPinSaved` ×4, `sokoniExpenses` ×5 | **REBUILD** |
| stories | `stories` | `sokoniStories` ×4 | **REBUILD** |
| disputes | `disputes` | `sokoniDisputes` ×1, `sokoniReturns` ×3 | **REBUILD** |
| customers | `customers` | `sokoniStoreFollowers` ×1, `sokoniFollowNotifications` ×2 | **REBUILD** |
| shop | `store` | `sokoniMiniStore` ×2, `sokoniSellerVerification` ×2 | **REBUILD** |

Whole-file data surface:

| file | localStorage keys | Firestore collections | callables |
|---|---|---|---|
| `seller.js` (280KB) | **28** | 9 | **2** (`canPublishProduct`, `inviteShopEmployee`) |
| `seller.html` (445KB) | 11 | 8 | 5 (`getShopProfile`, `saveShopProfile`, `getMyMinishop`, `getSellerDisputes`, `sellerRespondToDispute`) |
| `merchant.html` (161KB) | 5 | 2 | 2 |

**Consequence for the plan.** "Extract into shared modules, then point merchant.html at them" would
carry a device-local data model into the new workspace — and the standing rule (CLAUDE.md, *UI Data
Integrity*) forbids exactly that: business figures must come from a canonical source, never from
`localStorage`. So the correct shape is:

- **REBUILD (11)** — keep the *screens and interaction design*, re-source the data. The server side
  mostly already exists (`products`, `orders`, `providerBookings`, `commissionLedger`, the POS
  callables); what is missing is the read path, not the backend.
- **EXTRACT (0 of the eleven)** — the extractable assets are in `seller.html`'s callable-backed
  corners (shop profile, MiniShop, disputes) and in the already-shared modules
  (`sokoni-receipt.js`, `sokoni-image.js`, `PosPrintService`, `sokoni-merchant-routes.js`).
- **NATIVE (9)** — dashboard, orders, analytics, revenue, payments, settings, reports, availability,
  devices already belong to merchant.html.

A capability whose only state is a `localStorage` array is not a module to lift; it is a screen to
re-point. Porting it verbatim would move a defect into the page that is supposed to replace it.

---

## Frozen-authority baseline — and one live breach

The directive was *"do not reintroduce `_decrementStock`, `totalUnitsSold`, `products.totalRevenue`,
seller-keyed analytics, or client-authoritative sale writes."* Measured against the tree, one of
those is not waiting to be reintroduced — **it is live**:

| pattern | client hits | writers |
|---|---|---|
| `_decrementStock` (by name) | 3 | `seller-wiring.js:115/230/244` |
| `totalUnitsSold` (by name) | 1 | `seller-success.html:409` (read) |
| `totalRevenue` (by name) | 70 | reads |
| **client writes `products.stock`** | **2** | `seller-wiring.js:125` `stock: increment(-1)` · `sokoni-db.js:800` |
| **client writes `products.sold`** | **2** | `seller-wiring.js:126` `sold: increment(1)` · `sokoni-db.js:801` |

`seller-wiring.js` is loaded by **`checkout.html`** — the live buyer checkout — and is precached by
the service worker. On every completed checkout it patches `saveAndRedirect` and fires, per line
item:

```js
updateDoc(doc(db,'products',item.id), { stock: increment(-1), sold: increment(1) }).catch(()=>{});
```

Meanwhile the canonical server path (`functions/index.js:2920-2945`, the payment webhook) already
deducts stock **transactionally, by quantity**, floored at zero, writing `stock` + `updatedAt` +
`inventoryVersion` together and raising `oversoldAlerts` on a shortfall.

Both run. Three consequences follow, and none of them are being fixed here:

1. **Stock is double-decremented** on every online order — server `-qty`, client a further `-1` per
   distinct line item.
2. **The client decrement ignores quantity.** An order of five units decrements one.
3. **`products.sold` has no server writer at all** — the two writers in the tree are both
   client-side and both fire-and-forget (`.catch(()=>{})`). That makes `seller-wiring.js:126` the
   most plausible origin of the **unsourced `product.sold = 17,162`**, and explains why it cannot be
   reconciled against orders: it counts line items on the checkout path, not units sold.

**Untouched, per the standing boundary** (`product.sold`, the 17,162 figure and the frozen sales
architecture are all explicitly off-limits in this track). Recorded here so the rebuild does not
inherit it, and so the 17,162 question has a documented lead when it is opened deliberately.

---

## Deep links that must keep working

**37 deep links across 15 files**, and they are not evenly shaped:

```
#products(4)  ?tab=products(4)  ?employee=1(2)  #orders(2)  #flash(2)
#disputes(2)  ?edit=(2)  #earnings(1)  #boosts(1)  #flash-sales(1)  #tax(1)  #tax-section(1)
```

Two anchor vocabularies are already in use for the same destinations (`#flash` and `#flash-sales`,
`#tax` and `#tax-section`), so the compatibility layer must map *both*. `?edit=` and `?employee=1`
carry state, not just a section — a redirect that drops the query string silently loses the thing
the merchant clicked. Backend email templates also deep-link into `seller.html`
(`functions/index.js`, `email-templates.js`), so links already in merchants' inboxes have to keep
resolving.

## Mobile signals (static baseline)

| page | viewport | `<table>` | iframes | bottom nav | max-width queries |
|---|---|---|---|---|---|
| merchant.html | yes | **0** | 1 | yes | 5 |
| seller.html | yes | **8** | 1 | yes | 12 |
| pos.html | yes | 3 | 0 | yes | 3 |
| checkout.html | yes | 0 | 0 | yes | 2 |

merchant.html is already table-free; `seller.html` carries eight tables, which is the horizontal-
scroll problem the mobile-first brief names. The single iframe in merchant.html is the seller mount
this track removes. These are **static** signals — real viewport interaction (tap targets, one-hand
cart reach, sticky bars over browser chrome) has to be measured in a device viewport during
implementation, not inferred from source.

---

## What this changes about the plan

1. **Stage 2D is a rebuild, not a port.** Budget it as eleven screens re-sourced onto canonical
   data, in priority order: Sell/POS → Inventory → Orders/Receipts → Shop → Subscription → Settings.
2. **Sell + Inventory come first and together**, because they are the only pair with a real server
   authority already in place (`posCompleteCheckout`, the payment webhook, `inventoryVersion`).
   Everything else can follow without blocking a merchant from trading.
3. **The compatibility layer is query-string-aware**, not a blanket redirect.
4. **`checkout.html`'s client-side stock/sold write is a separate, deliberate decision** — it is a
   correctness defect in the frozen sales path, not UI work, and it should not be smuggled into a
   consolidation commit.

Nothing here is implemented. Next commit boundary is 2D-1 (Sell/POS + Inventory on canonical data),
once the above is agreed.
