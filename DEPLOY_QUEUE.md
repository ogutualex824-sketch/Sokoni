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

## Full pending CF deploy (run as one command)

```powershell
npm config set fetch-timeout 3000; npm config set fetch-retry-mintimeout 1000; firebase deploy --only "functions:fosInitiatePayment,functions:fosSecureWebhook,functions:fosSubmitRefund,functions:fosApproveRefund,functions:fosGenerateInvoice,functions:fosExportReport,functions:fosGetProviderHealth,functions:fosGetAdminConsole,functions:subScheduleRenewals,functions:subAutoActivateOnPayment,functions:subUpgradeWithProration,functions:getSellerEarningsReport,functions:getAdminRevenueByHub,functions:getConversationContext,functions:searchConversations,functions:editMessage,functions:updateConversationStatus,functions:pcGetHubRegistry,functions:pcRegisterHub,functions:pcUpdateHubConfig,functions:pcGetFeatureFlags,functions:pcSetFeatureFlag,functions:pcGetCrossHubMetrics" --project sokoni-aeb26; npm config delete fetch-timeout; npm config delete fetch-retry-mintimeout
```

## Functions and their source files

| Function | File | Added |
|---|---|---|
| `pcGetHubRegistry` | `functions/platform-core.js` | 2026-07-06 |
| `pcRegisterHub` | `functions/platform-core.js` | 2026-07-06 |
| `pcUpdateHubConfig` | `functions/platform-core.js` | 2026-07-06 |
| `pcGetFeatureFlags` | `functions/platform-core.js` | 2026-07-06 |
| `pcSetFeatureFlag` | `functions/platform-core.js` | 2026-07-06 |
| `pcGetCrossHubMetrics` | `functions/platform-core.js` | 2026-07-06 |
| `fosInitiatePayment` | `functions/financial-os.js` | 2026-07-06 |
| `fosSecureWebhook` | `functions/financial-os.js` | 2026-07-06 |
| `fosSubmitRefund` | `functions/financial-os.js` | 2026-07-06 |
| `fosApproveRefund` | `functions/financial-os.js` | 2026-07-06 |
| `fosGenerateInvoice` | `functions/financial-os.js` | 2026-07-06 |
| `fosExportReport` | `functions/financial-os.js` | 2026-07-06 |
| `fosGetProviderHealth` | `functions/financial-os.js` | 2026-07-06 |
| `fosGetAdminConsole` | `functions/financial-os.js` | 2026-07-06 |
| `subScheduleRenewals` | `functions/sub-engine.js` | 2026-07-06 |
| `subAutoActivateOnPayment` | `functions/sub-engine.js` | 2026-07-06 |
| `subUpgradeWithProration` | `functions/sub-engine.js` | 2026-07-06 |
| `getSellerEarningsReport` | `functions/commission.js` | 2026-07-06 |
| `getAdminRevenueByHub` | `functions/commission.js` | 2026-07-06 |
| `getConversationContext` | `functions/messages.js` | 2026-07-06 |
| `searchConversations` | `functions/messages.js` | 2026-07-06 |
| `editMessage` | `functions/messages.js` | 2026-07-06 |
| `updateConversationStatus` | `functions/messages.js` | 2026-07-06 |

## Secrets required (set these first if not already set)
```bash
firebase functions:secrets:set INTASEND_PRIVATE_KEY  --project sokoni-aeb26
firebase functions:secrets:set LOYALTY_HMAC_SECRET   --project sokoni-aeb26
firebase functions:secrets:set PAYMENT_HMAC_SECRET   --project sokoni-aeb26
firebase functions:secrets:set PAYROLL_ENCRYPTION_KEY --project sokoni-aeb26
```

## Hosting (already deployed 2026-07-06)
All HTML/CSS/JS pages are LIVE. CF features will activate when quota clears.
New pages deployed today:
- `/seller-earnings` — Seller earnings dashboard
- `/revenue-dashboard` — Admin revenue dashboard
- `/my-subscriptions` — Universal subscription management portal
- `/fos-admin` — Financial OS admin console
