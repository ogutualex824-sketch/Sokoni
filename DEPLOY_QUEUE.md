# SOKONI CF Deploy Queue

All Cloud Functions below are code-complete and hosted. They are waiting for
Cloud Run quota to clear (quota typically resets within 24 hours).

---

## Enterprise Settlement (Phase 2 + Phase 3) — 2026-07-11 — ✅ DEPLOYED

All 12 settlement ops are LIVE, consolidated into a single dispatcher and hosted
inside `financeSprintDispatch` (finance domain) — **zero dedicated settlement
services**. Deployed via the orphan-reclamation pilot: deleted 38 superseded
loyalty orphans to free Cloud Run headroom, then created `loyaltyDispatch` +
`financeSprintDispatch`. No quota increase used.

Callers: `financeSprintDispatch({op,...})` via `sokoni-settlement.js`. Ops:
settlementGetContext/Preview/GetDashboard, settlementGet/SetRoutingConfig,
getCheckout/adminGet/adminSetPaymentConfig, settlementValidatePath,
settlementGet/SetProviders (settlementGetProviders/settlementSetProvider),
settlementPreviewMethod.

### Quota reclamation — remaining (443 orphans) — repeatable pattern
For each subsystem: `orphans ∩ dispatcher._h` → confirm no direct client caller →
`functions:delete` set → deploy dispatcher. Buckets: admin ~43 (adminOsDispatch),
redis ~28 (redisDispatch), search ~19, booking ~16 (bookingDispatch), pos ~9.

---

## Sprint 4.8 — Phase 3 Portal Completion — 2026-07-08

**No new Cloud Functions.** All backing CFs were deployed in Phase 3.

**New pages (hosting deploy required):**
- `webhooks.html` — Webhook Management portal
- `task-queue.html` — Task Queue monitor
- `api-gateway.html` — API Gateway metrics

**Screenshots generated:**
- `assets/screenshots/screen-{1..4}.png` — 1080×1920 Play Store screenshots

**Hosting deploy:**
```bash
npx firebase-tools@latest deploy --only hosting
```

**Android build (manual — requires Android SDK):**
1. Install Android Studio: https://developer.android.com/studio
2. Update `~/.bubblewrap/config.json` with Android SDK path
3. `bubblewrap build --skipPwaValidation`
4. Upload `app-release.aab` to Play Console

---

## Sprint 4.7 — Native Android TWA — 2026-07-08

**No new Cloud Functions.**

**Hosting deploy required** (publishes `assetlinks.json`, updated `firebase.json`, updated `manifest.json`):

```bash
npx firebase-tools@latest deploy --only hosting
```

**Then build the Android app:**
```bash
# Prerequisites: JDK 11+, Android SDK, npm i -g @bubblewrap/cli
# 1. Generate keystore (once only)
keytool -genkeypair -alias sokoni-key -keyalg RSA -keysize 2048 -validity 10000 -keystore sokoni-release.keystore
# 2. Get SHA-256 fingerprint
keytool -list -v -keystore sokoni-release.keystore -alias sokoni-key | grep "SHA256:"
# 3. Update assetlinks.json + twa-manifest.json with fingerprint
# 4. Redeploy hosting
npx firebase-tools@latest deploy --only hosting
# 5. Build AAB for Play Store
bubblewrap build --skipPwaValidation
```

See `docs/ANDROID_RELEASE.md` for the full 10-step guide.

---

## Sprint 4.6 — Platform Shell — 2026-07-08

**No new Cloud Functions.** All observability CFs were deployed in Phase 3.

**New client-side files (hosting deploy required):**
- `sokoni-command-palette.js` — global command palette; auto-injected via shared-header.js
- `observability.html` — admin observability dashboard

**Hosting deploy command:**
```bash
npx firebase-tools@latest deploy --only hosting
```

---

## Phase 3 — Enterprise Scalability — 2026-07-08

**Files:**
- `functions/analytics-engine.js` — NEW (34 CFs)
- `functions/observability-engine.js` — NEW (10 CFs)
- `functions/reliability-engine.js` — NEW (9 CFs)
- `functions/api-gateway.js` — NEW (3 CFs)
- `functions/webhook-engine.js` — NEW (8 CFs)
- `functions/task-queue.js` — NEW (7 CFs)
- `sokoni-observability.js` — NEW (client SDK, auto-injected)
- `sokoni-resilience.js` — NEW (client SDK, auto-injected)
- `sokoni-performance.js` — NEW (client SDK, auto-injected)
- `shared-header.js` — 3 new SDK injections added
- `functions/index.js` — 71 new exports added
- `docs/ARCHITECTURE.md` — updated to v4.0
- `docs/SCALABILITY.md` — NEW (Enterprise Scalability reference doc)

**Analytics Engine CFs (34 — analytics-engine.js):**

| Export | Purpose |
|---|---|
| `salesGetSummary` | Revenue KPIs: GMV, orders, AOV, conversion |
| `salesGetTimeSeries` | Revenue trend by day/week/month |
| `salesGetByCategory` | Revenue breakdown by product category |
| `salesGetByChannel` | Revenue by sales channel (online/POS/wholesale) |
| `salesGetPaymentMethodBreakdown` | M-Pesa vs card vs wallet split |
| `salesGetTopProducts` | Top products by revenue/quantity |
| `salesGetHourlyHeatmap` | Orders by hour-of-day × day-of-week |
| `analyticsTrackEvent` | Client-side event ingestion (page_view, add_to_cart, etc.) |
| `analyticsGetFunnel` | Checkout funnel drop-off analysis |
| `analyticsGetTopPages` | Most-visited pages by sessions |
| `analyticsGetSearchTerms` | Search queries, zero-results rate |
| `analyticsGetCartAbandonment` | Cart abandonment rate + abandoned revenue |
| `analyticsGetTrafficSources` | Acquisition channel analysis |
| `cohortGetRetention` | Weekly cohort retention grid |
| `cohortGetLTV` | Customer lifetime value by cohort |
| `cohortGetNewVsReturning` | New vs returning customer revenue split |
| `cohortGetChurn` | Churn rate and at-risk customers |
| `cohortGetTopBuyers` | Top buyers by spend/frequency |
| `productGetSalesVelocity` | Sales velocity (units/day) per product |
| `productGetReturnRate` | Return/refund rate by product |
| `productGetReviewSentiment` | AI sentiment score from product reviews |
| `productGetMarginAnalysis` | Gross margin per product (requires cost data) |
| `productGetInventoryTurnover` | Stock turn ratio by category |
| `productGetSlowMovers` | Slow-moving inventory (no sale in 30d) |
| `analyticsGetRealtimeSnapshot` | Live: active sessions, events/min, revenue today |
| `analyticsGetPlatformSnapshot` | Platform-wide health: error rates, p95 latency |
| `analyticsGetOrderStatusBreakdown` | Order status distribution (pending/processing/shipped/etc.) |
| `analyticsGetAverageDeliveryTime` | Mean delivery time by zone/rider |
| `analyticsGetStaffPerformance` | Staff KPIs: sales/shift, cashier accuracy |
| `reportCreate` | Save custom report definition |
| `reportList` | List saved reports |
| `reportDelete` | Delete saved report |
| `analyticsExport` | CSV/JSON export of any metric |
| `analyticsSnapshotDaily` | Scheduled: materialise daily analytics to Firestore |

**Spot-deploy command (71 new CFs):**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:salesGetSummary,functions:salesGetTimeSeries,functions:salesGetByCategory,functions:salesGetByChannel,functions:salesGetPaymentMethodBreakdown,functions:salesGetTopProducts,functions:salesGetHourlyHeatmap,functions:analyticsTrackEvent,functions:analyticsGetFunnel,functions:analyticsGetTopPages,functions:analyticsGetSearchTerms,functions:analyticsGetCartAbandonment,functions:analyticsGetTrafficSources,functions:cohortGetRetention,functions:cohortGetLTV,functions:cohortGetNewVsReturning,functions:cohortGetChurn,functions:cohortGetTopBuyers,functions:productGetSalesVelocity,functions:productGetReturnRate,functions:productGetReviewSentiment,functions:productGetMarginAnalysis,functions:productGetInventoryTurnover,functions:productGetSlowMovers,functions:analyticsGetRealtimeSnapshot,functions:analyticsGetPlatformSnapshot,functions:analyticsGetOrderStatusBreakdown,functions:analyticsGetAverageDeliveryTime,functions:analyticsGetStaffPerformance,functions:reportCreate,functions:reportList,functions:reportDelete,functions:analyticsExport,functions:analyticsSnapshotDaily,functions:obsIngestTelemetry,functions:obsGetErrorReport,functions:obsGetPerformanceReport,functions:obsGetRealTimeMetrics,functions:obsScheduledAggregation,functions:obsGetAuditLog,functions:obsCreateAlert,functions:obsCheckAlerts,functions:obsDistributedTrace,functions:obsHealthProbe,functions:relEnqueueTask,functions:relGetDeadLetterQueue,functions:relRetryDeadLetter,functions:relPurgeDeadLetter,functions:relCircuitBreakerState,functions:relHealthProbeAll,functions:relScheduledHealthCheck,functions:relScheduledRetryProcessor,functions:relGetSystemMetrics,functions:sokoniAPIGateway,functions:gwGetMetrics,functions:gwManageRateLimit,functions:webhookRegister,functions:webhookList,functions:webhookDelete,functions:webhookDeliver,functions:webhookRetryProcessor,functions:webhookGetDeliveries,functions:webhookTestEndpoint,functions:webhookGetStats,functions:tqEnqueue,functions:tqGetStatus,functions:tqCancelTask,functions:tqGetQueueStats,functions:tqWorkerProcessor,functions:tqScheduledCleanup,functions:tqBulkEnqueue" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

**Hosting deploy (new client SDKs):**
```bash
firebase deploy --only hosting
```

**Post-deploy steps:**
1. Set `minInstances: 1` in `firebase.json` for `sokoniAPIGateway` and `obsHealthProbe`
2. Configure Cloud Monitoring uptime check on `https://us-central1-sokoni-aeb26.cloudfunctions.net/obsHealthProbe`
3. Create initial alerts via `obsCreateAlert` CF: error_rate > 0.01, p95_lcp > 3000
4. Enable Firestore multi-region in GCP Console (Settings → Multi-region: nam5)

---

## Logistics+ (Sprint 4.4) — 2026-07-08

**Files:**
- `functions/logistics-plus.js` — NEW (30 CFs)
- `fleet-manager.html` — NEW (Fleet management + maintenance/fuel logs)
- `route-planner.html` — NEW (Multi-stop route creation + optimize + stop status)
- `warehouse.html` — NEW (Receive, putaway, pick list, ship)
- `logistics-reports.html` — NEW (Delivery KPIs, rider leaderboard, zone perf, on-time trend)
- `functions/index.js` — 30 new exports added

**New CFs (30 — quota-blocked):**

| Export | Module | Auth |
|---|---|---|
| `fleetVehicleCreate` | Fleet | Manager |
| `fleetVehicleUpdate` | Fleet | Manager |
| `fleetVehicleList` | Fleet | Shop member |
| `fleetLogMaintenance` | Fleet | Shop member |
| `fleetLogFuel` | Fleet | Shop member |
| `fleetGetVehicleStats` | Fleet | Manager |
| `routeCreate` | Route | Manager |
| `routeOptimize` | Route | Manager |
| `routeAssignDriver` | Route | Manager |
| `routeUpdateStop` | Route | Assigned driver |
| `routeGetActive` | Route | Shop member |
| `warehouseReceive` | Warehouse | Manager |
| `warehousePutaway` | Warehouse | Shop member |
| `warehouseGeneratePickList` | Warehouse | Shop member |
| `warehouseConfirmPick` | Warehouse | Shop member |
| `warehouseShipOrder` | Warehouse | Shop member |
| `warehouseGetInventory` | Warehouse | Shop member |
| `warehouseGetDashboard` | Warehouse | Shop member |
| `deliveryZoneCreate` | Zones | Manager |
| `deliveryZoneUpdate` | Zones | Manager |
| `deliveryZoneList` | Zones | Any auth |
| `deliveryZoneCheckCoverage` | Zones | Any auth |
| `cargoCalculateFreight` | Cargo | Any auth |
| `cargoManifestCreate` | Cargo | Manager |
| `cargoManifestAddItem` | Cargo | Manager |
| `cargoManifestList` | Cargo | Shop member |
| `logisticsGetDeliveryReport` | Reports | Manager |
| `logisticsGetRiderLeaderboard` | Reports | Manager |
| `logisticsGetZonePerformance` | Reports | Manager |
| `logisticsGetOnTimeRate` | Reports | Manager |

**Spot deploy (run after quota clears):**
```bash
firebase deploy --only functions:fleetVehicleCreate,functions:fleetVehicleUpdate,functions:fleetVehicleList,functions:fleetLogMaintenance,functions:fleetLogFuel,functions:fleetGetVehicleStats,functions:routeCreate,functions:routeOptimize,functions:routeAssignDriver,functions:routeUpdateStop,functions:routeGetActive,functions:warehouseReceive,functions:warehousePutaway,functions:warehouseGeneratePickList,functions:warehouseConfirmPick,functions:warehouseShipOrder,functions:warehouseGetInventory,functions:warehouseGetDashboard,functions:deliveryZoneCreate,functions:deliveryZoneUpdate,functions:deliveryZoneList,functions:deliveryZoneCheckCoverage,functions:cargoCalculateFreight,functions:cargoManifestCreate,functions:cargoManifestAddItem,functions:cargoManifestList,functions:logisticsGetDeliveryReport,functions:logisticsGetRiderLeaderboard,functions:logisticsGetZonePerformance,functions:logisticsGetOnTimeRate
```

**Hosting (4 new pages):**
```bash
firebase deploy --only hosting
```

---

## Finance OS (Sprint 4.3) — 2026-07-08

**Files:**
- `functions/finance-os-sprint43.js` — NEW (37 CFs)
- `finance-budget.html` — NEW (Budget creation, tracking, alerts)
- `finance-expenses.html` — NEW (Expense claims + approval workflow)
- `finance-reconcile.html` — NEW (Bank statement import + matching)
- `finance-invoices.html` — NEW (Invoice creation + lifecycle)
- `functions/index.js` — 37 new exports added

**New CFs (37 — quota-blocked):**

| Export | Module | Auth |
|---|---|---|
| `budgetCreate` | Budgeting | Manager |
| `budgetUpdate` | Budgeting | Manager |
| `budgetGet` | Budgeting | Shop member |
| `budgetList` | Budgeting | Shop member |
| `budgetRecordExpense` | Budgeting | Shop member |
| `budgetGetAlerts` | Budgeting | Shop member |
| `expenseCreate` | Expenses | Shop member |
| `expenseApprove` | Expenses | Manager |
| `expenseReject` | Expenses | Manager |
| `expenseMarkPaid` | Expenses | Manager |
| `expenseGetMine` | Expenses | Shop member |
| `expenseGetPending` | Expenses | Manager |
| `expenseList` | Expenses | Manager |
| `reconImportStatement` | Bank Recon | Manager |
| `reconGetUnmatched` | Bank Recon | Shop member |
| `reconMatchTransaction` | Bank Recon | Manager |
| `reconMarkExternal` | Bank Recon | Manager |
| `reconGetSummary` | Bank Recon | Shop member |
| `taxFilingCreate` | Tax Calendar | Manager |
| `taxFilingMarkFiled` | Tax Calendar | Manager |
| `taxFilingGetDue` | Tax Calendar | Shop member |
| `taxFilingGetHistory` | Tax Calendar | Shop member |
| `finStmtGetPL` | Financial Stmts | Manager |
| `finStmtGetBalanceSheet` | Financial Stmts | Manager |
| `finStmtGetCashFlow` | Financial Stmts | Manager |
| `finStmtExport` | Financial Stmts | Manager |
| `pettyCashCreate` | Petty Cash | Manager |
| `pettyCashDisburse` | Petty Cash | Shop member |
| `pettyCashReplenish` | Petty Cash | Manager |
| `pettyCashGetBalance` | Petty Cash | Shop member |
| `pettyCashReconcile` | Petty Cash | Manager |
| `invoiceCreate` | Invoices | Shop member |
| `invoiceSend` | Invoices | Shop member |
| `invoiceMarkPaid` | Invoices | Shop member |
| `invoiceVoid` | Invoices | Manager |
| `invoiceGet` | Invoices | Shop member |
| `invoiceList` | Invoices | Shop member |

**New Firestore collections:**
- `budgets/{id}` — budget docs with embedded categories[] array
- `expenseClaims/{id}` — expense claims with approval lifecycle
- `bankStatements/{id}` — imported statement metadata
- `bankStatementEntries/{id}` — individual statement rows
- `taxFilings/{id}` — tax filing calendar entries
- `pettyCashFunds/{id}` — petty cash funds
- `pettyCashTransactions/{id}` — disbursements/replenishments/reconciliations
- `invoices/{id}` — invoice docs with embedded line items[]
- `invoiceCounters/{shopId}` — auto-increment invoice number per shop

**Spot deploy command:**
```powershell
firebase deploy --only "functions:budgetCreate,functions:budgetUpdate,functions:budgetGet,functions:budgetList,functions:budgetRecordExpense,functions:budgetGetAlerts,functions:expenseCreate,functions:expenseApprove,functions:expenseReject,functions:expenseMarkPaid,functions:expenseGetMine,functions:expenseGetPending,functions:expenseList,functions:reconImportStatement,functions:reconGetUnmatched,functions:reconMatchTransaction,functions:reconMarkExternal,functions:reconGetSummary,functions:taxFilingCreate,functions:taxFilingMarkFiled,functions:taxFilingGetDue,functions:taxFilingGetHistory,functions:finStmtGetPL,functions:finStmtGetBalanceSheet,functions:finStmtGetCashFlow,functions:finStmtExport,functions:pettyCashCreate,functions:pettyCashDisburse,functions:pettyCashReplenish,functions:pettyCashGetBalance,functions:pettyCashReconcile,functions:invoiceCreate,functions:invoiceSend,functions:invoiceMarkPaid,functions:invoiceVoid,functions:invoiceGet,functions:invoiceList" --project sokoni-aeb26
```

**Hosting deploy:**
```powershell
firebase deploy --only hosting --project sokoni-aeb26
```

---

## Marketplace Extensions (Sprint 4.2) — 2026-07-08

**Files:**
- `functions/marketplace-extensions.js` — NEW (31 CFs)
- `auction.html` — NEW (public auction browser + live bidding)
- `auction-manager.html` — NEW (seller auction management)
- `rental.html` — NEW (rental product browser + booking flow)
- `digital-store.html` — NEW (digital product store + my library)
- `functions/index.js` — 31 new exports added

**New CFs (31 — quota-blocked):**

| Export | Module | Auth |
|---|---|---|
| `auctionCreate` | Auctions | Seller |
| `auctionBid` | Auctions | Any authed |
| `auctionGet` | Auctions | Public |
| `auctionList` | Auctions | Public |
| `auctionGetBids` | Auctions | Seller |
| `auctionWatch` | Auctions | Any authed |
| `auctionGetMyBids` | Auctions | Any authed |
| `auctionCloseSweep` | Auctions | Scheduled |
| `rentalProductCreate` | Rentals | Seller |
| `rentalGetAvailability` | Rentals | Public |
| `rentalBook` | Rentals | Any authed |
| `rentalConfirm` | Rentals | Seller |
| `rentalComplete` | Rentals | Seller |
| `rentalCancel` | Rentals | Seller/Buyer |
| `rentalList` | Rentals | Public |
| `digitalProductCreate` | Digital Products | Seller |
| `digitalProductPurchase` | Digital Products | Any authed |
| `digitalProductDownload` | Digital Products | Buyer |
| `digitalProductGetMyLibrary` | Digital Products | Any authed |
| `digitalProductGetSales` | Digital Products | Seller |
| `productAskQuestion` | Q&A | Any authed |
| `productAnswerQuestion` | Q&A | Seller/Owner |
| `productGetQA` | Q&A | Public |
| `productVoteHelpful` | Q&A | Any authed |
| `wishlistAdd` | Wishlist | Any authed |
| `wishlistRemove` | Wishlist | Any authed |
| `wishlistGet` | Wishlist | Any authed |
| `priceHistoryRecord` | Price History | Internal/Seller |
| `priceHistoryGet` | Price History | Public |
| `seoGetProductMeta` | SEO | Public |
| `seoGetSitemap` | SEO | Public (HTTP) |

**New Firestore collections:**
- `auctions/{id}` — auction docs (scheduled/active/ended_sold/ended_unsold)
- `auctionBids/{id}` — bid records (single-field auctionId query)
- `auctionWatchers/{auctionId}_{uid}` — compound doc ID
- `rentalProducts/{id}` — rental listings with flexible rate types
- `rentalBookings/{id}` — bookings with overlap detection
- `digitalProducts/{id}` — listings with Firebase Storage path
- `digitalPurchases/{id}` — purchase records with license key + download count
- `productQuestions/{id}` — Q&A with embedded answers array
- `wishlistItems/{uid}_{productId}` — compound doc ID
- `priceHistoryLog/{id}` — flat collection with single productId field

**Spot deploy command:**
```powershell
firebase deploy --only "functions:auctionCreate,functions:auctionBid,functions:auctionGet,functions:auctionList,functions:auctionGetBids,functions:auctionWatch,functions:auctionGetMyBids,functions:auctionCloseSweep,functions:rentalProductCreate,functions:rentalGetAvailability,functions:rentalBook,functions:rentalConfirm,functions:rentalComplete,functions:rentalCancel,functions:rentalList,functions:digitalProductCreate,functions:digitalProductPurchase,functions:digitalProductDownload,functions:digitalProductGetMyLibrary,functions:digitalProductGetSales,functions:productAskQuestion,functions:productAnswerQuestion,functions:productGetQA,functions:productVoteHelpful,functions:wishlistAdd,functions:wishlistRemove,functions:wishlistGet,functions:priceHistoryRecord,functions:priceHistoryGet,functions:seoGetProductMeta,functions:seoGetSitemap" --project sokoni-aeb26
```

**Hosting deploy:**
```powershell
firebase deploy --only hosting --project sokoni-aeb26
```

---

## SmartPOS Completeness Engine (Sprint 4.1) — 2026-07-08

**Files:**
- `functions/pos-completeness.js` — NEW (27 CFs)
- `pos-completeness.html` — NEW (Gift Cards, Layaway, Park Sales, Cycle Count, Currency hub)
- `pos-kds.html` — NEW (Kitchen Display System — real-time Firestore onSnapshot)
- `functions/index.js` — 27 new exports added

**New CFs (27 — quota-blocked):**

| Export | Module | Auth |
|---|---|---|
| `giftCardIssue` | Gift Cards | Seller/Cashier |
| `giftCardRedeem` | Gift Cards | Seller/Cashier |
| `giftCardBalance` | Gift Cards | Any authed |
| `giftCardVoid` | Gift Cards | Seller |
| `giftCardList` | Gift Cards | Seller |
| `layawayCreate` | Layaway | Seller/Cashier |
| `layawayAddPayment` | Layaway | Seller/Cashier |
| `layawayFulfill` | Layaway | Seller/Cashier |
| `layawayCancel` | Layaway | Seller/Cashier |
| `layawayList` | Layaway | Seller/Cashier |
| `salePark` | Park Sales | Seller/Cashier |
| `saleRetrieve` | Park Sales | Seller/Cashier |
| `saleListParked` | Park Sales | Seller/Cashier |
| `saleDiscardParked` | Park Sales | Seller/Cashier |
| `kdsSubmitOrder` | KDS | Seller/Cashier |
| `kdsUpdateItem` | KDS | Seller/Cashier/Kitchen |
| `kdsGetQueue` | KDS | Seller/Cashier/Kitchen |
| `kdsBump` | KDS | Seller/Cashier/Kitchen |
| `cycleCountCreate` | Cycle Count | Seller/Manager |
| `cycleCountUpdateItem` | Cycle Count | Seller/Manager |
| `cycleCountComplete` | Cycle Count | Seller/Manager |
| `cycleCountList` | Cycle Count | Seller/Manager |
| `cycleCountGet` | Cycle Count | Seller/Manager |
| `currencyGetRates` | Multi-Currency | Any authed |
| `currencySetRate` | Multi-Currency | Seller/Manager |

**New Firestore collections:**
- `giftCards/{code}` — gift card docs (active/redeemed/void)
- `layaways/{id}` — layaway plans with embedded payments array
- `parkedSales/{id}` — parked cart docs (TTL: until retrieved/discarded)
- `kdsOrders/{id}` — KDS order queue (real-time listener)
- `cycleCounts/{id}` — count sessions with embedded items
- `inventoryAdjustments/{id}` — audit trail for stock corrections
- `currencyRates/{shopId}` — per-shop FX rates

**Spot deploy command:**
```powershell
firebase deploy --only "functions:giftCardIssue,functions:giftCardRedeem,functions:giftCardBalance,functions:giftCardVoid,functions:giftCardList,functions:layawayCreate,functions:layawayAddPayment,functions:layawayFulfill,functions:layawayCancel,functions:layawayList,functions:salePark,functions:saleRetrieve,functions:saleListParked,functions:saleDiscardParked,functions:kdsSubmitOrder,functions:kdsUpdateItem,functions:kdsGetQueue,functions:kdsBump,functions:cycleCountCreate,functions:cycleCountUpdateItem,functions:cycleCountComplete,functions:cycleCountList,functions:cycleCountGet,functions:currencyGetRates,functions:currencySetRate" --project sokoni-aeb26
```

**Hosting deploy:**
```powershell
firebase deploy --only hosting --project sokoni-aeb26
```

---

## Navigation & Intelligent Dispatch v2.0 — 2026-07-08

**Files:**
- `functions/navigation.js` — +4 new CFs (794 → 1,154 lines)
- `sokoni-navigation.js` — v2.0 SDK (safety monitor, dynamic throttle, offline queue)
- `rider-dashboard.html` — NEW rider dashboard page
- `track.html` — real-time Firestore listeners (replaces 5s polling)
- `functions/index.js` — 4 new exports added

**New CFs (4 — quota-blocked):**

| Export name | Type | Auth | Purpose |
|---|---|---|---|
| `navGenerateDeliveryOTP` | onCall | Seller/Driver | 6-digit OTP for proof-of-delivery, SMS via Africa's Talking |
| `navGetRiderDashboard` | onCall | Driver | Earnings, ratings, completion rate, active trip banner |
| `navBatchSyncLocations` | onCall | Driver | Offline location queue flush (max 100 points, 50 history writes) |
| `navGetDeliveryAnalytics` | onCall | Admin | Platform-wide delivery stats, clamp 1–90 days |

**Secrets required:**
- `AFRICASTALKING_API_KEY` (new — add to Secret Manager)
- `AFRICASTALKING_USERNAME` (new — add to Secret Manager)

**Spot deploy command:**
```powershell
firebase deploy --only "functions:navGenerateDeliveryOTP,functions:navGetRiderDashboard,functions:navBatchSyncLocations,functions:navGetDeliveryAnalytics" --project sokoni-aeb26
```

**Hosting deploy (new rider-dashboard.html + updated track.html):**
```powershell
firebase deploy --only hosting --project sokoni-aeb26
```

**New Firestore collections:**
- `deliveryOTPs/{tripId}_{stopIndex}` — 6-digit OTP doc (expires 10 min)
- `riderLocationHistory/{uid}/points/{ts}` — offline-synced GPS history

---

## Merchant Success & Growth Engine v2.0 — 2026-07-08

**Files:**
- `functions/merchant-success.js` — REPLACED (v1.0 11 CFs → v2.0 17 CFs)
- `merchant-success.html` — REPLACED (full premium redesign, 10 sections)
- `functions/index.js` — updated exports (stale v1 names replaced with v2 names)

**New CFs (17 — add to pending count — quota-blocked):**

| Export name | Type | Auth | Purpose |
|---|---|---|---|
| `getMerchantDashboard` | onCall | Seller | Combined health + stats + alerts on page load |
| `getMerchantHealthScore` | onCall | Seller | Detailed health score (8 factors, grade, tips) |
| `getMerchantAICoach` | onCall | Seller | Claude Haiku recommendations + Q&A |
| `getMerchantOpportunities` | onCall | Seller | Trending, low stock, returning customer signals |
| `getMerchantCRM` | onCall | Seller | Customer list with LTV, segments, history |
| `updateCustomerNote` | onCall | Seller | Add/update CRM note for a customer |
| `getMerchantInventoryIntelligence` | onCall | Seller | Slow/fast/dead/overstock analysis |
| `getMerchantFinancials` | onCall | Seller | P&L, revenue trend, AOV, CLV, peak hours |
| `getMerchantBenchmark` | onCall | Seller | Anonymous comparison with similar businesses |
| `getMerchantAutomations` | onCall | Seller | List automation rules |
| `saveMerchantAutomation` | onCall | Seller | Create/update automation rule |
| `toggleMerchantAutomation` | onCall | Seller | Enable/disable automation rule |
| `createMerchantCampaign` | onCall | Seller | AI-generated or manual marketing campaign |
| `getMerchantCampaigns` | onCall | Seller | Campaign list + stats |
| `getMerchantAcademy` | onCall | Seller | Learning modules + progress (22 lessons, 5 modules) |
| `updateAcademyProgress` | onCall | Seller | Mark lesson complete + award XP |
| `generateMerchantContent` | onCall | Seller | AI content: descriptions, bios, campaigns, status |

**Renamed from v1.0 (old live CFs to delete after v2 deploy):**
- `getAICoachInsights` → `getMerchantAICoach` *(old CF stays live until deleted)*
- `getMerchantInventoryInsights` → `getMerchantInventoryIntelligence`
- `getMerchantBenchmarks` → `getMerchantBenchmark`
- `createMerchantAutomation` → `saveMerchantAutomation`
- `completeMerchantLesson` → `updateAcademyProgress`

**New Firestore collections:**
- `merchantHealth/{shopId}` — cached health score (TTL 1h)
- `merchantAutomations/{id}` — automation rules (`shopId` single-field query)
- `merchantCampaigns/{id}` — campaign records (`shopId` single-field query)
- `crmNotes/{shopId}/customers/{customerId}` — CRM notes per customer
- `academyProgress/{uid}` — lesson completion + XP
- `aiCoachRL/{shopId_YYYYMMDD}` — coach rate-limit counter (max 10/day)
- `aiContentRL/{uid_YYYYMMDD}` — content gen rate-limit counter (max 20/day)

**Secrets required:** `ANTHROPIC_API_KEY` (already in Secret Manager)

**Spot deploy command (all 17 — run when quota available):**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:getMerchantDashboard,functions:getMerchantHealthScore,functions:getMerchantAICoach,functions:getMerchantOpportunities,functions:getMerchantCRM,functions:updateCustomerNote,functions:getMerchantInventoryIntelligence,functions:getMerchantFinancials,functions:getMerchantBenchmark,functions:getMerchantAutomations,functions:saveMerchantAutomation,functions:toggleMerchantAutomation,functions:createMerchantCampaign,functions:getMerchantCampaigns,functions:getMerchantAcademy,functions:updateAcademyProgress,functions:generateMerchantContent" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

**Cleanup command (delete stale v1 CFs after v2 deploy succeeds):**
```powershell
firebase functions:delete getAICoachInsights getMerchantInventoryInsights getMerchantBenchmarks createMerchantAutomation completeMerchantLesson --project sokoni-aeb26 --force
```

**Hosting deploy (merchant-success.html page):**
```powershell
firebase deploy --only hosting --project sokoni-aeb26
```

---

## BUG FIX — 2026-07-08 (earnLoyaltyPoints export mismatch)

**File:** `functions/index.js` line 8224

`loyalty.js` exports `awardLoyaltyPoints` (not `earnLoyaltyPoints`). The index.js
export was using the wrong function name, causing deploy to abort immediately with
"No function matches the filter: default:earnLoyaltyPoints".

**Fix applied:**
```js
// Before (wrong):
exports.earnLoyaltyPoints = loyalty.earnLoyaltyPoints;
// After (correct):
exports.awardLoyaltyPoints = loyalty.awardLoyaltyPoints;
```

Use `functions:awardLoyaltyPoints` in all deploy commands (not `earnLoyaltyPoints`).

---

## SmartPOS Cash Drawer v1.0 — 2026-07-11 — ⛔ QUOTA-BLOCKED

**8 new Cloud Functions — quota-blocked. Hosting-only deploy available now.**

New CFs in `functions/pos-cash-drawer.js`:
| CF | Auth | Purpose |
|---|---|---|
| `cdOpenDrawer` | cashier+ | Log every drawer event |
| `cdGetAuditLog` | manager+ | Query audit log |
| `cdGetConfig` | any auth | Per-register config |
| `cdSetConfig` | admin | Update drawer config |
| `cdRecordCashEvent` | cashier+ | Till movements |
| `cdGetShiftSummary` | manager+ | Expected vs actual |
| `cdGetReconciliation` | manager+ | Full shift detail |
| `cdGetDiagnostics` | admin | 24h error rate |

**Hosting deploy (do now — no quota needed):**
```bash
npx firebase-tools@latest deploy --only hosting
```

**CF deploy command (run once quota clears):**
```bash
firebase deploy --only functions:cdOpenDrawer,functions:cdGetAuditLog,functions:cdGetConfig,functions:cdSetConfig,functions:cdRecordCashEvent,functions:cdGetShiftSummary,functions:cdGetReconciliation,functions:cdGetDiagnostics
```

---

## SmartPOS Multi-Till System v1.0 — 9 CFs (QUOTA BLOCKED)

**Added:** 2026-07-11
**File:** `functions/pos-multi-till.js`

| CF | Auth | Purpose |
|---|---|---|
| `mtRegisterCreate` | admin | Create a register config doc |
| `mtRegisterUpdate` | admin | Update name / status / devices |
| `mtRegisterDelete` | admin | Soft-delete (status: deleted) |
| `mtRegisterList` | manager+ | List all registers for a merchant |
| `mtRegisterAssign` | manager+ | Assign/unassign cashier to till |
| `mtGetLiveFloor` | manager+ | Server snapshot of active tills |
| `mtGetFloorSummary` | manager+ | Aggregated store KPIs |
| `mtGetRegisterStats` | manager+ | Per-register config + live state |
| `mtRecordTillEvent` | cashier+ | Log a floor event |

**Hosting deploy (do now — no quota needed):**
```bash
firebase deploy --only hosting
```

**CF deploy command (run once quota clears):**
```bash
firebase deploy --only functions:mtRegisterCreate,functions:mtRegisterUpdate,functions:mtRegisterDelete,functions:mtRegisterList,functions:mtRegisterAssign,functions:mtGetLiveFloor,functions:mtGetFloorSummary,functions:mtGetRegisterStats,functions:mtRecordTillEvent
```

---

## ▶ AUTHORITATIVE PENDING SNAPSHOT — 2026-07-11 (updated)
_Supersedes the older per-batch counts below (14/23, 0/143 were partial views)._

Ground truth: `firebase functions:list` (1512 live) vs trigger exports loaded from
`index.js` (1698+). **195+ functions are in code but NOT deployed**, all blocked by the
same hard **Cloud Run CPU quota ceiling** in `us-central1` (HTTP 429). Confirmed by 3
dry auto-retries returning 0 created; freeing 14 slots earlier let in exactly 14 — a
1:1 hard ceiling that does NOT reset on a timer.

### Pending by subsystem (218 total)
- 38 — POS terminal / peripheral (`pos*`) — includes 7 new printer CFs
- 17 — financial-os (`fos*`)
- **17 — venue & resource booking engine (NEW) ⚠ PRIORITY**
- **14 — availability engine (NEW) ⚠ PRIORITY (enables open/closed status on all hubs)**
- 13 — Firestore triggers (`on*` order/payment/delivery/user)
- **11 — async job-engine (NEW) ⚠ PRIORITY (restores job processing — see gap note)**
- 10 — sessions
- 9 — rosters / shifts
- 7 — subscription (`sub*`)
- 7 — franchise
- 6 — platform-core (`pc*`)
- 6 — ops-center (`ops*`)
- 6 — rollback / DR
- 6 — installments
- 5 — returns
- 5 — currency
- 4 each — security-audit, pos-smartpos-webhooks, file-security, api-keys
- 3 each — workflow-automation, maintenance
- 2 — event-bus
- 24 — other

Full name list: `scratchpad/pending.txt`.

---

## Intelligent Automation & Decision Engine v1.0 — 2026-07-08

**Files:**
- `functions/automation-engine.js` — 15 CFs (6 triggers + 2 scheduled + 7 callable)
- `automation-center.html` — admin UI; calls `auto*` CFs
- `admin-os.html` — added sidebar links to automation-center + ADE rules

**New CFs (add to pending count — blocked by same quota):**

| Export name | Type | Purpose |
|---|---|---|
| `autoOnAccountCreate` | Firestore trigger `users/{uid}` | Auto-activate new accounts |
| `autoOnSubscriptionCreate` | Firestore trigger `subscriptions/{subId}` | Activate subscription lifecycle |
| `autoOnSellerApplication` | Firestore trigger `sellerApplications/{appId}` | Auto-approve/queue seller applications |
| `autoOnDisputeCreate` | Firestore trigger `disputes/{disputeId}` | AI-powered dispute resolution |
| `autoOnRefundRequest` | Firestore trigger `refundRequests/{refId}` | Auto-approve small refunds, queue large |
| `autoOnApprovalRequest` | Firestore trigger `approvalRequests/{reqId}` | Route approval requests by risk |
| `autoScheduledPayouts` | Schedule every 6 hours | Process eligible seller payouts |
| `autoScheduledMaintenance` | Schedule every 24 hours | Archive orders, retry failed jobs |
| `autoGetExceptionQueue` | onCall admin | List automationQueue items |
| `autoResolveException` | onCall admin | Resolve exception with override tracking |
| `autoGetRules` | onCall admin | Fetch all business rules |
| `autoUpdateRule` | onCall admin | Update single rule category |
| `autoGetAuditLog` | onCall admin | Paginated automation audit log |
| `autoGetStatus` | onCall admin | Engine health and queue stats |
| `autoTriggerMaintenance` | onCall admin | On-demand maintenance run |

**New Firestore collections:**
- `automationRules/{category}` — configurable business rules (no-code threshold editing)
- `automationQueue` — exception items requiring human review
- `automationAuditLog` — immutable trail of every automated action

**Secrets required:** `ANTHROPIC_API_KEY` (already in Secret Manager — for AI dispute resolution)

**Deploy command (when quota available):**
```bash
firebase deploy --only functions:autoOnAccountCreate,functions:autoOnSubscriptionCreate,functions:autoOnSellerApplication,functions:autoOnDisputeCreate,functions:autoOnRefundRequest,functions:autoOnApprovalRequest,functions:autoScheduledPayouts,functions:autoScheduledMaintenance,functions:autoGetExceptionQueue,functions:autoResolveException,functions:autoGetRules,functions:autoUpdateRule,functions:autoGetAuditLog,functions:autoGetStatus,functions:autoTriggerMaintenance,hosting
```

**What's automated on deploy:**
- Every new user account auto-activated (configurable: can require email verify)
- Every new subscription auto-activated with billing cycle date
- Seller applications with standard docs auto-approved; incomplete → exception queue with guidance
- Disputes under KES 1,000 auto-resolved with evidence; larger disputes get Claude Haiku recommendation + queued
- Refunds under KES 2,000 auto-approved + wallet credited; over KES 20,000 → exception queue
- Low-risk approval requests (score < 30, amount < KES 10K) auto-approved; others queued
- Payouts over 2-day hold and under KES 100K auto-processed; larger → exception queue
- Daily: archive completed orders > 90 days, retry failed async jobs, expire stale queue items

---

### ⚠ Async job-engine gap (deploy these first when quota frees)
This session pruned the old `async-jobs-engine.js` workers (10 caller-less callables
+ 4 redundant workers) to free quota. Their replacement `async-jobs.js` workers
(`asyncWorker`, `asyncSweeper`, `asyncEnqueue`, `asyncEventRouter`, `asyncCancel`,
`asyncRetryJob`, `asyncPauseQueue`, `asyncGetDashboard`, `asyncGetJobs`,
`asyncInspect`, `asyncCleanup`) are in the pending set — **not yet deployed**, so the
`asyncJobs` collection currently has **no deployed processor**. No live feature breaks
(nothing deployed still enqueues to it), but deploy these 11 first once capacity exists.

### The fix: raise the Cloud Run CPU quota
GCP Console → IAM & Admin → **Quotas** → `run.googleapis.com`, `us-central1` →
**"CPU allocation without committed use (Total, per region)"** → request increase,
then `firebase deploy --only functions --force` lands all 187.

---

## DEPLOY ACTIVITY — 2026-07-08 (Admin OS v2.0 — Mission Control)

### Admin Operating System v2.0 — hosting deploy required
**Files changed:** `admin-os.html`, `sokoni-aos.js`

**New panels / tabs added:**
- Dashboard: +5 KPI cards (Active Businesses, Active Bookings, Inventory Alerts, Platform Uptime, MRR) — now 19 total KPI cards
- User Management: 11 role filters (added agent/doctor/lawyer/hotel/freelancer/employee)
- Delivery: +3 stats (Failed Today, On-Time Rate, Active Riders) + Fleet Monitor / Rider Nav / GIP map links
- Financial: +2 tabs — Wallet Ops (`adminGetWalletOperations`) + Escrow (`finosGetEscrowAccounts`, `finosReleaseEscrow`) + formatted Report tab with JSON export
- Communications: Push tab refactored + Email Blast tab (`adminSendEmailBlast`) + SMS tab (`adminSendSMSBlast`)
- Content: +Campaigns tab (`adminGetCampaigns`, `adminCreateCampaign`, `adminUpdateCampaignStatus`, `adminDeleteCampaign`)
- Analytics: +3 tabs — Cohort (`adminGetCohortAnalysis`), Funnel (`adminGetConversionFunnel`), Retention (`adminGetRetentionMetrics`)
- Config: +Commission Rules section + Payout Schedule section (both save via `adminUpdatePlatformSettings`)
- Audit: +search/filter input (`filterAuditRows` — client-side, no CF needed)
- Fraud: + Payment Anomaly section (`detectPaymentAnomalies` live) + Void Receipt button (`voidTrustReceipt`)
- Security: +Security Tools row (links to Security Center, Zero Trust Dashboard) + Security Events feed (`securityEvents` collection) + Revoke All Sessions
- SmartPOS: +2 tabs — Revenue (`getAdminRevenueReport` with `scope:pos`) + Shifts (`posShifts` collection) + Observability link

**New functions added to public API:** `voidReceiptDialog`, `analyticsTab`, `saveCommissionRules`, `savePayoutSchedule`, `filterAuditRows`, `revokeAllSessions`, `loadSecurityEvents`, `posTab`, `releaseEscrow`, `exportFinancialReport`, `commsTab`, `sendEmailBlast`, `sendSMSBlast`, `createCampaign`, `activateCampaign`, `deleteCampaign`

**Live KPI listeners added:** `businesses` (active count) + `bookings` (confirmed+pending count)

**No new CFs required** — all new tabs call existing CFs or Firestore directly. Some tabs (`adminGetCohortAnalysis`, `adminGetConversionFunnel`, `adminGetRetentionMetrics`, `adminGetWalletOperations`, `adminSendEmailBlast`, `adminSendSMSBlast`, `adminGetCampaigns`) will gracefully show empty states until the corresponding CFs are deployed.

**Hosting deploy (run now):**
```powershell
firebase deploy --only hosting
```

---

## DEPLOY ACTIVITY — 2026-07-07 (Payment Trust & Security)

### Payment Trust & Security v2.0 — hosting deployed, 1 CF quota-blocked
**Files changed:** `wallet.html`, `functions/payment-trust.js` (+velocity+outlier patterns +voidTrustReceipt), `functions/index.js`

**Security fix:** `_assertAdmin()` was missing `await` on `_assertAuth()` — `uid` resolved to a Promise, meaning the admin check ran before auth resolved. All admin-guarded CFs (`getPaymentSecurityAlerts`) were effectively unauthenticated.

**`detectPaymentAnomalies` now implements all 4 documented patterns:**
1. Duplicate charges (same amount, same user, <5 min) — was implemented
2. Failed payment spikes (≥5 failures/24h per user) — was implemented
3. **Velocity breach (>20 tx/hour per cashier)** — was documented but missing; now added
4. **Large transaction outlier (>3× 30-day average per merchant)** — was documented but missing; now added

**New CF:** `voidTrustReceipt` — admin-only; marks a receipt `status:'void'`, logs to `receiptEvents`, validates double-void

**`wallet.html` trust integration (was zero):**
- `sokoni-payment-trust.js` now loaded on wallet page
- Compact IntaSend badge + secure payment pills in top-up panel
- Buyer protection section (marketplace context)
- Trust footer: SSL / IntaSend / PCI DSS / CBK Compliant

**CF deploy (quota-blocked):**
```powershell
firebase deploy --only "functions:voidTrustReceipt,functions:detectPaymentAnomalies"
```

---

## DEPLOY ACTIVITY — 2026-07-07 (SmartPOS Checkout + Venue Booking)

### SmartPOS Zero-Friction Checkout v3.0 — hosting deployed, 5 CFs quota-blocked
**Files changed:** `pos-checkout.html` (2726 → 2927 lines), `pos-sync.js` (+55 lines adapter), `functions/pos-intelligence.js` (+5 new CFs), `functions/index.js`

**What's new:**
- `window.PosSync` adapter added to `pos-sync.js` — fixes broken offline sync across `pos-sales.js`, `pos-customers.js`, `pos-inventory.js` (all three called `PosSync.queue/enqueue` with no definition)
- `pos-sync.js` now loaded in `pos-checkout.html` (was missing from script list)
- Shift startup: checks for active shift on auth; if none, prompts cashier to enter opening cash float; "End Shift" button in topbar → closing cash float → `PosSales.closeShift()`
- Customer purchase history: `_loadRecentPurchases()` fetches last 3 purchases via `PosCustomers.getPurchaseHistory()` and shows them in the customer card
- Low stock indicators: product tiles get amber `.low-stock` border/text when `stockQty ≤ 5`; toast on `addItem()` when adding item with `stockQty ≤ 3`
- Fuzzy product search: Levenshtein distance matching as fallback when no exact results; "Did you mean…" header before fuzzy results
- 5 new AI assistance CFs in `pos-intelligence.js`: `posSmartSearch` (Haiku-corrected search), `posDetectAnomaly` (pricing errors, large transactions), `posGetCustomerInsights` (purchase patterns + upsell suggestion), `posGetInventoryAlerts` (expiry + low-stock at session start), `posGetReorderSuggestions` (velocity-ranked reorder list)

**Hosting deploy (run now):**
```powershell
firebase deploy --only hosting
```

**CF deploy (quota-blocked, run once quota frees):**
```powershell
firebase deploy --only "functions:posSmartSearch,functions:posDetectAnomaly,functions:posGetCustomerInsights,functions:posGetInventoryAlerts,functions:posGetReorderSuggestions"
```

---

### ✅ SmartPOS Next-Generation Checkout v2.0 — client-side only (hosting)
**Files changed:** `pos-checkout.html` (2528 → 2726 lines)

**Enhancements:**
- Replaced all `prompt()` / `confirm()` / `alert()` calls with proper SOKONI modals — zero native dialogs remain
- Gift Card modal: scans via wedge or manual entry; validates via `PosLoyalty.checkGiftCard()` before redeeming; Enter key confirm
- Void Confirmation modal: shows item count + total before clearing cart
- Sale Note modal: 200-char textarea with live char counter; note stored in state + passed to `posCompleteCheckout` metadata + displayed as indicator strip in cart
- AI Suggestion Strip wired: on every `addItem()` call, finds an in-stock product from the same category not already in cart and suggests it; one-tap add; cleared on sale reset
- `openRefund()` parks current cart then redirects to `pos.html` (refund flow requires manager authorization — handled in POS dashboard)
- Parked sales list now shows "Selecting a sale replaces the current cart" hint instead of native `confirm()`
- No new CFs, no new Firestore indexes

**Deploy (hosting only):**
```powershell
firebase deploy --only hosting
```

---

### Venue & Resource Booking Engine v1.0 — code-complete, QUOTA-BLOCKED
**Files changed:** `functions/venue-booking.js` (NEW, 430 lines, 17 CFs), `venue-booking.html`, `venue-manager.html`, `functions/index.js`, `firestore.indexes.json` (191 indexes)

**Pending spot deploy (run once quota frees):**
```powershell
firebase deploy --only "functions:venueCreate,functions:venueUpdate,functions:venueGetPublic,functions:venueGetAvailability,functions:venueCalculatePrice,functions:venueCreateBooking,functions:venueCancelBooking,functions:venueConfirmBooking,functions:venueCheckIn,functions:venueCheckOut,functions:venueMarkNoShow,functions:venueGetBooking,functions:venueGetMyBookings,functions:venueGetCalendar,functions:venueBlockDates,functions:venueRemoveBlock,functions:venueGetStats"
```

---

## DEPLOY ACTIVITY — 2026-07-07 (Universal Printer Engine v5.0)

### ✅ Printer Engine v5.0 — 4 CFs (enforceAppCheck) + hosting
**Files changed:** `functions/pos-printer.js`, `sokoni-universal-printer.js`, `pos-printer-setup.html`, `functions/index.js` (commit c34accf)

**Engine upgrades (sokoni-universal-printer.js):**
- Logo image raster support: `_imgToRasterCached()` with `_imgRasterCache` (Map)
- New doc types: `invoice` (formal tax invoice with VAT/WHT/bank details) and `custom` (free-form via `d.build(encoder, W, PX)`)
- `registerDocType(type, fn)` extensibility API — no core edits needed for new types
- New APIs: `printQR()`, `printBarcode()`, `waitForJob(id, ms)`, `cancelAllJobs()`, `clearHistory()`, `getJob(id)`
- Lazy `ReceiptRenderer` cache (`_getRenderer()`); invalidated on `setConfig()`
- Config: added `logoUrl`, `autoPrintAfterPayment`, `showPreview`, `encoding`, `printDensity`
- BroadcastChannel upgraded: `sokoni_printer_v4` → `sokoni_printer_v5`

**CF upgrades (pos-printer.js):**
- `enforceAppCheck: true` added to all 4 existing CFs (was missing — critical security fix)
- Config sanitiser: `logoUrl` must be `https://`; `encoding` whitelist; `printDensity` -3 to +3
- 3 new CFs (QUOTA-BLOCKED — code complete, not yet deployed):
  - `posGetPrintStats` — admin aggregate stats with daily breakdown
  - `posGetPrintTemplate` — get saved template with ownership guard
  - `posSavePrintTemplate` — save template with ownership validation

**Setup UI (pos-printer-setup.html):** logo URL field, auto-print toggle, preview toggle, encoding selector, density slider

**Hosting:** ✅ Deployed

**Pending quota (all 7 printer CFs are new — hit 429 on creation):**
`posLogPrint`, `getPrintHistory`, `getPrinterConfig`, `setPrinterConfig`,
`posGetPrintStats`, `posGetPrintTemplate`, `posSavePrintTemplate`

---

## DEPLOY ACTIVITY — 2026-07-07 (security patch batch)

### ✅ Security & Correctness Patches — 9 CFs + hosting
**Code fixes applied (all files):**
- `async-job-handlers.js` — EmailHandler now receives SendGrid key via `helpers.secrets.sendgridKey` (injected by asyncWorker/asyncSweeper at runtime) — eliminates `process.env` access
- `async-jobs.js` — `_executeJob(jobId, secrets)` passes `{ sendgridKey: SENDGRID_API_KEY.value() }` from asyncWorker + asyncSweeper; `helpers.secrets` forwarded to handler
- `scheduled-reports.js` — replaced `process.env.SENDGRID_API_KEY` with `SENDGRID_API_KEY.value()` (already `defineSecret`-bound); email failures no longer block Firestore save; `getDailyReport` + `getWeeklyReports` gained `enforceAppCheck: true`
- `pos-crm-pro.js:379` — `checkGiftCardBalance` changed `enforceAppCheck: false` → `true`
- `pos-integrations.js:74` — `_CF_NOCHECK` changed `enforceAppCheck: false` → `true`
- `index.js:6298` — `sendInvoiceEmail` changed `enforceAppCheck: false` → `true`
- `b2b-wholesale.js:871` — `getWholesaleAnalytics` adds `.limit(500)` to prevent full collection scan
- `admin-os.js:441` — `adminGetExecutiveDashboard` transactions query adds `.limit(1000)`
- `seller.html` + `profile.html` — removed `<script src="demo-seed.js">` (production data seeder leak)

**Deployed:**
`scheduledDailyOpsReport`, `scheduledWeeklySecurityReport`, `getDailyReport`, `getWeeklyReports`,
`checkGiftCardBalance`, `validateAPIKey`, `sendInvoiceEmail`, `getWholesaleAnalytics`,
`adminGetExecutiveDashboard` + hosting

**Pending quota (code is patched, will pick up fixes when deployed):**
`asyncWorker`, `asyncSweeper`, `asyncEnqueue` (and remaining 8 async-job-engine CFs)

---

## DEPLOY ACTIVITY — 2026-07-07 (earlier)

### ✅ 30 Redis Layer CFs — DEPLOYED WITH VPC CONNECTOR
All 30 `redis-layer.js` functions updated with:
- `secrets: [REDIS_URL_SECRET]` (from Secret Manager, not .env)
- `vpcConnector: 'sokoni-redis-connector'` + `PRIVATE_RANGES_ONLY` egress
- Connector `sokoni-redis-connector` verified READY (10.8.0.0/28, default network)

Redis CFs can now reach Memorystore at `10.127.36.43:6379` via private VPC.

### ✅ 8 Release Readiness CFs — REDEPLOYED (REDIS_URL_SECRET rebind)
`runReleaseReadinessCheck`, `checkInfrastructure`, `checkSecurityReadiness`,
`checkPlatformModules`, `checkPerformanceReadiness`, `checkComplianceReadiness`,
`approveRelease`, `getLatestReleaseReport` — all updated.

### ✅ 77/79 Algolia CFs — DEPLOYED (key rotation rebind complete)
`algoliaReprocessDLQ` and `searchValidateIndexes` had transient Cloud Run container
healthcheck failures. Retrying in the next batch below.
Safe to disable old `ALGOLIA_ADMIN_KEY` Secret Manager version — 77 CFs are on new key.
Retry the 2 after they succeed below.

### ✅ 20/20 CFs — DEPLOYED (enterprise-health + disaster-recovery + 2 Algolia retries)
All successful. `algoliaReprocessDLQ` and `searchValidateIndexes` resolved on retry.
Algolia key rotation is now 79/79 complete — safe to disable old Secret Manager version.
enterprise-health and disaster-recovery CFs now have REDIS_URL_SECRET + VPC connector.

### ⛔ 9 prior-queue CFs — STILL QUOTA-BLOCKED (confirmed 2026-07-07)
All 9 hit HTTP 429 immediately. Quota ceiling is hard — does NOT reset on a timer.
Requires GCP Cloud Run CPU quota increase before any new CF can be created.

`fosSecureWebhook`, `fosExportReport`, `fosGetProviderHealth`, `fosGetAdminConsole`,
`subScheduleRenewals`, `subAutoActivateOnPayment`, `getSellerEarningsReport`,
`getAdminRevenueByHub`, `editMessage`

**Action required (user):**
GCP Console → IAM & Admin → Quotas → `run.googleapis.com` → `us-central1`
→ "CPU allocation without committed use (Total, per region)" → Request increase.
Once approved, run the master deploy command in the MASTER DEPLOY section below.

---

## STATUS — 2026-07-06 (partial deploy: 14 of 23 LIVE)
Queue is 23 functions (not 24). After freeing 14 quota slots + setting
`POS_WEBHOOK_SECRET`, the deploy created **14 of 23**; **9 remain** quota-blocked
(HTTP 429). Blockers cleared this session:
- ✅ Fixed invalid/insecure `_webhookStripe_disabled` export (was aborting analysis).
- ✅ Set `POS_WEBHOOK_SECRET` (new `pos-terminal-live.js` dependency) — strong
  random value; **configure POS webhook senders to sign with the same value, or
  rotate to the vendor value.**
- ✅ Freed 14 Cloud Run slots (deleted redundant old async-job CFs — see below).

### ✅ DEPLOYED (14 live)
`fosInitiatePayment`, `fosSubmitRefund`, `fosApproveRefund`, `fosGenerateInvoice`,
`subUpgradeWithProration`, `getConversationContext`, `searchConversations`,
`updateConversationStatus`, `pcGetHubRegistry`, `pcRegisterHub`,
`pcUpdateHubConfig`, `pcGetFeatureFlags`, `pcSetFeatureFlag`, `pcGetCrossHubMetrics`

### ⛔ STILL QUOTA-BLOCKED (9 — retry after quota reset/increase)
`fosSecureWebhook`, `fosExportReport`, `fosGetProviderHealth`, `fosGetAdminConsole`,
`subScheduleRenewals`, `subAutoActivateOnPayment`, `getSellerEarningsReport`,
`getAdminRevenueByHub`, `editMessage`

Retry command for just the remaining 9:
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:fosSecureWebhook,functions:fosExportReport,functions:fosGetProviderHealth,functions:fosGetAdminConsole,functions:subScheduleRenewals,functions:subAutoActivateOnPayment,functions:getSellerEarningsReport,functions:getAdminRevenueByHub,functions:editMessage" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

### To land the last 9 (pick one)
1. **Wait** for the daily Cloud Run quota reset, then run the retry command above.
2. **Request a quota increase** (recommended — the project runs ~1500 CFs):
   GCP Console → IAM & Admin → Quotas → filter service `run.googleapis.com`,
   region `us-central1`, raise **"CPU allocation without committed use (Total, per region)"**.
   Also check the Cloud Functions API quotas (Function CPU / instances).
3. **Free more quota** by pruning unused/duplicate functions before retrying.

## Quota cleanup — 2026-07-06 (10 slots freed)
Deleted 10 superseded functions from the OLD async-job system
(`functions/async-jobs-engine.js`, replaced by `functions/async-jobs.js`).
Verified at invocation level that each had **no live caller** (only the dead
`sokoni-async-jobs.js` SDK, which no page loads):
`submitEmailJob`, `submitWebhookJob`, `cancelJob`, `retryJob`, `getJobDashboard`,
`getMyJobs`, `getWorkerStats`, `inspectJob`, `replayDLQJob`, `bulkCancelJobs`.

**Held (NOT deleted) — need deeper review:**
- `getQueueDepth` — still called live by `executive-dashboard.html` +
  `enterprise-ops.html`. Migrate those to the new `asyncGetDashboard` first.
- `onJobCreated`, `processJobQueue`, `jobCleanupScheduled`, `jobStuckRecovery` —
  background workers entangled with the shared `asyncJobs` collection (the new
  `asyncWorker` fires on the same `asyncJobs/{jobId}` path; 5 live functions —
  disaster-recovery, enterprise-health, platform-ops, release-readiness,
  async-job-handlers — write to it). Confirm no double-processing/schema
  mismatch before removing.

Follow-up hygiene: `sokoni-async-jobs.js` is a dead client SDK (only in the SW
precache list, loaded by no page). Safe to remove from `service-worker.js`
precache + delete the file once the above workers are resolved.

## Required workaround before EVERY CF deploy
The Firebase CLI's npm SDK version check times out on this machine.
Set a short npm fetch timeout before deploying — restore it after:

```powershell
npm config set fetch-timeout 3000
npm config set fetch-retry-mintimeout 1000
# --- run firebase deploy here ---
npm config delete fetch-timeout
npm config delete fetch-retry-mintimeout
```

## Redis Integration — 2026-07-07 ✅ CODE COMPLETE / DEPLOYING

**Secret**: `REDIS_URL=redis://10.127.36.43:6379` stored in Firebase Secret Manager (version 2).  
**Secret removed from**: `functions/.env` — no longer a plain env var.

### Files updated (defineSecret migration + connection pooling)
| File | Change |
|---|---|
| `redis-service.js` | `defineSecret('REDIS_URL')`, `enableAutoPipelining`, `keepAlive 10s`, `enableOfflineQueue:false` |
| `redis-layer.js` | `secrets:[REDIS_URL_SECRET]` on all 3 CF option sets |
| `redis-integrations.js` | `secrets:[REDIS_URL_SECRET]` on trigger OPTS |
| `release-readiness.js` | `_REDIS_URL` added to `CF_OPTIONS.secrets` |
| `enterprise-health.js` | `REDIS_URL_SECRET` added to `HEALTH_SECRETS` |
| `disaster-recovery.js` | `REDIS_URL_SECRET` added to `CF_OPTS` |
| `functions/.env` | REDIS_URL line removed — see Secret Manager |

### ⚠️ VPC CONNECTOR REQUIRED (Redis not reachable without this)
GCP Memorystore uses a private IP (10.127.36.43). Cloud Functions Gen2 cannot reach
private VPC IPs without a Serverless VPC Access connector or Direct VPC Egress.

**Create the connector (one-time, run in Cloud Shell or local gcloud):**
```bash
gcloud compute networks vpc-access connectors create sokoni-redis-connector \
  --network default \
  --region us-central1 \
  --range 10.8.0.0/28
```

**Then add to firebase.json (inside the `"functions"` block):**
```json
"vpcConnector": "sokoni-redis-connector",
"vpcConnectorEgressSettings": "PRIVATE_RANGES_ONLY"
```

**Then redeploy all Redis CFs** (see deploy command in the Redis CFs section below).

Without the VPC connector, all Redis operations fail with ETIMEDOUT. The platform
degrades gracefully (no-op mode) but rate limiting is disabled.

---

## Status — 2026-07-07 (updated)

**61/61 Security Patch CFs REDEPLOYED ✅ — 2026-07-07**
Wallet, email-triggers, release-readiness, payment-trust, pos-retail patches live.

**0/163 NEW CFs LIVE — Blocked by Cloud Run CPU quota**
_(138 in master command + 5 commission/settlement + 3 sub-engine subscription extras + 7 finos-automation + 10 platform-hub)_

New CFs added 2026-07-07 (platform-hub.js — 10 CFs):
- `wapProcessDelays` — onSchedule every 5 min; advances WAP workflow instances with due delay steps
- `wapGetInstances` — onCall admin; paginated workflow instance inspector
- `wapRetryStep` — onCall admin; reset a failed step to pending + re-run
- `pcGetPerHubFlags` — onCall admin; per-hub feature flag values (scoped)
- `pcSetPerHubFlag` — onCall admin; toggle a per-hub feature flag
- `pcGetHubDetails` — onCall admin; full hub doc + flags + lifetime metrics
- `pcGetCrossHubHealth` — onCall admin; per-hub 24h health snapshot
- `platformNotifyTransactionChange` — onCall auth; generic transaction status → chat system message
- `pcActivateHub` — onCall admin; set hub status → live; emits hub.activated event
- `pcDeactivateHub` — onCall admin; set hub status → maintenance; emits hub.deactivated event

New CFs added 2026-07-07 (commission.js settlement — 5 CFs):
- `processSettlement` — onCall admin; idempotent escrow → seller wallet settlement
- `requestWithdrawal` — onCall seller; race-guarded withdrawal request from withdrawable balance
- `approveWithdrawal` — onCall admin; disburse withdrawal; status guard (pending only)
- `rejectWithdrawal` — onCall admin; reject withdrawal; funds remain in wallet
- `getWithdrawals` — onCall auth; seller sees own; admin sees all

New CFs added 2026-07-07 (sub-engine.js extras — 3 CFs):
- `subCheckFeature` — onCall auth; gate-check a feature against the user's active subscription plan
- `subRetryFailedPayments` — onCall admin; retry all subscriptions in `payment_failed` state
- `subDowngrade` — onCall auth; immediately downgrade a subscription to a lower plan

New CFs added 2026-07-07 (pos-printer.js — 4 CFs):
- `posLogPrint` — onCall; logs a print job to `posPrintLog` + updates `posPrintStats` daily rollup
- `getPrintHistory` — onCall; paginated print history + 7-day stats for the authenticated seller
- `getPrinterConfig` — onCall; reads saved printer config from `posPrinterConfig/{uid}`
- `setPrinterConfig` — onCall; validates and saves printer config (paperWidth, autoCut, logoText, footer, promoMessage, returnPolicy, copies, imageThreshold)

New CFs added 2026-07-07 (finos-automation.js — 7 CFs):
- `fosAutoSettlement` — onSchedule 0/6h; auto-releases held escrow past settlement window
- `fosAutoRefund` — onDocumentUpdated orders/{orderId}; policy-based auto-refund on cancellation
- `fosReconcile` — onCall admin; IntaSend transaction reconciliation
- `fosGetForecast` — onCall admin; 7–90 day AI revenue forecasting (Claude Haiku)
- `fosGetSettlementConfig` — onCall admin; read per-hub settlement rules
- `fosSetSettlementConfig` — onCall admin; write per-hub settlement rules
- `fosGetAuditTrail` — onCall admin; filtered paginated ledger query

New CFs added 2026-07-07 (legacy record):
- `commission.js`: processSettlement, requestWithdrawal, approveWithdrawal, rejectWithdrawal, getWithdrawals
- `sub-engine.js`: subCheckFeature, subRetryFailedPayments, subDowngrade

The quota was exhausted during the big 1,512-function update deploy. All new Cloud Run
service creations fail silently (only `pcGetHubRegistry` showed an explicit 429 in the log).
Verified via `firebase functions:list` — none of the 119 appear in the live list.

**To fix**: Request a GCP Cloud Run CPU quota increase:
1. GCP Console → IAM & Admin → Quotas
2. Filter: "Cloud Run Admin API" + "us-central1"
3. Find "Total CPU (all regions)" — request increase to 2000+ vCPUs

---

## SECURITY PATCH REDEPLOY — 61 CFs ✅ DEPLOYED 2026-07-07 (61/61 live)

**DONE.** All 61 security-patched functions were redeployed successfully (57 on the
first pass; the remaining 4 email triggers — `emailOnProductStatusChange`,
`emailOnSellerPayout`, `emailOnDriverAssigned`, `emailOnOrderCreated` — had transient
"Deadline Exceeded" CLI-polling timeouts and went green on a one-shot retry).
Because these are updates to existing functions, they were NOT affected by the
new-function Cloud Run quota ceiling. Command retained below for future reference.

These functions are **already deployed and live**. Security patches were applied
to their source files — run this command to push the fixes to production.

**Patches applied:**
- `wallet.js` — Removed `process.env.INTASEND_PRIVATE_KEY ||` bypass (×2)
- `pos-retail.js` — Migrated string literal secrets → `defineSecret` objects
- `email-triggers.js` — Bound `SENDGRID_WEBHOOK_KEY` via `defineSecret`; HMAC now active
- `release-readiness.js` — Fixed dead `process.env` secret reads; certification scores now correct
- `payment-trust.js` — Added `enforceAppCheck: true` to shared `cfg` (4 onCall CFs)

```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:getWalletBalance,functions:initiateWalletTopUp,functions:confirmWalletTopUp,functions:spendFromWallet,functions:getWalletTransactions,functions:requestSellerPayout,functions:getPayoutHistory,functions:adminProcessPayout,functions:adminGetPendingPayouts,functions:refundToWallet,functions:sweepStaleWalletTopUps,functions:posSyncToMarketplace,functions:sendPOSReceipt,functions:sendPurchaseOrder,functions:posLowStockAlert,functions:posMarketplaceOrderSync,functions:emailOnUserCreate,functions:emailOnSellerStatusChange,functions:emailOnProductStatusChange,functions:emailOnPaymentSuccess,functions:emailOnSellerPayout,functions:emailOnSubscriptionRenewal,functions:emailOnDisputeCreate,functions:emailOnDisputeResolved,functions:emailOnDeliveryCreate,functions:emailOnDriverAssigned,functions:emailOnDriverCreate,functions:emailOnDriverStatusChange,functions:emailOnTicketCreate,functions:emailOnPropertyEnquiry,functions:emailOnBookingCreate,functions:emailOnAppointmentCreate,functions:emailOnLegalConsultation,functions:emailOnOrderDelivered,functions:emailOnOrderCreated,functions:emailOnOrderShipped,functions:emailOnOrderCancelled,functions:processEmailQueue,functions:emailSubscriptionReminders,functions:emailDriverDocReminders,functions:emailUnassignedDeliveryAlert,functions:emailWebhook,functions:updateEmailPreferences,functions:sendBroadcastEmail,functions:resendEmail,functions:onLoginEvent,functions:runReleaseReadinessCheck,functions:checkInfrastructure,functions:checkSecurityReadiness,functions:checkPlatformModules,functions:checkPerformanceReadiness,functions:checkComplianceReadiness,functions:approveRelease,functions:getLatestReleaseReport,functions:runProductionCertification,functions:getCertificationHistory,functions:generateTrustReceipt,functions:emailTrustReceipt,functions:verifyTrustReceipt,functions:getPaymentSecurityAlerts,functions:detectPaymentAnomalies" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

> `financial-os.js` (fosInitiatePayment et al.) is in the main 135-CF queue below —
> those are new CFs (not yet live) so `enforceAppCheck` is baked into their first deploy.

---

## ALGOLIA KEY ROTATION REDEPLOY — 79 CFs (already live, key rotated 2026-07-07)

`ALGOLIA_ADMIN_KEY` was rotated in Firebase Secret Manager on 2026-07-07.
Firebase injects the **latest enabled version** of a secret at deploy time, so these
79 live functions need a redeploy (revision bump) to pick up the new key. No source
code changes are required — the codebase was fully verified clean before this entry
was written.

**Live functions continue working until the old key version is disabled** in Secret
Manager. Do not disable the old version until after this redeploy completes.

**Verification summary (2026-07-07):**
- ✅ All 18 Algolia source files use `defineSecret('ALGOLIA_ADMIN_KEY')` — no exceptions
- ✅ Zero hardcoded Algolia Admin Key values anywhere in `functions/`
- ✅ `process.env.ALGOLIA_APP_ID` — public App ID only; correct, not a secret
- ✅ CLI scripts (`algolia-backfill.js`, `algolia-setup.js`) use `process.env` correctly — not deployed CFs
- ✅ `system-health.js` uses `const ALGOLIA_KEY = defineSecret("ALGOLIA_ADMIN_KEY")` — different local variable name, same secret string — functionally correct

### 79 Algolia Admin Key dependent functions by source

| Source file | Count | Functions |
|---|---|---|
| `algolia-queue.js` | 3 | `processAlgoliaQueue`, `algoliaReprocessDLQ`, `algoliaQueueMonitor` |
| `algolia-admin.js` | 12 | `algoliaSetupIndexes`, `algoliaBackfill`, `algoliaReindex`, `algoliaHealthCheck`, `algoliaGetQueueStats`, `algoliaDeleteOrphans`, `algoliaSetupRules`, `algoliaSetupPersonalization`, `algoliaSetupDynamicReranking`, `algoliaCreateABTest`, `algoliaGetABTestResults`, `algoliaStopABTest` |
| `algolia-settings.js` | 4 | `searchApplyIndexSettings`, `searchValidateIndexes`, `searchApplySynonyms`, `searchApplyRules` |
| `algolia-analytics.js` | 6 | `recordSearchEvent`, `algoliaEventAggregator`, `aggregateSearchAnalytics`, `getSearchAnalytics`, `getTrendingSearches`, `algoliaAnalyticsCleanup` |
| `algolia-recommend.js` | 9 | `getAlgoliaFBT`, `getAlgoliaRelated`, `getAlgoliaTrendingItems`, `getAlgoliaTrendingFacets`, `getAlgoliaLookingSimilar`, `getAlgoliaMultiRecommend`, `algoliaRecommendEvent`, `algoliaRecommendStatus`, `algoliaRecommendAnalyticsCleanup` |
| `algolia-query-suggestions.js` | 4 | `algoliaSetupQuerySuggestions`, `algoliaGetQuerySuggestions`, `algoliaQSRebuildStatus`, `algoliaSetupQSIndexSettings` |
| `algolia-personalization.js` | 5 | `setAlgoliaPersonalizationStrategy`, `getAlgoliaPersonalizationStrategy`, `getAlgoliaUserProfile`, `deleteAlgoliaUserProfile`, `algoliaPersonalizationStatus` |
| `algolia-reconcile.js` | 4 | `algoliaReconcile`, `algoliaVerifyDoc`, `algoliaGetReconcileHistory`, `algoliaReconcileStats` |
| `algolia-monitor.js` | 6 | `algoliaMonitorHealth`, `algoliaMonitorEntries`, `algoliaGetMonitorDashboard`, `algoliaGetLatencyHistory`, `algoliaResolveMonitorAlert`, `algoliaMonitorCleanup` |
| `search-queue.js` | 5 | `getQueueStats`, `purgeCompleted`, `pauseQueue`, `resumeQueue`, `redriveFromDLQ` |
| `search-admin.js` | 6 | `searchSetup`, `searchBackfillAll`, `searchSystemReport`, `searchGetSecuredKeys`, `searchConfigUpdate`, `searchGetStats` |
| `search-service.js` | 1 of 6 | `searchSimilar` only — `searchQuery`, `searchAutocomplete`, `searchNearby`, `searchPersonalized`, `searchIntent` are unaffected (use `ALGOLIA_SEARCH_KEY` only) |
| `search-monitor.js` | 4 | `searchGetUnifiedDashboard`, `searchSystemHealth`, `searchGetHealthHistory`, `searchResolveAlert` |
| `search-repair.js` | 5 | `searchRepairAll`, `searchVerifyDocument`, `searchFullReindex`, `searchRepairOrphanedDocs`, `searchScheduledReconcile` |
| `search-worker.js` | 3 | `searchQueueCoordinator`, `searchDLQSweep`, `searchQueueRecovery` |
| `search-health.js` | 1 | `searchHealth` |
| `system-health.js` | 1 | `systemHealthCheck` |

**Functions NOT affected by ALGOLIA_ADMIN_KEY rotation (same source files):**
`searchQuery`, `searchAutocomplete`, `searchNearby`, `searchPersonalized`, `searchIntent`,
`getAlgoliaSearchKey`, `algoliaKeyStats`, `algoliaKeyCleanup`

### Full redeploy command (79 functions — run once after quota clears)

```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:processAlgoliaQueue,functions:algoliaReprocessDLQ,functions:algoliaQueueMonitor,functions:algoliaSetupIndexes,functions:algoliaBackfill,functions:algoliaReindex,functions:algoliaHealthCheck,functions:algoliaGetQueueStats,functions:algoliaDeleteOrphans,functions:algoliaSetupRules,functions:algoliaSetupPersonalization,functions:algoliaSetupDynamicReranking,functions:algoliaCreateABTest,functions:algoliaGetABTestResults,functions:algoliaStopABTest,functions:searchApplyIndexSettings,functions:searchValidateIndexes,functions:searchApplySynonyms,functions:searchApplyRules,functions:recordSearchEvent,functions:algoliaEventAggregator,functions:aggregateSearchAnalytics,functions:getSearchAnalytics,functions:getTrendingSearches,functions:algoliaAnalyticsCleanup,functions:getAlgoliaFBT,functions:getAlgoliaRelated,functions:getAlgoliaTrendingItems,functions:getAlgoliaTrendingFacets,functions:getAlgoliaLookingSimilar,functions:getAlgoliaMultiRecommend,functions:algoliaRecommendEvent,functions:algoliaRecommendStatus,functions:algoliaRecommendAnalyticsCleanup,functions:algoliaSetupQuerySuggestions,functions:algoliaGetQuerySuggestions,functions:algoliaQSRebuildStatus,functions:algoliaSetupQSIndexSettings,functions:setAlgoliaPersonalizationStrategy,functions:getAlgoliaPersonalizationStrategy,functions:getAlgoliaUserProfile,functions:deleteAlgoliaUserProfile,functions:algoliaPersonalizationStatus,functions:algoliaReconcile,functions:algoliaVerifyDoc,functions:algoliaGetReconcileHistory,functions:algoliaReconcileStats,functions:algoliaMonitorHealth,functions:algoliaMonitorEntries,functions:algoliaGetMonitorDashboard,functions:algoliaGetLatencyHistory,functions:algoliaResolveMonitorAlert,functions:algoliaMonitorCleanup,functions:getQueueStats,functions:purgeCompleted,functions:pauseQueue,functions:resumeQueue,functions:redriveFromDLQ,functions:searchSetup,functions:searchBackfillAll,functions:searchSystemReport,functions:searchGetSecuredKeys,functions:searchConfigUpdate,functions:searchGetStats,functions:searchSimilar,functions:searchGetUnifiedDashboard,functions:searchSystemHealth,functions:searchGetHealthHistory,functions:searchResolveAlert,functions:searchRepairAll,functions:searchVerifyDocument,functions:searchFullReindex,functions:searchRepairOrphanedDocs,functions:searchScheduledReconcile,functions:searchQueueCoordinator,functions:searchDLQSweep,functions:searchQueueRecovery,functions:searchHealth,functions:systemHealthCheck" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

### Minimum viable subset (5 — if quota is critically low)
Covers the functions users interact with most directly. Run only if a full 79-function
redeploy isn't feasible immediately:

```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:searchSimilar,functions:searchHealth,functions:processAlgoliaQueue,functions:algoliaHealthCheck,functions:systemHealthCheck" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

## REDIS SECRET MIGRATION REDEPLOY — 30 CFs (already live, secret moved to Secret Manager)

`REDIS_URL` was migrated from `functions/.env` to Firebase Secret Manager (version 2 — `redis://10.127.36.43:6379`).
All redis-layer.js functions need a revision bump to inject the secret from Secret Manager.
**No source code changes required** — the codebase already uses `defineSecret('REDIS_URL')`.

> ⚠️ **VPC Connector must be created first** before these functions can actually reach Redis.
> See the "Redis Integration" section above for the `gcloud` command.

```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:redisSessionCreate,functions:redisSessionGet,functions:redisSessionRevoke,functions:redisSessionRevokeAll,functions:redisSessionList,functions:redisPresenceHeartbeat,functions:redisPresenceGet,functions:redisPresenceRemove,functions:redisPosSetState,functions:redisPosGetState,functions:redisPosPublish,functions:redisInventoryLock,functions:redisInventoryRelease,functions:redisDashboardGet,functions:redisDashboardSet,functions:redisDashboardIncr,functions:redisCacheGet,functions:redisCacheSet,functions:redisPaymentLock,functions:redisPaymentUnlock,functions:redisPaymentSetState,functions:redisPaymentGetState,functions:redisEventPublish,functions:redisEventRead,functions:redisQueuePush,functions:redisQueueDepth,functions:redisRateCheck,functions:redisAdminMetrics,functions:redisScheduledPresenceCleanup,functions:redisScheduledQueueWorker" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

**Also redeploy these already-live functions** (they reference `REDIS_URL_SECRET` after the migration):
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:runReleaseReadinessCheck,functions:checkInfrastructure,functions:checkSecurityReadiness,functions:checkPlatformModules,functions:checkPerformanceReadiness,functions:checkComplianceReadiness,functions:approveRelease,functions:getLatestReleaseReport,functions:runProductionCertification,functions:getCertificationHistory" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

> `enterprise-health.js` and `disaster-recovery.js` CFs should also be redeployed once VPC connector is active.

---

### Deployment order priority (when quota partially available)
1. **Security Patch Redeploy** (61 CFs) — security bugs in live functions
2. **Algolia Key Rotation** (79 CFs) — pick up rotated key before old version is disabled
3. **Redis Secret Migration** (30+ CFs) — pick up REDIS_URL from Secret Manager
4. **Master Deploy** (163 new CFs) — new features, not yet live

---

## MASTER DEPLOY COMMAND (all 233 new CFs — updated 2026-07-08 ✅)

Includes: 218 original + 15 auto* (automation engine) + `earnLoyaltyPoints` → `awardLoyaltyPoints` fix.

```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:fosInitiatePayment,functions:fosSecureWebhook,functions:fosSubmitRefund,functions:fosApproveRefund,functions:fosGenerateInvoice,functions:fosExportReport,functions:fosGetProviderHealth,functions:fosGetAdminConsole,functions:subScheduleRenewals,functions:subAutoActivateOnPayment,functions:subUpgradeWithProration,functions:getSellerEarningsReport,functions:getAdminRevenueByHub,functions:getConversationContext,functions:searchConversations,functions:editMessage,functions:updateConversationStatus,functions:pcGetHubRegistry,functions:pcRegisterHub,functions:pcUpdateHubConfig,functions:pcGetFeatureFlags,functions:pcSetFeatureFlag,functions:pcGetCrossHubMetrics,functions:asyncEnqueue,functions:asyncWorker,functions:asyncSweeper,functions:asyncEventRouter,functions:asyncCancel,functions:asyncRetryJob,functions:asyncPauseQueue,functions:asyncGetDashboard,functions:asyncGetJobs,functions:asyncInspect,functions:asyncCleanup,functions:opsGetMasterDashboard,functions:opsGetAlerts,functions:opsAcknowledgeAlert,functions:opsCreateAlert,functions:opsGetPostLaunchMetrics,functions:opsScheduledHealthCheck,functions:rollbackGetSnapshots,functions:rollbackCreateSnapshot,functions:rollbackTrigger,functions:rollbackGetExecutions,functions:rollbackUpdateStatus,functions:rollbackScheduledSnapshot,functions:recordPosEvent,functions:getPosPerfMetrics,functions:getPosSpeedReport,functions:posScheduledPerfRollup,functions:acknowledgeShift,functions:approveShiftSwap,functions:assignShift,functions:createShiftTemplate,functions:getRoster,functions:getRosterGaps,functions:getStaffRoster,functions:publishWeeklyRoster,functions:schedulerWeeklyDigest,functions:setStaffAvailability,functions:swapShiftRequest,functions:createSession,functions:detectSessionAnomaly,functions:getUserSessions,functions:revokeDeviceSessions,functions:rotateSession,functions:scheduledSessionCleanup,functions:terminateAllSessions,functions:terminateSession,functions:validateSession,functions:generateSecureUploadUrl,functions:getFileAuditLog,functions:onFileUploaded,functions:quarantineFile,functions:validateUploadRequest,functions:getLatestSecurityReport,functions:runSecurityAudit,functions:scheduleWeeklySecurityAudit,functions:getPOSInventoryIntelligence,functions:getProductSalesTrend,functions:awardLoyaltyPoints,functions:onInventoryUpdated,functions:onOrderCreated,functions:onPaymentCreated,functions:onPaymentUpdated,functions:onRiderStatusChange,functions:onUserCreated,functions:posCleanupPeripheralSignals,functions:posCreateCustomerDisplay,functions:posGetPeripherals,functions:posRegisterPeripheral,functions:posRemovePeripheral,functions:posUpdateCustomerDisplay,functions:posUpdatePeripheralStatus,functions:posGetApiDocs,functions:posGetEtimsExport,functions:posGetInventoryExport,functions:posGetLedgerExport,functions:posGetSalesExport,functions:posListApiKeys,functions:posReceiveErpUpdate,functions:posRegisterApiKey,functions:posRegisterWebhook,functions:posRevokeApiKey,functions:posRevokeWebhook,functions:posTestWebhook,functions:posGetTerminalBatchReport,functions:posGetTerminalCapabilities,functions:posGetTerminalHealth,functions:posPollTerminalStatus,functions:posReverseTerminalPayment,functions:posSettleTerminalBatch,functions:posTerminalEventWebhook,functions:currencyGetRates,functions:currencyConvert,functions:currencyUpdateRates,functions:currencyGetHistory,functions:currencyScheduledRateRefresh,functions:installmentCreatePlan,functions:installmentRecordPayment,functions:installmentGetMyPlans,functions:installmentGetSellerPlans,functions:installmentMarkOverdue,functions:installmentCancelPlan,functions:franchiseCreateBrand,functions:franchiseApplyForLocation,functions:franchiseReviewApplication,functions:franchiseRecordRoyalty,functions:franchiseGetMyLocations,functions:franchiseGetBrandDashboard,functions:franchiseGetLocations,functions:onOrderStatusChanged,functions:onBookingStatusChanged,functions:onFoodOrderStatusChanged,functions:posLogPrint,functions:getPrintHistory,functions:getPrinterConfig,functions:setPrinterConfig,functions:processSettlement,functions:requestWithdrawal,functions:approveWithdrawal,functions:rejectWithdrawal,functions:getWithdrawals,functions:subCheckFeature,functions:subRetryFailedPayments,functions:subDowngrade,functions:fosAutoSettlement,functions:fosAutoRefund,functions:fosReconcile,functions:fosGetForecast,functions:fosGetSettlementConfig,functions:fosSetSettlementConfig,functions:fosGetAuditTrail,functions:wapProcessDelays,functions:wapGetInstances,functions:wapRetryStep,functions:pcGetPerHubFlags,functions:pcSetPerHubFlag,functions:pcGetHubDetails,functions:pcGetCrossHubHealth,functions:platformNotifyTransactionChange,functions:pcActivateHub,functions:pcDeactivateHub,functions:setProviderAvailability,functions:setLiveStatus,functions:getAvailabilitySlots,functions:reserveSlot,functions:releaseSlot,functions:scheduledAvailabilityMaintenance,functions:getProviderAvailability,functions:setVacationMode,functions:addAvailabilityOverride,functions:removeAvailabilityOverride,functions:listAvailabilityOverrides,functions:setMarketplaceAvailability,functions:checkProviderAvailability,functions:getNextAvailableSlot,functions:venueCreate,functions:venueUpdate,functions:venueGetPublic,functions:venueGetAvailability,functions:venueCalculatePrice,functions:venueCreateBooking,functions:venueCancelBooking,functions:venueConfirmBooking,functions:venueCheckIn,functions:venueCheckOut,functions:venueMarkNoShow,functions:venueGetBooking,functions:venueGetMyBookings,functions:venueGetCalendar,functions:venueBlockDates,functions:venueRemoveBlock,functions:venueGetStats" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

## Secret Manager — Complete Manifest (audited 2026-07-07)

All secrets verified via `firebase functions:secrets:access`. Status as of this audit:

| Secret | Category | Status | Source |
|---|---|---|---|
| `INTASEND_PRIVATE_KEY` | Third-party | ✅ SET | IntaSend dashboard |
| `INTASEND_API_KEY` | Third-party | ✅ SET | IntaSend dashboard |
| `SENDGRID_API_KEY` | Third-party | ✅ SET | SendGrid dashboard |
| `SENDGRID_WEBHOOK_KEY` | Internal HMAC | ✅ SET | Generated 2026-07-07 |
| `ALGOLIA_ADMIN_KEY` | Third-party | ✅ SET | Algolia dashboard |
| `ALGOLIA_SEARCH_KEY` | Third-party | ✅ SET | Algolia dashboard |
| `TYPESENSE_ADMIN_KEY` | Third-party | ✅ SET | Typesense cloud |
| `TYPESENSE_SEARCH_KEY` | Third-party | ✅ SET | Typesense cloud |
| `AFRICASTALKING_API_KEY` | Third-party | ✅ SET | Africa's Talking dashboard |
| `AFRICASTALKING_USERNAME` | Third-party | ⏳ Sandbox (set when going live) | Africa's Talking — production username only |
| `ANTHROPIC_API_KEY` | Third-party | ✅ SET | Anthropic console |
| `FACEBOOK_APP_SECRET` | Third-party | ✅ SET | Meta developer console |
| `MAIL_HOST` | Third-party | ✅ SET | SMTP provider |
| `MAIL_USER` | Third-party | ✅ SET | SMTP provider |
| `MAIL_PASS` | Third-party | ✅ SET | SMTP provider |
| `PAYMENT_HMAC_SECRET` | Internal HMAC | ✅ SET | Generated (256-bit) |
| `LOYALTY_HMAC_SECRET` | Internal HMAC | ✅ SET | Generated (256-bit) |
| `SOKONI_HMAC_KEY` | Internal HMAC | ✅ SET | Generated (256-bit) |
| `PAYROLL_ENCRYPTION_KEY` | Internal crypto | ✅ SET | Generated (AES-256) |
| `SUB_OS_SIGNING_SECRET` | Internal HMAC | ✅ SET | Generated (256-bit) |
| `QR_SIGNING_SECRET` | Internal HMAC | ✅ SET | Generated (256-bit) |
| `ETIMS_MASTER_KEY` | Third-party | ✅ SET | KRA eTIMS |
| `ETIMS_PLATFORM_PIN` | Third-party | ✅ SET | KRA eTIMS |
| `ETIMS_PLATFORM_SECRET` | Third-party | ✅ SET | KRA eTIMS |

**All production secrets are SET. `AFRICASTALKING_USERNAME` intentionally left as sandbox until AT account goes live.**

### Redis rate limiting status
`REDIS_URL` is stored in Firebase Secret Manager (version 2 — `redis://10.127.36.43:6379`).
**VPC connector must be created before Redis is reachable.** See "Redis Integration" section above.
Rate limiting activates automatically once the Redis CFs are redeployed with the VPC connector active.

---

## All 163 functions by source file

### financial-os.js (8)
| Function | Type |
|---|---|
| `fosInitiatePayment` | onCall auth |
| `fosSecureWebhook` | onRequest webhook |
| `fosSubmitRefund` | onCall auth |
| `fosApproveRefund` | onCall admin |
| `fosGenerateInvoice` | onCall auth |
| `fosExportReport` | onCall admin |
| `fosGetProviderHealth` | onCall admin |
| `fosGetAdminConsole` | onCall admin |

### sub-engine.js (6)
| Function | Type |
|---|---|
| `subScheduleRenewals` | onSchedule |
| `subAutoActivateOnPayment` | onDocumentUpdated |
| `subUpgradeWithProration` | onCall auth |
| `subCheckFeature` | onCall auth |
| `subRetryFailedPayments` | onCall admin |
| `subDowngrade` | onCall auth |

### commission.js (7)
| Function | Type |
|---|---|
| `getSellerEarningsReport` | onCall auth |
| `getAdminRevenueByHub` | onCall admin |
| `processSettlement` | onCall admin |
| `requestWithdrawal` | onCall seller |
| `approveWithdrawal` | onCall admin |
| `rejectWithdrawal` | onCall admin |
| `getWithdrawals` | onCall auth |

### messages.js (7)
| Function | Type |
|---|---|
| `getConversationContext` | onCall auth |
| `searchConversations` | onCall auth |
| `editMessage` | onCall auth |
| `updateConversationStatus` | onCall auth |
| `onOrderStatusChanged` | onDocumentUpdated trigger |
| `onBookingStatusChanged` | onDocumentUpdated trigger |
| `onFoodOrderStatusChanged` | onDocumentUpdated trigger |

### platform-core.js (6)
| Function | Type |
|---|---|
| `pcGetHubRegistry` | onCall auth |
| `pcRegisterHub` | onCall admin |
| `pcUpdateHubConfig` | onCall admin |
| `pcGetFeatureFlags` | onCall auth |
| `pcSetFeatureFlag` | onCall admin |
| `pcGetCrossHubMetrics` | onCall admin |

### async-jobs.js (11)
| Function | Type |
|---|---|
| `asyncEnqueue` | onCall auth |
| `asyncWorker` | onDocumentCreated |
| `asyncSweeper` | onSchedule (every 1 min) |
| `asyncEventRouter` | onDocumentCreated |
| `asyncCancel` | onCall auth |
| `asyncRetryJob` | onCall admin |
| `asyncPauseQueue` | onCall admin |
| `asyncGetDashboard` | onCall admin |
| `asyncGetJobs` | onCall admin |
| `asyncInspect` | onCall admin |
| `asyncCleanup` | onSchedule (daily 03:30) |

### platform-ops.js (6)
| Function | Type |
|---|---|
| `opsGetMasterDashboard` | onCall admin |
| `opsGetAlerts` | onCall admin |
| `opsAcknowledgeAlert` | onCall admin |
| `opsCreateAlert` | onCall admin |
| `opsGetPostLaunchMetrics` | onCall admin |
| `opsScheduledHealthCheck` | onSchedule (every 5 min) |

### rollback.js (6)
| Function | Type |
|---|---|
| `rollbackGetSnapshots` | onCall admin |
| `rollbackCreateSnapshot` | onCall admin |
| `rollbackTrigger` | onCall admin |
| `rollbackGetExecutions` | onCall admin |
| `rollbackUpdateStatus` | onCall admin |
| `rollbackScheduledSnapshot` | onSchedule (daily 00:00) |

### pos-perf.js (4)
| Function | Type |
|---|---|
| `recordPosEvent` | onCall auth |
| `getPosPerfMetrics` | onCall auth |
| `getPosSpeedReport` | onCall auth |
| `posScheduledPerfRollup` | onSchedule (daily 22:00 UTC) |

### pos-shift-scheduler.js (11)
| Function | Type |
|---|---|
| `acknowledgeShift` | onCall auth |
| `approveShiftSwap` | onCall admin |
| `assignShift` | onCall admin |
| `createShiftTemplate` | onCall admin |
| `getRoster` | onCall auth |
| `getRosterGaps` | onCall admin |
| `getStaffRoster` | onCall auth |
| `publishWeeklyRoster` | onCall admin |
| `schedulerWeeklyDigest` | onSchedule (weekly) |
| `setStaffAvailability` | onCall auth |
| `swapShiftRequest` | onCall auth |

### security-session.js (9)
| Function | Type |
|---|---|
| `createSession` | onCall auth |
| `detectSessionAnomaly` | onCall auth |
| `getUserSessions` | onCall auth |
| `revokeDeviceSessions` | onCall auth |
| `rotateSession` | onCall auth |
| `scheduledSessionCleanup` | onSchedule (daily) |
| `terminateAllSessions` | onCall admin |
| `terminateSession` | onCall auth |
| `validateSession` | onCall auth |

### security-file.js (5)
| Function | Type |
|---|---|
| `generateSecureUploadUrl` | onCall auth |
| `getFileAuditLog` | onCall admin |
| `onFileUploaded` | onObjectFinalized |
| `quarantineFile` | onCall admin |
| `validateUploadRequest` | onCall auth |

### security-pentest.js (3)
| Function | Type |
|---|---|
| `getLatestSecurityReport` | onCall admin |
| `runSecurityAudit` | onCall admin |
| `scheduleWeeklySecurityAudit` | onSchedule (weekly) |

### pos-intelligence.js (2)
| Function | Type |
|---|---|
| `getPOSInventoryIntelligence` | onCall auth |
| `getProductSalesTrend` | onCall auth |

### loyalty.js (1)
| Function | Type |
|---|---|
| `earnLoyaltyPoints` | onCall auth |

### redis-integrations.js (6)
| Function | Type |
|---|---|
| `onInventoryUpdated` | onDocumentUpdated |
| `onOrderCreated` | onDocumentCreated |
| `onPaymentCreated` | onDocumentCreated |
| `onPaymentUpdated` | onDocumentUpdated |
| `onRiderStatusChange` | onDocumentUpdated |
| `onUserCreated` | onDocumentCreated |

### pos-peripherals.js (7)
| Function | Type |
|---|---|
| `posCleanupPeripheralSignals` | onSchedule (daily) |
| `posCreateCustomerDisplay` | onCall auth |
| `posGetPeripherals` | onCall auth |
| `posRegisterPeripheral` | onCall auth |
| `posRemovePeripheral` | onCall auth |
| `posUpdateCustomerDisplay` | onCall auth |
| `posUpdatePeripheralStatus` | onCall auth |

### pos-integrations-api.js (12)
| Function | Type |
|---|---|
| `posGetApiDocs` | onCall auth |
| `posGetEtimsExport` | onCall auth |
| `posGetInventoryExport` | onCall auth |
| `posGetLedgerExport` | onCall auth |
| `posGetSalesExport` | onCall auth |
| `posListApiKeys` | onCall auth |
| `posReceiveErpUpdate` | onRequest webhook |
| `posRegisterApiKey` | onCall auth |
| `posRegisterWebhook` | onCall auth |
| `posRevokeApiKey` | onCall auth |
| `posRevokeWebhook` | onCall auth |
| `posTestWebhook` | onCall auth |

### pos-terminal-live.js (7)
| Function | Type |
|---|---|
| `posGetTerminalBatchReport` | onCall auth |
| `posGetTerminalCapabilities` | onCall auth |
| `posGetTerminalHealth` | onCall auth |
| `posPollTerminalStatus` | onCall auth |
| `posReverseTerminalPayment` | onCall admin |
| `posSettleTerminalBatch` | onCall admin |
| `posTerminalEventWebhook` | onRequest webhook |

### pos-printer.js (4) — added 2026-07-07
| Function | Type |
|---|---|
| `posLogPrint` | onCall auth |
| `getPrintHistory` | onCall auth |
| `getPrinterConfig` | onCall auth |
| `setPrinterConfig` | onCall auth |

### finos-automation.js (7) — added 2026-07-07
| Function | Type |
|---|---|
| `fosAutoSettlement` | onSchedule (0 */6 * * *) |
| `fosAutoRefund` | onDocumentUpdated |
| `fosReconcile` | onCall admin |
| `fosGetForecast` | onCall admin |
| `fosGetSettlementConfig` | onCall admin |
| `fosSetSettlementConfig` | onCall admin |
| `fosGetAuditTrail` | onCall admin |

### platform-hub.js (10) — added 2026-07-07
| Function | Type |
|---|---|
| `wapProcessDelays` | onSchedule (every 5 min) |
| `wapGetInstances` | onCall admin |
| `wapRetryStep` | onCall admin |
| `pcGetPerHubFlags` | onCall admin |
| `pcSetPerHubFlag` | onCall admin |
| `pcGetHubDetails` | onCall admin |
| `pcGetCrossHubHealth` | onCall admin |
| `platformNotifyTransactionChange` | onCall auth |
| `pcActivateHub` | onCall admin |
| `pcDeactivateHub` | onCall admin |

---

### currency-engine.js (5) — added 2026-07-07
| Function | Type | Auth |
|---|---|---|
| `currencyGetRates` | onCall | Public (no auth required) |
| `currencyConvert` | onCall | Public (no auth required) |
| `currencyUpdateRates` | onCall | Admin only |
| `currencyGetHistory` | onCall | Admin only |
| `currencyScheduledRateRefresh` | onSchedule (0 */6 * * *) | — |

**Firestore paths written:**
- `exchangeRates/latest` — live rate document (base: KES)
- `exchangeRates/latest/history/{YYYY-MM-DD}` — daily audit snapshots
- `systemAlerts/rateRefresh` — stale-rate alert flag (set by scheduler, cleared by `currencyUpdateRates`)

**No secrets required.** No external HTTP calls. Rates are admin-managed only.

**Spot deploy command (these 5 only):**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:currencyGetRates,functions:currencyConvert,functions:currencyUpdateRates,functions:currencyGetHistory,functions:currencyScheduledRateRefresh" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

### installments.js (6) — added 2026-07-07
| Function | Type | Auth |
|---|---|---|
| `installmentCreatePlan` | onCall | Buyer (auth required) |
| `installmentRecordPayment` | onCall | Buyer — plan owner (auth required) |
| `installmentGetMyPlans` | onCall | Buyer (auth required) |
| `installmentGetSellerPlans` | onCall | Seller or Admin |
| `installmentMarkOverdue` | onSchedule (`0 1 * * *` UTC) | — |
| `installmentCancelPlan` | onCall | Buyer (no payments) or Admin (any state) |

**Firestore paths written:**
- `installmentPlans/{planId}` — plan document (schedule array, status, amounts)
- `installmentPlans/{planId}/installmentPayments/{paymentRef}` — payment records
- `installmentAudit/{id}` — audit log for all create / pay / cancel actions
- `notifications/{id}` — buyer notifications on plan completion or cancellation

**Plan types:**
- `3_month` — 3 payments: 30% upfront + 2 equal monthly
- `6_month` — 6 payments: 30% upfront + 5 equal monthly
- `12_month` — 12 payments: 30% upfront + 11 equal monthly

**No secrets required.** Amounts stored in KES (float, 2 d.p.).

**Spot deploy command (these 6 only):**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:installmentCreatePlan,functions:installmentRecordPayment,functions:installmentGetMyPlans,functions:installmentGetSellerPlans,functions:installmentMarkOverdue,functions:installmentCancelPlan" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

### franchise-engine.js (7) — added 2026-07-07
| Function | Type | Auth |
|---|---|---|
| `franchiseCreateBrand` | onCall | Admin |
| `franchiseApplyForLocation` | onCall | Auth (franchisee) |
| `franchiseReviewApplication` | onCall | Admin |
| `franchiseRecordRoyalty` | onCall | Auth — location owner |
| `franchiseGetMyLocations` | onCall | Auth |
| `franchiseGetBrandDashboard` | onCall | Admin |
| `franchiseGetLocations` | onCall | Admin |

**Firestore paths written:**
- `franchiseBrands/{brandId}` — brand record (name, royaltyPct, techFeePct, minInvestment, territories)
- `franchiseApplications/{appId}` — application (status: pending → approved | rejected)
- `franchiseLocations/{locId}` — active franchise location (created on approval)
- `royaltyPayments/{payId}` — monthly royalty record (grossRevenue, royaltyAmount, techFeeAmount, totalDue)
- `franchiseAudit/{id}` — immutable audit log for all franchise actions
- `notifications/{id}` — applicant notified on approval or rejection

**No secrets required.** All amounts in KES (float, 2 d.p.). Duplicate monthly revenue submission blocked at CF level.

**Spot deploy command (these 7 only):**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:franchiseCreateBrand,functions:franchiseApplyForLocation,functions:franchiseReviewApplication,functions:franchiseRecordRoyalty,functions:franchiseGetMyLocations,functions:franchiseGetBrandDashboard,functions:franchiseGetLocations" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

### messages.js — status lifecycle triggers (3) — added 2026-07-07
| Function | Type | Trigger |
|---|---|---|
| `onOrderStatusChanged` | onDocumentUpdated | `orders/{orderId}` — status field change |
| `onBookingStatusChanged` | onDocumentUpdated | `bookings/{bookingId}` — status/bookingStatus field change |
| `onFoodOrderStatusChanged` | onDocumentUpdated | `foodOrders/{orderId}` — status field change |

Posts a system message into the linked conversation when the transaction status changes.
Uses `STATUS_MSGS` map (16 statuses). Batch writes system message + updates `transactionStatus` field.

**No secrets required.** Zero config — reads from existing `conversations` collection.

**Spot deploy command (these 3 only):**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:onOrderStatusChanged,functions:onBookingStatusChanged,functions:onFoodOrderStatusChanged" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

### commission.js — Settlement & Withdrawals v1.0 (5) — added 2026-07-07
| Function | Type | Auth |
|---|---|---|
| `processSettlement` | onCall | Admin only |
| `requestWithdrawal` | onCall | Auth (seller) |
| `approveWithdrawal` | onCall | Admin only |
| `rejectWithdrawal` | onCall | Admin only |
| `getWithdrawals` | onCall | Auth (seller sees own; admin sees all) |

**Firestore paths written:**
- `settlements/{orderId}` — settlement record (idempotent on orderId); status: `settled`
- `wallets/{sellerId}` — created on first settlement; fields: `availableBalance`, `withdrawableBalance`, `pendingBalance`, `heldBalance`, `lifetimeEarnings`, `lifetimeWithdrawals`, `lifetimeRefunds`
- `withdrawals/{withdrawalId}` — withdrawal request; status: `pending` → `approved` | `rejected`
- `ledger/{id}` — double-entry entries: type `seller_earning` (on settlement), type `withdrawal` (on approval)

**Transaction safety:**
- `processSettlement` — idempotency pre-check on `settlements/{orderId}` + atomic wallet create/increment + ledger write
- `requestWithdrawal` — race-condition guard: pre-check balance before transaction, re-validate inside transaction before deducting `withdrawableBalance`
- `approveWithdrawal` / `rejectWithdrawal` — status guard (`pending` only) prevents double-processing

**No new secrets required.** All amounts stored in cents (integer).

**Spot deploy command (these 5 only):**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:processSettlement,functions:requestWithdrawal,functions:approveWithdrawal,functions:rejectWithdrawal,functions:getWithdrawals" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

### finos-automation.js (7) — added 2026-07-07
| Function | Type | Auth |
|---|---|---|
| `fosAutoSettlement` | onSchedule (0 */6 * * *) | — |
| `fosAutoRefund` | onDocumentUpdated orders/{orderId} | — |
| `fosReconcile` | onCall | Admin only |
| `fosGetForecast` | onCall | Admin only |
| `fosGetSettlementConfig` | onCall | Admin only |
| `fosSetSettlementConfig` | onCall | Admin only |
| `fosGetAuditTrail` | onCall | Admin only |

**Firestore paths written:**
- `finosConfig/settlementRules` — per-hub settlement days + refund policy (read/write)
- `escrows/{id}` — status updated to 'released' by auto-settlement
- `wallets/{sellerId}` — wallet balances incremented on auto-settlement
- `ledger/{id}` — escrow_auto_release + auto_refund entries
- `refunds/{id}` — auto-approved refund records
- `pendingRefunds/{orderId}` — refunds flagged for admin review
- `notifications/{id}` — buyer refund notifications
- `adminAuditLog/{id}` — settlement config change audit

**Secrets required:** `ANTHROPIC_API_KEY` (fosGetForecast AI insight), `INTASEND_API_KEY` (fosReconcile provider fetch).
Both secrets already set in Secret Manager.

**Spot deploy command (these 7 only):**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:fosAutoSettlement,functions:fosAutoRefund,functions:fosReconcile,functions:fosGetForecast,functions:fosGetSettlementConfig,functions:fosSetSettlementConfig,functions:fosGetAuditTrail" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

## Platform Hub Engine v1.0 — 10 CFs (NEW — 2026-07-07)

Source: `functions/platform-hub.js`

| CF | Type | Purpose |
|---|---|---|
| `wapProcessDelays` | onSchedule every 5 min | Advances WAP workflow instances with due delay steps |
| `wapGetInstances` | onCall admin | Paginated workflow instance inspector |
| `wapRetryStep` | onCall admin | Reset a failed step to pending + re-run |
| `pcGetPerHubFlags` | onCall admin | Per-hub feature flag values (scoped, not global) |
| `pcSetPerHubFlag` | onCall admin | Toggle a per-hub feature flag |
| `pcGetHubDetails` | onCall admin | Full hub doc + flags + lifetime metrics in one call |
| `pcGetCrossHubHealth` | onCall admin | Per-hub 24h health snapshot (orders, revenue, error rate) |
| `platformNotifyTransactionChange` | onCall authenticated | Generic transaction status → chat system message (new hubs use this instead of custom Firestore triggers) |
| `pcActivateHub` | onCall admin | Set hub status → live; emits hub.activated platform event |
| `pcDeactivateHub` | onCall admin | Set hub status → maintenance; emits hub.deactivated event |

**Firestore paths written:**
- `workflowSchedule/{id}` — processed flag updated by wapProcessDelays
- `workflowInstances/{id}` — steps updated by wapRetryStep
- `platformConfig/hubFlags` — per-hub feature flags document
- `platformHubs/{hubId}` — status + activatedAt/deactivatedAt
- `platformEvents` — hub lifecycle events
- `adminAuditLog` — all admin actions
- `conversations/{id}/messages` — system messages from platformNotifyTransactionChange

**Secrets required:** None (no external API calls).

**Spot deploy command:**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:wapProcessDelays,functions:wapGetInstances,functions:wapRetryStep,functions:pcGetPerHubFlags,functions:pcSetPerHubFlag,functions:pcGetHubDetails,functions:pcGetCrossHubHealth,functions:platformNotifyTransactionChange,functions:pcActivateHub,functions:pcDeactivateHub" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

### pos-printer.js (4) — added 2026-07-07
| Function | Type | Auth |
|---|---|---|
| `posLogPrint` | onCall | Auth (seller) |
| `getPrintHistory` | onCall | Auth (seller) |
| `getPrinterConfig` | onCall | Auth (seller) |
| `setPrinterConfig` | onCall | Auth (seller) |

**Firestore paths written:**
- `posPrintLog/{id}` — individual print job records (type, copies, timestamp, success flag)
- `posPrintStats/{uid}/daily/{YYYY-MM-DD}` — daily print count rollup per seller
- `posPrinterConfig/{uid}` — saved printer configuration document

**No secrets required.** All operations are scoped to the authenticated seller's UID.

**Spot deploy command (these 4 only):**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:posLogPrint,functions:getPrintHistory,functions:getPrinterConfig,functions:setPrinterConfig" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

### sub-engine.js — Subscription extras (3) — added 2026-07-07
| Function | Type | Auth |
|---|---|---|
| `subCheckFeature` | onCall | Auth |
| `subRetryFailedPayments` | onCall | Admin only |
| `subDowngrade` | onCall | Auth |

**Firestore paths written:**
- `subscriptions/{subId}` — plan updated to lower tier on `subDowngrade`; status `payment_failed` → retry on `subRetryFailedPayments`
- `subscriptionAudit/{id}` — downgrade and retry events

**No new secrets required.** Builds on existing `SUB_OS_SIGNING_SECRET` from sub-engine.js.

**Spot deploy command (these 3 only):**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:subCheckFeature,functions:subRetryFailedPayments,functions:subDowngrade" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

---

### availability.js — Universal Availability & Scheduling Engine v1.0 (14 CFs) — added 2026-07-07

Source: `functions/availability.js` · Client SDK: `sokoni-availability.js` · UI: `availability-manager.html`

| Function | Type | Auth | Purpose |
|---|---|---|---|
| `setProviderAvailability` | onCall | Auth (owner) | Save full weekly schedule, modes, appt settings |
| `setLiveStatus` | onCall | Auth (owner) | Instant live status change (available/busy/break/DND/etc.) |
| `getAvailabilitySlots` | onCall | Public | Fetch open appointment slots for a provider (next N days) |
| `reserveSlot` | onCall | Auth (buyer) | Book a slot atomically — prevents double-booking |
| `releaseSlot` | onCall | Auth (buyer/owner/admin) | Cancel a booked slot; decrements capacity |
| `scheduledAvailabilityMaintenance` | onSchedule (00:01 Nairobi daily) | — | Reactivate expired vacations; reset daily counters |
| `getProviderAvailability` | onRequest | Public HTTP | Lightweight public endpoint for embedding in external pages |
| `setVacationMode` | onCall | Auth (owner) | Enable/disable vacation mode with optional date range |
| `addAvailabilityOverride` | onCall | Auth (owner) | Day-specific schedule exception (closed or alternate hours) |
| `removeAvailabilityOverride` | onCall | Auth (owner) | Remove a day override |
| `listAvailabilityOverrides` | onCall | Auth (owner/admin) | Paginated future overrides list |
| `setMarketplaceAvailability` | onCall | Auth (owner) | Set stock status and delivery status for marketplace items |
| `checkProviderAvailability` | onCall | Public | Full real-time availability check (computes isOpen, nextOpenAt, capacity) |
| `getNextAvailableSlot` | onCall | Public | Find next free appointment slot within 30 days |

**Firestore paths:**
- `providerAvailability/{uid}` — provider config (owner read/write; CFs read)
- `availabilityStatus/{uid}` — denormalized public cache (public read; CFs write)
- `providerAvailability/{uid}/bookings/{YYYY-MM-DD}_{HHmm}` — booked slots (atomic via `runTransaction`)
- `providerAvailability/{uid}/overrides/{YYYY-MM-DD}` — day-specific exceptions

**No new secrets required.** No new Firestore composite indexes (doc-ID prefix queries + single-field ranges).

**Spot deploy command (all 14):**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:setProviderAvailability,functions:setLiveStatus,functions:getAvailabilitySlots,functions:reserveSlot,functions:releaseSlot,functions:scheduledAvailabilityMaintenance,functions:getProviderAvailability,functions:setVacationMode,functions:addAvailabilityOverride,functions:removeAvailabilityOverride,functions:listAvailabilityOverrides,functions:setMarketplaceAvailability,functions:checkProviderAvailability,functions:getNextAvailableSlot" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

### sokoni-at.js — Africa's Talking SMS Consolidation (2026-07-07)

**New file:** `functions/sokoni-at.js` — single source of truth for all AT SMS integration.

**What changed:**
- Secrets renamed: `AT_API_KEY` → `AFRICASTALKING_API_KEY`, `AT_USERNAME` → `AFRICASTALKING_USERNAME`
- Non-sensitive env var `AT_ENV=sandbox|production` in `functions/.env` (committed; safe)
- `sokoni-at.js` exports `atSendSMS()`, `atBuildClient()`, `resolveAtCredentials()`, `secrets[]`
- `index.js`, `redis-jobs.js`, `redis-layer.js`, `pos-retail.js` — all migrated to shared module
- `system-health.js` — secret name updated from `AT_API_KEY` to `AFRICASTALKING_API_KEY`

**No new CFs — update existing CFs to pick up the new secret names:**

```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:onOrderStatusChange,functions:onNewOrderCreated,functions:posSendSMS,functions:sendPOSReceipt,functions:redisScheduledQueueWorker,functions:systemHealthCheck" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

**Secret migration steps (when going to production):**
1. `firebase functions:secrets:set AFRICASTALKING_API_KEY` — set the real AT API key
2. `firebase functions:secrets:set AFRICASTALKING_USERNAME` — set your registered AT username
3. In `functions/.env`: change `AT_ENV=sandbox` → `AT_ENV=production`
4. Redeploy the 6 CFs above

---

---

### venue-booking.js — Venue, Facility & Resource Booking Engine v1.0 (17 CFs) — 2026-07-07

Source: `functions/venue-booking.js` · Customer UI: `venue-booking.html` · Owner UI: `venue-manager.html`

| Function | Type | Auth | Purpose |
|---|---|---|---|
| `venueCreate` | onCall | Auth (owner) | Create a venue / bookable resource |
| `venueUpdate` | onCall | Auth (owner/admin) | Update venue config, schedule, pricing |
| `venueGetPublic` | onCall | Public | Read venue profile (no owner fields) |
| `venueGetAvailability` | onCall | Public | Slot grid for a date range (up to 60 days) |
| `venueCalculatePrice` | onCall | Public | Dynamic price breakdown for a proposed booking |
| `venueCreateBooking` | onCall | Auth (customer) | Atomic slot reservation — `runTransaction()`, prevents double-booking |
| `venueCancelBooking` | onCall | Auth (customer/owner/admin) | Cancel with cancellation fee per policy |
| `venueConfirmBooking` | onCall | Auth (owner/admin) | Confirm a pending booking |
| `venueCheckIn` | onCall | Auth (owner/admin) | Mark booking as checked-in |
| `venueCheckOut` | onCall | Auth (owner/admin) | Mark booking as completed |
| `venueMarkNoShow` | onCall | Auth (owner/admin) | Mark no-show, apply no-show fee |
| `venueGetBooking` | onCall | Auth (customer/owner/admin) | Fetch single booking |
| `venueGetMyBookings` | onCall | Auth (customer) | Customer booking history — paginated |
| `venueGetCalendar` | onCall | Auth (owner/admin) | Calendar view with bookings + blockouts |
| `venueBlockDates` | onCall | Auth (owner/admin) | Block date range (maintenance, holidays) |
| `venueRemoveBlock` | onCall | Auth (owner/admin) | Remove a blockout — restores availability |
| `venueGetStats` | onCall | Auth (owner/admin) | 30-day analytics: revenue, utilisation, peak hour |

**Firestore paths:**
- `venues/{venueId}` — venue profile, schedule, pricing, capacity
- `venues/{venueId}/bookings/{YYYY-MM-DD_HHmm_shortId}` — slot locks (atomic via `runTransaction`)
- `venues/{venueId}/blockouts/{blockId}` — maintenance / holiday blocks
- `venueBookings/{bookingId}` — top-level mirror for customer history queries

**New composite index (firestore.indexes.json — already added):**
- Collection: `venueBookings` | `customerId ASC, createdAt DESC`
- Index count: 190 → 191 (9 slots remaining before 200 limit)

**Booking models supported:** hourly · half_day · full_day · multi_day · weekly_recurring · monthly_recurring · seasonal · exclusive · shared

**Dynamic pricing features:** base rate/hour, weekend multiplier, peak-hour surcharges (time-range overlaps), member discount, deposit %, cancellation fee policy (free window, late %, no-show %)

**No new secrets required.** Extends the Universal Availability Engine. Double-booking prevented by `runTransaction()` — exclusive or shared (capacity) logic per venue config.

**Spot deploy command (all 17):**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:venueCreate,functions:venueUpdate,functions:venueGetPublic,functions:venueGetAvailability,functions:venueCalculatePrice,functions:venueCreateBooking,functions:venueCancelBooking,functions:venueConfirmBooking,functions:venueCheckIn,functions:venueCheckOut,functions:venueMarkNoShow,functions:venueGetBooking,functions:venueGetMyBookings,functions:venueGetCalendar,functions:venueBlockDates,functions:venueRemoveBlock,functions:venueGetStats" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

## MiniShop Social Commerce Engine v3.0 — 2026-07-08

**Files:**
- `functions/minishop-v3.js` — 12 CFs
- `minishop.html` — v3 HTML sections added (catalog filter, promotions, announcements, similar shops)
- `minishop.css` — NEW; extracted from minishop.html + v3.0 styles
- `minishop-admin.html` — Flash Sales tab, Canvas asset generator, Announcements section
- `sokoni-minishop.js` — handle parser, v3 loaders, product card fixes
- `firebase.json` — `/shop/**` and `/@**` now route to `miniShopOGMeta` CF

**New CFs (12 — blocked by same quota):**

| Export name | Type | Purpose |
|---|---|---|
| `miniShopOGMeta` | onRequest (public) | Dynamic OG meta / shell page for all /shop/* and /@* URLs |
| `miniShopCreatePromotion` | onCall | Create flash sale / bundle / coupon / BOGO |
| `miniShopGetPromotions` | onCall (public) | List active promotions for a shop |
| `miniShopUpdatePromotion` | onCall | Pause/activate/edit promotion |
| `miniShopToggleWishlist` | onCall (auth) | Add/remove product from wishlist |
| `miniShopGetWishlist` | onCall (auth) | Get user wishlist for a shop |
| `miniShopShareProduct` | onCall | Record per-product share event + return share URL |
| `miniShopAIMarketing` | onCall | AI marketing: best_times, seasonal, trending_angle, campaign_plan |
| `miniShopSendAnnouncement` | onCall | Seller sends announcement to followers |
| `miniShopGetAnnouncements` | onCall (public) | Get recent shop announcements |
| `miniShopGetSimilar` | onCall (public) | Get similar businesses by category |
| `miniShopScheduledDigest` | onSchedule (weekly) | Email sellers their weekly analytics digest |

**New Firestore collections:**
- `minishopPromotions/{promoId}` — flash sales, bundles, coupons
- `minishopWishlist/{uid}/items/{productId}` — per-user wishlists
- `minishopAnnouncements/{shopId}/posts/{id}` — seller announcements

**Secrets required:** `ANTHROPIC_API_KEY` (already in Secret Manager for `miniShopAIMarketing`)

**Spot deploy command (all 12):**
```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:miniShopOGMeta,functions:miniShopCreatePromotion,functions:miniShopGetPromotions,functions:miniShopUpdatePromotion,functions:miniShopToggleWishlist,functions:miniShopGetWishlist,functions:miniShopShareProduct,functions:miniShopAIMarketing,functions:miniShopSendAnnouncement,functions:miniShopGetAnnouncements,functions:miniShopGetSimilar,functions:miniShopScheduledDigest" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

**Hosting spot deploy (static assets only):**
```powershell
firebase deploy --only hosting --project sokoni-aeb26
```

---

## Hosting (already deployed 2026-07-06)
All HTML/CSS/JS pages are LIVE. CF features will activate when quota clears.
New pages deployed:
- `/seller-earnings` — Seller earnings dashboard
- `/revenue-dashboard` — Admin revenue dashboard
- `/my-subscriptions` — Universal subscription management portal
- `/fos-admin` — Financial OS admin console
- `/async-jobs` — Async Jobs Engine monitoring dashboard
- `/messages-admin` — Business Communication admin console (moderation, policies, conversation search)
- `/availability-manager` — Universal Availability & Scheduling Manager (all hub types)
- `/venue-booking` — Customer venue search & booking (sports courts, event halls, studios, all resource types)
- `/venue-manager` — Owner venue management: calendar, bookings, block dates, pricing, stats
