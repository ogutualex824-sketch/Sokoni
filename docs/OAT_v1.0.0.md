# SOKONI v1.0.0 — Operational Acceptance Testing (OAT)

**Final release gate.** Engineering is complete; nothing below is a code task.
**Status: 0 of 8 PASSED. Verdict: NO-GO.**

Related: [[RELEASE_v1.0.0_RC3]] · [[APP_CHECK]] · [[OPERATIONS_GUIDE]]

---

## Why this document exists (read first)

**Every OAT item requires a human.** Real money through M-PESA, a real handset for the OTP, real devices for the PWA, a real screen reader. None can be executed from a terminal, and per the release standard, **terminal output, code inspection and reasoning must not be substituted for operational proof.**

Therefore **no OAT item is marked PASS here, and none may be** until a person performs it and attaches the evidence. This pack exists to make that fast and unambiguous.

> ⚠️ **Freeze in effect.** No feature work, refactoring, tuning, or architectural change. Code changes **only** if an OAT run uncovers a verified defect — in which case: stop, document root cause + impact + evidence, fix, retest.

---

## Status board

| # | Test | Status | Evidence | Owner | Date |
|---|---|---|---|---|---|
| OAT-01 | Money Path (end-to-end) | 🔴 **PENDING** | — | | |
| OAT-02 | Refund | 🔴 **PENDING** | — | | |
| OAT-03 | Payout | 🔴 **PENDING** | — | | |
| OAT-04 | Dispute | 🔴 **PENDING** | — | | |
| OAT-05 | Subscription | 🔴 **PENDING** | — | | |
| OAT-06 | Authentication | 🔴 **PENDING** | — | | |
| OAT-07 | PWA | 🔴 **PENDING** | — | | |
| OAT-08 | Accessibility | 🔴 **PENDING** | — | | |

**GO requires 8/8 PASS with attached real-world evidence.**

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
