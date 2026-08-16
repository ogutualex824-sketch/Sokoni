/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — ONE delivery actor primitive

   THE PROBLEM THIS SOLVES
   Three dispatch callables accepted a client-supplied `deliveryRef` behind
   `_assertAuth` and nothing else:

     dispatchDelivery      started the rider cascade on any delivery
     handleFailedDelivery  declared any delivery failed — and its `reassign`
                           branch nulls `riderId`/`driverId` AND decrements the
                           real rider's `activeDeliveries`, while its `refund`
                           branch moves the delivery into `refund_initiated`
     optimizeBatchRoute    read an arbitrary list of deliveries to plan a route,
                           returning their addresses

   So any signed-in account could sabotage a stranger's delivery, strip its
   rider, damage that rider's cancellation record, and read customer addresses
   in bulk.

   WHY A SHARED MODULE RATHER THAN THREE CHECKS
   `fulfilment-scan.js` already resolves the same question correctly, and
   copying its logic would have produced a second role vocabulary that drifts
   from the first — which is precisely the class of defect the fulfilment
   lifecycle work already had to repair once, when `fulfilment-scan` tested for
   `assigned` while `dispatch.js` wrote `driver_assigned`. Authorities are not
   duplicated: this module holds the definition and `fulfilment-scan.js`
   consumes it.

   WHAT IT DELIBERATELY DOES NOT DO
   It does not decide lifecycle legality (that is `fulfilment-lifecycle.js`) and
   it does not touch payment state. It answers one question: what is this
   caller, to this delivery?
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

/* The ownership spellings these documents actually use. Kept in ONE place so a
   new spelling is added once rather than in every consumer. Mirrors the
   canonical definition in firestore.rules. */
const BUYER_FIELDS  = ['uid', 'userId', 'buyerId', 'buyerUid', 'customerUid'];
const SELLER_FIELDS = ['sellerUid', 'sellerId', 'merchantId'];
const RIDER_FIELDS  = ['assignedDriverUid', 'assignedDriverId', 'riderId', 'driverId', 'assignedRiderId'];

function _any(obj, fields, uid) {
  if (!obj || !uid) return false;
  return fields.some((f) => obj[f] && String(obj[f]) === String(uid));
}

function isAdminToken(token) {
  if (!token) return false;
  return token.admin === true || token.isAdmin === true ||
    token.role === 'admin' || token.role === 'superadmin';
}

/* Resolve the caller's relationship to a delivery, and to its order when one is
   available. Returns null when there is NO relationship — callers must treat
   null as a refusal, never as a default.

   `order` is optional: dispatch operates on packageRequests alone, while
   fulfilment-scan has both. A missing order narrows what can be proven; it
   never widens it. */
function resolveActor({ uid, token, delivery, order }) {
  if (!uid) return null;
  if (isAdminToken(token)) return 'admin';
  if (_any(delivery, RIDER_FIELDS, uid) || _any(order, RIDER_FIELDS, uid)) return 'rider';
  if (_any(delivery, SELLER_FIELDS, uid) || _any(order, SELLER_FIELDS, uid)) return 'seller';
  if (_any(delivery, BUYER_FIELDS, uid) || _any(order, BUYER_FIELDS, uid)) return 'buyer';
  return null;
}

/* ── Which actors may perform which delivery operation ─────────────────────
   Derived from who bears the consequence, not from who happens to call it:

   dispatch    offering a job to riders is the SELLER's decision (they are
               handing over custody) or an admin's. A rider must not be able to
               put a stranger's parcel into the cascade, and a buyer has no
               operational role here.

   fail        the RIDER is the party who discovers a failed delivery, and the
               SELLER owns the consequence. A BUYER declaring failure is a
               dispute, not a fulfilment transition — that path exists already
               and does not run through here.

   route       a RIDER planning their own route. Every delivery in the batch is
               checked individually, so "rider" does not mean "any rider".      */
const OPERATION_ACTORS = {
  dispatch: ['seller', 'admin'],
  fail:     ['rider', 'seller', 'admin'],
  route:    ['rider', 'admin'],
};

function mayPerform(operation, actor) {
  const allowed = OPERATION_ACTORS[operation];
  if (!allowed) return false;           /* unknown operation fails closed */
  return !!actor && allowed.indexOf(actor) !== -1;
}

/* Throw-style guard for callables. `HttpsError` is injected so this module
   stays free of a functions-runtime dependency and can be unit-tested. */
function assertMayPerform(operation, { uid, token, delivery, order, HttpsError, deliveryRef }) {
  const actor = resolveActor({ uid, token, delivery, order });
  if (!mayPerform(operation, actor)) {
    const E = HttpsError || Error;
    throw new E('permission-denied',
      'You are not authorised to ' +
      (operation === 'dispatch' ? 'dispatch' : operation === 'fail' ? 'report a failure on' : 'route') +
      ' this delivery.');
  }
  return actor;
}

module.exports = {
  BUYER_FIELDS, SELLER_FIELDS, RIDER_FIELDS,
  OPERATION_ACTORS,
  isAdminToken, resolveActor, mayPerform, assertMayPerform,
};
