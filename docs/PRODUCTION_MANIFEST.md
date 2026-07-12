# SOKONI Production Manifest — v1.0.0

**Generated:** 2026-07-12  
**Project:** sokoni-aeb26  
**Region:** europe-west1 (primary)

---

## Cloud Infrastructure

| Component | Value |
|---|---|
| Firebase Project | sokoni-aeb26 |
| Primary Region | europe-west1 |
| Hosting URL | https://mysokoni.co.ke |
| Firebase Hosting | Deployed via `firebase deploy --only hosting` |
| Cloudflare CDN | Active (CDN-Cache-Control headers set) |

---

## Cloud Functions

### Deployed Count
| Database/Module | Count |
|---|---|
| Total deployed (approximate) | ~630 |
| Pending (Cloud Run quota) | ~218 |
| Total when quota resolved | ~848 |

### Function Modules (Deployed)

| File | Functions |
|---|---|
| `functions/email-triggers.js` | 30 email trigger CFs |
| `functions/email-dmarc.js` | 1 |
| `functions/ops-tools.js` | `scheduledDailyOpsReport`, `weeklySecurityReport`, `testEmailDelivery` |
| `functions/minishop-v3.js` | 14 (MiniShop 2.0) |
| `functions/retention.js` | Retention engine CFs |
| `functions/pos-retail.js` | POS retail CFs |
| `functions/pos-retail-engine.js` | POS engine CFs |
| `functions/payment-trust.js` | Payment trust CFs |
| `functions/index.js` | Core dispatchers + triggers |
| `functions/conversion-analytics.js` | Analytics CFs |
| `functions/api-gateway.js` | `sokoniAPIGateway` (REST API) |
| `functions/pos-terminal-live.js` | Terminal payment CFs |
| `functions/sokoni-zero-trust.js` | `evaluateAccessRequest` |
| `functions/company-identity.js` | Company identity CFs |
| `functions/email-templates.js` | Email template CFs |
| `functions/legal-agreements.js` | Legal acceptance CFs |
| `functions/legal-dispatch.js` | Legal dispatch CFs |
| `functions/provider-onboarding.js` | Provider onboarding CFs |
| `functions/provider-ops.js` | Provider operations CFs |
| (+ 200+ additional modules) | Commerce, Loyalty, Loyalty v2, FinOS, Events, etc. |

### Pending (Quota Blocked)
| File | Functions | Blocker |
|---|---|---|
| `functions/financial-os.js` | ~50 | Cloud Run CPU quota |
| `functions/platform-core.js` | ~60 | Cloud Run CPU quota |
| `functions/sub-engine.js` | ~15 | Cloud Run CPU quota |
| `functions/messages.js` | ~20 | Cloud Run CPU quota |
| Services dispatch (security-identity, jobs, hr-payroll, b2b-wholesale, property-hub) | ~73 | Cloud Run CPU quota |

---

## Firestore Databases

| Database | Purpose | Index Count |
|---|---|---|
| `(default)` | All user-facing collections | 200 (at limit) |
| `sokoni-ops` | Operational back-office data (POS cash, provider data, account ops) | 54 |

### Key Collections (default database)
`users`, `sellers`, `products`, `orders`, `payments`, `wallets`, `subscriptions`, `loyaltyAccounts`, `loyaltyTransactions`, `giftCards`, `luckyDraws`, `reviews`, `disputes`, `notifications`, `messages`, `events`, `tickets`, `properties`, `vehicles`, `jobs`, `healthcare`, `legal`, `education`, `entertainment`, `digitalProducts`, `digitalPurchases`, `deliveries`, `drivers`, `tracking`, `vouchers`, `commissions`, `settlements`, `ledger`, `etims`, `legalAcceptances`, `platformHubs`, `asyncJobs`, `healthSnapshots`

### Key Collections (sokoni-ops database)
`posCashEvents`, `posCashSessions`, `posDrawerEvents`, `posCloseApprovals`, `providerProfiles`, `providerBookings`, `providerPayouts`, `providerReviews`, `accountProfiles`, `accountSubscriptions`

---

## Authentication

| Method | Status |
|---|---|
| Email + Password | ✅ Active |
| Google OAuth | ✅ Active |
| Facebook OAuth | ✅ Active |
| Phone OTP (Kenya +254) | ✅ Active |
| Firebase App Check (reCAPTCHA v3) | ✅ Enforced |

---

## Payments

| Integration | Status | Account |
|---|---|---|
| IntaSend STK Push (M-Pesa) | ✅ Live | sokoni-aeb26 |
| IntaSend B2C Disbursement | ✅ Live | sokoni-aeb26 |
| Merchant of Record settlement | ✅ Live | Bravilex 0686420001 |
| Platform wallet (internal) | ✅ Live | Firestore-backed |

---

## Email

| Component | Value |
|---|---|
| Provider | SendGrid |
| Domain | @mysokoni.co.ke |
| Transactional templates | 53 |
| Mailboxes | 40+ (info@, support@, merchant@, etc.) |
| DMARC | Configured (see `docs/DMARC.md`) |
| Secret | `SENDGRID_API_KEY` in Secret Manager |

---

## Search

| Component | Value |
|---|---|
| Provider | Algolia |
| Index | sokoni_products (primary) |
| NLP | Swahili NLP preprocessing |
| Secret | `ALGOLIA_ADMIN_KEY` in Secret Manager |

---

## Secrets in Secret Manager

| Secret | Purpose | Status |
|---|---|---|
| `SENDGRID_API_KEY` | Email delivery | ⚠ Placeholder — replace before go-live |
| `LOYALTY_HMAC_SECRET` | Loyalty QR signing | ✅ Set (auto-generated) |
| `ANTHROPIC_API_KEY` | KASS AI + insights | ✅ Set |
| `INTASEND_API_KEY` | M-Pesa payments | ✅ Set |
| `INTASEND_PRIVATE_KEY` | Webhook verification | ✅ Set |
| `ALGOLIA_ADMIN_KEY` | Search indexing | ✅ Set |
| `SOKONI_HMAC_KEY` | Internal signing | ✅ Set |
| `PAYMENT_HMAC_SECRET` | Payment FSM signing | ✅ Set |
| `PAYROLL_ENCRYPTION_KEY` | Payroll AES-256 | ✅ Set |
| `ETIMS_CLIENT_ID` | KRA eTIMS | ⚠ Pending |
| `ETIMS_CLIENT_SECRET` | KRA eTIMS | ⚠ Pending |
| `KRA_PIN` | Bravilex KRA PIN | ⚠ Pending |
| `REDIS_URL` | Redis connection | ✅ Set (10.127.36.43:6379) |

---

## Redis

| Parameter | Value |
|---|---|
| Host | 10.127.36.43 |
| Port | 6379 |
| SDK | sokoni-redis.js |
| VPC Connector | ⚠ Not yet provisioned |
| Fallback | Fail-safe (all ops degrade gracefully) |

---

## Scheduled Jobs

| Job | Schedule | Function |
|---|---|---|
| Daily Ops Report | 06:00 EAT daily | `scheduledDailyOpsReport` |
| Weekly Security Report | Monday 08:00 EAT | `weeklySecurityReport` |
| Auto Settlement | Every 6 hours | `autoSettlement` |
| Retention / Price Alerts | Daily | `triggerPriceAlerts` |
| Email Subscription Reminders | Daily | `emailSubscriptionReminders` |
| Driver Doc Reminders | Weekly | `emailDriverDocReminders` |
| MiniShop Digest | Weekly | `miniShopScheduledDigest` |
| Async Job Sweeper | Every 5 minutes | `asyncSweeper` |

---

## Monitoring & Alerts

| Alert | Condition | Notification |
|---|---|---|
| Error rate spike | CF error rate > 5% | Email (ogutualex824@gmail.com) |
| Payment failure spike | Payment errors > 3% | Email |
| Cold start latency | P95 > 5s | Email |
| Firestore quota | Read/write > 80% quota | Email |
| Crash-free rate | < 99% | Email |
| 18+ additional alerts | Various | Email |

---

## Service Worker

| Key | Value |
|---|---|
| Cache version | `sokoni-20260712-golive-v40` |
| Offline support | Full PWA with background sync |
| Install prompt | Active |
| Push notifications | Active |

---

## CDN / Hosting Config

| Setting | Value |
|---|---|
| Cloudflare | Active |
| CDN-Cache-Control | `max-age=86400` (1 day) for static assets |
| CACHE_BUST param | In SW cache key |
| Custom domain | mysokoni.co.ke |
| SSL/TLS | Enforced (HTTPS only) |
