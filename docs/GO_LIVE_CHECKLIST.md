# SOKONI Go-Live Checklist

**Platform:** SOKONI  
**Legal Entity:** Bravilex International Co. Limited  
**Target Environment:** Production (sokoni-aeb26)  
**Classification:** Internal — Engineering

---

## Pre-Launch: Code & Infrastructure

### ✅ Completed (Verified)

- [x] Firebase project `sokoni-aeb26` live and operational
- [x] Firestore security rules deployed (4,275 lines, auth-guarded)
- [x] Cloud Storage rules deployed (size limits, content-type guards, no public write)
- [x] App Check (ReCaptcha v3) configured in `sokoni-appcheck.js`
- [x] Service Worker v68 (`sokoni-20260713-notify-channels-v68`) deployed
- [x] Settlement Engine (`functions/settlement-engine.js`) — canonical MoR account
- [x] Notification Engine (`functions/notify.js`) — 50+ types, category channels
- [x] Email Architecture — 45+ sender identities, all `@mysokoni.co.ke`
- [x] CompanyIdentity service — server + client lockstep
- [x] IntaSend live public key set in `sokoni-config.js`
- [x] IntaSend private key in Secret Manager
- [x] Africa's Talking production environment (`AT_ENV=production`)
- [x] Scheduled reports: daily ops (06:00 EAT) + weekly security (Mon 07:00 EAT)
- [x] Admin roles documented (`docs/ADMIN_ROLES.md`)
- [x] Firebase Cloud Messaging — category channels (sokoni_orders, sokoni_payments, etc.)
- [x] Rate limiting (Firestore fallback active; Redis VPC pending)
- [x] PITR (Point In Time Recovery) enabled for Firestore
- [x] 606+ Cloud Functions deployed

---

## Pre-Launch: Manual Configuration Tasks

### Google Workspace

- [ ] **GW-1** — `isaac@mysokoni.co.ke` account created in Workspace
- [ ] **GW-2** — Isaac assigned User Management Admin + Support Admin + Help Desk Admin
- [ ] **GW-3** — Isaac granted Firebase Editor role (not Owner)
- [ ] **GW-4** — Alex confirmed as Workspace Super Admin
- [ ] **GW-5** — 2-Step Verification enforced for all users
- [ ] **GW-6** — Security Center enabled
- [ ] **GW-7** — Admin activity alerts enabled (privilege grant, suspicious sign-in, etc.)
- [ ] **GW-8** — `bravilexinternational@gmail.com` forwarding to `info@mysokoni.co.ke` confirmed
- [ ] **GW-9** — Shared Drives created (Operations, Engineering, Legal)

### Firebase Console

- [ ] **FB-1** — Authentication → Email Templates: Display Name = "SOKONI"
- [ ] **FB-2** — Authentication → Email Templates: Reply-To = `support@mysokoni.co.ke`
- [ ] **FB-3** — Project Settings: Public-facing name = "SOKONI"
- [ ] **FB-4** — Project Settings: Support email = `support@mysokoni.co.ke`
- [ ] **FB-5** — Authentication → Authorized domains: `mysokoni.co.ke` present
- [ ] **FB-6** — App Check enforcement: ENABLED (not audit mode) for Functions + Firestore + Storage

### Google Cloud

- [ ] **GCP-1** — OAuth consent screen: App name = "SOKONI", support = `support@mysokoni.co.ke`
- [ ] **GCP-2** — Web API key restricted to `https://mysokoni.co.ke/*` HTTP referrers
- [ ] **GCP-3** — Cloud Monitoring: `security@mysokoni.co.ke` added as alert channel
- [ ] **GCP-4** — Cloud Monitoring: `admin@mysokoni.co.ke` added as secondary alert channel
- [ ] **GCP-5** — IAM: `ogutualex824@gmail.com` confirmed Owner; no other unexpected Owner
- [ ] **GCP-6** — Billing: account name updated to "Bravilex International Co. Limited"
- [ ] **GCP-7** — Billing: cost alerts set at $100 / $500 / $1,000

### IntaSend

- [ ] **IS-1** — Business profile: "Bravilex International Co. Limited" / "SOKONI"
- [ ] **IS-2** — Contact email: `info@mysokoni.co.ke`
- [ ] **IS-3** — Support email: `payments@mysokoni.co.ke`
- [ ] **IS-4** — Webhook contact: `developers@mysokoni.co.ke`
- [ ] **IS-5** — Webhook URL confirmed: `https://us-central1-sokoni-aeb26.cloudfunctions.net/intasendWebhook`
- [ ] **IS-6** — Webhook retries: 3 attempts, 30s interval
- [ ] **IS-7** — Settlement account: Bravilex 0686420001 confirmed

### Secret Manager

- [ ] **SEC-1** — `SENDGRID_API_KEY` — real SG. key (not placeholder)
- [ ] **SEC-2** — `INTASEND_PRIVATE_KEY` — live private key
- [ ] **SEC-3** — `INTASEND_API_KEY` — live API key
- [ ] **SEC-4** — `AFRICASTALKING_API_KEY` — production AT key
- [ ] **SEC-5** — `AFRICASTALKING_USERNAME` — production AT username
- [ ] **SEC-6** — `ETIMS_PLATFORM_PIN` — KRA PIN (P051521597J)
- [ ] **SEC-7** — `LOYALTY_HMAC_SECRET` — strong random secret set
- [ ] **SEC-8** — `REDIS_URL` — production Redis URL confirmed
- [ ] **SEC-9** — `ANTHROPIC_API_KEY` — production Anthropic key

---

## Pre-Launch: Code Fixes (Firestore Rules)

- [x] **CODE-1** — Fix duplicate `conversations` rules block — FIXED 2026-07-13 (removed duplicate, merged update rule)
- [x] **CODE-2** — Fix `deliveryLocations` GPS privacy gap — FIXED 2026-07-13 (scoped to rider + viewers array + admin)
- [x] **CODE-3-b** — Fix `driverLocations` GPS privacy gap — FIXED 2026-07-13 (same pattern: rider + viewers array + admin)
- [ ] **CODE-3** — Complete VPC serverless connector for Redis
- [ ] **CODE-4** — Dispatch CF must populate `driverLocations.viewers` array when ride is assigned (enables passenger GPS access)

---

## Pre-Launch: End-to-End Tests

- [ ] **TEST-1** — Account registration (email + phone)
- [ ] **TEST-2** — OTP delivery via SMS
- [ ] **TEST-3** — Login (email, Google, phone)
- [ ] **TEST-4** — Payment checkout (M-Pesa STK push)
- [ ] **TEST-5** — Payment webhook received and processed
- [ ] **TEST-6** — Order lifecycle (created → confirmed → shipped → delivered)
- [ ] **TEST-7** — Seller settlement triggered
- [ ] **TEST-8** — Push notification delivery (order update)
- [ ] **TEST-9** — Email notification (order confirmation to buyer)
- [ ] **TEST-10** — Refund flow
- [ ] **TEST-11** — Admin dashboard functional
- [ ] **TEST-12** — Cloud Monitoring alert fires on test trigger
- [x] **TEST-13a** — P58E printer hardware certification — CERTIFIED 2026-07-13 (see [[P58E_HARDWARE_CERTIFICATION]])
- [ ] **TEST-13c** — iOS / Safari printing certification
  - Operator runs `pos-ios-print-test.html` on iPhone — 7-step matrix
  - Auto-detects: platform, Web Bluetooth (✗), Web Serial (✗), WebUSB (✗), AirPrint (✓), Web Share (✓)
  - Manual: POS accessibility, AirPrint dialog, Share Sheet, WhatsApp receipt, cross-platform consistency
- [ ] **TEST-13b** — SmartPOS full sale + automatic receipt print (end-to-end checkout cycle)
  - Pre-conditions fixed 2026-07-14: `shiftId` now flows checkout→sale record→closeShift; print failures now surfaced to cashier with retry; `closeShift` collection corrected (`posSales→posRetailSales`)
  - Remaining: live hardware test — scan product, pay cash, confirm receipt prints, check `posRetailSales` in Firestore, close shift, verify Z report totals match
- [ ] **TEST-14** — Offline mode (service worker cache hit)

---

## Pending External Approvals

- [ ] **EXT-1** — Africa's Talking: SOKONI alphanumeric Sender ID approved
  - On approval: set `AT_SENDER_ID=SOKONI` in `functions/.env` and deploy
- [ ] **EXT-2** — ODPC: Data Controller/Data Processor registration submitted
- [ ] **EXT-3** — KIPI: Trademark application for SOKONI filed and monitored

---

## Go/No-Go Decision

| Category | Status | Blocking? |
|---|---|---|
| Core infrastructure | ✅ Live | — |
| Payment integrity | ✅ Verified | — |
| Security rules | ✅ 3 fixes applied | — |
| P58E printer | ✅ Hardware certified | — |
| Secret Manager | ⚠️ Verify all secrets | Yes |
| Firebase branding | ⚠️ Manual pending | No |
| Google Workspace | ⚠️ Manual pending | No |
| Redis VPC | ⚠️ Pending | No (Firestore fallback active) |
| AT Sender ID | ⏳ Awaiting approval | No (shared shortcode works) |
| End-to-end tests | ⬜ Not run | Yes |
| ODPC registration | ⬜ Pending | No (recommended before public launch) |

### Definition of GO:
All **Yes** blockers resolved + all **TEST-** items passed.

---

*Document: SOKONI Go-Live Checklist v1.0 — 2026-07-13*
