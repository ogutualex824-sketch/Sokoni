# deploy-new-functions.ps1
# Deploys all 69 new Cloud Functions from v1.1 + v1.2 sprint
# Run from the SOKONI project root: .\deploy-new-functions.ps1

$batches = @(
  "getMinishopPublic,claimMinishopHandle,saveMinishopConfig,trackMinishopView,getMinishopAnalytics",
  "generateMinishopShareCard,aiGenerateMinishopContent,followShop,getMyMinishop",
  "createMinishopCampaign,getMinishopCampaigns,trackCampaignClick,pauseMinishopCampaign,deleteMinishopCampaign",
  "getMerchantHealthScore,getAICoachInsights,getMerchantCRM,getInventoryInsights,getMerchantFinancials",
  "getMerchantBenchmarks,getMerchantOpportunities,createMerchantAutomation,getMerchantAutomations",
  "getMerchantAcademy,completeMerchantLesson",
  "getLoyaltyAccount,earnLoyaltyPoints,redeemLoyaltyPoints,confirmLoyaltyRedemption,getLoyaltyHistory",
  "getLoyaltyTiers,adminAdjustPoints,getLoyaltyLeaderboard",
  "getWalletBalance,initiateWalletTopUp,confirmWalletTopUp,spendFromWallet,getWalletTransactions",
  "requestSellerPayout,getPayoutHistory,adminProcessPayout,adminGetPendingPayouts,refundToWallet",
  "createJob,updateJob,closeJob,listJobs,getJob",
  "applyForJob,getJobApplications,updateApplicationStatus,getMyApplications,saveJobSeekerProfile",
  "getJobSeekerProfile,getFeaturedJobs",
  "generateSecureQR,verifyQRCode,getMyQRAssets",
  "listCourses,getCourse,enrollCourse,getCourseProgress,updateCourseProgress",
  "reviewCourse,createCourse,getMyEnrollments",
  "setUserRole,suspendUser,sendPlatformBroadcast"
)

$total = $batches.Count
$i = 1

foreach ($batch in $batches) {
  Write-Host "[$i/$total] Deploying: $batch" -ForegroundColor Cyan
  firebase deploy --only "functions:$batch"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  FAILED on first try, retrying after 10s..." -ForegroundColor Red
    Start-Sleep -Seconds 10
    firebase deploy --only "functions:$batch"
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  STILL FAILED - continuing to next batch" -ForegroundColor Red
    }
  }
  Write-Host "  Batch $i done. Pausing 15s..." -ForegroundColor Green
  if ($i -lt $total) { Start-Sleep -Seconds 15 }
  $i++
}

Write-Host "All functions deployed!" -ForegroundColor Green
