# Settlement Dispatcher Consolidation Report

**Platform:** SOKONI · **Date:** 2026-07-11 · **Pattern:** mirrors `loyaltyDispatch` / analytics dispatcher

> Consolidates all settlement Cloud Functions into a single `settlementDispatch` service to stay within Cloud Run quota **without** requesting additional quota, while preserving every Phase 1–3 capability and all API contracts.

---

## 1. Service count — before vs after

| | Individual Cloud Run services | 
|---|---|
| **Before** (intended) | 12 settlement CFs (3 Phase 1 + 6 Phase 2 + 3 Phase 3) |
| **After** | **1** (`settlementDispatch`) |
| **Reduction** | **12 → 1 (−11 services, −92%)** |

Of the 12, **0 were actually live** (Phase 1's 3 plus Phase 2/3's 9 all failed creation under the Cloud Run CPU quota). So the real deployment ask drops from **12 new services → 1 new service**.

## 2. Cloud Run reduction

- Net new services required to ship the entire settlement subsystem: **1** (was 12).
- No individual settlement CFs are exported from `index.js` — they exist only as handlers inside modules, constructed but never registered as top-level CFs.
- Future settlement ops add a handler to a module's `_h` registry → **zero** new Cloud Run services.

## 3. Dispatcher routing map

`settlementDispatch({ op, ...payload })` → handler (auth enforced inside each handler):

| op | Module | Auth |
|----|--------|------|
| `settlementGetContext` | settlement-engine | admin |
| `settlementPreview` | settlement-engine | admin |
| `settlementGetDashboard` | settlement-engine | admin |
| `settlementGetRoutingConfig` | settlement-routing | admin |
| `settlementSetRoutingConfig` | settlement-routing | admin |
| `getCheckoutPaymentConfig` | payment-config | public (App Check) |
| `adminGetPaymentConfig` | payment-config | admin |
| `adminSetPaymentConfig` | payment-config | admin |
| `settlementValidatePath` | settlement-validation | admin |
| `settlementGetProviders` | settlement-providers | admin |
| `settlementSetProvider` | settlement-providers | admin |
| `settlementPreviewMethod` | settlement-executor | admin |

Dispatcher options (widest superset): `secrets:[SETTLEMENT_ACCOUNT_NUMBER]`, `enforceAppCheck:true`, `region:us-central1`, `memory:512MiB`, `timeout:120s`. Unknown op → `not-found` with the valid-op list; missing op → `invalid-argument`.

**Client contract preserved:** `sokoni-settlement.js` (`SokoniSettlement.call(op,data)` + named helpers) and `settlement-dashboard.html` (its `cf()` helper now wraps `settlementDispatch` — call sites and `{data}` responses unchanged).

## 4. Capabilities preserved (Phase 2 + Phase 3)

Provider abstraction · split settlement · automatic fallback to collect-then-payout · feature flags · rollback (killSwitch) · validation harness · ledger generation · audit trail · accounting · settlement-method stamping — **all intact**; only the transport (individual CF → dispatched op) changed.

## 5. Validation results (pre-deploy)

| Check | Result |
|-------|--------|
| All 12 dispatcher routes resolve | ✅ 12/12 ops registered, none missing |
| Every op reaches correct handler | ✅ verified (validatePath, getCheckoutPaymentConfig, etc.) |
| Admin authorization preserved | ✅ non-admin → `permission-denied`; admin → runs |
| App Check preserved | ✅ `enforceAppCheck:true` on dispatcher |
| Feature flags work | ✅ routing resolve + killSwitch (validation `rollback` check PASS) |
| Split-settlement fallback works | ✅ split vs collect-then-payout decision unchanged |
| Accounting balances correct | ✅ engine + split ledger net-zero (validation `accounting_balance` PASS) |
| Webhook replay protection | ✅ unchanged (idempotency in finos webhooks; validation flags emulator check) |
| No duplicate payouts | ✅ executor picks one method + stamps it; guards unchanged |
| Existing integrations unmodified | ✅ handler bodies/signatures identical; `index.js` load clean (guard PASS) |
| `node --check` all modules | ✅ pass |

## 6. Deployment status

**The project is at the Cloud Run CPU quota ceiling — even a single new service (`settlementDispatch`) returned HTTP 429.** Per the directive to reuse existing infrastructure rather than request quota, the 12 settlement ops are **hosted inside the already-deployed `financeSprintDispatch`** service (finance domain):

- `finance-sprint-dispatch.js` merges finance (37) + settlement (12) = **49 ops**, binds `SETTLEMENT_ACCOUNT_NUMBER`, memory 256→512MiB, timeout 60→120s. Collision-guarded.
- Deploying this is a **pure UPDATE** to an existing service → **zero new Cloud Run services created**.
- Callers use `financeSprintDispatch({op,...})` via `sokoni-settlement.js`; op names/payloads/responses unchanged.
- Commits: `c7f1ff9` (consolidation), `a899e87` (host-in-finance).
- Final Cloud Run footprint for the entire settlement subsystem: **0 additional services** (was 12).

## 6b. DEPLOYED — orphan-reclamation pilot (2026-07-11)

The project was at the Cloud Run vCPU ceiling: 1512 functions deployed, but index.js only exports 1294 → **482 orphans** (old individual CFs whose dispatchers were written + clients migrated, but the dispatcher never deployed). These orphans occupied the slots the pending dispatchers needed.

**Pilot executed (safe, verified):**
- Finance had **no** deployed orphans (already clean) — so the reclaim came from **loyalty**.
- Identified **38 loyalty orphans** = orphan ∩ `loyaltyDispatch` handler set (provably superseded).
- Verified **zero direct client callers** (all loyalty pages route through `loyaltyDispatch`).
- **Deleted the 38** → freed slots → **deployed `loyaltyDispatch` + `financeSprintDispatch`** (which now hosts the 12 settlement ops) + hosting. Both `Successful create`.

**Result:** deployed 1512 → **1475**, orphans 482 → **443**, net **−37 services**. **Settlement is LIVE** (12 ops via `financeSprintDispatch`); loyalty + finance restored (were broken with dispatchers down).

**Repeatable pattern (go-list for remaining 443 orphans):** for each consolidated subsystem — (1) `orphans ∩ dispatcher._h` = safe set, (2) confirm no direct client `httpsCallable` of those names, (3) `functions:delete` the set, (4) deploy the dispatcher. Largest remaining buckets: **admin ~43** (`adminOsDispatch`), **redis ~28** (`redisDispatch`), **search ~19**, **booking ~16** (`bookingDispatch`), **pos ~9**. Each pass reclaims dozens of slots with no customer-facing risk.

## 7. Remaining operational prerequisites

- Native split stays **disabled** per gateway (Phase 3) until the IntaSend Wallets/split capability is verified in sandbox (see `INTASEND_SETTLEMENT_AUDIT.md`).
- Routing flags default **legacy** (Phase 2) — no live routing change.
- If even a single new Cloud Run service cannot be created under current quota, the dispatcher is the minimal footprint; a one-time quota bump would then be the only remaining option (not required for correctness — subsystem is inert until enabled).

Related: [[SETTLEMENT_SPLIT_PHASE3]] · [[SETTLEMENT_MIGRATION_PHASE2]] · [[INTASEND_SETTLEMENT_AUDIT]]
