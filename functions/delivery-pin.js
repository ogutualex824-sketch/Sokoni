/* ═══════════════════════════════════════════════════════════════════════════
   Secure Delivery Authorization — PHASE 0 (SHADOW / instrumentation ONLY)
   ---------------------------------------------------------------------------
   Adds delivery-verification telemetry WITHOUT touching any money path. It:
     • generates a 6-digit delivery PIN when a rider accepts (a NEW trigger — the
       live claimAvailableDelivery accept function is NOT modified),
     • stores a keyed HMAC HASH on the packageRequest (safe to expose — a 6-digit
       PIN is only non-brute-forceable because the server HMAC key is secret),
     • stores the PLAINTEXT PIN in `deliveryPins/{orderId}`, which has NO rule and
       is therefore deny-by-default — no client reads it, the buyer obtains it only
       through getMyDeliveryPin, which proves buyer identity and refuses the rider.

       This line used to read "delivers the PLAINTEXT PIN to the BUYER only (on their
       order doc; the rider reads deliveries via CF endpoints, not the order doc)".
       That was wrong in one word — ONLY. The CF endpoints and their projections were
       real, but firestore.rules grants `assignedDriverUid` a FULL-DOCUMENT read on
       orders, and Firestore cannot project fields on read. The rider could read the
       plaintext out of the order it was written to. Fixed by moving the secret off
       the document rather than by adding another projection in front of it.
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

/* The buyer, spelled every way the delivery documents spell it. */
const BUYER_FIELDS = ["buyerUid", "buyerId", "userId", "uid", "customerUid"];
function buyerUidOf(d) {
  for (const f of BUYER_FIELDS) if (d && d[f]) return String(d[f]);
  return null;
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

      /* ── The plaintext PIN does NOT go on the order document ──────────────
         It used to. The reasoning was "riders read deliveries via CF endpoints,
         not orders" — and the endpoints and their projections are real. What
         failed was the word ONLY: firestore.rules grants a FULL-DOCUMENT read
         on orders to `assignedDriverUid`, and claimAvailableDelivery sets that
         field to the rider's uid in the same transaction that produces the
         `driver_accepted` transition this trigger fires on. So the rider could
         read the plaintext PIN out of the order the moment it was issued —
         the party the PIN exists to defend against.

         Firestore has no field-level read control, so no projection can fix a
         document the rider is entitled to read. The secret therefore moves off
         that document entirely.

         `deliveryPins` has NO rule in firestore.rules and there is no
         permissive catch-all, so it is deny-by-default: unreadable by every
         client including the buyer, and reachable only through the Admin SDK.
         The buyer gets it from getMyDeliveryPin, which proves buyer identity
         first. That is strictly stronger than a buyer-readable document AND
         costs zero rules bytes, which matters — the compiled ruleset has ~72
         bytes of headroom. */
      if (orderId) {
        await db.collection("deliveryPins").doc(String(orderId)).set({
          orderId:    String(orderId),
          deliveryRef: pkgId,
          pin,                                  /* CF-only; never client-readable */
          buyerUid:   buyerUidOf(after),
          issuedAt:   admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        /* The order keeps only the fact that a PIN exists, so track.html can
           show the right state without the value. Any plaintext left on the
           document by the previous implementation is removed here as the order
           passes through — see scripts/sweep-order-delivery-pins.js for the
           historical records this trigger will never touch again. */
        await db.collection("orders").doc(String(orderId)).set({
          deliveryPin:         admin.firestore.FieldValue.delete(),
          deliveryPinIssued:   true,
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

    /* ── The caller must be the rider this delivery is assigned to ───────────
       Without this, shadow was a PIN oracle: any signed-in account could submit
       guesses for any deliveryRef and read pass/fail back. delivery-complete.js
       states the reason plainly in its own guard — "checked before the PIN so a
       stranger cannot use this endpoint as a PIN oracle" — and that guard was
       simply never applied here. Same check, same order: assignment first, PIN
       second. */
    const assigned = d.riderId || d.assignedRiderId || d.assignedDriverUid || null;
    if (!assigned || assigned !== uid) {
      await _audit({ event: "shadow_denied_not_assigned", deliveryRef: String(deliveryRef),
                     orderId: d.orderId || null, actorUid: uid, assigned });
      throw new HttpsError("permission-denied", "This delivery is not assigned to you.");
    }

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

    /* ── Shadow keeps its OWN attempt counter ────────────────────────────────
       It used to increment `deliveryVerifyAttempts` — the same field
       completeDeliveryWithPin reads for its 5-attempt lockout. Telemetry could
       therefore exhaust the budget the real completion path depends on and push
       a legitimate rider into the "ask support" branch. A shadow observer must
       not be able to deny the authoritative path. */
    await ref.set({
      deliveryVerificationStatus: (stage === "delivery" && wouldAllow) ? "verified_shadow" : (d.deliveryVerificationStatus || "pending"),
      deliveryShadowAttempts:     admin.firestore.FieldValue.increment(1),
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

/* ── The BUYER reads their own delivery PIN ─────────────────────────────────
   The plaintext used to sit on the order document so track.html could render
   it. That made it readable by the assigned rider, because the orders rule
   grants that rider a full-document read and Firestore cannot project fields
   on read. The value now lives in `deliveryPins`, which has no rule at all and
   is therefore deny-by-default — no client can read it, and this callable is
   the only way to obtain one.

   Authorisation is against the ORDER, not against the stored `buyerUid` hint:
   the order is the record that decides who the buyer is, and resolving it here
   means a delivery document written with a missing or unusual buyer field
   cannot lock a buyer out of their own PIN.

   The assigned rider is refused explicitly. Without that, a rider who is also
   the buyer of some other order could probe this endpoint by orderId; more
   importantly it states the invariant in code rather than relying on the buyer
   check happening to exclude them. */
exports.getMyDeliveryPin = onCall(
  { region: "us-central1", timeoutSeconds: 15, memory: "256MiB" },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to see your delivery PIN.");

    const orderId = String((request.data && request.data.orderId) || "").trim();
    if (!orderId) throw new HttpsError("invalid-argument", "orderId is required.");

    const oSnap = await db.collection("orders").doc(orderId).get();
    if (!oSnap.exists) throw new HttpsError("not-found", "Order not found.");
    const o = oSnap.data();

    const buyer = buyerUidOf(o);
    if (!buyer || buyer !== uid) {
      await _audit({ event: "pin_read_denied", orderId, actorUid: uid, buyer });
      throw new HttpsError("permission-denied", "Only the buyer can see this delivery PIN.");
    }

    const rider = o.assignedDriverUid || o.riderId || o.assignedRiderId || null;
    if (rider && rider === uid) {
      await _audit({ event: "pin_read_denied_rider", orderId, actorUid: uid });
      throw new HttpsError("permission-denied", "The assigned rider cannot read the delivery PIN.");
    }

    const pSnap = await db.collection("deliveryPins").doc(orderId).get();
    if (!pSnap.exists || !pSnap.data().pin) {
      /* Not an error — a PIN is only issued once a rider accepts. */
      return { ok: true, issued: false, pin: null };
    }

    await _audit({ event: "pin_read", orderId, actorUid: uid });
    return { ok: true, issued: true, pin: String(pSnap.data().pin) };
  }
);
