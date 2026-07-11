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

## Name-collision analysis (guard-surfaced, 2026-07-11) — CORRECTED

The guard flags 13 ops that are **both a dispatcher handler AND an individual export**. Deeper verification (comparing the actual implementations) proved these are **NOT duplicates** — they are **cross-domain name collisions**: two genuinely different functions in different modules that happen to share a name. **Both implementations are legitimately used**, so **none may be de-exported** (that would break the exported version's callers).

| Op | Dispatcher handler (module) | Individual export (module) | Both used? |
|----|-----------------------------|-----------------------------|-----------|
| `registerWebhook`/`testWebhook`/`deleteWebhook`/`listWebhooks` | pos-integrations (seller POS webhooks) | developer-portal (partner API webhooks) | ✅ yes |
| `createPurchaseOrder` | pos-inventory-pro | procurement (supplier PO) | ✅ yes |
| `getWalletBalance`/`getWalletTransactions`/`refundToWallet` | pos-crm-pro (POS wallet) | wallet (customer wallet) | ✅ yes |
| `currencyGetRates` | pos (POS pricing) | currency-engine | ✅ yes |
| `getAuditLog` | pos | security-audit | ✅ yes |
| `registerDevice` | services | device-manager | ✅ yes |
| `adminGetPendingPayouts` | admin-os | wallet | ✅ yes |
| `adminResolveDispute` | admin-os | disputes | ✅ yes |

**Group A (de-export) is CANCELLED** — there are **zero** true duplicates. Verification caught 3 regressions the earlier POS migration had introduced by routing `partner-portal`/`procurement` clients to the wrong same-named implementation; these were reverted (commit `a6a0b59`).

**Correct remediation (future, careful):** *namespace* the POS/admin-domain dispatcher handlers to domain-unique op names (e.g. `posRegisterWebhook`, `posCreatePurchaseOrder`, `posGetWalletBalance`) so each callable name maps to exactly one business domain — the sprint's "one domain per callable" principle. This requires updating each handler's `_h` key + any client that calls it via the dispatcher. It is **not** a de-export and must not delete the individually-exported functions.

**Guard behaviour:** true duplicates (same module) → hard fail (de-export). Cross-domain collisions (different module) → warning (namespace). ~~Currently: 0 hard failures, 13 namespacing warnings~~ → **RESOLVED 2026-07-12 (commit `8fe29e2`): 0 hard failures, 0 warnings.**

## Collision resolution (2026-07-12, caller-verified)
Every client helper was traced (`.html` + `.js`) before touching anything:

- **8 DEAD handlers removed** from their module `_h` (no client routed them via a dispatcher — all callers use the canonical standalone CF directly): `currencyGetRates` (pos-completeness), `createPurchaseOrder` (pos-inventory-pro), `registerWebhook`/`deleteWebhook`/`listWebhooks`/`testWebhook` (pos-integrations), `getAuditLog` (pos-retail-engine), `registerDevice` (security-identity). Standalone onCall exports + canonical CFs untouched.
- **5 USED handlers namespaced** (distinct impls both legitimately used; renamed the dispatcher `_h` key + updated the exact verified caller, behavior preserved):
  - `getWalletBalance`/`getWalletTransactions`/`refundToWallet` → `posGetWalletBalance`/`posGetWalletTransactions`/`posRefundToWallet` (caller: `pos-crm-pro.html` via smartPosDispatch; `sokoni-wallet.js` stays on the direct wallet CF).
  - `adminGetPendingPayouts`/`adminResolveDispute` → `aosGetPendingPayouts`/`aosResolveDispute` (caller: `sokoni-aos.js` whitelist + `_call` via adminOsDispatch; `super-admin.html`/`trust-safety.html` stay on the direct CFs).

Deployed: smartPosDispatch, adminOsDispatch, servicesDispatch (updated) + providerDispatch (new). **Reversible:** `git revert 8fe29e2` + redeploy the 4 dispatchers. ⏳ Money/admin dispatch paths (POS wallet, admin payouts/disputes) should get an authenticated-device smoke test.

New dispatcher: **`providerDispatch`** → `provider-onboarding` (18 ops, 1 Cloud Run service).

Related: [[ORPHAN_RECLAMATION_CAMPAIGN]] · [[SETTLEMENT_DISPATCHER_CONSOLIDATION]]
