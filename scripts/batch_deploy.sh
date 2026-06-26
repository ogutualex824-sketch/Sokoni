#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# SOKONI Cloud Functions — Batch Deployment Script
# 430 functions across 15 batches (~30 per batch)
# Deploys most-critical first; 30s pause between batches
# Usage: bash scripts/batch_deploy.sh [batch_number]
#   No arg  → deploy all batches
#   e.g. 3  → deploy only batch 3
# ══════════════════════════════════════════════════════════════

set -e
PAUSE=30   # seconds between batches
START_BATCH=${1:-1}
END_BATCH=15

GREEN="\033[0;32m"; AMBER="\033[0;33m"; RED="\033[0;31m"; NC="\033[0m"
log()  { echo -e "${GREEN}[DEPLOY]${NC} $*"; }
warn() { echo -e "${AMBER}[WARN]${NC}  $*"; }
fail() { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

deploy_batch() {
  local num=$1; local label=$2; shift 2
  local funcs=("$@")

  [[ $num -lt $START_BATCH ]] && return 0

  echo ""
  log "════════════════════════════════════"
  log "Batch $num/15 — $label (${#funcs[@]} functions)"
  log "════════════════════════════════════"

  local only_arg=""
  for f in "${funcs[@]}"; do
    only_arg+="functions:${f},"
  done
  only_arg="${only_arg%,}"

  if firebase deploy --only "$only_arg" --project sokoni-aeb26; then
    log "Batch $num complete ✅"
  else
    warn "Batch $num had errors — check Firebase Console before continuing"
    read -p "Continue to next batch? (y/N) " cont
    [[ "$cont" != "y" && "$cont" != "Y" ]] && fail "Deployment paused at batch $num."
  fi

  if [[ $num -lt $END_BATCH ]]; then
    log "Waiting ${PAUSE}s before next batch…"
    sleep $PAUSE
  fi
}

log "SOKONI Functions Batch Deployment"
log "Firebase project: sokoni-aeb26"
log "Starting at batch: $START_BATCH"
echo ""

# ──────────────────────────────────────────────────────────────
# BATCH 1 — Auth & Admin Claims (HIGHEST PRIORITY)
# ──────────────────────────────────────────────────────────────
deploy_batch 1 "Auth & Admin Claims" \
  bootstrapAdminClaim grantAdminClaim revokeAdminClaim getUserClaims \
  grantPlatformRole revokePlatformRole \
  invitePlatformEmployee acceptPlatformInvite revokePlatformInvite removePlatformEmployee \
  inviteShopEmployee acceptShopInvite revokeShopInvite

# ──────────────────────────────────────────────────────────────
# BATCH 2 — Payments & Webhooks (REVENUE CRITICAL)
# ──────────────────────────────────────────────────────────────
deploy_batch 2 "Payments & Webhooks" \
  createCheckoutSession verifyIntasendPayment verifyPaymentStatus \
  darajaSTKPush darajaSTKCallback validateDarajaCredentials sendTestSTKPush \
  initiateSTKPush intasendWebhook cancelPayment \
  webhookIntasend webhookMpesa webhookStripe webhookSmartpos replayWebhookDLQ webhookHealth \
  releaseEscrow initiateRefund getSettlementReport initiateSellerPayout getLedgerBalance \
  expireOldEscrows cleanupIdempotencyStore processSettlementQueue getPaymentAuditTrail

# ──────────────────────────────────────────────────────────────
# BATCH 3 — Orders, Seller Core & Comms
# ──────────────────────────────────────────────────────────────
deploy_batch 3 "Orders, Seller Core & Comms" \
  onOrderStatusChange onOrderConfirmed onNewOrderCreated onSellerPaymentCreated \
  onSellerBroadcast kass sokoniChat \
  getRevenueConfig updateRevenueConfig getSellerBillingReport getAdminRevenueReport \
  getCommissionLedger markCommissionPaid generateMonthlyInvoices \
  purchaseFeaturedListing createAdCampaign updateSellerSubscription \
  sendInvoiceEmail posSendSMS

# ──────────────────────────────────────────────────────────────
# BATCH 4 — POS, Rides & Delivery
# ──────────────────────────────────────────────────────────────
deploy_batch 4 "POS, Rides & Delivery" \
  posExtractProductsFromImage posInitiateTerminalPayment posPollTerminalPayment \
  posCancelTerminalPayment posPrint \
  onRideStatusChange onDeliveryStatusChange processScheduledDeliveries \
  managerAuthNotify cleanupAuthRequests registerManagerFCMToken

# ──────────────────────────────────────────────────────────────
# BATCH 5 — Platform Health, Analytics & Fraud
# ──────────────────────────────────────────────────────────────
deploy_batch 5 "Platform Health, Analytics & Fraud" \
  platformHealth getPlatformMetrics getPlatformHealthScores getTopBusinessPriorities \
  systemHealthCheck cspReportCollect \
  recordMetric aggregateAnalytics generateTrending recordUserActivity aggregatePlatformMetrics \
  detectFraud getSecurityEvents evaluateFraudRisk fraudBlock getSecuritySummary \
  activateSubscription redeemVoucher cleanupExpiredSubscriptions \
  aggregateTrendingSearches

# ──────────────────────────────────────────────────────────────
# BATCH 6 — Ops, Reporting & Retention
# ──────────────────────────────────────────────────────────────
deploy_batch 6 "Ops, Reporting & Retention" \
  scheduledDailyOpsReport scheduledWeeklySecurityReport getDailyReport getWeeklyReports \
  recordFunnelEvent getFunnelMetrics recordHealthSnapshot getReliabilityMetrics \
  getBusinessMetrics getOrderTrends getOpsStatus \
  submitFeedback getFeedbackItems updateFeedbackStatus \
  testPushNotification testEmailDelivery \
  getListingQualityReport getSellerPerformanceSummary getMarketplaceSellerHealth \
  recordRecentlyViewed saveSearch deleteSavedSearch createPriceAlert deletePriceAlert \
  triggerPriceAlerts getRetentionData getMarketplaceQualityReport \
  flagLowQualityListing getSearchInsights getZeroResultTerms recordSearchQuery

# ──────────────────────────────────────────────────────────────
# BATCH 7 — Product Analytics, Search Indexing & Media
# ──────────────────────────────────────────────────────────────
deploy_batch 7 "Product Analytics, Indexing & Media" \
  recordProductView onProductPriceChanged onOrderPaidUpdateStats \
  aggregateProductStats aggregateSellerPerformance computeProductTrending \
  getProductTrustData getAdminProductAnalytics cleanupProductViewDedup \
  indexProductCreate indexProductUpdate indexProviderCreate onEventLogged \
  generateProductMetadata moderateMediaContent deleteMediaAsset onMediaUploaded aggregateMediaStats \
  scheduledFirestoreBackup fetchEPRAFuelPrices triggerEPRAFuelFetch \
  previewEmailTemplate getQueueStats purgeCompleted pauseQueue resumeQueue redriveFromDLQ

# ──────────────────────────────────────────────────────────────
# BATCH 8 — Algolia Queue & Core Setup
# ──────────────────────────────────────────────────────────────
deploy_batch 8 "Algolia Queue & Core Setup" \
  processAlgoliaQueue algoliaReprocessDLQ algoliaQueueMonitor \
  algoliaSetupIndexes algoliaBackfill algoliaReindex algoliaHealthCheck \
  algoliaGetQueueStats algoliaDeleteOrphans \
  algoliaSetupRules algoliaSetupPersonalization algoliaSetupDynamicReranking \
  algoliaCreateABTest algoliaGetABTestResults algoliaStopABTest \
  searchApplyIndexSettings searchValidateIndexes searchApplySynonyms searchApplyRules \
  getAlgoliaSearchKey algoliaKeyStats algoliaKeyCleanup \
  algoliaReconcile algoliaVerifyDoc algoliaGetReconcileHistory algoliaReconcileStats

# ──────────────────────────────────────────────────────────────
# BATCH 9 — Algolia Analytics, Recommendations & Personalisation
# ──────────────────────────────────────────────────────────────
deploy_batch 9 "Algolia Analytics, Recommendations & Personalisation" \
  recordSearchEvent algoliaEventAggregator aggregateSearchAnalytics \
  getSearchAnalytics getTrendingSearches algoliaAnalyticsCleanup \
  getAlgoliaFBT getAlgoliaRelated getAlgoliaTrendingItems getAlgoliaTrendingFacets \
  getAlgoliaLookingSimilar getAlgoliaMultiRecommend \
  algoliaRecommendEvent algoliaRecommendStatus algoliaRecommendAnalyticsCleanup \
  algoliaSetupQuerySuggestions algoliaGetQuerySuggestions algoliaQSRebuildStatus algoliaSetupQSIndexSettings \
  setAlgoliaPersonalizationStrategy getAlgoliaPersonalizationStrategy \
  getAlgoliaUserProfile deleteAlgoliaUserProfile algoliaPersonalizationStatus \
  algoliaMonitorHealth algoliaMonitorEntries algoliaGetMonitorDashboard \
  algoliaGetLatencyHistory algoliaResolveMonitorAlert algoliaMonitorCleanup

# ──────────────────────────────────────────────────────────────
# BATCH 10 — Typesense Core
# ──────────────────────────────────────────────────────────────
deploy_batch 10 "Typesense Core" \
  processTypesenseQueue typesenseReprocessDLQ typesenseForceRetry typesenseQueueMonitor \
  typesenseCreateCollections typesenseBackfill typesenseHealthCheck \
  typesenseDeleteOrphans typesenseCreateAlias typesenseCollectionStats typesenseCanaryDeploy \
  typesenseReconcile typesenseRepairDivergent typesenseVerifyDoc \
  typesenseMonitorHealth typesenseMonitorLatency typesenseGetDashboard \
  typesenseResolveAlert typesenseMonitorCleanup \
  typesenseBackupDaily typesenseBackupCleanup typesenseListBackups \
  typesenseVerifyBackup typesenseRestoreBackup \
  getTypesenseSearchKey typesenseKeyStats typesenseKeyCleanup \
  recordTypesenseSearchEvent tsEventAggregator aggregateTypesenseAnalytics \
  getTypesenseAnalytics getTsAutocompleteSuggestions typesenseAnalyticsCleanup

# ──────────────────────────────────────────────────────────────
# BATCH 11 — Unified Search Platform
# ──────────────────────────────────────────────────────────────
deploy_batch 11 "Unified Search Platform" \
  searchSetup searchBackfillAll searchSystemReport searchGetSecuredKeys \
  searchConfigUpdate searchGetStats \
  searchQuery searchAutocomplete searchNearby searchSimilar searchPersonalized searchIntent \
  searchGetUnifiedDashboard searchSystemHealth searchGetHealthHistory searchResolveAlert \
  searchRepairAll searchVerifyDocument searchFullReindex searchRepairOrphanedDocs \
  searchScheduledReconcile searchQueueCoordinator searchDLQSweep searchQueueRecovery searchHealth

# ──────────────────────────────────────────────────────────────
# BATCH 12 — Inventory Core & AI
# ──────────────────────────────────────────────────────────────
deploy_batch 12 "Inventory Core & AI" \
  inventoryAdjustStock inventoryReserveStock inventoryReleaseReservation \
  inventoryTransferStock inventoryReceivePO inventoryProcessStockCount \
  inventoryAggregateAnalytics inventoryOnMovement inventoryCleanupOldMovements \
  inventoryAiQuery inventoryAiForecast inventoryAiReorderSuggestions inventoryAiIdentifyProduct \
  inventoryDailyForecasts inventoryCalculateHealth inventoryGetHealthHistory inventoryHealthMonitor \
  inventoryFraudOnMovement inventoryFraudScan inventoryGetFraudEvents \
  inventoryFraudReview inventoryFraudReport \
  inventorySimulate inventoryGetSimulations \
  inventoryInitiateRecall inventoryGetRecalls inventoryUpdateRecallStatus \
  inventoryRecallReport inventoryRecallOnCreated \
  inventoryImportAiMap inventoryImportPreview inventoryImportCommit inventoryGetImportJobs

# ──────────────────────────────────────────────────────────────
# BATCH 13 — Inventory Webhooks, Workflows, Pricing & Variants
# ──────────────────────────────────────────────────────────────
deploy_batch 13 "Inventory Webhooks, Workflows, Pricing & Variants" \
  inventoryRegisterWebhook inventoryListWebhooks inventoryDeleteWebhook \
  inventoryTestWebhook inventoryAlertWebhook \
  inventoryWorkflowEvaluator inventoryWorkflowOnStock inventoryCreateWorkflow \
  inventoryGetWorkflows inventoryToggleWorkflow inventoryDeleteWorkflow inventoryGetWorkflowRuns \
  inventoryGetPricingRecommendations inventorySetPricingRule \
  inventorySimulatePriceChange inventoryPricingScheduler \
  inventorySaveVariant inventoryGetVariants inventoryDeleteVariant \
  inventoryCreateBatch inventoryDeductBatch inventoryGetBatches inventoryGetExpiringBatches \
  inventoryRegisterSerials inventoryUpdateSerialStatus inventoryGetSerials \
  inventorySaveBOM inventoryGetBOM inventoryCreateWorkOrder \
  inventoryUpdateWorkOrderStatus inventoryGetWorkOrders \
  inventoryRequestTransfer inventoryPatchTransfer inventoryGetTransfers \
  inventoryScoreSupplier inventoryFlushSyncQueue inventoryGetAuditLog

# ──────────────────────────────────────────────────────────────
# BATCH 14 — AI Subscriptions, Subscription OS & WAP
# ──────────────────────────────────────────────────────────────
deploy_batch 14 "AI Subscriptions, Subscription OS & WAP" \
  activateAIPlan consumeAICredit topupAICredits resetAIUsage \
  getAISubscriptionStats updateAIPlan \
  generateEntitlementToken verifyEntitlement processSubscriptionChange detectSubscriptionFraud \
  proposeFinancialChange approveFinancialChange forecastRevenue \
  runSubscriptionBrain selfHealSubscriptions sendBillingReminders reconcileBilling \
  wapTriggerWorkflow wapAdvanceWorkflow wapApproveStep wapScheduledResume \
  wapGetInstance wapGetPendingApprovals wapSaveDefinition \
  wapEscalateApprovals wapWatchdog wapDLQSweep wapGetDLQ \
  eccHealthCheck eccAlertCheck eccGetMetrics \
  eccCreateIncident eccResolveIncident eccWriteAudit eccGetAuditLog

# ──────────────────────────────────────────────────────────────
# BATCH 15 — SASOS & Platform Registry (FINAL)
# ──────────────────────────────────────────────────────────────
deploy_batch 15 "SASOS & Platform Registry" \
  sasosSubscribe sasosCancel sasosGetSubscription sasosListPlans sasosCheckFeature \
  sasosAdminListSubscriptions sasosAdminUpdatePlanConfig \
  sasosExpireTrials sasosProcessRenewals sasosSyncLegacy \
  sasosCreateInvoice sasosGetInvoices sasosGetBillingHistory \
  sasosAdminRefund sasosCalculateProration sasosDunningCycle sasosRecordFailedPayment \
  sasosDailyRevenue sasosGetRevenueSummary \
  sasosRecordUsage sasosGetUsage sasosCheckQuota \
  sasosDeductCredits sasosAllocateCredits sasosGetCredits \
  sasosAllocateStorage sasosGetStorageUsage sasosResetMonthlyUsage \
  sasosUpdateRiskScore sasosGetRiskProfile sasosReportFraud sasosResolveRisk \
  sasosFraudScan sasosGetFraudQueue \
  sasosRunBrain sasosGetInsights sasosGetRecommendations \
  sasosGetForecast sasosGetChurnRisk sasosGetSegmentInsights \
  sasosCreateOrg sasosGetOrg sasosInviteSeat sasosAcceptSeatInvite \
  sasosRemoveSeat sasosGetOrgSeats \
  sasosCreateLicense sasosActivateLicense sasosRevokeLicense sasosGetLicense \
  platformRegisterService platformGetRegistry platformUpdateHealth platformGetHealth \
  platformDeregisterService platformGetDependencies platformGetCapabilityMatrix platformHealthSweep \
  platformPublishEvent platformGetEventLog platformRegisterSub \
  platformGetSubscriptions platformReplayEvents onPlatformEventCreated

# ──────────────────────────────────────────────────────────────
echo ""
log "══════════════════════════════════════════"
log "All batches complete. Verify in Firebase Console:"
log "  https://console.firebase.google.com/project/sokoni-aeb26/functions"
log "══════════════════════════════════════════"
