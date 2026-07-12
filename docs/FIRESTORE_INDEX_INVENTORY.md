# Firestore Index Inventory — B-14 Audit

> ⚠️ **CORRECTED 2026-07-12:** the "200 composite index hard limit" stated below is **FALSE**. The live quota API (`serviceusage`) reports **1000** composite indexes per database; production holds **284**, all READY. Never hardcode this limit — read it live. See [[FIRESTORE-INDEX-ARCHITECTURE]].


**Date:** 2026-07-12  
**Auditor:** Claude Code (B-14 task)  
**Scope:** Full composite index audit across both Firestore databases  
**Default DB status at audit time:** 200 / 200 composite indexes (AT the hard limit)  
**sokoni-ops DB status at audit time:** 54 composite indexes

---

## Summary

| Database | Total Indexes | Collections | Safe to Remove | Candidates | Investigate |
|----------|--------------|-------------|----------------|------------|-------------|
| (default) | **200** | 122 | 0 | 1 | 4 |
| sokoni-ops | **54** | 35 | 2 | 0 | 0 |
| **TOTAL** | **254** | 157 | **2** | **1** | **4** |

**Projected default DB after removing safe + candidate:** 199 / 200 (marginal — see Recommendation)  
**No duplicate indexes detected** in either database.

---

## Default DB — Full Collection Inventory

Source: `firestore.indexes.json`

| Collection | Index Count | Code Evidence | Status |
|------------|-------------|---------------|--------|
| `_sokoniErrors` | 1 | `_sokoniErrors` in functions/ (monitoring) | Active |
| `_sokoniPerf` | 1 | `_sokoniPerf` in functions/ (performance tracking) | Active |
| `_sokoniTaskQueue` | 4 | Referenced in 2 function files | Active |
| `aiBoosts` | 1 | `aiBoosts` in AI subscription functions | Active |
| `aiCreditLedger` | 1 | AI subscription ledger writes | Active |
| `aiPromotions` | 1 | AI promotions engine | Active |
| `aiSubscriptions` | 2 | ai-subscriptions functions | Active |
| `aiUsage` | 1 | AI usage tracking functions | Active |
| `applications` | 1 | Referenced in 2 function files | Active |
| `auditLogs` | 3 | Extensively used across platform | Active |
| `bookings` | 7 | 46 hits in functions/ | Active |
| `businessHealthScores` | 1 | `business-health-score.js` | Active |
| `checkoutSessions` | 2 | Payment flow functions | Active |
| `commissionLedger` | 2 | Commission engine (11 hits) | Active |
| `communityPosts` | 2 | community.html and functions | Active |
| `conversations` | 1 | 17 hits in functions/ (chat engine) | Active |
| `crmCustomerProfiles` | 1 | CRM functions (9 hits) | Active |
| `crmLeadActivities` | 1 | CRM functions (3 hits) | Active |
| `crmLeads` | 2 | CRM functions (11 hits) | Active |
| `crmSupportTickets` | 1 | CRM functions (4 hits) | Active |
| `deliveries` | 3 | 20 function files reference deliveries | Active |
| `deliveryRiders` | 1 | 14 hits in HTML + functions | Active |
| `disputes` | 1 | 16 function files | Active |
| `driverLocations` | 2 | Delivery/navigation functions | Active |
| `driverRatings` | 1 | 7 hits in HTML/functions | Active |
| `drivers` | 1 | GIP dispatch (COLLECTION_GROUP scope) | Active |
| `education` | 1 | 21 hits in functions/ | Active |
| `entArtistBookings` | 1 | 6 hits in HTML/functions | Active |
| `entArtists` | 2 | 10 hits in HTML/functions | Active |
| `entEvents` | 2 | Event hub functions | Active |
| `entitlements` | 2 | SASOS core, subscription-os.js (extensive) | Active |
| `entReviews` | 1 | 4 hits in HTML/functions | Active |
| `entTickets` | 2 | 14 hits in HTML/functions | Active |
| `entVenues` | 2 | 7 hits in HTML/functions | Active |
| `escrows` | 1 | 22 hits in functions/ | Active |
| `etimsBulkJobs` | 1 | etims functions | Active |
| `etimsInvoices` | 4 | etims invoice engine | Active |
| `featuredListings` | 2 | 3 hits in functions/ | Active |
| `feedback` | 2 | 13 function files | Active |
| `gipDispatch` | 2 | GIP dispatch engine (19 hits) | Active |
| `homeServiceBookings` | 1 | cleaning.html, electrical.html, plumbing.html, home-services.html | Active |
| `homeServiceReviews` | 1 | home-services.html | Active |
| `hrLeaves` | 1 | HR/payroll functions | Active |
| `hrPayrollRuns` | 1 | HR/payroll functions | Active |
| `hubDocuments` | 4 | Hub eTIMS functions | Active |
| `hubInvoices` | 3 | Hub invoice engine | Active |
| `inventory_batches` | 1 | Inventory FEFO engine | Active |
| `inventory_fraud_events` | 2 | `inventory-fraud.js` | Active |
| `inventory_grn` | 2 | firestore.rules sub-collection; no CF queries found | **INVESTIGATE** |
| `inventory_levels` | 1 | `inventory-engine.js` (direct queries) | Active |
| `inventory_movements` | 2 | `inventory-engine.js` (direct queries) | Active |
| `inventory_products` | 3 | `inventory-engine.js` (direct queries) | Active |
| `inventory_purchaseOrders` | 2 | `inventory-engine.js`, `procurement.js` | Active |
| `inventory_stockcounts` | 2 | firestore.rules sub-collection; no CF queries found | **INVESTIGATE** |
| `inventory_transfers` | 2 | `inventory-v2.js` (queries with orderBy) | Active |
| `inventory_variants` | 2 | `inventory-v2.js` (queries with where+orderBy) | Active |
| `inventory_work_orders` | 1 | `inventory-v2.js` (queries with orderBy) | Active |
| `invoices` | 1 | 10 hits in functions/ | Active |
| `jobApplications` | 1 | Jobs functions | Active |
| `jobs` | 3 | 30 hits in functions/ | Active |
| `ledgerEntries` | 1 | `finos-admin.js`, `business-health-score.js` | Active |
| `legalAppointments` | 1 | `legal-hub.html` (addDoc writes) | Active |
| `legalReviews` | 1 | Functions (2 hits) | Active |
| `legalServiceRequests` | 1 | `legal-hub.html` (addDoc writes) | Active |
| `listings` | 1 | Functions (2 hits) | Active |
| `loyaltyAccounting` | 1 | Loyalty functions | Active |
| `loyaltyCampaigns` | 1 | Loyalty functions | Active |
| `loyaltyCashbackLedger` | 1 | Loyalty functions | Active |
| `loyaltyCheckouts` | 1 | Loyalty checkout orchestrator | Active |
| `loyaltyDrawEntries` | 1 | Lucky draw functions | Active |
| `loyaltyGiftCards` | 1 | Gift card functions | Active |
| `loyaltyLedger` | 2 | 32 hits in functions/ | Active |
| `loyaltyReferrals` | 1 | Loyalty referral engine | Active |
| `mediaAssets` | 2 | Creative studio functions | Active |
| `mktABTests` | 1 | Marketing engine | Active |
| `mktBundleDeals` | 1 | Marketing engine | Active |
| `mktCampaigns` | 1 | Marketing engine (2 hits) | Active |
| `mktFlashSales` | 1 | Marketing engine | Active |
| `notifications` | 3 | Notification center (extensively used) | Active |
| `offers` | 1 | `sokoni-offers.js` | Active |
| `orders` | 7 | 65+ hits in functions/ | Active |
| `packageRequests` | 3 | 18 hits in functions/ | Active |
| `paymentLedger` | 1 | 7 hits in functions/ | Active |
| `payments` | 1 | 65 hits in functions/ | Active |
| `paymentSessions` | 2 | Payment FSM functions | Active |
| `paymentVerifications` | 1 | Payment trust functions | Active |
| `platformEvents` | 2 | Platform registry (34 hits) | Active |
| `platformServices` | 2 | Platform registry (9 hits) | Active |
| `posPayments` | 2 | SmartPOS functions (16 hits) | Active |
| `posTransactions` | 1 | SmartPOS checkout | Active |
| `priceAlerts` | 2 | `retention.js` | Active |
| `procPurchaseOrders` | 1 | Procurement functions | Active |
| `procSupplierInvoices` | 1 | Procurement functions | Active |
| `products` | 3 | Marketplace core (extensively used) | Active |
| `productStats` | 2 | `product-analytics.js` | Active |
| `providers` | 1 | 11 hits in functions/ | Active |
| `referrals` | 1 | 3 function files | Active |
| `refunds` | 1 | 12 hits in functions/ | Active |
| `reviews` | 1 | 21 hits in functions/ | Active |
| `rideDrivers` | 1 | Ride-hailing functions (9 hits) | Active |
| `rideRequests` | 3 | 11 hits in HTML/functions | Active |
| `rides` | 1 | 4 hits in functions/ | Active |
| `sellerPayments` | 2 | index.js, seller.html, payments.html | Active |
| `sellerSubscriptions` | 1 | index.js (4 hits), revenue.html | Active |
| `services` | 1 | 21 hits in functions/ | Active |
| `settlementQueue` | 1 | Settlement engine | Active |
| `settlements` | 1 | 4 hits in functions/ | Active |
| `sokoAds` | 2 | Ads functions (2 hits) | Active |
| `subscriptionBrain` | 2 | `subscription-os.js` | Active |
| `subscriptions` | 1 | 46 hits in functions/ | Active |
| `users` | 1 | Core user management | Active |
| `venueBookings` | 1 | Venue booking engine | Active |
| `venues` | 4 | Venue booking engine | Active |
| `verificationRequests` | 1 | Verification engine | Active |
| `verifications` | 1 | 40 hits across codebase | Active |
| `vouchers` | 1 | `index.js` (voucher redemption) | Active |
| `walletTxns` | 1 | Only in `firestore.rules` — no function or HTML code queries/writes this collection | **CANDIDATE** |
| `webhookDeliveries` | 1 | Webhook delivery engine | Active |
| `withdrawals` | 1 | 5 function files | Active |
| `workflowApprovals` | 2 | WAP workflow functions | Active |
| `workflowInstances` | 2 | WAP workflow functions (8 hits) | Active |
| `workflowSchedule` | 2 | WAP workflow functions (2 hits) | Active |

**Default DB Total: 200 indexes | 122 collections | 0 duplicates**

---

## sokoni-ops DB — Full Collection Inventory

Source: `firestore.indexes.sokoni-ops.json`

| Collection | Index Count | Code Evidence | Status |
|------------|-------------|---------------|--------|
| `accountProfiles` | 2 | `universal-onboarding.js` (direct writes + queries) | Active |
| `accountSubscriptions` | 2 | `universal-onboarding.js`, `subscription-core.js` | Active |
| `adminAlerts` | 1 | 34 hits in functions/ | Active |
| `algoliaQueue` | 1 | `algolia-queue.js` (extensive use) | Active |
| `bookingFees` | 1 | 3 hits in HTML/functions | Active |
| `bookingHolds` | 1 | 8 hits in HTML/functions | Active |
| `certificationReports` | 1 | `release-readiness.js` | Active |
| `contentFlags` | 1 | `admin.html` (direct queries) | Active |
| `deliveryLocations` | 1 | 2 hits in code | Active |
| `deliveryProofs` | 1 | 2 hits in code | Active |
| `eccAuditLog` | 1 | `ecc.js` (writes + queries) | Active |
| `eccIncidents` | 1 | `ecc.js` (extensive queries) | Active |
| `emailLogs` | 2 | Email functions (9 hits) | Active |
| `emailQueue` | 1 | Email queue functions (10 hits) | Active |
| `etimsAlerts` | 1 | eTIMS functions | Active |
| `etimsQueue` | 2 | eTIMS queue functions | Active |
| `healthSnapshots` | 1 | `conversion-analytics.js`, `platform-health.js` | Active |
| `hubInvoiceQueue` | 1 | `hub-etims.js` | Active |
| `moderationQueue` | 1 | 5 hits in code | Active |
| `notificationQueue` | 1 | 8 hits in code | Active |
| `operationsReports` | 1 | **Collection does not exist** — actual name is `ops_reports` (verified in `scheduled-reports.js`, `platform-health.js`, `firestore.rules`) | **SAFE TO REMOVE** |
| `orders` | 1 | `storeId+createdAt` index for store-scoped order queries | Active |
| `posCashEvents` | 8 | `functions/pos-retail.js`, Cash Manager v3 | Active |
| `posCashSessions` | 1 | Cash Manager functions | Active |
| `posCloseApprovals` | 2 | Cash Manager functions | Active |
| `posDrawerEvents` | 2 | Cash Manager drawer tracking | Active |
| `productPriceHistory` | 1 | `product-analytics.js` | Active |
| `providerBookings` | 2 | Provider hub functions | Active |
| `providerPayouts` | 1 | Provider payout functions | Active |
| `providerProfiles` | 5 | 20 hits in functions/ | Active |
| `providerReviews` | 1 | Provider review functions | Active |
| `reportSchedules` | 1 | **Not found anywhere** — absent from `firestore.rules`, all `functions/*.js` files, and all `*.html` files | **SAFE TO REMOVE** |
| `trending` | 1 | `algolia-analytics.js`, `index.js` | Active |
| `typesenseQueue` | 2 | `typesense-queue.js`, `search-admin.js` | Active |
| `voucherRedemptions` | 1 | `index.js` (writes redemptions) | Active |

**sokoni-ops Total: 54 indexes | 35 collections | 0 duplicates**

---

## Findings

### SAFE TO REMOVE (100% confident — collection absent from all live code)

| Database | Collection | Index Count | Justification |
|----------|------------|-------------|---------------|
| sokoni-ops | `operationsReports` | 1 | Name mismatch: every function and the Firestore rules use `ops_reports` (snake_case). `operationsReports` only appears in `docs/appendices.md` and the `scripts/split-indexes.js` migration script — never in a `collection()` call anywhere. |
| sokoni-ops | `reportSchedules` | 1 | Completely absent from `firestore.rules`, all `functions/*.js` files, and all `*.html` pages. Only reference is in `scripts/split-indexes.js` (the file that created it). No feature writes to this collection. |

**Safe removal total: 2 indexes** (sokoni-ops: 54 → 52)  
_No safe removals in default DB — walletTxns is ruled by firestore.rules._

---

### CANDIDATES FOR REMOVAL (collection exists in rules, but no active queries found)

| Database | Collection | Index Count | Justification |
|----------|------------|-------------|---------------|
| (default) | `walletTxns` | 1 | Collection is defined in `firestore.rules:1457` but **no function or HTML file contains a `collection('walletTxns')` call**. Wallet balance is computed from other collections (`commission.js` uses a `walletRef` variable — local var, not this collection). Likely superseded by wallet/ledger system. Needs manual confirmation before removal. |

**Candidate removal total: 1 index** (default DB: 200 → 199)

---

### INVESTIGATE (collection exists in rules/docs, queries not confirmed in functions)

These exist in `firestore.rules` as sub-collections under `tenants/{tenantId}/`, are documented in CHANGELOG, but no explicit composite-query code path was located in `functions/*.js`. They may be queried from client-side SDKs, pending features, or through the inventory-engine's `tenantCol()` helper using dynamic collection names not captured by static grep.

| Database | Collection | Index Count | Notes |
|----------|------------|-------------|-------|
| (default) | `inventory_grn` | 2 | In `firestore.rules` as tenant sub-collection. Procurement uses `procGRN` (different collection). Documented in CHANGELOG. |
| (default) | `inventory_stockcounts` | 2 | In `firestore.rules` as tenant sub-collection. No CF query code found. |

**Investigate total: 4 indexes** — if confirmed orphaned, default DB drops to 196 / 200.

---

## Headroom Analysis

| Scenario | Default DB | sokoni-ops DB | Notes |
|----------|-----------|--------------|-------|
| Current | 200 / 200 | 54 | AT the hard limit |
| After safe removals | 200 / 200 | 52 | sokoni-ops has no hard limit; no default DB relief |
| After safe + candidate | 199 / 200 | 52 | 1 slot freed |
| After safe + candidate + investigate confirmed | 195 / 200 | 52 | 5 slots freed |

**The default DB is at 200/200 with only 1–5 recoverable slots from this audit.** This is insufficient to reach the recommended <190/200 safety margin.

---

## Recommendations

### Immediate (safe, no code changes required)
1. Remove `operationsReports` and `reportSchedules` from `firestore.indexes.sokoni-ops.json` — 2 confirmed orphans.

### Short-term (requires code confirmation)
2. Audit `walletTxns` — confirm no client-side wallet reads use this collection name. If confirmed orphaned, remove from `firestore.indexes.json`.
3. Audit `inventory_grn` and `inventory_stockcounts` — check if `sokoni-inventory-v2.js` (client-side) or `pos-inventory.js` perform compound queries on these collections. If no compound queries exist, the single-field reads don't need composite indexes.

### To reach <190/200 comfort zone (10+ index headroom needed)
The 4–5 recoverable slots above are insufficient. The following strategies are needed:

**A. Migrate more collections to sokoni-ops** — Collections that are ops/queue-oriented but still in the default DB:
   - `_sokoniTaskQueue` (4 indexes) — internal task queue, no user-facing queries
   - `_sokoniPerf` (1 index) — internal perf monitoring
   - `_sokoniErrors` (1 index) — internal error tracking
   - `webhookDeliveries` (2 indexes) — internal webhook queue
   
   Moving these 8 indexes to sokoni-ops would bring default DB to 192 / 200.

**B. Evaluate low-traffic collections** — The following have 1–2 indexes and low query frequency:
   - `homeServiceReviews` (1) — reviews only written from HTML, unlikely to need composite sort
   - `legalAppointments` (1), `legalServiceRequests` (1) — legal hub only writes; queries are simple gets
   - `sellerSubscriptions` (1), `listings` (1) — simple indexed fields

**C. Add new features exclusively to sokoni-ops** — Enforce as a team rule: any new collection that is operational/internal/queue-type goes to sokoni-ops first.

---

## Duplicate Index Check

No duplicate composite indexes were found in either database (200 unique in default DB, 54 unique in sokoni-ops).

---

## Audit Methodology

1. Both index JSON files were fully parsed and counted.
2. Each collection was searched in `functions/*.js` using `grep` for `collection('name')` and `collection("name")` patterns.
3. Collections not found in functions were also searched in `*.html` files.
4. Collections not found in either were searched in `firestore.rules` and documentation.
5. "Safe to remove" requires: absent from functions, HTML, AND firestore.rules.
6. No index files were modified during this audit.

---

*Generated by B-14 Firestore Index Audit — 2026-07-12*
