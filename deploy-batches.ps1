# SOKONI — Batched Cloud Functions Deploy
# Deploys all ~525 functions in batches of ≤25 to stay under the
# 240/min Cloud Run API mutation quota.
#
# BEFORE running this script, run once:
#   gcloud run services delete pos-print --region us-central1 --project sokoni-aeb26 --quiet
#   firebase deploy --only firestore:rules,firestore:indexes
#
# Run from the SOKONI root:
#   .\deploy-batches.ps1
#
# To resume after a failure on batch N:
#   .\deploy-batches.ps1 -StartBatch N
#
param([int]$StartBatch = 1)

$ErrorActionPreference = "Stop"

$batches = @(
  # ── Batch 1: Core A ──────────────────────────────────────────────────────
  "functions:acceptPlatformInvite,acceptShopInvite,activateAIPlan,activateSubscription,aggregateAnalytics,aggregateMediaStats,aggregatePlatformMetrics,aggregateSearchAnalytics,aggregateTrendingSearches,aggregateTypesenseAnalytics,algoliaAnalyticsCleanup,algoliaBackfill,algoliaCreateABTest,algoliaDeleteOrphans,algoliaEventAggregator,algoliaGetABTestResults,algoliaGetLatencyHistory,algoliaGetMonitorDashboard,algoliaGetQuerySuggestions,algoliaGetQueueStats,algoliaGetReconcileHistory,algoliaHealthCheck,algoliaKeyCleanup,algoliaKeyStats,algoliaMonitorCleanup",

  # ── Batch 2: Core B ──────────────────────────────────────────────────────
  "functions:algoliaMonitorEntries,algoliaMonitorHealth,algoliaPersonalizationStatus,algoliaQSRebuildStatus,algoliaQueueMonitor,algoliaRecommendAnalyticsCleanup,algoliaRecommendEvent,algoliaRecommendStatus,algoliaReconcile,algoliaReconcileStats,algoliaReindex,algoliaReprocessDLQ,algoliaResolveMonitorAlert,algoliaSetupDynamicReranking,algoliaSetupIndexes,algoliaSetupPersonalization,algoliaSetupQSIndexSettings,algoliaSetupQuerySuggestions,algoliaSetupRules,algoliaStopABTest,algoliaVerifyDoc,approveFinancialChange,bootstrapAdminClaim,cancelPayment,cleanupAuthRequests",

  # ── Batch 3: Scheduled + Fraud ───────────────────────────────────────────
  "functions:cleanupExpiredSubscriptions,cleanupIdempotencyStore,consumeAICredit,createAdCampaign,darajaSTKCallback,darajaSTKPush,deleteAlgoliaUserProfile,deleteMediaAsset,detectFraud,detectSubscriptionFraud,eccAlertCheck,eccCreateIncident,eccGetAuditLog,eccGetMetrics,eccHealthCheck,eccResolveIncident,eccWriteAudit,evaluateFraudRisk,expireOldEscrows,forecastRevenue,fraudBlock,generateEntitlementToken,generateMonthlyInvoices,generateProductMetadata,generateTrending",

  # ── Batch 4: Get/Query endpoints ─────────────────────────────────────────
  "functions:getAISubscriptionStats,getAdminRevenueReport,getAlgoliaFBT,getAlgoliaLookingSimilar,getAlgoliaMultiRecommend,getAlgoliaPersonalizationStrategy,getAlgoliaRelated,getAlgoliaSearchKey,getAlgoliaTrendingFacets,getAlgoliaTrendingItems,getAlgoliaUserProfile,getCommissionLedger,getLedgerBalance,getPlatformMetrics,getQueueStats,getRevenueConfig,getSearchAnalytics,getSecurityEvents,getSellerBillingReport,getSettlementReport,getTrendingSearches,getTsAutocompleteSuggestions,getTypesenseAnalytics,getTypesenseSearchKey,getUserClaims",

  # ── Batch 5: Payments + Auth (minInstances:1 on critical ones) ───────────
  "functions:grantAdminClaim,grantPlatformRole,indexProductCreate,indexProductUpdate,indexProviderCreate,initiateRefund,initiateSTKPush,initiateSellerPayout,intasendWebhook,inventoryAdjustStock,inventoryAggregateAnalytics,inventoryAiForecast,inventoryAiIdentifyProduct,inventoryAiQuery,inventoryAiReorderSuggestions,inventoryAlertWebhook,inventoryCalculateHealth,inventoryCleanupOldMovements,inventoryCreateBatch,inventoryCreateWorkOrder,inventoryCreateWorkflow,inventoryDailyForecasts,inventoryDeductBatch,inventoryDeleteVariant,inventoryDeleteWebhook",

  # ── Batch 6: Inventory A ─────────────────────────────────────────────────
  "functions:inventoryDeleteWorkflow,inventoryFlushSyncQueue,inventoryFraudOnMovement,inventoryFraudReport,inventoryFraudReview,inventoryFraudScan,inventoryGetAuditLog,inventoryGetBOM,inventoryGetBatches,inventoryGetExpiringBatches,inventoryGetFraudEvents,inventoryGetHealthHistory,inventoryGetImportJobs,inventoryGetPricingRecommendations,inventoryGetRecalls,inventoryGetSerials,inventoryGetSimulations,inventoryGetTransfers,inventoryGetVariants,inventoryGetWorkOrders,inventoryGetWorkflowRuns,inventoryGetWorkflows,inventoryHealthMonitor,inventoryImportAiMap,inventoryImportCommit",

  # ── Batch 7: Inventory B ─────────────────────────────────────────────────
  "functions:inventoryImportPreview,inventoryInitiateRecall,inventoryListWebhooks,inventoryOnMovement,inventoryPatchTransfer,inventoryPricingScheduler,inventoryProcessStockCount,inventoryRecallOnCreated,inventoryRecallReport,inventoryReceivePO,inventoryRegisterSerials,inventoryRegisterWebhook,inventoryReleaseReservation,inventoryRequestTransfer,inventoryReserveStock,inventorySaveBOM,inventorySaveVariant,inventoryScoreSupplier,inventorySetPricingRule,inventorySimulate,inventorySimulatePriceChange,inventoryTestWebhook,inventoryToggleWorkflow,inventoryTransferStock,inventoryUpdateRecallStatus",

  # ── Batch 8: Orders + Notifications (minInstances:1 on triggers) ─────────
  "functions:inventoryUpdateSerialStatus,inventoryUpdateWorkOrderStatus,inventoryWorkflowEvaluator,inventoryWorkflowOnStock,invitePlatformEmployee,inviteShopEmployee,kass,managerAuthNotify,markCommissionPaid,moderateMediaContent,onDeliveryStatusChange,onEventLogged,onMediaUploaded,onNewOrderCreated,onOrderConfirmed,onOrderStatusChange,onPlatformEventCreated,onRideStatusChange,onSellerBroadcast,onSellerPaymentCreated,pauseQueue,platformDeregisterService,platformGetCapabilityMatrix,platformGetDependencies,platformGetEventLog",

  # ── Batch 9: Platform + POS (posPrint freshly created after gcloud delete)
  "functions:platformGetHealth,platformGetRegistry,platformGetSubscriptions,platformHealth,platformHealthSweep,platformPublishEvent,platformRegisterService,platformRegisterSub,platformReplayEvents,platformUpdateHealth,posCancelTerminalPayment,posExtractProductsFromImage,posInitiateTerminalPayment,posPollTerminalPayment,posPrint,posSendSMS,previewEmailTemplate,processAlgoliaQueue,processSettlementQueue,processSubscriptionChange,processTypesenseQueue,proposeFinancialChange,purchaseFeaturedListing,purgeCompleted,reconcileBilling",

  # ── Batch 10: Records + SASOS A ──────────────────────────────────────────
  "functions:recordMetric,recordSearchEvent,recordTypesenseSearchEvent,recordUserActivity,redeemVoucher,redriveFromDLQ,registerManagerFCMToken,releaseEscrow,removePlatformEmployee,replayWebhookDLQ,resetAIUsage,resumeQueue,revokeAdminClaim,revokePlatformInvite,revokePlatformRole,revokeShopInvite,runSubscriptionBrain,sasosAcceptSeatInvite,sasosActivateLicense,sasosAdminListSubscriptions,sasosAdminRefund,sasosAdminUpdatePlanConfig,sasosAllocateCredits,sasosAllocateStorage,sasosCalculateProration",

  # ── Batch 11: SASOS B ────────────────────────────────────────────────────
  "functions:sasosCancel,sasosCheckFeature,sasosCheckQuota,sasosCreateInvoice,sasosCreateLicense,sasosCreateOrg,sasosDailyRevenue,sasosDeductCredits,sasosDunningCycle,sasosExpireTrials,sasosFraudScan,sasosGetBillingHistory,sasosGetChurnRisk,sasosGetCredits,sasosGetForecast,sasosGetFraudQueue,sasosGetInsights,sasosGetInvoices,sasosGetLicense,sasosGetOrg,sasosGetOrgSeats,sasosGetRecommendations,sasosGetRevenueSummary,sasosGetRiskProfile,sasosGetSegmentInsights",

  # ── Batch 12: SASOS C + Search A ─────────────────────────────────────────
  "functions:sasosGetStorageUsage,sasosGetSubscription,sasosGetUsage,sasosInviteSeat,sasosListPlans,sasosProcessRenewals,sasosRecordFailedPayment,sasosRecordUsage,sasosRemoveSeat,sasosReportFraud,sasosResetMonthlyUsage,sasosResolveRisk,sasosRevokeLicense,sasosRunBrain,sasosSubscribe,sasosSyncLegacy,sasosUpdateRiskScore,searchApplyIndexSettings,searchApplyRules,searchApplySynonyms,searchAutocomplete,searchBackfillAll,searchConfigUpdate,searchDLQSweep,searchFullReindex",

  # ── Batch 13: Search B ───────────────────────────────────────────────────
  "functions:searchGetHealthHistory,searchGetSecuredKeys,searchGetStats,searchGetUnifiedDashboard,searchHealth,searchIntent,searchNearby,searchPersonalized,searchQuery,searchQueueCoordinator,searchQueueRecovery,searchRepairAll,searchRepairOrphanedDocs,searchResolveAlert,searchScheduledReconcile,searchSetup,searchSimilar,searchSystemHealth,searchSystemReport,searchValidateIndexes,searchVerifyDocument,selfHealSubscriptions,sendBillingReminders,sendInvoiceEmail,sendTestSTKPush",

  # ── Batch 14: Typesense Admin + AI ───────────────────────────────────────
  "functions:setAlgoliaPersonalizationStrategy,sokoniChat,topupAICredits,tsEventAggregator,typesenseAnalyticsCleanup,typesenseBackfill,typesenseBackupCleanup,typesenseBackupDaily,typesenseCanaryDeploy,typesenseCollectionStats,typesenseCreateAlias,typesenseCreateCollections,typesenseDeleteOrphans,typesenseForceRetry,typesenseGetDashboard,typesenseHealthCheck,typesenseKeyCleanup,typesenseKeyStats,typesenseListBackups,typesenseMonitorCleanup,typesenseMonitorHealth,typesenseMonitorLatency,typesenseQueueMonitor,typesenseReconcile,typesenseRepairDivergent",

  # ── Batch 15: Typesense B + WAP + Payments ───────────────────────────────
  "functions:typesenseReprocessDLQ,typesenseResolveAlert,typesenseRestoreBackup,typesenseVerifyBackup,typesenseVerifyDoc,updateAIPlan,updateRevenueConfig,updateSellerSubscription,validateDarajaCredentials,verifyEntitlement,verifyIntasendPayment,verifyPaymentStatus,wapAdvanceWorkflow,wapApproveStep,wapDLQSweep,wapEscalateApprovals,wapGetDLQ,wapGetInstance,wapGetPendingApprovals,wapSaveDefinition,wapScheduledResume,wapTriggerWorkflow,wapWatchdog,webhookHealth,webhookIntasend",

  # ── Batch 16: Webhooks ───────────────────────────────────────────────────
  "functions:webhookMpesa,webhookSmartpos,webhookStripe",

  # ── Batch 17: algoliaSync triggers — products/sellers/providers/services/events ──
  "functions:algoliaSync_products_create,algoliaSync_products_update,algoliaSync_products_delete,algoliaSync_sellers_create,algoliaSync_sellers_update,algoliaSync_sellers_delete,algoliaSync_providers_create,algoliaSync_providers_update,algoliaSync_providers_delete,algoliaSync_services_create,algoliaSync_services_update,algoliaSync_services_delete,algoliaSync_events_create,algoliaSync_events_update,algoliaSync_events_delete,algoliaSync_properties_create,algoliaSync_properties_update,algoliaSync_properties_delete,algoliaSync_cars_create,algoliaSync_cars_update,algoliaSync_cars_delete,algoliaSync_digitalJobs_create,algoliaSync_digitalJobs_update,algoliaSync_digitalJobs_delete,algoliaSync_jobs_create",

  # ── Batch 18: algoliaSync triggers — remaining collections ───────────────
  "functions:algoliaSync_jobs_update,algoliaSync_jobs_delete,algoliaSync_users_create,algoliaSync_users_update,algoliaSync_users_delete,algoliaSync_categories_create,algoliaSync_categories_update,algoliaSync_categories_delete,algoliaSync_brands_create,algoliaSync_brands_update,algoliaSync_brands_delete,algoliaSync_collections_create,algoliaSync_collections_update,algoliaSync_collections_delete,algoliaSync_coupons_create,algoliaSync_coupons_update,algoliaSync_coupons_delete,algoliaSync_foods_create,algoliaSync_foods_update,algoliaSync_foods_delete,algoliaSync_stores_create,algoliaSync_stores_update,algoliaSync_stores_delete,algoliaSync_real_estate_create,algoliaSync_real_estate_update",

  # ── Batch 19: algoliaSync tail + searchSync triggers ─────────────────────
  "functions:algoliaSync_real_estate_delete,algoliaSync_vehicles_create,algoliaSync_vehicles_update,algoliaSync_vehicles_delete,searchSync_deals_onCreate,searchSync_deals_onUpdate,searchSync_deals_onDelete,searchSync_auctions_onCreate,searchSync_auctions_onUpdate,searchSync_auctions_onDelete,searchSync_vendors_onCreate,searchSync_vendors_onUpdate,searchSync_vendors_onDelete,searchSync_companies_onCreate,searchSync_companies_onUpdate,searchSync_companies_onDelete,searchSync_inventory_products_onCreate,searchSync_inventory_products_onUpdate,searchSync_inventory_products_onDelete,searchSync_orders_onCreate,searchSync_orders_onUpdate,searchSync_orders_onDelete",

  # ── Batch 20: ts_ triggers A — products/sellers/providers/events/propertyListings ──
  "functions:ts_products_onCreate,ts_products_onUpdate,ts_products_onDelete,ts_sellers_onCreate,ts_sellers_onUpdate,ts_sellers_onDelete,ts_providers_onCreate,ts_providers_onUpdate,ts_providers_onDelete,ts_events_onCreate,ts_events_onUpdate,ts_events_onDelete,ts_propertyListings_onCreate,ts_propertyListings_onUpdate,ts_propertyListings_onDelete,ts_cars_onCreate,ts_cars_onUpdate,ts_cars_onDelete,ts_digitalJobs_onCreate,ts_digitalJobs_onUpdate,ts_digitalJobs_onDelete,ts_digitalGigs_onCreate,ts_digitalGigs_onUpdate,ts_digitalGigs_onDelete,ts_users_onCreate",

  # ── Batch 21: ts_ triggers B — users/bnbListings/fitness/education/lawyers ──
  "functions:ts_users_onUpdate,ts_users_onDelete,ts_bnbListings_onCreate,ts_bnbListings_onUpdate,ts_bnbListings_onDelete,ts_fitness_clubs_onCreate,ts_fitness_clubs_onUpdate,ts_fitness_clubs_onDelete,ts_fitness_classes_onCreate,ts_fitness_classes_onUpdate,ts_fitness_classes_onDelete,ts_education_onCreate,ts_education_onUpdate,ts_education_onDelete,ts_lawyers_onCreate,ts_lawyers_onUpdate,ts_lawyers_onDelete,ts_reviews_onCreate,ts_reviews_onUpdate,ts_reviews_onDelete,ts_digitalReviews_onCreate,ts_digitalReviews_onUpdate,ts_digitalReviews_onDelete,ts_legalReviews_onCreate,ts_legalReviews_onUpdate",

  # ── Batch 22: ts_ triggers C — remaining + categories/brands/etc ─────────
  "functions:ts_legalReviews_onDelete,ts_categories_onCreate,ts_categories_onUpdate,ts_categories_onDelete,ts_brands_onCreate,ts_brands_onUpdate,ts_brands_onDelete,ts_collections_onCreate,ts_collections_onUpdate,ts_collections_onDelete,ts_coupons_onCreate,ts_coupons_onUpdate,ts_coupons_onDelete,ts_foods_onCreate,ts_foods_onUpdate,ts_foods_onDelete,ts_jobs_onCreate,ts_jobs_onUpdate,ts_jobs_onDelete,ts_hotels_onCreate,ts_hotels_onUpdate,ts_hotels_onDelete,ts_properties_onCreate,ts_properties_onUpdate,ts_properties_onDelete"
)

$totalBatches = $batches.Count
Write-Host ""
Write-Host "=== SOKONI Batched Deploy — $totalBatches batches of <=25 ===" -ForegroundColor Cyan
Write-Host ""

if ($StartBatch -gt 1) {
  Write-Host "Resuming from batch $StartBatch" -ForegroundColor Yellow
  Write-Host ""
}

for ($i = $StartBatch - 1; $i -lt $totalBatches; $i++) {
  $batchNum = $i + 1
  $spec     = $batches[$i]
  $fnCount  = ($spec -split ",").Count
  $preview  = $spec.Substring(10, [Math]::Min(80, $spec.Length - 10))

  Write-Host "[$batchNum/$totalBatches] $fnCount functions..." -ForegroundColor Green
  Write-Host "  $preview..." -ForegroundColor Gray

  $maxRetries = 5
  $attempt    = 0
  $succeeded  = $false
  while ($attempt -lt $maxRetries -and -not $succeeded) {
    $attempt++
    if ($attempt -gt 1) {
      Write-Host "  Retry $attempt/$maxRetries — waiting 5 min for Firebase to recover..." -ForegroundColor Yellow
      Start-Sleep -Seconds 300
    }
    firebase deploy --only $spec
    if ($LASTEXITCODE -eq 0) {
      $succeeded = $true
    } else {
      Write-Host "  Attempt $attempt failed (exit $LASTEXITCODE)" -ForegroundColor DarkYellow
    }
  }

  if (-not $succeeded) {
    Write-Host ""
    Write-Host "  FAILED: Batch $batchNum after $maxRetries attempts. Firebase infrastructure issue." -ForegroundColor Red
    Write-Host "  Wait 10+ minutes then resume:" -ForegroundColor Yellow
    Write-Host "  .\deploy-batches.ps1 -StartBatch $batchNum" -ForegroundColor Yellow
    Write-Host ""
    exit 1
  }

  Write-Host "  OK: Batch $batchNum done." -ForegroundColor Green

  if ($batchNum -lt $totalBatches) {
    Write-Host "  Waiting 35s..." -ForegroundColor Gray
    Start-Sleep -Seconds 35
  }
}

Write-Host ""
Write-Host "=== All $totalBatches batches deployed successfully ===" -ForegroundColor Green
Write-Host ""
