# SOKONI CF Deploy Queue

All Cloud Functions below are code-complete and hosted. They are waiting for
Cloud Run quota to clear (quota typically resets within 24 hours).

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

## Status — 2026-07-07 (updated)

**61/61 Security Patch CFs REDEPLOYED ✅ — 2026-07-07**
Wallet, email-triggers, release-readiness, payment-trust, pos-retail patches live.

**0/156 NEW CFs LIVE — Blocked by Cloud Run CPU quota**
_(135 original + 5 commission + 3 sub-engine + 6 finos-admin + 7 finos-automation)_

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

## SECURITY PATCH REDEPLOY — 61 CFs (already-live functions, code changed)

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

### Deployment order priority (when quota partially available)
1. **Security Patch Redeploy** (61 CFs) — security bugs in live functions
2. **Algolia Key Rotation** (79 CFs) — pick up rotated key before old version is disabled
3. **Master Deploy** (143 new CFs) — new features, not yet live

---

## MASTER DEPLOY COMMAND (all 135 CFs)

Run once when quota is cleared:

```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:fosInitiatePayment,functions:fosSecureWebhook,functions:fosSubmitRefund,functions:fosApproveRefund,functions:fosGenerateInvoice,functions:fosExportReport,functions:fosGetProviderHealth,functions:fosGetAdminConsole,functions:subScheduleRenewals,functions:subAutoActivateOnPayment,functions:subUpgradeWithProration,functions:getSellerEarningsReport,functions:getAdminRevenueByHub,functions:getConversationContext,functions:searchConversations,functions:editMessage,functions:updateConversationStatus,functions:pcGetHubRegistry,functions:pcRegisterHub,functions:pcUpdateHubConfig,functions:pcGetFeatureFlags,functions:pcSetFeatureFlag,functions:pcGetCrossHubMetrics,functions:asyncEnqueue,functions:asyncWorker,functions:asyncSweeper,functions:asyncEventRouter,functions:asyncCancel,functions:asyncRetryJob,functions:asyncPauseQueue,functions:asyncGetDashboard,functions:asyncGetJobs,functions:asyncInspect,functions:asyncCleanup,functions:opsGetMasterDashboard,functions:opsGetAlerts,functions:opsAcknowledgeAlert,functions:opsCreateAlert,functions:opsGetPostLaunchMetrics,functions:opsScheduledHealthCheck,functions:rollbackGetSnapshots,functions:rollbackCreateSnapshot,functions:rollbackTrigger,functions:rollbackGetExecutions,functions:rollbackUpdateStatus,functions:rollbackScheduledSnapshot,functions:recordPosEvent,functions:getPosPerfMetrics,functions:getPosSpeedReport,functions:posScheduledPerfRollup,functions:acknowledgeShift,functions:approveShiftSwap,functions:assignShift,functions:createShiftTemplate,functions:getRoster,functions:getRosterGaps,functions:getStaffRoster,functions:publishWeeklyRoster,functions:schedulerWeeklyDigest,functions:setStaffAvailability,functions:swapShiftRequest,functions:createSession,functions:detectSessionAnomaly,functions:getUserSessions,functions:revokeDeviceSessions,functions:rotateSession,functions:scheduledSessionCleanup,functions:terminateAllSessions,functions:terminateSession,functions:validateSession,functions:generateSecureUploadUrl,functions:getFileAuditLog,functions:onFileUploaded,functions:quarantineFile,functions:validateUploadRequest,functions:getLatestSecurityReport,functions:runSecurityAudit,functions:scheduleWeeklySecurityAudit,functions:getPOSInventoryIntelligence,functions:getProductSalesTrend,functions:earnLoyaltyPoints,functions:onInventoryUpdated,functions:onOrderCreated,functions:onPaymentCreated,functions:onPaymentUpdated,functions:onRiderStatusChange,functions:onUserCreated,functions:posCleanupPeripheralSignals,functions:posCreateCustomerDisplay,functions:posGetPeripherals,functions:posRegisterPeripheral,functions:posRemovePeripheral,functions:posUpdateCustomerDisplay,functions:posUpdatePeripheralStatus,functions:posGetApiDocs,functions:posGetEtimsExport,functions:posGetInventoryExport,functions:posGetLedgerExport,functions:posGetSalesExport,functions:posListApiKeys,functions:posReceiveErpUpdate,functions:posRegisterApiKey,functions:posRegisterWebhook,functions:posRevokeApiKey,functions:posRevokeWebhook,functions:posTestWebhook,functions:posGetTerminalBatchReport,functions:posGetTerminalCapabilities,functions:posGetTerminalHealth,functions:posPollTerminalStatus,functions:posReverseTerminalPayment,functions:posSettleTerminalBatch,functions:posTerminalEventWebhook,functions:currencyGetRates,functions:currencyConvert,functions:currencyUpdateRates,functions:currencyGetHistory,functions:currencyScheduledRateRefresh,functions:installmentCreatePlan,functions:installmentRecordPayment,functions:installmentGetMyPlans,functions:installmentGetSellerPlans,functions:installmentMarkOverdue,functions:installmentCancelPlan,functions:franchiseCreateBrand,functions:franchiseApplyForLocation,functions:franchiseReviewApplication,functions:franchiseRecordRoyalty,functions:franchiseGetMyLocations,functions:franchiseGetBrandDashboard,functions:franchiseGetLocations,functions:onOrderStatusChanged,functions:onBookingStatusChanged,functions:onFoodOrderStatusChanged" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
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
| `AT_API_KEY` | Third-party | ✅ SET | Africa's Talking dashboard |
| `AT_USERNAME` | Third-party | ✅ SET | Africa's Talking dashboard |
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

**All 24 production secrets are SET. No missing secrets remain.**

### After quota clears: activate Redis rate limiting
Set `REDIS_URL` in `functions/.env` (and optionally Secret Manager) once your Redis instance is provisioned.
Format: `rediss://:<password>@<host>:6379` (TLS required for production).

---

## All 114 functions by source file

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

### sub-engine.js (3)
| Function | Type |
|---|---|
| `subScheduleRenewals` | onSchedule |
| `subAutoActivateOnPayment` | onDocumentUpdated |
| `subUpgradeWithProration` | onCall auth |

### commission.js (2)
| Function | Type |
|---|---|
| `getSellerEarningsReport` | onCall auth |
| `getAdminRevenueByHub` | onCall admin |

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

## Hosting (already deployed 2026-07-06)
All HTML/CSS/JS pages are LIVE. CF features will activate when quota clears.
New pages deployed:
- `/seller-earnings` — Seller earnings dashboard
- `/revenue-dashboard` — Admin revenue dashboard
- `/my-subscriptions` — Universal subscription management portal
- `/fos-admin` — Financial OS admin console
- `/async-jobs` — Async Jobs Engine monitoring dashboard
- `/messages-admin` — Business Communication admin console (moderation, policies, conversation search)
