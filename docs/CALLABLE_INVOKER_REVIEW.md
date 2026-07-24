# Callable invoker review — expected caller per function

Companion to `CALLABLE_INVOKER_GAPS.md`. That file lists the 348 functions whose
Cloud Run service has no `roles/run.invoker` binding. This one turns that into
**architectural decisions to confirm**, not IAM bindings to apply blindly.

Generated 2026-07-24 by classifying each function against the client codebase.

## How each row was derived

- **Client reference** — the function name appears as a quoted string in a page or
  client script. This codebase invokes functions through many wrappers
  (`httpsCallable`, `callCF`, `callFn`, and page-local ones such as `_lhCallCF`), so
  enumerating wrappers under-counts; matching the quoted name is the reliable signal.
  `cf-complete-audit.html` and `cf-migration-plan.html` are excluded — they embed
  every function name and would mark all 348 as browser-called.
- A reference is **evidence, not proof**. It could sit in dead code or a comment. The
  named file makes it checkable in seconds.

## Known limitation — internal auth was NOT reliably determined

An attempt to record `request.auth` / admin enforcement per function failed: most are
re-exported through modules and dispatchers, so the definition site could not be
located automatically. **No auth column is published rather than an unreliable one.**
Confirm in-function authorization yourself before granting public invoker — that
check, not IAM, is the real security boundary for a callable.

## Group 1 — client reference found (206)

The browser appears to be the expected caller. If the function authenticates and
authorizes internally, granting `run.invoker` restores the intended architecture.
Admin-surface functions (e.g. `super-admin.html`, `trust-safety.html`) are still
browser-called — an admin UI is a browser — but they carry the highest blast radius,
so confirm their in-function admin check explicitly before granting.

| Function | Client evidence | Desired invoker |
|---|---|---|
| `addSupplier` | inventory.html | public invoker (confirm internal auth) |
| `adminGetAllDisputes` | trust-safety.html | public invoker (confirm internal auth) |
| `adminProcessPayout` | super-admin.html | public invoker (confirm internal auth) |
| `approveAndPayInvoice` | procurement.html | public invoker (confirm internal auth) |
| `approveFinancialChange` | sokoni-entitlement.js subscription-os.html | public invoker (confirm internal auth) |
| `approveLegalProvider` | legal-admin.html | public invoker (confirm internal auth) |
| `approvePurchaseOrder` | inventory.html procurement.html | public invoker (confirm internal auth) |
| `approveRelease` | release-readiness.html | public invoker (confirm internal auth) |
| `askPOSAssistant` | developer-portal.html pos-ai.html | public invoker (confirm internal auth) |
| `autoUpdateRule` | automation-center.html | public invoker (confirm internal auth) |
| `blockAISession` | security-center.html | public invoker (confirm internal auth) |
| `blockDevice` | security-center.html | public invoker (confirm internal auth) |
| `bookLegalConsultation` | legal-hub.html | public invoker (confirm internal auth) |
| `buildCustomerProfile` | crm.html | public invoker (confirm internal auth) |
| `calculateCLV` | crm.html | public invoker (confirm internal auth) |
| `checkComplianceReadiness` | release-readiness.html | public invoker (confirm internal auth) |
| `checkInfrastructure` | release-readiness.html | public invoker (confirm internal auth) |
| `checkInTicket` | event-manager.html | public invoker (confirm internal auth) |
| `checkPerformanceReadiness` | release-readiness.html | public invoker (confirm internal auth) |
| `checkPlatformModules` | release-readiness.html | public invoker (confirm internal auth) |
| `checkSecurityReadiness` | release-readiness.html | public invoker (confirm internal auth) |
| `convertLead` | crm.html | public invoker (confirm internal auth) |
| `createCourse` | sokoni-education.js | public invoker (confirm internal auth) |
| `createEvent` | event-manager.html | public invoker (confirm internal auth) |
| `createEventPromoCode` | event-manager.html | public invoker (confirm internal auth) |
| `createIncident` | security-center.html | public invoker (confirm internal auth) |
| `createLead` | crm.html | public invoker (confirm internal auth) |
| `createPurchaseOrder` | inventory.html procurement.html | public invoker (confirm internal auth) |
| `createSupportTicket` | crm.html | public invoker (confirm internal auth) |
| `createTicketTier` | event-manager.html | public invoker (confirm internal auth) |
| `disablePaymentMethod` | security-center.html | public invoker (confirm internal auth) |
| `dismissFraudAlert` | security-center.html | public invoker (confirm internal auth) |
| `enrollCourse` | sokoni-education.js | public invoker (confirm internal auth) |
| `escalateFraudAlert` | security-center.html | public invoker (confirm internal auth) |
| `etimsBulkGenerate` | sokoni-etims.js | public invoker (confirm internal auth) |
| `etimsDownloadReceipt` | sokoni-hub-etims.js | public invoker (confirm internal auth) |
| `etimsGenerateInvoice` | sokoni-etims.js | public invoker (confirm internal auth) |
| `etimsGetAdminStats` | sokoni-etims.js | public invoker (confirm internal auth) |
| `etimsGetBuyerReceipts` | sokoni-etims.js | public invoker (confirm internal auth) |
| `etimsGetProfile` | sokoni-etims.js | public invoker (confirm internal auth) |
| `etimsGetSellerStats` | sokoni-etims.js | public invoker (confirm internal auth) |
| `etimsPlatformInvoice` | sokoni-etims.js | public invoker (confirm internal auth) |
| `etimsRegisterSeller` | sokoni-etims.js | public invoker (confirm internal auth) |
| `etimsResubmitInvoice` | sokoni-etims.js | public invoker (confirm internal auth) |
| `etimsUpdateProfile` | sokoni-etims.js | public invoker (confirm internal auth) |
| `etimsValidatePin` | sokoni-etims.js | public invoker (confirm internal auth) |
| `evaluateAccessRequest` | developer-portal.html sokoni-zero-trust.js | public invoker (confirm internal auth) |
| `evaluateFraudRisk` | sokoni-aos.js | public invoker (confirm internal auth) |
| `exportAuditLog` | security-center.html | public invoker (confirm internal auth) |
| `forecastRevenue` | sokoni-subscription-brain.js subscription-os.html | public invoker (confirm internal auth) |
| `generateDRReport` | enterprise-ops.html | public invoker (confirm internal auth) |
| `generateEntitlementToken` | sokoni-entitlement.js | public invoker (confirm internal auth) |
| `getActivePOSPromotions` | pos-marketplace.html | public invoker (confirm internal auth) |
| `getAIQueryHistory` | pos-ai.html | public invoker (confirm internal auth) |
| `getAIRateLimitStatus` | security-center.html | public invoker (confirm internal auth) |
| `getAISecurityLog` | security-center.html | public invoker (confirm internal auth) |
| `getAISubscriptionStats` | sokoni-aos.js | public invoker (confirm internal auth) |
| `getAISystemHealth` | enterprise-ops.html | public invoker (confirm internal auth) |
| `getBusinessHealthScore` | business-health.html commerce-os.html | public invoker (confirm internal auth) |
| `getCategoryPerformance` | pos-bi.html | public invoker (confirm internal auth) |
| `getChurnRisk` | crm.html | public invoker (confirm internal auth) |
| `getCourse` | sokoni-education.js | public invoker (confirm internal auth) |
| `getCourseProgress` | sokoni-education.js | public invoker (confirm internal auth) |
| `getCRMDashboard` | crm.html | public invoker (confirm internal auth) |
| `getCustomerGrowthMetrics` | pos-bi.html | public invoker (confirm internal auth) |
| `getCustomerProfile` | crm.html | public invoker (confirm internal auth) |
| `getEventAnalytics` | event-manager.html | public invoker (confirm internal auth) |
| `getEventOrders` | event-manager.html | public invoker (confirm internal auth) |
| `getExecutiveDashboard` | pos-bi.html | public invoker (confirm internal auth) |
| `getFraudAlerts` | developer-portal.html executive-dashboard.html | public invoker (confirm internal auth) |
| `getFraudReport` | executive-dashboard.html security-center.html | public invoker (confirm internal auth) |
| `getHealthScoreBenchmarks` | business-health.html | public invoker (confirm internal auth) |
| `getHealthScoreHistory` | business-health.html | public invoker (confirm internal auth) |
| `getIncidents` | executive-dashboard.html security-center.html | public invoker (confirm internal auth) |
| `getInfrastructureStatus` | enterprise-ops.html | public invoker (confirm internal auth) |
| `getInventoryHealthScore` | pos-bi.html | public invoker (confirm internal auth) |
| `getInventoryReserveStatus` | pos-marketplace.html | public invoker (confirm internal auth) |
| `getLatestReleaseReport` | developer-portal.html executive-dashboard.html | public invoker (confirm internal auth) |
| `getLeadBoard` | crm.html | public invoker (confirm internal auth) |
| `getLegalProvider` | legal-hub.html | public invoker (confirm internal auth) |
| `getLegalProviders` | legal-hub.html | public invoker (confirm internal auth) |
| `getMarketplaceHealth` | enterprise-ops.html | public invoker (confirm internal auth) |
| `getMyEnrollments` | sokoni-education.js | public invoker (confirm internal auth) |
| `getMyLegalConsultations` | legal-hub.html | public invoker (confirm internal auth) |
| `getMyQRAssets` | qr-center.html | public invoker (confirm internal auth) |
| `getMyTickets` | event-hub.html | public invoker (confirm internal auth) |
| `getOrganizerDashboard` | event-manager.html | public invoker (confirm internal auth) |
| `getPaymentSystemHealth` | enterprise-ops.html | public invoker (confirm internal auth) |
| `getPaymentTrends` | pos-bi.html | public invoker (confirm internal auth) |
| `getPayoutHistory` | sokoni-wallet.js | public invoker (confirm internal auth) |
| `getPOSSystemStatus` | enterprise-ops.html | public invoker (confirm internal auth) |
| `getProcurementDashboard` | procurement.html | public invoker (confirm internal auth) |
| `getProcurementForecast` | procurement.html | public invoker (confirm internal auth) |
| `getProviderConsultations` | legal-hub.html | public invoker (confirm internal auth) |
| `getQueueDepth` | enterprise-ops.html executive-dashboard.html | public invoker (confirm internal auth) |
| `getRevenueDrilldown` | pos-bi.html | public invoker (confirm internal auth) |
| `getRevenueForecast` | pos-bi.html | public invoker (confirm internal auth) |
| `getRevenueTrend` | pos-bi.html | public invoker (confirm internal auth) |
| `getRiskProfile` | security-center.html | public invoker (confirm internal auth) |
| `getSecurityScorecard` | developer-portal.html executive-dashboard.html | public invoker (confirm internal auth) |
| `getSecuritySystemHealth` | enterprise-ops.html | public invoker (confirm internal auth) |
| `getSessionRiskScore` | sokoni-zero-trust.js | public invoker (confirm internal auth) |
| `getStaffProductivityMetrics` | pos-bi.html | public invoker (confirm internal auth) |
| `getStuckSessions` | commerce-os.html | public invoker (confirm internal auth) |
| `getSystemHealth` | enterprise-certification.html | public invoker (confirm internal auth) |
| `getUnifiedSalesReport` | pos-marketplace.html | public invoker (confirm internal auth) |
| `getWalletBalance` | developer-portal.html sokoni-wallet-v2.js | public invoker (confirm internal auth) |
| `getZeroTrustPolicyStatus` | security-center.html security-zero-trust-dashboard.html | public invoker (confirm internal auth) |
| `hubAdminGetAllStats` | sokoni-hub-etims.js | public invoker (confirm internal auth) |
| `hubCreate` | sokoni-hub-etims.js | public invoker (confirm internal auth) |
| `hubGenerateDocument` | sokoni-hub-etims.js | public invoker (confirm internal auth) |
| `hubGenerateInvoice` | sokoni-hub-etims.js | public invoker (confirm internal auth) |
| `hubGetAuditTrail` | sokoni-hub-etims.js | public invoker (confirm internal auth) |
| `hubGetDocuments` | sokoni-hub-etims.js | public invoker (confirm internal auth) |
| `hubGetProfile` | sokoni-hub-etims.js | public invoker (confirm internal auth) |
| `hubGetStats` | sokoni-hub-etims.js | public invoker (confirm internal auth) |
| `hubRegisterEtims` | sokoni-hub-etims.js | public invoker (confirm internal auth) |
| `hubResubmitInvoice` | sokoni-hub-etims.js | public invoker (confirm internal auth) |
| `hubUpdate` | sokoni-hub-etims.js | public invoker (confirm internal auth) |
| `hubUpdateTaxConfig` | sokoni-hub-etims.js | public invoker (confirm internal auth) |
| `initiateRefund` | sokoni-endpoints.js | public invoker (confirm internal auth) |
| `initiateWalletTopUp` | developer-portal.html sfos-wallet.html | public invoker (confirm internal auth) |
| `inventoryAdjustStock` | sokoni-inventory.js | public invoker (confirm internal auth) |
| `inventoryAiForecast` | inv-ai.html sokoni-inventory.js | public invoker (confirm internal auth) |
| `inventoryAiIdentifyProduct` | sokoni-inventory.js | public invoker (confirm internal auth) |
| `inventoryAiQuery` | inv-ai.html inv-product.html | public invoker (confirm internal auth) |
| `inventoryAiReorderSuggestions` | inv-ai.html sokoni-inventory.js | public invoker (confirm internal auth) |
| `inventoryCreateWorkflow` | sokoni-inventory-v2.js | public invoker (confirm internal auth) |
| `inventoryGetPricingRecommendations` | sokoni-inventory-v2.js | public invoker (confirm internal auth) |
| `inventoryGetRecalls` | sokoni-inventory-v2.js | public invoker (confirm internal auth) |
| `inventoryImportAiMap` | inv-products.html pos-inventory.html | public invoker (confirm internal auth) |
| `inventoryImportPreview` | inv-products.html pos-inventory.html | public invoker (confirm internal auth) |
| `inventoryProcessStockCount` | sokoni-inventory.js | public invoker (confirm internal auth) |
| `inventoryRecallReport` | sokoni-inventory-v2.js | public invoker (confirm internal auth) |
| `inventoryReceivePO` | sokoni-inventory.js | public invoker (confirm internal auth) |
| `inventorySimulatePriceChange` | sokoni-inventory-v2.js | public invoker (confirm internal auth) |
| `listEvents` | event-hub.html | public invoker (confirm internal auth) |
| `lockStore` | security-center.html | public invoker (confirm internal auth) |
| `logLeadActivity` | crm.html | public invoker (confirm internal auth) |
| `pauseQueue` | sokoni-async-jobs.js | public invoker (confirm internal auth) |
| `platformGetCapabilityMatrix` | platform.html sokoni-platform.js | public invoker (confirm internal auth) |
| `platformReplayEvents` | platform.html | public invoker (confirm internal auth) |
| `processSubscriptionChange` | sokoni-entitlement.js | public invoker (confirm internal auth) |
| `purchaseTickets` | event-hub.html | public invoker (confirm internal auth) |
| `rateLegalProvider` | legal-hub.html | public invoker (confirm internal auth) |
| `receiveGoods` | procurement.html | public invoker (confirm internal auth) |
| `recordTypesenseSearchEvent` | sokoni-typesense-engine.js | public invoker (confirm internal auth) |
| `registerLegalProvider` | legal-hub.html | public invoker (confirm internal auth) |
| `registerWebhook` | developer-portal.html partner-portal.html | public invoker (confirm internal auth) |
| `requestDataExport` | account-centre.html | public invoker (confirm internal auth) |
| `requestSellerPayout` | developer-portal.html seller-earnings.html | public invoker (confirm internal auth) |
| `resendEmail` | email-center.html sokoni-endpoints.js | public invoker (confirm internal auth) |
| `resumeQueue` | sokoni-async-jobs.js | public invoker (confirm internal auth) |
| `revokeUserSessions` | security-center.html | public invoker (confirm internal auth) |
| `runDRSimulation` | enterprise-ops.html | public invoker (confirm internal auth) |
| `runReleaseReadinessCheck` | developer-portal.html release-readiness.html | public invoker (confirm internal auth) |
| `runSecurityScan` | security-center.html | public invoker (confirm internal auth) |
| `runSubscriptionBrain` | sokoni-subscription-brain.js | public invoker (confirm internal auth) |
| `sasosAdminListSubscriptions` | sasos-admin.html | public invoker (confirm internal auth) |
| `sasosAllocateCredits` | sasos-admin.html | public invoker (confirm internal auth) |
| `sasosDeductCredits` | sokoni-platform.js sokoni-sasos.js | public invoker (confirm internal auth) |
| `sasosGetBillingHistory` | sasos-admin.html | public invoker (confirm internal auth) |
| `sasosGetForecast` | sasos-admin.html | public invoker (confirm internal auth) |
| `sasosGetInsights` | sasos-admin.html sokoni-platform.js | public invoker (confirm internal auth) |
| `sasosGetLicense` | sasos-admin.html | public invoker (confirm internal auth) |
| `sasosGetRecommendations` | sokoni-platform.js sokoni-sasos.js | public invoker (confirm internal auth) |
| `sasosGetRevenueSummary` | sasos-admin.html | public invoker (confirm internal auth) |
| `sasosGetSubscription` | sasos-admin.html sokoni-sasos.js | public invoker (confirm internal auth) |
| `sasosRecordUsage` | sokoni-platform.js sokoni-sasos.js | public invoker (confirm internal auth) |
| `sasosRevokeLicense` | sasos-admin.html | public invoker (confirm internal auth) |
| `sasosSubscribe` | sokoni-sasos.js | public invoker (confirm internal auth) |
| `sasosSyncLegacy` | sasos-admin.html | public invoker (confirm internal auth) |
| `sasosUpdateRiskScore` | sokoni-platform.js sokoni-sasos.js | public invoker (confirm internal auth) |
| `searchEvents` | event-hub.html | public invoker (confirm internal auth) |
| `searchGetStats` | sokoni-aos.js | public invoker (confirm internal auth) |
| `searchRepairAll` | sokoni-aos.js | public invoker (confirm internal auth) |
| `searchSystemReport` | sokoni-aos.js | public invoker (confirm internal auth) |
| `secSuspendUser` | security-center.html | public invoker (confirm internal auth) |
| `secUnsuspendUser` | security-center.html | public invoker (confirm internal auth) |
| `sendBroadcastEmail` | email-center.html | public invoker (confirm internal auth) |
| `sendPlatformBroadcast` | super-admin.html | public invoker (confirm internal auth) |
| `sendPOSReceipt` | pos-customers.js | public invoker (confirm internal auth) |
| `sendPurchaseOrder` | inventory.html pos-suppliers.js | public invoker (confirm internal auth) |
| `suspendUser` | security-center.html super-admin.html | public invoker (confirm internal auth) |
| `syncPromotionToPOS` | pos-marketplace.html | public invoker (confirm internal auth) |
| `testWebhook` | partner-portal.html | public invoker (confirm internal auth) |
| `triggerStepUpAuth` | developer-portal.html sokoni-zero-trust.js | public invoker (confirm internal auth) |
| `typesenseBackfill` | sokoni-endpoints.js | public invoker (confirm internal auth) |
| `typesenseCreateCollections` | sokoni-endpoints.js | public invoker (confirm internal auth) |
| `typesenseGetDashboard` | sokoni-config.js | public invoker (confirm internal auth) |
| `typesenseHealthCheck` | sokoni-endpoints.js | public invoker (confirm internal auth) |
| `unlockStore` | security-center.html | public invoker (confirm internal auth) |
| `updateClickAndCollectStatus` | pos-marketplace.html | public invoker (confirm internal auth) |
| `updateConsultationStatus` | legal-hub.html | public invoker (confirm internal auth) |
| `updateCourseProgress` | sokoni-education.js | public invoker (confirm internal auth) |
| `updateEvent` | event-manager.html | public invoker (confirm internal auth) |
| `updateIncident` | security-center.html | public invoker (confirm internal auth) |
| `updateLead` | crm.html | public invoker (confirm internal auth) |
| `updateSupportTicket` | crm.html | public invoker (confirm internal auth) |
| `validateAIPrompt` | developer-portal.html | public invoker (confirm internal auth) |
| `validateDeviceAccess` | pos-manager-auth.js | public invoker (confirm internal auth) |
| `validateEventPromoCode` | event-hub.html | public invoker (confirm internal auth) |
| `verifyAuditIntegrity` | security-center.html | public invoker (confirm internal auth) |
| `verifyEntitlement` | sokoni-entitlement.js | public invoker (confirm internal auth) |
| `verifyFirestoreBackup` | enterprise-ops.html | public invoker (confirm internal auth) |
| `verifyStepUpAuth` | sokoni-zero-trust.js | public invoker (confirm internal auth) |

## Group 2 — no client reference found (142)

No page or client script mentions these. Candidates for **deliberately private**:
server-to-server, invoked by another function with an IAM identity, or reachable only
through a dispatcher. A 403 may be exactly correct here.

**Leave unchanged until the intended caller is identified.** Absence of a reference is
weaker evidence than presence of one — a dynamically-built name would not be found.

| Function | Desired invoker |
|---|---|
| `cancelEvent` | unchanged until caller identified |
| `checkImpossibleTravel` | unchanged until caller identified |
| `checkPaymentVelocity` | unchanged until caller identified |
| `clearAIQueryHistory` | unchanged until caller identified |
| `compareVehicles` | unchanged until caller identified |
| `createClickAndCollect` | unchanged until caller identified |
| `createDigitalProduct` | unchanged until caller identified |
| `createEntertainmentListing` | unchanged until caller identified |
| `createPaymentSession` | unchanged until caller identified |
| `createSupplierInvoice` | unchanged until caller identified |
| `createVehicleListing` | unchanged until caller identified |
| `decommissionDevice` | unchanged until caller identified |
| `deleteWebhook` | unchanged until caller identified |
| `detectAnomalies` | unchanged until caller identified |
| `deviceHeartbeat` | unchanged until caller identified |
| `downloadDigitalProduct` | unchanged until caller identified |
| `filterAIResponse` | unchanged until caller identified |
| `flagUnmatchedPayment` | unchanged until caller identified |
| `fraudBlock` | unchanged until caller identified |
| `generateCorrelationId` | unchanged until caller identified |
| `generateExecutiveSummary` | unchanged until caller identified |
| `getAIContextPolicy` | unchanged until caller identified |
| `getBranchPerformanceComparison` | unchanged until caller identified |
| `getCertificationHistory` | unchanged until caller identified |
| `getChaosTestReports` | unchanged until caller identified |
| `getComplianceReport` | unchanged until caller identified |
| `getCreatorDashboard` | unchanged until caller identified |
| `getCustomerSegmentRevenue` | unchanged until caller identified |
| `getDataExportStatus` | unchanged until caller identified |
| `getDeviceList` | unchanged until caller identified |
| `getDigitalProduct` | unchanged until caller identified |
| `getDigitalSellerDashboard` | unchanged until caller identified |
| `getDimensionDrilldown` | unchanged until caller identified |
| `getDRHistory` | unchanged until caller identified |
| `getEntertainmentListing` | unchanged until caller identified |
| `getExecutiveSummaries` | unchanged until caller identified |
| `getHealthHistory` | unchanged until caller identified |
| `getIncidentTimeline` | unchanged until caller identified |
| `getIncrementalSync` | unchanged until caller identified |
| `getLatestSecurityScan` | unchanged until caller identified |
| `getLedgerBalance` | unchanged until caller identified |
| `getMarketingROI` | unchanged until caller identified |
| `getMpesaReconciliationSummary` | unchanged until caller identified |
| `getMultibranchHealthComparison` | unchanged until caller identified |
| `getMultiBranchRevenue` | unchanged until caller identified |
| `getMyDigitalPurchases` | unchanged until caller identified |
| `getMyEntertainmentPurchases` | unchanged until caller identified |
| `getPaymentState` | unchanged until caller identified |
| `getPendingClickAndCollect` | unchanged until caller identified |
| `getPlatformMetrics` | unchanged until caller identified |
| `getPostLaunchDashboard` | unchanged until caller identified |
| `getQueueStats` | unchanged until caller identified |
| `getReconciliationReport` | unchanged until caller identified |
| `getRevenueByChannel` | unchanged until caller identified |
| `getSelfHealHistory` | unchanged until caller identified |
| `getSettlementReport` | unchanged until caller identified |
| `getSupplierPerformance` | unchanged until caller identified |
| `getTicket` | unchanged until caller identified |
| `getVehicle` | unchanged until caller identified |
| `getVehicleEnquiries` | unchanged until caller identified |
| `initiateSellerPayout` | unchanged until caller identified |
| `invalidateBootstrapCache` | unchanged until caller identified |
| `inventoryDeductAVCO` | unchanged until caller identified |
| `inventoryFlushSyncQueue` | unchanged until caller identified |
| `inventoryFraudReport` | unchanged until caller identified |
| `inventoryGetAVCO` | unchanged until caller identified |
| `inventoryGetAVCOHistory` | unchanged until caller identified |
| `inventoryGetCOGSReport` | unchanged until caller identified |
| `inventoryUpdateAVCO` | unchanged until caller identified |
| `listDigitalProducts` | unchanged until caller identified |
| `listEntertainmentContent` | unchanged until caller identified |
| `listVehicles` | unchanged until caller identified |
| `listWebhooks` | unchanged until caller identified |
| `lockDevice` | unchanged until caller identified |
| `logSecurityEvent` | unchanged until caller identified |
| `moderateMediaContent` | unchanged until caller identified |
| `platformInfraDispatch` | unchanged until caller identified |
| `publishDigitalProduct` | unchanged until caller identified |
| `publishEntertainmentListing` | unchanged until caller identified |
| `publishVehicleListing` | unchanged until caller identified |
| `purchaseDigitalProduct` | unchanged until caller identified |
| `purchaseEntertainment` | unchanged until caller identified |
| `purgeCompleted` | unchanged until caller identified |
| `rateDigitalProduct` | unchanged until caller identified |
| `rateEntertainmentContent` | unchanged until caller identified |
| `recordSecurityEvent` | unchanged until caller identified |
| `recoverPaymentSession` | unchanged until caller identified |
| `redriveFromDLQ` | unchanged until caller identified |
| `refundToWallet` | unchanged until caller identified |
| `releaseEscrow` | unchanged until caller identified |
| `remoteLogout` | unchanged until caller identified |
| `remoteUpdate` | unchanged until caller identified |
| `replayWebhookDLQ` | unchanged until caller identified |
| `reportAIAbuse` | unchanged until caller identified |
| `reportVehicleListing` | unchanged until caller identified |
| `resolveUnmatchedPayment` | unchanged until caller identified |
| `runManualSelfHeal` | unchanged until caller identified |
| `runProductionCertification` | unchanged until caller identified |
| `runRecoveryPlaybook` | unchanged until caller identified |
| `sasosAcceptSeatInvite` | unchanged until caller identified |
| `sasosGetOrgSeats` | unchanged until caller identified |
| `sasosGetStorageUsage` | unchanged until caller identified |
| `sasosInviteSeat` | unchanged until caller identified |
| `scoreFraudRisk` | unchanged until caller identified |
| `sealPaymentAuditTrail` | unchanged until caller identified |
| `searchAutocomplete` | unchanged until caller identified |
| `searchBackfillAll` | unchanged until caller identified |
| `searchConfigUpdate` | unchanged until caller identified |
| `searchEntertainment` | unchanged until caller identified |
| `searchGetHealthHistory` | unchanged until caller identified |
| `searchGetSecuredKeys` | unchanged until caller identified |
| `searchGetUnifiedDashboard` | unchanged until caller identified |
| `searchNearby` | unchanged until caller identified |
| `searchPersonalized` | unchanged until caller identified |
| `searchQuery` | unchanged until caller identified |
| `searchQueueRecovery` | unchanged until caller identified |
| `searchRepairOrphanedDocs` | unchanged until caller identified |
| `searchResolveAlert` | unchanged until caller identified |
| `searchVehicles` | unchanged until caller identified |
| `searchVerifyDocument` | unchanged until caller identified |
| `spendFromWallet` | unchanged until caller identified |
| `submitVehicleEnquiry` | unchanged until caller identified |
| `terminateAllSessions` | unchanged until caller identified |
| `testSecretAccess` | unchanged until caller identified |
| `transitionPaymentState` | unchanged until caller identified |
| `triggerManualReconciliation` | unchanged until caller identified |
| `typesenseCanaryDeploy` | unchanged until caller identified |
| `typesenseCollectionStats` | unchanged until caller identified |
| `typesenseCreateAlias` | unchanged until caller identified |
| `typesenseForceRetry` | unchanged until caller identified |
| `typesenseRepairDivergent` | unchanged until caller identified |
| `typesenseReprocessDLQ` | unchanged until caller identified |
| `typesenseVerifyBackup` | unchanged until caller identified |
| `typesenseVerifyDoc` | unchanged until caller identified |
| `unlockDevice` | unchanged until caller identified |
| `updateDigitalProduct` | unchanged until caller identified |
| `updateRiskProfile` | unchanged until caller identified |
| `updateTicketTier` | unchanged until caller identified |
| `updateVehicleListing` | unchanged until caller identified |
| `verifyQRCode` | unchanged until caller identified |
| `verifyStorageIntegrity` | unchanged until caller identified |
| `walletV2EscrowCreate` | unchanged until caller identified |

## Sequence

1. Confirm Group 1 rows by opening the named client file.
2. For each confirmed row, verify the function enforces `request.auth` (and admin
   role where applicable) before granting `allUsers` invoker.
3. Grant, then re-run `node scripts/audit-callable-invokers.js --all --probe`.
4. Triage Group 2 by intended caller; record private ones as deliberate so a future
   audit does not re-flag them.
5. Exercise one real user flow per feature area — the audit proves reachability, not
   correctness.
