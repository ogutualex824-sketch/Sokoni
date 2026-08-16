# Marketing Authority Census

> Regenerate: `node scripts/census-marketing-authority.js --md > docs/MERCHANT_MARKETING_AUTHORITY.md`
> Read-only. No exports added, no authorization changed, no UI built.

Companion to [[MERCHANT_2D2_AUTHORITY_CENSUS]]. Resolves the three questions that census left open for Marketing.

## 1 — The four Minishop functions

| callable | exported | auth | ownership | client scope | collections | verdict |
|---|---|---|---|---|---|---|
| `createMinishopCampaign` | yes | yes | shop | yes | `shops` `minishopConfig` `minishopCampaigns` | **SAFE** |
| `getMinishopCampaigns` | yes | yes | shop | yes | `shops` `minishopCampaigns` | **SAFE** |
| `deleteMinishopCampaign` | yes | yes | **creator** | no | `minishopCampaigns` | **SAFE AFTER AUTH HARDENING** |
| `pauseMinishopCampaign` | yes | yes | **creator** | no | `minishopCampaigns` | **SAFE AFTER AUTH HARDENING** |
| `miniShopCreatePromotion` | yes | yes | shop | yes | `minishopPromoCodes` `minishopPromotions` | **SAFE** |
| `miniShopGetPromotions` | yes | public (by design) | **none** | yes | `minishopPromotions` | **SAFE** |
| `miniShopUpdatePromotion` | yes | yes | shop | yes | `minishopPromotions` `minishopPromoCodes` | **SAFE** |

### The divergence inside one module

`createMinishopCampaign` and `getMinishopCampaigns` authorise against the **shop**:
`shops/{shopId}.sellerUid !== uid` → denied. `deleteMinishopCampaign` and
`pauseMinishopCampaign` authorise against the **campaign document's creator**:
`minishopCampaigns/{id}.uid !== uid` → denied. They are not the same rule.

For a single-owner shop the two coincide, which is why the difference is invisible in
normal use. They separate when ownership moves: a shop transferred to a new owner leaves
every existing campaign undeletable and unpausable by the person who now owns the shop —
their shop, their campaigns, permanently locked. Nothing repairs this, because no path
rewrites `campaign.uid`.

**`deleteMinishopCampaign` is also a hard delete** (`.delete()`), destroying the campaign's
click, view, order and revenue history with it. `pauseMinishopCampaign` already provides the
reversible action, so the destructive one is the odd path, not the necessary one.

**The correct pattern already exists one module away.** `miniShopUpdatePromotion` handles the
same shape — mutate a document reached by its own id — by reading the document first and then
asserting on the shop it names:

```js
const promoData = promoSnap.data();
await _assertShopOwner(promoData.shopId, uid);   // the SHOP decides
```

`deleteMinishopCampaign` and `pauseMinishopCampaign` reach the same point and then ask a
different question (`docSnap.data().uid !== uid`). Hardening them is not new design work; it
is applying the rule their sibling already uses.

### The metric integrity problem behind the whole screen

`trackCampaignClick` is an **`onRequest` with no authentication at all**. It takes
`campaignId`, `shopId` and `event` from the request body and increments
`clicks` / `views` / **`orders`** on the campaign, rate-limited to 10 per IP per campaign
per hour. `getMinishopCampaigns` then returns those counters and derives `roi` from
`orders / clicks`.

So every number a Marketing screen would show for a campaign — including orders and ROI —
originates from an endpoint any anonymous caller can drive. Under the standing rule that no
UI component may fabricate a business metric, these cannot be presented as order counts or
return on investment. They are traffic counters with a spam floor.

### Error shape

`minishop-campaigns.js` throws bare `Error`, not `HttpsError` — so every refusal reaches the
client as `internal` with the message attached, and a caller cannot distinguish
"not your shop" from a genuine server fault by code. `minishop-v3.js` uses `HttpsError`
correctly. A Marketing UI must therefore read messages, not codes, for the campaign half.

## 2 — createAdCampaign scope

| callable | exported | auth | ownership | client scope | collections | verdict |
|---|---|---|---|---|---|---|
| `createAdCampaign` | yes | yes | **none** | no | `sokoAds` | **SHOP-SCOPE DECISION REQUIRED** |

The canonical merchant model established across 2D-1 and 2D-2 is:

```
auth.uid → sellerUid → activeShopId → shops/{shopId}
```

`createAdCampaign` writes `sokoAds` with `sellerUid: uid` and **no `shopId` at all**. Every
reader agrees: `functions/index.js:4806` and `sokoni-featured.js:54` both query `sokoAds`
by `status == "active"` only. A repo-wide search finds **no shop scoping on `sokoAds`
anywhere** — not in the writer, not in either reader.

So the account-level scope is **consistent**, not an oversight in one place. What has changed
is the surrounding model: a merchant may now own more than one shop, and an ad created in the
Marketing screen of Shop B would be indistinguishable from one created for Shop C.

**This is recorded as a decision, not silently broadened.** Adding `shopId` to the write
without changing the readers would produce a field nothing honours — the appearance of shop
scoping with none of the behaviour, which is worse than the honest account-level scope that
exists now. The options are:

- **A. Keep account scope.** Marketing → Ads is a seller-level surface, labelled as such, and
  shown identically from every shop the account owns. No code changes.
- **B. Introduce shop scope properly.** Writer records `shopId`, both readers filter by it,
  and existing `sokoAds` rows need a backfill decision. A real piece of work, not a field.

Until that is decided, Marketing must not present Ads as belonging to the active shop.

Two smaller findings in the same body: `budgetKES` is accepted with only a truthiness check —
no minimum, no maximum, and `Number(budgetKES)` will happily store a negative. It is written
`status: "pending_review"` with `spentKES: 0`, so no money moves at creation and an admin gate
stands between it and spend; the validation gap is real but not a payment hole.

## 3 — The eleven marketing-engine callables

| callable | exported | auth | ownership | client scope | collections | verdict |
|---|---|---|---|---|---|---|
| `createBundleDeal` | **no** | yes | **none** | yes | `mktBundleDeals` | **BLOCKED** |
| `getActiveBundleDeals` | **no** | **no** | **none** | yes | `mktBundleDeals` | **BLOCKED** |
| `createFlashSale` | **no** | yes | **none** | yes | `mktFlashSales` | **BLOCKED** |
| `getFlashSalePrice` | **no** | **no** | **none** | yes | `mktFlashSales` | **BLOCKED** |
| `recordFlashSalePurchase` | **no** | yes | **none** | no | `mktFlashSales` | **BLOCKED** |
| `getCrossSellRecommendations` | **no** | **no** | **none** | yes | `mktRecommendationEngineLog` `posProducts` | **BLOCKED** |
| `getUpsellRecommendations` | **no** | **no** | **none** | yes | `posProducts` | **BLOCKED** |
| `createMarketingCampaign` | **no** | yes | **none** | yes | `mktCampaigns` | **BLOCKED** |
| `runABTest` | **no** | yes | **none** | yes | `mktABTests` | **BLOCKED** |
| `recordABTestImpression` | **no** | **no** | **none** | no | `mktABTests` | **BLOCKED** |
| `applyCouponCode` | **no** | yes | **none** | yes | `mktCouponCodes` `orders` | **BLOCKED** |

### None of them verifies the merchant it is told about

Every one of these takes `merchantId` **from the request** and uses it to read or write.
A search of the whole module for an ownership assertion — the `shops` collection,
`assertShopOwner`, `ownerId`, `sellerUid`, or any comparison of `merchantId` to the caller —
returns **nothing**. `_requireMerchant` establishes that the caller has *a* merchant role;
it never establishes that they are *this* merchant.

So re-exporting them as they stand would publish eleven cross-tenant write paths.

### The gate does not merely fail closed — it inverts

```js
const role = req.auth.token?.role ?? 0;
if (role < 2) _err('Seller / merchant role required.', 'permission-denied');
```

| claim value | `role < 2` | outcome |
|---|---|---|
| absent (the production norm) | `0 < 2` → true | **refused** |
| `true` (boolean claims, as minted) | `true < 2` → true | **refused** |
| `"seller"` | `NaN < 2` → false | **allowed** |
| `"buyer"` | `NaN < 2` → false | **allowed** |
| `"anything at all"` | `NaN < 2` → false | **allowed** |

A string comparison against a number is `NaN`, and every comparison with `NaN` is false — so
the guard passes. It refuses the accounts that legitimately have no numeric claim, and admits
any account carrying a *string* `role` claim regardless of its value. Several modules in this
codebase read `claims.role === 'admin'`, so a string `role` claim is a shape this system
already expects to exist.

That is the decisive reason not to add the exports first. "Unsatisfiable" would be safe to
ship and useless; **inverted** is neither.

### Two of them read a collection the platform moved off

`getCrossSellRecommendations` and `getUpsellRecommendations` read `posProducts`. The canonical
product collection is `products` — `posCompleteCheckout` was converged onto it precisely
because `posProducts` was empty for most merchants. Recommendations built on it would be
empty for the same merchants, and would not see the catalogue Sell and Inventory operate on.

## What may be built on, today

| classification | capabilities |
|---|---|
| **SAFE** | `createMinishopCampaign`, `getMinishopCampaigns`, `miniShopCreatePromotion`, `miniShopGetPromotions`, `miniShopUpdatePromotion` |
| **SAFE AFTER AUTH HARDENING** | `deleteMinishopCampaign`, `pauseMinishopCampaign` |
| **SHOP-SCOPE DECISION REQUIRED** | `createAdCampaign` |
| **BLOCKED** | `createBundleDeal`, `getActiveBundleDeals`, `createFlashSale`, `getFlashSalePrice`, `recordFlashSalePurchase`, `getCrossSellRecommendations`, `getUpsellRecommendations`, `createMarketingCampaign`, `runABTest`, `recordABTestImpression`, `applyCouponCode` |

### Recommended Marketing scope

Build the first Marketing surface on the **SAFE** set only — shop-scoped campaign create and
read, and the shop-scoped promotions path. That is a coherent screen on its own.

Leave out, deliberately and visibly:

- **Ads**, until the account-vs-shop scope decision is made.
- **Campaign delete**, until it authorises against the shop rather than the creator; `pause`
  is the reversible action and has the same defect, so both wait together.
- **Order and ROI figures**, until a campaign's conversion counters come from somewhere an
  anonymous caller cannot increment. Clicks and views may be shown, labelled as traffic.
- **Everything in marketing-engine**, until ownership assertion and the role gate are fixed.
  Re-exporting is the last step of that work, not the first.
