/* ═══════════════════════════════════════════════════════════════════════════
   SELLER HANDOVER AUTHORIZATION — a SECOND, independent PIN stage
   ---------------------------------------------------------------------------
   delivery-pin.js (Phase 0) and delivery-complete.js (Phase 1, LIVE/ENFORCING) already
   implement one PIN stage end to end: the BUYER holds a code, the assigned RIDER proves
   it to complete the delivery, and that transition is the only thing onOrderStatusChange
   watches to release the rider's payout. That stage is untouched by this file.

   This adds the OTHER stage delivery-pin.js's own comment already named as the eventual
   plan ("Two-PIN stage: 'pickup' (seller handover -> custody) or 'delivery' (money
   release)... until distinct pickup/delivery codes land at cutover") — the SELLER holds a
   pickup code, the assigned RIDER proves it to advance custody. It is a SEPARATE PIN
   (`pickupPinHash`), a SEPARATE attempt counter (`pickupVerifyAttempts`), and a SEPARATE
   Firestore field from the delivery stage's `deliveryPinHash`/`deliveryVerifyAttempts` —
   deliberately, so this new path can never exhaust or interfere with the live completion
   path's attempt budget, the same reason Phase 0's shadow counter was already isolated
   from Phase 1's.

   WHY NOT MOVE THE EXISTING DELIVERY-PIN ISSUANCE HERE INSTEAD
   completeDeliveryWithPin (LIVE today) fails closed when `deliveryPinHash` is absent. That
   field is issued at claim time by deliveryPinOnAccept. Moving issuance to fire only once a
   seller calls this new, UI-less callable would starve every real delivery of its
   completion PIN until a seller acts — a regression on a live, money-adjacent path, for a
   step with no button yet. See docs/SELLER_AUTHORIZE_HANDOVER_DESIGN.md. So
   deliveryPinOnAccept is untouched; this file only ADDS a second PIN.

   WHAT THIS DOES NOT DO
   Does not modify claimAvailableDelivery or its transaction. Does not write `delivered` or
   touch any wallet/escrow collection — `picked_up` is not watched by onOrderStatusChange's
   payout logic (checked directly: that logic gates strictly on `toStatus === "delivered"`).
   Does not invent a new canonical status — `picked_up` already exists in
   fulfilment-lifecycle.js's ladder, immediately after `assigned`.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

const deliveryAuthority = require("./delivery-authority");
const fulfilmentLifecycle = require("./fulfilment-lifecycle");
const { _h: pinHelpers } = require("./delivery-pin");

const SOKONI_HMAC_KEY = defineSecret("SOKONI_HMAC_KEY");
const db = admin.firestore();

const MAX_ATTEMPTS = 5;

/* Salted with a distinct label so a pickup-stage hash and a delivery-stage hash for the
   SAME deliveryRef+PIN value never collide — two different secrets must hash differently
   even if (by pure chance) the two randomly generated PINs were ever equal. */
function _pickupHash(deliveryRef, pin, key) {
  return crypto.createHmac("sha256", key).update("pickup|" + String(deliveryRef) + "|" + String(pin)).digest("hex");
}
function _keyOrThrow() {
  let k = null;
  try { k = SOKONI_HMAC_KEY.value() || null; } catch (_) { k = null; }
  if (!k) {
    const e = new Error("SOKONI_HMAC_KEY is not configured");
    e.__noKey = true;
    throw e;
  }
  return k;
}
function _sameHash(a, b) {
  const A = Buffer.from(String(a || ""), "utf8");
  const B = Buffer.from(String(b || ""), "utf8");
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function _audit(entry) {
  return db.collection("deliveryAuditLog").add(Object.assign({
    at: admin.firestore.FieldValue.serverTimestamp(),
    phase: "handover",
  }, entry)).catch(() => {});
}

/* The rider fields these documents actually use — mirrors delivery-authority.js /
   delivery-pin.js exactly rather than teaching this file a sixth spelling. */
const RIDER_FIELDS = ["riderId", "assignedRiderId", "assignedDriverUid"];
function assignedRiderOf(d) {
  for (const f of RIDER_FIELDS) if (d && d[f]) return String(d[f]);
  return null;
}

/* ── SELLER authorizes the already-assigned rider for handover ─────────────────────── */
exports.sellerAuthorizeHandover = onCall(
  { region: "us-central1", secrets: [SOKONI_HMAC_KEY] },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to authorize handover.");

    const pkgId = String((req.data && req.data.deliveryRef) || "").trim();
    if (!pkgId) throw new HttpsError("invalid-argument", "deliveryRef is required.");

    const pkgRef = db.collection("packageRequests").doc(pkgId);
    const pkgSnap = await pkgRef.get();
    if (!pkgSnap.exists) throw new HttpsError("not-found", "Delivery not found.");
    const d = pkgSnap.data();

    let o = null;
    if (d.orderId) {
      const oSnap = await db.collection("orders").doc(String(d.orderId)).get();
      if (oSnap.exists) o = oSnap.data();
    }

    /* ONE authority module for every delivery operation — see delivery-authority.js's own
       header for why a second, hand-rolled check here would be how this bug class re-enters. */
    deliveryAuthority.assertMayPerform("authorizeHandover", {
      uid, token: req.auth.token, delivery: d, order: o, HttpsError, deliveryRef: pkgId,
    });

    /* A seller cannot authorize a rider who has not claimed the job yet — this reads the
       SAME assignment fields claimAvailableDelivery writes; it does not touch that
       transaction or its first-claim-wins guard. */
    const riderUid = assignedRiderOf(d);
    if (!riderUid) {
      throw new HttpsError("failed-precondition", "No rider has been assigned to this delivery yet.");
    }

    /* Idempotent: a second tap must not mint a NEW pin and silently invalidate one the
       seller may have already read out to the rider. */
    if (d.handoverAuthorizedAt) {
      return { ok: true, alreadyAuthorized: true, orderId: d.orderId || null };
    }

    let key;
    try { key = _keyOrThrow(); }
    catch (e) {
      if (e && e.__noKey) {
        await _audit({ event: "authorize_denied_no_hmac_key", deliveryRef: pkgId, orderId: d.orderId || null, actorUid: uid });
        throw new HttpsError("failed-precondition",
          "Handover authorization is unavailable right now. Try again shortly.");
      }
      throw e;
    }
    const pin = pinHelpers._gen6();
    const hash = _pickupHash(pkgId, pin, key);

    await db.runTransaction(async (t) => {
      const snap = await t.get(pkgRef);
      const cur = snap.data() || {};
      if (cur.handoverAuthorizedAt) return; /* raced with another authorize call — inert */
      t.set(pkgRef, {
        handoverAuthorizedAt: admin.firestore.FieldValue.serverTimestamp(),
        handoverAuthorizedBy: uid,
        pickupPinHash:        hash,
        pickupPinVersion:     6,
        pickupPinIssuedAt:    admin.firestore.FieldValue.serverTimestamp(),
        pickupVerifyAttempts: 0,
      }, { merge: true });
    });

    if (d.orderId) {
      await db.collection("orders").doc(String(d.orderId)).set({
        handoverAuthorizedAt: admin.firestore.FieldValue.serverTimestamp(),
        handoverAuthorizedBy: uid,
      }, { merge: true }).catch(() => {});

      /* Plaintext lives ONLY in the existing deny-by-default collection — no new rules
         surface. Same document delivery-pin.js already writes `pin` to; this adds a
         second, independently-secreted field alongside it. */
      await db.collection("deliveryPins").doc(String(d.orderId)).set({
        pickupPin: pin,
        pickupPinIssuedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }).catch(() => {});
    }

    await _audit({ event: "handover_authorized", deliveryRef: pkgId, orderId: d.orderId || null, sellerUid: uid, riderUid });
    return { ok: true, alreadyAuthorized: false, orderId: d.orderId || null };
  }
);

/* ── SELLER reads their own pickup PIN ──────────────────────────────────────────────
   Mirrors getMyDeliveryPin's shape exactly: authorize against the order/delivery record,
   never trust a stored hint alone, and explicitly refuse the assigned rider rather than
   relying on the seller-match happening to exclude them. */
exports.getMyPickupPin = onCall(
  { region: "us-central1", timeoutSeconds: 15 },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to see your pickup PIN.");

    const orderId = String((req.data && req.data.orderId) || "").trim();
    if (!orderId) throw new HttpsError("invalid-argument", "orderId is required.");

    const oSnap = await db.collection("orders").doc(orderId).get();
    if (!oSnap.exists) throw new HttpsError("not-found", "Order not found.");
    const o = oSnap.data();

    const seller = o.sellerUid || o.sellerId || o.merchantId || null;
    if (!seller || String(seller) !== String(uid)) {
      await _audit({ event: "pickup_pin_read_denied", orderId, actorUid: uid });
      throw new HttpsError("permission-denied", "Only the seller can see this pickup PIN.");
    }

    const rider = o.assignedDriverUid || o.riderId || o.assignedRiderId || null;
    if (rider && String(rider) === String(uid)) {
      await _audit({ event: "pickup_pin_read_denied_rider", orderId, actorUid: uid });
      throw new HttpsError("permission-denied", "The assigned rider cannot read the pickup PIN.");
    }

    const pSnap = await db.collection("deliveryPins").doc(orderId).get();
    if (!pSnap.exists || !pSnap.data().pickupPin) {
      return { ok: true, issued: false, pin: null };
    }

    await _audit({ event: "pickup_pin_read", orderId, actorUid: uid });
    return { ok: true, issued: true, pin: String(pSnap.data().pickupPin) };
  }
);

/* ── RIDER proves the seller's pickup PIN — advances custody, releases NO money ────── */
exports.completePickupWithPin = onCall(
  { region: "us-central1", secrets: [SOKONI_HMAC_KEY] },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to confirm pickup.");

    const pkgId = String((req.data && req.data.deliveryRef) || "").trim();
    const pin   = String((req.data && req.data.pin) || "").trim();
    if (!pkgId) throw new HttpsError("invalid-argument", "deliveryRef is required.");

    const pkgRef = db.collection("packageRequests").doc(pkgId);
    const pkgSnap = await pkgRef.get();
    if (!pkgSnap.exists) throw new HttpsError("not-found", "Delivery not found.");
    const d = pkgSnap.data();

    /* Assignment checked before the PIN — same anti-oracle ordering completeDeliveryWithPin
       already established: a stranger must not be able to use this as a guess-checker. */
    const assigned = assignedRiderOf(d);
    if (!assigned || assigned !== uid) {
      await _audit({ event: "pickup_denied_not_assigned", deliveryRef: pkgId, orderId: d.orderId || null, actorUid: uid, assigned });
      throw new HttpsError("permission-denied", "This delivery is not assigned to you.");
    }

    if (!/^\d{4,8}$/.test(pin)) {
      await _audit({ event: "pickup_denied_pin_missing", deliveryRef: pkgId, orderId: d.orderId || null, actorUid: uid });
      throw new HttpsError("invalid-argument", "Enter the pickup PIN from the seller.");
    }
    if (!d.pickupPinHash) {
      await _audit({ event: "pickup_denied_not_authorized", deliveryRef: pkgId, orderId: d.orderId || null, actorUid: uid });
      throw new HttpsError("failed-precondition", "The seller has not authorized handover yet.");
    }

    /* OWN attempt counter — never deliveryVerifyAttempts. A rider guessing the pickup PIN
       must not be able to burn the delivery-stage lockout budget, or vice versa. */
    const attempts = Number(d.pickupVerifyAttempts || 0);
    if (attempts >= MAX_ATTEMPTS) {
      await _audit({ event: "pickup_denied_locked", deliveryRef: pkgId, orderId: d.orderId || null, actorUid: uid, attempts });
      throw new HttpsError("resource-exhausted", "Too many incorrect PIN attempts. Ask support to verify this pickup.");
    }

    let computed;
    try { computed = _pickupHash(pkgId, pin, _keyOrThrow()); }
    catch (e) {
      if (e && e.__noKey) {
        await _audit({ event: "pickup_denied_no_hmac_key", deliveryRef: pkgId, orderId: d.orderId || null, actorUid: uid });
        throw new HttpsError("failed-precondition",
          "Pickup verification is unavailable. Ask the seller to confirm handover another way.");
      }
      throw e;
    }

    if (!_sameHash(computed, d.pickupPinHash)) {
      await pkgRef.set({ pickupVerifyAttempts: admin.firestore.FieldValue.increment(1) }, { merge: true }).catch(() => {});
      await _audit({ event: "pickup_denied_wrong_pin", deliveryRef: pkgId, orderId: d.orderId || null, actorUid: uid, attempts: attempts + 1 });
      throw new HttpsError("permission-denied", "Wrong pickup PIN.");
    }

    const orderId = d.orderId || null;

    /* Transactional, lifecycle-guarded, idempotent — mirrors _completeDelivery's shape.
       No wallet, no escrow: fulfilment-lifecycle's ladder places `picked_up` well before
       `delivered`, the only transition onOrderStatusChange's payout logic watches.

       Uses index() rather than canAdvance() deliberately: canAdvance treats an EQUAL
       status as a legal (idempotent) write, which would re-stamp `pickedUpAt` on every
       replay. What this needs is "already at or past this stage" — a plain index
       comparison — so a replay or an already-further-along order is inert without
       clobbering the original pickup timestamp. */
    const targetIdx = fulfilmentLifecycle.index("picked_up");
    const result = await db.runTransaction(async (t) => {
      const snap = await t.get(pkgRef);
      const cur = snap.data() || {};
      const curIdx = fulfilmentLifecycle.index(cur.status);
      if (curIdx != null && curIdx >= targetIdx) {
        return { ok: true, alreadyAdvanced: true, status: cur.status };
      }
      t.set(pkgRef, {
        status: "picked_up",
        pickedUpAt: admin.firestore.FieldValue.serverTimestamp(),
        pickupVerifiedMethod: "rider_pin",
      }, { merge: true });
      return { ok: true, alreadyAdvanced: false };
    });

    if (!result.alreadyAdvanced && orderId) {
      await db.collection("orders").doc(String(orderId)).set({
        status: "picked_up",
        deliveryStatus: "picked_up",
        pickedUpAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }).catch(() => {});
    }

    await _audit({ event: result.alreadyAdvanced ? "pickup_replay_inert" : "pickup_ok",
                   deliveryRef: pkgId, orderId, actorUid: uid, method: "rider_pin" });
    return { ok: true, orderId, alreadyAdvanced: !!result.alreadyAdvanced, method: "rider_pin" };
  }
);

/* Exposed for the test suite, same convention as delivery-complete.js's exports._h. */
exports._h = { _pickupHash, _sameHash, assignedRiderOf, MAX_ATTEMPTS };
