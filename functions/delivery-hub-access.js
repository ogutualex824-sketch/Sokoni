'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — DELIVERY HUB ACCESS BOUNDARY
   functions/delivery-hub-access.js

   One place decides who may do what to a delivery job. Every Delivery Hub operation —
   browsing riders, dispatching, accepting, messaging, advancing the lifecycle, rating —
   asks here first.

   WHY IT IS SEPARATE FROM THE CALLABLES

   An authorisation rule spread across seven endpoints is seven rules, and the day they
   disagree is the day one of them is wrong. This session has already found that shape
   three times: three rewards rates, six wallet-balance writers, three delivery splits.
   The rules live here, they are pure, and they are certified without a network.

   THE PRINCIPLE THROUGHOUT: A ROLE IS NOT A PERMISSION.

   Being a merchant does not let you dispatch THIS job. Being a rider does not let you
   accept it, message about it, or advance it. What confers a right is a RELATIONSHIP TO
   THIS DELIVERY — owning it, being assigned to it, being its customer — and every check
   is recomputed from the job's current state rather than granted once and remembered.
   That is what makes reassignment revoke the previous rider immediately, with no
   separate revocation step for anyone to forget.

   PURE. No Firestore, no network, no admin SDK.
   ══════════════════════════════════════════════════════════════════════════════ */

const OP = {
  VIEW_JOB: 'VIEW_JOB',
  LIST_RIDERS: 'LIST_RIDERS',
  DISPATCH: 'DISPATCH',
  RIDER_RESPOND: 'RIDER_RESPOND',
  POST_MESSAGE: 'POST_MESSAGE',
  READ_MESSAGES: 'READ_MESSAGES',
  UPDATE_LOCATION: 'UPDATE_LOCATION',
  ADVANCE_PICKUP: 'ADVANCE_PICKUP',
  ADVANCE_TRANSIT: 'ADVANCE_TRANSIT',
  ADVANCE_DELIVERED: 'ADVANCE_DELIVERED',
  CANCEL: 'CANCEL',
  RATE_RIDER: 'RATE_RIDER',
};

const ROLE = { MERCHANT: 'merchant', RIDER: 'rider', CUSTOMER: 'customer', NONE: null };

const STATE = {
  PACKAGING: 'PACKAGING', READY_FOR_DISPATCH: 'READY_FOR_DISPATCH',
  RIDER_SEARCH: 'RIDER_SEARCH', RIDER_ASSIGNED: 'RIDER_ASSIGNED',
  DISPATCHED: 'DISPATCHED', PICKED_UP: 'PICKED_UP', IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED', CANCELLED: 'CANCELLED', FAILED: 'FAILED',
};

function deny(reason, detail) { return { ok: false, reason, detail: detail || null }; }

/** The caller's relationship to THIS job — recomputed, never cached. */
function roleOf(job, uid) {
  if (!job || !uid) return ROLE.NONE;
  const u = String(uid);
  if (u === String(job.merchantUid)) return ROLE.MERCHANT;
  if (job.assignedRiderUid && u === String(job.assignedRiderUid)) return ROLE.RIDER;
  if (job.customerUid && u === String(job.customerUid)) return ROLE.CUSTOMER;
  return ROLE.NONE;
}

/* Who may perform each operation, and in which states.

   States are listed explicitly rather than derived from "not terminal", because the
   interesting cases are the ones in the middle: a merchant may cancel a job that has not
   been picked up, and may not once the goods are with the rider. */
const RULES = {
  [OP.VIEW_JOB]:          { roles: [ROLE.MERCHANT, ROLE.RIDER, ROLE.CUSTOMER], states: null },
  [OP.READ_MESSAGES]:     { roles: [ROLE.MERCHANT, ROLE.RIDER], states: null },

  [OP.LIST_RIDERS]:       { roles: [ROLE.MERCHANT],
                            states: [STATE.READY_FOR_DISPATCH, STATE.RIDER_SEARCH] },
  [OP.DISPATCH]:          { roles: [ROLE.MERCHANT],
                            states: [STATE.READY_FOR_DISPATCH, STATE.RIDER_SEARCH] },

  /* Only the rider the job is offered to may answer for it. */
  [OP.RIDER_RESPOND]:     { roles: [ROLE.RIDER], states: [STATE.RIDER_ASSIGNED] },

  [OP.POST_MESSAGE]:      { roles: [ROLE.MERCHANT, ROLE.RIDER],
                            states: [STATE.RIDER_ASSIGNED, STATE.DISPATCHED,
                                     STATE.PICKED_UP, STATE.IN_TRANSIT] },

  /* POSITION IS REPORTED BY THE ONLY PARTY WHO HAS IT, and only while they are
     actually carrying out the delivery.

     NOT from RIDER_ASSIGNED: a rider who has merely been OFFERED a job has not agreed
     to be followed, and a merchant does not get to watch someone who has not accepted.
     Tracking begins when the rider does, and the terminal states end it — a delivered
     parcel is not a reason to keep reporting where somebody is. */
  [OP.UPDATE_LOCATION]:   { roles: [ROLE.RIDER],
                            states: [STATE.DISPATCHED, STATE.PICKED_UP, STATE.IN_TRANSIT] },

  /* THE RIDER MOVES THE GOODS, SO THE RIDER REPORTS THE MOVEMENT. A merchant marking a
     parcel picked up would be attesting to something they cannot see, and a merchant
     marking it delivered would let a shop close its own delivery. */
  [OP.ADVANCE_PICKUP]:    { roles: [ROLE.RIDER], states: [STATE.DISPATCHED] },
  [OP.ADVANCE_TRANSIT]:   { roles: [ROLE.RIDER], states: [STATE.PICKED_UP] },
  [OP.ADVANCE_DELIVERED]: { roles: [ROLE.RIDER], states: [STATE.IN_TRANSIT] },

  /* A merchant may call off a delivery until the goods leave the shop. After PICKED_UP
     the rider is carrying real items, and "cancelled" would describe a parcel that is in
     someone's hands — the job can only complete or fail from there. */
  [OP.CANCEL]:            { roles: [ROLE.MERCHANT],
                            states: [STATE.PACKAGING, STATE.READY_FOR_DISPATCH,
                                     STATE.RIDER_SEARCH, STATE.RIDER_ASSIGNED, STATE.DISPATCHED] },

  /* Rating is the one operation a rider may never perform, in any state. */
  [OP.RATE_RIDER]:        { roles: [ROLE.MERCHANT, ROLE.CUSTOMER], states: [STATE.DELIVERED] },
};

/**
 * May `uid` perform `op` on `job`?
 *
 * Returns { ok, role } or { ok: false, reason }. The reason distinguishes NOT_A_PARTY
 * (you have no relationship to this delivery) from ROLE_NOT_PERMITTED (you do, but not
 * this one) and WRONG_STATE (you may, but not now) — because a caller that cannot tell
 * them apart will retry the wrong thing.
 */
function can(job, uid, op) {
  if (!job || !job.deliveryId) return deny('NO_JOB');
  if (!uid) return deny('NO_CALLER');
  const rule = RULES[op];
  if (!rule) return deny('UNKNOWN_OPERATION', String(op));

  const role = roleOf(job, uid);
  if (role === ROLE.NONE) {
    /* Not a party to THIS delivery. Whatever else the caller is on this platform is not
       relevant here. */
    return deny('NOT_A_PARTY');
  }
  if (rule.roles.indexOf(role) === -1) {
    return deny('ROLE_NOT_PERMITTED', role + ' may not ' + op);
  }
  if (rule.states && rule.states.indexOf(job.state) === -1) {
    return deny('WRONG_STATE', job.state + ' does not permit ' + op);
  }
  return { ok: true, role };
}

/** Everything this caller may currently do — for a UI that should not offer a refused action. */
function permitted(job, uid) {
  return Object.keys(RULES).filter((op) => can(job, uid, op).ok);
}

module.exports = { can, permitted, roleOf, OP, ROLE, RULES, STATE };
