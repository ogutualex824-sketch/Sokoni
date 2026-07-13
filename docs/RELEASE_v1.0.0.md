# SOKONI v1.0.0 — Release Notes

**Release Date:** 2026-07-12  
**Legal Entity:** Bravilex International Co. Limited *(corrected 2026-07-13 — this file said "Bravilex Systems Ltd", which is not the registered entity; canonical source is `CompanyIdentity` / `company-identity.js`)*  
**Platform URL:** https://mysokoni.co.ke  
**Release Tag:** v1.0.0  
**Service Worker:** `sokoni-20260713-pos-fix-v53` (current)

---

## Legal Engine — Regression Suite Aligned to the Mandatory Signature Workflow (2026-07-13)

**`test-legal-compliance.js` now validates the mandatory digital-signature workflow. 45 checks, 0 failures.**

### What was wrong

`legalAccept` was correctly hardened to require an electronic signature. The regression
suite still exercised the **previous** API contract and supplied none, so every acceptance
call threw `invalid-argument: A digital signature is required`.

**This was test-suite drift, not an application defect.** The implementation was right and
the tests were stale. `functions/legal-agreements.js` was **not modified** — the signature
requirement was not relaxed, weakened, or bypassed.

The stale suite was also masking a second drift: it asserted
`acceptanceMethod === 'checkbox'`, but the field now records the signature *type*
(`typed-signature` / `drawn-signature` / `stamp-signature`).

### Validation order (verified against the implementation, and intentional)

```
1. auth                      → unauthenticated
2. acceptances non-empty     → invalid-argument
3. signature type valid      → invalid-argument     ← signature is validated
4. signed name (≥2 chars)    → invalid-argument        BEFORE the catalogue is
5. confirmed === true        → failed-precondition     even loaded
6. drawn/stamp data ≥64B     → invalid-argument
7. professional declaration  → failed-precondition
8. agreement version matches → failed-precondition  ← version is the LAST gate
9. idempotent write (deterministic doc id)
```

A signature is a **precondition for recording anything at all** — it makes no sense to
validate *which version* of a document someone is signing before establishing *that they
signed*. This ordering is correct and must not be "fixed".

Consequently the wrong-version test can only observe a version error once it supplies an
otherwise-valid signature. The old test carried no signature, so it never reached the
version gate — it was asserting the right error code for the wrong reason.

### Coverage added

**All three lawful signature forms accepted** (Kenya Business Laws (Amendment) Act / ETA):
typed full legal name, drawn signature, company stamp. Drawn and stamped artefacts are
stored as a **SHA-256 hash only** — never the raw image, which is large and
biometric-adjacent personal data. Asserted.

**Rejections (all negative tests retained, eight added):** missing signature · empty
signature (drawn *and* stamp) · invalid signature type · signed name missing/too short ·
not confirmed · professional role without the Professional Declaration · unauthenticated
signer · no acceptances · wrong agreement version · unknown agreement.

**Tampered payload — the client cannot author its own evidence:** a client-supplied
`signature.hash` is **ignored** (the server recomputes it) and a client-supplied
`acceptedFrom` IP is **ignored** (the server captures it from the request). Both asserted.

**Duplicate acceptance** is idempotent via a deterministic document id — no duplicate
records. Asserted.

### CI gates (all passing, 2026-07-13)

`legal-compliance` (45) · `verify-company-identity` (893 files) · `payment-integrity` (17) ·
`notification` (26) · `SMS` (11) · `promotions` (10) · `App Check`

---

## Branding Policy — Verified (2026-07-13)

**Status: VERIFIED.** `CompanyIdentity` is the canonical source for legal-entity information.
Commit `0f50347` (maintenance — ships in the next **non-hotfix** release, isolated from the
payment hotfix).

### Policy

| | |
| --- | --- |
| **Customer-facing brand** | **SOKONI** — always |
| **Legal entity** | **Bravilex International Co. Limited** |

The legal entity appears **only** where legally required: certificates, regulatory
disclosures, tax-issuer information, settlement-entity information, Terms & Conditions,
Privacy Policy, legal footer. It **never** replaces SOKONI in headers, titles, navigation or
marketing surfaces.

### Canonical sources

| Concept | Source of truth |
| --- | --- |
| `legalName` / company name | `CompanyIdentity.legalName` |
| Trading / operating name | `CompanyIdentity.operatingName` (`'SOKONI'`) |
| Consumer brand | `CompanyIdentity.brand` (`'SOKONI'`) |
| Tax issuer | `invoiceIssuer()` / `receiptIssuer()` — both derive from `legalName` |
| Settlement entity | `settlement-account.js` `ACCOUNT_NAME` — **deliberately distinct** (see below) |

Two lock-step files: `functions/company-identity.js` (server) and `sokoni-company.js`
(client). Drift guard: `scripts/verify-company-identity.js`.

> **No `companyName` / `tradingName` aliases were added.** They do not exist and are not
> used; `legalName` and `operatingName` already carry those meanings. Adding synonyms would
> create two names for one thing — the exact bug class that produced `fcmToken`/`fcmTokens`,
> `deepLink`/`url` and `userId`/`targetUid` in this codebase, each of which failed silently
> in production.

> **The settlement account name is intentionally NOT `legalName`.** It is
> `"Bravilex International Co. **Ltd**"` — banks match the account name on an exact string,
> so it must not be "normalised" to `"… Co. Limited"`. Documented in
> `functions/settlement-account.js`. **Do not fix this.**

### What was fixed

`sokoni-legal-certificate.js` — the Digital Acceptance Certificate carried a
*"Powered by &lt;legal entity&gt;"* strapline directly beneath its title, the most prominent
line on the page, under a name that was not even the registered one. The title now reads
*"Issued by SOKONI."*; the entity moved to the footer as a regulatory disclosure, read from
`CompanyIdentity` rather than typed. `legal-centre.html` now loads `sokoni-company.js`
**before** the certificate module — it previously did not, so `window.SOKONI_COMPANY` was
undefined and the module would have silently fallen back to a hardcoded literal.

### Verification (2026-07-13)

- `verify-company-identity` → **PASS** (exit 0) — *CompanyIdentity consistent across 894 files*
- Repo-wide sweep: the obsolete literal *"Bravilex International **Company** Limited"* exists in
  **exactly one place** — inside the guard, as the string it detects. Nowhere else.
- No occurrence of the legal entity in any customer-facing title, `h1`/`h2`, nav, logo or
  header. All remaining uses are legal footers, policy pages, JSON-LD `legalName`, the admin
  panel, or the tax/settlement surfaces above — all permitted.
- No APIs, schemas, layouts or business logic changed.

---

## 🚨 HOTFIX P0-7 — Payment Integrity (2026-07-13)

**Deployed outside the feature freeze. Prevents incorrect financial state.**

| | |
| --- | --- |
| **Commits** | `d7a7ac7` · `af2d632` (checkout, hosting) · `2acdbea` (server-side payment gates) |
| **Deployed** | 2026-07-13 — hosting `af2d632`, functions `2acdbea` |
| **Regression gate** | `scripts/test-payment-integrity.js` — **17 checks, PASSING**, CI-blocking |
| **Standard** | `FINANCIAL_TRANSACTION_STANDARD.md` **v1.2.0** — new Invariant 9 (Provider-attested) + F6 |

### Root cause

Checkout had **four** paths that told the customer *"✅ Payment Confirmed"* and wrote a real
order with `status: "paid"` — the flag a seller reads to decide it is safe to ship — when
**no money had moved**: `processMobileMoney()` (a 1600 ms timer; six offered providers that
have **no backend at all**), `_runDemoStkPush()` (a complete fake M-Pesa STK flow, active
whenever `INTASEND_PUBLIC_KEY` was empty), `_cardFallback()` (*"simulate approval then save
order"*, reached whenever the IntaSend **script failed to load**), and a branch that trusted
a client-side `COMPLETE` event. `saveAndRedirect()` hardcoded `status: "paid"` for every
method.

Two server triggers then fired on order **create** with no payment gate, so an unpaid order
still reached people: `onNewOrderCreated` told the seller *"Confirm it to begin processing"*,
and `emailOnOrderCreated` emailed the customer an *"order-confirmation"*.

**The two most dangerous paths were not dead code — they were fallbacks.** The platform was
one blank config value, or one ad-blocker, away from giving stock away in production.

### Fix (all failing closed)

- Payment status is **derived, never assumed**. Only a provider callback or server-side
  verification yields `paid`; everything else is `pending_payment` — **DO NOT SHIP**.
- `escrow.held = 0` when unverified. Escrow holds money, not intent.
- All simulation paths **deleted**. Payment code has no demo mode.
- Six unintegrated methods refused and shown "Coming soon", from **one list**.
- Seller notification and customer confirmation email now require verified payment.
- Customer sees only neutral states until confirmation.

### Verification evidence (2026-07-13)

- **Production fetch of `https://mysokoni.co.ke/checkout.html`** → HTTP 200. `UNINTEGRATED_PAYMENTS`,
  `pending_payment` and `paymentVerified` **present**; the live `_cardFallback` body confirmed
  to fail closed ("*your card has NOT been charged and no order was placed*"); the fabricated
  "Card Approved" and STK "Payment Confirmed" strings **absent**.
- `scripts/test-payment-integrity.js` → **17/17 PASS**.
- Full regression: notify (26), SMS (11), promotions (10), company-identity, App Check → **all PASS**.

### ⚠️ Outstanding — reconciliation NOT yet performed

Historical orders were **not** modified, by design. The audit
(`scripts/audit-payment-integrity.js`, read-only) **could not be run**: Application Default
Credentials are stale (`invalid_client`). It requires:

```bash
gcloud auth application-default login
node scripts/audit-payment-integrity.js --csv payment-audit.csv
```

**Until this completes, no revenue, GMV, settlement or commission figure predating
2026-07-13 can be trusted.** See `RUNBOOK_PAYMENT_INTEGRITY.md`.

---

## What Is SOKONI v1.0.0

SOKONI is an enterprise-grade Kenyan super-platform connecting buyers, sellers, service providers, drivers, and businesses through a single digital ecosystem.

v1.0.0 is the first production-ready release, covering:

| Module | Status |
|---|---|
| Multi-Vendor Marketplace | ✅ Live |
| SmartPOS 4.0 (Retail OS) | ✅ Live |
| Food Hub | ✅ Live |
| Event Hub | ✅ Live |
| Property Marketplace | ✅ Live |
| Vehicle Marketplace | ✅ Live |
| Jobs & Hiring | ✅ Live |
| Healthcare Hub | ✅ Live |
| Legal Services | ✅ Live |
| Education Hub | ✅ Live |
| Entertainment Hub | ✅ Live |
| Digital Products Hub | ✅ Live |
| B2B Wholesale | ✅ Live |
| Logistics & Delivery | ✅ Live |
| Driver Hub | ✅ Live |
| Universal Loyalty (Bronze → Platinum) | ✅ Live |
| Wallet & Payments (M-Pesa via IntaSend) | ✅ Live |
| Subscriptions & Billing | ✅ Live |
| AI Concierge (KASS v2) | ✅ Live |
| Admin OS (19-panel hub) | ✅ Live |
| FinOS (General Ledger, Escrow, Settlements) | ✅ Live |
| eTIMS (KRA Tax Compliance) | ✅ Live (secrets pending) |
| Enterprise Search (Algolia) | ✅ Live (billing active) |
| Enterprise Notification Center | ✅ Live |
| Security 5.0 (Zero Trust) | ✅ Live |
| Legal Agreement Acceptance | ✅ Live |
| Commission Engine | ✅ Live |

---

## Architecture Summary

| Layer | Technology |
|---|---|
| Frontend | Static HTML/CSS/JS + Service Worker (PWA) |
| Backend | Firebase Cloud Functions (Gen2 ~630 CFs) |
| Database | Firestore (default + sokoni-ops databases) |
| Auth | Firebase Auth (Email, Google, Facebook, Phone OTP) |
| Payments | IntaSend (M-Pesa STK, B2C disbursement) |
| Email | SendGrid (53 templates, 40+ @mysokoni.co.ke accounts) |
| Search | Algolia |
| Cache | Redis (10.127.36.43:6379 — VPC connector pending) |
| Storage | Firebase Storage |
| Hosting | Firebase Hosting + Cloudflare CDN |
| Secrets | Google Secret Manager |
| Monitoring | Google Cloud Monitoring (18+ alert policies) |

---

## Post-Launch Fixes (v40 → v53)

| SW Version | Change |
|---|---|
| v41 | Header redesign |
| v42 | Email logo premultiplied-alpha fix (`sokoni-email-logo.png` 360×240) |
| v43 | PWA connectivity detection hardening — `_doProbe()` response type check; `_setBar()` cross-clear; initial probe 8 s → 3 s; `SokoniOffline.hide()` public API |
| v44 | Splash screen unified v2.0 — singleton `splash.js`, inline SVG basket icon, shared-header guard |
| — | **Email enterprise redesign v3.0** — white canvas, CSS brand header, 53 templates; statusCard/metricCard/codeBlock helpers; dark mode; Outlook VML buttons; enterprise footer |
| — | **Mobile layout regression fixes** — footer single-column ≤768px; login card full-width; header logo PNG→SVG; auth body flex-column; KASS FAB clearance confirmed |
| — | **CDN cache hardening** — `firebase.json` `**/*.@(js|css)` rule now includes `Cloudflare-CDN-Cache-Control: no-store` + `Surrogate-Control: no-store`; previously Cloudflare cached JS/CSS for up to 7 days post-deploy |
| — | **cleanUrls nav fix** — `shared-header.js` EXCLUDED list now includes no-extension variants (`login`, `signup`, `profile`, etc.); `cleanUrls:true` strips `.html` so `/login` never matched `'login.html'`, rendering the full platform nav on auth pages |
| v46 | **Communication Engine v1.0** — `functions/notify.js` is the single entry point for push/in-app/SMS/email; 11-stage monotonic order timeline (`orderAdvance`); `track.html` live journey. Fixed three silent production failures, all the same bug — a producer and a consumer using different names for one field, with nothing asserting they agreed: `fcmToken`/`fcmTokens` (**push from loyalty.js + redis-jobs.js had never reached a single user**), `deepLink`/`url` (**rich push would open the homepage, not the order**), `userId`/`targetUid` (**in-app notifications matched nobody's query**). Guarded by `scripts/test-notify.js` (23 checks). See [[Communication Engine]] |
| v50 | **P0-9: Flash Deals chip overflow + UTF-8 encoding + Mobile UI polish** — Three UI defects: (1) Flash Deals category chips compressed on iPhone Safari — `flex-shrink:0` missing from `.fs-cat`; `touch-action:pan-x` missing from `.fs-cats` and `.fs-feat-scroll` scroll containers. (2) Middle dot rendered as "Â·" due to UTF-8/Latin-1 double-encoding — replaced with `&middot;` entity in `flashsale.html`. (3) Story nav arrows were 28×28 px (below 44×44 WCAG minimum) — enlarged to 44×44; `storiesRing` and hub pills row missing `touch-action:pan-x;overscroll-behavior-x:contain` on iOS. |
| v47 | **P0-8: Google Sign-In broken + False offline banner** — Two compounding root causes: (1) `_isPopupSupported()` forced all iOS users through `signInWithRedirect`, which fails silently on iOS Safari (ITP blocks the `sokoni-aeb26.firebaseapp.com` iframe from reading cross-site storage → `getRedirectResult()` returns null). Fixed: regular iOS Safari now uses popup. (2) No already-logged-in guard on login.html — when the SW `controllerchange` reload fired during the 900ms + 1200ms auth timers, the user was stranded on the login page while Firebase had already set the session. Fixed: `_alreadyLoggedInGuard()` IIFE redirects immediately from localStorage (fast) or `sokoniAuthReady` event (slow path). Also fixed: `navigator.onLine` gate removed (unreliable on iOS/PWA); `setPersistence(browserLocalPersistence)` added before every redirect; `sokoniAuthReady` event now dispatched from `onAuthStateChanged` in `firebase.js`; `firebase.js`/`auth.js`/`session-manager.js` moved to `ALWAYS_FRESH` (no more stale auth SDK). Offline banner: `sokoni-offline.js` initial probe delayed from 0 ms to 3500 ms — eliminates false banner on PWA launch when `navigator.onLine` is transiently false during startup. |
| v52 | **Logo dark fix** — SOKONI logo PNG (`Sokonilogo2.png`) added to all pages that were still showing the light variant or a missing image; favicon and splash updated. |
| v53 | **Mobile Homepage Stabilization Sprint + POS/Seller emergency fixes** — (1) False offline banner on every PWA cold-start: `sokoni-ui.js` `_GRACE_MS` 4 s → 10 s; `sokoni-offline.js` boot-time grace 11 s added to all event handlers, initial probe 3.5 s → 11 s. (2) KASS FAB + Scroll-Top FAB overlapping content on iPhone: CSS vars `--sk-kass-bottom` and `--sk-scroll-bottom` = `calc(64px + env(safe-area-inset-bottom, 0px) + 20px)` in `mobile.css`; `kass-widget.js` modal bottom safe-area-aware. (3) Quick-links chips wrapping on 601–767 px: `style.css` `.qlinks-row` base changed to `flex-wrap:nowrap; overflow-x:auto`. (4) iOS Safari search zoom: `#sk-nav-search` font-size 13 px → 16 px on mobile in `shared-header.js`. (5) POS CRITICAL: SyntaxError in `pos-setup.html` killed all event listeners. (6) Seller dashboard: `sdSwitchTab` undefined above 768 px — all quick-action tiles silent on desktop. |

---

## Go-Live Sprint Fixes (v39 → v40)

All fixes applied in this sprint resolve production blockers identified during the final production readiness audit.

| ID | Severity | Fix |
|---|---|---|
| B-01 | CRITICAL | Email: SENDGRID_API_KEY confirmed live in Secret Manager (SG.* key); HTML + plain-text delivery verified end-to-end (SendGrid 202, 2026-07-12); enterprise base template v2.0 deployed across all 53 templates |
| B-09 | HIGH | Zero Trust: Financial operations now fail-closed when auth service is unreachable |
| B-10 | HIGH | Tables: Global responsive overflow-x fix applied via shared-header.js |
| B-11 | HIGH | Admin idle timeout: 60 min → 20 min across all pages (firebase.js + auth.js) |
| B-13 | HIGH | Monitor: Unbounded Firestore reads → limit(500) sampling |
| B-14 | CRITICAL | Firestore indexes: 226 → 200 (hard limit resolved); 26 migrated to sokoni-ops |
| B-15 | CRITICAL | API Gateway: CF-to-CF double billing eliminated; inline handlers |
| B-16 | CRITICAL | Digital hub: onSnapshot listener stacking eliminated |
| B-17 | HIGH | Firestore rules: Duplicate blocks + PII exposure + reviews moderation fixed |
| CF-02 | HIGH | conversion-analytics.js: Self-calling health CF → inline helper |
| CF-03 | CRITICAL | pos-terminal-live.js: setTimeout-in-frozen-CF removed; virtual terminal synchronous |

---

## Outstanding Blockers (Require Operator Action)

| ID | Action | Command |
|---|---|---|
| B-02 | Deploy remaining CFs after Cloud Run quota approval | `bash scripts/batch_deploy.sh` |
| B-04 | Provision VPC connector for Redis | See `docs/REDIS_ARCHITECTURE.md` |
| B-05 | Activate monitoring alerts | `bash scripts/setup-monitoring-alerts.sh ogutualex824@gmail.com` |
| B-07 | Store eTIMS credentials + KRA PIN | `bash scripts/setup-secrets.sh` |
| B-08 | Store LOYALTY_HMAC_SECRET | Auto-generated by `setup-secrets.sh` |

> **B-01 CLEARED** — Email infrastructure fully verified 2026-07-12. SPF, DKIM (s1 + s2), DMARC, SendGrid domain auth, HTML+plain delivery, and logo branding all confirmed operational. See §Email System — Full Production Audit below.

---

## Known Limitations (v1.0.0)

1. **Redis VPC connector**: Redis is provisioned but VPC connector is not yet created. Redis-dependent features (rate limiting, caching) fall back gracefully but without the performance benefit.
2. **Pending CF quota**: ~218 CFs across `financial-os.js`, `platform-core.js`, `sub-engine.js`, `messages.js` are awaiting Cloud Run CPU quota increase before deployment.
3. **orders field drift**: The `orders` collection uses both `sellerId` and `sellerUid` field names in different indexes. One index serves no real queries until this is resolved.
4. **sokoni-ops composite queries**: 10 collections (`posCashEvents`, `providerProfiles`, etc.) now have their composite indexes on `sokoni-ops` database. Affected CFs must specify `databaseId: 'sokoni-ops'` — update required before those queries are relied upon in production.
5. **eTIMS live credentials**: eTIMS has 28 CFs deployed but KRA credentials are not yet in Secret Manager. Tax filing is pending.
6. **Email verification + password reset templates**: Firebase Auth SDK handles these client-side. Backend delivery uses the production SendGrid key (verified live 2026-07-12).
7. **Email BIMI / VMC**: SPF, DKIM, and DMARC are now configured and verified. BIMI (brand logo in inbox) requires DMARC at `p=quarantine` (current: `p=none`). Full BIMI with Gmail requires a Verified Mark Certificate (~USD 1,400/yr). See `docs/BIMI_CHECKLIST.md` for the phased rollout timeline. This is a branding enhancement, not a deliverability blocker.

---

## Email System — Full Production Audit (2026-07-12)

> All results verified live. DNS resolved against Google (8.8.8.8) and Cloudflare (1.1.1.1). SendGrid API queried directly. No assumptions.

### Domain Authentication

| Record | Type | Value | Status |
|---|---|---|---|
| SPF | TXT @ `mysokoni.co.ke` | `v=spf1 +a +mx +ip4:46.165.235.143 include:relay.mailbaby.net include:sendgrid.net ~all` | ✅ PASS — both resolvers agree |
| DKIM s1 | CNAME `s1._domainkey.mysokoni.co.ke` | `→ s1.domainkey.u109608575.wl076.sendgrid.net` (TTL 300) | ✅ LIVE — Cloudflare; propagating Google |
| DKIM s2 | CNAME `s2._domainkey.mysokoni.co.ke` | `→ s2.domainkey.u109608575.wl076.sendgrid.net` (TTL 300) | ✅ LIVE — both resolvers |
| DMARC | TXT `_dmarc.mysokoni.co.ke` | `v=DMARC1; p=none; rua=mailto:dmarc@mysokoni.co.ke; ruf=mailto:dmarc@mysokoni.co.ke; fo=1; adkim=s; aspf=s; pct=100` | ✅ PASS — both resolvers agree |
| Return-path | CNAME `em.mysokoni.co.ke` | `→ u109608575.wl076.sendgrid.net` | ✅ LIVE |
| SendGrid API | `GET /v3/whitelabel/domains` | `domain: mysokoni.co.ke, valid: true` | ✅ AUTHENTICATED |

**Note on alignment:** `adkim=s` (strict) — DKIM `d=mysokoni.co.ke` exactly matches `From: hello@mysokoni.co.ke` ✅. `aspf=s` (strict) — if SendGrid MAIL FROM is `em.mysokoni.co.ke`, SPF strict alignment technically fails; however DMARC passes when **either** mechanism passes, and DKIM strict alignment passes. Net DMARC result: **PASS via DKIM**. Recommend relaxing `aspf=r` at next DNS update to eliminate the dependency.

### Delivery Verification

| Item | Result | Evidence |
|---|---|---|
| SENDGRID_API_KEY in Secret Manager | ✅ Confirmed | `firebase functions:secrets:access` → live `SG.*` key |
| SendGrid API key accepted | ✅ Confirmed | HTTP 202 from `api.sendgrid.com/v3/mail/send` |
| HTML email delivered | ✅ Confirmed | Full branded layout; `ogutualex824@gmail.com`; Message-ID `MgF9GQ7HRguGwahu5wOrCg` |
| Plain-text multipart | ✅ Confirmed | `text/plain` included in every send |
| Logo (Sokoni Logo.png v4) | ✅ Transparent PNG-32, 32.9 KB | Calibrated mask (lo=38,hi=50) at 1536×1024; downscaled 480×320; O-holes A≈6; wordmark fully opaque |
| From address | ✅ `SOKONI <hello@mysokoni.co.ke>` | Accepted; domain auth valid |
| Reply-To | ✅ `support@mysokoni.co.ke` | Set on every send |
| Footer & legal links | ✅ Present | Website · Support · Privacy Policy · Terms · Unsubscribe |
| Responsive layout | ✅ Confirmed | `@media (max-width:599px)` collapses to 100% width |
| 53 templates | ✅ All v3.0 | `base()` enterprise redesign — white canvas, CSS brand icon, status/metric/code/alert helpers; dark mode |
| 10 email CFs | ✅ Deployed | All updated to v2.1 branding; running in `us-central1` |
| processEmailQueue CF | ✅ Running | 5-minute Cloud Scheduler; no errors |
| Spam classification | ✅ Not spam | Delivered to primary inbox (Gmail) with DKIM + SPF pass |

### Verdict

**The SOKONI email system is fully production-ready.**

B-01 is cleared. No email blockers remain on the release path.

### Remaining Post-Launch Actions (non-blocking)

| Action | Priority | Owner |
|---|---|---|
| Change `aspf=r` in DMARC (relaxed SPF alignment) | Low | Operator — Cloudflare DNS |
| Enable SendGrid Email Activity Feed add-on | Low | Operator — SendGrid dashboard |
| Register `dmarc@mysokoni.co.ke` in SendGrid inbound-parse | Low | Operator — SendGrid dashboard |
| Escalate DMARC to `p=quarantine` after 30 days of clean reports | Medium | Operator |
| BIMI SVG + DNS record after `p=quarantine` | Low | After DMARC quarantine |
| Google Workspace profile photo for `hello@mysokoni.co.ke` | Low | Operator — admin.google.com |

---

## Deployment Checklist

- [ ] `bash scripts/setup-secrets.sh` — Store all secrets
- [x] `bash scripts/setup-sendgrid.sh` — ✅ SENDGRID_API_KEY live in Secret Manager (verified 2026-07-12)
- [x] Email DNS authentication — ✅ SPF + DKIM (s1+s2) + DMARC + return-path configured and verified (2026-07-12)
- [ ] `bash scripts/setup-monitoring-alerts.sh ogutualex824@gmail.com`
- [ ] `firebase deploy --only firestore:rules` — Deploy hardened rules
- [ ] `firebase deploy --only firestore:indexes` — Deploy indexes (default)
- [ ] `firebase deploy --only firestore:indexes --project sokoni-aeb26 --database sokoni-ops` — Deploy sokoni-ops indexes
- [ ] `firebase deploy --only functions` — Deploy all CFs (after quota approval)
- [ ] `firebase deploy --only hosting` — Deploy frontend
- [ ] Verify all scheduled jobs are active in Cloud Scheduler
- [ ] Create Git tag: `git tag -a v1.0.0 -m "SOKONI v1.0.0 Production Release"`
- [ ] Provision VPC connector for Redis

---

## Migration Notes

### From RC1 → v1.0.0
- No database schema migrations required — Firestore is schemaless
- `sokoni-ops` Firestore database must have its indexes deployed separately
- Service Worker v40 automatically invalidates all v39 caches on client update
- Admin users will be logged out after 20 minutes of inactivity (was 60)
- Virtual POS terminal now returns `status: 'approved'` immediately (was `'sent_to_terminal'`)

### Rollback
See `docs/ROLLBACK_MANIFEST.md`.
