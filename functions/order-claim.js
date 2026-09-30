/* ================================================================
   SOKONI — Atomic order claim (multi-employee POS distribution)

   A supermarket runs many tills. Ten cashiers may be logged in on ten machines
   under ten accounts, and one incoming online order is visible to all of them.
   EXACTLY ONE may take it.

       online order (STK | manual Till | PayBill — irrelevant here)
                            ↓
               shown on every eligible POS station
          ↓         ↓         ↓                    ↓
       POS #1    POS #2    POS #3   …          POS #10
          └─────────┴─────────┴────────┬──────────┘
                    atomic server claim
                                       ↓
                    ┌──────────────────┴──────────────────┐
              CLAIMED by A                      REFUSED for B–J
                                        "Already handled by another employee"

   WHY THE SERVER DECIDES, NOT THE SCREEN

   "First popup to appear wins" would let network latency pick the winner — the
   cashier with the fastest connection beats the one standing at the counter. The
   rule is FIRST SUCCESSFUL SERVER CLAIM, decided inside a transaction.

   CLAIMING IS A SEPARATE AXIS

   order received → order viewed → order CLAIMED by employee → fulfilment

   It must NOT overload:
     `paid`                          — payment established
     `awaiting_confirmation`         — seller accepts the order for fulfilment
     `awaiting_payment_attestation`  — manual payment awaiting merchant attestation

   Claiming says "I, this employee, am handling this". None of the above mean that,
   and merging them would repeat the F1 collision where one merchant action would
   have meant two different things.

   THE LOSER CAUSES NOTHING. No second order, payment transition, inventory
   movement, rider assignment, commission event, or customer notification. A clean
   refusal is the entire visible effect — which is why this module writes only the
   claim fields and never touches order status.

   RELATED, AND NOT FIXED HERE: `orderAdvance` (notify.js:727) reads then writes
   with no transaction anywhere in that file, so two cashiers can both advance the
   same order today. This module gives the claim a real concurrency boundary; it
   does NOT retrofit one onto orderAdvance. That remains open.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const db     = getFirestore();
const REGION = 'us-central1';
const cfg    = { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 30 };

/* Terminal states cannot be claimed — there is nothing left to handle. */
const UNCLAIMABLE = new Set(['completed', 'cancelled', 'refunded', 'rejected']);

/**
 * May `uid` act for the shop `sellerUid`?
 *
 * The merchant themselves, an admin, or an employee the MERCHANT granted.
 * `shopEmployees/{uid}.shopOwnerId` is the grant: firestore.rules only permits
 * creating that document when `shopOwnerId == request.auth.uid`, so a person
 * cannot make themselves an employee of someone else's shop. Attribution built on
 * a record the subject could mint would name whoever claimed the identity.
 */
async function _mayActForShop(uid, sellerUid, token) {
  if (!uid || !sellerUid) return { ok: false, as: null };
  if (String(uid) === String(sellerUid)) return { ok: true, as: 'owner' };
  if (token && (token.admin === true || token.superAdmin === true)) return { ok: true, as: 'admin' };

  const emp = await db.collection('shopEmployees').doc(String(uid)).get().catch(() => null);
  if (emp && emp.exists && String((emp.data() || {}).shopOwnerId) === String(sellerUid)) {
    return { ok: true, as: 'employee' };
  }
  return { ok: false, as: null };
}

/**
 * The atomic claim. Returns a plain result — a loss is an ordinary outcome, not an
 * exception, so ten simultaneous callers all get a clean answer.
 */
async function claimOrderFor(uid, orderId, { deviceId = null, token = null } = {}) {
  if (!uid)     return { ok: false, reason: 'unauthenticated' };
  if (!orderId) return { ok: false, reason: 'missing_order_id' };

  const ref = db.collection('orders').doc(String(orderId));

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return { ok: false, reason: 'order_not_found' };
    const d = snap.data() || {};

    const auth = await _mayActForShop(uid, d.sellerUid, token);
    if (!auth.ok) return { ok: false, reason: 'not_authorised_for_shop' };

    if (UNCLAIMABLE.has(String(d.status))) {
      return { ok: false, reason: 'order_not_claimable', status: d.status || null };
    }

    /* ── The race is decided here, and only here ─────────────────────────────
       Every concurrent caller reads inside its own transaction. Firestore
       serialises the conflicting writes: one commits, the rest retry, re-read the
       now-claimed document, and fall into the branch below. */
    if (d.claimedBy) {
      /* Idempotent for the SAME employee: a double-tap, a retry, or a reconnect
         must not read as a loss to the person who already won. */
      if (String(d.claimedBy) === String(uid)) {
        return { ok: true, reason: 'already_claimed_by_you', claimedBy: d.claimedBy, idempotent: true };
      }
      return { ok: false, reason: 'already_claimed', claimedBy: String(d.claimedBy) };
    }

    /* ONLY claim fields. Status, payment and inventory are untouched — a claim
       says who is handling the order, nothing about money or fulfilment. */
    txn.update(ref, {
      claimedBy:     String(uid),
      claimedByRole: auth.as,
      claimedAt:     FieldValue.serverTimestamp(),
      claimDeviceId: deviceId ? String(deviceId).slice(0, 64) : null,
      claimStatus:   'claimed',
    });

    return { ok: true, reason: 'claimed', claimedBy: String(uid), role: auth.as };
  });
}

/* ── Callable ─────────────────────────────────────────────────────────────── */
exports.claimOrder = onCall(cfg, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const { orderId, deviceId } = request.data || {};

  const res = await claimOrderFor(request.auth.uid, orderId, {
    deviceId, token: request.auth.token || {},
  });

  if (!res.ok && res.reason === 'not_authorised_for_shop') {
    throw new HttpsError('permission-denied', 'You are not authorised to handle this shop\'s orders.');
  }
  /* A loss is NOT an error — it is the expected outcome for nine of ten callers,
     and throwing would make normal contention look like a fault. */
  return res;
});

/** Release a claim, so a cashier who took an order by mistake can hand it back. */
exports.releaseOrderClaim = onCall(cfg, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = request.auth.uid;
  const { orderId } = request.data || {};
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId required.');

  const ref = db.collection('orders').doc(String(orderId));
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return { ok: false, reason: 'order_not_found' };
    const d = snap.data() || {};
    const token = request.auth.token || {};
    const isAdmin = token.admin === true || token.superAdmin === true;

    /* Only the holder may release — otherwise one cashier could take an order off
       another mid-handling. An admin may, for a cashier who has gone home. */
    if (String(d.claimedBy || '') !== String(uid) && !isAdmin) {
      return { ok: false, reason: 'not_your_claim' };
    }
    txn.update(ref, {
      claimedBy: null, claimedByRole: null, claimedAt: null,
      claimDeviceId: null, claimStatus: 'released',
    });
    return { ok: true, reason: 'released' };
  });
});

module.exports.claimOrderFor = claimOrderFor;
module.exports._mayActForShop = _mayActForShop;
module.exports.UNCLAIMABLE     = UNCLAIMABLE;
