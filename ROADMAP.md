# ROADMAP.md

# SOKONI Platform Roadmap

**Version:** 2.8.0  
**Updated:** 2026-06-21  
**Status:** Production — Active Development

Related: [[CHANGELOG]] [[docs/ARCHITECTURE]] [[docs/SECURITY]]

---

## Completed Features

### Core Platform

| Feature | Version | Status |
|---|---|---|
| Firebase Authentication (email, Google, phone) | v1.0 | ✅ Done |
| Multi-vendor marketplace — seller & buyer flows | v1.0 | ✅ Done |
| Product listings, categories, search | v1.0 | ✅ Done |
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
| Unit tests — 67 tests (helpers, fraud, webhooks) | v2.2 | ✅ Done |

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

## Planned Features

### Near-Term (Next Sprint)

| Feature | Priority | Notes |
|---|---|---|
| Wallet / Digital Wallet | High | Buyer stored-value wallet, top-up via M-Pesa, spend at checkout |
| Jobs Marketplace | High | Job listings, applications, employer dashboard |
| CSP hardening — remove `unsafe-inline` | High | Scheduled in v2.2 certification (30-day sprint) |
| `previewEmailTemplate` Cloud Function | Medium | Admin Email Center template preview (graceful fallback exists) |
| Loyalty & Rewards Program | Medium | Points per order, redemption at checkout, tiers |
| QR code system | Medium | Product QR, venue QR, order QR for pickup |
| Barcode system | Medium | Product barcode scanning for POS and inventory |

### Medium-Term

| Feature | Priority | Notes |
|---|---|---|
| Education Hub | Medium | Tutors, online courses, exam prep |
| Super Admin portal | Medium | Cross-project oversight, global analytics |
| Receipt printing improvements | Medium | Thermal printer templates, logo, QR |
| Algolia/Typesense production | Medium | Real search-as-a-service credentials + indexing pipeline |
| B2C payout improvements | Medium | Instant vs scheduled payout option for sellers |

### Long-Term

| Feature | Priority | Notes |
|---|---|---|
| SOKONI Wallet full stack | Low | Peer-to-peer transfers, merchant accounts, virtual cards |
| Insurance marketplace | Low | Integration with insurance providers |
| Government services | Low | NTSA, KRA, e-citizen integration |
| Franchise/white-label | Low | Branded sub-platforms for enterprise clients |

---

## Technical Debt

| Item | Severity | Notes |
|---|---|---|
| CSP `unsafe-inline` | High | `Content-Security-Policy` header uses `unsafe-inline` for scripts/styles — planned removal in next security sprint |
| EmailJS template ID placeholder | Low | `sokoni-invoice.js` still references `YOUR_TEMPLATE_ID`; CF fallback works, so this is cosmetic |
| VAPID key not configured | Medium | FCM web push silently disabled until key is generated and wired |
| Monitoring alerts not applied | Medium | `monitoring/alerts.json` ready but `NOTIFICATION_CHANNEL_ID` not set in GCP |
| Search credentials placeholder | Low | Algolia/Typesense keys not set; Firestore fallback active |

---

## Known Limitations

- Email delivery requires real SendGrid or SMTP credentials (currently placeholder)
- IntaSend payments bypass live key guard and return test responses
- FCM web push notifications not delivered (VAPID key absent)
- Google Cloud Monitoring alerts inactive (channel not provisioned)
- Algolia/Typesense search falls back to Firestore (slower, less ranked)

---

## Platform Health

| Metric | Score | Notes |
|---|---|---|
| Launch Readiness | 86/100 | Source: v2.7.0 audit |
| Security | 92/100 | Source: Production Hardening Sprint |
| Cloud Functions | 75+ live | All Gen 2 triggers verified |
| Unit Tests | 67 passing | helpers, fraud, webhooks |
| Firestore Indexes | 45+ composite | All deployed |
| Email Templates | 53 | All branded, Outlook-compatible |
