/* ═══════════════════════════════════════════════════════════════════════════
   SECURE DELIVERY AUTHORIZATION — PHASE 1 (ENFORCING)
   ---------------------------------------------------------------------------
   Phase 0 (delivery-pin.js) issued a PIN and watched. It says so itself: "DOES NOT
   gate delivery completion or any payout". Meanwhile the live path was:

     1. driver.html compared the typed PIN to `data.proofPin` — a PLAINTEXT value the
        RIDER'S OWN CLIENT had already fetched. A check against a value you hold is
        not a check.
     2. the rider's client then wrote orders/{id}.status = 'delivered', which
        firestore.rules explicitly permitted for the assigned driver.
     3. onOrderStatusChange saw `delivered` and credited real shillings to that same
        rider's wallet.

   So the rider authorised their own payout, and the PIN was decoration. This module
   moves step 1 and 2 to the server.

   WHAT IS AUTHORITATIVE NOW
     · the BUYER's PIN, verified here against the keyed HMAC on the packageRequest.
       The plaintext never leaves the buyer's order document, so the rider cannot
       read what they are being asked to prove.
     · only THIS function (and the buyer fallback below) writes `delivered` on an
       order. The client path is closed in firestore.rules.

   WHAT IS DELIBERATELY UNCHANGED
     The wallet credit stays exactly where it was — onOrderStatusChange, keyed on the
     deterministic walletTransactions/{rider}_{order}_delivery doc inside a
     transaction. That exactly-once guard was already correct; rebuilding it would
     risk a proven money path to fix an authorisation problem. This changes WHO can
     cause the first `delivered` transition, not what happens after it.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

const SOKONI_HMAC_KEY = defineSecret("SOKONI_HMAC_KEY");
const db = admin.firestore();

/* Must match delivery-pin.js exactly — the hash it wrote is what we verify.

   NO FALLBACK KEY HERE, deliberately. Phase 0 falls back to a constant because shadow
   telemetry must never crash, and that is right for something that authorises nothing.
   This function authorises money, and the constant lives in the source: the rider can
   read `deliveryPinHash` off the packageRequest, so a known key turns a 6-digit PIN
   into an offline brute-force of 10^6 — instant. A fallback here would be a lock whose
   key is printed on the door.

   Missing secret therefore FAILS CLOSED. That is safe rather than merely strict,
   because the buyer-confirmation fallback below needs no HMAC at all — deliveries can
   still complete while ops configures the secret; they just cannot complete on the
   rider's word. Availability is preserved without weakening authorisation. */
function _key() {
  let k = null;
  try { k = SOKONI_HMAC_KEY.value() || null; } catch (_) { k = null; }
  if (!k) {
    const e = new Error("SOKONI_HMAC_KEY is not configured");
    e.__noKey = true;
    throw e;
  }
  return k;
}
function _hash(deliveryRef, pin) {
  return crypto.createHmac("sha256", _key()).update(String(deliveryRef) + "|" + String(pin)).digest("hex");
}

/* Constant-time compare. A 6-digit PIN behind a keyed hash is not brute-forceable
   from the hash, but an early-exit comparison leaks position information to a caller
   who can time it — and this endpoint is callable by any authenticated rider. */
function _sameHash(a, b) {
  const A = Buffer.from(String(a || ""), "utf8");
  const B = Buffer.from(String(b || ""), "utf8");
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function _audit(entry) {
  return db.collection("deliveryAuditLog").add(Object.assign({
    at: admin.firestore.FieldValue.serverTimestamp(),
    phase: "enforcing",
  }, entry)).catch(() => {});
}

const MAX_ATTEMPTS = 5;

/* Shared completion write. Runs in a transaction so two concurrent calls cannot both
   see "not yet delivered" and both proceed — the order doc is the serialisation point.

   It writes `delivered` on the order, which is what onOrderStatusChange watches. The
   credit is NOT performed here: doing it in both places would be two rails to keep in
   step, and the existing rail is already exactly-once. */
async function _completeDelivery({ orderId, pkgId, riderUid, method, actorUid }) {
  const orderRef = db.collection("orders").doc(String(orderId));
  const result = await db.runTransaction(async (t) => {
    const snap = await t.get(orderRef);
    if (!snap.exists) return { ok: false, code: "not-found", reason: "order not found" };
    const o = snap.data();

    /* Already delivered is INERT, not an error. A retried call, a double-tap or a
       replay must not look like a failure to the rider, and must not write again —
       a second write would re-fire onOrderStatusChange, which the before/after guard
       would absorb, but relying on that would be depending on someone else's guard. */
    if (o.status === "delivered" || o.status === "completed") {
      return { ok: true, alreadyDelivered: true, status: o.status };
    }

    /* The order must be in a state a delivery can legitimately complete FROM. A correct
       PIN on a cancelled or refunded order is still not a delivery, and letting it through
       would credit a rider for an order the platform has already unwound — the PIN proves
       the buyer is present, not that the order is live. Denied rather than treated as
       inert, because this is a real conflict the caller should see. */
    const DELIVERABLE_FROM = [
      "confirmed", "processing", "paid", "shipped", "out_for_delivery",
      "rider_assigned", "rider_en_route", "picked_up", "in_transit",
    ];
    if (!DELIVERABLE_FROM.includes(String(o.status || ""))) {
      return { ok: false, code: "failed-precondition",
               reason: "Order is " + o.status + " — a delivery cannot complete from that state." };
    }

    t.set(orderRef, {
      status:              "delivered",
      deliveryStatus:      "delivered",
      deliveredAt:         admin.firestore.FieldValue.serverTimestamp(),
      deliveryAuthorizedBy: method,          /* 'rider_pin' | 'buyer_confirmation' */
      deliveryAuthorizedActor: actorUid || null,
      updatedAt:           admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ok: true, alreadyDelivered: false };
  });

  /* Mirror onto the packageRequest for the dispatch views. Best-effort and AFTER the
     order write: the order is what authorises the payout, so it must not be blocked
     by a secondary projection failing. */
  if (result.ok && !result.alreadyDelivered && pkgId) {
    await db.collection("packageRequests").doc(String(pkgId)).set({
      status: "delivered",
      deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
      deliveryVerificationStatus: "verified",
      deliveryVerifiedMethod: method,
    }, { merge: true }).catch(() => {});
  }
  return result;
}

/* ── RIDER completes with the BUYER's PIN ───────────────────────────────────── */
exports.completeDeliveryWithPin = onCall(
  { region: "us-central1", secrets: [SOKONI_HMAC_KEY] },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to complete a delivery.");

    const pkgId = String((req.data && req.data.deliveryRef) || "").trim();
    const pin   = String((req.data && req.data.pin) || "").trim();
    if (!pkgId) throw new HttpsError("invalid-argument", "deliveryRef is required.");

    const pkgRef = db.collection("packageRequests").doc(pkgId);
    const pkgSnap = await pkgRef.get();
    if (!pkgSnap.exists) throw new HttpsError("not-found", "Delivery not found.");
    const d = pkgSnap.data();

    /* The caller must be the rider this delivery is assigned to. Checked before the
       PIN so a stranger cannot use this endpoint as a PIN oracle. */
    const assigned = d.riderId || d.assignedRiderId || d.assignedDriverUid || null;
    if (!assigned || assigned !== uid) {
      await _audit({ event: "complete_denied_not_assigned", deliveryRef: pkgId, orderId: d.orderId || null, actorUid: uid, assigned });
      throw new HttpsError("permission-denied", "This delivery is not assigned to you.");
    }

    /* A missing PIN is a rejection, never a pass-through. The Phase 0 code path
       allowed `if (data.proofPin)` — no PIN meant no check at all. */
    if (!/^\d{4,8}$/.test(pin)) {
      await _audit({ event: "complete_denied_pin_missing", deliveryRef: pkgId, orderId: d.orderId || null, actorUid: uid });
      throw new HttpsError("invalid-argument", "Enter the delivery PIN from the customer.");
    }
    if (!d.deliveryPinHash) {
      await _audit({ event: "complete_denied_no_hash", deliveryRef: pkgId, orderId: d.orderId || null, actorUid: uid });
      throw new HttpsError("failed-precondition", "No delivery PIN was issued for this delivery.");
    }

    const attempts = Number(d.deliveryVerifyAttempts || 0);
    if (attempts >= MAX_ATTEMPTS) {
      await _audit({ event: "complete_denied_locked", deliveryRef: pkgId, orderId: d.orderId || null, actorUid: uid, attempts });
      throw new HttpsError("resource-exhausted", "Too many incorrect PIN attempts. Ask support to verify this delivery.");
    }

    /* Fail closed on a missing secret — never fall through to a guessable key. The buyer
       fallback still works, so this degrades authorisation strength to zero paths rather
       than to a weak one. */
    let computed;
    try { computed = _hash(pkgId, pin); }
    catch (e) {
      if (e && e.__noKey) {
        await _audit({ event: "complete_denied_no_hmac_key", deliveryRef: pkgId, orderId: d.orderId || null, actorUid: uid });
        throw new HttpsError("failed-precondition",
          "Delivery verification is unavailable. Ask the customer to confirm receipt in their app.");
      }
      throw e;
    }

    if (!_sameHash(computed, d.deliveryPinHash)) {
      await pkgRef.set({ deliveryVerifyAttempts: admin.firestore.FieldValue.increment(1) }, { merge: true }).catch(() => {});
      await _audit({ event: "complete_denied_wrong_pin", deliveryRef: pkgId, orderId: d.orderId || null, actorUid: uid, attempts: attempts + 1 });
      throw new HttpsError("permission-denied", "Wrong delivery PIN.");
    }

    const orderId = d.orderId;
    if (!orderId) throw new HttpsError("failed-precondition", "This delivery has no linked order.");

    const r = await _completeDelivery({ orderId, pkgId, riderUid: uid, method: "rider_pin", actorUid: uid });
    if (!r.ok) throw new HttpsError(r.code === "not-found" ? "not-found" : "failed-precondition", r.reason || "Could not complete.");

    await _audit({ event: r.alreadyDelivered ? "complete_replay_inert" : "complete_ok",
                   deliveryRef: pkgId, orderId, actorUid: uid, method: "rider_pin" });
    return { ok: true, orderId, alreadyDelivered: !!r.alreadyDelivered, method: "rider_pin" };
  }
);

/* ── BUYER fallback — the customer cannot produce the PIN ────────────────────
   The forgotten-PIN case must not become a rider-controlled bypass, so the fallback
   is not "the rider asserts the buyer agreed". It is an action only the BUYER can
   take, authenticated as themselves, from their own tracking screen.

   That inverts the trust correctly: the party who is owed the goods is the party who
   confirms receipt. It is server-verified (uid must equal the order's buyer), audited
   with the actor recorded, and it lands in the same single completion path — so the
   payout rail, its ordering and its exactly-once guard are identical either way. */
exports.buyerConfirmDelivery = onCall(
  { region: "us-central1" },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to confirm delivery.");

    const orderId = String((req.data && req.data.orderId) || "").trim();
    if (!orderId) throw new HttpsError("invalid-argument", "orderId is required.");

    const oSnap = await db.collection("orders").doc(orderId).get();
    if (!oSnap.exists) throw new HttpsError("not-found", "Order not found.");
    const o = oSnap.data();

    const buyer = o.buyerUid || o.userId || o.customerUid || null;
    if (!buyer || buyer !== uid) {
      await _audit({ event: "buyer_confirm_denied", orderId, actorUid: uid, buyer });
      throw new HttpsError("permission-denied", "Only the buyer can confirm this delivery.");
    }

    /* A rider must not be able to reach this by being the buyer of their own order —
       self-dealing would restore the bypass through the front door. */
    const rider = o.assignedDriverUid || o.riderId || null;
    if (rider && rider === uid) {
      await _audit({ event: "buyer_confirm_denied_self_deal", orderId, actorUid: uid });
      throw new HttpsError("permission-denied", "The assigned rider cannot confirm their own delivery.");
    }

    const pkgId = o.packageRequestId || o.deliveryRef || null;
    const r = await _completeDelivery({ orderId, pkgId, riderUid: rider, method: "buyer_confirmation", actorUid: uid });
    if (!r.ok) throw new HttpsError("failed-precondition", r.reason || "Could not complete.");

    await _audit({ event: r.alreadyDelivered ? "buyer_confirm_replay_inert" : "buyer_confirm_ok",
                   orderId, actorUid: uid, riderUid: rider, method: "buyer_confirmation" });
    return { ok: true, orderId, alreadyDelivered: !!r.alreadyDelivered, method: "buyer_confirmation" };
  }
);

/* Exposed for the test suite so the authorisation decisions can be exercised without
   deploying — the same functions the callables use, not a reimplementation of them. */
exports._h = { _hash, _sameHash, _completeDelivery, MAX_ATTEMPTS };
