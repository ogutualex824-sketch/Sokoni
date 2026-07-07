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

**0/114 LIVE — All blocked by Cloud Run CPU quota (confirmed 2026-07-07)**

The quota was exhausted during the big 1,512-function update deploy. All new Cloud Run
service creations fail silently (only `pcGetHubRegistry` showed an explicit 429 in the log).
Verified via `firebase functions:list` — none of the 114 appear in the live list.

**To fix**: Request a GCP Cloud Run CPU quota increase:
1. GCP Console → IAM & Admin → Quotas
2. Filter: "Cloud Run Admin API" + "us-central1"
3. Find "Total CPU (all regions)" — request increase to 2000+ vCPUs

---

## MASTER DEPLOY COMMAND (all 114 CFs)

Run once when quota is cleared:

```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:fosInitiatePayment,functions:fosSecureWebhook,functions:fosSubmitRefund,functions:fosApproveRefund,functions:fosGenerateInvoice,functions:fosExportReport,functions:fosGetProviderHealth,functions:fosGetAdminConsole,functions:subScheduleRenewals,functions:subAutoActivateOnPayment,functions:subUpgradeWithProration,functions:getSellerEarningsReport,functions:getAdminRevenueByHub,functions:getConversationContext,functions:searchConversations,functions:editMessage,functions:updateConversationStatus,functions:pcGetHubRegistry,functions:pcRegisterHub,functions:pcUpdateHubConfig,functions:pcGetFeatureFlags,functions:pcSetFeatureFlag,functions:pcGetCrossHubMetrics,functions:asyncEnqueue,functions:asyncWorker,functions:asyncSweeper,functions:asyncEventRouter,functions:asyncCancel,functions:asyncRetryJob,functions:asyncPauseQueue,functions:asyncGetDashboard,functions:asyncGetJobs,functions:asyncInspect,functions:asyncCleanup,functions:opsGetMasterDashboard,functions:opsGetAlerts,functions:opsAcknowledgeAlert,functions:opsCreateAlert,functions:opsGetPostLaunchMetrics,functions:opsScheduledHealthCheck,functions:rollbackGetSnapshots,functions:rollbackCreateSnapshot,functions:rollbackTrigger,functions:rollbackGetExecutions,functions:rollbackUpdateStatus,functions:rollbackScheduledSnapshot,functions:recordPosEvent,functions:getPosPerfMetrics,functions:getPosSpeedReport,functions:posScheduledPerfRollup,functions:acknowledgeShift,functions:approveShiftSwap,functions:assignShift,functions:createShiftTemplate,functions:getRoster,functions:getRosterGaps,functions:getStaffRoster,functions:publishWeeklyRoster,functions:schedulerWeeklyDigest,functions:setStaffAvailability,functions:swapShiftRequest,functions:createSession,functions:detectSessionAnomaly,functions:getUserSessions,functions:revokeDeviceSessions,functions:rotateSession,functions:scheduledSessionCleanup,functions:terminateAllSessions,functions:terminateSession,functions:validateSession,functions:generateSecureUploadUrl,functions:getFileAuditLog,functions:onFileUploaded,functions:quarantineFile,functions:validateUploadRequest,functions:getLatestSecurityReport,functions:runSecurityAudit,functions:scheduleWeeklySecurityAudit,functions:getPOSInventoryIntelligence,functions:getProductSalesTrend,functions:earnLoyaltyPoints,functions:onInventoryUpdated,functions:onOrderCreated,functions:onPaymentCreated,functions:onPaymentUpdated,functions:onRiderStatusChange,functions:onUserCreated,functions:posCleanupPeripheralSignals,functions:posCreateCustomerDisplay,functions:posGetPeripherals,functions:posRegisterPeripheral,functions:posRemovePeripheral,functions:posUpdateCustomerDisplay,functions:posUpdatePeripheralStatus,functions:posGetApiDocs,functions:posGetEtimsExport,functions:posGetInventoryExport,functions:posGetLedgerExport,functions:posGetSalesExport,functions:posListApiKeys,functions:posReceiveErpUpdate,functions:posRegisterApiKey,functions:posRegisterWebhook,functions:posRevokeApiKey,functions:posRevokeWebhook,functions:posTestWebhook,functions:posGetTerminalBatchReport,functions:posGetTerminalCapabilities,functions:posGetTerminalHealth,functions:posPollTerminalStatus,functions:posReverseTerminalPayment,functions:posSettleTerminalBatch,functions:posTerminalEventWebhook" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

---

## Secrets required (set these first if not already set)
```bash
firebase functions:secrets:set INTASEND_PRIVATE_KEY       --project sokoni-aeb26
firebase functions:secrets:set LOYALTY_HMAC_SECRET        --project sokoni-aeb26
firebase functions:secrets:set PAYMENT_HMAC_SECRET        --project sokoni-aeb26
firebase functions:secrets:set PAYROLL_ENCRYPTION_KEY     --project sokoni-aeb26
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

### messages.js (4)
| Function | Type |
|---|---|
| `getConversationContext` | onCall auth |
| `searchConversations` | onCall auth |
| `editMessage` | onCall auth |
| `updateConversationStatus` | onCall auth |

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

## Hosting (already deployed 2026-07-06)
All HTML/CSS/JS pages are LIVE. CF features will activate when quota clears.
New pages deployed:
- `/seller-earnings` — Seller earnings dashboard
- `/revenue-dashboard` — Admin revenue dashboard
- `/my-subscriptions` — Universal subscription management portal
- `/fos-admin` — Financial OS admin console
- `/async-jobs` — Async Jobs Engine monitoring dashboard
