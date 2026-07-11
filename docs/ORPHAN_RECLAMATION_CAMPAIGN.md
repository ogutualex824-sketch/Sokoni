# Orphan Reclamation Campaign

**Date:** 2026-07-11 · **Goal:** minimize Cloud Run services by deleting orphaned CFs (deployed but no longer exported by index.js, superseded by dispatchers) and deploying the pending dispatchers — no quota increase, zero regressions.

**Method (mandatory 6-phase procedure, every subsystem):** Discovery (`orphans ∩ dispatcher._h`) → Verification (no direct client callers / triggers / webhooks / internal imports / external refs) → Reclaim (delete verified only) → Deploy (dispatcher) → Validation → Report. **If an orphan cannot be proven safe, it is left in place and reported.**

---

## Progress (FINAL)

| Metric | Start | Final |
|--------|-------|-------|
| Cloud Run services | 1512 | **1239** (−273, −18%) |
| Orphans | 482 | **199** (283 reclaimed) |
| Dispatchers deployed | 3 (delivery only) | **13 — ALL live** |

**Every consolidation dispatcher is now deployed.** Remaining 199 orphans = **~147 Firestore triggers + ~52 email-notification triggers/webhooks/scheduled** (correctly kept — not dispatcher-superseded) + **~15 genuine onCall orphans with mismatched names** (no dispatcher covers them → manual review, per safety rule).

### Round 2 (this session, continued)
| Subsystem | Orphans deleted | Dispatcher | Notes |
|-----------|-----------------|------------|-------|
| Messages | 10 | `messagesDispatch` ✅ | incl. the 4 admin-chat ops excluded from Admin |
| Commerce | 34 | `commerceDispatch` ✅ | foundation/merchant/marketing/marketplace |
| Analytics | 0 | `analyticsDispatch` ✅ | no orphans — dispatcher restored |
| Logistics+ | 0 | `logisticsPlusDispatch` ✅ | no orphans — dispatcher restored |
| Services | 0 | `servicesDispatch` ✅ | no orphans — dispatcher restored |
| **POS** | **115** | `smartPosDispatch` ✅ | **client migration completed first** (7 call sites, 5 files) then reclaimed |

**POS migration (Track B):** migrated `pos.html`, `partner-portal.html`, `procurement.html`, `pos-analytics-live.js`, `sokoni-merchant-success.js` to route smartPos ops through `smartPosDispatch` (commit `eff7903`); deployed dispatcher + hosting; verified zero direct callers; then deleted 115 orphans — zero downtime.

## Subsystems reclaimed ✅

| Subsystem | Orphans deleted | Dispatcher | Verification |
|-----------|-----------------|------------|--------------|
| Loyalty | 38 | `loyaltyDispatch` | orphan ∩ `_h`; 0 direct callers (clients use `loyaltyDispatch`) |
| Finance + Settlement | (0 finance orphans) | `financeSprintDispatch` (hosts 12 settlement ops) | clients use `_cf`→dispatcher |
| Admin | 39 | `adminOsDispatch` | 0 direct callers; only `admin-os.js` references them |
| Redis | 28 | `redisDispatch` | 0 direct callers; scheduled redis jobs untouched |
| Booking | 21 | `bookingDispatch` | 0 direct callers; `emailOnBookingCreate` trigger excluded |

**Total reclaimed this campaign: 126 orphans; 5 new dispatchers live.** No regressions (each verified: zero direct callers, auth enforced per-handler inside dispatchers).

## Subsystems BLOCKED — manual review required ⚠️

| Subsystem | Orphans | Reason | Required before reclaim |
|-----------|---------|--------|-------------------------|
| **Search** (~19) | `searchSync_*_onCreate/onUpdate/onDelete` | **Firestore triggers**, not onCall handlers — **no dispatcher supersedes them**. Deleting could break Algolia/Typesense index sync. | Confirm whether a new search-sync mechanism replaced them; if not, they are ACTIVE — keep. |
| **POS** (~115 candidates) | pos/accounting/inventory/staff ops in `smartPosDispatch._h` | **Client migration incomplete** — main POS pages (`pos.html`, `pos-checkout.html`, `pos-modules.js`) call CFs **directly** (e.g. `pos.html` → `getPOSCustomer`; `_callCF(name)` helper), NOT via `smartPosDispatch`. Deleting would break the live POS terminal. | Migrate all POS client pages to `smartPosDispatch({op,...})`, then reclaim. |

## Remaining orphans (355)

- ~**93 are trigger-like** (`_onCreate/_onUpdate/_onDelete`, scheduled) — must be verified individually; triggers are **not** dispatcher-superseded and are generally kept unless a replacement is proven.
- ~**262 onCall candidates** across other subsystems (messages, analytics, wap, gip, eip, sub-engine, etc.) — each requires the same 6-phase procedure: identify dispatcher, `orphans ∩ _h`, **verify client migration complete** (the POS lesson), then delete + deploy.

## Operational notes

- **Deploy analyzer is intermittently slow** ("Cannot determine backend specification. Timeout after 10000") on the large codebase — deploys use up to 3 auto-retries; all succeeded within retries.
- Deletions are Cloud-state (`firebase functions:delete`), aligned with index.js intent (orphans are functions a full deploy would delete anyway).

## Next steps

1. **POS** — complete client migration to `smartPosDispatch`, then reclaim ~115 (largest single win).
2. **Search** — confirm trigger replacement status; keep active sync triggers.
3. Continue remaining onCall subsystems (messages, analytics, …) with the verified procedure.

Related: [[SETTLEMENT_DISPATCHER_CONSOLIDATION]] · [[DEPLOY_QUEUE]]
