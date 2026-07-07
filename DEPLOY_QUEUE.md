# SOKONI CF Deploy Queue

All Cloud Functions below are code-complete and hosted. They are waiting for
Cloud Run quota to clear (quota typically resets within 24 hours).

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

## Status — 2026-07-07

**0/135 LIVE — All blocked by Cloud Run CPU quota (confirmed 2026-07-07)**
_(119 from previous queue + 6 Installments CFs + 7 Franchise CFs + 3 Message Lifecycle triggers)_

The quota was exhausted during the big 1,512-function update deploy. All new Cloud Run
service creations fail silently (only `pcGetHubRegistry` showed an explicit 429 in the log).
Verified via `firebase functions:list` — none of the 119 appear in the live list.

**To fix**: Request a GCP Cloud Run CPU quota increase:
1. GCP Console → IAM & Admin → Quotas
2. Filter: "Cloud Run Admin API" + "us-central1"
3. Find "Total CPU (all regions)" — request increase to 2000+ vCPUs

---

## MASTER DEPLOY COMMAND (all 135 CFs)

Run once when quota is cleared:

```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:fosInitiatePayment,functions:fosSecureWebhook,functions:fosSubmitRefund,functions:fosApproveRefund,functions:fosGenerateInvoice,functions:fosExportReport,functions:fosGetProviderHealth,functions:fosGetAdminConsole,functions:subScheduleRenewals,functions:subAutoActivateOnPayment,functions:subUpgradeWithProration,functions:getSellerEarningsReport,functions:getAdminRevenueByHub,functions:getConversationContext,functions:searchConversations,functions:editMessage,functions:updateConversationStatus,functions:pcGetHubRegistry,functions:pcRegisterHub,functions:pcUpdateHubConfig,functions:pcGetFeatureFlags,functions:pcSetFeatureFlag,functions:pcGetCrossHubMetrics,functions:asyncEnqueue,functions:asyncWorker,functions:asyncSweeper,functions:asyncEventRouter,functions:asyncCancel,functions:asyncRetryJob,functions:asyncPauseQueue,functions:asyncGetDashboard,functions:asyncGetJobs,functions:asyncInspect,functions:asyncCleanup,functions:opsGetMasterDashboard,functions:opsGetAlerts,functions:opsAcknowledgeAlert,functions:opsCreateAlert,functions:opsGetPostLaunchMetrics,functions:opsScheduledHealthCheck,functions:rollbackGetSnapshots,functions:rollbackCreateSnapshot,functions:rollbackTrigger,functions:rollbackGetExecutions,functions:rollbackUpdateStatus,functions:rollbackScheduledSnapshot,functions:recordPosEvent,functions:getPosPerfMetrics,functions:getPosSpeedReport,functions:posScheduledPerfRollup,functions:acknowledgeShift,functions:approveShiftSwap,functions:assignShift,functions:createShiftTemplate,functions:getRoster,functions:getRosterGaps,functions:getStaffRoster,functions:publishWeeklyRoster,functions:schedulerWeeklyDigest,functions:setStaffAvailability,functions:swapShiftRequest,functions:createSession,functions:detectSessionAnomaly,functions:getUserSessions,functions:revokeDeviceSessions,functions:rotateSession,functions:scheduledSessionCleanup,functions:terminateAllSessions,functions:terminateSession,functions:validateSession,functions:generateSecureUploadUrl,functions:getFileAuditLog,functions:onFileUploaded,functions:quarantineFile,functions:validateUploadRequest,functions:getLatestSecurityReport,functions:runSecurityAudit,functions:scheduleWeeklySecurityAudit,functions:getPOSInventoryIntelligence,functions:getProductSalesTrend,functions:earnLoyaltyPoints,functions:onInventoryUpdated,functions:onOrderCreated,functions:onPaymentCreated,functions:onPaymentUpdated,functions:onRiderStatusChange,functions:onUserCreated,functions:posCleanupPeripheralSignals,functions:posCreateCustomerDisplay,functions:posGetPeripherals,functions:posRegisterPeripheral,functions:posRemovePeripheral,functions:posUpdateCustomerDisplay,functions:posUpdatePeripheralStatus,functions:posGetApiDocs,functions:posGetEtimsExport,functions:posGetInventoryExport,functions:posGetLedgerExport,functions:posGetSalesExport,functions:posListApiKeys,functions:posReceiveErpUpdate,functions:posRegisterApiKey,functions:posRegisterWebhook,functions:posRevokeApiKey,functions:posRevokeWebhook,functions:posTestWebhook,functions:posGetTerminalBatchReport,functions:posGetTerminalCapabilities,functions:posGetTerminalHealth,functions:posPollTerminalStatus,functions:posReverseTerminalPayment,functions:posSettleTerminalBatch,functions:posTerminalEventWebhook,functions:currencyGetRates,functions:currencyConvert,functions:currencyUpdateRates,functions:currencyGetHistory,functions:currencyScheduledRateRefresh,functions:installmentCreatePlan,functions:installmentRecordPayment,functions:installmentGetMyPlans,functions:installmentGetSellerPlans,functions:installmentMarkOverdue,functions:installmentCancelPlan,functions:franchiseCreateBrand,functions:franchiseApplyForLocation,functions:franchiseReviewApplication,functions:franchiseRecordRoyalty,functions:franchiseGetMyLocations,functions:franchiseGetBrandDashboard,functions:franchiseGetLocations,functions:onOrderStatusChanged,functions:onBookingStatusChanged,functions:onFoodOrderStatusChanged" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

## Secrets required (set these first if not already set)
```bash
firebase functions:secrets:set INTASEND_PRIVATE_KEY       --project sokoni-aeb26
firebase functions:secrets:set LOYALTY_HMAC_SECRET        --project sokoni-aeb26
firebase functions:secrets:set PAYMENT_HMAC_SECRET        --project sokoni-aeb26
firebase functions:secrets:set PAYROLL_ENCRYPTION_KEY     --project sokoni-aeb26
firebase functions:secrets:set SOKONI_HMAC_KEY            --project sokoni-aeb26
firebase functions:secrets:set SENDGRID_API_KEY           --project sokoni-aeb26
```

### After quota clears: activate Redis rate limiting
Set `REDIS_URL` in `functions/.env` (and Secret Manager) once your Redis instance is provisioned.
Format: `rediss://:<password>@<host>:6379` (TLS required for production).

### eTIMS secrets (3 pending — contact KRA for credentials)
```bash
firebase functions:secrets:set ETIMS_DEVICE_SERIAL        --project sokoni-aeb26
firebase functions:secrets:set ETIMS_PIN                  --project sokoni-aeb26
firebase functions:secrets:set ETIMS_AES_KEY              --project sokoni-aeb26
```

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

## Hosting (already deployed 2026-07-06)
All HTML/CSS/JS pages are LIVE. CF features will activate when quota clears.
New pages deployed:
- `/seller-earnings` — Seller earnings dashboard
- `/revenue-dashboard` — Admin revenue dashboard
- `/my-subscriptions` — Universal subscription management portal
- `/fos-admin` — Financial OS admin console
- `/async-jobs` — Async Jobs Engine monitoring dashboard
