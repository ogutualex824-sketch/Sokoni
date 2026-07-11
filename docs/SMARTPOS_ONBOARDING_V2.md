# SmartPOS Onboarding v2 — Auto Merchant ID & Business Detection

**Date:** 2026-07-11 · **Principle:** a first-time user is never asked for a Merchant ID they don't have.

## Onboarding flow (implemented)

```
Authentication
   ↓
getMyBusinesses  (auto-detect — no Merchant ID)
   ↓
 ┌─ businesses exist → business picker → select → bootstrapDevice → Ready
 └─ none            → "Create Your Business" form → createBusiness
                        (auto Merchant ID + defaults + QR) → Ready
Additional device: Merchant ID entry OR scan Business QR → pairDevice (backend-validated)
```

## Backend (all via `smartPosDispatch` — ZERO new Cloud Run services)

`functions/business-bootstrap.js` `_h` registry, merged in `smartpos-dispatch.js`:

| Op | Purpose | Security |
|----|---------|----------|
| `getMyBusinesses` | Businesses the user owns (`businesses.ownerId` ∪ legacy `merchants.ownerId`/`adminUids`) | auth required; only own businesses |
| `createBusiness` | First-time: auto Merchant ID + Business ID + defaults + QR | auth; owner = caller uid |
| `pairDevice` | Connect additional device by Merchant ID or QR | `_assertMerchantAccess` (owner/staff); QR token verified; client ID never trusted |
| `regeneratePairingQR` | New QR, same Merchant ID | owner only |

## Merchant ID generation strategy

- **Format:** `SOK-XXXXXX` (6 chars, alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no `0/O/1/I`).
- **Globally unique:** candidate checked against `businesses/{id}` (indexed doc-id lookup); regenerate on collision (≤10 tries).
- **Human-readable · Immutable:** it IS the business document ID — never changes.
- **Indexed:** doc-id is auto-indexed → O(1) lookup.

## QR pairing

- `createBusiness` / `regeneratePairingQR` return a QR payload: `{v:1, t:'sokoni-pos-pair', merchantId, businessId, branchId, token}`.
- Scanning → client passes the payload to `pairDevice({qr})` → backend parses, validates ownership, and verifies `token` matches `businesses.pairingToken`.
- Regenerating the QR rotates `pairingToken` without changing the Merchant ID (invalidates old QRs).

## Firestore schema (writes on createBusiness)

`businesses/{merchantId}` (merchantId, businessId, name, category, country, county, phone, logo, ownerId, status, defaultBranchId, pairingToken) · `merchants/{merchantId}` (ownership mirror) · `branches/{merchantId}-main` · `posRoles/{merchantId}-owner` · `posStaff/{branchId}-{uid}` (owner) · `paymentMethods/{merchantId}-cash|-mpesa` · `taxConfig` · `receiptConfig` · `featureFlags` · `posSettings` · `categories/{merchantId}-general`. No breaking schema changes — additive; matches what `bootstrapDevice` reads.

## Client (`pos-setup.html`)

- `SPOS(op)` helper routes onboarding ops through `smartPosDispatch`.
- Discovery → `getMyBusinesses` (claims-based fallback kept for backward-compat).
- 0 businesses → `renderCreateBusiness()` form (name, category, country, county, phone) → `createMyBusiness()` → `createBusiness`.
- Manual Merchant ID entry re-scoped to additional-device pairing via `pairDevice`.

## Migration / backward compatibility

- **Existing Merchant IDs remain valid** — unchanged; `pairDevice`/`getBusinessConfig` accept them.
- **Existing businesses auto-detected** — `getMyBusinesses` unions `businesses.ownerId` and legacy `merchants.ownerId`/`adminUids`, so no data migration is required for old shops.
- **Fallback** — if the dispatcher call fails, the client falls back to legacy claims-based discovery.

## Test results

- ✅ `node --check` all changed files.
- ✅ 4 ops merge into `smartPosDispatch` (184 ops, no collisions).
- ✅ Merchant ID format verified (`SOK-QK4UCY`, no ambiguous chars).
- ✅ Architecture + CompanyIdentity guards pass.
- ⏳ End-to-end (create → pair → bootstrap) requires an authenticated device against the deployed dispatcher — to run in staging.

## Remaining client polish (backend already supports)

- **Business Settings panel:** show Merchant ID, Business ID, QR (copy button), "Regenerate pairing QR" (calls `regeneratePairingQR`). Backend ready.
- **Camera QR scanner** for Option B pairing (feed decoded payload to `pairDevice({qr})`). Backend ready.

Files modified: `functions/business-bootstrap.js`, `functions/smartpos-dispatch.js`, `pos-setup.html`, `scripts/verify-architecture.js`. Commit `c997aac`.
