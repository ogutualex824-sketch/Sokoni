# SOKONI Dispatcher Registry & API Inventory

**Status:** canonical · enforced by `scripts/verify-architecture.js`
**Date:** 2026-07-11 · **Principle:** every callable API routes through a domain dispatcher — one Cloud Run service per domain, not per operation.

> **Quota impact:** ~559 callable operations are served by **13 dispatchers** instead of 559 individual Cloud Run services — **~546 services saved**. This is the platform's primary Cloud-Run-quota strategy and must be preserved (no op may be both dispatched and individually exported).

---

## Dispatcher registry (domain ownership)

| Dispatcher | Ops | Domain | Handler-source modules | Client wrapper |
|------------|----:|--------|------------------------|----------------|
| `smartPosDispatch` | 156 | SmartPOS / retail / inventory / accounting | pos-crm-pro, pos-completeness, pos-staff-ops, pos-inventory-pro, pos-accounting, pos-retail-engine, pos-integrations, pos-hq | `_cf`/`_callCF` per page |
| `commerceDispatch` | 75 | Marketplace ext, merchant success, foundation, marketing | marketplace-extensions, merchant-success, foundation, marketing-engine | page `_cf` helpers |
| `servicesDispatch` | 50 | Healthcare, security-identity, jobs, HR-payroll, B2B, property | healthcare-hub, security-identity, jobs, hr-payroll, b2b-wholesale, property-hub | domain pages |
| `financeSprintDispatch` | 49 | Finance OS + **Enterprise Settlement (12)** | finance-os-sprint43 + settlement-dispatch | `_cf`, `sokoni-settlement.js` |
| `bookingDispatch` | 45 | Bookings, venues, availability | booking, venue-booking, availability | booking pages |
| `adminOsDispatch` | 41 | Admin console | admin-os | `sokoni-aos.js` |
| `loyaltyDispatch` | 40 | Loyalty, rewards, gift cards | loyalty, loyalty-enterprise | `sokoni-loyalty.js` |
| `analyticsDispatch` | 33 | Analytics engine | analytics-engine | analytics pages |
| `logisticsPlusDispatch` | 30 | Logistics+ | logistics-plus | logistics pages |
| `redisDispatch` | 28 | Redis cache / session / presence / locks | redis-layer (inline `_H`) | `sokoni-redis.js` |
| `messagesDispatch` | 12 | Conversations, chat policy | messages | messaging pages |
| `navDispatchRider`, `respondToDispatch`, `dispatchDelivery` | — | Delivery / rider dispatch (domain-specific) | dispatch/navigation modules | rider/nav pages |

**All 13 are deployed and live** (verified 2026-07-11).

---

## Dispatcher contract (every dispatcher must)

1. **Route** on `req.data.op` to a handler in its merged `_h` registry.
2. **Validate** the op exists (`invalid-argument` / `not-found` with the valid-op list).
3. **Enforce permissions** inside each handler (admin/App Check unchanged by consolidation).
4. **Handle errors** consistently (`HttpsError`).
5. **Produce audit logs** where the handler mutates state.
6. **Return standardized** `{data}` responses (identical to the pre-consolidation individual CF).
7. Bind the **widest superset of secrets** any handler needs; set memory/timeout to the domain max.

## Invariants (enforced by `scripts/verify-architecture.js`)

- **No duplicate exports** in `index.js`.
- **No op is both dispatched AND individually exported** (that doubles a Cloud Run service — the core quota rule).
- **Every registry dispatcher is exported.**
- **CF export count within budget** (warn 1350, hard 1480 — early warning before the ~1500 vCPU ceiling this project hit).

## What is NOT consolidated (by design)

- **Firestore triggers** (`emailOn*`, `searchSync_*_onCreate/Update/Delete`) — event-driven, cannot be dispatched; each is its own function.
- **Scheduled jobs** (`onSchedule`) — e.g. `processPendingPayouts`, redis presence/queue workers.
- **Webhooks** (`onRequest`) — gateway/DMARC/email inbound endpoints.

These are legitimately individual and are excluded from the dispatcher model.

## Open architecture debt (guard-surfaced, 2026-07-11)

13 ops are currently **both dispatched and individually exported** (wasted services) — to be resolved by removing the individual `index.js` export (keeping the dispatcher handler) once each op's clients are confirmed on the dispatcher:
`adminGetPendingPayouts`, `adminResolveDispute` (admin); `registerDevice` (services); `getWalletBalance`, `refundToWallet`, `getWalletTransactions`, `currencyGetRates`, `createPurchaseOrder`, `getAuditLog`, `registerWebhook`, `deleteWebhook`, `listWebhooks`, `testWebhook` (smartPos).

Related: [[ORPHAN_RECLAMATION_CAMPAIGN]] · [[SETTLEMENT_DISPATCHER_CONSOLIDATION]]
