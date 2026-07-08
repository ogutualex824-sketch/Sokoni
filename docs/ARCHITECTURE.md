# SOKONI Enterprise Architecture Reference

**Version:** 4.0  
**Status:** Production  
**Date:** 2026-07-08  
**Previous:** v3.0 (2026-07-07)  
**Authors:** SOKONI Engineering Team  
**Scope:** Full platform — ~600 Cloud Functions, all service domains, all data layers

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Service Boundaries — Modular Microservices on Cloud Functions](#2-service-boundaries--modular-microservices-on-cloud-functions)
3. [Data Architecture](#3-data-architecture)
4. [Performance Architecture](#4-performance-architecture)
5. [Resilience Architecture](#5-resilience-architecture)
6. [Security Architecture](#6-security-architecture)
7. [Observability Architecture](#7-observability-architecture)
8. [Known Bottlenecks and Mitigations](#8-known-bottlenecks-and-mitigations)
9. [Module Catalog](#9-module-catalog)
10. [Architecture Decision Records](#10-architecture-decision-records)

---

## 1. Architecture Overview

### 1.1 System Diagram

SOKONI is a five-tier progressive web platform deployed entirely on Google Cloud Platform. Traffic flows from the global CDN edge through a Firebase-enforced API gateway into a modular service layer that reads and writes a Firestore system of record, with Redis providing sub-second operational state.

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  TIER 1 — EDGE (CDN)                                                         ║
║                                                                              ║
║  Firebase Hosting CDN (global PoPs) + Cloudflare (WAF, DDoS, canary)        ║
║  Static assets: HTML, CSS, JS, fonts, images — Cache-Control: immutable      ║
║  Service Worker (sokoni-vN) — offline-first, cache-then-network for shell    ║
╚══════════════════════════════════╤═══════════════════════════════════════════╝
                                   │ HTTPS / Firebase SDK
╔══════════════════════════════════▼═══════════════════════════════════════════╗
║  TIER 2 — API GATEWAY                                                        ║
║                                                                              ║
║  ┌──────────────────────────┐  ┌─────────────────────┐  ┌─────────────────┐ ║
║  │  Callable Functions       │  │  HTTP Functions      │  │ Firestore Trig. │ ║
║  │  enforceAppCheck: true    │  │  Webhooks / Public   │  │ onCreated etc.  │ ║
║  │  Auth-gated + RBAC        │  │  HMAC verified       │  │ Event reactions │ ║
║  └──────────┬───────────────┘  └──────────┬──────────┘  └────────┬────────┘ ║
║             │                             │                       │          ║
║  ┌──────────▼─────────────────────────────▼───────────────────────▼────────┐ ║
║  │  MIDDLEWARE CHAIN                                                        │ ║
║  │  App Check attestation → Firebase Auth → Custom claims (RBAC)           │ ║
║  │  → Rate limiter (Redis INCR / Firestore fallback)                       │ ║
║  │  → Input sanitisation + amount validation                                │ ║
║  │  → Audit log pre-write                                                   │ ║
║  └──────────────────────────────────────────────────────────────────────────┘ ║
╚══════════════════════════════════╤═══════════════════════════════════════════╝
                                   │
╔══════════════════════════════════▼═══════════════════════════════════════════╗
║  TIER 3 — SERVICE LAYER (~600 Cloud Functions, Gen2, Node.js 22)             ║
║                                                                              ║
║  Auth     Marketplace  Commerce  Delivery  Booking   Financial   Loyalty     ║
║  Service   Service     Service   Service   Service   Service     Service     ║
║                                                                              ║
║  Notification  Messaging  AI      SmartPOS  Analytics  Admin   Media  Hubs  ║
║  Service       Service    Service Service   Service    Service  Service      ║
║                                                                              ║
║  ┌──────────────────────────────────────────────────────────────────────────┐║
║  │  PLATFORM EVENT BUS (platform-event-bus.js)                              ║
║  │  Publish → Firestore platformEvents → Fan-out → Dead-letter → Replay    │║
║  └──────────────────────────────────────────────────────────────────────────┘║
╚════════════════════╤═════════════════════════════╤════════════════════════════╝
                     │                             │
╔════════════════════▼══════════╗  ╔══════════════▼══════════════════════════╗
║  TIER 4a — REDIS FAST LAYER   ║  ║  TIER 4b — FIRESTORE (SOURCE OF TRUTH)  ║
║  (operational / ephemeral)    ║  ║  (durable / permanent)                  ║
║                               ║  ║                                         ║
║  • Rate limiting (INCR)       ║  ║  • All business records                 ║
║  • Payment locks (NX, 30s)    ║  ║  • All financial transactions           ║
║  • Inventory locks (NX, 2m)   ║  ║  • All audit trails                     ║
║  • POS cart sync (500ms)      ║  ║  • All user profiles                    ║
║  • Dashboard counters         ║  ║  • PITR enabled                         ║
║  • Job queues (8 channels)    ║  ║  • 197+ composite indexes               ║
║  • Search / AI response cache ║  ║  • Second DB: sokoni-ops (overflow)     ║
║  • Rider/terminal presence    ║  ║                                         ║
║  Fallback: Firestore on miss  ║  ║                                         ║
╚═══════════════════════════════╝  ╚═════════════════════════════════════════╝
                     │
╔════════════════════▼═══════════════════════════════════════════════════════╗
║  TIER 5 — EXTERNAL APIS                                                    ║
║                                                                            ║
║  IntaSend (M-Pesa STK + Cards)  │  Anthropic (Claude claude-haiku-4-5, claude-sonnet-4-6)   ║
║  Africa's Talking (SMS)         │  SendGrid (Email, 53 templates)         ║
║  Typesense (Search, Swahili NLP)│  Algolia (Search fallback / analytics)  ║
║  OSRM (Route calculation)       │  Firebase Storage (Media, Receipts)     ║
╚════════════════════════════════════════════════════════════════════════════╝
```

### 1.2 Platform Tiers Summary

| Tier | Component | Responsibility |
|---|---|---|
| Edge | Firebase Hosting CDN + Cloudflare | Global static asset delivery, DDoS protection, cache |
| API Gateway | Cloud Functions middleware chain | Auth, rate limiting, input validation, routing |
| Service Layer | ~600 Cloud Functions (Gen2, Node 22) | All business logic, event publishing |
| Data Layer | Firestore + Redis + Cloud Storage | Durable records + operational state + media |
| External APIs | IntaSend, Anthropic, SendGrid, Typesense | Payments, AI, email, search |

### 1.3 Current Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | HTML5 PWA, vanilla JS | All 130+ pages, mobile-first |
| Hosting | Firebase Hosting | CDN, clean URLs, SSL, CORS |
| Functions | Cloud Functions Gen2, Node.js 22 | All backend logic (~600 CFs) |
| Database | Google Cloud Firestore | System of record, real-time listeners |
| Cache | Google Cloud Memorystore (Redis 7) | Operational state, queues, rate limiting |
| Storage | Firebase Cloud Storage | Images, PDFs, receipts, backups |
| Auth | Firebase Authentication | Email, Google, Phone, Facebook OAuth |
| AI | Anthropic (claude-haiku-4-5 + claude-sonnet-4-6) | KASS concierge, insights, creative studio |
| Payments | IntaSend (M-Pesa STK + Cards) | All payment processing |
| Search | Typesense (primary) + Algolia (analytics) | Full-text search, Swahili NLP |
| SMS | Africa's Talking | SMS delivery for Kenya |
| Email | SendGrid | Transactional email (53 templates) |
| Routing | OSRM | Delivery route calculation |
| Monitoring | Cloud Monitoring + Cloud Logging | 19 alert policies, structured logs |
| Secrets | GCP Secret Manager | All credentials (never in code) |

---

## 2. Service Boundaries — Modular Microservices on Cloud Functions

Each service domain owns its Cloud Function modules and its Firestore collections. Cross-domain data access must go through the owning service's API (a Cloud Function), never by reading another domain's collection directly from client code.

### 2.1 Auth Service

**Responsibility:** Identity, attestation, role assignment, session management, Zero Trust evaluation.

**CF Modules:**
- `functions/auth.js` — register, login, logout, custom claims assignment
- `functions/security.js` — Zero Trust evaluation, session validation, brute-force lockout
- `sokoni-appcheck.js` — App Check bootstrap (client SDK)
- `sokoni-zero-trust.js` — Zero Trust client SDK (injected globally via shared-header.js)

**Collections Owned:**
```
users/{uid}
  └─ fcmTokens/{tokenId}
userSessions/{sessionId}
securityAuditLog/{entryId}
authAttempts/{uid}
trustedDevices/{deviceId}
```

**Key Behaviours:**
- All custom claims (`seller`, `admin`, `rider`, `owner`, etc.) set server-side via `admin.auth().setCustomUserClaims()` — never client-side
- App Check enforced on all Cloud Functions (ReCaptchaV3 for web)
- Zero Trust: every request evaluated regardless of network origin; device posture + IP reputation + behaviour signals combined into trust score
- Brute-force: 5 failed login attempts → 15-minute lockout (Firestore-backed, not Redis, so it survives Redis unavailability)
- Session idle timeout: configurable (default 2 hours)

---

### 2.2 Marketplace Service

**Responsibility:** Product catalog, listings, categories, seller management, reviews, search indexing.

**CF Modules:**
- `functions/products.js` — CRUD for product listings, variant management
- `functions/sellers.js` — seller onboarding, KYC, approval workflow
- `functions/reviews.js` — review submission, moderation, aggregate scoring
- `functions/search-index.js` — Typesense + Algolia sync on product write
- `functions/sokoni-search-pro.js` — enterprise search engine (25 CFs, Swahili NLP)

**Collections Owned:**
```
products/{productId}
  └─ variants/{variantId}
sellers/{sellerId}
reviews/{reviewId}
searchAnalytics/{queryId}
recentlyViewed/{uid}/items/{productId}
savedSearches/{uid}/searches/{searchId}
priceAlerts/{alertId}
productStats/{productId}
```

**Key Behaviours:**
- All product writes trigger `search-index.js` to sync Typesense and Algolia
- Seller onboarding: hub-register.js → review queue → admin approval → claim grant
- Reviews: transaction-gated (buyer must have completed order for product)
- Search: 3-tier fallback: Typesense → Algolia → Firestore native query
- Swahili NLP: tokenisation + stopword removal + Kiswahili synonym expansion
- Listing quality scoring: 7-dimension score (images, description length, pricing, category, stock, reviews, responsiveness)

---

### 2.3 Commerce Service

**Responsibility:** Cart management, checkout orchestration, order lifecycle, payment initiation, commission calculation.

**CF Modules:**
- `functions/orders.js` — order creation, status transitions, cancellation
- `functions/checkout.js` — cart validation, price lock, checkout session
- `functions/payment-orchestrator.js` — payment state machine, provider dispatch
- `functions/commission.js` — commission calculation, double-entry ledger
- `functions/cart.js` — shared cart operations for marketplace and POS

**Collections Owned:**
```
orders/{orderId}
  └─ items/{itemId}
checkoutSessions/{sessionId}
payments/{paymentId}
  └─ history/{txId}
paymentIdempotency/{key}
commissionRules/{ruleId}
commissionLedger/{entryId}
sellerEarnings/{sellerId}
```

**Order State Machine:**
```
draft → confirmed → processing → packed → shipped → delivered → completed
  └──────────────────────────────────────────────────────────► cancelled
                                                                    └─► refunded
```

**Payment State Machine:**
```
created → pending → processing → succeeded
                       └──────────────────► failed → (refunded)
                       └──────────────────► cancelled
```

**Key Behaviours:**
- Payment idempotency: `paymentIdempotency/{orderId_method_amount_hash}` — 24h TTL, duplicate attempts return existing `paymentId`
- Redis payment lock (NX, 30s TTL) prevents double-charge race conditions
- Client-side payment confirmation never trusted; server-side provider API verification always required
- Payments stuck in `processing` > 30 minutes auto-failed by `paymentTimeoutSweep` scheduler
- Commission: 6 rule types — `percentage`, `fixed`, `percentage_plus_fixed`, `tiered`, `commission_holiday`, `custom`
- Multi-seller orders: single buyer order split into per-seller sub-orders at checkout

---

### 2.4 Delivery Service

**Responsibility:** Rider dispatch, delivery lifecycle, GPS tracking, fleet management, route optimisation.

**CF Modules:**
- `functions/delivery.js` — delivery creation, assignment, status lifecycle
- `functions/sokoni-navigation.js` — GPS tracking, OSRM routing, spoofing detection
- `functions/dispatch.js` — 8-factor rider scoring and assignment
- `functions/fleet-monitor.js` — fleet-wide visibility, performance dashboards

**Collections Owned:**
```
deliveries/{deliveryId}
  └─ trackingPoints/{pointId}
riders/{riderId}
riderStats/{riderId}
dispatchQueue/{queueId}
fleetAlerts/{alertId}
```

**Key Behaviours:**
- 8-factor dispatch scoring: distance, rating, cancellation rate, online time, vehicle type, load capacity, zone familiarity, current load
- GPS spoofing detection: speed > 150 km/h between consecutive points → flag + alert
- Auto-suspend: rider with ≥10 cancellations in rolling 30 days → automatically suspended pending review
- QR verification: signed QR scanned at pickup and delivery (HMAC-protected)
- Customer signature capture at delivery
- CSAT collected post-delivery; fed to rider score

---

### 2.5 Booking Service

**Responsibility:** Venue reservations, BnB listings, car rental, event ticketing, slot management.

**CF Modules:**
- `functions/booking.js` — atomic slot locking, reservation lifecycle, cancellation
- `functions/events.js` — event creation, ticketing, gate check-in
- `functions/venue-manager.js` — venue profiles, availability calendar, pricing modifiers

**Collections Owned:**
```
venues/{venueId}
  └─ availability/{slotId}
bookings/{bookingId}
events/{eventId}
  └─ tickets/{ticketId}
gateCheckins/{checkinId}
```

**Key Behaviours:**
- Atomic slot locking: Firestore transaction; 2-minute hold while payment completes
- Pricing modifiers: 8 types (peak hour, weekend, advance booking, minimum stay, cleaning fee, damage deposit, group discount, member rate)
- Event tickets: QR-based; HMAC-signed; single-use scan flag set on check-in
- Cancellation: rule-based refund percentages (e.g. 100% if > 48h before, 50% if > 24h, 0% if < 12h)

---

### 2.6 Financial Service

**Responsibility:** Financial OS, wallet, settlement, reconciliation, eTIMS, payroll, business health.

**CF Modules:**
- `functions/financial-os.js` — 12 CFs: escrow, settlement, dispute resolution, 7-day forecast
- `functions/finos-automation.js` — 7 CFs: auto-settlement (6h schedule), auto-refund trigger, IntaSend reconcile, AI forecast, settlement config CRUD, audit trail
- `functions/etims.js` — 28 CFs: KRA eTIMS electronic receipting, AES-256-GCM credentials
- `functions/hr-payroll.js` — Kenya PAYE, NHIF, NSSF computation and payslip generation
- `functions/wallet.js` — wallet top-up, balance queries, internal transfers

**Collections Owned:**
```
wallets/{uid}
  └─ transactions/{txId}
settlements/{settlementId}
settlementQueue/{itemId}
reconciliationRecords/{recordId}
etimsRecords/{receiptId}
etimsCredentials/{merchantId}      (AES-256-GCM encrypted at rest)
payrollRecords/{payrollId}
businessHealth/{merchantId}
foundationLedger/{entryId}
```

**Key Behaviours:**
- Double-entry ledger: every financial movement creates matching debit + credit entries; total always balances to zero
- Settlement: automated every 6 hours via Cloud Scheduler; holds released after delivery confirmation
- eTIMS: integrated with KRA's electronic receipting system; receipts generated on every completed sale
- Payroll: PAYE tax brackets (2026 Kenya Finance Act), NHIF/NSSF statutory deductions
- Business Health Score: 5-dimension composite (revenue trend, order velocity, return rate, stock health, customer retention)
- WHT (5%), VAT (16%), DST (1.5%) compliance computed at checkout

---

### 2.7 Loyalty Service

**Responsibility:** Points ledger, tier management, cashback, gift cards, lucky draws, QR loyalty cards.

**CF Modules:**
- `functions/loyalty.js` — 26 CFs: points earn/burn, tier promotion, campaign engine
- `functions/loyalty-enterprise.js` — 16 CFs: cashback, gift cards, lucky draws, AI personalisation, fraud dashboard, cross-merchant network

**Collections Owned:**
```
loyaltyAccounts/{uid}
loyaltyTransactions/{txId}
loyaltyTiers/{tierId}
loyaltyCampaigns/{campaignId}
giftCards/{cardId}
luckyDraws/{drawId}
loyaltyQRCodes/{codeId}
crossMerchantNetwork/{networkId}
```

**Key Behaviours:**
- Tiers: Bronze → Silver → Gold → Platinum (spend-based, rolling 12 months)
- Points earn: triggered by `payment.transaction.completed` event; rate configurable per category
- Points burn: at checkout as partial payment discount
- QR loyalty cards: SKN-XXXX format, HMAC-signed, offline sync via `LOYALTY_HMAC_SECRET`
- AI personalisation: Claude claude-haiku-4-5 generates per-user offer recommendations
- Cross-merchant network: customers earn/burn across enrolled merchant partners
- Fraud: velocity detection on redemption (>3 burns in 60 minutes flagged)

---

### 2.8 Notification Service

**Responsibility:** Multi-channel notification delivery — push, SMS, email, in-app.

**CF Modules:**
- `functions/notifications.js` — notification CRUD, delivery dispatch, token lifecycle
- `sokoni-notif-engine.js` — client-side notification SDK (5 priorities, 20 categories, DND)

**Collections Owned:**
```
notifications/{notifId}
notificationPreferences/{uid}
notificationQueue/{queueId}
notificationTemplates/{templateId}
```

**Key Behaviours:**
- 5 priority tiers: `urgent`, `high`, `normal`, `low`, `silent`
- 20 categories with per-category DND settings per user
- Multi-channel: FCM push → Africa's Talking SMS → SendGrid email (priority cascade)
- Invalid FCM tokens auto-removed on first delivery failure
- 53 email templates with Handlebars variable substitution
- Redis-queued: notifications pushed to Redis queue, worker dispatches every minute
- Rate limiting: max 50 notifications per user per 24 hours (non-urgent)

---

### 2.9 Messaging Service

**Responsibility:** Business communications, transaction-gated chat, order-linked threads.

**CF Modules:**
- `functions/messages.js` — message CRUD, thread management, media attachments
- `sokoni-chat-engine.js` — client-side chat SDK

**Collections Owned:**
```
conversations/{conversationId}
  └─ messages/{messageId}
messageMedia/{mediaId}
```

**Key Behaviours:**
- Transaction-gated: buyer can only message a seller once they have a completed or active order
- Order-linked threads: conversation tied to orderId for dispute resolution context
- Media: images and documents stored in Cloud Storage, references in Firestore
- Typing indicators: Firestore real-time listeners (no Redis needed for this volume)
- Message read receipts: Firestore write on message open

---

### 2.10 AI Service

**Responsibility:** KASS AI concierge, search intelligence, business insights, fraud detection, creative studio.

**CF Modules:**
- `functions/kass.js` — sokoniChat CF; 6 Firestore tools; Claude claude-haiku-4-5 with contextual tool use
- `functions/ai-engine.js` — AI job queue, 4 subscription tiers, credits/boosts
- `sokoni-creative.js` — AI creative studio (product descriptions, marketing copy)
- `functions/fraud.js` — ML-pattern fraud detection integrated into payment flow

**Collections Owned:**
```
aiSessions/{sessionId}
aiJobs/{jobId}
mediaAssets/{assetId}
brandKits/{kitId}
aiSubscriptions/{uid}
aiUsageLogs/{logId}
```

**AI Model Assignment:**
| Use Case | Model | Reason |
|---|---|---|
| KASS chat (real-time) | `claude-haiku-4-5-20251001` | Low latency, low cost |
| Business insights | `claude-sonnet-4-6` | Better reasoning for analytics |
| Long-form content | `claude-sonnet-4-6` | Document-quality output |

**Key Behaviours:**
- Response caching: Redis, 1-hour TTL; key = SHA-256(model + sanitised prompt)
- PII redaction before caching: KRA PIN, phone, email, card numbers stripped from cache keys
- AI subscription tiers: `ai_free` → `ai_basic` → `ai_pro` → `ai_enterprise`; credits + boosts system
- AI Policy Engine: `Verified` / `Calculated` / `Predicted` wrappers; confidence badges on all AI output
- Background AI jobs: `QueueService.push('ai', job)` for non-real-time generation
- Fraud detection: velocity + amount pattern + network analysis; integrated into payment-orchestrator.js

---

### 2.11 SmartPOS Service

**Responsibility:** Point-of-sale checkout, inventory, receipts, peripheral hardware, shift management, multi-device sync.

**CF Modules:**
- `functions/pos.js` — POS session CRUD, cart mutations, payment processing
- `functions/pos-peripherals.js` — peripheral registration, heartbeat, customer display
- `functions/pos-analytics.js` — shift reports, daily summaries, performance dashboards
- `functions/pos-inventory.js` — FEFO/AVCO inventory, reorder alerts
- `sokoni-device-hub.js` — USB/BT/Serial/Network peripheral adapters (client SDK)
- `sokoni-payment-terminal.js` — 12 terminal drivers behind unified interface (client SDK)
- `sokoni-customer-display.js` — multi-channel display sync (client SDK)
- `pos-manager-auth.js` — PIN/QR/NFC/Mobile/Biometric manager authorisation

**Collections Owned:**
```
posSessions/{sessionId}
posTransactions/{txId}
merchants/{merchantId}
  └─ posPeripherals/{deviceId}
  └─ posAudit/{entryId}
  └─ shifts/{shiftId}
posCustomerDisplays/{sessionId}
```

**Sync Architecture (3 layers):**
```
Layer 1: Firestore onSnapshot (<100ms) — all connected devices
Layer 2: Redis POSService (500ms poll) — customer display, manager tablet
Layer 3: IndexedDB offline queue — when device is disconnected
```

**Key Behaviours:**
- Multi-device session: cashier terminal + manager tablet + customer display all share same `posSessions/{id}`
- Session access controlled by `memberUids[]` field (Firestore rules enforce this)
- Cart mutations go through `updatePosCart` CF (transactional, prevents concurrent-write conflicts)
- Hardware adapters: 12 payment terminal drivers, USB/BT/Serial/Network printer protocols, WebUSB/Web Bluetooth scanner support
- Manager authorisation: 5 methods; 8 guarded operations; immutable audit log
- Offline: cart ops queued in IndexedDB (sokoni_offline DB); flushed on reconnect via `SokoniRedis.offline.flush()`

---

### 2.12 Analytics Service

**Responsibility:** Merchant analytics, platform-wide BI, funnel tracking, search insights, executive reporting.

**CF Modules:**
- `functions/bi-advanced.js` — enterprise BI (6 KPI categories, export, drill-down)
- `functions/analytics.js` — funnel event recording, daily/weekly aggregation
- `functions/crm.js` — CRM data, customer lifetime value, cohort analysis
- `functions/platform-analytics.js` — platform-level revenue, GMV, active merchants

**Collections Owned:**
```
funnelStats/{date}
analyticsEvents/{eventId}
merchantAnalytics/{merchantId}
  └─ daily/{date}
platformMetrics/{timestamp}
searchAnalytics/{queryId}
conversionFunnels/{funnelId}
```

**Key Behaviours:**
- Funnel events: `productViewed → searchPerformed → cartAdded → checkoutStarted → paymentAttempted → orderCompleted`
- Daily rollups: Cloud Scheduler aggregates raw events into daily summaries; raw events pruned at 30 days
- Merchant-facing: seller dashboard shows real-time GMV, order count, return rate, top products
- Executive dashboard: platform GMV, category breakdown, geographic heatmap, growth rate
- Search insights: no-result query terms, top queries by volume, conversion rates per query

---

### 2.13 Admin Service

**Responsibility:** Admin OS, operations centre, platform hub, super-admin portal, self-healing, hub registry.

**CF Modules:**
- `functions/admin.js` — admin actions, seller approval, dispute resolution, content moderation
- `functions/operations-center.js` — ops dashboard data, metric snapshots, self-heal triggers
- `functions/platform-hub.js` — 10 CFs: hub registry, WAP delay scheduler, per-hub feature flags
- `functions/automation-center.js` — 15 CFs: account lifecycle, intelligent dispatch, AI dispute resolution

**Collections Owned:**
```
adminActions/{actionId}
opsMetrics/{timestamp}
selfHealLog/{logId}
platformHubs/{hubId}
hubFlags/{hubId}
automationRules/{ruleId}
disputeQueue/{disputeId}
```

**Key Behaviours:**
- Admin OS: 19 panels, 19 KPI cards, tabbed comms/analytics/config/SmartPOS/financial
- Self-healing scheduler (every 15 min): retries stuck payments, replays dead-letter events, closes stale POS sessions, reconciles inventory orphans
- Hub registry: `registerHub()` SDK; per-hub feature flags; WAP delay scheduler for staged rollout
- Role switcher: injected in shared-header.js for multi-role users
- Automation engine: configurable rules for account lifecycle (seller trial → active → suspended → reinstated)

---

### 2.14 Media Service

**Responsibility:** Image processing, creative studio, brand kit management, asset library.

**CF Modules:**
- `functions/media-engine.js` — image resize, WebP conversion, thumbnail generation
- `sokoni-creative.js` — AI creative studio client SDK
- `functions/storage-triggers.js` — Firestore triggers on Cloud Storage events

**Collections Owned:**
```
mediaAssets/{assetId}
brandKits/{kitId}
processingJobs/{jobId}
```

**Key Behaviours:**
- All product images processed on upload: max 1200px, WebP conversion, thumbnail at 400px
- Storage lifecycle: images for archived products deleted after 180 days
- Brand kits: logo, colour palette, fonts stored per merchant; used for AI-generated content
- AI creative studio: generates product descriptions, marketing copy, social media captions using `claude-sonnet-4-6`

---

### 2.15 Hub Services

Each vertical hub is a thin service layer that reuses the shared platform engines (Commerce, Booking, Delivery, Notification) while owning its domain-specific data.

| Hub | Description | Key CFs | Domain Collections |
|---|---|---|---|
| Food Hub | Restaurant ordering, menus, kitchen management | `food.js` | `restaurants`, `menus`, `kitchenOrders` |
| Events Hub | Event lifecycle, ticketing, gate check-in | `events.js` (19 CFs) | `events`, `tickets`, `checkins` |
| Healthcare Hub | Appointments, telemedicine, prescriptions | `healthcare.js` | `practitioners`, `appointments`, `consultations` |
| Education Hub | Courses, enrolment, progress tracking | `education.js` (8 CFs) | `courses`, `enrolments`, `progress` |
| Property Hub | Buy/rent listings, BnB | `property.js` | `properties`, `propertyBookings` |
| Vehicles Hub | Car rental, NTSA integration, garages | `vehicles.js` | `vehicles`, `rentals`, `serviceRecords` |
| Jobs Hub | Job posts, applications, employer dashboard | `jobs.js` | `jobListings`, `applications` |
| Legal Hub | Service listings, document templates | `legal.js` | `legalServices`, `legalConsultations` |
| Entertainment Hub | Content, events, ticketing | `entertainment.js` | `entertainmentListings` |
| B2B Wholesale Hub | Bulk ordering, trade accounts | `b2b.js` (12 CFs) | `tradeAccounts`, `bulkOrders`, `catalogues` |
| Foundation Hub | Donations, campaigns, disbursements | `foundation.js` | `foundationCampaigns`, `donations` |

---

## 3. Data Architecture

### 3.1 Firestore Collection Naming Conventions

Collections follow camelCase plural naming. Subcollections are used only when data is tightly owned by the parent document and always accessed in that parent's context.

**Rules:**
- Collections: `camelCasePlural` — e.g. `products`, `orders`, `posTransactions`
- Documents: auto-ID (Firestore's `add()`) for most collections; `{uid}` as document ID for per-user collections
- Subcollections: only when the child data is never queried across parents (e.g. `orders/{id}/items` is fine; `users/{id}/orders` is not — orders are queried across all buyers by admin)
- Audit and history subcollections: `{parent}/{id}/history/{entryId}`, `{parent}/{id}/audit/{entryId}`

**Field naming:** camelCase for all fields. Timestamps always use Firestore `Timestamp` type, never Unix integers. Monetary amounts always stored as integers in the smallest currency unit (KES cents = 100 = KES 1.00) to avoid floating-point drift.

### 3.2 Sharding Strategy for High-Volume Collections

#### Orders — Shard by orderId Prefix

Firestore distributes documents across tablet servers. A single sequential counter would hot-spot. Instead:

```
orders collection — documents auto-IDed by Firestore
All orders for a seller: query where sellerId == X (indexed)
All orders for a buyer: query where buyerId == X (indexed)
Admin full scan: paginated, cursor-based, never unbounded

For analytics: daily aggregate document pattern
orderStats/{YYYY-MM-DD}
  └─ totalOrders: number (FieldValue.increment)
  └─ totalGMV: number
  └─ byCategory: { [categoryId]: count }
```

#### Notifications — Shard by UID Prefix

Rather than a global `notifications` collection that would hot-spot at scale, notifications are queryable by uid via composite index `(uid, createdAt DESC)`. Document IDs are Firestore auto-IDs (which Firestore distributes automatically).

For push-delivery queuing at high volume:
```
notificationQueue/{shardId}    shardId = uid.substring(0, 2)  (256 logical shards)
  └─ items: [] array capped at 100 per document
```

#### Analytics Events — Time-Bucketed Documents

Raw events are never stored one-per-document (too expensive at scale). Instead:

```
analyticsEvents/{YYYY-MM-DD-HH}    (hourly bucket documents)
  └─ events: []     array, max 500 events per bucket
  └─ count: number  FieldValue.increment on each append
  └─ createdAt, updatedAt: Timestamp

Rollup: Cloud Scheduler aggregates hourly → daily → weekly documents
Raw retention: 30 days (TTL policy on analyticsEvents)
Aggregated retention: permanent
```

#### Counters — Distributed Counter Pattern

For platform-wide totals (total orders, total GMV, active sellers), a single document would hit Firestore's 1 write/second limit at scale. Distributed counters distribute writes:

```
_counters/{counterId}/shards/{shardId}   (shardId: "0" through "9" = 10 shards)
  └─ value: number

Read total: sum across all 10 shards
Write: pick random shard 0-9, FieldValue.increment(delta)
Maximum write throughput: ~10 writes/second per counter (vs 1 without sharding)

Counters in use:
  platform_total_orders        (10 shards)
  platform_total_gmv           (10 shards)
  platform_active_sellers      (10 shards)
  platform_daily_transactions  (10 shards)
```

### 3.3 Index Strategy

All queries have a matching composite index. Index budget: 200 indexes maximum (Firebase limit).

**Current state:** 197+ composite indexes deployed.

**Overflow strategy:** When the 200 index limit is reached, new indexes go to `sokoni-ops` (second Firestore database). High-cardinality analytical queries are the first candidates for migration.

**Governance rule:** Never drop an existing index. Dropping an index breaks all clients that haven't been updated. Add only; remove never.

**Common index patterns:**
```
# Orders by seller + date (seller dashboard)
orders: [sellerId ASC, createdAt DESC]

# Orders by buyer (buyer order history)
orders: [buyerId ASC, createdAt DESC]

# Products by category + price (marketplace grid)
products: [categoryId ASC, price ASC]

# Notifications by user + priority (notification tray)
notifications: [uid ASC, priority DESC, createdAt DESC]

# Analytics by merchant + date (merchant dashboard)
merchantAnalytics: [merchantId ASC, date DESC]
```

### 3.4 Data Retention Policy

| Data Type | Retention | Policy |
|---|---|---|
| Raw analytics events | 30 days | Firestore TTL policy on `analyticsEvents` |
| Aggregated analytics | Permanent | Never deleted; storage cost is minimal for aggregated data |
| Notification records | 90 days | TTL policy on `notifications` |
| Search analytics | 90 days | TTL policy on `searchAnalytics` |
| Audit logs | 7 years | Permanent (Kenya compliance requirement) |
| Payment records | 7 years | Permanent (KRA compliance) |
| User PII | Until account deletion + 30 days | GDPR-compatible; then anonymised |
| POS transactions | 5 years | Tax compliance |
| Redis data | Per TTL (seconds to 24h) | Operational only; no retention expectation |
| Cloud Storage media | Per lifecycle rule | Archived product images deleted after 180 days |
| Firestore PITR | 7 days | Point-in-time recovery window |
| Firestore exports | 30 days | Nightly export to Cloud Storage |

### 3.5 Firestore Security Rules Architecture

Default deny. Each collection requires an explicit allow rule per role.

**Principles:**
- `request.auth != null` required for all non-public reads
- `request.auth.token.{claim}` used for role checks (never `request.auth.uid` on its own for write access)
- Document-scoped writes: `resource.data.uid == request.auth.uid` or `resource.data.sellerId == request.auth.uid`
- Admin claims checked via `request.auth.token.admin == true`
- Subcollection access follows parent document ownership

```javascript
// Pattern: user-owned data
match /users/{uid}/{document=**} {
  allow read, write: if request.auth.uid == uid || request.auth.token.admin == true;
}

// Pattern: seller-owned data with admin read
match /products/{productId} {
  allow read: if request.auth != null;
  allow create: if request.auth.token.seller == true;
  allow update, delete: if resource.data.sellerId == request.auth.uid
                        || request.auth.token.admin == true;
}

// Pattern: admin-only write
match /commissionRules/{ruleId} {
  allow read: if request.auth.token.seller == true || request.auth.token.admin == true;
  allow write: if request.auth.token.admin == true;
}
```

---

## 4. Performance Architecture

### 4.1 CDN Layer

Firebase Hosting provides a global CDN with automatic SSL and HTTP/2. All static assets are served from the nearest PoP to the user, typically within 50ms in East Africa.

Cloudflare is deployed as an optional additional layer providing:
- Web Application Firewall (WAF)
- DDoS protection
- Canary traffic splitting (for gradual rollouts)
- Additional edge caching for API responses

**Cache hierarchy:**
```
User browser cache (immutable assets: 1 year)
    ↓ miss
Cloudflare edge cache (API responses: 60s catalog, bypass user-specific)
    ↓ miss
Firebase Hosting CDN (static assets: immutable)
    ↓ miss
Origin: Cloud Functions / Firebase Hosting
```

### 4.2 Cache Headers Strategy

All resources have explicit Cache-Control headers. No implicit caching.

| Resource Type | Cache-Control | Notes |
|---|---|---|
| HTML shell (`index.html`) | `no-cache` | Always revalidated; SW serves from cache |
| JS/CSS (hashed filenames) | `public, max-age=31536000, immutable` | 1-year cache; filename hash changes on update |
| Product images | `public, max-age=86400` | 24-hour CDN cache; Cloud Storage served |
| API responses (catalog) | `public, s-maxage=60` | 60 seconds at CDN; private at client |
| API responses (user-specific) | `private, no-store` | Never cached at CDN |
| Service Worker script | `no-cache` | Browser always revalidates SW |

**Cloudflare caveat:** SW script must have `CDN-Cache-Control: no-store` to prevent Cloudflare caching it for 7 days (known bug — see `project_cloudflare_sw_cache.md`).

### 4.3 API Response Caching

| Endpoint Category | Cache Location | TTL | Strategy |
|---|---|---|---|
| Product catalog (listings grid) | Redis | 60 seconds | Cache-aside; invalidated on product write |
| Product detail | Redis | 300 seconds | Cache-aside; invalidated on product write |
| Search results | Redis | 60 seconds | Key = SHA-256(query + filters) |
| AI responses | Redis | 3600 seconds | Key = SHA-256(model + sanitised prompt) |
| User-specific data | No cache | — | Always fresh from Firestore |
| Admin dashboards | Redis | 30 seconds | Tolerate 30s staleness for dashboard KPIs |
| Merchant analytics | Redis | 120 seconds | Merchant-specific; key includes merchantId |

### 4.4 Service Worker — Offline-First Strategy

Service Worker `sokoni-v{N}` implements a cache-then-network strategy for the application shell:

```
SW Cache Strategy Map:
  /                     → Cache First (app shell)
  /index.html           → Network First (ensures latest)
  /sokoni-*.js          → Cache First (hashed; safe to cache indefinitely)
  /sokoni-tokens.css    → Cache First
  /shared-header.js     → Stale-while-revalidate (1h)
  /marketplace.html     → Stale-while-revalidate (1h)
  /product/*            → Network First (product data must be fresh)
  /checkout.html        → Network Only (payment pages never cached)
  External: Firebase SDK → Cache First

Background sync:
  - Failed write operations queued in IndexedDB
  - Background sync tag: 'sokoni-sync'
  - Replay on next connectivity
```

**CACHE_VERSION** is bumped on every significant deployment to bust cached SW.

### 4.5 Image Pipeline

All product images pass through a processing pipeline on upload:

```
Upload → Cloud Storage trigger → media-engine.js CF
    ↓
1. Validate: MIME type (JPEG/PNG/WebP only), max 10MB input
2. Resize: max 1200×1200px (preserve aspect ratio)
3. Convert: WebP output (typically 30–50% smaller than JPEG)
4. Thumbnail: 400×400px WebP for grid view
5. Store: original + processed + thumbnail in Cloud Storage
6. Update: product.imageUrl, product.thumbnailUrl in Firestore
```

Client-side lazy loading:
```html
<img src="{thumbnailUrl}" loading="lazy" decoding="async"
     width="400" height="400" alt="{productName}">
```

All images have explicit `width` and `height` to prevent layout shift (CLS target: < 0.1).

### 4.6 Core Web Vitals Targets

| Metric | Target | Ceiling | Current Strategy |
|---|---|---|---|
| LCP (Largest Contentful Paint) | < 2.5s | < 4.0s | Preconnect hints, critical CSS inline, lazy images |
| CLS (Cumulative Layout Shift) | < 0.1 | < 0.25 | Explicit width/height on all images, no layout-shifting ads |
| INP (Interaction to Next Paint) | < 200ms | < 500ms | Debounced inputs, async handlers, deferred non-critical JS |
| TTFB (Time to First Byte) | < 600ms | < 1000ms | CDN edge serving, preconnect to Firebase |
| FCP (First Contentful Paint) | < 1.8s | < 3.0s | Critical path CSS inlined, SW cache |

Tracking: CWV metrics reported to `_sokoniTelemetry` Firestore collection via client-side observer (`PerformanceObserver`).

---

## 5. Resilience Architecture

### 5.1 Circuit Breakers

Circuit breakers prevent cascade failures by stopping requests to a degraded dependency before the failures propagate. Each external service has its own circuit breaker state tracked in Redis.

```
Circuit Breaker State Machine:
  CLOSED (normal) ──► OPEN (failing)
      ▲                    │
      └─────────── HALF-OPEN (probing)

Thresholds (configurable per service):
  CLOSED → OPEN:     5 failures in 60s window
  OPEN → HALF-OPEN:  30s cooldown
  HALF-OPEN → CLOSED: 1 success
  HALF-OPEN → OPEN:   1 failure

Services with circuit breakers:
  IntaSend payments      60s cooldown
  Anthropic AI           30s cooldown
  Typesense search       15s cooldown
  Algolia search         15s cooldown
  Africa's Talking SMS   60s cooldown
  SendGrid email         60s cooldown
  OSRM routing           30s cooldown
  Redis itself           immediate Firestore fallback
```

### 5.2 Retry Policy

Transient failures are retried with exponential backoff and jitter to prevent thundering herd.

```javascript
// Retry configuration
{
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30000,
  jitterFactor: 0.2,    // ±20% randomisation
  retryableErrors: [
    'UNAVAILABLE',        // Firestore / gRPC temporary unavailability
    'DEADLINE_EXCEEDED',  // Timeout
    'INTERNAL',           // Internal server error (5xx)
    'RESOURCE_EXHAUSTED', // Quota temporarily exceeded
  ],
  // Never retry:
  nonRetryableErrors: [
    'INVALID_ARGUMENT',   // Client sent bad data; retry won't help
    'NOT_FOUND',          // Resource doesn't exist
    'ALREADY_EXISTS',     // Idempotency key already consumed
    'PERMISSION_DENIED',  // Auth failure; retry won't help
    'FAILED_PRECONDITION',// Business rule violation
  ]
}

// Delay calculation:
delay = min(baseDelayMs × 2^attempt, maxDelayMs) × (1 + jitter)
// attempt=0: ~500ms, attempt=1: ~1000ms, attempt=2: ~2000ms
```

### 5.3 Dead-Letter Queues

Failed operations that exhaust retries go to dead-letter queues for manual or automated recovery.

| Queue | Trigger | Dead-Letter Collection | Recovery |
|---|---|---|---|
| Platform events | 3 failed subscriber deliveries | `platformEvents` (status: `dead_letter`) | `selfHeal.replayDeadEvents()` every 15m |
| Notification delivery | 3 failed channel attempts | `notificationDeadLetter/{id}` | Admin review + re-queue |
| Webhook delivery | 3 failed HTTP POSTs | `webhookDeadLetter/{id}` | Auto-retry at T+1h, T+6h, T+24h |
| Payment processing | Provider timeout (IntaSend) | `paymentDeadLetter/{id}` | Manual review required; financial impact |
| Queue worker jobs | 3 failed processing attempts | `redisJobDeadLetter/{jobId}` | Admin review in ops-center.html |
| AI jobs | Provider error | `aiDeadLetter/{jobId}` | Auto-retry with lower model if budget allows |

Dead-letter events are visible in the Operations Center (ops-center.html) under the "Dead Letter" tab. Alert fires when `dead_letter_count > 100`.

### 5.4 Graceful Degradation

Each dependency degradation has a defined fallback:

| Dependency Fails | Degradation | User Impact | Data Impact |
|---|---|---|---|
| Redis | Firestore fallback for all state; rate limiting suspended | ~50ms latency increase | None — Redis is never source of truth |
| Typesense search | Algolia fallback → Firestore text filter | Search quality degrades | None |
| Algolia (both) | Firestore native query (limited) | Search becomes basic filter | None |
| Anthropic AI | Cached response if available; "AI temporarily unavailable" message | AI features hidden | None |
| IntaSend payment | "Payment service temporarily unavailable"; pending queue | No new payments taken | None |
| Africa's Talking SMS | Email fallback for notifications | Notifications via email only | None |
| SendGrid email | Queued in Redis; retried when available | Email delivery delayed | Queued in Firestore |
| OSRM routing | Haversine straight-line estimate | Less accurate ETAs | None |
| Cloud Storage | Existing images served from CDN; new uploads queued | Uploads temporarily unavailable | Queued locally |

### 5.5 Health Checks

**Active health checks:** `obsHealthProbe` CF runs every 5 minutes via Cloud Scheduler. Checks:
- Firestore read/write round-trip
- Redis PING (if configured)
- Typesense cluster health
- IntaSend connectivity
- Recent payment success rate

**Passive health checks:** Cloud Monitoring monitors CF error rates, latency P95, and queue depths continuously.

**Alert threshold:** 3 consecutive health check failures trigger a CRITICAL alert to the ops team.

**Health endpoint:** `GET /health` returns JSON `{ ok: boolean, checks: {...}, timestamp }` — used by uptime monitors.

### 5.6 Idempotency

All state-mutating API calls require an idempotency key. The platform enforces this at two levels:

1. **Payment idempotency:** `paymentIdempotency/{orderId_method_amount_hash}` — 24h TTL. If a payment request arrives with a matching key, the existing payment record is returned, not a new charge created.

2. **Order idempotency:** `orders` documents use Firestore's transactional write with a `idempotencyKey` field. Duplicate order creation attempts with the same key return the existing order.

3. **CF trigger idempotency:** Firestore triggers can fire more than once for a single write (at-least-once semantics). All trigger handlers are idempotent: they check a `processed` flag or use Firestore transactions to prevent double-processing.

```javascript
// Pattern: idempotent trigger handler
async function handleOrderCompleted(orderId) {
  const ref = db.collection('commissionLedger').doc(`order_${orderId}`);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (doc.exists) return; // Already processed; exit silently
    tx.set(ref, { orderId, calculatedAt: Timestamp.now(), ...commissionData });
  });
}
```

---

## 6. Security Architecture

### 6.1 Zero Trust Model

Every request is evaluated regardless of its network origin. There is no "trusted internal network." A Cloud Function calling another Cloud Function is still subject to auth checks.

```
Inbound request (any origin)
        │
        ▼
App Check attestation (is this a genuine SOKONI client?)
        │
        ▼
Firebase Auth verification (who is this user?)
        │
        ▼
Custom claims RBAC (what can this user do?)
        │
        ▼
Rate limiter (is this user within their quota?)
        │
        ▼
Input sanitisation (is this input safe?)
        │
        ▼
Business logic
        │
        ▼
Audit log (record what happened)
```

No step can be bypassed. Middleware chain is applied uniformly across all `onCall` functions.

### 6.2 App Check

Firebase App Check is enforced on all Cloud Functions (`enforceAppCheck: true`). Uses ReCaptchaV3 for web clients.

**What App Check prevents:**
- Automated bots calling Cloud Functions directly (without a genuine client)
- Competitor scraping via CF endpoints
- Denial of service via direct CF invocation

**What App Check does not replace:**
- Authentication (still required separately)
- Authorisation (still enforced via custom claims)
- Rate limiting (still required for authenticated abuse)

### 6.3 HMAC Signing

HMAC-SHA256 is used for tamper-proof signing wherever data crosses an untrusted boundary:

| Use Case | Secret | Verification |
|---|---|---|
| IntaSend webhook callbacks | `PAYMENT_HMAC_SECRET` | `crypto.timingSafeEqual(expected, actual)` |
| POS QR code payments | `QR_SIGNING_SECRET` | Verified server-side before payment state change |
| Loyalty QR cards | `LOYALTY_HMAC_SECRET` | Offline HMAC verification at merchant |
| Platform webhooks (outbound) | `SOKONI_HMAC_KEY` | Subscriber verifies before processing |

Timing-safe comparison (`crypto.timingSafeEqual`) is always used — never string equality (`===`) — to prevent timing attacks.

### 6.4 Secrets Management

All secrets are stored in GCP Secret Manager. No secrets in:
- Source code (git history included)
- Environment variables committed to repository
- Cloud Logging output
- Client-side JS (even minified)

Secrets are accessed at runtime by Cloud Functions using the Secret Manager API. `functions/.env` is gitignored.

**Secrets registry:**
```
INTASEND_PRIVATE_KEY        M-Pesa + card payment provider
INTASEND_PUBLISHABLE_KEY    Client-side payment initialisation
QR_SIGNING_SECRET           POS QR HMAC
SOKONI_HMAC_KEY             Platform webhook HMAC
SENDGRID_API_KEY            Email delivery
REDIS_URL                   Memorystore connection string
ANTHROPIC_API_KEY           AI engine (Claude)
AT_API_KEY                  Africa's Talking SMS
AT_USERNAME                 Africa's Talking account
LOYALTY_HMAC_SECRET         Offline loyalty card verification
PAYMENT_HMAC_SECRET         Payment integrity checking
PAYROLL_ENCRYPTION_KEY      Payroll data at rest (AES-256)
ALGOLIA_ADMIN_KEY            Search index administration
ETIMS_API_KEY               KRA eTIMS integration
ETIMS_ENCRYPTION_KEY        eTIMS credential encryption
VAPID_PRIVATE_KEY           Web push notification signing
```

### 6.5 Rate Limiting — Three Layers

**Layer 1 — Cloudflare (edge):**
- IP-based rate limiting at WAF level
- Bot detection and challenge
- DDoS mitigation

**Layer 2 — API Gateway (CF middleware):**
- Per-UID + per-IP composite rate limiting via Redis INCR
- Different quotas per action type:

| Action | Limit | Window |
|---|---|---|
| `checkout` | 10 | 1 minute |
| `search` | 60 | 1 minute |
| `login` | 5 | 15 minutes |
| `message` | 30 | 1 minute |
| `review` | 5 | 1 hour |
| `payment.initiate` | 5 | 5 minutes |
| `admin.*` | 100 | 1 minute |
| `ai.generate` | 10 | 1 minute (free tier) |

**Layer 3 — Business logic (CF-level):**
- Domain-specific checks (e.g. max 3 payment retries per order)
- Firestore-backed for critical paths (survives Redis outage)

**Fallback:** If Redis is unavailable, rate limiting fails open (allows requests). Critical security controls (auth, payment verification) are Firestore-backed and unaffected.

### 6.6 Content Security Policy

Strict CSP applied via Firebase Hosting `firebase.json` headers:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline'    (unsafe-inline required by IntaSend SDK — tracked as tech debt)
             https://www.gstatic.com
             https://apis.google.com
             https://www.recaptcha.net;
  style-src 'self' 'unsafe-inline'
            https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data: blob:
          https://firebasestorage.googleapis.com
          https://lh3.googleusercontent.com;
  connect-src 'self'
              https://*.firebaseapp.com
              https://*.googleapis.com
              wss://*.firebaseio.com
              https://api.intasend.com
              https://api.anthropic.com;
  frame-src 'none';
  object-src 'none';
  report-uri https://us-central1-sokoni-aeb26.cloudfunctions.net/cspReport;
```

A shadow `Content-Security-Policy-Report-Only` policy is deployed alongside to test stricter rules before enforcement.

**Technical debt:** `unsafe-inline` in `script-src` is required by the current IntaSend SDK. Migration to nonce-based CSP is tracked as a planned improvement (depends on IntaSend SDK nonce support).

### 6.7 XSS Prevention

All dynamic DOM manipulation uses explicit escaping. No `innerHTML` with user-supplied values.

```javascript
// Mandatory escaping helper used throughout all HTML-generating code
function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Correct: element.textContent = userValue;
// Correct: element.innerHTML = _esc(userValue);
// Correct: element.setAttribute('data-id', _esc(id));
// NEVER:   element.innerHTML = userValue;   // XSS vulnerability
```

9 XSS vulnerabilities identified and fixed during RC1 hardening (commit ae543de). All flagged via internal audit using `innerHTML =` pattern search.

### 6.8 Input Validation

All Cloud Function inputs are validated and sanitised before business logic executes:

```javascript
function _san(value, maxLength = 200) {
  if (typeof value !== 'string') throw new HttpsError('invalid-argument', 'Expected string');
  const clean = value.trim().replace(/[<>'"\\]/g, '');
  if (clean.length > maxLength) throw new HttpsError('invalid-argument', 'Value too long');
  return clean;
}

function _validateAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000)
    throw new HttpsError('invalid-argument', 'Invalid amount');
  return Math.round(n * 100) / 100; // 2 decimal places only
}

function _validatePhone(phone) {
  // Kenya E.164: +254XXXXXXXXX (12 digits)
  if (!/^\+254[7][0-9]{8}$/.test(phone))
    throw new HttpsError('invalid-argument', 'Invalid Kenya phone number');
  return phone;
}
```

---

## 7. Observability Architecture

### 7.1 Structured Logging

All Cloud Functions emit structured JSON logs to Cloud Logging. Log entries are queryable using structured field filters.

```javascript
// Standard log format for all CFs
function log(severity, message, context = {}) {
  const entry = {
    severity,           // 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'
    message: `[${SERVICE_NAME}] ${message}`,
    timestamp: new Date().toISOString(),
    ...context,         // orderId, paymentId, userId, shopId, merchantId as applicable
    // Performance
    durationMs: context.start ? Date.now() - context.start : undefined,
    // Environment
    functionName: process.env.FUNCTION_NAME,
    region: process.env.FUNCTION_REGION,
  };
  // NEVER include in logs:
  // password, token, apiKey, cardNumber, pin, secret, privateKey
  // Phone numbers except last 4 digits ("XXXXXXXX1234")
  // Email addresses except domain ("****@gmail.com")
  console.log(JSON.stringify(entry));
}
```

**Log levels by scenario:**
- `DEBUG`: Development only; suppressed in production
- `INFO`: Normal operations (order created, payment initiated, rider assigned)
- `WARNING`: Non-critical issues (cache miss, retry attempt, degraded mode)
- `ERROR`: Business logic failures (payment failed, validation error)
- `CRITICAL`: System failures requiring immediate attention (Redis down, payment provider unresponsive)

### 7.2 Client Telemetry

Client-side performance and error data is collected and stored in Firestore for analysis.

```
_sokoniTelemetry/{uid}/events/{eventId}
  └─ type: 'cwv' | 'error' | 'journey' | 'page_load'
  └─ metric: string         (e.g. 'LCP', 'CLS', 'INP')
  └─ value: number
  └─ page: string           (e.g. '/marketplace')
  └─ userAgent: string
  └─ timestamp: Timestamp
  └─ connectionType: string (e.g. '4g', '3g')
```

**Core Web Vitals tracking:**
```javascript
// Installed on every page via shared-header.js
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    reportTelemetry({ type: 'cwv', metric: entry.name, value: entry.value });
  }
}).observe({ type: 'largest-contentful-paint', buffered: true });
```

**Error tracking:** `window.onerror` and `window.onunhandledrejection` capture all uncaught errors and send to `_sokoniTelemetry`.

**User journey tracking:** Key funnel events (`page_view`, `product_viewed`, `cart_add`, `checkout_start`, `payment_complete`) are recorded for funnel analysis.

**Retention:** Raw telemetry events pruned at 30 days; aggregated CWV summaries kept permanently.

### 7.3 Distributed Tracing

A `traceId` is propagated across all Cloud Function calls within a single business flow.

```javascript
// At API gateway entry point:
const traceId = req.headers['x-trace-id'] || generateTraceId();

// Injected into all logs:
log('INFO', 'Order created', { orderId, traceId });

// Passed to downstream CFs:
await publishEvent('order.order.created', { orderId, traceId });

// Subscriber CFs extract and continue:
const { traceId } = event.payload;
log('INFO', 'Processing commission', { orderId, traceId });
```

All logs with the same `traceId` can be found in Cloud Logging using the filter:
```
jsonPayload.traceId = "trace_abc123"
```

This allows tracing a complete payment flow across 5+ Cloud Functions without a dedicated tracing service.

### 7.4 Metrics Collection

**Server-side metrics:** `snapshotPlatformMetrics` (Cloud Scheduler, every 5 minutes):

```
opsMetrics/{ISO-timestamp}
  └─ orders: { active, pending, stuck, completedToday }
  └─ payments: { todayTotal, todayGMV, failedLast24h, stuckCount }
  └─ deliveries: { inTransit, overdue, ridersOnline }
  └─ pos: { openSessions, deviceCount, transactionsToday }
  └─ eventBus: { pendingEvents, deadLetterCount }
  └─ redis: { connected, memoryUsedMB, hitRate, queueDepths }
  └─ notifications: { queued, sentLast24h, failedLast24h }
  └─ ai: { requestsToday, cacheHitRate, spendToday }
  └─ users: { onlineLast5m, newToday, authFailures24h }
```

Snapshots retained for 7 days; older snapshots deleted by `cleanupOpsMetrics` scheduler.

**Client-side metrics:** Reported via `_sokoniTelemetry` collection (see §7.2).

### 7.5 Alerting — 19 Active Policies

| Alert | Severity | Threshold | Channel |
|---|---|---|---|
| CF error rate > 2% | CRITICAL | 5-min window | PagerDuty + Email |
| CF P95 latency > 3s | WARNING | 5-min window | Email |
| Payment failure rate > 5% | CRITICAL | 1-hour window | PagerDuty + Email |
| Stuck payments > 5 | WARNING | Any | Email |
| Memory > 85% | WARNING | 10-min sustained | Email |
| Redis disconnected | CRITICAL | Any | PagerDuty + Email |
| Redis memory > 80% | WARNING | Any | Email |
| Dead-letter events > 100 | WARNING | Snapshot | Email |
| Orders stuck in processing > 30m | WARNING | > 10 orders | Email |
| Auth failure spike > 50 in 5m | WARNING | Rolling | Email |
| Health endpoint down | CRITICAL | Any failure | PagerDuty |
| Queue depth > 1000 | WARNING | Per queue | Email |
| POS session errors > 5 | WARNING | 15-min window | Email |
| Delivery overdue > 10 | WARNING | Any | Email |
| API rate limit violations > 100/min | INFO | Rolling | Slack |
| Search index lag > 5m | WARNING | Any | Email |
| Disk > 80% (Memorystore) | WARNING | Any | Email |
| CF cold start > 2s (critical path) | INFO | Any | Slack |
| Stock depleted — high-value product | INFO | Any | Slack |

### 7.6 Audit Log

All security-significant actions are written to the audit log immediately, before business logic executes, so the attempt is recorded even if the action subsequently fails.

**Audit log collections:**
```
securityAuditLog/{entryId}      Security events (auth, privilege escalation, HMAC failures)
adminActions/{actionId}         All admin panel actions with actor, target, old/new values
paymentAuditLog/{entryId}       Every payment state transition with actor + timestamp
posAudit/{merchantId}/{entryId} Every POS manager authorisation action
```

**Fields on every audit log entry:**
```
actorUid:     string    Who performed the action
actorRole:    string    Their role at time of action
action:       string    What they did (e.g. 'seller.approve', 'order.cancel')
targetId:     string    What was affected (orderId, userId, etc.)
before:       object    State before change (for updates)
after:        object    State after change
ipAddress:    string    Requester IP (masked: last octet replaced with .xxx)
userAgent:    string    Browser/client identifier
timestamp:    Timestamp When it happened
correlationId:string    Business flow trace ID
```

---

## 8. Known Bottlenecks and Mitigations

### 8.1 Firestore — 1 Write/Second Per Document

**Problem:** Firestore limits each document to approximately 1 write per second. High-frequency global counters (total orders, total GMV) would contend on a single document.

**Mitigation:** Distributed counter pattern — 10 shards per counter. Each write picks a random shard. Maximum throughput: ~10 writes/second per counter. Read by summing all shards.

**When to re-evaluate:** If transaction rate exceeds 1,000/minute, consider upgrading to 100 shards or aggregating via Cloud Pub/Sub.

### 8.2 Cloud Function Cold Starts

**Problem:** Gen2 Cloud Functions scale to zero when idle. First invocation after idle period incurs a cold start (~300–800ms for Node.js 22). This is unacceptable for payment and checkout flows.

**Mitigation:** `minInstances: 1` on critical paths:
```
verifyIntasendPayment    minInstances: 1
checkoutSessions         minInstances: 1
sokoniSearch             minInstances: 1
createPayment            minInstances: 1
posUpdateCart            minInstances: 1
```

Non-critical CFs remain at `minInstances: 0` (scale-to-zero) to minimise cost.

**When to re-evaluate:** If any critical CF shows P95 cold start > 500ms in monitoring, add to minInstances list.

### 8.3 Firestore — 200 Composite Index Limit

**Problem:** Firebase enforces a hard limit of 200 composite indexes per Firestore database. SOKONI currently uses 197+.

**Mitigation:** Second Firestore database (`sokoni-ops`) for overflow. Analytical and BI queries (high cardinality, admin-only) are the first candidates to migrate.

**Index governance:** Indexes are never dropped (see `feedback_index_management.md`). Only add indexes. Track all indexes in `docs/FIRESTORE-INDEX-ARCHITECTURE.md`.

**When to re-evaluate:** When `sokoni-ops` also approaches 200 indexes, evaluate BigQuery for analytical workloads.

### 8.4 Firebase Hosting — Bandwidth Costs at Scale

**Problem:** Firebase Hosting Blaze plan charges per GB egress beyond the free tier (10GB/month). At 1M daily active users, bandwidth costs can become significant.

**Mitigation:**
- WebP images (30–50% smaller than JPEG)
- Service Worker caches repeat visits (zero bandwidth for cached assets)
- Cloudflare CDN caches at edge (reduces Firebase egress)
- Lazy loading of images
- Code splitting (defer loading of unused JS)
- `Cache-Control: immutable` on hashed assets (365-day client cache)

**When to re-evaluate:** Monitor monthly bandwidth in Firebase Console. If > 500GB/month, evaluate Cloudflare R2 for static asset hosting.

### 8.5 Single-Region Firestore

**Problem:** SOKONI Firestore is currently deployed in a single region (`us-central1`). A regional outage would cause platform unavailability. Latency from East Africa to US-central is approximately 200–250ms (still within acceptable range via Firebase SDK).

**Mitigation (current):** PITR enabled (7-day recovery window). Nightly exports to Cloud Storage.

**Mitigation (planned):** Enable Firestore multi-region (`nam5` or `eur3`) once transaction volume justifies cost. Estimated cost increase: 2–3× per-operation pricing.

**When to re-evaluate:** When platform reaches 100K DAU or processes > 10K daily transactions.

### 8.6 Redis — Single Instance, Single Region

**Problem:** Google Cloud Memorystore Redis is deployed as a single instance in `us-central1`. Instance failure would trigger platform-wide Redis fallback (degraded performance, no data loss).

**Mitigation (current):** Full Firestore fallback implemented in `sokoni-redis.js`. Every service has a defined fallback that preserves correctness.

**Mitigation (planned):** Redis high-availability replica (Memorystore Standard tier with replica) once operational cost is justified.

**VPC connector status:** Redis is accessible from Cloud Functions via VPC connector. VPC connector health monitored; failure would cause Redis unavailability (Firestore fallback activates).

**Blocker (INF-1):** VPC connector configuration still pending full production validation. Tracked in launch certification.

### 8.7 Search Index Synchronisation Lag

**Problem:** Typesense and Algolia indexes are updated via Firestore triggers. Under high write load, index sync can lag by 1–5 minutes.

**Mitigation:** 
- Search results include Firestore fallback for products not yet indexed
- Typesense index update: near-real-time via `onDocumentWritten` trigger
- Bulk import: rate-limited to 50 products/minute to prevent index backlog

**When to re-evaluate:** If search lag consistently exceeds 2 minutes, implement direct Typesense write from the product-creation CF rather than via trigger.

---

## 9. Module Catalog

Complete inventory of all production modules:

| Module | File(s) | Domain | Status |
|---|---|---|---|
| Order Engine | `orders.js` | Commerce | Live |
| Payment Orchestrator v2 | `payment-orchestrator.js` | Commerce | Live |
| Checkout Engine | `checkout.js` | Commerce | Live |
| Commission Engine | `commission.js` | Commerce | Live |
| Delivery Engine | `delivery.js` | Delivery | Live |
| Rider Navigation | `sokoni-navigation.js` | Delivery | Live |
| Dispatch Engine | `dispatch.js` | Delivery | Live |
| Inventory Engine | `inventory.js` | Marketplace | Live |
| Product Engine | `products.js` | Marketplace | Live |
| Seller Engine | `sellers.js` | Marketplace | Live |
| Reviews Engine | `reviews.js` | Marketplace | Live |
| Enterprise Search | `sokoni-search-pro.js` | Marketplace | Live |
| SmartPOS Engine | `pos.js` | POS | Live |
| POS Peripheral Hub | `sokoni-device-hub.js` | POS | Live |
| POS Payment Terminal | `sokoni-payment-terminal.js` | POS | Live |
| POS Customer Display | `sokoni-customer-display.js` | POS | Live |
| POS Peripherals CF | `pos-peripherals.js` | POS | Live |
| Manager Auth Engine | `pos-manager-auth.js` | POS | Live |
| Universal Printer v3 | `sokoni-universal-printer.js` | POS | Live |
| Financial OS v2 | `financial-os.js` | Financial | Live |
| FinOS Automation | `finos-automation.js` | Financial | Live |
| Wallet Engine | `wallet.js` | Financial | Live |
| eTIMS Integration | `etims.js` | Financial | Live |
| HR/Payroll Engine | `hr-payroll.js` | Financial | Live |
| Foundation Engine | `foundation.js` | Foundation | Live |
| Notification Engine | `notifications.js` | Platform | Live |
| Platform Event Bus | `platform-event-bus.js` | Platform | Live |
| Operations Center | `operations-center.js` | Platform | Live |
| Self-Healing Engine | `self-heal.js` | Platform | Live |
| Platform Hub | `platform-hub.js` | Platform | Live |
| Automation Center | `automation-center.js` | Platform | Live |
| Loyalty Engine v2 | `loyalty.js` | Loyalty | Live |
| Enterprise Loyalty | `loyalty-enterprise.js` | Loyalty | Live |
| Subscription Engine | `sub-engine.js` | Commerce | Live |
| KASS AI Concierge | `kass.js` | AI | Live |
| AI Engine | `ai-engine.js` | AI | Live |
| AI Creative Studio | `sokoni-creative.js` | AI | Live |
| AI Policy Engine | `sokoni-ai-policy.js` | AI | Live |
| Fraud Detection | `fraud.js` | Security | Live |
| Zero Trust SDK | `sokoni-zero-trust.js` | Security | Live |
| App Check SDK | `sokoni-appcheck.js` | Security | Live |
| Security Engine | `security.js` | Security | Live |
| Booking Engine | `booking.js` | Services | Live |
| Event Hub | `events.js` | Services | Live |
| Education Hub | `education.js` | Services | Live |
| B2B Wholesale | `b2b.js` | Services | Live |
| Food Hub | `food.js` | Services | Live |
| Healthcare Hub | `healthcare.js` | Services | Live |
| Legal Hub | `legal.js` | Services | Live |
| Property Hub | `property.js` | Services | Live |
| Vehicles Hub | `vehicles.js` | Services | Live |
| Jobs Hub | `jobs.js` | Services | Live |
| Entertainment Hub | `entertainment.js` | Services | Live |
| BI Analytics | `bi-advanced.js` | Analytics | Live |
| Analytics Engine | `analytics.js` | Analytics | Live |
| CRM Engine | `crm.js` | Analytics | Live |
| Admin Engine | `admin.js` | Admin | Live |
| Universal Auth | `firebase.js` | Auth | Live |
| Media Engine | `media-engine.js` | Media | Live |
| Workflow Automation | `sokoni-wap.js` | Platform | Live |
| GIP Geo Intelligence | `sokoni-gip.js` | Platform | Live |
| Redis Service Layer | `redis-service.js` | Infrastructure | Live |
| Redis Client SDK | `sokoni-redis.js` | Client | Live |
| Platform Bootstrap | `sokoni-platform.js` | Client | Live |
| Nav Engine | `sokoni-nav-engine.js` | Client | Live |
| Drawer System | `sokoni-drawer.js` | Client | Live |
| Payment Trust SDK | `sokoni-payment-trust.js` | Client | Live |
| Delivery Pricing SDK | `sokoni-delivery-pricing.js` | Client | Live |
| Notification SDK | `sokoni-notif-engine.js` | Client | Live |

**Total deployed Cloud Functions: ~600+** (multiple CFs per module file)

---

## 10. Architecture Decision Records

### ADR-001: Firestore as System of Record, Redis as Operational Layer

**Decision:** All permanent business records are written to Firestore first and exclusively. Redis holds only ephemeral operational state with defined TTLs.

**Rationale:** Redis has no durable backup, no PITR, no ACID transactions, and TTL-based expiry. Firestore provides all of these. The correctness vs speed distinction is absolute: losing Redis at any moment must cause a speed degradation, never a data loss event.

**Consequences:** Every Redis write is redundant with Firestore. All Redis operations have a Firestore fallback. Engineers must never add a Redis write that is the only copy of business data.

---

### ADR-002: Platform Event Bus for Inter-Service Communication

**Decision:** Services communicate via the platform event bus (Firestore `platformEvents` collection) rather than direct Cloud Function invocations.

**Rationale:** Direct calls create tight coupling. Notification failure should not abort order creation. New subscribers (e.g. a new analytics engine) should not require modifying the Order service. Events invert the dependency.

**Consequences:** Business flows span multiple async steps. Debugging requires tracing `correlationId` through event logs. Dead-letter queue must be monitored. Event schema versioning is required for backward compatibility.

---

### ADR-003: Gen2 Cloud Functions Over Cloud Run Services

**Decision:** All backend logic runs as Firebase Cloud Functions Gen2 (backed by Cloud Run), not standalone Cloud Run services or App Engine.

**Rationale:** Cloud Functions Gen2 provides: automatic scaling (including scale-to-zero), native Firebase SDK integration, built-in App Check enforcement, Cloud Logging integration, and IAM managed service accounts. The operational overhead of standalone Cloud Run services is not justified at current scale.

**Consequences:** Cold starts are a concern for critical paths (mitigated by `minInstances`). Function file size limits apply (100MB deployment package). All functions share the same Node.js runtime version.

---

### ADR-004: Universal Adapter Pattern for POS Hardware

**Decision:** All POS hardware (payment terminals, printers, scanners, cash drawers) is accessed through vendor-agnostic adapter interfaces. Core POS code never calls vendor APIs directly.

**Rationale:** Kenya's market has 12+ payment terminal vendors, 5+ printer protocols, and no hardware standard. Locking in to any vendor's API would make hardware migration expensive. The adapter layer means adding a new vendor requires one new driver file.

**Consequences:** Adapter interfaces must be stable. Breaking changes to `BaseTerminalDriver` or `SokoniDeviceHub` require updating all existing drivers. Driver authors must implement the full interface contract.

---

### ADR-005: Mobile-First PWA Over Native Apps

**Decision:** SOKONI is delivered as a Progressive Web App (HTML5 PWA) rather than native iOS/Android applications.

**Rationale:** Kenya's smartphone market is dominated by Android devices with varying capabilities. A PWA provides: universal device coverage, no app store distribution friction, instant updates without user action, and significantly lower development and maintenance cost (one codebase vs three). 85% of SOKONI traffic is mobile.

**Consequences:** Platform features are limited to what Web APIs support (no background processes, limited BT/USB without Web Bluetooth/USB). Native apps are planned for the driver and merchant verticals (Phase 5) where deeper OS integration is required.

---

### ADR-006: Second Firestore Database for Index Overflow

**Decision:** When the primary Firestore database approaches the 200 composite index limit, overflow indexes are created in a secondary database (`sokoni-ops`).

**Rationale:** Dropping existing indexes breaks deployed clients. Creating a second database avoids this while respecting Firebase's per-database limit. Analytical and admin queries are the first candidates because they are accessed only by internal tools (not consumer-facing clients), making the connection string change manageable.

**Consequences:** Application code targeting `sokoni-ops` must use a separate Firestore client instance. Deployment process must manage two databases. Security rules must be configured on both.

---

## Related Documents

- [[REDIS_ARCHITECTURE]] — Full Redis layer specification (v2.0)
- [[REDIS_SECURITY]] — Redis security controls and TTL governance
- [[FIRESTORE-INDEX-ARCHITECTURE]] — Index catalogue and governance rules
- [[SCALABILITY]] — Forward-looking scalability playbook and growth gates
- [[SCALABILITY_REVIEW]] — Point-in-time scalability review (2026-06-25)
- [[SECURITY]] — Full security documentation and certification
- [[SECURITY_CERTIFICATION]] — Security audit certification report
- [[OPS_RUNBOOK]] — Day-to-day operational procedures
- [[deployment/DISASTER_RECOVERY]] — Disaster recovery playbook
- [[API]] — Cloud Function API reference
- [[ROADMAP]] — Feature roadmap and planned capabilities
- [[CHANGELOG]] — Release history

---

*Last updated: 2026-07-08 | Architecture version: 4.0 | Cloud Functions: ~600+ | Firestore indexes: 197+*
