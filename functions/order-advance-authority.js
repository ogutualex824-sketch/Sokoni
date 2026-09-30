'use strict';
/**
 * SOKONI Order Advance Authority — who may move an order, and how far.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 * `orderAdvance` was the ONLY authority over an order's status, it was deployed,
 * and its entire check was:
 *
 *     if (!(request.auth && request.auth.uid)) throw unauthenticated
 *
 * Any signed-in account could name any `orderId` and advance that order's
 * timeline. That is not merely a data-integrity problem: the `accepted` stage
 * also sets `status: 'confirmed'`, and `onOrderStatusChange` watches `confirmed`
 * to fire **rider auto-assignment**. So an unrelated account could push a
 * stranger's order into dispatch and put a real rider on the road.
 *
 * ── The model ───────────────────────────────────────────────────────────────
 *     auth.uid → the order's own parties → allowed stage for that actor →
 *     status mutation → rider assignment
 *
 * Two questions, asked separately, because collapsing them is how this kind of
 * hole appears in the first place:
 *
 *   1. WHO is this caller to this order?   resolveActor()
 *   2. May that actor set THIS stage?      assertMayAdvance()
 *
 * A seller may accept and prepare; a rider may pick up and deliver. Neither may
 * do the other's job, and a buyer may do neither — the buyer's client only ever
 * READS the timeline, which is what the original comment said and what the code
 * did not enforce.
 *
 * ── Identity is read from the ORDER, not from the request ───────────────────
 * Orders in this codebase carry the seller under `sellerUid`, `sellerId` or
 * `vendorId`, and the rider under `riderId`, `riderUid`, `driverId` or
 * `assignedRider`. All are read; none is written. This module resolves the union
 * exactly as the surrounding code already does — it does not attempt to converge
 * those vocabularies, which is separate work.
 *
 * If the order names a `shopId`, shop ownership is ALSO accepted, through the
 * canonical `shop-employees` contract — so a shop owner can act on their shop's
 * order even when the order records a different member of that shop as seller.
 */

const { HttpsError } = require('firebase-functions/v2/https');

/* Which actor may move an order INTO each stage. Anything absent from a stage's
   list is admin-only, so a new stage added upstream is refused by default rather
   than being silently open to everyone. */
const STAGE_ACTORS = Object.freeze({
  received:  ['admin'],                    /* an order becomes received by existing */
  paid:      ['admin'],                    /* payment is the payment authority's word, never a client's */
  accepted:  ['seller', 'admin'],
  preparing: ['seller', 'admin'],
  ready:     ['seller', 'admin'],
  assigned:  ['admin'],                    /* rider assignment is dispatch's, not a self-claim */
  picked_up: ['rider', 'admin'],
  halfway:   ['rider', 'admin'],
  near:      ['rider', 'admin'],
  delivered: ['rider', 'admin'],
  completed: ['seller', 'admin'],
});

const SELLER_FIELDS = ['sellerUid', 'sellerId', 'vendorId'];
const RIDER_FIELDS = ['riderId', 'riderUid', 'driverId', 'assignedRider'];
const BUYER_FIELDS = ['buyerId', 'uid', 'userId', 'customerId'];

function _match(order, fields, uid) {
  for (var i = 0; i < fields.length; i++) {
    var v = order && order[fields[i]];
    if (v && String(v) === String(uid)) return true;
  }
  return false;
}

function isAdminClaims(claims) {
  if (!claims) return false;
  return claims.admin === true || claims.superAdmin === true ||
         claims.role === 'admin' || claims.role === 'superAdmin' || claims.role === 'super_admin';
}

/**
 * Who is `uid` to this order?  'admin' | 'seller' | 'rider' | 'buyer' | null
 *
 * Admin is checked first so a platform operator is never blocked by a malformed
 * order. `shopAccess` is an optional async resolver, supplied by the caller, used
 * only when the order names a shopId and no direct uid match was found.
 */
async function resolveActor(order, uid, claims, shopAccess) {
  if (!uid) return null;
  if (isAdminClaims(claims)) return 'admin';
  if (_match(order, SELLER_FIELDS, uid)) return 'seller';
  if (_match(order, RIDER_FIELDS, uid)) return 'rider';

  /* The order belongs to a shop this account owns, even if the seller field
     records somebody else in that shop. */
  var shopId = order && order.shopId;
  if (shopId && typeof shopAccess === 'function') {
    try {
      var role = await shopAccess(uid, String(shopId));
      if (role === 'owner' || role === 'manager' || role === 'admin') return 'seller';
    } catch (_) { /* no access is simply not a seller */ }
  }

  if (_match(order, BUYER_FIELDS, uid)) return 'buyer';
  return null;
}

/**
 * May this actor move the order into `stage`?
 *
 * Throws HttpsError and never returns false, so a caller cannot forget to check
 * the result. The refusal deliberately does not say WHICH party the caller was
 * mistaken for — that would let a prober enumerate an order's participants.
 */
function assertMayAdvance(actor, stage) {
  var allowed = STAGE_ACTORS[String(stage)];
  if (!allowed) {
    throw new HttpsError('invalid-argument', 'Unknown order stage: ' + stage);
  }
  if (!actor || allowed.indexOf(actor) === -1) {
    throw new HttpsError('permission-denied', 'You cannot update this order.');
  }
  return true;
}

/** Convenience: resolve then assert, in the one order the model describes. */
async function authorise(o) {
  var actor = await resolveActor(o.order, o.uid, o.claims, o.shopAccess);
  assertMayAdvance(actor, o.stage);
  return actor;
}

module.exports = {
  STAGE_ACTORS: STAGE_ACTORS,
  SELLER_FIELDS: SELLER_FIELDS,
  RIDER_FIELDS: RIDER_FIELDS,
  BUYER_FIELDS: BUYER_FIELDS,
  isAdminClaims: isAdminClaims,
  resolveActor: resolveActor,
  assertMayAdvance: assertMayAdvance,
  authorise: authorise,
};
