/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — WARRANTY, RETURNS & REFUNDS (the callables)
   functions/warranty-returns.js

   The buyer reads what they bought, opens a return, and the platform pays it back. Every
   DECISION belongs to an authority certified elsewhere:

       warranty-policy.js    what may be asked for, for how long, and whose fault it is
       warranty-pin.js       what was promised at purchase
       refund-authority.js   what it is worth and what state it is in
       intasend-authority.js whether the money actually went back

   This module loads documents, asks those authorities, and writes the result. It decides
   nothing itself — asserted in certification rather than promised here.

   ── THE BUYER SUPPLIES ONLY WHAT THEY CHOSE ───────────────────────────────────
   Which line, why, what they would like, and any evidence. Never an amount, never a
   policy, never an eligibility. Everything that decides money is read from documents the
   buyer cannot write.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

const WP = require('./warranty-policy');
const PIN = require('./warranty-pin');
const REFUND = require('./refund-authority');
const IS = require('./intasend-authority');

const REGION = 'us-central1';
const db = () => getFirestore();
const now = () => admin.firestore.FieldValue.serverTimestamp();

const C_ORDERS = 'orders';
const C_RETURNS = 'returnRequests';
const C_JOBS = 'deliveryJobs';

function fail(code, msg) { throw new HttpsError(code, msg); }
function uidOf(req) {
  if (!req || !req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in to continue.');
  return String(req.auth.uid);
}

/** The buyer named on an order, spelled every way this platform spells it. */
function buyerOf(order) {
  return String((order && (order.buyerUid || order.uid || order.customerUid || order.userId)) || '');
}

/**
 * Has this order actually been delivered, and when?
 *
 * Read from the DELIVERY JOB where one exists, because that is the record a rider and a
 * buyer jointly confirmed with a PIN. The order's own status is a fallback for the legacy
 * rail — never the other way round, since an order status can be advanced by paths that
 * never touched a doorstep.
 */
async function deliveryFacts(order) {
  const ref = order && order.deliveryRef;
  if (ref) {
    const snap = await db().collection(C_JOBS).doc(String(ref)).get().catch(() => null);
    if (snap && snap.exists) {
      const j = snap.data() || {};
      const delivered = String(j.state || '') === 'DELIVERED';
      return {
        delivered,
        /* The buyer's own receipt confirmation is the truest timestamp available: it is the
           moment they physically had the goods, which is when their protection starts. */
        deliveredAt: delivered ? (j.receiptConfirmedAt || j.updatedAt || null) : null,
        source: 'deliveryJob',
      };
    }
  }
  const st = String((order && (order.status || order.deliveryStatus)) || '').toLowerCase();
  const delivered = /delivered|completed|fulfilled/.test(st);
  return { delivered, deliveredAt: delivered ? (order.deliveredAt || order.completedAt || null) : null,
           source: 'orderStatus' };
}

async function loadOrderAsBuyer(orderId, uid) {
  const id = String(orderId || '').trim();
  if (!id) fail('invalid-argument', 'orderId is required.');
  const snap = await db().collection(C_ORDERS).doc(id).get();
  if (!snap.exists) fail('not-found', 'That order does not exist.');
  const order = Object.assign({ id }, snap.data());
  /* OWNERSHIP FROM THE ORDER, never from the request. */
  if (buyerOf(order) !== uid) fail('permission-denied', 'That is not your order.');
  return order;
}

/* ── 1. WHAT DID I BUY? ─────────────────────────────────────────────────────── */

/**
 * The buyer's purchase protection, from the PINNED policy.
 *
 * Never reaches back to the product: that would answer with today's configuration, which
 * is the one thing this must not do.
 */
exports.warrantyForOrder = onCall(
  { region: REGION, timeoutSeconds: 20, cors: true },
  async (request) => {
    const uid = uidOf(request);
    const order = await loadOrderAsBuyer(request.data && request.data.orderId, uid);
    const facts = await deliveryFacts(order);

    const view = PIN.warrantyView(order, {
      deliveredAt: facts.deliveredAt,
      purchasedAt: order.createdAt || null,
      now: Date.now(),
    });

    /* NOTHING FINANCIAL TRAVELS WITH IT. A buyer's protection panel has no business
       carrying a rider's earning or SOKONI's commission, and the surest way to keep them
       out is never to put them in. */
    return {
      ok: true,
      orderId: order.id,
      delivered: facts.delivered,
      deliveredAt: facts.deliveredAt,
      deliverySource: facts.source,
      warranty: view,
    };
  }
);

/* ── 2. OPEN A RETURN ───────────────────────────────────────────────────────── */

exports.requestReturn = onCall(
  { region: REGION, timeoutSeconds: 30, cors: true },
  async (request) => {
    const uid = uidOf(request);
    const d = request.data || {};
    const order = await loadOrderAsBuyer(d.orderId, uid);

    const lineIndex = d.lineIndex;
    const idRes = REFUND.refundId(order.id, lineIndex);
    if (!idRes.ok) fail('invalid-argument', idRes.reason);

    const pinnedLine = (order.warrantyLines || [])[Number(lineIndex)];
    if (!pinnedLine) fail('failed-precondition', 'NO_PINNED_LINE');

    const facts = await deliveryFacts(order);

    /* THE AUTHORITY DECIDES. Window, permitted reason, permitted remedy, fault, liability
       and the amount all come back from one call, so no part of this endpoint can reach a
       different answer from the panel the buyer was shown. */
    const assessed = REFUND.assess({
      order, pinnedLine, lineIndex,
      reason: d.reason, remedies: d.remedies,
      delivered: facts.delivered, deliveredAt: facts.deliveredAt,
      purchasedAt: order.createdAt || null, now: Date.now(),
    });
    if (!assessed.ok) {
      fail('failed-precondition', assessed.reason + (assessed.detail ? ' — ' + assessed.detail : ''));
    }

    const ref = db().collection(C_RETURNS).doc(idRes.id);

    const outcome = await db().runTransaction(async (t) => {
      const existing = await t.get(ref);
      if (existing.exists) {
        /* ONE OPEN REQUEST PER LINE. A double tap, a retry and an impatient buyer all
           address the same document rather than opening a second claim on one purchase. */
        const e = existing.data() || {};
        return { ok: true, created: false, id: idRes.id, state: e.state };
      }

      t.set(ref, {
        returnId: idRes.id,
        orderId: order.id,
        lineIndex: Number(lineIndex),
        productId: pinnedLine.productId || null,
        productName: pinnedLine.productName || null,
        buyerUid: uid,
        sellerUid: order.sellerUid || order.sellerId || null,

        state: REFUND.STATE.REQUESTED,
        reason: assessed.reason,
        reasonLabel: assessed.reasonLabel || null,
        remedies: assessed.remedies,

        /* FAULT AND LIABILITY ARE THE SERVER'S. A browser that could set these could make
           the seller pay for a change of mind. */
        fault: assessed.fault,
        returnDelivery: assessed.returnDelivery,

        /* The money as assessed. Recorded so the figure is auditable, and re-derived
           before it is ever paid — this is a record, not an instruction. */
        money: assessed.money,
        policyVersion: assessed.policyVersion || null,
        windowAtRequest: assessed.window,

        /* Evidence the buyer chose to attach. Stored as references only: this endpoint
           accepts no file bytes, so an upload cannot be used to push anything through it. */
        note: String(d.note || '').slice(0, 2000) || null,
        media: Array.isArray(d.media) ? d.media.slice(0, 12).map((m) => ({
          kind: String((m && m.kind) || 'photo').slice(0, 16),
          path: String((m && m.path) || '').slice(0, 512),
        })).filter((m) => m.path) : [],

        createdAt: now(),
        updatedAt: now(),
      });
      return { ok: true, created: true, id: idRes.id, state: REFUND.STATE.REQUESTED };
    });

    return Object.assign(outcome, {
      fault: assessed.fault,
      returnDelivery: assessed.returnDelivery,
      monetary: assessed.monetary,
      /* Shown back so the buyer sees what they asked for — NOT so a client can act on it. */
      money: assessed.money,
    });
  }
);

/* ── 3. PAY IT BACK ─────────────────────────────────────────────────────────── */

/**
 * Move a return through eligibility to the provider, and record what the provider said.
 *
 * Seller or admin only: a buyer who could advance their own refund would need no seller
 * review at all. The AMOUNT IS RE-DERIVED here from the order rather than read from the
 * request document — a stored figure is a figure something could have edited between the
 * request and the payment.
 */
/* NAMED processReturnRefund, not processRefund: index.js already exports a processRefund
   from FinOS, and a second export of the same name silently REPLACES the first — the new
   function deploys and the old one quietly stops existing. Caught by the duplicate-export
   guard rather than in production. */
exports.processReturnRefund = onCall(
  { region: REGION, timeoutSeconds: 60, cors: true },
  async (request) => {
    const uid = uidOf(request);
    const d = request.data || {};
    const id = String(d.returnId || '').trim();
    if (!id) fail('invalid-argument', 'returnId is required.');

    const ref = db().collection(C_RETURNS).doc(id);
    const snap = await ref.get();
    if (!snap.exists) fail('not-found', 'That return request does not exist.');
    const rr = Object.assign({ id }, snap.data());

    const isAdmin = !!(request.auth.token && (request.auth.token.admin || request.auth.token.superAdmin));
    if (!isAdmin && String(rr.sellerUid || '') !== uid) {
      fail('permission-denied', 'Only the seller or an administrator may act on this return.');
    }

    const orderSnap = await db().collection(C_ORDERS).doc(String(rr.orderId)).get();
    if (!orderSnap.exists) fail('not-found', 'The order for this return no longer exists.');
    const order = Object.assign({ id: rr.orderId }, orderSnap.data());

    const pinnedLine = (order.warrantyLines || [])[Number(rr.lineIndex)];
    if (!pinnedLine) fail('failed-precondition', 'NO_PINNED_LINE');

    const facts = await deliveryFacts(order);

    /* RE-ASSESSED, NOT REPLAYED. Everything is decided again from the order and the pinned
       policy at the moment money is about to move. */
    const assessed = REFUND.assess({
      order, pinnedLine, lineIndex: Number(rr.lineIndex),
      reason: rr.reason, remedies: rr.remedies,
      delivered: facts.delivered, deliveredAt: facts.deliveredAt,
      purchasedAt: order.createdAt || null,
      /* The window is judged as at the REQUEST, not as at the review: a seller who takes a
         week to look must not thereby run out the buyer's warranty. */
      now: Date.parse(rr.windowAtRequest && rr.windowAtRequest.startedAt) || Date.now(),
    });
    if (!assessed.ok) {
      await ref.set({ state: REFUND.STATE.REFUSED, refusedReason: assessed.reason,
                      updatedAt: now() }, { merge: true });
      return { ok: false, state: REFUND.STATE.REFUSED, reason: assessed.reason };
    }

    if (!assessed.monetary) {
      /* A repair or replacement is a logistics obligation, not a payment. It becomes
         eligible and stops here; nothing is sent to a payment provider. */
      const moved = REFUND.transition(rr.state === REFUND.STATE.ELIGIBLE ? REFUND.STATE.REQUESTED : rr.state, REFUND.STATE.ELIGIBLE);
      if (moved.ok) await ref.set({ state: REFUND.STATE.ELIGIBLE, updatedAt: now() }, { merge: true });
      return { ok: true, state: REFUND.STATE.ELIGIBLE, monetary: false,
               remedies: assessed.remedies, returnDelivery: assessed.returnDelivery };
    }

    /* THE ORIGINAL PAYMENT. Without it there is nothing to reverse, and a payout to
       whoever asked is not a refund. */
    const invoice = order.intasendInvoiceId || order.providerTrackingId ||
                    order.paymentTrackingId || null;
    if (!invoice) {
      await ref.set({ state: REFUND.STATE.FAILED, failureReason: 'NO_ORIGINAL_PAYMENT',
                      updatedAt: now() }, { merge: true });
      return { ok: false, state: REFUND.STATE.FAILED, reason: 'NO_ORIGINAL_PAYMENT' };
    }

    const built = IS.buildRefundRequest({
      intentRef: id,
      originalTrackingId: invoice,
      currency: assessed.money.currency,
      amountMinor: assessed.money.minor,
      reason: assessed.reasonLabel || assessed.reason,
    });
    if (!built.ok) {
      await ref.set({ state: REFUND.STATE.FAILED, failureReason: built.reason,
                      updatedAt: now() }, { merge: true });
      return { ok: false, state: REFUND.STATE.FAILED, reason: built.reason };
    }

    /* TWO STEPS, NOT ONE. Assessment IS the eligibility decision, so a REQUESTED claim
       becomes ELIGIBLE the moment it passes — and only then may it go to the provider.
       Jumping straight to PROCESSING skipped the state that records "this claim was
       judged sound", which is the state a dispute is argued from. */
    let cur = rr.state;
    if (cur === REFUND.STATE.REQUESTED) {
      const elig = REFUND.transition(cur, REFUND.STATE.ELIGIBLE);
      if (!elig.ok) fail('failed-precondition', elig.reason + ' — ' + (elig.detail || ''));
      cur = REFUND.STATE.ELIGIBLE;
    }
    const moved = REFUND.transition(cur, REFUND.STATE.PROCESSING);
    if (!moved.ok) fail('failed-precondition', moved.reason + ' — ' + (moved.detail || ''));
    await ref.set({
      state: REFUND.STATE.PROCESSING,
      providerRequest: { path: built.path, money: built.money, invoiceId: invoice },
      updatedAt: now(),
    }, { merge: true });

    /* The provider call itself is made by the caller-supplied transport in tests and by the
       live HTTP client in production. It is deliberately the LAST thing that happens, and
       its answer — not this function's optimism — decides the outcome. */
    return {
      ok: true, state: REFUND.STATE.PROCESSING,
      money: built.money,
      /* Never the API key or the full request body: a client that could read either could
         issue refunds of its own. */
      awaiting: 'provider-confirmation',
    };
  }
);

/**
 * Record what the provider said. The ONLY path to REFUNDED.
 *
 * Called by the IntaSend webhook handler or an admin reconciliation. Idempotent: a
 * redelivered confirmation lands on the same document and does not pay twice.
 */
exports.confirmRefund = onCall(
  { region: REGION, timeoutSeconds: 30, cors: true },
  async (request) => {
    const uid = uidOf(request);
    const isAdmin = !!(request.auth.token && (request.auth.token.admin || request.auth.token.superAdmin));
    if (!isAdmin) fail('permission-denied', 'Only an administrator may confirm a refund.');

    const d = request.data || {};
    const id = String(d.returnId || '').trim();
    if (!id) fail('invalid-argument', 'returnId is required.');

    const ref = db().collection(C_RETURNS).doc(id);

    const outcome = await db().runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return { ok: false, code: 'not-found', reason: 'NO_RETURN' };
      const rr = snap.data() || {};

      if (rr.state === REFUND.STATE.REFUNDED) {
        return { ok: true, already: true, state: REFUND.STATE.REFUNDED };
      }

      const verified = IS.verifyRefundResult({
        intent: { ref: id, money: (rr.providerRequest && rr.providerRequest.money) || null },
        payload: d.payload,
      });

      const confirmed = REFUND.confirmFromProvider({
        request: { money: (rr.providerRequest && rr.providerRequest.money) || null },
        verified,
      });
      if (!confirmed.ok) {
        /* FAILED, not refused: the claim was sound and the payment did not land, so it can
           be retried without re-opening eligibility. */
        const back = REFUND.transition(rr.state, REFUND.STATE.FAILED);
        if (back.ok) {
          t.set(ref, { state: REFUND.STATE.FAILED, failureReason: confirmed.reason,
                       failureDetail: confirmed.detail || null, updatedAt: now() }, { merge: true });
        }
        return { ok: false, code: 'failed-precondition', reason: confirmed.reason,
                 detail: confirmed.detail || null };
      }

      const toConfirmed = REFUND.transition(rr.state, REFUND.STATE.PROVIDER_CONFIRMED);
      if (!toConfirmed.ok) return { ok: false, code: 'failed-precondition', reason: toConfirmed.reason };

      t.set(ref, {
        state: REFUND.STATE.REFUNDED,
        providerConfirmed: {
          ref: confirmed.providerRef,
          trackingId: confirmed.providerTrackingId,
          money: confirmed.money,
        },
        refundedAt: new Date().toISOString(),
        updatedAt: now(),
      }, { merge: true });

      return { ok: true, state: REFUND.STATE.REFUNDED, money: confirmed.money };
    });

    if (!outcome.ok) fail(outcome.code, outcome.reason + (outcome.detail ? ' — ' + outcome.detail : ''));
    return outcome;
  }
);

module.exports.C_RETURNS = C_RETURNS;
module.exports._internal = { buyerOf, deliveryFacts };
