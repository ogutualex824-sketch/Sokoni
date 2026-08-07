# Secure Delivery Authorization — Design & Convergence Plan

**Status:** Design (pre-implementation) · **Date:** 2026-08-07 · **Gate verdict:** REVISE (converge + gap-fill)
**Owner decisions baked in:** instant-vs-hold + per-method geofence (see §4).
**Related:** [[project_dispatch_completion_payout]] · [[project_rider_payout_double_rail]] · [[project_delivery_upgrade]] · [[feedback_security_layers]] · [[project_payment_trust]]

> **Core principle (owner):** the rider's payout is tied to *proof of delivery*, not to pressing a button — but a forgotten PIN must never block a legitimate delivery. So: a **verification hierarchy**, each tier producing signed proof, with per-tier rules for instant-release vs. hold-for-review.

---

## 1. Why this is a convergence, not a build

A survey (two independent passes) found the spec is **~90% already implemented** across three overlapping delivery systems (`deliveries`, `packageRequests`, `trips`). We **extend the existing, proven engine** — building a fourth parallel system would collide with the frozen wallet backend (`wallet-backend-v1.0-frozen`).

| Spec tier | Already exists | Evidence |
|---|---|---|
| Delivery PIN (buyer sees, rider enters) | ✅ **4-digit** `proofPin`, generated at booking | `sokoni-delivery.js:92,271`; verify `driver.html:2235`, `captureProofOfDelivery` |
| Buyer "I received my order" | ✅ fully wired | `delivery-tracking.html:611` → `sokoni-delivery.js:437` `buyerConfirmReceipt` (sets `sellerPayoutReady`) |
| SMS OTP (6-digit) | ✅ deployed | `functions/navigation.js:848` `navGenerateDeliveryOTP` |
| QR at handoff | ✅ customer-QR → rider scan (loose validation) | `delivery-tracking.html:1011`; `functions/dispatch.js:310` |
| Manual proof (photo+GPS+reason) | ✅ capture + failed-reason workflow | `functions/dispatch.js:293-440`; `sokoni-dispatch.js:50` |
| GPS geofence | ✅ **hard 500 m** block | `functions/sokoni-logistics.js:110-139` `validateProof` |
| Payout on verified delivery, exactly-once | ✅ rider on `delivered`, seller on `completed` | `index.js:2910`; `order-settlement.js` |
| Buyer PIN on tracking page | ✅ `delivery-tracking.html`; ❌ `track.html` |

**Canonical completion path (the ONE to extend):** `captureProofOfDelivery` (`functions/dispatch.js:293`) → `SokoniLogistics.validateProof` (OTP/QR/GPS/photo) → `packageRequests.status='delivered'` + mirror `orders.status='delivered'` → `onOrderStatusChange` (`index.js:2910`) credits rider exactly-once (`walletTransactions/{rider}_{order}_delivery`) → `completed` → `order-settlement.js` settles seller exactly-once.

---

## 2. The genuine gaps (all this design adds)

1. **Unified 6-digit PIN, generated on rider-accept.** Today there are *two* codes — 4-digit `proofPin` (booking) + 6-digit `deliveryOTP` (on demand). Converge to ONE 6-digit `deliveryPin`, generated when the rider accepts (`claimAvailableDelivery`, `index.js:6926`), shown only to the buyer.
2. **Orchestrated verification hierarchy.** The methods exist as separate flows; wire them into one server gate: *verified iff ANY of {PIN, buyer-confirm, OTP, QR, manual-proof}* succeeds, each carrying its `verificationMethod` into the proof record.
3. **Per-method release policy** (instant vs. hold) — §4.
4. **Per-method geofence policy** (hard vs. advisory) — §4.
5. **"Left in a safe place" as a proof-backed SUCCESS** (photo+GPS+reason → delivered-with-proof, funds HELD pending review) — today "customer unavailable" is only a failure/return path (`sokoni-dispatch.js:50`).
6. **PIN surfaced on `track.html`** (the lighter buyer tracking page has none).
7. **Formal delivery audit-log** entry on the delivered/completed transition (today only de-facto artifacts: `deliveryProofs`, `deliveryFees`, `walletTransactions`, `settlements`).

---

## 3. Verification hierarchy (the state machine)

```
Accepted ─▶ Picked Up ─▶ At Destination ─▶  VERIFY  ─▶ Verified Delivery ─▶ Release ─▶ Complete
                                              │
              ┌───────────────────────────────┼───────────────────────────────┐
      1. Delivery PIN (primary)   2. Buyer confirm (fastest fallback)   3. SMS OTP
              4. QR co-location proof            5. Manual proof (photo+GPS+reason)
```

- **1. Delivery PIN** — buyer reads it to rider; rider enters; server verifies against `deliveryPin`.
- **2. Buyer in-app confirm** — buyer taps "I received my order" (optionally Face/fingerprint/device-PIN → signed). Fastest path when PIN is forgotten. Already: `buyerConfirmReceipt`.
- **3. SMS OTP** — fresh 6-digit to buyer's phone; buyer reads to rider. Already: `navGenerateDeliveryOTP`.
- **4. QR** — buyer QR scanned by rider (co-location proof). **Gap:** make it HMAC-bound to the specific delivery (reuse `functions/qr.js` `generateSecureQR`/`verifyQRCode`) instead of substring match.
- **5. Manual** — "Customer unavailable" → left-with-security / receptionist / safe-place / returned; requires photo + GPS + timestamp + reason (+ optional signature). Funds HELD.

---

## 4. Release & geofence policy (owner decisions)

| Method | Releases funds | Geofence (rider within 50–100 m) |
|---|---|---|
| Delivery PIN | **Instant** | **Hard block** (rider-side) |
| Buyer in-app confirm | **Instant** | **Advisory + flag** (buyer already vouched; don't block on flaky GPS) |
| SMS OTP | **Instant** | **Hard block** (rider-side) |
| QR co-location | **Instant** | **Hard block** (rider-side) |
| Manual proof (safe-place etc.) | **HOLD — pending review** | Recorded, not a gate (funds already held) |

- **Instant** = the existing `delivered → onOrderStatusChange` rider credit + `completed → settleOrder` seller credit fire as they do today.
- **HOLD** = mark `settlementStatus='HELD'` + `payoutHold=true` + open a `deliveryReviews/{ref}` case; a support action or the auto-confirm sweep (`order-settlement.js:245`) releases after review.
- **Geofence source of truth:** extend `validateProof` (`sokoni-logistics.js:110-139`, currently hard 500 m for all) to take the `verificationMethod` and apply **hard for {PIN, OTP, QR}**, **advisory for buyer-confirm** (out-of-range → write an `oversoldAlerts`-style entry to a review queue, do NOT block). Tighten the hard radius from 500 m → configurable 50–100 m via `_systemConfig/delivery.geofenceMeters`.

---

## 5. Fraud protection (all required before instant release)

Per the owner spec, an instant release requires ALL of:
1. A valid verification (PIN / buyer-confirm / OTP / QR).
2. Rider GPS within geofence **at verification time** — hard for rider-side methods (§4).
3. Timestamp recorded.
4. No duplicate completion (order not already `delivered`/`completed`).
5. Audit-log written.
6. Idempotent payout (already: `{rider}_{order}_delivery`; cross-rail guard now landed — [[project_rider_payout_double_rail]]).

Existing GPS-fraud heuristics stay: Kenya bounding box + impossible-speed (`sokoni-dispatch.js:346-373`).

---

## 6. Data model changes (additive, backward-compatible)

On `packageRequests/{ref}` (and mirror where relevant):
- `deliveryPin` — string, 6-digit, set on rider-accept. (Keep `proofPin` readable during migration; new writes populate `deliveryPin`.)
- `deliveryPinIssuedAt` — server timestamp.
- `verificationMethod` — enum on completion: `pin|buyer_confirm|otp|qr|manual`.
- `verifiedAt`, `verifiedGeo` (lat/lng), `geofencePass` (bool | 'advisory').
- `payoutHold` (bool), `holdReason` (string) — for manual/held flows.

New collections:
- `deliveryReviews/{ref}` — held cases (method, proof refs, reason, status).
- `deliveryAuditLog/{autoId}` — formal audit on delivered/completed (orderId, riderUid, method, geo, amounts, decision).

No breaking change to existing readers: `proofPin` stays; `deliveryPin` is additive.

---

## 7. Phased implementation (money-path phases are shadow-first)

**Phase 0 — no money-path change (buildable + deployable immediately):**
- P0.1 Surface the PIN on `track.html`.
- P0.2 Write the formal `deliveryAuditLog` entry inside `captureProofOfDelivery` + `onOrderStatusChange` (additive; best-effort, never blocks).
- P0.3 ✅ *Done* — cross-rail double-pay guard + client-earnings removal ([[project_rider_payout_double_rail]]).

**Phase 1 — unified 6-digit PIN on rider-accept (touches generation + verify points):**
- Generate `deliveryPin` (6-digit) in `claimAvailableDelivery`; keep `proofPin` populated for back-compat.
- Update verify points (`driver.html`, `delivery-hub.js`, `captureProofOfDelivery`) to accept `deliveryPin` (fall back to `proofPin`).
- Surface on buyer pages (`delivery-tracking.html`, `track.html`, `checkout.html` success copy: "4-digit" → "6-digit").
- Verified by a shadow flag: compute the new PIN + record a comparison, but keep the old verify authoritative until parity is shown (mirrors the checkout-convergence shadow discipline).

**Phase 2 — orchestrated hierarchy + per-method policy (frozen release path → shadow-first, owner sign-off per deploy):**
- Extend `validateProof` to take `verificationMethod` and apply §4 geofence policy.
- Route instant vs. hold per §4 in `captureProofOfDelivery` / the settlement bridge.
- Shadow mode: run the new gate in parallel, write `deliveryVerifyShadow/{ref}` (would-release vs. would-hold, geofence decision, method) with **zero side effects**, compare against live for N real deliveries before cutover — exactly as checkout convergence was de-risked.

**Phase 3 — QR hardening + safe-place success:**
- HMAC-bind QR to the delivery (`functions/qr.js`).
- Add "left in safe place" as a delivered-with-proof outcome (funds HELD + `deliveryReviews`).

---

## 8. Acceptance criteria & test plan

Per phase, before deploy:
- **Correctness:** each verification method independently marks delivery verified; wrong PIN/OTP rejected; QR bound to the right delivery.
- **Exactly-once money:** one delivery → one rider credit → one seller settlement, across ALL methods and any rail (regression test the cross-rail guard).
- **Instant vs. hold:** PIN/buyer-confirm/OTP/QR release; manual holds and opens a review case.
- **Geofence:** rider-side methods blocked outside the radius (with a manual-override that HOLDS); buyer-confirm not blocked but flagged when out of range.
- **No client trust:** payout amount is always server-computed (never `request.data`).
- **Audit:** every completion writes `deliveryAuditLog` with method + geo + amounts + decision.
- **Back-compat:** existing 4-digit `proofPin` deliveries still complete during migration.
- **Accessibility/UI:** PIN visible on both buyer tracking pages; dialogs via the canonical `SK.dialog`.

**Freeze boundary:** Phases 1–3 modify `captureProofOfDelivery` / `validateProof` / the release bridge — all on `wallet-backend-v1.0-frozen`. Each requires explicit owner sign-off and shadow-verified parity before cutover. Phase 0 is safe and does not touch fund release.
