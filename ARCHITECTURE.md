# ARCHITECTURE.md

# SOKONI System Architecture

Version: 2.0 — Enterprise Edition
Date: 2026-06-20
Status: Living Document

---

# Purpose

This document defines the complete architecture of the SOKONI platform at enterprise scale.

Its objectives are to:

* Explain how the platform is organised.
* Define system boundaries and service responsibilities.
* Describe interactions between all services and modules.
* Document event flows, data flows, and payment flows.
* Establish architectural principles for future development.
* Guide onboarding, maintenance, and extension.

---

# Architectural Vision

SOKONI is a unified digital ecosystem connecting buyers, sellers, service providers, drivers, healthcare workers, educators, entertainers, and administrators through one resilient, scalable platform.

The architecture targets:

* 1,000,000+ concurrent users
* Sub-100ms median response time
* 99.9%+ uptime
* Zero data loss on payment operations
* Full observability across all services

---

# High-Level Architecture v2.0

```text
                         Internet
                             │
                     ┌───────▼────────┐
                     │  Cloudflare    │  CDN · DDoS · WAF
                     │  (Edge Layer)  │
                     └───────┬────────┘
                             │
                     ┌───────▼────────┐
                     │ Firebase Hosting│  PWA · Static Assets · SW
                     └───────┬────────┘
                             │
            ┌────────────────▼──────────────────┐
            │     Progressive Web Application    │
            │  ┌─────────────────────────────┐  │
            │  │     Client-Side Modules      │  │
            │  │  sokoni-event-bus.js         │  │
            │  │  sokoni-gateway.js           │  │
            │  │  sokoni-payment-engine.js    │  │
            │  │  sokoni-fraud-engine.js      │  │
            │  │  sokoni-service-mesh.js      │  │
            │  │  sokoni-observability.js     │  │
            │  │  sokoni-search-pro.js        │  │
            │  │  sokoni-webhook-engine.js    │  │
            │  │  sokoni-security.js          │  │
            │  │  sokoni-scale.js             │  │
            │  │  sokoni-queue.js             │  │
            │  │  sokoni-db.js                │  │
            │  │  sokoni-pay.js               │  │
            │  └─────────────────────────────┘  │
            └────────────────┬──────────────────┘
                             │  Firebase SDK
                    ┌────────▼──────────┐
                    │  Firebase Auth    │  JWT · Custom Claims
                    └────────┬──────────┘
                             │
          ┌──────────────────▼─────────────────────┐
          │           Cloud Functions v2             │
          │                                         │
          │  Webhook Platform                       │
          │    webhookIntasend  webhookMpesa         │
          │    webhookStripe    webhookSmartpos      │
          │    replayWebhookDLQ webhookHealth        │
          │                                         │
          │  Payment Engine                         │
          │    releaseEscrow    initiateRefund       │
          │    getSettlementReport                  │
          │    initiateSellerPayout                 │
          │    getLedgerBalance                     │
          │                                         │
          │  Fraud & Security                       │
          │    evaluateFraudRisk  fraudBlock        │
          │    getSecurityEvents                    │
          │                                         │
          │  Event Processor                        │
          │    onEventLogged (Firestore trigger)    │
          │                                         │
          │  Search Indexer                         │
          │    indexProductCreate indexProductUpdate│
          │    indexProviderCreate                  │
          │                                         │
          │  Observability                          │
          │    platformHealth  getPlatformMetrics   │
          │                                         │
          │  Scheduled Jobs                         │
          │    expireOldEscrows (24h)               │
          │    cleanupIdempotencyStore (24h)        │
          │    aggregateTrendingSearches (60min)    │
          │    processSettlementQueue (60min)       │
          │                                         │
          │  AI Agent                               │
          │    KASS  sokoniChat                     │
          │                                         │
          │  Existing Functions (preserved)         │
          │    darajaSTKPush  verifyIntasendPayment │
          │    sendSms  sendFcm  sendTestSTKPush    │
          │    onOrderStatusChange onOrderConfirmed │
          │    getCommissionLedger markCommissionPaid│
          │    updateSellerSubscription             │
          └──────────┬──────────────────────────────┘
                     │
          ┌──────────▼─────────────────────────────┐
          │         Cloud Firestore                  │
          │                                         │
          │  Core Collections                       │
          │    users  products  orders  providers   │
          │    applications  rides  messages        │
          │                                         │
          │  Payment Collections                    │
          │    paymentLedger  escrows  settlements  │
          │    refunds  webhookPayments             │
          │                                         │
          │  Webhook Collections                    │
          │    webhookLogs  webhookIdempotency      │
          │    webhookDLQ  webhookRetryQueue        │
          │                                         │
          │  Security Collections                   │
          │    auditLogs  fraudLog  fraudBlocklist  │
          │    securityEvents                       │
          │                                         │
          │  Search Collections                     │
          │    searchAnalytics  searchClicks        │
          │    searchTrending                       │
          │                                         │
          │  Platform Collections                   │
          │    eventLog  metrics  featureFlags      │
          │    posTransactions  settlementQueue     │
          │    sellerSubscriptions  shopEmployees   │
          └─────────────────────────────────────────┘
```

---

# Client-Side Module Architecture

## Module Dependency Graph

```text
sokoni-event-bus.js          ← Foundation (no dependencies)
       │
       ├── sokoni-webhook-engine.js
       ├── sokoni-payment-engine.js
       ├── sokoni-fraud-engine.js
       ├── sokoni-observability.js
       ├── sokoni-service-mesh.js
       │       │
       │       └── All other modules register here
       │
       ├── sokoni-search-pro.js
       ├── sokoni-gateway.js
       │
       └── sokoni-scale.js        ← Circuit breaker primitives
              │
              └── sokoni-queue.js ← IndexedDB write queue
```

All modules follow the IIFE pattern and expose a single `window.Sokoni*` global.

---

# Enterprise Module Reference

## sokoni-event-bus.js

Internal pub/sub message bus.

**Key features:**
- 60+ typed events across all domains (Order, Payment, Escrow, Fraud, Delivery, etc.)
- Persistent events written to Firestore `eventLog` collection
- BroadcastChannel for cross-tab relay
- In-memory ring buffer (200 events)
- Dead-letter queue (DLQ) for failed handlers (500 entries max)
- Replay by correlationId

**Key API:** `Bus.on()`, `Bus.emit()`, `Bus.once()`, `Bus.replay()`, `Bus.diagnostics()`

---

## sokoni-webhook-engine.js

Client-side webhook coordination layer.

**Key features:**
- 18 provider configurations (IntaSend, M-Pesa, Stripe, SmartPOS, etc.)
- HMAC-SHA256 signature verification via SubtleCrypto
- Timing-safe comparison
- Sliding-window rate limiting per provider
- Idempotency store (24h TTL)
- Nonce tracking (15-min window)
- Exponential back-off retry (5s × 2^attempt, max 300s)
- Dead-letter queue (1000 entries)

---

## sokoni-payment-engine.js

Client-side double-entry ledger and payment orchestration.

**Key features:**
- Currencies: KES, USD, EUR, GBP
- Payment statuses: pending → processing → completed → escrowed → released
- Escrow lifecycle with 30-day auto-expiry
- Kenyan tax: VAT 16%, WHT 5% (above KES 24,000), DST 1.5%
- Platform fee: 10%
- Split payments with rounding correction
- Settlement period calculations
- Refund initiation (delegates to server)

**Collections written:** `paymentLedger`, `escrows`, `settlements`, `refunds`

---

## sokoni-fraud-engine.js

Real-time client-side fraud detection.

**Key features:**
- Composite risk score 0-100 → ALLOW / REVIEW / BLOCK
- Velocity checks: payment (3/5min, 10/hr), login (5/5min), order (20/hr)
- Device fingerprinting (userAgent + screen + timezone + hardware)
- Multi-account device detection
- Blocklist: phones, emails, UIDs, IPs (loaded from `fraudBlocklist` Firestore collection)
- Amount spike detection (>5× rolling average)
- Unusual-hour detection (2–5 AM EAT)
- Auto-wired to EventBus for PAYMENT_INITIATED events

---

## sokoni-service-mesh.js

Service registry, health monitoring, and feature flags.

**Key features:**
- 25 registered service IDs
- Dependency graph with boot sequencer
- Per-service circuit breakers (CLOSED / OPEN / HALF_OPEN)
- Health checks every 60 seconds
- Firestore-backed feature flags with runtime override
- Service discovery by capability

**Pre-registered services:** AUTH (critical), DATABASE (critical), PAYMENTS, FRAUD, WEBHOOKS, NOTIFICATIONS, SEARCH, ANALYTICS, SMARTPOS, MAPS, AI

---

## sokoni-observability.js (APM)

Application Performance Monitoring layer.

**Key features:**
- Counters, gauges, histograms (1000 value ring buffer)
- Distributed tracing with span/correlationId
- Web Vitals: LCP, FID, CLS, TTFB, DOM load, DNS, TCP
- Memory pressure monitoring (every 30s)
- Global error and unhandledrejection handlers
- Firestore batch flush every 30s → `metrics` collection
- Auto-instrumented for EventBus events (orders, payments, fraud, webhooks)
- Histogram percentiles: p50, p95, p99

---

## sokoni-search-pro.js

Hybrid search engine with multi-provider fallback.

**Key features:**
- Primary: Algolia (typo-tolerance, facets, geo-search)
- Secondary: Typesense (fast open-source)
- Fallback: Firestore (`searchableTerms` array-contains)
- Federated search across all indices simultaneously
- Result cache (60s TTL, max 1000 entries)
- Debounce (300ms)
- Trending terms from `searchTrending` collection
- Click analytics to `searchClicks` collection
- Indices: products, sellers, services, events, properties, jobs, food, vehicles, providers

---

## sokoni-gateway.js

Client-side API gateway.

**Key features:**
- Origin allowlist (8 permitted origins)
- Token-bucket rate limiting per operation profile
- Idempotency store (24h TTL)
- Input sanitisation (XSS, SQL injection prevention, 7 pattern rules)
- JSON schema validation (payment, order, review schemas)
- Response cache for GET requests
- Automatic retry with exponential back-off (max 3)
- Auto-attaches Firebase ID token
- Force token refresh on retry

---

# Cloud Functions Architecture

## Webhook Platform

```text
External Provider (IntaSend / M-Pesa / Stripe / SmartPOS)
    │
    ▼  POST /webhookIntasend | /webhookMpesa | /webhookStripe | /webhookSmartpos
    │
    ├── ACK 200 immediately (prevent provider retry)
    │
    ├── Signature verification (HMAC-SHA256 / timing-safe)
    │
    ├── Timestamp replay check (5-minute window)
    │
    ├── Idempotency check → webhookIdempotency collection
    │
    ├── Mark as "processing"
    │
    ├── Parse payload
    │
    ├── Handle (write to webhookPayments)
    │
    ├── Mark as "processed" + write to webhookLogs
    │
    └── On error → write to webhookDLQ
                      │
                      └── Admin: replayWebhookDLQ()
```

---

## Payment Flow (Full Lifecycle)

```text
Buyer initiates payment
    │
    ▼
Client: sokoni-gateway.js validates + rate-limits
    │
    ▼
Cloud Function: darajaSTKPush OR IntaSend STK Push
    │
    ▼
M-Pesa / IntaSend processes payment
    │
    ▼
Webhook arrives → webhookMpesa / webhookIntasend
    │
    ├── Signature verified
    ├── Deduplicated
    └── Saved to webhookPayments
    │
    ▼
Cloud Function: releaseEscrow (on delivery confirmation)
    │
    ├── Commission deducted (10%)
    ├── WHT deducted if applicable (5% above KES 24,000)
    ├── Three ledger entries written to paymentLedger
    ├── Escrow status → "released"
    ├── FCM notification to seller
    └── Emits Escrow.Released event → settlementQueue
    │
    ▼
Scheduled: processSettlementQueue (every 60 min)
    │
    └── IntaSend B2C payout to seller
```

---

## Fraud Detection Flow

```text
Payment initiated
    │
    ▼
Client: SokoniFraudEngine.evaluate() [real-time, client-side]
    │
    ├── Blocklist check (phone, email, uid, ip)
    ├── Velocity check (3 payments/5min, 10/hr)
    ├── Amount spike (>5× rolling average)
    ├── Unusual hour (2–5AM EAT)
    └── Multi-account device
    │
    ▼
Score 0-100 → ALLOW / REVIEW / BLOCK
    │
    ├── ALLOW → proceed
    ├── REVIEW → flag, proceed with manual review
    └── BLOCK → reject, log to fraudLog, notify security
    │
Server-side: evaluateFraudRisk() (onCall)
    │
    ├── Velocity check against Firestore auditLogs
    ├── Blocklist check against fraudBlocklist
    └── Returns { decision, score, signals }
```

---

## Search Indexing Flow

```text
Document created/updated in products / providers
    │
    ▼
Firestore trigger: indexProductCreate / indexProductUpdate / indexProviderCreate
    │
    ├── Extract text from name, title, category, description, tags, brand, location
    ├── Tokenise words
    ├── Generate prefix tokens (2–6 chars) for autocomplete
    └── Write searchableTerms[] + nameLower back to document
    │
    ▼
Client search: SokoniSearchPro.search()
    │
    ├── 1. Try Algolia (typo-tolerance + facets + geo)
    ├── 2. Try Typesense (fast fallback)
    └── 3. Firestore array-contains on searchableTerms (offline fallback)
```

---

# Data Architecture

## Firestore Collection Inventory

| Collection | Purpose | Access |
|---|---|---|
| users | User profiles | Self + admin |
| products | Marketplace listings | Public read, seller write |
| orders | Purchase records | Buyer + seller + admin |
| providers | Service provider profiles | Public read, provider write |
| applications | Service bookings | Buyer + provider + admin |
| rides | Ride requests | Buyer + driver + admin |
| messages | Inbox messages | Participants only |
| paymentLedger | Double-entry accounting | Admin only |
| escrows | Escrow holds | Buyer + seller + admin |
| settlements | Seller payouts | Seller + admin |
| refunds | Refund records | Buyer + admin |
| webhookPayments | Confirmed payments from providers | Admin only |
| webhookLogs | Webhook processing log | Admin only |
| webhookIdempotency | Dedup store (7-day TTL) | Functions only |
| webhookDLQ | Failed webhooks | Admin only |
| webhookRetryQueue | Retry queue | Functions only |
| eventLog | Domain event log (persistent) | Functions only |
| auditLogs | Admin action audit trail | Admin only |
| fraudLog | Fraud decisions | Admin only |
| fraudBlocklist | Blocked entities | Admin only |
| securityEvents | Security alerts | Admin only |
| searchAnalytics | Search query analytics | Functions only |
| searchClicks | Click-through analytics | Functions only |
| searchTrending | Trending terms (hourly agg) | Public read |
| metrics | APM metrics | Functions only |
| featureFlags | Runtime feature toggles | Admin write |
| posTransactions | SmartPOS transactions | Admin + seller |
| settlementQueue | Pending payouts | Functions only |
| sellerSubscriptions | Plan + expiry | Seller + admin |
| shopEmployees | Employee sessions | Seller + admin |

---

## Ledger Account Naming Convention

```text
buyer:{uid}              — buyer wallet
seller:{uid}             — seller receivable
seller:{uid}:bank        — seller bank account (payout target)
escrow:holding           — funds in escrow
platform:revenue         — platform commission earned
platform:tax_liability   — VAT + WHT collected for KRA
platform:payable:{uid}   — payable to seller (pre-payout)
```

---

# Security Architecture

## Defense Layers

```text
Layer 1: Edge (Cloudflare)
  - DDoS protection
  - WAF rules
  - Bot filtering
  - SSL/TLS termination

Layer 2: Authentication (Firebase Auth)
  - JWT tokens (1-hour expiry)
  - Custom claims for roles (admin, superAdmin, moderator)
  - MFA ready

Layer 3: Gateway (sokoni-gateway.js)
  - Origin allowlist
  - Token-bucket rate limiting
  - Input sanitisation (XSS, injection)
  - Schema validation

Layer 4: Cloud Functions
  - Auth context verification on every onCall
  - Admin claim check for privileged operations
  - HMAC-SHA256 webhook signature verification
  - Timing-safe comparison

Layer 5: Firestore Security Rules
  - Role-based collection access
  - Field-level validation
  - Admin-only collections blocked client-side

Layer 6: Fraud Detection
  - Real-time velocity checks
  - Device fingerprinting
  - Blocklist enforcement
  - Risk scoring

Layer 7: Audit
  - All admin actions logged to auditLogs
  - Payment operations logged to paymentLedger
  - Security events logged to securityEvents
```

---

# Performance Strategy

| Area | Strategy |
|---|---|
| Page load | PWA + Service Worker caching (v157+) |
| Search | Client-side 60s cache + Algolia edge nodes |
| Firestore reads | Paginated queries, composite indexes |
| Firestore writes | Batch writes (max 500/batch), write-through queue |
| Images | Firebase Storage + CDN + lazy loading |
| Code | IIFE modules, no bundler needed, loaded on demand |
| Offline | IndexedDB-backed write queue (sokoni-queue.js) |
| Background | Cloud Functions for heavy computation |
| Metrics | APM flush batched (30s intervals) |

---

# Reliability Strategy

| Scenario | Mitigation |
|---|---|
| Network failure | IndexedDB queue + exponential back-off retry |
| Payment provider down | Circuit breaker + fallback provider |
| Firestore unavailable | Client cache + retry queue |
| Webhook delivery failure | DLQ + admin replay |
| Function timeout | Idempotency store prevents double-processing |
| Concurrent duplicate payment | Idempotency key check in both client and server |
| Old escrows | Daily scheduled expiry job |
| Bad actors | Fraud engine blocklist + account suspension |

---

# Observability Architecture

```text
Client Events → SokoniObservability
    │
    ├── Counters (orders, payments, errors, searches)
    ├── Gauges (memory, web vitals)
    ├── Histograms (latency distributions)
    └── Spans (distributed traces)
    │
    ▼
Firestore: metrics collection (batch flush every 30s)
    │
    ▼
Admin: getPlatformMetrics() Cloud Function
    │
    ├── Orders: total, GMV, by status
    ├── Payments: total confirmed
    ├── New users
    ├── Webhooks: by provider
    └── Fraud: flagged + blocked counts
    │
    ▼
monitor.html dashboard (existing)
```

---

# Integration Architecture

## Payment Providers

| Provider | Integration | Method |
|---|---|---|
| M-Pesa (Daraja) | Cloud Function | STK Push → Callback |
| IntaSend | Cloud Function + Webhook | STK Push + Webhook |
| Stripe | Webhook (webhookStripe) | Payment Intent |
| PayPal | Planned | REST API |

## Communication

| Channel | Integration |
|---|---|
| SMS | Africa's Talking via sendSms Cloud Function |
| Push | Firebase Cloud Messaging via sendFcm |
| Email | sendInvoiceEmail Cloud Function (SendGrid / SMTP) |
| In-app | Firestore real-time listener |

## Search

| Engine | Role |
|---|---|
| Algolia | Primary (typo-tolerance, facets, geo) |
| Typesense | Secondary fallback |
| Firestore | Offline/emergency fallback |

---

# Deployment Architecture

```text
Source: c:\Users\USER1\OneDrive\Desktop\SOKONI\
    │
    ├── Hosting: firebase deploy --only hosting
    │     └── All .html + .js + .css + assets
    │
    ├── Functions: firebase deploy --only functions
    │     └── functions/index.js (4500+ lines, 40+ exports)
    │
    ├── Firestore Rules: firebase deploy --only firestore:rules
    │
    └── Storage Rules: firebase deploy --only storage
```

**Project:** sokoni-aeb26
**Region:** us-central1
**Hosting:** mysokoni.co.ke

---

# Event Catalogue

## Domain Events (60+)

| Domain | Events |
|---|---|
| Order | Order.Created, Order.Confirmed, Order.Completed, Order.Cancelled, Order.Disputed |
| Payment | Payment.Initiated, Payment.Completed, Payment.Failed, Payment.Refunded, Payment.Disputed |
| Escrow | Escrow.Created, Escrow.Released, Escrow.Refunded, Escrow.Disputed, Escrow.Expired |
| Wallet | Wallet.Credited, Wallet.Debited, Wallet.Withdrawn |
| Commission | Commission.Calculated, Commission.Settled |
| Settlement | Settlement.Initiated, Settlement.Completed, Settlement.Failed |
| Delivery | Delivery.Assigned, Delivery.PickedUp, Delivery.Completed, Delivery.Failed |
| Ride | Ride.Requested, Ride.Accepted, Ride.Started, Ride.Completed |
| Ticket | Ticket.Purchased, Ticket.Validated, Ticket.Refunded |
| SmartPOS | SmartPOS.TransactionCompleted, SmartPOS.InventoryUpdated |
| User | User.Registered, User.Verified, User.Suspended |
| Business | Business.Approved, Business.Suspended |
| Fraud | Fraud.Flagged, Fraud.Blocked |
| Subscription | Subscription.Activated, Subscription.Expired, Subscription.Upgraded |
| System | System.CircuitOpen, System.HealthAlert, System.ServiceBooted |

---

# Related Documents

* [[CHANGELOG]] — Full upgrade history
* [[docs/WEBHOOK]] — Webhook integration guide
* [[docs/API]] — Cloud Functions API reference
* [[docs/DATABASE]] — Firestore schema documentation
* [[docs/SECURITY]] — Security implementation details
* [[docs/DEPLOYMENT]] — Deployment runbook
* [[README]] — Platform overview and getting started
* [[ROADMAP]] — Planned features and milestones

---

# Architecture Principle

Every architectural decision in SOKONI must improve at least one of:

* Security — protect users and their money
* Performance — serve Kenya's growing digital population
* Scalability — grow from thousands to millions without redesign
* Reliability — payments and orders must never be lost
* Maintainability — every engineer should understand every module

If a proposed solution weakens these principles without strong justification, it must be reconsidered before implementation.
