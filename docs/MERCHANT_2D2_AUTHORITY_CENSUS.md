# 2D-2 Authority Census

> Regenerate: `node scripts/census-merchant-2d2-authority.js --md > docs/MERCHANT_2D2_AUTHORITY_CENSUS.md`
> Read-only: no network, no writes, no implementation change.

Companion to [[MERCHANT_CAPABILITY_MAP]] and [[MERCHANT_CONSOLIDATION_CENSUS]].


## Legacy baseline

seller.js carries **28** device-local keys and only **2** callable invocations.

That ratio is the whole finding: for these eleven screens seller.js is not a data layer to port, it is a **device-local cache with no server behind it**. Every verdict below is therefore about the authority that must exist *elsewhere*, not about seller.js.

## Headline findings

1. **An entire authority module is written but not deployed.** `functions/marketing-engine.js` exports 12 callables covering Flash Sales, Bundles, Campaigns, A/B tests and Coupons. **11** of them are never re-exported in `functions/index.js`, so they do not exist at runtime. The one that IS re-exported is `concludeExpiredFlashSales` — a scheduled job that expires rows in `mktFlashSales`, a collection **no deployed callable can write**. This is the `sellerApplications` shape from the previous census: a live trigger over a starved collection.

2. **That module's auth gate is unsatisfiable, and it is not alone.** `_requireMerchant` reads `req.auth.token.role ?? 0` and rejects anything below `2` — a *numeric* role claim. Every one of the **18** `setCustomUserClaims` call sites in `functions/` was opened and checked for a numeric `role`: **0** mint one. The canonical shapes are boolean custom claims and a `roles` ARRAY on `users/{uid}`, so `?? 0` always wins and every caller is refused. The same gate appears in **2** files (`b2b-wholesale.js`, `marketing-engine.js`) — a **fourth** role representation alongside claims-boolean, `roles`-array, and the `.role` string analytics reads.

3. **`orderAdvance` has no ownership check.** It is the only order-status authority, it is deployed, and it verifies only that the caller is signed in. It accepts any `orderId`, advances that order's timeline, and on the `accepted` stage sets `status: 'confirmed'` — which is what triggers rider auto-assignment. This is a live IDOR independent of 2D-2, not merely a blocker for the Orders screen.

4. **`shopEmployees` writer and readers disagree on the document key** — see the cross-cutting section. This one reaches backwards into the Inventory surface shipped in 2D-1C.

5. **Stories has no server authority of any kind** — and `demo-seed.js` writes the same `sokoniStories` key the screen reads, which is a demo/seed path touching a production surface.

## Constraints this census observed

- No implementation was modified. No Merchant button, route or surface was removed, hidden or retargeted.
- POS, and the native Sell/Inventory surfaces from 2D-1C, are untouched.
- seller.js's localStorage model is recorded as a **dependency to retire**, never as a model to port.
- A callable is judged by its opened body, never by its name. Name traps are listed explicitly in each table.
- Anything unresolved is **UNKNOWN**. No screen is called safe on a guess.
- Scope is judged against the canonical pair `sellerUid` (account) and `shopId` (shop). An authority that conflates them, or that accepts either from the client without verifying it, is flagged rather than accepted.

> **Scope note.** The eleven screens censused are the ones named for 2D-2. `Products` is *not* among them but is still a `kind:'seller'` iframe route in the contract — it needs the same treatment and is not covered here.

## Orders

| | |
|---|---|
| canonical source | orders |
| read authority | client SDK on `orders` + SokoniOrderService; merchant.html already renders this natively (renderOrders) |
| legacy seller.html dependency | `sokoniOrders`, `sokoniReturns`, `sokoniOffers` |
| sections | buyer-orders-section, returns-section, offers-section |
| mobile requirements | status advance + returns/offers triage; one-thumb list, no horizontal scroll |

| candidate | status | guard | client scope | considered because |
|---|---|---|---|---|
| `orderAdvance` | **AUTH ONLY** | auth-only | no | the only order-status/timeline write authority |
| `onOrderStatusChange` | **TRIGGER** | NONE DETECTED | no | trigger, not callable — reacts, cannot be driven by a screen |

**VERDICT: BLOCKED — DIVERGENT STORE** — orderAdvance is deployed and is the ONLY status authority, but it verifies only that the caller is signed in — never that they own the order. It also flips status to confirmed, which triggers rider auto-assignment. A merchant Orders screen cannot be built on it until it asserts ownership.

## Receipts

| | |
|---|---|
| canonical source | posReceipts |
| read authority | posReceipts written by posCompleteCheckout + payment-trust; no merchant-scoped LIST callable found |
| legacy seller.html dependency | none |
| sections | receipts-section |
| mobile requirements | search by receipt no, reprint, share, void-with-reason |

| candidate | status | guard | client scope | considered because |
|---|---|---|---|---|
| `verifyTrustReceipt` | **PUBLIC / NO AUTH** | NONE DETECTED | ⚠ yes | reads a single receipt by number |
| `generateTrustReceipt` | **PUBLIC / NO AUTH** | NONE DETECTED | ⚠ yes | creates a trust receipt |
| `voidTrustReceipt` | **ADMIN ONLY** | admin-only | ⚠ yes | the void/correction path |
| `sendPOSReceipt` | **AUTH ONLY + CLIENT SCOPE** | auth-only | ⚠ yes | delivery of an existing receipt |

**VERDICT: NEEDS AUTHORIZATION HARDENING** — deployed, but the authority trusts a client-supplied scope id without verifying ownership

## Team / Staff

| | |
|---|---|
| canonical source | shopEmployees |
| read authority | client SDK on shopEmployees (seller.js:2633 deletes directly) |
| legacy seller.html dependency | `sokoniEmployees`, `sokoniEmployeeSession`, `sokoniSellerVerification`, `sokoniStockAlerts` |
| sections | employees-section, verify-section, restock-section, danger-section |
| mobile requirements | invite by email, role picker, revoke; PIN/QR handover is POS-side |

| candidate | status | guard | client scope | considered because |
|---|---|---|---|---|
| `inviteShopEmployee` | **AUTHORITATIVE** | shop-owner assert | no | the invite authority seller.js already calls |
| `acceptShopInvite` | **AUTH ONLY** | auth-only | no | the only WRITER of shopEmployees |
| `orgCreateTeam` | **NOT MERCHANT-USABLE** | admin-only | no | NAME TRAP — organisational teams, a different entity from shop staff |
| `getStaffRoster` | **NOT MERCHANT-USABLE** | auth-only | ⚠ yes | NAME TRAP — provider/roster domain, not shop employees |

**VERDICT: SAFE TO REBUILD** — deployed, ownership-asserting authority: inviteShopEmployee

## Messages

| | |
|---|---|
| canonical source | conversations |
| read authority | messages.js — participant-scoped |
| legacy seller.html dependency | `sokoniMessages`, `sokoniQA` |
| sections | seller-dms, qa-section |
| mobile requirements | sticky composer over the keyboard; the known enhancement deferred at 2C |

| candidate | status | guard | client scope | considered because |
|---|---|---|---|---|
| `createConversation` | **AUTH ONLY + CLIENT SCOPE** | auth-only | ⚠ yes | opens a thread |
| `updateConversationStatus` | **AUTHORITATIVE** | party/participant | ⚠ yes | thread lifecycle |
| `markRead` | **AUTHORITATIVE** | party/participant | ⚠ yes | read state |
| `searchConversations` | **AUTH ONLY** | auth-only | no | inbox search |
| `messagesDispatch` | **ROUTER** | NONE DETECTED | no | op-router front door — delegates auth to the handler it routes to |

**VERDICT: SAFE TO REBUILD (partial)** — a shop-scoped authority exists, but 1 sibling(s) accept a client-supplied scope id unchecked — build ONLY on the asserted ones: updateConversationStatus, markRead

## Marketing

| | |
|---|---|
| canonical source | minishopCampaigns / minishopPromotions / mktCampaigns |
| read authority | getMinishopCampaigns (shop-owner asserted) |
| legacy seller.html dependency | `sokoniCampaigns`, `sokoniPromoCodes`, `sokoniAds` |
| sections | marketing-section, flash-section, ads-section |
| mobile requirements | create/schedule/stop a campaign; budget entry needs numeric keypad |

| candidate | status | guard | client scope | considered because |
|---|---|---|---|---|
| `createMinishopCampaign` | **AUTHORITATIVE** | shop-owner assert | ⚠ yes | shop-scoped campaign create |
| `getMinishopCampaigns` | **AUTHORITATIVE** | shop-owner assert | ⚠ yes | shop-scoped campaign read |
| `deleteMinishopCampaign` | **AUTH ONLY** | auth-only | no | shop-scoped campaign delete |
| `miniShopCreatePromotion` | **AUTHORITATIVE** | shop-owner assert | ⚠ yes | shop-scoped promotion create |
| `createAdCampaign` | **AUTHORITATIVE** | party/participant | no | seller-scoped ad campaign |
| `createMarketingCampaign` | **NOT DEPLOYED** | numeric-role gate | ⚠ yes | marketing-engine campaign create |
| `createPromotion` | **ADMIN ONLY** | admin-only | no | NAME TRAP — finos, _assertAdmin only |

**VERDICT: SAFE TO REBUILD** — deployed, ownership-asserting authority: createMinishopCampaign, getMinishopCampaigns, miniShopCreatePromotion, createAdCampaign

## Flash Sales

| | |
|---|---|
| canonical source | mktFlashSales (engine) vs minishopPromotions type=flash_sale (minishop) — TWO counters |
| read authority | getFlashSalePrice (engine) / miniShopGetPromotions (minishop) |
| legacy seller.html dependency | `sokoniFlashSales` |
| sections | flash-section |
| mobile requirements | pick product, set % and window, live countdown |

| candidate | status | guard | client scope | considered because |
|---|---|---|---|---|
| `createFlashSale` | **NOT DEPLOYED** | numeric-role gate | ⚠ yes | the engine authority the scheduled concluder implies |
| `getFlashSalePrice` | **NOT DEPLOYED** | NONE DETECTED | ⚠ yes | price resolution at sale time |
| `recordFlashSalePurchase` | **NOT DEPLOYED** | auth-only | no | stock-limit decrement |
| `concludeExpiredFlashSales` | **SCHEDULED** | NONE DETECTED | no | scheduled job — expires them; cannot be driven by a screen |
| `miniShopCreatePromotion` | **AUTHORITATIVE** | shop-owner assert | ⚠ yes | accepts type flash_sale — the OTHER counter |

**VERDICT: BLOCKED — DIVERGENT STORE** — TWO stores for one number: mktFlashSales (marketing-engine, whose whole module is un-re-exported) and minishopPromotions type=flash_sale (minishop-v3, deployed and shop-scoped). The deployed scheduled concluder reads mktFlashSales — a collection no deployed callable can write. Building a screen before these converge repeats the Inventory defect exactly.

## Tax

| | |
|---|---|
| canonical source | etimsInvoices / etimsProfile |
| read authority | etimsGetProfile / etimsGetSellerStats |
| legacy seller.html dependency | `kraPinSaved`, `sokoniExpenses`, `sokoniWallet` |
| sections | tax-section, wallet-section, expense-section, mpesa-insights-section |
| mobile requirements | KRA PIN entry, invoice list, download; wallet is the FROZEN engine — read only |

| candidate | status | guard | client scope | considered because |
|---|---|---|---|---|
| `etimsGetProfile` | **AUTH ONLY** | auth-only | no | seller eTIMS profile |
| `etimsGetSellerStats` | **AUTH ONLY + CLIENT SCOPE** | auth-only | ⚠ yes | seller-scoped stats |
| `etimsGenerateInvoice` | **AUTH ONLY + CLIENT SCOPE** | auth-only | ⚠ yes | the invoice authority |
| `etimsBulkGenerate` | **AUTH ONLY + CLIENT SCOPE** | auth-only | ⚠ yes | bulk invoice authority |
| `calculateTaxBreakdown` | **PUBLIC / NO AUTH** | NONE DETECTED | ⚠ yes | computation only |
| `hubUpdateTaxConfig` | **ADMIN ONLY** | admin-only | no | NAME TRAP — hub-level config, not per-merchant |

**VERDICT: NEEDS AUTHORIZATION HARDENING** — deployed, but the authority trusts a client-supplied scope id without verifying ownership

## Stories

| | |
|---|---|
| canonical source | NONE FOUND |
| read authority | none — localStorage only, and demo-seed.js writes the same key |
| legacy seller.html dependency | `sokoniStories` |
| sections | stories-section |
| mobile requirements | camera/upload, 24h expiry, viewer counts |

**VERDICT: NEEDS NEW AUTHORITY** — no server authority of any kind exists for this capability

## Disputes

| | |
|---|---|
| canonical source | disputes |
| read authority | disputes rules — party-scoped |
| legacy seller.html dependency | `sokoniDisputes` |
| sections | disputes-section |
| mobile requirements | evidence upload from camera roll; read-only timeline |

| candidate | status | guard | client scope | considered because |
|---|---|---|---|---|
| `addDisputeEvidence` | **AUTHORITATIVE** | party/participant | ⚠ yes | seller is an explicit party |
| `createDispute` | **NOT MERCHANT-USABLE** | party/participant | ⚠ yes | BUYER-side only — the handler rejects a non-buyer, so a merchant screen cannot use it |
| `cancelDispute` | **AUTHORITATIVE** | party/participant | ⚠ yes | party-side cancel |
| `adminResolveDispute` | **ADMIN ONLY** | admin-only | ⚠ yes | admin-only resolution, correctly so |
| `adminGetAllDisputes` | **ADMIN ONLY** | auth-only | no | NAME TRAP — admin console, platform-wide |

**VERDICT: SAFE TO REBUILD** — deployed, ownership-asserting authority: addDisputeEvidence, cancelDispute

## Customers

| | |
|---|---|
| canonical source | posCustomers |
| read authority | crm.js / pos-crm-pro.js |
| legacy seller.html dependency | `sokoniOrders` |
| sections | customers-section |
| mobile requirements | search, profile, purchase history, loyalty balance |

| candidate | status | guard | client scope | considered because |
|---|---|---|---|---|
| `getCustomerProfile` | **AUTHORITATIVE** | shop-owner assert | ⚠ yes | merchant-owner asserted profile read |
| `buildCustomerProfile` | **AUTHORITATIVE** | shop-owner assert | ⚠ yes | profile construction |
| `posGetCustomerInsights` | **AUTH ONLY + CLIENT SCOPE** | auth-only | ⚠ yes | merchant-scoped insights |
| `getCustomerGrowthMetrics` | **AUTH ONLY + CLIENT SCOPE** | auth-only | ⚠ yes | aggregate metrics |

**VERDICT: SAFE TO REBUILD (partial)** — a shop-scoped authority exists, but 2 sibling(s) accept a client-supplied scope id unchecked — build ONLY on the asserted ones: getCustomerProfile, buildCustomerProfile

## Store

| | |
|---|---|
| canonical source | shops / minishopConfig / shopHandles |
| read authority | getMinishopAnalytics (shop-owner asserted) |
| legacy seller.html dependency | `sokoniMiniStore`, `sokoniPremiumPlan`, `sokoniStoreFollowers` |
| sections | ministore-section, premium-section, danger-section |
| mobile requirements | storefront preview, handle, theme, danger zone |

| candidate | status | guard | client scope | considered because |
|---|---|---|---|---|
| `claimMinishopHandle` | **AUTH ONLY + CLIENT SCOPE** | auth-only | ⚠ yes | handle claim, ownership-gated |
| `getMinishopAnalytics` | **AUTHORITATIVE** | shop-owner assert | ⚠ yes | shop-owner asserted analytics |
| `updateMinishopConfig` | **ABSENT** | — | no | storefront configuration |
| `generateMinishopShareCard` | **AUTHORITATIVE** | shop-owner assert | ⚠ yes | share asset |
| `followShop` | **AUTH ONLY + CLIENT SCOPE** | auth-only | ⚠ yes | follower relationship |

**VERDICT: SAFE TO REBUILD (partial)** — a shop-scoped authority exists, but 2 sibling(s) accept a client-supplied scope id unchecked — build ONLY on the asserted ones: getMinishopAnalytics, generateMinishopShareCard

## Cross-cutting defects

### `shopEmployees`: the writer and the readers disagree on the document key

| site | key form | role |
|---|---|---|
| `functions/analytics-engine.js:87` | `{shopId}_{uid}` | reader |
| `functions/index.js:5757` | `{uid}` | WRITER |
| `functions/merchant-inventory.js:77` | `{shopId}_{uid}` | reader |
| `seller.js:2633` | `{id} (client-supplied)` | deleter |

**Consequence.** The only thing that CREATES a `shopEmployees` record writes one key; every reader looks up another. An employee who accepts an invite is therefore invisible to `merchantAdjustStock` and to `analytics-engine`, and both fall through to their permission-denied branch. The `{uid}` form also means an employee can belong to exactly one shop platform-wide.

This is not a 2D-2 finding only — it reaches back into the Inventory surface shipped in 2D-1C, whose employee-access path cannot match a real record until the key converges.


## Implementation order (evidence-derived)

| # | screen | verdict | what must happen first |
|---|---|---|---|
| 1 | Team / Staff | **SAFE TO REBUILD** | nothing — build on the asserted authority |
| 2 | Marketing | **SAFE TO REBUILD** | nothing — build on the asserted authority |
| 3 | Disputes | **SAFE TO REBUILD** | nothing — build on the asserted authority |
| 4 | Messages | **SAFE TO REBUILD (partial)** | nothing — build on the asserted authority |
| 5 | Customers | **SAFE TO REBUILD (partial)** | nothing — build on the asserted authority |
| 6 | Store | **SAFE TO REBUILD (partial)** | nothing — build on the asserted authority |
| 7 | Receipts | **NEEDS AUTHORIZATION HARDENING** | add an ownership assert to the authority |
| 8 | Tax | **NEEDS AUTHORIZATION HARDENING** | add an ownership assert to the authority |
| 9 | Stories | **NEEDS NEW AUTHORITY** | design and build a server authority |
| 10 | Orders | **BLOCKED — DIVERGENT STORE** | resolve the unknown before scheduling |
| 11 | Flash Sales | **BLOCKED — DIVERGENT STORE** | resolve the unknown before scheduling |
