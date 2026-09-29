# Commerce Convergence — Coordination Census (read-only)

> **Date:** 2026-09-29 · **Measured tree:** `slice/c4-category-matrix` @ `30c6066` (local, NOT deployed, NOT pushed)
> **Mode:** read-only. No code was changed to produce this document. Production state not read → marked UNKNOWN.
> Related: [[SOKONI_POINTS]] · [[MARKETING_OFFERS]] · [[CATALOGUE_CAPABILITY_MATRIX]] · [[REFUND_AUTHORITY_CONVERGENCE]]

This is the first task of the owner's *End-to-End Commerce Convergence* master prompt: find the ONE existing
authority for every commercial fact before any slice extends it, and map who owns what so no two agents build the same
rule twice. **Every later slice must extend the authority named here, never create a second one.**

---

## A. Repository / worktree state

| | |
|---|---|
| Convergence branch | `slice/c4-convergence` (from `30c6066`), worktree `C:/temp/sok-u7c2` |
| Integration branch | `slice/c4-category-matrix` = `30c6066` (worktree `C:/temp/sok-catmx`) |
| Locked baselines | `c59e0f2` loyalty security (FIRST deploy dependency) · `4ad69bf` P1 · `1adbb8d` → `e19e6c0` → `30c6066` P2 |
| Registered worktrees | 270 (shared repo — repo-wide git operations are forbidden) |
| Live peer sessions | sokoni-60, sokoni-eb, sokoni-d6 (+ this one, sokoni-66) |

**Branches active today (not modified by this census):**

| Branch | Worktree | Relation to 30c6066 | Uncommitted |
|---|---|---|---|
| `slice/c4-capability-consumer` (58bd2a3) | `C:/temp/sok-cap` | diverged at `4ad69bf` | none observed |
| `feat/integrations-control-center` (40f5df9) | main checkout | diverged | `functions/.env`, `service-worker.js`, `version.json`, a release-gate json |
| `fix/featured-spotlight-canonical-app-on-93c5783` (6e01729) | `C:/temp/sok-lifegoals` | diverged (live lineage) | committed per its owner |
| `fix/life-goals-overlay-on-live`, `fix/payout-paid-guard-on-8183694`, `pos-safety/6b-smartpos-cash-on-072e03d`, `ui/pos-setup-page-on-be7c676` | own worktrees | diverged (live/POS lineages) | — |
| `slice/c4-u7-dev` | `C:/temp/sok-u7dev` | ancestor | — |

**Production writes recorded by another track (cited, not re-verified):** sokoni-60 reports owner-authorized plan-digest
migrations on 2026-09-29 creating `businesses/Ohg9HrtGpCXBUSzbRfaUifOPWQ32` (DG Wine) and
`businesses/IaOBkEJYcCXk23UDWk0OPp7XXeD3` (Latomi), each with a SERVICES capability stamp and one `adminAudit` record
(docs/C4_DG_WINE_MIGRATION.md, docs/C5_LATOMI_MIGRATION.md on `slice/c4-capability-consumer`).

**P0 outside this track (reported by sokoni-eb):** a Meta access token is committed in
`docs/backups/products-before-kassvapes-cleanup.json` (e6e98b3) and the GitHub repository is public. The remedy is
**rotation**; deleting the file does not invalidate an exposed credential.

---

## B. Authorities

### B1. Catalogue · inventory · offers · price · till · points · identity (built or audited in P1/P2/U7)

| Fact | Authority (extend this) | Notes |
|---|---|---|
| Offering identity | `products/{id}` (seller identity lives here; `order.sellerUid` is buyer-written) | writers: merchant-product-writer, posUpsert catalogue contract; canonical top-level `barcode` (U7b `2530f0f`) |
| Saleability | `functions/shared/sellability.js` `tillBlockReason` (U7a) · `isPubliclyListed` exists but **has no non-test caller** | |
| Stock | `products.stock` + `inventoryVersion`, transactional only (`posCompleteCheckout`, `_finalizeMarketplacePayment`, `merchantAdjustStock`) | second counter: warehouse-scanner `stockQty` (debt) |
| Packages / bundles | `functions/shared/package-stock.js` (U5) | no independent stock |
| Shop offers (incl. flash sale, free delivery) | `functions/shop-offers.js` `quoteShopOffers` / `shopOfferQuote` / `shopOfferUpsert` | the ONLY charged offer store |
| Online price | `payment-purposes.js` `validateOrderLines` → `product_order` (M-PESA) and `createCheckoutSession` (card) | two entry points over one validator |
| Till sale | `functions/pos-zero-friction.js` `posCompleteCheckout` | competing: `pos-retail-engine.recordPOSSale` (`posSales`, client prices) and pos.js direct `posTransactions` writes |
| Points | earn `loyalty-points.js`; spend `loyalty-points-spend.js`; guard `loyalty-dispatch.js` | legacy `posCustomers.loyaltyPoints` and wap.js `_svcLoyalty` (1 pt / KES 100) are NOT SOKONI points |
| Buyer identity | `users/{uid}` + Auth; phone → uid via `wallet-engine._resolveRecipientByPhone` | |
| Business capability | `functions/shared/business-capabilities.js` `readModel()` / `resolveRouting()` (**on `slice/c4-capability-consumer`, sokoni-60**) | consume only through the read model, and only after sokoni-60's R2 lands |
| Category registry | `functions/business-category.js` `CATEGORIES` — **31 categories** | capability flags: `functions/shared/catalogue-capabilities.js` `CAPS` (its `marketing` flag is consumed nowhere) |

### B2. Delivery · commission · tax · receipts · payment authorization

| Fact | Authority | Duplicates / gaps (file:line at 30c6066) |
|---|---|---|
| **Delivery fee** | **TWO**: (A) merchant `sellers/{uid}.deliveryConfig` via `functions/shared/delivery-engine.js` `calculateDelivery` (modes free/flat/distance/zones/own_fleet/pickup_only, `freeAbove`, `serviceZones`); (B) platform rider quote `delivery-quote-authority.js` + `delivery-quote-endpoint.js` (Gate C / RES-1) | **Card session charges (B); M-PESA `product_order` charges (A)** — same cart, different delivery price by rail. **No merchant UI writes `deliveryConfig`** (only QA scripts) → M-PESA delivery is effectively 0 ("unconfigured"). Shop-profile "free delivery above" (`shops/{id}.freeDelivery`, kasshop.js) is stored but applied nowhere. `cart.html:256` hard-codes "Delivery FREE". `products.deliveryCost` is a dead fourth price. `distanceKm`/`deliveryZone` on product_order are client-supplied. |
| **Commission rate** | `functions/commission-config.js` RATES + `finos-utils.calculateCommission` | amounts computed on different bases in several places: webhook `commissionLedger` (paid incl. delivery) vs order settlement (total − delivery); POS computes twice per sale (trace vs `pos-sale-commission` liability — the latter's basis vs points UNKNOWN); `money-authority`, `commercial-policy.commissionCents` have their own arithmetic. Events are 5% in RATES while comments say 3%. |
| **Tax / eTIMS** | `functions/etims-tax-engine.js` (`computeLine` reads `quantity`, `discountRate`) | online invoices (`etims.orderToLines`) use **list prices, no offer/promo/points discounts, no delivery line**; `hub-etims.js` reads only `quantity` (a `qty`-only order counts 1). VAT status in TWO stores: `etimsProfiles.vatStatus` (written) vs `merchants.vatStatus` (read by the till estimate, **no writer found**). |
| **Receipts** | by rail: POS `posReceipts/{saleId}`; STK online `posReceipts/{apiRef}` (webhook) | **card-session orders write no receipt row**; two receipt-number schemes (`receipt-number-authority.js` unused); `payment-trust.generateTrustReceipt` trusts client totals; invoice desk (`finance-os-sprint43 invoiceCreate`) uses a client tax rate, not the engine; bookings: no receipt writer found. |
| **Payment authorization** | `payment-intents.createPaymentIntent` + `payment-purposes` registry (film_access, digital_download, event_ticket, venue_booking, service_booking, healthcare_subscription, pos_till_sale, product_order, hub_registration) → IntaSend → `webhookIntasend`; card: `createCheckoutSession` → `verifyIntasendPayment` | STK intent enforcement covers only subscription + healthcare_subscription; other intent-less STK is still accepted at a client amount (`STK_NO_AUTHORITY` warning). Daraja outbound retired; inbound callbacks alive. `sokoni-webhook-engine.js` declares 17 providers but makes no calls (frozen lane — sokoni-eb). |

### B3. Bookings · services · events · Quick Charge · tenders · refunds

| Fact | Authority | Duplicates / gaps |
|---|---|---|
| Service / provider / healthcare / entertainment bookings | `providerBookings` — `booking-service.bookingCreateService` → `service_booking` intent → `booking-payment-sweep.holdServiceBookingPayment` (`paid_held`) → `provider-ops.providerCompleteBooking` / `settleOnShowUp` (`_settlementWrites`); money back `_disburseHeldFunds` | **legacy webhook `type:'booking'` branch (index.js ~8246–8321) credits the provider AT PAYMENT** and writes `bookings/{apiRef}` — a second creation + settlement authority. Booking refunds go to `users.walletBalance`, not financial-os. |
| Venue bookings | `bookings` (top-level) via `booking.js` + `venue-payments.js` (self-settling) | `venue-booking.js` `venueBookings` fallback has no payment rail; two writers share `bookings` |
| Stays / rentals / car rental | `bnbBookings` (client request, no engine), `rentalBookings` (server-priced, no payment), `carRentals` (client addDoc + WhatsApp) | no payment authority — points NOT APPLICABLE until one exists |
| Events / tickets | `event-hub.purchaseTickets` → `event_ticket` → `event-settlement` (release at admission) | two admission entry points converge on `releaseTicketShare` (OK) |
| Jobs | `jobs.js` is an EMPLOYMENT board; customer invoices `finance-os-sprint43` (`invoiceMarkPaid` self-attested) | no work-order engine |
| **Quick Charge** | `pos_till_sale` → `sokoni-qr-authority.priceTillSale` → webhook till branch | **free-typed `{name, price, qty}` only** (productId dropped); no ownership/saleability/stock check; **PAID writes no sale record, no receipt, no stock movement**; employee cashiers cannot use cart mode. Points EARN is wired (index.js ~8098); SPEND is not. |
| **Till tenders** | `posCompleteCheckout` checks only `mpesa`/`card`/`mpesa_daraja` (posPayments evidence), `wallet` (posWallets), `points` (confirmed redemption) | **any other label (`gift_card`, `split`, `bank`, `qr`, `voucher`, …) completes a sale with no evidence** and is booked as electronic money. `gift_card` in pos-checkout is a client-side IndexedDB decrement then posted blindly; three gift-card stores (`giftCards`, `posGiftCards`, `loyaltyGiftCards`) — none consulted. No server writes a completed **card** `posPayments`, so `card` tenders cannot confirm. pos.js (`mpesa_till_manual`, `qr`, `split`) syncs straight to `posTransactions`, bypassing the sale authority. |
| **Refunds** | `financial-os` (`fosSubmitRefund`…`_executeRefund`, per-domain hooks) — events, venues | competing: `initiateRefund` (online orders), `finos.processRefund`, `automation-engine.autoOnRefundRequest` (auto wallet credit), wap/sub-billing/finos-automation `refunds`, POS `posProcessRefund` + `pos-qr.refundPOSPayment`, bookings via provider-ops. **No refund path touches `loyaltyAccounts` / `loyaltyLedger` / `pointsHolds`**: earned points survive refunds; `posProcessRefund` repays the points-paid part as money. |

### B4. Marketing · Stories · Spotlight · discovery · KASS · AdminOS · documents · staff

| Fact | Authority | Duplicates / gaps |
|---|---|---|
| Marketing Hub | merchant-v2 route `marketing` (Offers \| Campaigns \| Promotions \| Ads) | **Promotions tab** (`minishopPromotions` / `minishopPromoCodes`) tells merchants codes work at checkout — **no charge path reads them**. Three flash-sale stores + localStorage homepage bar. Ads (`sokoAds`) accept any budget; approval is a client `updateDoc`. |
| Stories | `stories/{id}` — client writes, rules only | merchant-v2 Stories route = legacy seller.html editor → **localStorage only, says "Story live!"**; Storage has no `stories/` match (uploads denied); `/stories` missing from `firestore.rules.live` / RC; story price is a copied snapshot; allowance not enforced (`stories-capability.js` unused). |
| **Live Pulse** | **does not exist** in code | new feature (owner ask), Enterprise-gated |
| Spotlight / Featured | **no canonical paid authority — 7 stores** | `purchaseFeaturedListing` throws (`FEATURED_PRICING` undefined, index.js ~4995); AdminOS `featuredShops` has no UI and no reader; Spotlight queries a rule-denied `shopSettings` and shows **12 hard-coded fake sellers**; Pro Boost / boosts are browser-recorded; `products.isFeatured` is **seller-writable** and ranks search. sokoni-d6's `6e01729` (App Check app) is the base for Slice 9. Owner decisions open: Spotlight data source; the fake pool. |
| Discovery | shops/providers: `business-category.publicEligibility` / `shopEligibility` via `discovery-eligibility.prepareForIndex` | **products: 7 predicates + 1 unfiltered read**; homepage sections (Sellers Near You, Picked For You…) bypass both and derive from `/api/catalogue` + localStorage |
| KASS | `exports.kass` tools | `search_marketplace` reads raw `products` — no listing/shop gate, **never applies shop offers**; the corpus invites it to talk about offers with no offer tool |
| AdminOS | admin-os.js, business-category-admin.js, trust-safety.js | featured, banners, platform settings written but **not consumed** by the storefront; no offers/campaign module |
| Listing documents | business-level permits (`shops/{id}/private/compliance`, `DOC_STATES` in catalogue-capabilities.js) | **no listing-level document store**; car-hub fleet + driver verification, seller ownership docs, merchant-products docs **store nothing** (localStorage / filename only); `verification.html` cannot submit (omits `applicantUid`) |
| Trust badges | — | "✅ Verified" seller badge from the **viewer's localStorage**; "Verified owner" from `products.verificationStatus` which the **rules let a seller write**; fake "SOKONI VERIFIED" sellers in index.html + spotlight |
| Staff capability | `shop-employees.js` `ROLE_CAPABILITIES` (owner/admin/manager/cashier/inventory/support) | **no `marketing` capability**; merchant-v2 sidebar not capability-gated; 4 unrelated "capability" vocabularies |

---

## C. Ownership map

| Workstream | Existing implementation | Agent / branch | Status | This track may edit? |
|---|---|---|---|---|
| Points, offers, till sale, checkout pricing | loyalty-points*, shop-offers, pos-zero-friction, payment-purposes, checkout | sokoni-66 / `slice/c4-convergence` | P1/P2 committed | **yes** |
| Business capability + workspace routing | business-capabilities.js, business-scope.js, business-workspace.js | sokoni-60 / `slice/c4-capability-consumer` | active (R2 → R3 → R4) | **no** — consume read model after R2 |
| Integrations catalogue, WhatsApp webhook | integration-*.js, whatsapp-webhook.js, sokoni-webhook-engine.js (frozen) | sokoni-eb / `feat/integrations-control-center` | committed | **no** |
| Featured / Spotlight app wiring; Track hub | sokoni-featured.js, sokoni-spotlight.js (`6e01729`); track/delivery-tracking/my-orders | sokoni-d6 | featured committed; Track in progress | **no** until Slice 9 builds on `6e01729`; tracking pages never |
| POS safety lineage (6a/6b, M0-4, L-series), payouts, POS setup | pos-safety/*, fix/payout-*, ui/pos-setup-* | earlier sessions (live/POS lineages) | committed on other lineages | read-only; port only by identified commit |

---

## D. What this changes in the slice plan

Ordered by the owner's sequence, with the census facts each slice must respect:

1. **Quick Charge + points (Slice 2).** The earn is wired; the spend is not. Quick Charge is free-typed only. Redeeming there
   needs the P2b confirmed-redemption binding to the **intent** (points held against the intent ref, spent on PAID) —
   and must NOT let a free-typed line pose as a catalogue product. Catalogue-aware Quick Charge (productId → canonical
   price/offer/stock) is a larger change; Quick Charge also writes no sale/receipt today (recorded).
2. **Bookings / services + points (Slice 3).** Hook into the canonical `providerBookings` path only
   (`holdServiceBookingPayment` → settle): earn at SETTLEMENT (money actually kept), never at `paid_held`; the legacy
   webhook `type:'booking'` path must not earn. Venue / event rails are self-settling → hooks go in
   `venue-payments` / `event-settlement`. Stays / rentals / car rental: NOT APPLICABLE (no payment authority).
3. **Payment-label authorization (Slice 13).** Allow-list with evidence per label. Legitimate labels: `cash`, `mpesa`
   (posPayments), `mpesa_daraja`, `card` (**no evidence writer exists → decision needed**), `wallet`, `points`,
   `gift_card` (**needs a server gift-card authority — three client stores today**), `split` (a client grouping, not a
   tender). pos.js labels bypass the sale authority entirely (separate lineage decision).
4. **Refunds × points (Slice 15)** — pulled forward in priority: a refunded sale keeps its earned points and a points-
   paid till sale is refunded in cash. This is a money defect in P1/P2 as built, and should be the next loyalty slice.
5. **Delivery / offer parity (Slices 4–5).** First decide ONE delivery authority for a marketplace order (merchant
   config vs platform rider quote) — today the rail decides. Then: merchant-v2 delivery settings writing
   `deliveryConfig` (zones = `serviceZones`, free-above = `freeAbove`), the shop-profile `freeDelivery` either wired to it
   or retired, `cart.html` hard-coded FREE removed, product-card badges from the server quote.
6. Spotlight (on `6e01729`) → Stories/Marketing → Marketer capability (`ROLE_CAPABILITIES` + sidebar gating) → Live
   Pulse → feeds (one product-listing predicate: `isPubliclyListed`) → listing documents → category matrix (31
   categories via `CAPS` + capability read model).

**Owner decisions surfaced (not decided here):**
- which delivery authority prices a marketplace order;
- whether `card` / `gift_card` till tenders stay (and on what evidence);
- the Spotlight data source and the 12 fake sellers;
- the Promotions tab (wire to `shopOffers` or retire);
- event commission 5% (config) vs 3% (terms, comments).

**Security findings for their own slices:**
- `products.isFeatured` and `products.verificationStatus` are seller-writable (rules `noAdminFields`);
- unverified till tenders.
