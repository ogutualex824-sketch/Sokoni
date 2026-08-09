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

/* Haversine distance in metres. */
function _distM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
/* First present {lat,lng} among the candidate fields on a doc. */
function _coord(o, keys) {
  for (const k of keys) {
    const c = o && o[k];
    if (c && c.lat != null && c.lng != null) return { lat: +c.lat, lng: +c.lng };
  }
  return null;
}
const GEOFENCE_M = 250; /* pickup/delivery radius — tighten to 50–100 m at cutover via _systemConfig */

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

    /* Two-PIN stage: 'pickup' (seller handover → custody) or 'delivery' (money release).
       Shadow verifies the Phase-0 deliveryPin for both until distinct pickup/delivery codes
       land at cutover. */
    const stage = request.data.stage === "pickup" ? "pickup" : "delivery";

    /* 1) PIN check (server-side HMAC — the client check is bypassable, this is not). */
    let pinPass = false;
    if (d.deliveryPinHash) {
      const got = _hash(String(deliveryRef), String(pin).trim());
      try { pinPass = crypto.timingSafeEqual(Buffer.from(got), Buffer.from(d.deliveryPinHash)); }
      catch (_) { pinPass = got === d.deliveryPinHash; }
    }
    const result = pinPass ? "pass" : (d.deliveryPinHash ? "fail" : "no_pin");

    /* 2) Geofence — pickup checks the SELLER location, delivery the BUYER location. */
    const riderHasGps = (lat != null && lng != null);
    const target = stage === "pickup"
      ? _coord(d, ["pickupCoords", "sellerCoords"])
      : _coord(d, ["deliveryCoords", "dropoffCoords", "buyerCoords"]);
    let geofence = "no_coords", distanceM = null;
    if (!riderHasGps) geofence = "no_rider_gps";
    else if (target) {
      distanceM = Math.round(_distM(+lat, +lng, target.lat, target.lng));
      geofence = distanceM <= GEOFENCE_M ? "pass" : "fail";
    }

    /* 3) Would the SERVER gate allow this transition? PIN must pass; geofence must pass when
       we have both points (advisory — no block — when coords are missing, which itself is
       telemetry that pickup/delivery coords aren't being captured yet). */
    const wouldAllow = pinPass && (geofence === "pass" || geofence === "no_coords" || geofence === "no_rider_gps");

    /* Shadow record (one per delivery+stage) + audit — NO completion, NO money. */
    await db.collection("deliveryGateShadow").doc(String(deliveryRef) + "_" + stage).set({
      deliveryRef: String(deliveryRef), stage, orderId: d.orderId || null, riderUid: uid,
      pinPass, geofence, distanceM, wouldAllow,
      at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});

    await ref.set({
      deliveryVerificationStatus: (stage === "delivery" && wouldAllow) ? "verified_shadow" : (d.deliveryVerificationStatus || "pending"),
      deliveryVerifyAttempts:     admin.firestore.FieldValue.increment(1),
      deliveryLastVerifyAt:       admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});

    await _audit({
      event: "gate_shadow", stage, deliveryRef: String(deliveryRef), orderId: d.orderId || null,
      riderUid: uid, method: method || "pin", result, geofence, distanceM, wouldAllow,
      geo: riderHasGps ? { lat: Number(lat), lng: Number(lng) } : null,
    });

    /* Shadow: returns the outcome so the client can show telemetry, but the caller must NOT
       treat it as completion — the real completion path is unchanged (no money released). */
    return { ok: true, stage, result, geofence, distanceM, wouldAllow, shadow: true };
  }
);
