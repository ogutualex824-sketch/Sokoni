---
tags: [reference, appendices, glossary, firestore, secrets, deployment]
---

# SOKONI Platform — Appendices

**Volume:** Appendices (Supplementary Reference)
**Series:** SOKONI Technical Documentation — 18-Volume Series
**Project:** sokoni-aeb26 · Region: us-central1
**Last Updated:** 2026-07-05
**Status:** Living Document

> This volume consolidates cross-cutting reference material for the entire SOKONI platform. It is intended to be the single source of truth for collection schemas, secrets, index budgets, statutory rates, and the deployment runbook. All other volumes link here rather than duplicating this information.

**Related Volumes:**
- [[vol-01-vision-architecture]] — System Design Overview
- [[vol-02-identity-security]] — Auth & Access Control
- [[vol-03-pos-enterprise]] — SmartPOS 3.0/4.0
- [[vol-04-payments]] — Payment FSM & FinOS
- [[vol-05-accounting]] — Ledger, Payroll & Tax
- [[vol-06-inventory-warehousing]] — Inventory & AVCO
- [[vol-07-marketplace-commerce]] — Commerce OS
- [[vol-08-loyalty-platform]] — Loyalty & Rewards
- [[vol-09-delivery-logistics]] — Dispatch & Routing
- [[vol-10-artificial-intelligence]] — KASS & AI Engines
- [[vol-11-crm-marketing]] — CRM & Campaigns
- [[vol-12-hr-workforce]] — HR & Payroll
- [[vol-13-foundation]] — Platform Core & Registry
- [[vol-14-analytics-bi]] — Analytics & BI
- [[vol-15-enterprise-operations]] — Ops Center & Self-Heal
- [[vol-17-testing-qa]] — Testing & QA
- [[vol-18-production-certification]] — Certification & Release

---

## Appendix A — Firestore Collection Reference

> Complete schema reference for all known Firestore collections across both databases. The primary `(default)` database handles transactional and user-facing data. The `sokoni-ops` database handles admin, monitoring, and audit data to preserve index budget. See [[vol-01-vision-architecture]] for the data architecture rationale.

### A.1 Core Platform Collections

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `users/{uid}` | User profile and platform identity | `uid`, `email`, `displayName`, `phone`, `role` (guest/buyer/seller/driver/admin), `loyaltyPoints`, `walletBalance`, `kycStatus`, `appCheckVerified`, `createdAt`, `updatedAt` |
| `merchants/{merchantId}` | Business entity — vendor or service provider | `name`, `ownerId`, `verified`, `subscriptionTier`, `commissionRate`, `kycStatus`, `location`, `categories[]`, `rating`, `totalSales`, `createdAt` |
| `branches/{branchId}` | Physical branch of a merchant | `merchantId`, `name`, `location` (GeoPoint), `address`, `hours`, `phone`, `active`, `posEnabled` |
| `products/{productId}` | Marketplace product listings | `merchantId`, `title`, `description`, `category`, `subcategory`, `price`, `stock`, `images[]`, `sku`, `barcode`, `status` (active/draft/suspended), `tags[]`, `createdAt` |
| `orders/{orderId}` | Customer purchase orders | `buyerId`, `sellerId`, `items[]`, `state` (FSM), `totalAmount`, `deliveryFee`, `paymentId`, `deliveryId`, `createdAt`, `updatedAt`, `cancelReason` |
| `payments/{paymentId}` | Payment lifecycle records (12-state FSM) | `orderId`, `buyerId`, `amount`, `currency` (KES), `method` (mpesa/card/wallet), `state`, `intaSendRef`, `mpesaCode`, `idempotencyKey`, `createdAt`, `completedAt` |
| `walletTransactions/{txId}` | Double-entry wallet ledger | `uid`, `type` (credit/debit), `amount`, `balanceBefore`, `balanceAfter`, `reference`, `description`, `createdAt` |
| `disbursements/{id}` | Payouts to sellers and drivers | `recipientId`, `recipientType` (seller/driver), `amount`, `method`, `status`, `mpesaCode`, `approvedBy`, `createdAt`, `processedAt` |
| `reviews/{reviewId}` | Product and vendor reviews | `targetId`, `targetType` (product/vendor), `authorId`, `rating` (1-5), `comment`, `moderationStatus` (pending/approved/rejected), `createdAt` |
| `notifications/{notifId}` | User notification inbox | `uid`, `type`, `title`, `body`, `priority` (1-5), `category`, `read`, `actionUrl`, `createdAt` |

### A.2 POS & Device Management Collections

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `posDevices/{deviceId}` | Registered POS terminals | `merchantId`, `branchId`, `deviceType`, `serialNumber`, `lastHeartbeat`, `heartbeatAt`, `status` (active/offline/suspended), `remoteCommand`, `swVersion`, `registeredAt` |
| `posSession/{sessionId}` | Cashier shift sessions | `deviceId`, `cashierId`, `merchantId`, `branchId`, `openingFloat`, `closingFloat`, `totalSales`, `totalRefunds`, `salesCount`, `startedAt`, `endedAt`, `status` (open/closed) |
| `posSales/{saleId}` | Completed POS sales with receipts | `sessionId`, `deviceId`, `merchantId`, `cashierId`, `items[]`, `subtotal`, `tax`, `discount`, `total`, `paymentMethod`, `mpesaCode`, `receiptNumber`, `printStatus`, `etimsSubmitted`, `createdAt` |
| `bootstrapCache/{merchantId_branchId}` | 5-minute TTL device config bundle | `merchantId`, `branchId`, `products[]`, `staff[]`, `discounts[]`, `taxConfig`, `printConfig`, `loyaltyConfig`, `version`, `expiresAt`, `cachedAt` |
| `syncQueue/{itemId}` | Offline transaction queue awaiting sync | `deviceId`, `type` (sale/refund/adjustment), `payload`, `attempts`, `lastAttemptAt`, `status` (pending/syncing/synced/failed), `createdAt` |

**sokoni-ops database only:**

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `deviceAuditLog/{logId}` | Immutable device event log | `deviceId`, `event` (login/sale/refund/config-change), `actorId`, `payload`, `ipAddress`, `createdAt` |

### A.3 Loyalty & Rewards Collections

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `loyaltyAccounts/{uid}` | Customer loyalty tier and balance | `uid`, `tier` (Bronze/Silver/Gold/Platinum), `pointsBalance`, `lifetimePoints`, `tierUpdatedAt`, `cardQr` (SKN-XXXX format), `hmacSignature`, `createdAt` |
| `loyaltyTransactions/{txId}` | Point earn and redeem history | `uid`, `type` (earn/redeem/expire/adjust), `points`, `balanceBefore`, `balanceAfter`, `sourceType` (purchase/referral/bonus), `sourceId`, `merchantId`, `createdAt` |
| `loyaltyGiftCards/{cardId}` | Gift card issuance and balance | `code`, `issuedTo`, `balance`, `originalAmount`, `currency`, `status` (active/used/expired), `transactions[]`, `expiresAt`, `createdAt` |
| `luckyDraws/{drawId}` | Lucky draw configuration and entries | `name`, `merchantId`, `prizeDescription`, `entryMethod`, `entries[]`, `winnerId`, `status` (upcoming/active/drawn), `drawDate`, `createdAt` |
| `cashbackLedger/{id}` | Cashback accrual and redemption | `uid`, `merchantId`, `type` (accrual/redemption), `amount`, `orderId`, `status` (pending/confirmed/redeemed), `confirmedAt`, `createdAt` |

### A.4 Commerce Collections

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `carts/{uid}` | Active customer shopping cart | `uid`, `items[]` (productId, qty, price, merchantId), `subtotal`, `updatedAt` |
| `wishlist/{uid}/items/{productId}` | Saved products per user | `productId`, `title`, `price`, `image`, `merchantId`, `addedAt` |
| `vendors/{vendorId}` | Marketplace vendor profiles | `uid`, `businessName`, `category`, `verified`, `rating`, `totalReviews`, `responseRate`, `joinedAt` |
| `commissionLedger/{id}` | Platform commission records | `orderId`, `merchantId`, `grossAmount`, `commissionRate`, `commissionAmount`, `vatOnCommission`, `whtAmount`, `netCommission`, `status`, `createdAt` |
| `subscriptions/{subId}` | Merchant subscription billing | `merchantId`, `planId`, `status` (TRIALING/ACTIVE/GRACE/EXPIRED), `billingCycle`, `amount`, `nextBillingAt`, `gracePeriodEndsAt`, `createdAt` |

### A.5 Delivery & Logistics Collections

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `deliveries/{deliveryId}` | Delivery job lifecycle | `orderId`, `driverId`, `customerId`, `merchantId`, `pickupLocation` (GeoPoint), `dropLocation` (GeoPoint), `status` (9-stage), `distance`, `fee`, `eta`, `otp`, `signatureUrl`, `createdAt`, `deliveredAt` |
| `drivers/{driverId}` | Driver profile and vehicle info | `uid`, `name`, `phone`, `vehicleType`, `plateNumber`, `nationalId`, `rating`, `totalDeliveries`, `cancellationCount`, `suspended`, `walletBalance`, `onlineStatus`, `currentLocation` (GeoPoint) |
| `driverEarnings/{id}` | Driver payout records | `driverId`, `deliveryId`, `grossEarning`, `platformFee`, `netEarning`, `status` (pending/paid), `paidAt`, `createdAt` |
| `fleetVehicles/{vehicleId}` | Fleet management records | `ownerId`, `make`, `model`, `year`, `plate`, `vehicleType`, `capacity`, `status` (available/assigned/maintenance), `lastServiceAt`, `mileage`, `assignedDriverId` |

### A.6 Financial & Accounting Collections

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `ledgerEntries/{id}` | Double-entry journal lines | `journalId`, `accountId`, `type` (debit/credit), `amount`, `currency`, `description`, `reference`, `createdAt` |
| `accounts/{accountId}` | Chart of accounts | `code`, `name`, `type` (asset/liability/equity/revenue/expense), `parentId`, `tenantId`, `balance`, `currency`, `active` |
| `taxReturns/{id}` | VAT and WHT periodic filings | `tenantId`, `period`, `type` (VAT/WHT), `grossAmount`, `taxAmount`, `status` (draft/filed/paid), `kraReference`, `filedAt`, `dueDate` |
| `payrollRuns/{runId}` | Monthly payroll batches with Kenya deductions | `tenantId`, `period`, `employeeCount`, `totalGross`, `totalPAYE`, `totalNHIF`, `totalNSSF`, `totalHousingLevy`, `totalNet`, `status` (draft/approved/disbursed), `approvedBy`, `processedAt` |
| `employees/{employeeId}` | Staff records under merchant tenants | `tenantId`, `name`, `nationalId`, `kraPin`, `nhifNo`, `nssfNo`, `jobTitle`, `department`, `grossSalary`, `bankAccount` (encrypted), `active`, `joinedAt` |

### A.7 Search & Indexing Collections

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `algoliaQueue/{id}` | Pending Algolia index operations | `operation` (upsert/delete), `index`, `objectId`, `payload`, `attempts`, `status` (pending/processing/done/failed), `createdAt` |

**sokoni-ops database only:**

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `typesenseQueue/{id}` | Pending Typesense sync operations | `operation`, `collection`, `documentId`, `payload`, `attempts`, `status`, `createdAt` |

### A.8 Admin & Monitoring Collections

> All collections in this section reside in the `sokoni-ops` Firestore database unless noted otherwise.

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `adminAlerts/{alertId}` | Platform operational alerts | `severity` (critical/high/medium/low), `category`, `title`, `description`, `resolved`, `resolvedBy`, `resolvedAt`, `createdAt` |
| `selfHealLog/{runId}` | Self-heal engine execution results | `triggeredBy`, `anomaliesFound`, `actionsAttempted`, `actionsSucceeded`, `durationMs`, `summary`, `runAt` |
| `healthSnapshots/{id}` | Periodic platform health readings | `activeOrders`, `pendingPayments`, `onlineDrivers`, `openAlerts`, `errorRate`, `avgLatencyMs`, `score`, `snapshotAt` |
| `operationsReports/{id}` | Daily operations reports | `period`, `gmv`, `orderCount`, `newUsers`, `activeDrivers`, `disbursementTotal`, `topMerchants[]`, `generatedAt` |
| `chaosTestReports/{id}` | Chaos engineering run results | `scenariosRun`, `scenariosPassed`, `scenariosFailed`, `mttr`, `findings[]`, `runAt` |
| `certificationReports/{id}` | Platform certification run results | `certVersion`, `score`, `grade`, `categories[]`, `findings[]`, `certifiedAt` |

**Primary `(default)` database:**

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `rateLimits/{key}` | Brute-force and rate limit counters | `key` (uid or ip), `count`, `windowStart`, `resetAt`, `blocked` |
| `featureFlags/{flag}` | Runtime feature toggles | `key`, `enabled`, `description`, `rolloutPercentage`, `allowlist[]`, `updatedBy`, `updatedAt` |

### A.9 CRM & Marketing Collections

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `crmLeads/{leadId}` | Sales pipeline leads | `name`, `email`, `phone`, `company`, `stage` (new/contacted/qualified/proposal/closed), `assignedTo`, `value`, `notes[]`, `createdAt`, `updatedAt` |
| `supportTickets/{ticketId}` | Customer support cases | `uid`, `orderId`, `subject`, `description`, `status` (open/pending/resolved/closed), `priority`, `agentId`, `messages[]`, `createdAt`, `resolvedAt` |
| `campaigns/{campaignId}` | Marketing campaign definitions | `name`, `type` (email/push/sms), `segmentId`, `content`, `status` (draft/scheduled/running/completed), `scheduledAt`, `sentCount`, `openRate`, `clickRate` |
| `segments/{segmentId}` | Customer cohort definitions | `name`, `description`, `criteria[]`, `memberCount`, `lastRefreshedAt`, `createdBy`, `createdAt` |

### A.10 eTIMS Collections

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `etimsProfiles/{sellerId}` | KRA eTIMS seller registration | `sellerId`, `kraPin`, `encryptedCredentials` (AES-256-GCM), `deviceSerialNumber`, `status` (pending/active/suspended), `registeredAt` |
| `etimsInvoices/{invoiceId}` | Submitted KRA tax invoices | `sellerId`, `orderId`, `invoiceNumber`, `kraInvoiceNumber`, `items[]`, `taxableAmount`, `vatAmount`, `totalAmount`, `status` (pending/submitted/accepted/rejected), `kraResponse`, `submittedAt` |
| `etimsQueue/{id}` | Failed eTIMS submissions awaiting retry | `invoiceId`, `attempts`, `lastError`, `nextRetryAt`, `status` (queued/retrying/exhausted), `createdAt` |

### A.11 Events & Bookings Collections

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `events/{eventId}` | Event listings with ticketing | `organizerId`, `title`, `description`, `category`, `location`, `startAt`, `endAt`, `ticketTiers[]`, `totalCapacity`, `soldCount`, `commissionRate` (3%), `status`, `createdAt` |
| `eventTickets/{ticketId}` | Issued event tickets with QR | `eventId`, `holderId`, `tierName`, `price`, `qrCode`, `status` (active/used/refunded), `checkedInAt`, `issuedAt` |
| `venueBookings/{bookingId}` | Venue and resource reservations | `venueId`, `resourceId`, `customerId`, `startAt`, `endAt`, `durationMins`, `slotLocked`, `holdExpiresAt`, `basePrice`, `modifiers[]`, `totalPrice`, `status` (hold/confirmed/cancelled), `createdAt` |

### A.12 Inventory Collections

| Collection Path | Purpose | Primary Fields |
|---|---|---|
| `tenants/{tenantId}/inventory/{productId}` | Per-tenant stock levels | `productId`, `sku`, `qtyOnHand`, `qtyReserved`, `qtyAvailable`, `reorderPoint`, `warehouseId`, `lastCountAt`, `updatedAt` |
| `tenants/{tenantId}/inventory_avco/{productId_warehouseId}` | AVCO cost tracking | `productId`, `warehouseId`, `avgCost`, `totalQty`, `totalValue`, `lastPurchasePrice`, `updatedAt` |
| `warehouses/{warehouseId}` | Warehouse location records | `tenantId`, `name`, `address`, `location` (GeoPoint), `type` (main/satellite/3pl), `active`, `managerUid`, `createdAt` |
| `stockMovements/{id}` | GRN, transfers, and adjustments | `tenantId`, `type` (grn/transfer/adjustment/return), `productId`, `warehouseFrom`, `warehouseTo`, `qty`, `unitCost`, `reference`, `reason`, `authorId`, `createdAt` |

---

## Appendix B — Secret Manager Reference

> All secrets are stored in Google Secret Manager under project `sokoni-aeb26`. Access is granted to the Cloud Functions service account. Secrets are accessed at runtime via `functions.params.defineSecret()`. See [[vol-02-identity-security]] for the security architecture.

### B.1 Secret Inventory

| Secret Name | Purpose | Rotation Required | Auto-Generated |
|---|---|---|---|
| `LOYALTY_HMAC_SECRET` | HMAC-SHA256 key for offline loyalty QR card sync signatures (SKN-XXXX format) | Annually | Yes — `setup-secrets.ps1` |
| `PAYMENT_HMAC_SECRET` | Payment audit trail seal for COMPLETED→ARCHIVED FSM state transition | Annually | Yes — `setup-secrets.ps1` |
| `PAYROLL_ENCRYPTION_KEY` | AES-256-GCM master key for bank account field encryption in HR/Payroll module | Annually | Yes — `setup-secrets.ps1` |
| `SOKONI_HMAC_KEY` | General-purpose platform HMAC key used for idempotency tokens and webhook verification | Annually | Yes — `setup-secrets.ps1` |
| `SENDGRID_API_KEY` | SendGrid transactional email API key — required for all 53 email templates | Never (external) | No — must be set manually |
| `ANTHROPIC_API_KEY` | Claude (Haiku) API key — powers KASS AI concierge, POS AI assistant, inventory AI | Never (external) | No — must be set manually |
| `INTASEND_PRIVATE_KEY` | IntaSend M-Pesa B2C disbursement private key for driver and seller payouts | Never (external) | No — must be set manually |
| `ETIMS_MASTER_KEY` | Master encryption key for eTIMS seller credential storage in Firestore | Annually | No — must be set manually |
| `ETIMS_PLATFORM_PIN` | SOKONI's own KRA PIN (format: P051234567T) used for platform-level eTIMS submissions | Never | No — must be set manually |
| `ETIMS_PLATFORM_SECRET` | SOKONI's eTIMS taxpayer secret (paired with `ETIMS_PLATFORM_PIN`) | On compromise | No — must be set manually |

### B.2 Secret Access Pattern

```javascript
// Cloud Functions v2 — secret binding example
const { defineSecret } = require('firebase-functions/params');

const LOYALTY_HMAC_SECRET = defineSecret('LOYALTY_HMAC_SECRET');
const ANTHROPIC_API_KEY   = defineSecret('ANTHROPIC_API_KEY');

exports.myFunction = onCall(
  { secrets: [LOYALTY_HMAC_SECRET, ANTHROPIC_API_KEY] },
  async (request) => {
    const hmacKey  = LOYALTY_HMAC_SECRET.value();
    const claudeKey = ANTHROPIC_API_KEY.value();
    // ...
  }
);
```

### B.3 First-Time Secret Provisioning

Run `scripts/setup-secrets.ps1` from the project root on first deployment. This script:
1. Generates cryptographically secure random values for all auto-generated secrets.
2. Creates each secret in Secret Manager with the correct IAM bindings.
3. Outputs a checklist of manual secrets that still require real values.

> **Security note:** Never commit secret values to git. Never log secret values. The `PAYROLL_ENCRYPTION_KEY` encrypts PII at rest — losing this key means payroll records become unreadable.

---

## Appendix C — Environment Variables

> Non-sensitive configuration values are stored in `functions/.env`. These are loaded by the Firebase Functions runtime at startup and do not require Secret Manager. See [[vol-13-foundation]] for the platform bootstrap sequence.

### C.1 Current Variables

```dotenv
# functions/.env

# eTIMS environment — "sandbox" (KRA test) or "production" (live KRA)
ETIMS_ENV=sandbox

# Optional Redis connection URL — if set, enables the Redis caching layer
# Leave blank to operate without Redis (graceful fallback is built in)
# Example: redis://default:password@redis.example.com:6379
REDIS_URL=

# Runtime environment indicator
NODE_ENV=production
```

### C.2 Variable Descriptions

| Variable | Type | Default | Description |
|---|---|---|---|
| `ETIMS_ENV` | `string` | `sandbox` | Controls KRA eTIMS API endpoint. Set to `production` before go-live. |
| `REDIS_URL` | `string` | `""` (empty) | Redis connection string. Empty string disables Redis; platform falls back gracefully to Firestore-only caching. |
| `NODE_ENV` | `string` | `production` | Standard Node.js environment flag. Affects logging verbosity and error detail. |

### C.3 Adding New Variables

1. Add the variable to `functions/.env`.
2. Reference it in code via `process.env.VARIABLE_NAME`.
3. If the value is sensitive, move it to Secret Manager instead (see Appendix B).
4. Update this appendix and the relevant module documentation.

---

## Appendix D — Firestore Index Budget

> SOKONI operates two Firestore databases. Index governance is critical — composite indexes are a finite resource. See [[vol-13-foundation]] for the index management policy.

### D.1 Index Budget Summary

| Database | Database ID | Current Usage | Limit | Headroom |
|---|---|---|---|---|
| Primary (transactional) | `(default)` | 199 | 200 | 1 |
| Admin/Monitoring | `sokoni-ops` | 27 | 200 | 173 |

### D.2 Index Files

| File | Database | Description |
|---|---|---|
| `firestore.indexes.json` | `(default)` | All transactional composite indexes |
| `firestore.indexes.sokoni-ops.json` | `sokoni-ops` | Admin, monitoring, and audit indexes |

### D.3 Index Governance Rules

> **CRITICAL: Never drop an existing index.** Dropping an index breaks production queries immediately and silently.

1. **Add only** — every index change is additive.
2. **Primary database is full** — all new admin, monitoring, logging, and audit collection indexes must go to `sokoni-ops`.
3. **Review before adding** — check if an existing index already covers the query before requesting a new one.
4. **Use `scripts/split-indexes.js`** before every deployment to split the master index file into the correct per-database files.
5. **Monitor budget** — review index count after every sprint. Alert if primary reaches 199.

### D.4 Collections in sokoni-ops Database

The following collections are housed exclusively in `sokoni-ops` to preserve primary index budget:

- `adminAlerts`
- `etimsAlerts`
- `deviceAuditLog`
- `selfHealLog`
- `chaosTestReports`
- `certificationReports`
- `posDevices` (monitoring queries only)
- `emailLogs`
- `typesenseQueue`
- `algoliaQueue`
- `notificationQueue`
- `moderationQueue`
- `operationsReports`
- `healthSnapshots`
- `eccAuditLog`
- `eccIncidents`

---

## Appendix E — Cloud Functions Count by Module

> SOKONI deploys approximately 636 Cloud Functions across ~158 source files in `functions/`. All functions run in `us-central1`. See [[vol-01-vision-architecture]] for the architecture overview and [[vol-15-enterprise-operations]] for the ops center.

### E.1 Function Inventory by Module

| Module | Primary File(s) | Approx. CFs | Volume Reference |
|---|---|---|---|
| PnP Business Bootstrap | `business-bootstrap.js` | 5 | [[vol-03-pos-enterprise]] |
| Device Manager | `device-manager.js` | 9 | [[vol-03-pos-enterprise]] |
| Self-Healing Engine | `self-heal.js` | 3 | [[vol-15-enterprise-operations]] |
| eTIMS Integration | `etims.js` | 28 | [[vol-05-accounting]] |
| Security Zero Trust | `security-zero-trust.js` | 8 | [[vol-02-identity-security]] |
| Loyalty Platform v2 | `loyalty-v2.js` + support files | 26 | [[vol-08-loyalty-platform]] |
| Enterprise Loyalty | `loyalty-enterprise.js` | 16 | [[vol-08-loyalty-platform]] |
| Payment FSM | `payment-fsm.js` | 8 | [[vol-04-payments]] |
| Reconciliation | `reconciliation.js` | 7 | [[vol-04-payments]] |
| HR / Payroll | `hr-payroll.js` | ~12 | [[vol-12-hr-workforce]] |
| CRM | `crm.js` | 13 | [[vol-11-crm-marketing]] |
| Email Service | `email-service.js`, `email-triggers.js`, `email-templates.js` | 26 | [[vol-13-foundation]] |
| Search — Algolia | `algolia-*.js` (11 files) | ~30 | [[vol-14-analytics-bi]] |
| Search — Typesense | `typesense-*.js` (9 files) | ~25 | [[vol-14-analytics-bi]] |
| Inventory | `inventory-*.js` (8 files) | ~40 | [[vol-06-inventory-warehousing]] |
| Delivery & Logistics | `sokoni-dispatch.js`, `sokoni-logistics.js` | ~23 | [[vol-09-delivery-logistics]] |
| SmartPOS 3.0 — BOS | `pos-*.js` (8 modules) | 139 | [[vol-03-pos-enterprise]] |
| Event Hub | `event-hub.js` | 19 | [[vol-07-marketplace-commerce]] |
| Venue & Booking | `venue-booking.js` | 19 | [[vol-07-marketplace-commerce]] |
| Commission Engine | `commission-engine.js` | 5 | [[vol-05-accounting]] |
| Subscription Billing | `subscription-billing.js` | 15 | [[vol-07-marketplace-commerce]] |
| KASS AI Concierge | `sokoniChat` (within AI module) | 6 | [[vol-10-artificial-intelligence]] |
| FinOS v2 | `finos-v2.js` | 12 | [[vol-04-payments]] |
| Navigation & Dispatch | `sokoni-navigation.js` + related | 16 | [[vol-09-delivery-logistics]] |
| Platform Registry & Event Bus | `platform-registry.js` + event bus | 14 | [[vol-13-foundation]] |
| Admin Operating System | `admin-os.js` | ~10 | [[vol-15-enterprise-operations]] |
| Reviews Engine | `reviews.js` | 5 | [[vol-07-marketplace-commerce]] |
| QR System | `qr-system.js` | 3 | [[vol-13-foundation]] |
| Education Hub | `education-hub.js` | 8 | [[vol-07-marketplace-commerce]] |
| Security Hardening v2 | `security-hardening-v2.js` | ~10 | [[vol-02-identity-security]] |
| Release Readiness | `release-readiness.js` | 8 | [[vol-18-production-certification]] |
| B2B Wholesale | `b2b-wholesale.js` | 12 | [[vol-07-marketplace-commerce]] |
| Merchant Success | `merchant-success.js` | 11 | [[vol-11-crm-marketing]] |
| Chaos Engineering | `chaos.js` | 5 | [[vol-17-testing-qa]] |
| MiniShop | `minishop.js` | 14 | [[vol-07-marketplace-commerce]] |
| AI Creative Studio | `ai-creative.js` | ~8 | [[vol-10-artificial-intelligence]] |
| Workflow Automation | `sokoni-wap.js` | 7 | [[vol-10-artificial-intelligence]] |
| Geo Intelligence Platform | `sokoni-gip.js` | ~15 | [[vol-09-delivery-logistics]] |
| **Total** | **~158 files** | **~636 CFs** | |

### E.2 Function Naming Convention

```
{module}{Action}        — e.g. bootstrapDevice, processPayment
scheduled{Name}         — e.g. scheduledDailyOpsReport
on{Collection}{Event}   — e.g. onOrderCreated, onPaymentUpdated
```

All functions use Gen2 (`onCall`, `onRequest`, `onDocumentWritten`) unless a specific legacy pattern is required.

---

## Appendix F — Kenya Statutory Compliance Reference

> SOKONI's HR/Payroll module implements Kenya statutory deductions as mandated by KRA, NHIF, and NSSF. Rates below are current as of the 2024 KRA guidelines. See [[vol-12-hr-workforce]] for implementation details.

### F.1 PAYE Tax Bands (2024 KRA)

| Monthly Taxable Income (KES) | Tax Rate |
|---|---|
| 0 – 24,000 | 10% |
| 24,001 – 32,333 | 25% |
| 32,334 – 500,000 | 30% |
| 500,001 – 800,000 | 32.5% |
| 800,001 and above | 35% |

**Personal Relief:** KES 2,400 per month (deducted from computed PAYE)
**Insurance Relief:** 15% of qualifying insurance premiums paid (max KES 5,000/month)

> PAYE is computed on taxable income = Gross Salary − NSSF Tier I − NSSF Tier II − Allowable Deductions.

### F.2 NHIF Contribution Table (2024)

| Monthly Gross Salary (KES) | Monthly Contribution (KES) |
|---|---|
| Up to 5,999 | 150 |
| 6,000 – 7,999 | 300 |
| 8,000 – 11,999 | 400 |
| 12,000 – 14,999 | 500 |
| 15,000 – 19,999 | 600 |
| 20,000 – 24,999 | 750 |
| 25,000 – 29,999 | 850 |
| 30,000 – 34,999 | 900 |
| 35,000 – 39,999 | 950 |
| 40,000 – 44,999 | 1,000 |
| 45,000 – 49,999 | 1,100 |
| 50,000 – 59,999 | 1,200 |
| 60,000 – 69,999 | 1,300 |
| 70,000 – 79,999 | 1,400 |
| 80,000 – 89,999 | 1,500 |
| 90,000 – 99,999 | 1,600 |
| 100,000 and above | 1,700 |

### F.3 NSSF Contributions (NSSF Act 2013)

| Component | Basis | Rate | Maximum |
|---|---|---|---|
| Tier I | Gross salary up to KES 7,000 | 6% employee + 6% employer | KES 420 employee / KES 420 employer |
| Tier II | Gross salary KES 7,001 – KES 36,000 | 6% employee + 6% employer | KES 1,740 employee / KES 1,740 employer |

### F.4 Affordable Housing Levy (AHL)

| Party | Rate | Basis |
|---|---|---|
| Employee | 1.5% | Gross monthly salary |
| Employer | 1.5% | Gross monthly salary |

### F.5 VAT and WHT Rates

| Tax | Rate | Notes |
|---|---|---|
| VAT (Value Added Tax) | 16% | Standard rate on all taxable goods and services in Kenya |
| WHT (Withholding Tax) | 5% | Applied on professional service payments and management fees |

---

## Appendix G — Commission & Fee Rates Reference

> The commission engine applies category-specific rates defined in `DEFAULT_COMMISSION_RATES`. These are the platform defaults and can be overridden per merchant via the admin portal. See [[vol-05-accounting]] and [[vol-07-marketplace-commerce]] for the commission engine implementation.

### G.1 DEFAULT_COMMISSION_RATES by Category

| Category | Commission Rate | Notes |
|---|---|---|
| `general_merchandise` | 8% | Standard goods |
| `electronics` | 5% | Lower margin category |
| `fashion_apparel` | 12% | High-velocity fashion |
| `food_grocery` | 3% | Essential goods — low commission |
| `fresh_produce` | 2.5% | Perishables — lowest rate |
| `restaurants` | 15% | Food delivery / dine-in |
| `beauty_personal_care` | 10% | Health and beauty |
| `home_garden` | 8% | Home improvement |
| `sports_outdoor` | 8% | Sports equipment |
| `automotive` | 5% | Vehicles and parts |
| `health_pharmacy` | 6% | Medical and pharmaceutical |
| `books_stationery` | 8% | Education materials |
| `digital_products` | 20% | Highest margin — zero fulfillment cost |
| `services_professional` | 10% | Legal, consulting, etc. |
| `real_estate` | 2% | Property — large ticket size |
| `events_entertainment` | 8% | Event ticketing |

### G.2 Event Ticketing Commission

| Type | Commission Rate |
|---|---|
| Event tickets (Event Hub) | 3% flat |

### G.3 Commission Calculation Formula

```
Commission Amount = Order Total × Commission Rate
VAT on Commission = Commission Amount × 0.16
WHT on Commission = Commission Amount × 0.05   (professional services only)
Net Payout to Merchant = Order Total − Commission Amount
```

---

## Appendix H — Deployment Runbook (Quick Reference)

> Full deployment documentation is in [[vol-18-production-certification]]. This appendix provides the essential step-by-step sequence for a production deployment.

### H.1 Prerequisites Checklist

Before any deployment:
- [ ] All secrets in Secret Manager have real values (not placeholders)
- [ ] `functions/.env` has `ETIMS_ENV=production` (for go-live)
- [ ] No background deploy is running (wait for completion notification)
- [ ] Index budget has headroom (check Appendix D)
- [ ] `git status` is clean on `main`

### H.2 Full Production Deployment Sequence

```powershell
# Step 1 — First time only: provision all secrets
.\scripts\setup-secrets.ps1

# Step 2 — Set environment variables
# Edit functions/.env:
#   ETIMS_ENV=production
#   REDIS_URL=redis://... (if Redis is provisioned)
#   NODE_ENV=production

# Step 3 — Split index file into primary + sokoni-ops
node scripts/split-indexes.js

# Step 4 — Deploy Firestore rules and indexes (both databases)
firebase deploy --only firestore

# Step 5 — Deploy all Cloud Functions (~636 CFs)
# NOTE: This can take 15-25 minutes
firebase deploy --only functions

# Step 6 — Deploy static hosting assets
firebase deploy --only hosting

# Step 7 — Commit and push
git add -A
git commit -m "deploy: production release vX.Y.Z"
git push origin main
```

### H.3 Partial Deployment (--only parameter)

The automated script `scripts/deploy.ps1` supports the `--only` parameter with the following valid values:

| Value | What Deploys |
|---|---|
| `all` | Firestore + Functions + Hosting |
| `firestore` | Rules and indexes only |
| `functions` | All Cloud Functions |
| `hosting` | Static assets only |
| `functions,hosting` | Functions + Hosting (skip Firestore) |

```powershell
# Example: deploy only functions and hosting
.\scripts\deploy.ps1 --only functions,hosting
```

### H.4 Post-Deployment Verification

After every deployment:
1. Check Firebase Console → Functions → errors (within 5 minutes)
2. Open `ops-center.html` → verify all health indicators are green
3. Run a test STK Push on the staging device
4. Verify `adminAlerts` in sokoni-ops has no new CRITICAL alerts
5. Check `healthSnapshots` — score should be ≥ 90

### H.5 Rollback Procedure

Firebase Functions does not support automatic rollback. To revert:

```powershell
# Identify the previous working commit
git log --oneline -10

# Check out the previous version
git checkout <previous-commit-hash> -- functions/

# Redeploy functions
firebase deploy --only functions

# Restore HEAD
git checkout main
```

---

## Appendix I — Glossary

> Platform-specific terminology used throughout the 18-volume documentation series.

### I.1 SOKONI Platform Terms

| Term | Definition |
|---|---|
| **SKN-XXXX** | SOKONI loyalty card QR code format. Four alphanumeric characters suffix a unique card identifier (e.g. `SKN-A3K9`). The QR payload is HMAC-signed using `LOYALTY_HMAC_SECRET` for offline verification. |
| **Bootstrap Bundle** | The complete device configuration package returned by the `bootstrapDevice` Cloud Function during POS terminal startup. Includes products, staff PINs, discount rules, tax config, and print settings. Cached in `bootstrapCache` with a 5-minute TTL. |
| **AVCO** | Average Cost — the inventory valuation method used by SOKONI. Each inbound purchase recalculates a weighted average unit cost across all stock held. Stored per product per warehouse in `inventory_avco`. |
| **FSM** | Finite State Machine — the pattern used for payment state transitions. The payment FSM has 12 states: `INITIATED → PENDING → PROCESSING → COMPLETED → ARCHIVED` (happy path), with error and dispute branches. |
| **sokoni-ops** | The secondary Firestore database (`sokoni-ops`) used exclusively for admin, monitoring, audit, and logging collections. Created to preserve the 200-index budget of the primary database. |
| **eTIMS** | Electronic Tax Invoice Management System — the Kenya Revenue Authority's real-time electronic invoicing API. SOKONI integrates with eTIMS to submit tax invoices on behalf of registered sellers. |
| **PAYE** | Pay As You Earn — Kenya's employer-withheld income tax system. SOKONI's HR/Payroll module computes and reports PAYE for all employees. |
| **NHIF** | National Hospital Insurance Fund — mandatory employee health insurance contribution deducted from gross salary. |
| **NSSF** | National Social Security Fund — mandatory pension contribution. SOKONI implements the two-tier NSSF Act 2013 model (Tier I + Tier II). |
| **WHT** | Withholding Tax — 5% tax deducted on professional service payments. Applied by SOKONI when disbursing commissions categorised as professional services. |
| **Housing Levy** | Affordable Housing Levy (AHL) — 1.5% of gross salary deducted from both employee and employer, effective 2024. |
| **STK Push** | SIM Toolkit Push — the mechanism by which M-Pesa payment prompts are sent to a customer's phone. SOKONI uses IntaSend SDK to initiate STK pushes. |
| **B2C** | Business-to-Customer — M-Pesa payout from a business to an individual. Used for driver earnings disbursements and seller payouts via IntaSend. |
| **App Check** | Firebase App Check — a security service that prevents unauthorised API access. SOKONI uses `ReCaptchaV3Provider` and enforces App Check on Cloud Functions, Firestore, and Cloud Storage. |
| **PnP** | Plug-and-Play — SOKONI's zero-configuration device onboarding system. A new POS device scans a QR code and is fully configured within 60 seconds via the `bootstrapDevice` CF. |
| **KASS** | SOKONI's AI customer concierge. Powered by Claude Haiku (Anthropic) via the `sokoniChat` Cloud Function. Capable of product search, order status, and merchant recommendations using 6 Firestore tools. |
| **Delta Sync** | Incremental data synchronisation strategy — only records changed since the last sync timestamp are fetched. Used by offline-first POS to minimise bandwidth and read costs. |
| **Self-Heal** | The automated anomaly detection and remediation system. Runs every 5 minutes via a scheduled Cloud Function, detects platform anomalies (stuck orders, payment failures, offline devices), and attempts automated fixes. |
| **Tombstone** | A deleted record marker (`_deleted: true`) used in IndexedDB for offline-first sync. Tombstones allow the sync engine to propagate deletions without losing the record identity. |
| **Commerce OS** | SOKONI's integrated commerce operating system — the collection of modules covering Payment FSM, Reconciliation, Business Health Score, HR/Payroll, Procurement, Marketing Engine, AVCO, and Chaos Engineering. |
| **Event Bus** | The Firebase-based event routing layer built on Cloud Functions triggers. 8 Cloud Functions form the event bus, routing domain events (order.created, payment.completed) to downstream consumers. |
| **FinOS** | Financial Operating System — SOKONI's double-entry ledger, escrow, settlement, and dispute resolution system. Version 2.0 includes a 7-day cash flow forecast and AI-assisted anomaly detection. |
| **Admin OS (AOS)** | The Admin Operating System — a single-page dark-theme admin portal (`admin-os.html`) with 17+ management sections, real-time charts, and direct Cloud Function wiring for platform operators. |
| **Idempotency Key** | A unique token attached to payment and mutation requests to prevent duplicate processing. Generated client-side using HMAC and stored server-side for deduplication. |
| **GeoPoint** | Firestore's native geo-coordinate type (`latitude`, `longitude`). Used for driver locations, delivery waypoints, warehouse locations, and branch positions. |
| **PITR** | Point-in-Time Recovery — Firestore feature that allows restoring the database to any point within a 7-day window. Enabled on the primary database as part of production hardening. |
| **sokoni-config.js** | The client-side Firebase configuration file containing the project's public API keys and the ReCaptcha v3 site key for App Check. Committed to the repository (public keys only — no secrets). |
| **MiniShop** | Per-seller storefronts accessible at `/shop/{handle}` and `/@{handle}`. Includes WhatsApp Status integration, a Digital Business Card, and a campaign engine. |
| **Merchant Pipeline** | The end-to-end merchant onboarding and management workflow portal (`merchant-pipeline.html`). Covers KYC, subscription selection, product upload, and go-live checklist. |
| **Business Health Score** | A composite score (0–100) computed by the Commerce OS from sales velocity, inventory levels, customer satisfaction, and financial health indicators. Displayed on merchant dashboards. |
| **Ops Center** | The platform operations control centre (`ops-center.html`) used by SOKONI operations staff. Shows real-time health, alerts, self-heal logs, and incident management tools. |

### I.2 Third-Party Service Abbreviations

| Abbreviation | Full Name | Usage in SOKONI |
|---|---|---|
| **IntaSend** | IntaSend Fintech | M-Pesa STK Push and B2C payouts |
| **KRA** | Kenya Revenue Authority | eTIMS integration and tax compliance |
| **Algolia** | Algolia Search | Primary full-text product search |
| **Typesense** | Typesense Search | Secondary/fallback search (sokoni-ops) |
| **SendGrid** | SendGrid (Twilio) | All 53 transactional email templates |
| **Anthropic** | Anthropic (Claude) | KASS AI, POS AI assistant, inventory AI |
| **GCP** | Google Cloud Platform | Underlying infrastructure (Firebase runs on GCP) |
| **SM** | Secret Manager | Google Cloud Secret Manager for all secrets |
| **CF** | Cloud Function | Firebase/Google Cloud Functions |

---

## Appendix J — Data Retention & Compliance Reference

> SOKONI handles personal and financial data subject to Kenya's Data Protection Act (2019) and KRA compliance requirements. See [[vol-02-identity-security]] for the full compliance architecture.

### J.1 Retention Schedule

| Collection / Data Type | Minimum Retention | Legal Basis |
|---|---|---|
| `payments` | 7 years | KRA financial records requirement |
| `etimsInvoices` | 7 years | KRA eTIMS regulation |
| `payrollRuns` | 5 years | Kenya Employment Act |
| `ledgerEntries` | 7 years | Kenya Companies Act |
| `deviceAuditLog` | 3 years | Internal audit policy |
| `orders` | 5 years | Consumer protection |
| `users` (deleted accounts) | 90 days (then anonymise) | Kenya Data Protection Act |
| `rateLimits` | 24 hours | Operational (auto-expire) |
| `bootstrapCache` | 5 minutes | Operational (auto-expire TTL) |
| `syncQueue` (synced) | 30 days (then purge) | Operational |
| `notifications` (read) | 60 days | Operational |

### J.2 PII Fields Requiring Encryption

The following fields are encrypted at rest using AES-256-GCM:

| Collection | Field | Key Used |
|---|---|---|
| `employees` | `bankAccount` | `PAYROLL_ENCRYPTION_KEY` |
| `etimsProfiles` | `credentials` | `ETIMS_MASTER_KEY` |
| `drivers` | `nationalId` (stored copy) | `SOKONI_HMAC_KEY` |

---

*This appendices document is part of the SOKONI 18-volume technical documentation series. It is maintained as a living document and updated with every platform release.*

*Last updated: 2026-07-05 | Maintainer: SOKONI Engineering Team | Project: sokoni-aeb26*
