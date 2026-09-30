/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — RESOLUTIONS (the callables)
   functions/resolutions.js

   Carries a decided claim to its end. Every DECISION belongs to resolution-authority.js:
   which milestones a remedy has, which moves are legal, and who may make each one.

   ── IT MOVES NO MONEY ────────────────────────────────────────────────────────
   For a REFUND this module records the branch and then gets out of the way: the money is
   moved by processReturnRefund and confirmed by the provider, exactly as before. The
   resolution's refund status is DERIVED from the return request rather than written here,
   so there is one lifecycle for money and not two spellings of it.

   For a replacement, repair, exchange or store credit there is no money at all — those are
   obligations, and this module records whether they were met.

   ── V1 IS SELLER-ARRANGED ────────────────────────────────────────────────────
   No rider is dispatched for a return. Rider business identity is UNLINKED, and a remedy
   that waited on rider provisioning would be one nobody could receive. What is NOT dropped
   is the liability: who would have owed for that return is persisted on the resolution.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const RES = require('./resolution-authority');
const REFUND = require('./refund-authority');
const WP = require('./warranty-policy');
const _ac = require('./admin-claim');

const REGION = 'us-central1';
const db = () => getFirestore();
const stamp = () => FieldValue.serverTimestamp();

const C_ORDERS = 'orders';
const C_RETURNS = 'returnRequests';
const C_RESOLUTIONS = 'resolutions';
const C_DISPUTES = 'disputes';

function fail(code, msg) { throw new HttpsError(code, msg); }

function uidOf(req) {
  if (!req || !req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in to continue.');
  return String(req.auth.uid);
}

/** The buyer named on an order, across every spelling this platform has used. */
function buyerOf(order) {
  return String((order && (order.buyerId || order.buyerUid || order.userId ||
                           order.customerId || order.customerUid || order.uid)) || '');
}
function sellerOf(order) {
  return String((order && (order.sellerUid || order.sellerId || order.vendorId)) || '');
}

/** Deterministic, so a retried authorisation lands on the document it already made. */
function resolutionId(orderId, lineIndex) {
  const n = (lineIndex === null || lineIndex === undefined || lineIndex === '') ? 'x' : Number(lineIndex);
  return 'res_' + String(orderId) + '_' + n;
}

/**
 * Load the case: the order, the return request the buyer opened, and the resolution if one
 * exists. Read together because every decision below needs all three, and reading them
 * apart is how a check ends up applied to a stale one.
 */
async function loadCase(orderId, lineIndex) {
  const oSnap = await db().collection(C_ORDERS).doc(String(orderId)).get();
  if (!oSnap.exists) fail('not-found', 'That order does not exist.');
  const order = Object.assign({ id: oSnap.id }, oSnap.data());

  const rid = REFUND.refundId(String(orderId), lineIndex);
  if (!rid.ok) fail('invalid-argument', 'That line could not be identified.');
  const rSnap = await db().collection(C_RETURNS).doc(rid.id).get();

  const resId = resolutionId(orderId, lineIndex);
  const resSnap = await db().collection(C_RESOLUTIONS).doc(resId).get();

  return {
    order,
    returnId: rid.id,
    ret: rSnap.exists ? Object.assign({ id: rSnap.id }, rSnap.data()) : null,
    resId,
    res: resSnap.exists ? Object.assign({ id: resSnap.id }, resSnap.data()) : null,
  };
}

/* ═══ 1. authorizeResolution — the platform commits the case to one remedy ════
   This is the branch point, and it is deliberately a PLATFORM decision. A seller who
   could choose the remedy would answer every refund claim with a repair; a buyer who
   could choose alone would need no review at all. */
exports.authorizeResolution = onCall({ region: REGION, enforceAppCheck: true }, async (req) => {
  const uid = uidOf(req);
  if (!_ac.isAdmin(req.auth.token)) fail('permission-denied', 'Only SOKONI can authorise a resolution.');

  const d = req.data || {};
  const orderId = String(d.orderId || '').trim();
  if (!orderId) fail('invalid-argument', 'orderId is required.');
  const remedy = String(d.remedy || '').trim();

  const c = await loadCase(orderId, d.lineIndex);
  if (!c.ret) fail('failed-precondition', 'No return request exists for that line.');

  /* THE REMEDY MUST BE ONE THE BUYER ASKED FOR AND THE SELLER OFFERED. The buyer's list
     came from the pinned policy at request time, so checking against it checks both at
     once — and stops a resolution being authorised for something nobody agreed to. */
  const asked = Array.isArray(c.ret.remedies) ? c.ret.remedies : [];
  if (asked.indexOf(remedy) === -1) {
    fail('failed-precondition', 'That resolution was not among the ones requested.');
  }

  const built = RES.buildRecord({
    orderId,
    lineIndex: d.lineIndex,
    productId: c.ret.productId || null,
    disputeId: 'dp_' + orderId,
    remedy,
    /* FROM THE RETURN REQUEST, which the warranty authority wrote. Never from this call. */
    fault: c.ret.fault || WP.FAULT.UNDETERMINED,
    policyVersion: c.ret.policyVersion || null,
  });
  if (!built.ok) {
    fail('invalid-argument', built.reason === 'UNKNOWN_REMEDY'
      ? 'That is not a resolution SOKONI can carry out.' : 'That resolution could not be recorded.');
  }

  const ref = db().collection(C_RESOLUTIONS).doc(c.resId);
  let created = false;

  await db().runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (snap.exists) {
      /* Idempotent. Authorising twice returns the resolution that already exists rather
         than moving a case that has already started. */
      return;
    }
    created = true;
    txn.set(ref, Object.assign({}, built.record, {
      returnRequestId: c.returnId,
      buyerUid: buyerOf(c.order),
      sellerUid: sellerOf(c.order),
      resolutionStatus: RES.STATE.RESOLUTION_AUTHORIZED,
      authorizedBy: uid,
      authorizedAt: stamp(),
      /* The case's own history, appended to and never rewritten. */
      timeline: [
        { state: RES.STATE.REQUESTED, actor: buyerOf(c.order), actorRole: 'buyer',
          note: 'Return requested', at: new Date().toISOString() },
        { state: RES.STATE.ELIGIBLE, actor: uid, actorRole: 'admin',
          note: 'Claim accepted', at: new Date().toISOString() },
        { state: RES.STATE.RESOLUTION_AUTHORIZED, actor: uid, actorRole: 'admin',
          note: 'Resolution agreed: ' + remedy, at: new Date().toISOString() },
      ],
      createdAt: stamp(),
      updatedAt: stamp(),
    }));
  });

  /* The dispute keeps pointing at its remedy. A case whose dispute and resolution are
     separate documents with no link between them is two half-stories. */
  await db().collection(C_DISPUTES).doc('dp_' + orderId).set({
    resolutionId: c.resId,
    resolutionType: remedy,
    updatedAt: stamp(),
  }, { merge: true }).catch(() => {});

  return { ok: true, resolutionId: c.resId, created, remedy, status: RES.STATE.RESOLUTION_AUTHORIZED };
});

/* ═══ 2. advanceResolution — the seller performs, the buyer confirms ══════════
   One entry point for both, because the AUTHORITY decides which of them a given move
   belongs to. Two endpoints would mean two places that could disagree about it. */
exports.advanceResolution = onCall({ region: REGION, enforceAppCheck: true }, async (req) => {
  const uid = uidOf(req);
  const d = req.data || {};
  const orderId = String(d.orderId || '').trim();
  if (!orderId) fail('invalid-argument', 'orderId is required.');
  const to = String(d.to || '').trim();

  const c = await loadCase(orderId, d.lineIndex);
  if (!c.res) fail('failed-precondition', 'No resolution has been authorised for that line.');

  const remedy = c.res.resolutionType;

  /* A REFUND IS NOT ADVANCED HERE. Its money is moved by processReturnRefund and confirmed
     by the provider; letting this endpoint touch it would be a second path to a payment. */
  if (RES.isMonetary(remedy)) {
    fail('failed-precondition', 'A refund is carried out by the refund process, not here.');
  }

  /* THE GUARD THAT MATTERS MOST. A logistics obligation must never be able to turn itself
     into a payment — checked before the transition table, so that even a table with a
     mistake in it cannot let a repair reach REFUNDED. */
  if (RES.crossesIntoMoney(remedy, to)) {
    fail('failed-precondition', 'That is not a step this resolution has.');
  }

  const move = RES.canTransition(c.res.resolutionStatus, to, remedy);
  if (!move.ok) {
    fail('failed-precondition', move.reason === 'ILLEGAL_TRANSITION'
      ? 'That resolution has already moved past that step.'
      : 'That is not a step this resolution has.');
  }

  const need = RES.actorFor(c.res.resolutionStatus, to, remedy);
  if (!need.ok) fail('failed-precondition', 'That step has no owner.');

  /* WHO THE CALLER IS, ESTABLISHED FROM THE DOCUMENTS. Never from the request. */
  const isSeller = uid === String(c.res.sellerUid || '');
  const isBuyer = uid === String(c.res.buyerUid || '');
  const isAdmin = _ac.isAdmin(req.auth.token);

  const permitted =
    (need.actor === RES.ACTOR.SELLER && (isSeller || isAdmin)) ||
    (need.actor === RES.ACTOR.BUYER && (isBuyer || isAdmin)) ||
    (need.actor === RES.ACTOR.ADMIN && isAdmin);

  if (!permitted) {
    fail('permission-denied', need.actor === RES.ACTOR.BUYER
      ? 'Only the buyer can confirm they received it.'
      : 'Only the seller can mark that step.');
  }

  const ref = db().collection(C_RESOLUTIONS).doc(c.resId);
  let out = null;

  await db().runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) fail('not-found', 'That resolution no longer exists.');
    const cur = snap.data() || {};

    /* RE-CHECKED INSIDE THE TRANSACTION. The state was read before the lock, so two
       confirmations racing would otherwise both pass the check above and both write. */
    const again = RES.canTransition(cur.resolutionStatus, to, cur.resolutionType);
    if (!again.ok) fail('failed-precondition', 'That resolution has already moved past that step.');

    txn.update(ref, {
      resolutionStatus: to,
      updatedAt: stamp(),
      timeline: FieldValue.arrayUnion({
        state: to,
        actor: uid,
        actorRole: need.actor,
        note: String(d.note || '').slice(0, 500) || null,
        at: new Date().toISOString(),
      }),
    });
    out = { ok: true, resolutionId: c.resId, status: to, terminal: again.terminal };
  });

  return out;
});

/* ═══ 3. resolutionCase — the whole story, for whoever is entitled to it ══════
   The dispute, the resolution and the milestones of THIS remedy, joined. A buyer looking
   at a replacement is never shown "Refunded" as a future step: the steps come from the
   branch, so a remedy cannot display a milestone it does not have. */
exports.resolutionCase = onCall({ region: REGION, enforceAppCheck: true }, async (req) => {
  const uid = uidOf(req);
  const d = req.data || {};
  const orderId = String(d.orderId || '').trim();
  if (!orderId) fail('invalid-argument', 'orderId is required.');

  const c = await loadCase(orderId, d.lineIndex);
  const buyer = buyerOf(c.order);
  const seller = sellerOf(c.order);
  const isAdmin = _ac.isAdmin(req.auth.token);
  if (uid !== buyer && uid !== seller && !isAdmin) {
    fail('permission-denied', 'That is not your order.');
  }

  if (!c.res) {
    return { ok: true, resolution: null,
             returnState: c.ret ? c.ret.state : null };
  }

  const remedy = c.res.resolutionType;

  /* THE REFUND BRANCH'S STATUS IS THE REFUND RAIL'S. Derived, never mirrored into this
     document — a copy of a money state is a second answer to "was this paid". */
  const status = RES.isMonetary(remedy)
    ? (c.ret && c.ret.state) || c.res.resolutionStatus
    : c.res.resolutionStatus;

  const ms = RES.milestones(remedy, status);

  /* WHAT EACH PARTY MAY DO NEXT, so a surface never has to work it out. */
  const next = RES.allowedNext(status, remedy);
  const actions = (next.ok ? next.next : []).map((t) => {
    const a = RES.actorFor(status, t, remedy);
    return a.ok ? { to: t, actor: a.actor } : null;
  }).filter(Boolean);

  return {
    ok: true,
    resolution: {
      id: c.res.id,
      orderId,
      lineIndex: c.res.lineIndex,
      productId: c.res.productId,
      disputeId: c.res.disputeId,
      resolutionType: remedy,
      resolutionStatus: status,
      monetary: RES.isMonetary(remedy),
      handover: c.res.handover,

      /* WHOSE COST THE RETURN WOULD BE. Shown to the parties because it is the thing they
         will otherwise argue about, and it was decided by the policy rather than by
         either of them. */
      sellerFault: c.res.sellerFault === true,
      returnDeliveryLiability: c.res.returnDeliveryLiability || null,
      policyVersion: c.res.policyVersion || null,

      timeline: Array.isArray(c.res.timeline) ? c.res.timeline : [],
    },
    milestones: ms.ok ? ms.steps : [],
    refused: ms.ok ? ms.refused : false,
    /* Only the actions belonging to THIS caller. Handing a buyer the seller's step would
       be an interface inviting a refusal. */
    actions: actions.filter((a) =>
      (a.actor === RES.ACTOR.SELLER && (uid === seller || isAdmin)) ||
      (a.actor === RES.ACTOR.BUYER && (uid === buyer || isAdmin)) ||
      (a.actor === RES.ACTOR.ADMIN && isAdmin)),
  };
});

module.exports.C_RESOLUTIONS = C_RESOLUTIONS;
module.exports._internal = { resolutionId, loadCase, buyerOf, sellerOf };
