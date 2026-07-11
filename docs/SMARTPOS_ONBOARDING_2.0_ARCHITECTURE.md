# SmartPOS Enterprise Onboarding 2.0 — Architecture & Delivery Plan

**Date:** 2026-07-11 · **Goal:** Shopify/Square-grade zero-friction merchant onboarding, fully integrated with SOKONI, quota-safe.

> This is a **multi-phase program**, not a one-shot build. Phase 1 (the enterprise backend foundation) is **shipped & deployed**; the premium 14-step wizard UI is a sequenced frontend program below. Everything is engineered so no step requires new Cloud Run services.

---

## 1. Architecture overview
- **Backend:** all onboarding ops live in `business-bootstrap._h`, served by the existing **`smartPosDispatch`** — **zero new Cloud Run services** (quota discipline). Clients call `smartPosDispatch({op,…})` via a `SPOS()` wrapper.
- **Data model:** business keyed by `businesses/{merchantId}`; ownership mirrored in `merchants/{merchantId}`; provisioning defaults across `branches`, `posStaff`, `posRoles`, `paymentMethods`, `taxConfig`, `receiptConfig`, `featureFlags`, `posSettings`, `categories`. Resumable state in `onboardingProgress/{uid}`.
- **Security:** every op validates ownership/staff on the backend (`_assertMerchantAccess`); client-supplied Merchant IDs are never trusted; QR pairing tokens verified server-side.

## 2. Updated onboarding flow
```
Welcome → Auth → getMyBusinesses ─┬─ exist → Business picker → connect → bootstrapDevice → Ready
                                  └─ none  → Create Business → auto IDs + defaults + QR → Ready
Wizard steps persisted per user (saveOnboardingProgress) → resume anytime.
Additional device → Merchant ID OR scan Business QR → pairDevice (backend-validated).
```

## 3. Firestore schema changes
No breaking changes — additive. `createBusiness` writes: `businesses` (+ `storeCode`, `posCode`, `publicStoreId`, `referralCode`, `apiPublicKey`, `typeFlags`, `pairingToken`), `merchants`, `branches/{merchantId}-main`, `posRoles/{merchantId}-owner`, `posStaff/{branchId}-{uid}`, `paymentMethods/{merchantId}-cash|-mpesa`, `taxConfig`, `receiptConfig`, `featureFlags` (merged type flags), `posSettings` (+ `barcodeFormat`), `categories` (per-type starter set). New: `onboardingProgress/{uid}`.

## 4. Merchant ID generation strategy
`SOK-XXXXXX`, alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `0/O/1/I`). Globally unique (doc-id existence check, retry on collision), immutable (IS the doc id), indexed (O(1)), human-readable. Companion IDs: `BIZ-…`, `STR-…`, `POS-…`, `SHOP-…`, `REF-…`, `pk_…` — all auto-generated.

## 5. QR pairing implementation
`createBusiness`/`regeneratePairingQR` return signed-ish payloads: business `{t:'sokoni-pos-pair', merchantId, businessId, branchId, token}` and device `{t:'sokoni-pos-device', merchantId, branchId, posCode}`. `pairDevice({qr})` parses, `_assertMerchantAccess`, and verifies `token === businesses.pairingToken`. Regenerating rotates the token (invalidates old QRs) without changing the Merchant ID.

## 6. Device pairing implementation
`pairDevice` accepts Merchant ID or scanned QR; returns validated business context for `bootstrapDevice`. (Client camera-scan UI + NFC/Bluetooth/LAN discovery are Phase 3 — the backend contract is stable.)

## 7. Setup wizard implementation
`saveOnboardingProgress({step,data,merchantId})` / `getOnboardingProgress()` back a resumable "Step X of 12" wizard (offline-safe: client caches locally and syncs). Provisioning already creates everything Steps 5–7 need in one batch.

## 8. Migration strategy
- Existing Merchant IDs unchanged. `getMyBusinesses` unions `businesses.ownerId` + legacy `merchants.ownerId`/`adminUids` → existing shops auto-detected, **no data migration required**.
- Inventory/orders/customers/subscriptions/wallet/receipts untouched (additive writes only).
- Client falls back to legacy claims-based discovery if the dispatcher is unreachable.

## 9. Files modified
`functions/business-bootstrap.js` (6 handlers + ID/defaults/progress), `functions/smartpos-dispatch.js` (merge), `pos-setup.html` (auto-detect + create form + pairing), `scripts/verify-architecture.js` (registry). Commits `c997aac`, `61632b7`.

## 10. Backend changes
**8 dispatcher ops** (all via `smartPosDispatch`, 0 new CFs): `getMyBusinesses`, `createBusiness`, `pairDevice`, `regeneratePairingQR`, `saveOnboardingProgress`, `getOnboardingProgress`, **`getSetupStatus`**, **`markSetupStep`**. Full ID set + per-type intelligent defaults + auto free-trial.

### Mandatory first-run resume logic + completion checklist (`getSetupStatus`)
Computes the checklist from **real Firestore state** (not just a cached step), so resume is authoritative and production-ready is never premature:

| Checklist item | Source of truth |
|----------------|-----------------|
| authenticated / businessCreated / merchantIdGenerated | auth + `businesses` doc |
| subscription | `subscriptions` active/trialing (auto free-trial on create) |
| branchCreated | `branches` for merchantId (default main) |
| taxesConfigured | `taxConfig` doc (country defaults auto-loaded) |
| inventoryReady | `posProducts` exist OR `markSetupStep('inventoryReady')` |
| hardwareConnected | `posDevices` exist OR skipped via `markSetupStep` |
| testSaleSuccessful | `markSetupStep('testSaleSuccessful')` |
| staff | optional |

`getSetupStatus` returns `{ checklist, nextStep, productionReady }` → the wizard **resumes at `nextStep`** (first incomplete) and only enters live production mode when `productionReady` (all required complete). `markSetupStep` records non-inferable completions and flips `productionReady`.

## 11. Frontend changes (shipped)
`SPOS()` dispatcher wrapper; auto-detect discovery; "Create Your Business" form (name/category/country/county/phone); manual entry re-scoped to additional-device pairing.

## 12. Security implementation
Backend ownership/staff/role validation on every op; App Check enforced (dispatcher); QR token verification; no client-trusted IDs; owner-only QR regeneration.

## 13. Performance
Single-batch provisioning; `bootstrapCache` cache-first bootstrap; indexed doc-id lookups; parallelised ownership queries. No new cold-start surface (reused dispatcher).

## 14. Test report
✅ `node --check` all files · ✅ 6 ops merge (186 total, 0 collisions) · ✅ Merchant ID format · ✅ both governance guards · ⏳ end-to-end (create→pair→bootstrap→sale) to run in staging on an authenticated device.

## 15. Rollback plan
- Client: `SPOS` discovery has a legacy-claims fallback; reverting `pos-setup.html` restores the prior flow (backend ops are additive and harmless if unused).
- Backend: the 6 ops are additive; removing them from `_h` + redeploying `smartPosDispatch` fully reverts with no data loss (provisioned docs remain valid).
- No Merchant IDs or existing data are ever mutated.

---

## Phased delivery (remaining — sequenced, each safe & quota-neutral)

| Phase | Scope | Backend ready? |
|-------|-------|----------------|
| **1 — Foundation (DONE ✅)** | Auto-detect, create + full ID set, intelligent defaults, QR, pairing, resumable state | ✅ deployed |
| **2 — Wizard shell (DONE ✅)** | 7-step premium wizard (progress dots, single-active-panel isolation, animations, dark, a11y) + boot resume gate | ✅ deployed |
| **5 — Actionable Setup Guide (DONE ✅)** | Ready screen renders `getSetupStatus` as a **one-task-at-a-time** guide: each incomplete required task (subscription, taxes, inventory, hardware, test sale) has an inline action wired to `markSetupStep` or a real feature page (`pos-inventory.html`, `pos-hardware-wizard.html`, `pos-checkout.html`); `Next` task highlighted; badge shows steps-left; **Production Ready gated** on `productionReady`; POS never hard-locked (guide, not a wall) | ✅ deployed |
| 3 — Device & pairing UX | Camera QR scanner, printer/scanner detection UI, NFC/BT/LAN discovery, test print | partial (pairDevice ✅) |
| 4 — Business Settings & switcher | Merchant/Business/Store IDs panel, QR copy/share/download/print, regenerate; multi-business switcher | backend ✅ |
| 6 — Admin dashboards | Businesses/devices/QRs/branches/staff/subscriptions views | reuse admin/pos ops |

**Setup Guide design note (Phase 5):** rather than force a returning merchant back through a 14-screen linear gauntlet, the completion checklist itself became the actionable surface (Square/Shopify pattern). It is driven entirely by authoritative backend state (`getSetupStatus` infers subscription/branch/taxes/inventory/hardware from real Firestore data; `markSetupStep` records the non-inferable choices — subscription confirm, tax default, inventory-later, hardware-skip, test-sale-done, staff-skip). No business logic changed; the working single-active-panel wizard structure is untouched.

Each phase is a self-contained PR gated by the architecture guard. **Acceptance criterion already met for the core:** a first-time merchant creates a business and receives an auto-generated Merchant ID without ever being asked for one.

Related: [[SMARTPOS_ONBOARDING_V2]] · [[DISPATCHER_REGISTRY]]
