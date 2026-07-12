# SOKONI v1.0.0 — Operational Acceptance Testing (OAT)

**Final release gate (RC4).** Engineering is complete; nothing below is a code task.
**Status: 0 of 12 PASSED. Verdict: NO-GO.**

Related: [[RELEASE_v1.0.0_RC3]] · [[APP_CHECK]] · [[OPERATIONS_GUIDE]]

---

## Why this document exists (read first)

**Every OAT item requires a human.** Real money through M-PESA, a real handset for the OTP, real devices for the PWA, a real screen reader. None can be executed from a terminal, and per the release standard, **terminal output, code inspection and reasoning must not be substituted for operational proof.**

Therefore **no OAT item is marked PASS here, and none may be** until a person performs it and attaches the evidence. This pack exists to make that fast and unambiguous.

> ⚠️ **Freeze in effect.** No feature work, refactoring, tuning, or architectural change. Code changes **only** if an OAT run uncovers a verified defect — in which case: stop, document root cause + impact + evidence, fix, retest.

---

## Status board

**RC4 — extended to 12 tests.**

| # | Test | Status | Evidence | Owner | Date |
|---|---|---|---|---|---|
| OAT-01 | Money Path (end-to-end) | 🔴 **PENDING** | — | | |
| OAT-02 | Refund | 🔴 **PENDING** | — | | |
| OAT-03 | Payout | 🔴 **PENDING** | — | | |
| OAT-04 | Dispute | 🔴 **PENDING** | — | | |
| OAT-05 | Subscription | 🔴 **PENDING** | — | | |
| OAT-06 | Authentication | 🔴 **PENDING** | — | | |
| OAT-07 | PWA | 🔴 **PENDING** | — | | |
| OAT-08 | Responsive UI | 🔴 **PENDING** | — | | |
| OAT-09 | Accessibility | 🔴 **PENDING** | — | | |
| OAT-10 | Operations (alerts · backup · **restore drill**) | 🔴 **PENDING** | — | | |
| OAT-11 | Marketplace onboarding (merchant → SmartPOS Ready) | 🔴 **PENDING** | — | | |
| OAT-12 | Email inbox delivery | 🔴 **PENDING** | — | | |

**GO requires 12/12 PASS with attached real-world evidence.**
**Current: 0 / 12.**

> ⚠️ **Release Manager note (RM-01):** the working tree currently has **204 uncommitted files**. **A release tag cannot be cut and a Deployment Manifest cannot be issued from an unreproducible build.** The operator must commit or revert before OAT evidence is bound to a build. *(RC4 blocker — independent of OAT.)*

---

## Evidence standard (applies to every test)

A test is PASS only when **all** of the following are attached:

1. **Screenshots** at each numbered step.
2. **Transaction / document IDs** — real, copy-pasteable.
3. **Firestore documents** — the actual written docs (screenshot or JSON export).
4. **Cloud Logs** — the Cloud Function execution entries for the run.
5. **A stated expected-vs-actual** for each assertion.

Anything unattached is **not evidence**. A green screen in the UI is not proof the ledger is correct.

---

## OAT-01 — Money Path (the single largest unverified risk)

**This has never been verified. It is the biggest unknown in the release.**

### Steps
1. **Merchant login** — real merchant account.
2. **Create order** → record `orders/{orderId}`.
3. **Customer payment** → initiate checkout.
4. **STK push** → confirm the prompt reaches the real handset.
5. **PIN entry** → complete on the phone.
6. **Payment success** → record the M-PESA/IntaSend receipt number.
7. **Receipt** → confirm it renders and matches the amount to the cent.
8. **Wallet** → `walletTransactions` entry appears.
9. **Settlement** → `settlements` entry appears.
10. **Merchant dashboard** → the sale appears with the correct net amount.

### Evidence to capture
- `orders/{orderId}`, `payments/{paymentId}`, `walletTransactions/{id}`, `settlements/{id}`
- M-PESA receipt number + the amount **in cents**
- Cloud Logs for the payment CF and the webhook handler
- Screenshots of receipt, wallet, merchant dashboard

### PASS criteria — assert explicitly
- [ ] Amount charged **exactly** equals the order total (no rounding drift).
- [ ] Commission / platform fee matches the configured rate.
- [ ] Merchant net = gross − fees, and the dashboard agrees with `settlements`.
- [ ] **Exactly one** `payments` document. No duplicates.
- [ ] Money is attributed to the **correct merchant**.

### ⚠️ Deliberately exercise the unhappy paths — these are where money is lost
- [ ] **Cancel the STK prompt** → order must NOT be marked paid; no wallet/settlement entry.
- [ ] **Wrong PIN** → clean failure, no partial write.
- [ ] **Pay, then kill the app before the webhook lands** → the webhook must still settle it correctly.
- [ ] **Double-submit checkout** (tap Pay twice) → **exactly one** charge. The idempotency key (`finos.js`) is the guard; prove it holds under a real double-tap, not in theory.

---

## OAT-02 — Refund

### Steps
Refund → wallet credit → ledger → customer notification.

### Evidence
`refunds/{id}`, `walletTransactions/{id}`, `ledgerEntries` query for the order, notification screenshot, Cloud Logs.

### PASS criteria
- [ ] **Exactly one ledger entry.** Query `ledgerEntries` for the order and count. Not "looks right" — count it.
- [ ] Wallet credit equals the refunded amount exactly.
- [ ] Customer notification received.
- [ ] **Re-submit the same refund** → must NOT double-credit. This is the assertion that matters most.

---

## OAT-03 — Payout

### Steps
Pending payout → approval → settlement → merchant confirmation.

### Evidence
`payouts/{id}` before and after approval, `settlements/{id}`, Cloud Logs for the payout CF, merchant confirmation.

### PASS criteria
- [ ] **No duplicate payouts.** Approve once; query `payouts` for the merchant and confirm a single settled record.
- [ ] **Double-click Approve** → still exactly one payout. (A duplicate-payout guard exists in `finos.processPendingPayouts` — prove it under a real double-click.)
- [ ] Payout amount reconciles against `settlements`.
- [ ] Funds reach the merchant's real account.

---

## OAT-04 — Dispute

### Steps
Create dispute → resolve → verify audit trail.

### Evidence
`disputes/{id}` through each state, the audit-trail documents, Cloud Logs.

### PASS criteria
- [ ] Every state transition is recorded with actor + server timestamp.
- [ ] The audit trail is **immutable** — attempt an edit as a non-admin and confirm it is rejected.
- [ ] Resolution moves money correctly (if applicable) and only once.

---

## OAT-05 — Subscription

### Steps
Purchase → activation → renewal → feature unlock.

### Evidence
`sasosSubscriptions/{uid}`, billing ledger entry, Cloud Logs for the renewal job.

### PASS criteria
- [ ] Purchase activates the correct product and tier.
- [ ] The gated feature actually unlocks (test the gate, not the flag).
- [ ] Renewal charges **once**.
- [ ] Cancellation stops billing and revokes access at period end.

> Note: `sasosProcessRenewals` and `sasosExpireTrials` were failing until 2026-07-12 (missing indexes, now fixed and green). **Subscription renewals have never run successfully in production** — this test carries more risk than its size suggests.

---

## OAT-06 — Authentication

Automated verification is complete (Email/Password, password reset, email verification — all pass; App Check 200, zero 403s). **These remaining items are human-only.**

- [ ] **Production App Check** — open `https://mysokoni.co.ke/login.html` → DevTools → Network → filter `firebaseappcheck` → confirm `exchangeRecaptchaV3Token` returns **200**. Repeat on `https://sokoni-aeb26.web.app`. *(Not automatable — reCAPTCHA v3 scores bots below the 0.5 `minValidScore`, so automated results are noise in both directions.)*
- [ ] Real **Google sign-in**
- [ ] Real **SMS OTP** received and login completed
- [ ] **Account linking** — Google onto an existing password account
- [ ] **Merchant** login · [ ] **Provider** login · [ ] **Driver** login · [ ] **Admin** login

> ⚠️ 40 compat pages shipped with a **dead auth gate** until `48ed2a2` (they called `firebase.auth()` before any Firebase app existed). Click through several — `messages.html`, `financial-os.html`, `chat.html` — while signed in. That surface has had almost no real-browser exercise.

---

## OAT-07 — PWA

- [ ] **Android** — install, launch, use
- [ ] **iPhone** — install, launch, use *(iOS handles PWAs differently; auth popups behave differently here — `auth.js` deliberately uses redirect on iOS/standalone)*
- [ ] **Tablet** — layout holds
- [ ] **Offline** — load offline, queued actions behave sanely
- [ ] **Install** prompt appears and works
- [ ] **Update** — a new service-worker version activates without the stale-cache trap
- [ ] **Push notifications** — received on a real device

Evidence: screenshots/screen-recording per device, device + OS version.

---

## OAT-08 — Accessibility

**Never audited. Deliberately unscored — do not invent a score.**

- [ ] **Keyboard only** — complete a purchase without a mouse
- [ ] **Screen reader** — VoiceOver or NVDA through login + checkout
- [ ] **Zoom 200%** — no loss of content or function
- [ ] **Contrast** — meets WCAG AA
- [ ] **Labels** — every input has an accessible name
- [ ] **Focus** — visible focus, no traps

Evidence: recording, tool output (axe / Lighthouse), list of violations.

---

## Failure protocol

If any test fails: **stop.** Do not work around it. Document:

1. **Root cause** — proven, not suspected.
2. **Impact** — who/what is affected, and is money at risk.
3. **Evidence** — logs, docs, IDs.
4. **Fix** — minimal, no redesign.
5. **Retest** — re-run the full test, not just the failing step.

---

## Known issues carried into the gate (not blockers)

- **EPRA fuel prices are STATIC.** EPRA restructured their site; the scraper URLs 404. The job no longer fails, but prices will not update until the URLs are re-pointed.
- **`firestore.rules` has not been security-reviewed** (H5, carried since RC1).
- **A Cloud Monitoring alert has never been observed firing.** Channels are attached and the delivery path works; no real alert has fired end-to-end.

---

## Release artifacts — NOT YET PRODUCED

The Release Certificate, Production Readiness Certificate, Deployment Manifest, Rollback Manifest, Operations Handbook, Support Handbook, Known Issues and v1.1 Roadmap will be produced **only after 8/8 OAT items pass with attached evidence.** Producing them now would assert a level of verification that does not exist.

---

# GO / NO-GO

# 🔴 **NO-GO**

**0 of 8 OAT items have been executed.** Infrastructure is green and every engineering blocker is closed — but the money path has never moved a real shilling, no OTP has reached a real phone, and no screen reader has touched the product.

**GO is granted only when 8/8 pass with real-world evidence attached.**

---

## OAT-08 — Responsive UI

**Prerequisites:** real devices (or Chrome DevTools device emulation for the initial sweep, **but at least one real Android + one real iPhone** for sign-off).

**Breakpoints (all mandatory):** 320 · 360 · 375 · 390 · 414 · 768 · 1024 · 1440 px

**Pages that MUST be checked (the money + onboarding paths):**
`index` · `category` · `product` · `cart` · `checkout` · `wallet` · `pos-setup` · `pos` · `onboarding` · `provider-onboarding` · `admin-os` · `legal-centre`

**PASS criteria — assert explicitly:**
- [ ] **No horizontal overflow** at any breakpoint (`document.body.scrollWidth <= window.innerWidth`)
- [ ] **No clipped content** (text truncated by overflow, not by design)
- [ ] **No hidden controls** — every primary CTA reachable without zoom
- [ ] **No broken navigation** — bottom-nav / header usable at 320 px
- [ ] **No layout shift** on load (CLS)

**Evidence:** screenshot **per page per breakpoint**, or a single scripted screenshot matrix. Note the device + browser.

**FAIL handling:** capture page + breakpoint + screenshot; file under Known Issues; fix only that page.

---

## OAT-10 — Operations

**This is the CB-05 checklist. Execute `CB05_MONITORING_CHECKLIST.md` in full.**

| Item | PASS criteria | Evidence |
|---|---|---|
| Notification channel | Verified + **test notification received** | Screenshot of the received message |
| Alert policies | Payments · auth · scheduler · quota · error-rate · ledger anomaly — exist, enabled, wired to a verified channel | Policy list |
| **LIVE ALERT TEST** | **A real alert fires AND the notification is received** | **Incident + notification screenshot** |
| Cloud Logging | Logs queryable; payment logs present | Query screenshot |
| Backup | PITR/scheduled backup enabled; a backup <24 h old exists | Backup listing |
| **RESTORE DRILL** | **Restore to a scratch DB completed; data spot-checked** | **Restore job ID + RTO/RPO** |
| Scheduler | All **158** scheduled jobs enabled; none failing silently | Scheduler listing |

> **Configuration is not evidence — delivery is.** An alert that has never fired is not an alert. **An untested backup is a hypothesis, not a backup.**
> ⚠️ **Do NOT trip a payment alert to test.** Use a non-financial function.

**PASS criteria:** live alert **received** + restore drill **completed with RTO/RPO recorded**.

---

## OAT-11 — Marketplace Onboarding (merchant → SmartPOS Ready)

**Prerequisites:** a **fresh** account (never onboarded). Real device.

**Flow:** Buyer onboarding · Merchant onboarding · Provider onboarding · Driver onboarding — then the merchant path end-to-end:

Business creation → **Merchant ID auto-generated** → QR generated → Subscription activated → Branch created → Tax configured → Staff created → Product import → POS setup → **Guided test sale** → **SmartPOS Ready**

**PASS criteria — assert explicitly:**
- [ ] A first-time user is **never asked for a Merchant ID** (it is generated: `SOK-XXXXXX`)
- [ ] QR pairing code generated and scannable
- [ ] Subscription activates and **enforces the correct tier/commission**
- [ ] **Legal gate blocks progress until agreements are accepted** (`SokoniLegalGate`)
- [ ] Guided test sale completes → **"Production Ready"** state reached
- [ ] Resume works: kill the app mid-flow, reopen → **resumes at the correct step**
- [ ] Provider onboarding completes end-to-end (draft → subscription → **publish**) ← *this path was broken (C2) and fixed; it has never been run by a human*

**Evidence:** screenshots per step · generated Merchant ID · Firestore docs (`businesses/{merchantId}`, `providerProfiles/{uid}`) · legal acceptance record.

---

## OAT-12 — Email Inbox Delivery

**This is CB-03. API-key validity is NOT delivery.**

**Send each flow to real inboxes on Gmail · Outlook · Apple Mail · Yahoo:**

| # | Email | PASS criteria |
|---|---|---|
| 1 | Email verification | Delivered to **inbox** (not spam); link works |
| 2 | Password reset | Delivered; link resets the password |
| 3 | Welcome | Delivered |
| 4 | Receipt | Delivered; amounts correct |
| 5 | Refund | Delivered |
| 6 | Merchant notification | Delivered |
| 7 | Provider notification | Delivered |

**For every email also assert:**
- [ ] **Logo renders** (hosted over stable HTTPS — not blocked by the client)
- [ ] **HTML** version renders correctly on **mobile and desktop**
- [ ] **Plain-text** alternative present
- [ ] Footer: company details · support · privacy · terms
- [ ] **SPF · DKIM · DMARC all PASS** in the received message headers *(check "Show original" in Gmail)*
- [ ] **Not in spam** on any of the four providers

**Evidence:** **inbox screenshot per email per provider** + the raw header block showing `spf=pass dkim=pass dmarc=pass` + SendGrid Activity/Event export.

**FAIL handling:** a bounce, spam-folder placement, or a failing auth check is a **FAIL**. Capture the header block and SendGrid event.

---

## Sign-off

| Field | Value |
|---|---|
| Release | v1.0.0 (RC4) |
| Tests passed | **0 / 12** |
| Verdict | 🔴 **NO-GO** |
| Blocking | All 12 OAT items + **RM-01** (204 uncommitted files → build not reproducible) |

**The Production Release Certificate cannot be issued until 12/12 PASS with attached real-world evidence AND the build is reproducible.**
