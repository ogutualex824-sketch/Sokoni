/* ═══════════════════════════════════════════════════════════════════════════════════════════
   VENUE BOOKING PAYMENTS — the venue rail (owner decisions 2026-09-27: venue bookings are paid
   online through SOKONI at the 5 % Entertainment booking lane; the booking settles when the buyer
   SHOWS UP — the venue verifies the buyer's booking PIN).

     createPaymentIntent('venue_booking', bookingId)   priced HERE from the booking's server total
        → IntaSend STK → payments/{ref} COMPLETE
        → venueOnBookingPayment → entitlement-engine.activate (exactly once)
             booking paymentStatus 'paid'; venueSettlements/{ref} HELD (gross, provider fee, 5 %, net)
        → SHOW-UP: entertainment-bookings.verifyPin → settleOnShowUp → the venue owner's business
             wallet (wallets/{ownerId}) is credited the net; SOKONI's 5 % is collected. Never the buyer.
        → NO-SHOW: 24 h after the booking ends, with no refund request open → released to the owner
             (the reserved slot is forfeited, as the venue's policy states).

   REFUND POLICY (the venue's own terms, applied by the server — never a client amount):
     · the venue cancels / rejects a paid booking             → full refund
     · the buyer cancels ≥ cancellationWindowHours before start → full refund
     · the buyer cancels inside that window, before the start  → refund less the venue's
                                                                 cancellationFeeRate (the fee is paid
                                                                 to the venue, less SOKONI's 5 %)
     · after the start, or once the buyer has shown up         → no automatic refund (support dispute)
   Every refund is a REQUEST to the canonical refund authority (financial-os): reviewed, executed,
   and reversed here exactly once (onVenueRefundProcessed). There is no second refund writer.

   The generic webhook never credits anyone for this purpose (shared/self-settling-purposes).
   ═══════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';
const { HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const POLICY = require('./shared/commercial-policy');
const { providerFee } = require('./shared/provider-fee');

const REGION = 'us-central1';
const PURPOSE = 'venue_booking';
const _db = () => getFirestore();
let _now = () => Date.now();
const fail = (code, msg) => { throw new HttpsError(code, msg); };
const COL = Object.freeze({
  BOOKINGS: 'bookings', VENUES: 'venues', SETTLEMENTS: 'venueSettlements', COMMISSION: 'commissionLedger',
  WALLETS: 'wallets', WALLET_TX: 'walletTransactions', INTENTS: 'paymentIntents', EXCEPTIONS: 'venueExceptions',
  REFUNDS: 'fosRefundQueue', REQUESTS: 'venueRefundRequests',
});
const SETTLEMENT = Object.freeze({ HELD: 'HELD', FEE_UNREPORTED: 'FEE_UNREPORTED', RELEASED: 'RELEASED', REFUNDED: 'REFUNDED' });
const TERMINAL_PAID = new Set(['COMPLETE', 'COMPLETED', 'PAID', 'SUCCESS', 'SUCCESSFUL']);
const REFUND_OPEN = new Set(['pending', 'approved', 'processing', 'outcome_unknown', 'provider_succeeded', 'failed']);   /* same set as event-settlement */
const PAYMENT_WINDOW_MS = 30 * 60 * 1000;
const NO_SHOW_RELEASE_MS = 24 * 3600e3;

/* ═══ PRICER (payment-purposes) ═════════════════════════════════════════════════════════════ */
async function priceVenueBooking(uid, data) {
  const bookingId = String((data && data.bookingId) || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(bookingId)) fail('invalid-argument', 'bookingId is required.');
  const db = _db();
  const b = (await db.collection(COL.BOOKINGS).doc(bookingId).get()).data();
  if (!b || !b.venueId) fail('not-found', 'Booking not found.');
  if (b.customerId !== uid) fail('permission-denied', 'This booking is not yours to pay.');
  if (!['pending', 'confirmed'].includes(String(b.status))) fail('failed-precondition', `This booking is ${b.status}.`);
  if (b.paymentStatus === 'paid') fail('failed-precondition', 'This booking is already paid.');
  const venue = (await db.collection(COL.VENUES).doc(String(b.venueId)).get()).data();
  if (!venue || venue.ownerId !== b.ownerId) fail('failed-precondition', 'This venue cannot take payment.');
  if (venue.status && venue.status !== 'active') fail('failed-precondition', 'This venue is not taking bookings.');
  const total = b.pricingBreakdown && Number(b.pricingBreakdown.total);
  if (!Number.isFinite(total) || total <= 0) fail('failed-precondition', 'This booking has no amount to pay.');
  return {
    amountCents: Math.round(total * 100), currency: 'KES', resourceType: 'venueBooking', resourceId: bookingId,
    preferredRef: `VB-${bookingId}`,
    metadata: { type: PURPOSE, bookingId, venueId: b.venueId, ownerUid: b.ownerId },
  };
}

/* ═══ SETTLEMENT MATH — 5 % Entertainment booking lane; the provider fee is borne by the venue ═══ */
function computeSettlement({ grossCents, providerFeeCents }) {
  const g = Math.max(0, Math.round(Number(grossCents) || 0));
  const feeKnown = Number.isFinite(providerFeeCents);
  const c = POLICY.commissionCents('entertainment_booking', { grossCents: g, providerFeeCents: feeKnown ? providerFeeCents : 0 });
  return {
    grossCents: g, providerFeeCents: feeKnown ? providerFeeCents : null, feeKnown,
    commissionCents: c.commission, commissionBps: c.bps, policy: c.policy, rateSource: c.source, basis: c.basis,
    netCents: feeKnown ? Math.max(0, g - providerFeeCents - c.commission) : null,
  };
}

/* ═══ ENTITLEMENT ADAPTER ═══════════════════════════════════════════════════════════════════ */
const venueBookingAdapter = {
  async validate(ctx) {
    const id = String(ctx.resourceId || '');
    const b = id ? (await _db().collection(COL.BOOKINGS).doc(id).get()).data() : null;
    if (!b) { const e = new Error('booking missing'); e.code = 'booking_missing'; throw e; }
    if (b.customerId !== ctx.ownerUid) { const e = new Error('booking customer differs from payer'); e.code = 'ownership_mismatch'; throw e; }
    const expect = Math.round(Number(b.pricingBreakdown && b.pricingBreakdown.total) * 100);
    if (Number.isFinite(expect) && Number(ctx.amountCents) < expect) { const e = new Error('intent amount below booking total'); e.code = 'amount_short'; throw e; }
  },
  async activate(txn, ctx) {
    const db = _db();
    const id = String(ctx.resourceId);
    const bRef = db.collection(COL.BOOKINGS).doc(id);
    const setRef = db.collection(COL.SETTLEMENTS).doc(ctx.paymentRef);
    const [bSnap, sSnap] = await Promise.all([txn.get(bRef), txn.get(setRef)]);
    const b = bSnap.data();
    /* availability item (read before any write) */
    const AV = require('./ent-availability');
    const avRec = AV.planFromRecord(b.availability);
    const avSt = avRec ? await AV.readPlan(txn, avRec) : null;
    const fee = providerFee(ctx.payment || {});
    const s = computeSettlement({ grossCents: ctx.amountCents, providerFeeCents: fee.cents });
    /* A payment for a booking that was cancelled meanwhile is still honoured as money received: it is
       recorded and flagged for a refund, never silently kept. */
    const lateOnDead = ['cancelled', 'no_show'].includes(String(b.status));
    txn.update(bRef, { paymentStatus: 'paid', paymentId: ctx.paymentRef, paidAt: FieldValue.serverTimestamp(), requiresPayment: false, updatedAt: Date.now() });
    /* Payment authoritatively confirmed → the hold becomes a BOOKING (public: BOOKED). */
    if (avRec && !lateOnDead) AV.setKind(txn, avRec, avSt, 'B');
    if (!sSnap.exists) {
      txn.create(setRef, {
        paymentRef: ctx.paymentRef, bookingId: id, venueId: b.venueId, ownerUid: b.ownerId, customerUid: b.customerId,
        currency: ctx.currency || 'KES', ...s, providerFeeSource: fee.source,
        status: s.feeKnown ? SETTLEMENT.HELD : SETTLEMENT.FEE_UNREPORTED,
        releaseAfter: Number.isFinite(Number(b.endTs)) ? Timestamp.fromMillis(Number(b.endTs) + NO_SHOW_RELEASE_MS) : null,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      if (s.feeKnown) txn.create(db.collection(COL.COMMISSION).doc(`ven_${ctx.paymentRef}`), {
        ref: ctx.paymentRef, source: PURPOSE, category: 'entertainment_bookings', bookingId: id, uid: b.ownerId,
        policy: s.policy, basis: s.basis, rateSource: s.rateSource, commissionPct: s.commissionBps / 100, commissionCents: s.commissionCents,
        sokoniCut: s.commissionCents / 100, serviceTotal: s.grossCents / 100, providerFeeCents: s.providerFeeCents,
        providerNet: s.netCents / 100, status: 'held', createdAt: FieldValue.serverTimestamp(),
      });
    }
    if (lateOnDead) txn.set(db.collection(COL.EXCEPTIONS).doc(`late_payment_${ctx.paymentRef}`), { kind: 'payment_on_cancelled_booking', paymentRef: ctx.paymentRef, bookingId: id, status: 'OPEN', createdAt: FieldValue.serverTimestamp() });
    return { ref: `${COL.BOOKINGS}/${id}` };
  },
  async revoke(txn, led, reason) {
    const db = _db();
    const id = String(led.resourceId || '');
    const bRef = db.collection(COL.BOOKINGS).doc(id);
    const setRef = db.collection(COL.SETTLEMENTS).doc(led.paymentRef);
    const comRef = db.collection(COL.COMMISSION).doc(`ven_${led.paymentRef}`);
    const [bSnap, sSnap, cSnap] = await Promise.all([txn.get(bRef), txn.get(setRef), txn.get(comRef)]);
    const AV = require('./ent-availability');
    const avRec = bSnap.exists ? AV.planFromRecord(bSnap.data().availability) : null;
    const avSt = avRec ? await AV.readPlan(txn, avRec) : null;
    /* The refund was EXECUTED (this is the refund authority's revoke) — only now does the time reopen. */
    if (bSnap.exists) txn.update(bRef, { paymentStatus: 'refunded', status: 'cancelled', refundedAt: Date.now(), updatedAt: Date.now() });
    if (avRec) AV.release(txn, avRec, avSt);
    if (!sSnap.exists) return;
    const st = sSnap.data().status;
    if (st === SETTLEMENT.HELD || st === SETTLEMENT.FEE_UNREPORTED) {
      txn.update(setRef, { status: SETTLEMENT.REFUNDED, refundReason: String(reason || '').slice(0, 300), updatedAt: FieldValue.serverTimestamp() });
      if (cSnap.exists) txn.update(comRef, { status: 'reversed', reversedAt: FieldValue.serverTimestamp() });
    } else if (st === SETTLEMENT.RELEASED) {
      txn.set(db.collection(COL.EXCEPTIONS).doc(`refund_after_release_${led.paymentRef}`), { kind: 'refund_after_release', paymentRef: led.paymentRef, bookingId: id,
        ownerUid: sSnap.data().ownerUid || null, netCents: sSnap.data().netCents || null, reason: String(reason || '').slice(0, 300), status: 'OPEN', createdAt: FieldValue.serverTimestamp() });
    }
  },
  async status(ctx) { const b = (await _db().collection(COL.BOOKINGS).doc(String(ctx.resourceId)).get()).data(); return b ? { paymentStatus: b.paymentStatus, status: b.status } : null; },
};

function registerPurpose() {
  const engine = require('./entitlement-engine');
  if (!engine.getPurpose(PURPOSE)) engine.registerPurpose(PURPOSE, { resourceType: 'venueBooking', handler: venueBookingAdapter, expiresDays: null, refundable: true });
  return engine;
}

async function activateIfVenueBooking(paymentRef) {
  const ref = String(paymentRef || '').trim();
  const intent = ref ? (await _db().collection(COL.INTENTS).doc(ref).get()).data() : null;
  if (!intent || intent.purpose !== PURPOSE) return { skipped: 'other_purpose' };
  const engine = registerPurpose();
  try {
    const r = await engine.activate(ref, { source: 'payment-trigger' });
    return r && r.alreadyActive ? { alreadyActive: true } : { activated: true };
  } catch (e) {
    logger.warn('[venuePayments] activation refused', { ref, code: e.code || null, error: e.message });
    await _db().collection(COL.EXCEPTIONS).doc(`activation_${ref}`).set({ kind: 'activation_refused', paymentRef: ref, code: e.code || 'unknown', detail: String(e.message).slice(0, 300), status: 'OPEN', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    return { refused: true, code: e.code || 'unknown' };
  }
}

const venueOnBookingPayment = onDocumentWritten({ document: 'payments/{paymentId}', region: REGION }, async (event) => {
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  if (!after) return;
  const was = TERMINAL_PAID.has(String((before && before.status) || '').toUpperCase());
  const is = TERMINAL_PAID.has(String(after.status || '').toUpperCase());
  if (is && !was) await activateIfVenueBooking(event.params.paymentId);
});

/* ═══ RELEASE — to the venue owner's business wallet ════════════════════════════════════════ */
async function _release(paymentRef, trigger, guard) {
  const db = _db();
  const setRef = db.collection(COL.SETTLEMENTS).doc(String(paymentRef));
  return db.runTransaction(async (txn) => {
    const sSnap = await txn.get(setRef);
    if (!sSnap.exists) return { skipped: 'no_settlement' };
    const s = sSnap.data();
    if (s.status !== SETTLEMENT.HELD) return { skipped: `status_${s.status}` };
    const [bSnap, refSnap] = await Promise.all([
      txn.get(db.collection(COL.BOOKINGS).doc(String(s.bookingId))),
      txn.get(db.collection(COL.REFUNDS).doc(`ref_${paymentRef}`)),
    ]);
    const b = bSnap.exists ? bSnap.data() : null;
    if (refSnap.exists && REFUND_OPEN.has(String(refSnap.data().status))) return { skipped: 'refund_open' };
    const why = guard ? guard(b, s) : null;
    if (why) return { skipped: why };
    const wRef = db.collection(COL.WALLETS).doc(s.ownerUid);
    const wSnap = await txn.get(wRef);
    const net = Math.max(0, Number(s.netCents) || 0);
    const shillings = Math.floor(net / 100);
    const txRef = db.collection(COL.WALLET_TX).doc(`${s.ownerUid}_${paymentRef}_venue`);
    if (shillings > 0) {
      if (wSnap.exists) txn.update(wRef, { balance: FieldValue.increment(shillings), updatedAt: FieldValue.serverTimestamp() });
      else txn.set(wRef, { uid: s.ownerUid, balance: shillings, currency: 'KES', createdAt: FieldValue.serverTimestamp() }, { merge: true });
      txn.create(txRef, { uid: s.ownerUid, type: 'venue_booking_earning', amount: shillings, paymentRef, bookingId: s.bookingId, trigger,
        description: `Venue booking — ${s.bookingId}`, status: 'completed', createdAt: FieldValue.serverTimestamp() });
    }
    txn.update(setRef, { status: SETTLEMENT.RELEASED, releasedAt: FieldValue.serverTimestamp(), releasedBy: trigger, creditedKES: shillings,
      roundingRemainderCents: net - shillings * 100, walletTxId: shillings > 0 ? txRef.id : null, updatedAt: FieldValue.serverTimestamp() });
    txn.set(db.collection(COL.COMMISSION).doc(`ven_${paymentRef}`), { status: 'collected', collectedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { released: true, credited: shillings, ownerUid: s.ownerUid };
  });
}

/** SHOW-UP: the venue verified the buyer's booking PIN (entertainment-bookings.verifyPin). */
async function settleOnShowUp(bookingId) {
  const b = (await _db().collection(COL.BOOKINGS).doc(String(bookingId)).get()).data();
  if (!b || b.paymentStatus !== 'paid' || !b.paymentId) return { skipped: 'not_paid' };
  return _release(b.paymentId, 'show_up', (bk) => (!bk || bk.paymentStatus !== 'paid' ? 'not_paid' : (['cancelled'].includes(String(bk.status)) ? 'cancelled' : null)));
}

/** NO-SHOW: 24 h after the booking ended, never verified, no refund open → the owner is paid. */
async function releaseNoShow(paymentRef, nowMs) {
  return _release(paymentRef, 'no_show', (bk, s) => {
    if (!bk || bk.paymentStatus !== 'paid') return 'not_paid';
    if (String(bk.status) === 'cancelled') return 'cancelled';
    const due = s.releaseAfter && typeof s.releaseAfter.toMillis === 'function' ? s.releaseAfter.toMillis() : null;
    if (due == null || nowMs < due) return 'not_due';
    return null;
  });
}

/* ═══ REFUND POLICY — the request goes to the canonical refund authority ════════════════════ */
function refundQuote(b, venue, nowMs, by) {
  const total = Number(b.pricingBreakdown && b.pricingBreakdown.total) || 0;
  if (b.paymentStatus !== 'paid') return { eligible: false, reason: 'This booking has not been paid.' };
  if (by === 'owner') return { eligible: true, refundKes: total, feeKes: 0, rule: 'venue_cancelled' };
  const startMs = Number(b.startTs);
  if (Number.isFinite(startMs) && nowMs >= startMs) return { eligible: false, reason: 'The booking has started. Contact SOKONI support if something went wrong.' };
  const windowH = Number(b.cancellationWindowHours != null ? b.cancellationWindowHours : (venue && venue.pricing && venue.pricing.cancellationWindow)) || 24;
  const rate = Math.min(1, Math.max(0, Number(b.cancellationFeeRate != null ? b.cancellationFeeRate : 0) || 0));
  if (nowMs <= startMs - windowH * 3600e3) return { eligible: true, refundKes: total, feeKes: 0, rule: 'before_window' };
  const feeKes = Math.round(total * (rate > 1 ? rate / 100 : rate));
  return { eligible: true, refundKes: Math.max(0, total - feeKes), feeKes, rule: 'inside_window' };
}

/** BUYER (or the venue owner) requests a refund of a paid booking — priced by the policy above. */
async function requestRefund(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const uid = req.auth.uid; const d = req.data || {};
  const bookingId = String(d.bookingId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(bookingId)) fail('invalid-argument', 'bookingId is required.');
  const reason = String(d.reason || '').trim().slice(0, 300);
  if (reason.length < 5) fail('invalid-argument', 'Tell us why (at least 5 characters).');
  const db = _db();
  const b = (await db.collection(COL.BOOKINGS).doc(bookingId).get()).data();
  if (!b) fail('not-found', 'Booking not found.');
  const by = uid === b.customerId ? 'buyer' : (uid === b.ownerId ? 'owner' : null);
  if (!by) fail('not-found', 'Booking not found.');
  const env = (await db.collection('entBookings').doc(`ven_${bookingId}`).get()).data();
  if (env && env.verification && env.verification.state === 'VERIFIED') fail('failed-precondition', 'This booking was used (the PIN was verified at check-in). Contact SOKONI support.');
  const venue = (await db.collection(COL.VENUES).doc(String(b.venueId)).get()).data();
  const q = refundQuote(b, venue, _now(), by);
  if (!q.eligible) fail('failed-precondition', q.reason);
  const reqRef = db.collection(COL.REQUESTS).doc(bookingId);
  await db.runTransaction(async (txn) => {
    const cur = await txn.get(reqRef);
    if (cur.exists && !['REJECTED'].includes(cur.data().status)) fail('already-exists', 'A refund has already been requested for this booking.');
    txn.set(reqRef, { bookingId, paymentRef: b.paymentId, requestedBy: uid, by, reason, rule: q.rule, originalKes: q.refundKes + q.feeKes, feeKes: q.feeKes,
      refundKes: q.refundKes, status: 'SUBMITTING', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  });
  let fos;
  try {
    fos = await require('./financial-os')._internal.submitRefund({ ...req, data: { payRef: b.paymentId, amountKES: q.refundKes, reason: `[venue:${q.rule}] ${reason}`, refundType: q.feeKes > 0 ? 'partial' : 'full' } },
      { via: 'venue_booking', onBehalfOfBuyer: b.customerId });
  } catch (e) { await reqRef.delete().catch(() => {}); throw e; }
  await reqRef.update({ status: 'PENDING_REVIEW', fosRefundId: fos.refundId || null, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true, bookingId, refundKes: q.refundKes, feeKes: q.feeKes, rule: q.rule, status: 'PENDING_REVIEW' };
}

/** Called by financial-os once a refund EXECUTED. Full → revoke; partial → the kept fee is released
 *  to the venue (the booking will not happen). Exactly once through the engine. Never throws. */
async function onVenueRefundProcessed({ payRef, amountCents }) {
  try {
    const intent = (await _db().collection(COL.INTENTS).doc(String(payRef)).get()).data();
    if (!intent || intent.purpose !== PURPOSE) return { skipped: 'other_purpose' };
    const engine = registerPurpose();
    const setRef = _db().collection(COL.SETTLEMENTS).doc(String(payRef));
    const s = (await setRef.get()).data();
    const gross = s ? Number(s.grossCents) : null;
    const reqRef = _db().collection(COL.REQUESTS).doc(String(intent.resourceId));
    if (s && Number.isFinite(gross) && Number(amountCents) < gross && s.status === SETTLEMENT.HELD) {
      const kept = gross - Number(amountCents);
      const k = computeSettlement({ grossCents: kept, providerFeeCents: s.providerFeeCents });
      await setRef.update({ grossCents: kept, commissionCents: k.commissionCents, netCents: k.netCents, originalGrossCents: gross,
        refundedCents: Number(amountCents), keptFeeCents: kept, updatedAt: FieldValue.serverTimestamp() });
      await _cancelAndRelease(String(intent.resourceId), { status: 'cancelled', paymentStatus: 'partially_refunded', updatedAt: Date.now() });
      await _release(payRef, 'cancellation_fee', null);
    } else {
      await engine.revoke(payRef, 'refund_processed');
    }
    await reqRef.set({ status: 'REFUNDED', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true };
  } catch (e) { logger.error('[venuePayments] refund hook failed', { payRef, err: e.message }); return { error: e.message }; }
}

/* A venue booking becomes cancelled and its availability item is released in ONE transaction
   (skip(cur) → true leaves it untouched). Returns true when it changed the booking. */
async function _cancelAndRelease(bookingId, patch, skip) {
  const AV = require('./ent-availability');
  const ref = _db().collection(COL.BOOKINGS).doc(String(bookingId));
  let changed = false;
  await _db().runTransaction(async (txn) => {
    changed = false;
    const s = await txn.get(ref);
    if (!s.exists) return;
    const cur = s.data();
    const avRec = AV.planFromRecord(cur.availability);
    const avSt = avRec ? await AV.readPlan(txn, avRec) : null;
    if (skip && skip(cur)) return;
    txn.update(ref, patch);
    txn.delete(_db().collection('venues').doc(String(cur.venueId)).collection('slotLocks').doc(`${cur.date}_${cur.startTs}_${cur.endTs}`));
    if (avRec) AV.release(txn, avRec, avSt);
    changed = true;
  });
  return changed;
}

/* ═══ SWEEP — expire unpaid holds; pay no-show bookings to the venue ════════════════════════ */
async function sweep(nowMs = _now()) {
  const db = _db();
  let expired = 0; let released = 0;
  const unpaid = await db.collection(COL.BOOKINGS).where('requiresPayment', '==', true).limit(200).get();
  for (const d of unpaid.docs) {
    const b = d.data();
    if (b.paymentStatus === 'paid' || !['pending', 'confirmed'].includes(String(b.status))) continue;
    if (Number(b.paymentDueBy) && nowMs > Number(b.paymentDueBy)) {
      /* A payment still in flight keeps the slot protected — the webhook's answer decides. */
      if (await require('./ent-availability').paymentInFlight(d.id)) continue; // eslint-disable-line no-await-in-loop
      const r = await _cancelAndRelease(d.id, { status: 'cancelled', cancelReason: 'unpaid', cancelledBy: 'system', requiresPayment: false, updatedAt: nowMs }, // eslint-disable-line no-await-in-loop
        (cur) => cur.paymentStatus === 'paid' || !['pending', 'confirmed'].includes(String(cur.status)));
      if (r) expired++;
    }
  }
  const held = await db.collection(COL.SETTLEMENTS).where('status', '==', SETTLEMENT.HELD).where('releaseAfter', '<=', Timestamp.fromMillis(nowMs)).limit(200).get();
  for (const d of held.docs) { const r = await releaseNoShow(d.id, nowMs); if (r.released) released++; } // eslint-disable-line no-await-in-loop
  return { expired, released };
}
const venuePaymentSweep = onSchedule({ schedule: 'every 15 minutes', timeZone: 'Africa/Nairobi', region: REGION }, async () => {
  const r = await sweep(); logger.info('[venuePayments] sweep', r);
});

const _h = { venueRequestRefund: requestRefund };

module.exports = {
  PURPOSE, COL, SETTLEMENT, PAYMENT_WINDOW_MS, NO_SHOW_RELEASE_MS, priceVenueBooking, computeSettlement, venueBookingAdapter,
  registerPurpose, activateIfVenueBooking, settleOnShowUp, releaseNoShow, refundQuote, requestRefund, onVenueRefundProcessed, sweep,
  venueOnBookingPayment, venuePaymentSweep, _h, _setClock: (fn) => { _now = fn || (() => Date.now()); },
};
