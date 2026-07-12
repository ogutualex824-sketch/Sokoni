# CF-to-CF Chaining Audit — B-15

**Date:** 2026-07-12
**Auditor:** SOKONI AI Engineering Team
**Scope:** All `functions/*.js` deployed Cloud Function files
**Status:** COMPLETE — CLEAN

---

## Executive Summary

A full scan of all ~230 deployed Cloud Function source files for CF-to-CF HTTP calls found **zero production CF-to-CF chains**. The api-gateway.js fix applied in the Go-Live Sprint v40 was the only instance of this anti-pattern; it has already been eliminated. The codebase is clean.

---

## Scan Methodology

Searched all `functions/*.js` files (excluding `functions/node_modules/`) for the following patterns:

| Pattern | Tool | Purpose |
|---|---|---|
| `cloudfunctions.net` in any string | Grep | CF URL in code |
| `run.app` in any string | Grep | Cloud Run URL |
| `europe-west1.*sokoni` or `sokoni-aeb26` in fetch/request calls | Grep | Project-specific CF URLs |
| `axios.get/post` to CF URLs | Grep | Axios CF calls |
| `https.request` / `http.request` hostnames | Grep | All outbound HTTPS |
| `functions.httpsCallable(` | Grep | Client SDK in CF (always wrong) |
| `require('firebase/functions')` | Grep | Client SDK import |
| `CF_BASE`, `CF_URL`, `FUNCTION_URL` constants | Grep | Hardcoded CF base URLs |
| `process.env.FUNCTION_URL` | Grep | Env var CF URLs |
| `fetch(` with URL analysis | Manual review | All fetch targets |

---

## Findings — Deployed Cloud Functions

### FINDING 1: `functions/index.js` — Daraja Callback Registration
**Lines:** 2796, 3169
**Disposition:** NOT a CF-to-CF chain

```js
const callbackUrl = "https://us-central1-sokoni-aeb26.cloudfunctions.net/darajaSTKCallback";
// ...
CallBackURL: callbackUrl,  // passed TO Safaricom's API
```

This string is sent to Safaricom's Daraja API as a webhook registration parameter. Safaricom's servers call this URL when an M-Pesa payment completes. Our code never makes an HTTP request to it directly. This is the standard M-Pesa integration pattern and is correct.

**Action required:** None.

---

### FINDING 2: `functions/email-dmarc.js` — Setup Comment
**Line:** 256
**Disposition:** Comment only — NOT a runtime call

```
// URL: https://us-central1-sokoni-aeb26.cloudfunctions.net/dmarcReportWebhook
```

This is a code comment explaining how to configure SendGrid's Inbound Parse to route DMARC reports to our CF. There is no runtime HTTP call.

**Action required:** None.

---

### FINDING 3: `functions/email-triggers.js` — Setup Comment
**Line:** 741
**Disposition:** Comment only — NOT a runtime call

```
// Register: https://us-central1-sokoni-aeb26.cloudfunctions.net/emailWebhook
```

Configuration documentation comment for SendGrid Event Webhook registration. Not a runtime call.

**Action required:** None.

---

### FINDING 4: `functions/pos-integrations-api.js` — OpenAPI Spec Metadata
**Line:** 570
**Disposition:** OpenAPI documentation string — NOT a runtime call

```js
servers: [{ url: 'https://us-central1-sokoni-aeb26.cloudfunctions.net', description: 'Production' }],
```

This is a static string embedded in an OpenAPI 3.0 specification object returned to callers who request the API schema. No HTTP request is made to this URL at runtime.

**Action required:** None.

---

### FINDING 5: `functions/security-pentest.js` — Firestore REST API
**Lines:** 64–68
**Disposition:** Calls Firestore REST API — NOT a CF call

```js
const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/...`;
const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
```

Security pentest function probing Firestore's public read rules. Calls Google's Firestore REST API, not another Cloud Function.

**Action required:** None.

---

### FINDING 6: `functions/index.js` — GCP Metadata + Firestore Admin REST
**Lines:** 7446–7466
**Disposition:** GCP internal metadata server + Firestore Admin API — NOT CF calls

```js
await fetch("http://metadata.google.internal/...")  // GCP metadata server
await fetch("https://firestore.googleapis.com/...")  // Firestore Admin API
```

Used in the automated Firestore backup function. Calls GCP infrastructure endpoints, not Cloud Functions.

**Action required:** None.

---

## All https.request() Targets in Deployed Functions

| File | Target Hostname | Purpose |
|---|---|---|
| `foundation.js` | `payment.intasend.com` / `sandbox.intasend.com` | M-Pesa STK push |
| `foundation.js` | `api.sendgrid.com` | Donation receipt email |
| `payment-adapters.js` | `payment.intasend.com` / `sandbox.intasend.com` | Payment processing |
| `sub-engine.js` | `payment.intasend.com` / `sandbox.intasend.com` | Subscription billing |
| `async-job-handlers.js` | Dynamic (generic HTTPS helper) | Job handler payload delivery |
| `wap.js` | User-configured webhook URL | WAP workflow webhooks |
| `webhook-engine.js` | User-registered webhook URL | Platform webhook delivery |
| `developer-portal.js` | User-registered webhook URL | Developer webhook testing |
| `inventory-webhooks.js` | User-registered webhook URL | Inventory event delivery |
| `etims.js` | `timrc.kra.go.ke` (ETIMS_BASE) | KRA eTIMS tax submission |
| `hub-etims.js` | `timrc.kra.go.ke` (ETIMS_HOST) | Hub eTIMS submission |
| `inventory-import.js` | `api.anthropic.com` | AI-powered inventory import |
| `inventory-pricing.js` | `api.anthropic.com` | AI pricing suggestions |
| `inventory-simulate.js` | `api.anthropic.com` | AI simulation |
| `inventory-ai.js` | `api.anthropic.com` | AI inventory assistant |
| `algolia-indexer.js` | `*.algolia.net` | Algolia search index |
| `reliability-engine.js` | `api.anthropic.com` | Health check ping |
| `search-health.js` | `{appId}-dsn.algolia.net` | Algolia health probe |

**Zero occurrences of `cloudfunctions.net` or `run.app` as http.request hostname in any deployed function file.**

---

## All fetch() Targets in Deployed Functions

| File | Target | Purpose |
|---|---|---|
| `automation-engine.js` | `api.anthropic.com` | AI dispute resolution |
| `business-health-score.js` | `api.anthropic.com` | AI health scoring |
| `conversion-analytics.js` | `{appId}-dsn.algolia.net` | Algolia health check |
| `finos-utils.js` | `payment.intasend.com` | M-Pesa B2C payout |
| `finos-automation.js` | `api.intasend.com` | Reconciliation check |
| `finos-automation.js` | `api.anthropic.com` | AI forecast |
| `index.js` | `payment.intasend.com` | IntaSend verify |
| `index.js` | `api.safaricom.co.ke` | Daraja OAuth token |
| `index.js` | `api.safaricom.co.ke` | Daraja STK push |
| `index.js` | `payment.intasend.com` | B2C send money |
| `index.js` | `metadata.google.internal` | GCP metadata token |
| `index.js` | `firestore.googleapis.com` | Firestore export |
| `index.js` | EPRA website URLs | Fuel price scrape |
| `loyalty-enterprise.js` | `api.anthropic.com` | AI personalization |
| `merchant-success.js` | `api.anthropic.com` | AI merchant coach |
| `navigation.js` | `api.africastalking.com` | SMS dispatch |
| `payment-trust.js` | `api.sendgrid.com` | Trust receipt email |
| `pos-ai-assistant.js` | `api.anthropic.com` | POS AI assistant |
| `pos-integrations.js` | `wh.url` (user config) | POS webhook delivery |
| `pos-integrations-api.js` | `wh.url` (user config) | POS webhook delivery |
| `pos-retail-engine.js` | `api.sendgrid.com` | POS receipt email |
| `redis-jobs.js` | `api.sendgrid.com` | Background email |
| `redis-jobs.js` | `api.anthropic.com` | Background AI job |
| `retention.js` | `api.sendgrid.com` | Retention email |
| `scheduled-reports.js` | `api.sendgrid.com` | Scheduled report email |
| `security-pentest.js` | `firestore.googleapis.com` | Auth probe |
| `sokoni-at.js` | `api.africastalking.com` | SMS |
| `system-health.js` | `{appId}-dsn.algolia.net` | Algolia health check |

**Zero occurrences of `cloudfunctions.net` or `run.app` as fetch URL in any deployed function file.**

---

## Script Files (Not Deployed CFs)

These files live in `functions/scripts/` and run locally as developer tools. They are excluded from the production audit but documented here for completeness.

| File | Calls CF URL | Purpose |
|---|---|---|
| `scripts/test-email.js` | `us-central1-sokoni-aeb26.cloudfunctions.net/testEmailDelivery` | Developer test harness |
| `scripts/typesense-setup.js` | `CF_BASE = https://us-central1-sokoni-aeb26.cloudfunctions.net` | Backfill script calling Typesense sync CFs |
| `scripts/algolia-backfill.js` | `firestore.googleapis.com`, `{APP_ID}-1.algolianet.com` | Algolia index backfill (no CF call) |
| `scripts/algolia-setup.js` | `{APP_ID}-dsn.algolia.net` | Algolia setup (no CF call) |

The scripts calling CF URLs (`test-email.js`, `typesense-setup.js`) are developer utilities. They authenticate as an admin user before calling. These are the expected way to invoke CFs from external tooling and are not a billing concern.

---

## Previously Fixed — api-gateway.js (B-15 Trigger)

Prior to the Go-Live Sprint v40, `functions/api-gateway.js` contained a route handler that proxied to other CFs via HTTP, creating double-billing on every API call. This was fixed by:

- Removing all HTTP proxy logic
- Implementing inline `_handleSearch()` and `_handleCreateOrder()` handlers
- Adding inline products query
- Documenting the pattern in a code comment: "no outbound CF-to-CF HTTP calls"

**Chains eliminated:** 3 (search proxy, order proxy, products proxy)

---

## Metrics

| Metric | Count |
|---|---|
| Deployed CF files scanned | ~230 |
| CF-to-CF chains found in deployed functions | **0** |
| CF-to-CF chains eliminated (api-gateway fix, B-15) | **3** |
| Script-only CF calls (dev tools, not production) | 2 scripts |
| External API call patterns verified as safe | 32 |

---

## Cost Impact

The 3 chains eliminated in api-gateway.js (B-15) were the only billing concern. With 0 additional chains found:

| Item | Calculation | Estimate |
|---|---|---|
| api-gateway proxied routes eliminated | 3 double-invocations per gateway request | Varies by traffic |
| Additional chains found in this scan | 0 | $0 additional savings |
| Rate: $0.40 / million invocations | — | — |

At 1 million API gateway calls/month, the B-15 fix alone saves ~3 million excess invocations = ~$1.20/month at minimum, scaling proportionally with traffic.

---

## Disposition

| Category | Count | Status |
|---|---|---|
| True CF-to-CF HTTP chains (deployed) | 0 | Nothing to fix |
| Callback URL registrations (outbound, correct) | 2 | Correct — Safaricom integration |
| Comment/doc URL references | 3 | Correct — documentation only |
| External API calls | 32 | Correct — third-party services |
| Webhook delivery (user-configured URLs) | 5 files | Correct — platform feature |
| Script-only CF calls | 2 | Out of scope — dev tools |

**Overall verdict:** The SOKONI Cloud Functions codebase is free of CF-to-CF HTTP chaining in production code. The single known case (api-gateway.js) was already resolved in B-15.

---

*Generated by: SOKONI AI Engineering Team — 2026-07-12*
