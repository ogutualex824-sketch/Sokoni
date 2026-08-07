/* ═══════════════════════════════════════════════════════════════════════════
   Secure Delivery Authorization — PHASE 0 (SHADOW / instrumentation ONLY)
   ---------------------------------------------------------------------------
   Adds delivery-verification telemetry WITHOUT touching any money path. It:
     • generates a 6-digit delivery PIN when a rider accepts (a NEW trigger — the
       live claimAvailableDelivery accept function is NOT modified),
     • stores a keyed HMAC HASH on the packageRequest (safe to expose — a 6-digit
       PIN is only non-brute-forceable because the server HMAC key is secret),
     • delivers the PLAINTEXT PIN to the BUYER only (on their order doc; the rider
       reads deliveries via CF endpoints, not the order doc),
     • records every verification attempt to `deliveryAuditLog`,
     • tracks `deliveryVerificationStatus`.
   It DOES NOT gate delivery completion or any payout. Escrow release, wallet
   crediting, seller payouts and rider earnings are all untouched. The existing
   proofPin/OTP flow remains authoritative; this only observes, so we can prove the
   new verification pipeline is reliable on production data before enforcing it.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

const SOKONI_HMAC_KEY = defineSecret("SOKONI_HMAC_KEY");
const db = admin.firestore();

/* Cryptographically-random 6-digit code (unbiased). */
function _gen6() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

/* Keyed hash — binds the PIN to the specific delivery. The server HMAC key is what
   makes a 6-digit code non-brute-forceable from the stored hash. Falls back to a
   constant only if the secret is unavailable (shadow telemetry must never crash). */
function _hash(deliveryRef, pin) {
  let key = "sokoni-delivery-pin-fallback";
  try { key = SOKONI_HMAC_KEY.value() || key; } catch (_) {}
  return crypto.createHmac("sha256", key).update(String(deliveryRef) + "|" + String(pin)).digest("hex");
}

function _audit(entry) {
  return db.collection("deliveryAuditLog").add(Object.assign({
    at: admin.firestore.FieldValue.serverTimestamp(),
    phase: "shadow",
  }, entry)).catch(() => {});
}

/* ── PIN issuance — fires when a delivery becomes driver_accepted ───────────────
   A NEW trigger, additive to the packageRequest. Never modifies the accept CF. */
exports.deliveryPinOnAccept = onDocumentUpdated(
  { document: "packageRequests/{pkgId}", region: "us-central1", secrets: [SOKONI_HMAC_KEY] },
  async (event) => {
    const before = event.data && event.data.before.data();
    const after  = event.data && event.data.after.data();
    if (!before || !after) return;
    /* only on the transition INTO driver_accepted, and only once */
    if (after.status !== "driver_accepted" || before.status === "driver_accepted") return;
    if (after.deliveryPinHash) return; /* already issued — idempotent */

    const pkgId   = event.params.pkgId;
    const pin      = _gen6();
    const orderId  = after.orderId || null;
    const riderUid = after.riderId || after.assignedRiderId || after.assignedDriverUid || null;

    try {
      /* packageRequest gets the HASH + status only — NEVER the plaintext (a rider
         could read this doc). */
      await event.data.after.ref.set({
        deliveryPinHash:          _hash(pkgId, pin),
        deliveryPinVersion:       6,
        deliveryPinIssuedAt:      admin.firestore.FieldValue.serverTimestamp(),
        deliveryVerificationStatus: "pending",
        deliveryVerifyAttempts:   0,
      }, { merge: true });

      /* plaintext PIN → the BUYER's order doc (buyer-readable; riders read
         deliveries via CF endpoints, not orders). This is the buyer's display copy. */
      if (orderId) {
        await db.collection("orders").doc(String(orderId)).set({
          deliveryPin:         pin,          /* buyer-visible; shown on track.html */
          deliveryPinIssuedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      await _audit({ event: "pin_issued", deliveryRef: pkgId, orderId, riderUid, method: "pin" });
    } catch (e) {
      await _audit({ event: "pin_issue_error", deliveryRef: pkgId, orderId, error: String(e && e.message || e) });
    }
  }
);

/* ── SHADOW verification — rider submits the PIN; we RECORD the result ──────────
   Returns pass/fail and writes an audit entry. Does NOT complete the delivery or
   release any funds — the existing captureProofOfDelivery flow stays authoritative. */
exports.deliveryVerifyShadow = onCall(
  { region: "us-central1", timeoutSeconds: 20, memory: "256MiB", invoker: "public", secrets: [SOKONI_HMAC_KEY] },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to verify a delivery.");
    const { deliveryRef, pin, lat, lng, method } = request.data || {};
    if (!deliveryRef || !pin) throw new HttpsError("invalid-argument", "deliveryRef and pin required.");

    const ref  = db.collection("packageRequests").doc(String(deliveryRef));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Delivery not found.");
    const d = snap.data();

    let result = "fail";
    if (d.deliveryPinHash) {
      const got = _hash(String(deliveryRef), String(pin).trim());
      try {
        result = crypto.timingSafeEqual(Buffer.from(got), Buffer.from(d.deliveryPinHash)) ? "pass" : "fail";
      } catch (_) { result = (got === d.deliveryPinHash) ? "pass" : "fail"; }
    } else {
      result = "no_pin"; /* PIN not issued (legacy delivery) — recorded, not an error */
    }

    /* Record the attempt. SHADOW: update status + attempt counter only; no completion. */
    await ref.set({
      deliveryVerificationStatus: result === "pass" ? "verified_shadow" : (d.deliveryVerificationStatus || "pending"),
      deliveryVerifyAttempts:     admin.firestore.FieldValue.increment(1),
      deliveryLastVerifyAt:       admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});

    await _audit({
      event:       "pin_verify_attempt",
      deliveryRef: String(deliveryRef),
      orderId:     d.orderId || null,
      riderUid:    uid,
      method:      method || "pin",
      result,
      geo:         (lat != null && lng != null) ? { lat: Number(lat), lng: Number(lng) } : null,
    });

    /* Shadow: we return the outcome so the client can show telemetry, but the caller
       must NOT treat this as completion — the real completion path is unchanged. */
    return { ok: true, result, shadow: true };
  }
);
