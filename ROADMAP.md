# ROADMAP.md

# SOKONI Platform Roadmap

**Version:** 5.1.0  
**Updated:** 2026-06-25  
**Status:** Phase 0 — Merchant Acquisition & Market Activation

**Current focus:** Build the supply side before driving buyer traffic. No new features. Every week is measured by sellers onboarded, listings added, and quality scores — not by code committed.

**v2.0 policy:** No new feature without a completed `docs/FEATURE_PROPOSAL_TEMPLATE.md`.  
**v2.1 candidates:** See `docs/V2_ROADMAP.md` for ranked evidence-gated initiatives.

---

## Phase 0 — Market Activation (In Progress)

| Milestone | Target | Status |
|-----------|--------|--------|
| Anchor seller program launched | 25–50 sellers | 🔵 Active |
| Category coverage: 6+ categories ready | ≥50 listings each | 🔴 0/11 |
| Soft launch readiness (16 criteria) | All ✅ | 🔴 0/16 |
| Stage 2 community launch | 500+ listings | 🔴 Pending |
| Stage 3 paid marketing begins | All criteria met | 🔴 Pending |

### Activation Documents
- `docs/ANCHOR_SELLER_PROGRAM.md` — [[Anchor Seller Program]]
- `docs/CATEGORY_LAUNCH_TARGETS.md` — [[Category Launch Targets]]
- `docs/MERCHANT_ONBOARDING_CHECKLIST.md` — [[Merchant Onboarding Checklist]]
- `docs/MARKETPLACE_QUALITY_STANDARDS.md` — [[Marketplace Quality Standards]]
- `docs/SOFT_LAUNCH_CRITERIA.md` — [[Soft Launch Criteria]]
- `docs/WEEKLY_ACTIVATION_REPORT_TEMPLATE.md` — [[Weekly Activation Report Template]]

---

## RC1 Stabilization — ARCHIVED COMPLETE (2026-07-18)

| Track | Status |
|-------|--------|
| Engineering Stabilization | ✅ COMPLETE |
| Performance Stabilization | ✅ COMPLETE |
| Production Readiness | 🟡 **CONDITIONAL GO** |

Change freeze remains in force. **No further performance optimization before the pilot** unless a
verified production defect appears.

Accepted conclusions: SmartPOS operationally healthy and representative in warm usage · measurement
harness trustworthy · Firebase configuration resolved · CSP report storm resolved · Home bottleneck
identified and root-caused · **no RC1 optimization justified**.

- `docs/PERFORMANCE_SPRINT_CLOSURE.md` — [[Performance Sprint Closure]]
- `docs/MEASUREMENT_VALIDITY_CORRECTION.md` — [[Measurement Validity Correction]]
- `docs/HOME_PERFORMANCE_INVESTIGATION.md` — [[Home Performance Investigation]]
- `scripts/perf-baseline.js` — URL-asserting cold+warm baseline harness

---

## Phase 1 — Post-Pilot Optimization Roadmap (Not RC1)

Remaining performance work belongs here, not to RC1 release stabilization.

| Initiative | Scope | Status |
|-----------|-------|--------|
| **Home Rendering Optimization** | Structural rendering efficiency — style recalc, layout, DOM size | 🔵 OPEN, gated |
| P1-HOME-TBT | Home warm TBT 755 ms; `promote()` −271 ms verified | 🔴 Deferred |
| P1-CHARSET | `<meta charset>` placement, 231 files — standards hygiene, **zero expected perf gain** | 🔴 Deferred |
| T-1 / T-2 | Financial transaction behaviour (deferred 2026-07-17) | 🔴 Deferred |

> **Mandatory gate.** The Home Rendering initiative may not implement any optimization until the
> complete investigation is repeated on mid-range Android with CPU throttling, network simulation,
> real touch interaction and a warm merchant session. Desktop findings are accepted as engineering
> evidence but **must not be used alone to prioritize post-pilot work** — the ranking may reorder
> under a mobile CPU.

- `docs/INITIATIVE_HOME_RENDERING.md` — [[Initiative Home Rendering]]
- `docs/PHASE1_POST_PILOT_BACKLOG.md` — [[Phase 1 Post Pilot Backlog]]

---

## v2.0 Completed (2026-06-25)

| Initiative | Status |
|------------|--------|
| Platform health scoring engine (5 dimensions) | ✅ Done |
| Unified admin health dashboard (platform-health.html) | ✅ Done |
| Feature Proposal governance gate | ✅ Done |
| Performance budget document | ✅ Done |
| Cost governance document | ✅ Done |
| Scaling triggers (12 thresholds) | ✅ Done |
| v2.0 evidence-gated roadmap | ✅ Done |

Related: [[CHANGELOG]] [[docs/ARCHITECTURE]] [[docs/SECURITY]]

---

## Completed Features

### Core Platform

| Feature | Version | Status |
|---|---|---|
| Firebase Authentication (email, Google, phone) | v1.0 | ✅ Done |
| Multi-vendor marketplace — seller & buyer flows | v1.0 | ✅ Done |
| Product listings, categories, search | v1.0 | ✅ Done |
| Product variants — capture (upload + edit forms) | v1.2 | ✅ Done |
| Product variants — display, search, indexing, filters | v1.2 | ✅ Done |
| Shopping cart & checkout | v1.0 | ✅ Done |
| Order management | v1.0 | ✅ Done |
| Reviews & ratings | v1.0 | ✅ Done |
| Seller dashboard | v1.0 | ✅ Done |
| Buyer profile | v1.0 | ✅ Done |
| Admin portal (admin.html) | v1.0 | ✅ Done |
| Employee system (cross-device, role restrictions) | v1.2 | ✅ Done |
| Hub registration (103 categories, 25 pages) | v1.3 | ✅ Done |

### Hubs

| Hub | Status |
|---|---|
| Marketplace (shopping) | ✅ Done |
| Food & Delivery Hub | ✅ Done |
| Car Hub (rental, NTSA, DL, GPS, insurance, garages) | ✅ Done |
| Events Hub | ✅ Done |
| Property Marketplace (buy/rent, BnB) | ✅ Done |
| Healthcare Hub | ✅ Done |
| Legal Services Hub | ✅ Done |
| B2B / Business Hub | ✅ Done |
| Tech / Digital Products | ✅ Done |
| Entertainment Hub | ✅ Done |

### Payments & Finance

| Feature | Version | Status |
|---|---|---|
| M-Pesa STK Push (Daraja) | v1.0 | ✅ Done |
| IntaSend checkout integration | v1.1 | ✅ Done |
| IntaSend B2C seller payouts | v2.0 | ✅ Done |
| Double-entry payment ledger | v2.0 | ✅ Done |
| Escrow engine | v2.0 | ✅ Done |
| Refund engine | v2.0 | ✅ Done |
| Commission engine (6 models) | v1.2 | ✅ Done |
| Settlement queue & reporting | v2.0 | ✅ Done |
| VAT + WHT + DST tax compliance | v2.0 | ✅ Done |
| Invoice generation (SokoniInvoice) | v2.3 | ✅ Done |
| Subscription management | v1.3 | ✅ Done |

### Platform Infrastructure

| Feature | Version | Status |
|---|---|---|
| Firebase Cloud Functions v2 (Gen 2) | v2.0 | ✅ Done |
| Enterprise event bus (sokoni-event-bus.js) | v2.0 | ✅ Done |
| Webhook platform (IntaSend, M-Pesa, Stripe, SmartPOS) | v2.0 | ✅ Done |
| Webhook DLQ + replay | v2.0 | ✅ Done |
| API gateway (rate limiting, sanitisation, validation) | v2.0 | ✅ Done |
| Fraud detection engine | v2.0 | ✅ Done |
| APM observability (sokoni-observability.js) | v2.0 | ✅ Done |
| Service mesh + circuit breakers | v2.0 | ✅ Done |
| Hyper-scale queue (sokoni-scale/queue/cache.js) | v2.0 | ✅ Done |
| Real-time monitoring dashboard (monitor.html) | v1.4 | ✅ Done |
| Google Cloud Monitoring alert policies | v2.2 | ✅ Done |
| RBAC — 8-role system (sokoni-permissions.js) | v1.4 | ✅ Done |
| Firestore security rules (full coverage) | v1.4 | ✅ Done |
| CI/CD pipeline (GitHub Actions) | v2.2 | ✅ Done |
| SASOS — Universal AI Subscription OS (50 CFs, 22 collections, 46 plans × 13 products) | v2.8 | ✅ Done |
| Platform Registry + Event Bus (14 CFs, 6 collections, 35 event domains) | v2.8 | ✅ Done |
| Universal Platform Bootstrap (sokoni-platform.js) | v2.8 | ✅ Done |
| Platform Operations Center (platform.html — 8-tab admin) | v2.8 | ✅ Done |
| Shared CF constants + error handling (functions/shared/) | v2.9 | ✅ Done |
| Expanded test suite — 169 passing tests (5 test files) | v2.9 | ✅ Done |
| Auth & RBAC hardening — claim-preserving merge, getUserClaims CF, idle session timeout | v3.0 | ✅ Done |
| Expanded test suite — 480 passing tests (10 test files) | v3.1 | ✅ Done |
| Production Certification — 40-phase directive complete, all phases signed off | v3.1 | ✅ Done |
| CF security hardening — zero inline auth guards, all plain Error → HttpsError | v3.1 | ✅ Done |
| KRA financial compliance tests — VAT 16%, WHT 5%, DST 1.5% verified | v3.1 | ✅ Done |
| Resilience test suite — SASOS fraud, risk decay, inventory fraud rules (80 tests) | v3.1 | ✅ Done |
| Certification test suite — regulatory + invariant + security contracts (79 tests) | v3.1 | ✅ Done |

### Search & Discovery

| Feature | Version | Status |
|---|---|---|
| Universal Search — 13 Firestore collections | v2.4 | ✅ Done |
| SokoniSearchPro (Algolia/Typesense hybrid) | v2.4 | ✅ Done |
| Search autocomplete + keyboard nav | v2.2 | ✅ Done |
| Trending / recommendations engine | v2.0 | ✅ Done |

### Communications

| Feature | Version | Status |
|---|---|---|
| Universal Inbox — real-time messaging | v2.6 | ✅ Done |
| Notifications system (FCM + Firestore) | v1.4 | ✅ Done |
| Verification badges (8 types) | v2.2 | ✅ Done |
| SMS via Africa's Talking | v2.0 | ✅ Done |
| Enterprise email system (53 templates) | v2.7 | ✅ Done |
| 26 auto-triggered email Cloud Functions | v2.7 | ✅ Done |
| Email Center admin dashboard | v2.7 | ✅ Done |
| Delivery email suite (delivery@, dispatch@, drivers@, tracking@) | v2.7 | ✅ Done |

### Logistics

| Feature | Version | Status |
|---|---|---|
| Ride system (ride.html + driver.html) | v1.3 | ✅ Done |
| OSRM-based fare calculation (sokoni-routing.js) | v1.3 | ✅ Done |
| Delivery tracking (real-time GPS) | v1.3 | ✅ Done |
| Commerce-to-delivery pipeline | v1.3 | ✅ Done |

### SmartPOS

| Feature | Version | Status |
|---|---|---|
| POS core (pos.js, pos-db.js, pos-boss.js) | v1.0 | ✅ Done |
| POS mobile layout (pos-mobile.js/.css) | v2.1 | ✅ Done |
| POS hardware API (Bluetooth/USB printer, cash drawer) | v2.1 | ✅ Done |
| P58E printer driver — BLE + Web Serial COM port (Windows SPP) | v5.0 | ✅ Done |
| pos-printer-setup.html — transport selector, device cache, demo receipt | v5.0 | ✅ Done |
| POS terminals + sync queue | v1.2 | ✅ Done |
| BOS v2 — Finance, Audit, Repair tabs | v1.5 | ✅ Done |

### AI

| Feature | Version | Status |
|---|---|---|
| KASS — Admin AI assistant (Claude claude-sonnet-4-6, 16 tools) | v2.0 | ✅ Done |
| sokoniChat — Customer AI assistant | v2.0 | ✅ Done |
| AI Creative Studio (media generation, brand kits, analytics) | v2.8 | ✅ Done |
| AI Subscriptions (4 plans, credits, boosts, storage) | v2.8 | ✅ Done |
| AI Policy Engine (confidence badges, fuel guard) | v2.8 | ✅ Done |

### Enterprise Intelligence

| Feature | Version | Status |
|---|---|---|
| Enterprise Intelligence Platform — EIP (decision engine, data quality, feature flags) | v2.8 | ✅ Done |
| Workflow Automation Platform — WAP (7 workflows, 20 handlers) | v2.8 | ✅ Done |
| GIP — Geo Intelligence Platform (analytics, fleet, routing command center) | v2.8 | ✅ Done |

### Inventory V2

| Feature | Version | Status |
|---|---|---|
| Inventory V2 engine (sokoni-inventory-v2.js) — offline-first, multi-warehouse | v2.8 | ✅ Done |
| Inventory shell UI (inv-dashboard, inv-products, inv-product) | v2.8 | ✅ Done |
| Firestore security rules + 35 composite indexes for all V2 collections | v2.8 | ✅ Done |
| Analytics V2 — 6 KPIs + 5 sub-tabs (Movements, Aging, Margin, Branch, Forecast) | v2.8 | ✅ Done |
| GRN / partial delivery workflow | v2.8 | ✅ Done |
| Stock Count full workflow (session → count sheet → variance → approve/reject) | v2.8 | ✅ Done |
| Sustainability dashboard (waste rate, carbon, spoilage, recommendations) | v2.8 | ✅ Done |
| Business Simulation tab (demand/price factor model) | v2.8 | ✅ Done |
| Supplier detail modal (tabs: overview, orders, price list, contracts) | v2.8 | ✅ Done |
| Purchase Requisitions (create → approve → convert to PO) | v2.8 | ✅ Done |
| AI Shelf Counting (camera → inventoryAiQuery CF → variance table → apply/export) | v2.8 | ✅ Done |
| Bulk Operations (export, labels, transfer, price adjust, duplicate, archive, create PO) | v2.8 | ✅ Done |
| Advanced Search (stock range, date range, tags, search-field selector) | v2.8 | ✅ Done |

---

## Pending Configuration (Ops Tasks)

These are NOT code gaps — the platform code is complete. Real credentials are needed.

| Item | Action Required |
|---|---|
| SendGrid API key | Sign up at sendgrid.com, verify `mysokoni.co.ke`, run `firebase functions:secrets:set SENDGRID_API_KEY` |
| SMTP fallback credentials | Run `firebase functions:secrets:set MAIL_HOST`, `MAIL_USER`, `MAIL_PASS` with real SMTP provider |
| IntaSend private key (production) | Obtain from IntaSend dashboard — replace `YOUR_INTASEND_PRIVATE_KEY` guard in `functions/index.js:3071` |
| Google Cloud Monitoring channel | Run `gcloud alpha monitoring channels create` then set ID in `monitoring/alerts.json` |
| VAPID key for web push | Generate at Firebase Console → Cloud Messaging → Web Push certificates, update `firebase.js` |
| SendGrid webhook URL | Register `https://us-central1-sokoni-aeb26.cloudfunctions.net/emailWebhook` in SendGrid Event Webhook settings |

---

## v1.1 Roadmap — Recommended Initiatives

All v1.0 infrastructure is live. v1.1 focuses on revenue expansion and retention — no new hubs without user-demand evidence.

### Priority Ranking Methodology

Each initiative ranked on 5 axes (1–5 each, 25 max):
- **User Impact** — how many users benefit and how directly
- **Revenue Potential** — GMV uplift, new revenue streams, or reduced churn
- **Dev Complexity** — estimated effort (5 = trivially simple, 1 = very hard)
- **Operational Cost** — recurring infra/support burden (5 = very low cost, 1 = high)
- **Dependency Risk** — depends on unbuilt components (5 = no deps, 1 = many deps)

---

### Enterprise Authentication 2.0 — Premium Session Experience (v1.1)

**Scope:** Full premium identity and session experience — silent auth on launch, multi-profile switching, Account Centre, active device management, graceful logout, 30-day deletion grace period, offline access, data export.

**User Experience Target:** TikTok / Instagram / Uber quality — sign in once, never prompted again unless security event forces it.

**Key capabilities to build:**
- Silent auth on every launch: splash → token refresh → profile restore → last page restore
- Multi-profile switcher: Buyer / Merchant / Driver / Provider / Admin — no logout required
- Account Centre (14 sections): Profile, Security, Devices, Sessions, Legal, Subscriptions, Payments, Wallet, Notifications, Privacy, Businesses, Verification, Downloads, Delete Account
- Active devices panel: device name, platform, browser, city, last active, revoke session
- Premium logout flow: single device or all devices (requires password/OTP)
- Account deletion: 5-step flow with 30-day grace period, data export, legal compliance
- Refresh token rotation + server-side session revocation
- Suspicious login detection
- Offline access to cached content with sync on reconnect
- First-login onboarding: biometrics offer, notification opt-in, role selection

**Backward compatibility:** Reuse existing Firebase Auth, App Check, role engine, onboarding, subscriptions. No breaking changes.

**Deferred from v1.0 code freeze:** 2026-07-13.

---

### Tier 1 — v1.1 (Build First)

#### 1. Loyalty & Rewards Program — Score: 22/25

| Axis | Score | Rationale |
|------|-------|-----------|
| User Impact | 5 | Every buyer benefits on every order — immediately visible |
| Revenue Potential | 5 | Points drive repeat purchase; redemption keeps spend on-platform |
| Dev Complexity | 4 | Points ledger + redemption UI; no new APIs needed |
| Operational Cost | 5 | Pure Firestore; minimal CF cost |
| Dependency Risk | 3 | Requires stable order flow (already live) |

**Plan:** Points earned at order completion (`onOrderPaid` trigger), redeemed at checkout as partial payment. Tiers: Bronze/Silver/Gold/Platinum. Admin dashboard for campaign boosts.

---

#### 2. Wallet & Seller Payouts — Score: 21/25

| Axis | Score | Rationale |
|------|-------|-----------|
| User Impact | 4 | High impact for sellers (instant payouts vs manual settlement) |
| Revenue Potential | 5 | Float income on wallet balances; seller retention driver |
| Dev Complexity | 3 | IntaSend B2C API wired; needs balance ledger + payout scheduler |
| Operational Cost | 4 | Low infra cost; compliance overhead moderate |
| Dependency Risk | 5 | Zero new deps — IntaSend already live |

**Plan:** Firestore double-entry ledger per seller. Top-up via M-Pesa STK Push. Payout to registered M-Pesa number. Minimum payout threshold: KES 100. Scheduled daily payout sweep via Cloud Scheduler.

---

#### 3. Jobs Marketplace — Score: 18/25

| Axis | Score | Rationale |
|------|-------|-----------|
| User Impact | 5 | Opens the platform to a completely new user demographic (job seekers, employers) |
| Revenue Potential | 4 | Featured listings, promoted applications, subscription job boards |
| Dev Complexity | 3 | Standard listing → application flow; hub-register already handles categories |
| Operational Cost | 3 | Moderation overhead; job post expiry logic |
| Dependency Risk | 3 | Depends on Hub Registration + Auth (both live) |

**Plan:** Employer posts job (hub-register flow). Seekers browse + apply. Employer reviews applications. Featured placement via commission engine. Employer dashboard for tracking.

---

### v1.2 — Completed (2026-06-25)

| Initiative | Status |
|------------|--------|
| Complete conversion funnel (paymentAttempted) | ✅ Done |
| Seller Success Center (tabbed, data-driven) | ✅ Done |
| Listing quality scoring (getListingQualityReport) | ✅ Done |
| Seller performance summary (fast/slow movers) | ✅ Done |
| Retention engine (recently viewed, saved searches, price alerts) | ✅ Done |
| Marketplace quality scanner (7 issue types, health score) | ✅ Done |
| Search insights CF (no-result terms, top queries, conversions) | ✅ Done |
| Conversion analysis document | ✅ Done |
| Search quality report | ✅ Done |
| Marketplace quality report | ✅ Done |
| Scalability review | ✅ Done |
| 90-day growth plan (evidence-gated) | ✅ Done |

### Tier 2 — v1.3 (post-Phase-A evidence)

| Initiative | Score | When |
|------------|-------|------|
| QR Code System | 16/25 | After Loyalty (shares checkout flow) |
| Super Admin Portal | 15/25 | When multi-admin team exists |
| CSP nonce migration (`unsafe-inline` removal) | 14/25 | When IntaSend SDK supports nonces |
| Education Hub | 13/25 | After Jobs validates service-marketplace pattern |
| `SENDGRID_WEBHOOK_KEY` hardening | 12/25 | Operational — low effort, do in v1.1 maintenance window |

---

### Tier 3 — v1.3+

| Initiative | Notes |
|------------|-------|
| Insurance Marketplace | Requires insurance provider partnerships first |
| Government Services | Requires API agreements with NTSA, KRA, eCitizen |
| Franchise / White-label | Requires stable multi-tenancy architecture |
| Peer-to-peer Wallet | Requires CBK licensing considerations |

---

### v1.1 Decision Principle

> **Do not build Tier 2 or Tier 3 features until:**
> 1. Loyalty has measurable repeat-purchase lift (track via `productStats.salesLast30d` vs baseline)
> 2. Wallet has processed ≥50 real payouts without incident
> 3. Jobs has ≥20 active listings within 30 days of launch

Evidence from real users determines what gets built next, not assumptions.

---

## Technical Debt

| Item | Severity | Status |
|------|----------|--------|
| CSP `unsafe-inline` in script-src | LOW | IntaSend SDK requires it; CSP nonce migration in v1.2 |
| `SENDGRID_WEBHOOK_KEY` not set | LOW | Webhook accepts but logs warning; set before v1.1 |
| ~~`MAIL_HOST` secret = placeholder~~ | RESOLVED | smtp.sendgrid.net — SendGrid SMTP relay configured 2026-06-25 |
| First Firestore backup not yet run | INFO | Scheduled daily; will self-resolve |
| Search index backfill pending | INFO | Run `searchBackfillAll` once |
| ~~`onBookingStatusChanged` HTTPS→Firestore migration blocked~~ | RESOLVED | GCP stale HTTPS version deleted 2026-07-11; re-exported as `onDocumentUpdated` trigger |

---

## Known Limitations (v1.0.0 Production)

All previous blockers (secrets, DNS, monitoring, deployments) resolved as of 2026-06-25.

Remaining accepted limitations:
- `unsafe-inline` required until IntaSend SDK nonce-compatible version released
- SMTP fallback offline (SendGrid covers all email delivery)
- Algolia/Typesense indexes empty until `searchBackfillAll` is run (Firestore fallback active)

---

## Platform Health (Verified 2026-06-25)

| Metric | Score | Notes |
|---|---|---|
| Production Readiness | **98/100** | All infra live, verified by live HTTP + health check |
| Security | **94/100** | HSTS, CSP + frame-ancestors + report-uri, HMAC webhook, 237 Firestore rule blocks |
| Performance | **89/100** | Bounded queries, cache-first SW, lazy loading, 3-tier search |
| Scalability | **94/100** | Stateless Gen2 CFs, flat Firestore, GCS lifecycle, scale/queue modules |
| Reliability | **93/100** | 12 monitoring alerts, CF circuit breakers, email queue+retry, health endpoint |
| Maintainability | **89/100** | 63 CF modules, pre-deploy gate (12/12), CI/CD pipeline, 188 indexes documented |
| Cloud Functions | **569 live** | All Gen2 Node 22; verified via firebase functions:list |
| Firestore Indexes | **188 / 200** | 12 reserve slots |
| Email Templates | 53 | All branded, Outlook-compatible |
| Service Worker | sokoni-v292 | Cache-first with background sync |
| Git Tag | v1.0.0 | Commit 3560bba; latest 1c552c2 |
