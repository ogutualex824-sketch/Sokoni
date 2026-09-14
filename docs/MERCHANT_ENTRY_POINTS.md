# Merchant Entry-Point Census

> `node scripts/census-merchant-entry-points.js --md`. Read-only.

**99 references** to a merchant workspace across 1147 scanned files.

| category | count |
|---|--:|
| 1 ENTRY — routed through the decision | 4 |
| 2 MODULE — shell mounting its own module | 0 |
| 3 INTERNAL — tests / docs / comments | 7 |
| **4 STALE/BYPASS — public control, hardcoded** | **88** |

## Bypasses — a public control that skips the routing decision

| file | line | how | target |
|---|--:|---|---|
| `404.html` | 48 | href | `/seller.html` |
| `admin.html` | 639 | href | `seller.html` |
| `auth.js` | 500 | href | `seller.html?employee=1` |
| `auth.js` | 500 | location | `seller.html?employee=1` |
| `auth.js` | 802 | href | `seller.html` |
| `auth.js` | 802 | location | `seller.html` |
| `availability-manager.html` | 321 | href | `seller.html` |
| `availability-manager.html` | 710 | href | `seller.html` |
| `beta.html` | 137 | href | `seller.html` |
| `beta.html` | 140 | href | `seller.html` |
| `business-analytics.html` | 153 | href | `seller.html` |
| `business-analytics.html` | 300 | href | `seller.html` |
| `business-os.html` | 180 | href | `seller.html` |
| `community.html` | 236 | href | `seller.html` |
| `community.html` | 937 | href | `seller.html` |
| `construction.html` | 208 | href | `seller.html` |
| `construction.html` | 290 | href | `seller.html` |
| `etims-seller.html` | 110 | href | `seller.html` |
| `fitness-hub.html` | 416 | href | `seller.html` |
| `growth-dashboard.html` | 268 | href | `seller.html` |
| `growth-dashboard.html` | 369 | href | `seller.html` |
| `growth-dashboard.html` | 451 | href | `seller.html` |
| `index.html` | 1519 | href | `seller.html` |
| `index.html` | 1670 | href | `seller.html` |
| `index.html` | 2723 | href | `seller.html#boosts` |
| `index.html` | 2724 | href | `seller.html#flash-sales` |
| `index.html` | 2725 | href | `seller.html#tax` |
| `inv-ai.html` | 145 | href | `seller.html` |
| `inv-ai.html` | 157 | href | `seller.html` |
| `inv-dashboard.html` | 134 | href | `seller.html` |
| `inv-dashboard.html` | 146 | href | `seller.html` |
| `inv-products.html` | 152 | href | `seller.html` |
| `invoice.html` | 265 | href | `seller.html#tax-section` |
| `minishop-admin.html` | 429 | href | `seller.html` |
| `minishop-admin.html` | 446 | href | `seller.html` |
| `minishop-admin.html` | 516 | href | `seller.html#products` |
| `minishop-admin.html` | 519 | href | `seller.html#orders` |
| `ministore.html` | 400 | href | `seller.html` |
| `offer.html` | 149 | href | `seller.html` |
| `offer.html` | 166 | href | `seller.html` |
| `pos-completeness.html` | 525 | href | `seller.html` |
| `pos-completeness.html` | 525 | location | `seller.html` |
| `pos-kds.html` | 262 | href | `seller.html` |
| `pos-kds.html` | 262 | location | `seller.html` |
| `pos.html` | 92 | href | `seller.html` |
| `pos.html` | 276 | href | `seller.html` |
| `profile.html` | 2046 | href | `seller.html` |
| `profile.html` | 2115 | href | `seller.html` |
| `profile.html` | 2186 | href | `seller.html` |
| `profile.html` | 3219 | href | `seller.html` |
| `profile.html` | 3914 | href | `seller.html` |
| `profile.html` | 3921 | href | `seller.html` |
| `profile.html` | 3954 | href | `seller.html` |
| `provider.html` | 303 | href | `seller.html` |
| `provider.html` | 825 | href | `seller.html` |
| `provider.html` | 825 | location | `seller.html` |
| `providers.html` | 262 | href | `seller.html` |
| `providers.html` | 306 | href | `seller.html` |
| `qr-center.html` | 256 | href | `seller.html` |
| `script.js` | 1084 | href | `seller.html` |
| `script.js` | 1653 | href | `seller.html` |
| `script.js` | 1702 | href | `seller.html` |
| `script.js` | 1954 | href | `seller.html` |
| `script.js` | 3358 | href | `seller.html` |
| `script.js` | 3485 | href | `seller.html?tab=stories` |
| `sell.html` | 167 | href | `/seller` |
| `sell.html` | 436 | href | `/seller` |
| `seller-analytics.html` | 292 | href | `seller.html` |
| `seller-analytics.html` | 294 | href | `seller.html` |
| `seller-earnings.html` | 219 | href | `seller.html` |
| `seller-earnings.html` | 222 | href | `seller.html#products` |
| `seller-revenue.html` | 92 | href | `seller.html` |
| `seller-revenue.html` | 92 | location | `seller.html` |
| `seller-success.html` | 139 | href | `seller.html?tab=products` |
| `seller-success.html` | 161 | href | `seller.html` |
| `seller-success.html` | 162 | href | `seller.html?tab=products` |
| `seller-success.html` | 330 | href | `seller.html?tab=products` |
| `seller-success.html` | 391 | href | `seller.html?edit=${p.id}` |
| `seller-success.html` | 433 | href | `seller.html?edit=${p.id}` |
| `seller-wallet.html` | 161 | href | `seller.html` |
| `seller.html` | 378 | href | `seller.html#store` |
| `seller.html` | 378 | location | `seller.html#store` |
| `sokoni-nav-engine.js` | 493 | href | `seller.html` |
| `sokoni-nav-engine.js` | 564 | href | `seller.html` |
| `sokoni-ui-extras.js` | 257 | href | `seller.html` |
| `subscriptions.html` | 153 | href | `seller.html` |
| `subscriptions.html` | 323 | href | `seller.html` |
| `subscriptions.html` | 323 | location | `seller.html` |

## The finding that matters most — the post-login redirect

`auth.js:876-881` decides where EVERY signed-in account lands:

```js
user = JSON.parse(localStorage.getItem("sokoniUser"));   // <- localStorage
...
if (cb("roleSellerCb")) user.registeredAs.seller = true;      // <- a signup CHECKBOX
...
if (user.registeredAs.seller) { dest = "seller.html"; }       // <- the OLD shell
```

Two defects in one branch:

1. **It bypasses the routing contract entirely.** A seller never presses "My Store" — signing
   in already dropped them in the old shell. Fixing the four buttons while this stands would
   be cosmetic.
2. **It decides on a forgeable signal.** `registeredAs.seller` comes from localStorage and is
   set by a checkbox the user ticked at signup. The live `noPrivilegeEscalation()` guards only
   `admin`/`superAdmin`/`moderator`/`isAdmin` inside `registeredAs`, so `registeredAs.seller`
   is client-writable. Anyone who ticked "I want to sell" is routed as a seller, approved or not.

**Required change (NOT applied — this sweep is read-only):** the post-login destination must ask
`SokoniMerchantEntry.resolve()` rather than read a checkbox, so the same approval authority
governs the redirect and the buttons.

## Census blind spot, stated

Both shells set their iframe source dynamically (`f.src = src` with a variable), so **no module
mount is a literal** and category 2 legitimately reads 0. The census counts literal destinations
only; it does not follow a computed one. That is also why no mount was mistaken for a bypass.
