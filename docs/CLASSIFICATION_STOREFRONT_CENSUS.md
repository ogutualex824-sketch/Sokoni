# Classification → storefront → dashboard: census (read-only)

**Date:** 2026-09-29 · **Branch:** `feat/integrations-control-center` @ `a189089` · **Nothing changed, nothing deployed.**
First slice of the classification / storefront / dashboard convergence track. Related: [[CONNECTED_WORKSPACE_CERTIFICATION]] (untouched by this track), [[Marketplace]], [[Authentication]].

The question the owner asked: *which fields are actually authoritative* for what a business offers, whether it is approved, which storefront and card it gets, and which dashboard its owner lands in — before DG Wine or Latomi Gadgets are touched.

## 1 · The short answer

**There is no canonical capability state.** Nothing persisted on a business, shop, provider or user says "sells products / provides services / both". The nearest thing is *derived*: `functions/shared/business-scope.js` says `products` if `sellers/{uid}` is live and `services` if `providers/{uid}` is live, where live = status active/approved **and** approval evidence (`approvedAt` / `approved` / `adminApproved`). It deliberately ignores `businessType`, `category` and `hub`. Its only server consumer is the POS service-basket gate; its client mirrors are `catalogue.html` (repaired) and `business-apply.html` (stale).

**Routing does not use it.** Six separate resolvers pick storefront, card and dashboard, each keyed on a different input, and only two of them are approval-based (`sokoni-merchant-entry.js` on the `seller` claim / `users.roles`; login on `getMyShopWorkspaces`, shop ownership or corroborated employment). Nothing on the client ever routes on the `provider` claim.

**Business ≠ service provider is not a distinction the records carry.** A merchant approval projects `shops/{id}` + `sellers/{uid}` + `businesses/{uid}`; a provider approval projects `providers/{uid}` only. A "Double Business" today is simply an account that has both `--merchant` and `--provider` applications approved — two unlinked cards in AdminOS, two unlinked projections, no single business identity.

## 2 · Ownership map

| Record | Writers | Readers | Authoritative field(s) | Notes |
|---|---|---|---|---|
| `applications/{id}` | 16 intake surfaces (§3); lifecycle intake patch; `applicationDecide` | `applicationList` (AdminOS), `applyDecision`, `provider-hub`, `provider-onboarding`, `driver-success.html` | server-stamped `role` (from `resolveRole`), `status`/`statusCanonical`, `decidedBy`, `projectionStatus` | applicant chooses `type`, `category`, `hub` — none are in `noAdminFields()` |
| `sellers/{uid}` | `projectSeller`; client `seller.html:2785`, `seller.js:2505` | `business-scope`, `catalogue.html`, `adminGetSellers`, store.html | `status` + `approvedAt` (the only protected marker) | `status`/`active` are client-writable |
| `providers/{uid}` | `projectProvider`; `providerPublish` (content); client stubs in `onboarding-professional.html`, `healthcare.html` | `business-scope`, directory/search, `booking-service`, `adminGetProviders` | `status` + `approvedAt`, `searchable` | `providerPublish` mints the `provider` claim on `status` alone |
| `shops/{id}` | `projectSeller` | `adminGetShops`, minishop, merchant surfaces | `status`, `ownerId`, `source` | `category` is raw client input |
| `businesses/{id}` | `projectSeller` (`{uid}`); client `seller.html:2799`; POS `_createBusiness` (`{merchantId}`) | POS bootstrap, `business.html`, admin counts | **none for classification** | two id schemes; `category` and `businessType` written identically |
| `users/{uid}` | `role-authority`; client signup (`registeredAs.*`) | everything client-side | `roles[]` + Auth custom claims | `isProvider`, `isSeller`, `registeredAs.*`, `approved` are labels |
| `accounts` / `accountProfiles` | `onbActivateRole` (`universal-onboarding.js:174-210`) | onboarding | a **parallel** roles/claims path with no approval | see §6 |
| `legalProviders`, `healthProviders` | hub register/approve callables | hubs | `status` | not linked to `applications`; approving a legal application writes no registry |
| `providerProfiles/{uid}` | `providerPublish` | `providerDashboard` callable | existence | a **different registry** from `providers/{uid}`; the dashboard gate keys on it |

**Six places where two fields claim the same thing:** applicant kind (`type` / `category` / `categoryLabel` / `hub` / `professionalType` / `businessType` / `serviceType`, pooled by `resolveRole`); role spellings (`health`/`legal` → `provider` claim; `driver` → `rider`; `merchant` vs `seller`; `accounts.roles`); business category (`businesses.category` = `businesses.businessType`); approved/live (`sellers.status`+`active` vs `approvedAt`; `providers.status` alone vs with `approvedAt`; `applications.status` vs `statusCanonical` vs `projectionStatus`); capability (doc existence vs `users.isProvider`/`isSeller`/`registeredAs` vs `accounts.roles`); healthcare identity (`providers` vs `healthProviders`).

## 3 · "What are you offering?"

It exists **once**: `business-apply.html:161-190` (Products / Services / Both), merged from the dual-business lineage (`f1d3355`, an ancestor of HEAD — the memory note calling that branch unmerged is stale). It is **unreachable** (no page links to it; `navigation-registry.json` says `reachable: false`), sends `profile: {}` so approval projects a blank provider name and a shop called "My Shop", stores **no offering field** (the choice survives only as which `--merchant` / `--provider` docs exist), and its status card uses a stale liveness rule. No other intake — Register My Business (`hub-register.js`, opened from ~30 hub pages), the seller wizard, the professional/driver wizards, the hub forms — asks the question.

`resolveRole` over the 114 Register-My-Business categories yields **seller for 5, provider for 85** (wholesale, supermarket, hardware, restaurant, bakery, butcher, manufacturer, farm all become providers: `\bwholesal\b` never matches "wholesale", `hub:'shopping'` never matches `\bshop\b`). Driver and professional applications carry no `agreementAccepted`, so `applicationDecide` cannot approve them at all.

## 4 · Storefront, card, dashboard — what decides today

| Resolver | Input | Output |
|---|---|---|
| `/shop/{handle}`, `/@{handle}` → `minishopPage` → `getMinishopPublic` | `shopHandles/{handle}.shopId` | product storefront only; `services` never returned, so the minishop service section never renders |
| `sokoni-minishop.js _getSmartCta` | **`shop.category` substring** (healthcare/legal/salon/hotel…) | "Book" vs "Shop Now" CTA |
| `store.html?id=` | `shops/{uid}` → `sellers/{uid}`; `sellers.branches[]` | legacy product store |
| `business.html?id=` | `businesses/{id}`; badge by **`b.type==='pro'`** | products + services tabs, always both |
| `provider-profile.html?uid=` | `providers/{uid}` status active/approved | provider page |
| link builders | the **source collection** of the card (`products`/`shops` → store, `businesses` → business.html, `providers` → provider-profile); `item.type` / localStorage `e.type` | destination page; `type==='mechanic'` → `mechanic.html`, which does not exist |
| homepage product card (`script.js buildProductCard`) | — | browse-only, no buttons, tap → `product.html?id=` ✓ the "existing premium card" |
| category card (`category.js`) | — | Add / Wish / Buy Now; tap → `product.html` via localStorage, no `?id` |
| minishop card | — | ♥ wishlist only, tap → `product.html?id=` ✓ |
| provider cards (`services.html .pv-card`, `providers.html .pv-card`) | `providers` | informative, Book + Message, no product buttons ✓; **no certifications, no branches** rendered anywhere; hub pages (`electrical`, `plumbing`, `cleaning`…) render hard-coded arrays |
| login (`auth.js`) | `profile.role==='employee'` → seller.html; `getMyShopWorkspaces` → merchant-v2 / choose-shop; else `next=` | a shop owner's `next=` is overridden |
| `SokoniMerchantEntry` | `claims.seller` or `users.roles ∋ seller` | merchant-v2 or onboarding; **no provider outcome** |
| `provider-dashboard.html` | existence of `providerProfiles/{uid}` | dashboard or provider-onboarding |
| nav engine / header / profile / onboarding / profile-switcher | **localStorage `sokoniUser`** `roles`, `isProvider`, `isSeller`, `registeredAs.*` | provider → seller.html (nav engine), provider.html (header), provider-dashboard (profile); many mapped dashboards do not exist |
| Merchant V2 Services side | intended: `providers` approval + `providerSubscriptions` via `window._navState`; **`_navState` is never assigned** | every merchant sees Services and Bookings (fails open) |
| branches | three disjoint models: `sellers.branches[]` (client), `branches/{id}`+`posStaff` (SmartPOS), `sellers/{id}/branches` (POS-HQ); **services carry no branch field** | products and services do not share a branch model |

Fourteen places route on a display or self-declared field rather than an approval/capability state; they are enumerated in the storefront census output and summarised above.

## 5 · DG Wine and Latomi Gadgets — current production state (read-only, aggregate)

| | DG Wine | Latomi Gadgets |
|---|---|---|
| owner uid | `Ohg9HrtGpCXBUSzbRfaUifOPWQ32` | `IaOBkEJYcCXk23UDWk0OPp7XXeD3` |
| records that name them | `providers/{uid}` + one **approved** `applications/{id}` | `providers/{uid}` + one **approved** `applications/{id}` |
| `businesses` / `shops` / `sellers` doc | **none** | **none** |
| products attached (`products` by shopId / businessId / sellerUid) | **0** | **0** |
| Auth claims | `provider` | `provider` |
| `users` roles / activeRole | `buyer, provider` / `provider`, `isProvider: true`, `approved: true` | same |

So the "migration" is **not** a Service → Business field flip on an existing business record: there is no business record and no product data to preserve in the product collection. It would create the business + shop identity for the first time under the same owner uid. Before that is final, the census must still scan the other product-bearing collections (`posProducts`, `inventory_products`, `listings`, `providerServices`) and the ops database for these uids — that read was **blocked by the session's production-read permission** and is written, unrun, in the scratchpad.

## 6 · Findings that must be settled before any migration

1. **Self-mint hole in this branch's source.** `onbActivateRole` (`universal-onboarding.js:174-210`) sets a custom claim for any of 20 roles after only a sign-in check. Production carries the hotfix (`1171a16`, deployed); **that commit is not an ancestor of HEAD**. Any functions deploy from this branch would re-open it. Blocker for deploying anything in this track.
2. **The category authority is on another branch.** `functions/business-category.js` (31 categories, stamps `providers.business` / `shops.business` at approval, `shopEligibility` requires `business.source ∈ {application, admin}`) and `catalogue-capabilities.js` live on `slice/c4-category-matrix` (`62e38b3`, `446e826`), not here. The owner's standing rule is to EXTEND that one, never build a second. The convergence track therefore starts by bringing that lineage in, or is done on that lineage.
3. **No linkage between a merchant and a provider approval of the same owner.** "Double Business" cannot be represented until one business identity carries both capabilities.
4. **`resolveRole` mis-classifies 85 of 114 business categories as providers** — the wrong-storefront problem the owner named is systemic, not two records.
5. **Admin user counts are one database.** AdminOS/Super Admin count Firestore `users` only (85), never Auth (77); a failed count renders 0. "Reflect both databases" is a server stat returning both figures and the two deltas (6 Auth accounts without a doc, 14 docs without an account), with unknown as a dash.

## 7 · Proposed order (not started)

1. Owner decisions: land the c4 category lineage here (or work there); confirm the capability model — `business.capabilities = {products, services}` stamped at approval on ONE business identity, derived never from category text.
2. Canonical intake: every application flow converges on the one "What are you offering?" primitive, stored as a field, single application record with one or two capability requests.
3. Approval: business approval and service approval stay distinct decisions on the same record; both approved = Double Business; projections go to one `businesses/{id}` + `shops/{id}` + `providers/{uid}` linked by that id.
4. Resolver: ONE `resolveWorkspace(uid)` / `resolveStorefront(id)` reading capability state; wire the existing premium cards, minishop, provider page, merchant-v2 (set `_navState`), provider dashboard. No redesign.
5. DG Wine / Latomi: create business + shop under the same uid with `capabilities.products` approved by an admin decision, keep the provider record; certify storefront and dashboard; no duplicate entity.
6. Fake-data cleanup and the two-database user count: separate authorized slice, exact named list, re-census-and-abort guard.
