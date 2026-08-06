# SOKONI SmartPOS — Launch Readiness

> **Standard:** *Engineering Complete ≠ Production Proven.* Nothing is marked **PROVEN** without
> evidence (a real transaction, a production read, or a headless probe). Items that are built but
> unverified on real devices are **ENGINEERED — needs device test**, not "done". See
> [[project_release_validation_standard]].

Owner-driven hardening phase (feature freeze). Update the status column as each flow is exercised
with **real transactions over several days** on Android + iPhone + Desktop.

---

## Phase 2 — Data Consistency (automated, evidence-based)

`node scripts/qa/consistency-audit.js` — read-only, run against production `2026-08-06`, merchant
KASS (`D5Ql2…`):

| Entity | Canonical source | Result |
|---|---|---|
| Merchant identity | `users/{uid}` | ✓ one doc; roles a **unique set** `[buyer, rider, seller]` (dedupe holds) |
| Shop | `sellers/{uid}` | ✓ exists |
| Inventory | `products` (sellerUid==uid) | ✓ 103 products, **no owner mismatch**, all have `stock` |
| Legacy inventory | `posProducts` | ✓ **empty** — till reads canonical `products` |
| Orders | `orders` (uid \| buyerUid) | ✓ 4/4; **0 on the deprecated `xrH` account** (backfill holds) |
| POS terminal | `posTerminals/{uid}_hardware` | ✗ **not saved yet** — run the wizard *Save* once (permission fixed) to enable Cloud Restore |

**Action:** run the hardware wizard → Save once to create the terminal profile. Otherwise data is
canonical and clean; the earlier owner-id / orders / inventory / identity issues are resolved.

---

## Phase 4 — Audit Coverage

Sensitive actions must write `auditLogs` with `{ actor, ts, action, object, outcome }`.

| Action | Audited? | Where |
|---|---|---|
| Dispatch / collect / cancel | ✅ | `updateClickAndCollectStatus` (Sprint 7) |
| Financial (payouts, WHT/VAT, settlements) | ✅ | FinOS `writeAuditLog` |
| Device register / lock / logout / decommission | ✅ | `device-manager.js` |
| Admin invitations, subscriptions, incidents | ✅ | admin-invitations, ai-subscriptions, ecc |
| **Refund** (`posProcessRefund`) | ✅ `pos.refund` | order, amount, reason, prev→new status |
| **Inventory adjustment** (`inventoryAdjustStock`) | ✅ `inventory.stock_adjust` | product, prev→new available, delta, reason |
| **Price change** (`indexProductUpdate` trigger) | ✅ `product.price_change` | prev→new price, delta, actor=updatedBy |
| **Receipt reprint** (`posLogReprint`) | ✅ `pos.receipt_reprint` | order, type, printer, server reprint count |
| **Role change** (`setUserRole`, `grantAdminClaim`, `revokeAdminClaim`) | ✅ `role.change` | actor, target, **previous→new role**, ts, outcome |

All four written through **one canonical schema** (`functions/pos-audit.js` → `writeAudit`):
`{ schema, action, actorUid, actorRole, branchId, objectType, objectId, before, after, delta,
reason, outcome, metadata, ts }`. Dispatch + role-change audits migrated to the same schema.
Deployed `2026-08-06`. **All Phase-4 sensitive actions now emit a canonical audit entry.**

---

## Phase 6 — Operational Resilience (VERIFIED with evidence)

**Firestore backups** (`gcloud firestore ...`, `2026-08-06`):
- ✅ Daily backup schedule, **98-day retention** (8467200s), since 2026-06-25.
- ✅ **Point-in-Time Recovery ENABLED**.
- ✅ Alert **"Backup Not Run in 26 Hours"** (enabled) — catches backup failures.
- ☐ **Restore drill** not yet performed — do one test restore before launch to prove restorability.

**Monitoring & alerting** (Cloud Monitoring API, `2026-08-06`): **20 alert policies, all enabled**,
**2 email channels** (SOKONI Ops Alerts, Kaspa):

| Requested | Covered by |
|---|---|
| Cloud Function failures | ✅ CF Error Rate >5%, CF P95 Latency >10s |
| Firestore errors | ✅ Firestore Read Latency P99 >2s |
| Payment failures | ✅ Payment Verification Failure >10%, Idempotency Replay Spike |
| High error rates | ✅ HTTP 5xx >1%, SLO Order Success <99%, Checkout Session Error |
| Backup failures | ✅ Backup Not Run in 26h |
| Authentication failures | ✅ **"Auth Failure Spike (>10/5min)"** — log-metric `auth_failures`, wired to SOKONI Ops Alerts |
| Dispatch failures | ✅ **"Dispatch Failure (>3/5min)"** — log-metric `dispatch_failures`, order id in CF logs for correlation |

Both created + enabled `2026-08-06` (22 policies total). **Controlled trigger-test** is a manual
runbook step (see below) — generating real auth/dispatch failures on production is deliberate, not
automated.

### Alert trigger-test runbook (manual acceptance)
1. **Auth:** from a test client, make >10 authenticated CF calls in 5 min with an invalid/expired
   token (or App Check off) → each logs `unauthenticated`. Confirm the alert fires + email arrives,
   then stop → confirm it auto-resolves within a window.
2. **Dispatch:** temporarily point a test order's dispatch at a bad ref (or observe a real failure)
   so `dispatch/notify failed` logs >3× in 5 min → confirm alert + correlation id in logs → recover
   → confirm auto-resolve.

### Backup restore drill (Task 3)
- Latest backup `fe8bdbea…` (snapshot `2026-08-05T12:36:49Z`) restored to a **new** `restore-drill`
  database (non-destructive) on `2026-08-06`. Duration + doc-count verification:
  `node scripts/qa/verify-restore-drill.js`. **[results filled below once verified]**
- Cleanup: `gcloud firestore databases delete restore-drill` after verification.

---

## Phase 5 — Launch Readiness Checklist

Legend: **PROVEN** (evidence) · **ENG** (built, needs device test) · **GAP** (work remaining).

| # | Flow | Status | Evidence / how to test |
|---|---|---|---|
| 1 | Sign in / sign out | ENG | warm-app auth live; test persistence on all 3 devices |
| 2 | Merchant onboarding | ENG | onboarding gate live (v319); run first-login once |
| 3 | MiniShop creation + public access | ENG | verify `/shop/{handle}` renders live |
| 4 | Product upload + editing | PROVEN | 103 products canonical, editable (inventory.html) |
| 5 | Inventory synchronization | ENG | `subscribeProducts` live; test edit-on-A → appears-on-B |
| 6 | Customer checkout | ENG | keyless IntaSend proven earlier (3 real orders) |
| 7 | Payment confirmation | PROVEN | webhook-authoritative; gate orders confirmed |
| 8 | Merchant Orders | PROVEN | live via `clickAndCollect` onSnapshot |
| 9 | Ready for Dispatch / Pickup | ENG | `updateClickAndCollectStatus` live; run E2E |
| 10 | Rider assignment | ENG | claimable list + `claimAvailableDelivery`; test rider device |
| 11 | Delivery completion | ENG | run full delivery E2E |
| 12 | Pickup completion | ENG | run full pickup E2E |
| 13 | Receipt printing | ENG | 58mm engine + preview live (v317); test on Android/network printer |
| 14 | Reprint receipt | ENG | reprint wired; verify + add audit (Phase 4 gap) |
| 15 | Analytics updates | ENG | verify KPI/analytics after a real sale |
| 16 | Cross-device sync | ENG | live indicator (v322); test A↔B within seconds |
| 17 | Offline cash sale recovery | ENG | idempotent queue live (v324); test airplane-mode → reconnect |
| 18 | Backup + monitoring | PROVEN | daily backups + 98-day retention + PITR; 20 alert policies enabled + email channels (see Phase 6). Pending: restore drill + auth/dispatch alerts |

---

## Phase 3 — Real Device Matrix (owner-run)

| Check | Android | iPhone | Desktop |
|---|---|---|---|
| Login persistence | ☐ | ☐ | ☐ |
| Session sync (A↔B) | ☐ | ☐ | ☐ |
| Offline recovery | ☐ | ☐ | ☐ |
| Printer reconnect | ☐ | **N/A** ¹ | ☐ |
| Barcode scanning | ☐ | ☐ | ☐ |
| Camera permissions | ☐ | ☐ | ☐ |
| Safe-area layout | — | ☐ | — |
| Tablet layout | ☐ | ☐ | ☐ |

¹ **iOS Safari has no Web Bluetooth** — BLE printer auto-reconnect cannot work on iPhone. Use a
**network/Wi-Fi printer** (wizard supports IP) or a native bridge. This is an Apple platform limit.

---

## Go / No-Go

**No-Go until:** items 1–13 are **PROVEN** with real transactions on ≥2 devices, the 4 audit gaps
are closed, and #18 (backup + monitoring) is confirmed. Then tag and onboard.
