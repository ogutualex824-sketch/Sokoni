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
| **Refund** (`posProcessRefund`) | ❌ **GAP** | — |
| **Inventory adjustment** | ❌ **GAP** | verify CF name |
| **Price change** (product edit) | ❌ **GAP** | — |
| **Receipt reprint** | ❌ **GAP** | — |
| **Role change** (`grantAdmin`/`setUserRole`) | ⚠️ verify | index.js |

**Action:** close the 4 gaps (refund, stock-adjust, price, reprint) with the same fire-and-forget
`auditLogs.add` pattern before onboarding merchants.

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
| 18 | Backup + monitoring | GAP | confirm Firestore backups + an ops alert exist |

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
