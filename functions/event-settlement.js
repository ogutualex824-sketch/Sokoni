'use strict';
/**
 * SOKONI — Event ticket payment → entitlement → settlement → refund.
 * ============================================================================================
 * event-hub.js priced ticket orders and reserved inventory, then redirected the buyer to a
 * checkout that never read the order. Nothing ever moved an order from `pending_payment` to
 * `paid` or a ticket from `awaiting_payment` to `valid`, so only free tickets worked; nothing
 * settled the organizer; `cancelEvent`'s `pending_refund` had no consumer; and unpaid orders
 * held their seats for ever.
 *
 * This module closes that chain on the CANONICAL rails — no parallel payment or refund path:
 *
 *   purchaseTickets (event-hub)          reserve seats, write eventOrders/{orderId}
 *   createPaymentIntent('event_ticket')  server prices the ORDER (payment-purposes.js),
 *                                        ref = orderId
 *   initiateSTKPush / hosted checkout    capability-gated, single-flight
 *   webhook → payments/{ref} COMPLETE    webhook EXITS before its generic seller credit
 *                                        (shared/self-settling-purposes.js)
 *   eventOnTicketPayment (trigger)       entitlement-engine.activate(ref) — exactly once
 *     └ eventTicketAdapter.activate      order paid · tickets valid · settlement HELD ·
 *                                        commission booked — ONE transaction
 *   eventReleaseSettlements (schedule)   after the event: organizer wallet credit, exactly once
 *   fos* refund (financial-os)           → onEventRefundProcessed → engine.revoke(ref)
 *
 * COMMERCIAL POLICY: shared/commercial-policy.js `event_ticket` — 3 % (commission-config
 * RATES.event_tickets) on the NET-OF-PROVIDER-FEE basis, as authorized 2026-09-26:
 *     ticket sale − provider fee = net;  SOKONI 3 % of net;  organizer = net − commission.
 * An unreported provider fee is never assumed to be zero: the tickets still activate (the buyer
 * paid), but the settlement is FEE_UNREPORTED and releases nothing until a super admin attests
 * the fee with evidence.
 *
 * WHY HELD UNTIL AFTER THE EVENT. A cancelled event refunds its buyers. If the organizer were
 * credited at purchase, every cancellation refund would have to claw money back out of a
 * wallet that may already be withdrawn. Holding until the event has happened means a
 * cancellation refund reverses a settlement that never left the platform.
 */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { TERMINAL_PAID } = require('./shared/constants');
const { providerFee } = require('./shared/provider-fee');
const POLICY = require('./shared/commercial-policy');
const AC = require('./admin-claim');
const OPS = require('./event-ops');

const REGION = 'us-central1';
const PURPOSE = 'event_ticket';
const _db = () => getFirestore();

const COL = Object.freeze({
  ORDERS: 'eventOrders', TICKETS: 'eventTickets', TIERS: 'eventTicketTiers', EVENTS: 'events',
  SETTLEMENTS: 'eventSettlements', EXCEPTIONS: 'eventExceptions', COMMISSION: 'commissionLedger',
  WALLETS: 'wallets', WALLET_TX: 'walletTransactions', REFUNDS: 'fosRefundQueue',
  INTENTS: 'paymentIntents', PAYMENTS: 'payments', ADMIN_AUDIT: 'adminAudit', OVERSOLD: 'oversoldAlerts',
});

const SETTLEMENT = Object.freeze({
  HELD: 'HELD',                       /* fee known, waiting for the event to pass */
  FEE_UNREPORTED: 'FEE_UNREPORTED',   /* fee unknown — releases nothing until attested */
  RELEASED: 'RELEASED',               /* organizer credited — terminal */
  REFUNDED: 'REFUNDED',               /* reversed before release — terminal */
});

/* How long after the event's end (or start, when no end is set) before the organizer is paid. */
const RELEASE_GRACE_MS = 24 * 60 * 60 * 1000;
/* An unpaid order older than this releases its seats. The intent TTL is 15 min; the margin
   covers an STK prompt the buyer is still answering. */
const UNPAID_ORDER_TTL_MS = 45 * 60 * 1000;
/* A refund request in any of these states means "money may be going back" — never release. */
const REFUND_OPEN = new Set(['pending', 'approved', 'processing', 'outcome_unknown', 'provider_succeeded', 'failed']);

function _fail(code, msg) { throw new HttpsError(code, msg); }
const _ms = (v) => { if (!v) return null; if (typeof v.toMillis === 'function') return v.toMillis(); const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };

/** When may this event's settlements be released? Pure. */
function releaseAfterMs(ev) {
  const end = _ms(ev && ev.endDate) || _ms(ev && ev.startDate);
  return end == null ? null : end + RELEASE_GRACE_MS;
}

/** The settlement arithmetic for one paid order. Pure, integer cents. */
function computeSettlement({ grossCents, providerFeeCents }) {
  const g = Math.max(0, Math.round(Number(grossCents) || 0));
  if (providerFeeCents == null) {
    return { grossCents: g, providerFeeCents: null, netCents: null, commissionCents: null, organizerNetCents: null, feeKnown: false };
  }
  const fee = Math.min(g, Math.max(0, Math.round(Number(providerFeeCents))));
  const c = POLICY.commissionCents('event_ticket', { grossCents: g, providerFeeCents: fee });
  return {
    grossCents: g, providerFeeCents: fee, netCents: c.base, commissionCents: c.commission,
    organizerNetCents: c.base - c.commission, commissionBps: c.bps,
    policy: c.policy, rateSource: c.source, basis: c.basis, feeKnown: true,
  };
}

/* ═══ ENTITLEMENT ADAPTER ═════════════════════════════════════════════════════════════════ */

const eventTicketAdapter = {
  /* Domain preconditions only — payment truth is the engine's (assertPaymentHonourable). */
  async validate(ctx) {
    const orderId = String(ctx.resourceId || '');
    if (!orderId) { const e = new Error('event_ticket intent carries no order'); e.code = 'resource_missing'; throw e; }
    const o = await _db().collection(COL.ORDERS).doc(orderId).get();
    if (!o.exists) { const e = new Error(`eventOrders/${orderId} not found`); e.code = 'order_missing'; throw e; }
    const od = o.data();
    if (od.buyerUid !== ctx.ownerUid) { const e = new Error('order buyer differs from payer'); e.code = 'ownership_mismatch'; throw e; }
    const expect = Math.round(Number(od.totalAmount) * 100);
    if (Number.isFinite(expect) && Number(ctx.amountCents) < expect) { const e = new Error('intent amount below order total'); e.code = 'amount_short'; throw e; }
  },

  /**
   * One transaction: order paid, tickets valid, settlement recorded, commission booked.
   * A LATE payment for an order the expiry sweep already released is still honoured — the
   * buyer paid — its seats are re-reserved and an oversold alert is raised if that exceeds
   * the tier (CLAUDE.md: a post-payment race is flagged, never rejected).
   */
  async activate(txn, ctx) {
    const db = _db();
    const orderId = String(ctx.resourceId);
    const orderRef = db.collection(COL.ORDERS).doc(orderId);
    const setRef = db.collection(COL.SETTLEMENTS).doc(ctx.paymentRef);
    const comRef = db.collection(COL.COMMISSION).doc(`evt_${ctx.paymentRef}`);

    /* ── reads ── */
    const oSnap = await txn.get(orderRef);
    if (!oSnap.exists) { const e = new Error('order vanished'); e.code = 'order_missing'; throw e; }
    const o = oSnap.data();
    const evRef = db.collection(COL.EVENTS).doc(String(o.eventId));
    const tierRef = db.collection(COL.TIERS).doc(String(o.tierId));
    const [evSnap, tierSnap, tixSnap, setSnap] = await Promise.all([
      txn.get(evRef), txn.get(tierRef),
      txn.get(db.collection(COL.TICKETS).where('orderId', '==', orderId)),
      txn.get(setRef),
    ]);
    const ev = evSnap.exists ? evSnap.data() : {};
    const qty = Math.max(0, Number(o.quantity) || 0);
    const wasExpired = o.status === 'expired';

    const fee = providerFee(ctx.payment || {});
    const s = computeSettlement({ grossCents: ctx.amountCents, providerFeeCents: fee.cents });
    const organizerUid = ev.organizerUid || (ctx.intent.metadata || {}).organizerUid || null;

    /* ── writes ── */
    txn.update(orderRef, {
      status: 'paid', paidAt: FieldValue.serverTimestamp(), paymentRef: ctx.paymentRef,
      updatedAt: FieldValue.serverTimestamp(), ...(wasExpired ? { lateSettled: true } : {}),
    });
    if (tixSnap.empty) {
      /* Tickets are written after the purchase transaction; if that write was lost, the paid
         order still gets its tickets here — inside the activation transaction. */
      const { genTicketToken } = require('./event-hub')._internal;
      for (let i = 0; i < qty; i++) {
        const tRef = db.collection(COL.TICKETS).doc();
        const token = genTicketToken();
        txn.set(tRef, {
          ticketId: tRef.id, orderId, eventId: o.eventId, tierId: o.tierId, tierName: o.tierName || null,
          buyerUid: o.buyerUid, token, qrData: `sokoni-ticket:${tRef.id}:${token}`,
          attendeeName: o.attendeeName || null, attendeeEmail: o.attendeeEmail || null,
          status: 'valid', checkedIn: false, checkedInAt: null, checkedInBy: null, seatNumber: null,
          paymentRef: ctx.paymentRef, createdAt: FieldValue.serverTimestamp(),
          ...OPS.issueCredentials(txn, { eventId: o.eventId, ticketId: tRef.id, buyerUid: o.buyerUid, soldBy: o.soldBy || null }),
        });
      }
    } else {
      /* A ticket becomes an admission credential only when it is PAID: its PIN is issued here, in
         the activation transaction (event-ops.issueCredentials), never at reservation time. */
      tixSnap.docs.forEach((d) => txn.update(d.ref, {
        status: 'valid', paymentRef: ctx.paymentRef, validatedAt: FieldValue.serverTimestamp(),
        ...(d.data().pinHash ? {} : OPS.issueCredentials(txn, { eventId: o.eventId, ticketId: d.id, buyerUid: o.buyerUid, soldBy: o.soldBy || null })),
      }));
    }
    if (wasExpired && tierSnap.exists) {
      const td = tierSnap.data();
      txn.update(tierRef, { sold: FieldValue.increment(qty), updatedAt: FieldValue.serverTimestamp() });
      txn.update(evRef, { totalTicketsSold: FieldValue.increment(qty), updatedAt: FieldValue.serverTimestamp() });
      if ((Number(td.sold) || 0) + qty > (Number(td.quantity) || 0)) {
        txn.set(db.collection(COL.OVERSOLD).doc(`evt_${ctx.paymentRef}`), {
          kind: 'event_ticket_late_payment', orderId, eventId: o.eventId, tierId: o.tierId, quantity: qty,
          tierSold: Number(td.sold) || 0, tierQuantity: Number(td.quantity) || 0, paymentRef: ctx.paymentRef,
          status: 'OPEN', createdAt: FieldValue.serverTimestamp(),
        });
      }
    }
    if (!setSnap.exists) {
      const releaseMs = releaseAfterMs(ev);
      txn.create(setRef, {
        paymentRef: ctx.paymentRef, orderId, eventId: o.eventId || null, organizerUid, buyerUid: o.buyerUid,
        currency: ctx.currency, ...s,
        providerFeeSource: fee.source,
        status: s.feeKnown ? SETTLEMENT.HELD : SETTLEMENT.FEE_UNREPORTED,
        releaseAfter: releaseMs == null ? null : Timestamp.fromMillis(releaseMs),
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      if (s.feeKnown) txn.create(comRef, _commissionRow(ctx.paymentRef, orderId, o.eventId, organizerUid, s));
    }
    return { ref: `${COL.ORDERS}/${orderId}` };
  },

  /** Refund / chargeback: tickets void, settlement reversed if it has not left the platform. */
  async revoke(txn, led, reason) {
    const db = _db();
    const orderId = String(led.resourceId || '');
    const orderRef = db.collection(COL.ORDERS).doc(orderId);
    const setRef = db.collection(COL.SETTLEMENTS).doc(led.paymentRef);
    const comRef = db.collection(COL.COMMISSION).doc(`evt_${led.paymentRef}`);
    const [oSnap, tixSnap, setSnap, comSnap] = await Promise.all([
      txn.get(orderRef), txn.get(db.collection(COL.TICKETS).where('orderId', '==', orderId)),
      txn.get(setRef), txn.get(comRef),
    ]);
    if (oSnap.exists) txn.update(orderRef, { status: 'refunded', refundedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tixSnap.docs.forEach((d) => txn.update(d.ref, { status: 'refunded', revokedAt: FieldValue.serverTimestamp() }));
    if (setSnap.exists) {
      const st = setSnap.data().status;
      if (st === SETTLEMENT.HELD || st === SETTLEMENT.FEE_UNREPORTED) {
        txn.update(setRef, { status: SETTLEMENT.REFUNDED, refundReason: String(reason || '').slice(0, 300), updatedAt: FieldValue.serverTimestamp() });
        if (comSnap.exists) txn.update(comRef, { status: 'reversed', reversedAt: FieldValue.serverTimestamp() });
      } else if (st === SETTLEMENT.RELEASED) {
        /* The organizer has already been paid. Never debit a wallet silently: record it for a
           human in AdminOS, where the recovery decision belongs. */
        txn.set(db.collection(COL.EXCEPTIONS).doc(`refund_after_release_${led.paymentRef}`), {
          kind: 'refund_after_release', paymentRef: led.paymentRef, orderId, organizerUid: setSnap.data().organizerUid || null,
          organizerNetCents: setSnap.data().organizerNetCents || null, reason: String(reason || '').slice(0, 300),
          status: 'OPEN', createdAt: FieldValue.serverTimestamp(),
        });
      }
    }
  },

  async status(ctx) {
    const s = await _db().collection(COL.ORDERS).doc(String(ctx.resourceId || '')).get();
    return s.exists ? { status: s.data().status } : { status: 'NONE' };
  },
};

function _commissionRow(paymentRef, orderId, eventId, organizerUid, s) {
  return {
    ref: paymentRef, source: 'event_ticket', category: 'event_tickets', orderId, eventId: eventId || null,
    uid: organizerUid, policy: s.policy, basis: s.basis, rateSource: s.rateSource,
    commissionPct: s.commissionBps / 100, commissionCents: s.commissionCents,
    sokoniCut: s.commissionCents / 100, serviceTotal: s.grossCents / 100,
    providerFeeCents: s.providerFeeCents, providerNet: s.organizerNetCents / 100,
    status: 'held', createdAt: FieldValue.serverTimestamp(),
  };
}

function registerPurpose() {
  const engine = require('./entitlement-engine');
  if (!engine.getPurpose(PURPOSE)) {
    engine.registerPurpose(PURPOSE, { resourceType: 'eventOrder', handler: eventTicketAdapter, expiresDays: null, refundable: true });
  }
  return engine;
}

/* ═══ ACTIVATION TRIGGER ═════════════════════════════════════════════════════════════════ */

function shouldActivate(before, after) {
  if (!after) return false;
  const was = TERMINAL_PAID.has(String((before && before.status) || '').toUpperCase());
  const is = TERMINAL_PAID.has(String(after.status || '').toUpperCase());
  return is && !was;
}

async function activateIfEventTicket(paymentRef, opts = {}) {
  const ref = String(paymentRef || '').trim();
  if (!ref) return { skipped: 'no_ref' };
  let intent;
  try {
    const snap = await _db().collection(COL.INTENTS).doc(ref).get();
    intent = snap.exists ? snap.data() : null;
  } catch (e) {
    logger.error('[eventSettlement] intent read failed', { ref, error: e.message });
    return { skipped: 'intent_unreadable', error: e.message };
  }
  if (!intent) return { skipped: 'no_intent' };
  if (intent.purpose !== PURPOSE) return { skipped: 'other_purpose', purpose: intent.purpose || null };
  const engine = registerPurpose();
  try {
    const r = await engine.activate(ref, { source: opts.source || 'payment-trigger' });
    return r && r.alreadyActive ? { alreadyActive: true } : { activated: true };
  } catch (e) {
    /* A refusal (unpaid, short, reversed, mis-owned) is the engine doing its job. Recorded for
       AdminOS, never rethrown — a rethrow retries a payment that will be refused every time. */
    logger.warn('[eventSettlement] activation refused', { ref, code: e.code || null, error: e.message });
    await _db().collection(COL.EXCEPTIONS).doc(`activation_${ref}`).set({
      kind: 'activation_refused', paymentRef: ref, code: e.code || 'unknown', detail: String(e.message).slice(0, 300),
      status: 'OPEN', updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    return { refused: true, code: e.code || 'unknown' };
  }
}

/* SOKONI_HMAC_KEY: activation issues ticket PINs (event-ops.issueCredentials), which fail closed
   without the key. */
const eventOnTicketPayment = onDocumentWritten({ document: 'payments/{paymentId}', region: REGION, secrets: [OPS.SOKONI_HMAC_KEY] }, async (event) => {
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  if (!shouldActivate(before, after)) return;
  await activateIfEventTicket(event.params.paymentId, { source: 'payment-trigger' });
});

/* ═══ RELEASE ════════════════════════════════════════════════════════════════════════════ */

/**
 * Credit one HELD settlement to the organizer, exactly once. Refuses when the event was
 * cancelled, has not yet passed, or a refund may be in flight. Wallet unit is whole SHILLINGS
 * (wallets/{uid}.balance — the rail requestSellerPayout pays out); sub-shilling cents stay
 * recorded on the settlement as `roundingRemainderCents`, never silently dropped.
 */
async function releaseOne(paymentRef, opts = {}) {
  const db = _db();
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const setRef = db.collection(COL.SETTLEMENTS).doc(String(paymentRef));
  return db.runTransaction(async (txn) => {
    const sSnap = await txn.get(setRef);
    if (!sSnap.exists) return { skipped: 'missing' };
    const s = sSnap.data();
    if (s.status !== SETTLEMENT.HELD) return { skipped: `status_${s.status}` };
    const [evSnap, refSnap, oSnap] = await Promise.all([
      txn.get(db.collection(COL.EVENTS).doc(String(s.eventId || '_'))),
      txn.get(db.collection(COL.REFUNDS).doc(`ref_${paymentRef}`)),
      txn.get(db.collection(COL.ORDERS).doc(String(s.orderId || '_'))),
    ]);
    const ev = evSnap.exists ? evSnap.data() : null;
    if (!ev) return { skipped: 'event_missing' };
    if (ev.status === 'cancelled') return { skipped: 'event_cancelled' };
    const rel = releaseAfterMs(ev);
    if (rel == null || nowMs < rel) return { skipped: 'not_due' };
    if (refSnap.exists && REFUND_OPEN.has(String(refSnap.data().status))) return { skipped: 'refund_open' };
    if (!oSnap.exists || oSnap.data().status !== 'paid') return { skipped: `order_${oSnap.exists ? oSnap.data().status : 'missing'}` };
    if (!s.organizerUid) return { skipped: 'no_organizer' };

    const shillings = Math.floor(Math.max(0, Number(s.organizerNetCents) || 0) / 100);
    const remainder = Math.max(0, Number(s.organizerNetCents) || 0) - shillings * 100;
    const wRef = db.collection(COL.WALLETS).doc(s.organizerUid);
    const txRef = db.collection(COL.WALLET_TX).doc(`${s.organizerUid}_${paymentRef}_event`);
    const wSnap = await txn.get(wRef);
    if (shillings > 0) {
      if (wSnap.exists) txn.update(wRef, { balance: FieldValue.increment(shillings), updatedAt: FieldValue.serverTimestamp() });
      else txn.set(wRef, { uid: s.organizerUid, balance: shillings, currency: 'KES', createdAt: FieldValue.serverTimestamp() }, { merge: true });
      txn.create(txRef, {
        uid: s.organizerUid, type: 'event_ticket_earning', amount: shillings, paymentRef, orderId: s.orderId,
        eventId: s.eventId, description: `Ticket sales — order ${s.orderId}`, status: 'completed',
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    txn.update(setRef, {
      status: SETTLEMENT.RELEASED, releasedAt: FieldValue.serverTimestamp(), creditedKES: shillings,
      roundingRemainderCents: remainder, walletTxId: shillings > 0 ? txRef.id : null,
      releasedBy: opts.actorUid || 'schedule', updatedAt: FieldValue.serverTimestamp(),
    });
    txn.set(db.collection(COL.COMMISSION).doc(`evt_${paymentRef}`), { status: 'collected', collectedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { released: true, creditedKES: shillings };
  });
}

const eventReleaseSettlements = onSchedule({ schedule: 'every 60 minutes', timeZone: 'Africa/Nairobi', region: REGION }, async () => {
  const snap = await _db().collection(COL.SETTLEMENTS)
    .where('status', '==', SETTLEMENT.HELD).where('releaseAfter', '<=', Timestamp.now()).limit(200).get();
  let released = 0;
  for (const d of snap.docs) {
    try { const r = await releaseOne(d.id); if (r.released) released++; } // eslint-disable-line no-await-in-loop
    catch (e) { logger.error('[eventSettlement] release failed', { ref: d.id, err: e.message }); }
  }
  logger.info('[eventSettlement] release sweep', { scanned: snap.size, released });
});

/* ═══ UNPAID ORDER EXPIRY ════════════════════════════════════════════════════════════════ */

/** Release one unpaid order's seats. Never expires an order whose payment is terminal or in flight. */
async function expireOne(orderId, opts = {}) {
  const db = _db();
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const orderRef = db.collection(COL.ORDERS).doc(String(orderId));
  return db.runTransaction(async (txn) => {
    const oSnap = await txn.get(orderRef);
    if (!oSnap.exists) return { skipped: 'missing' };
    const o = oSnap.data();
    if (o.status !== 'pending_payment') return { skipped: `status_${o.status}` };
    const created = _ms(o.createdAt);
    if (created == null || nowMs - created < UNPAID_ORDER_TTL_MS) return { skipped: 'not_due' };
    const [paySnap, tixSnap] = await Promise.all([
      txn.get(db.collection(COL.PAYMENTS).doc(String(orderId))),
      txn.get(db.collection(COL.TICKETS).where('orderId', '==', String(orderId))),
    ]);
    if (paySnap.exists) {
      const ps = String(paySnap.data().status || '').toUpperCase();
      if (TERMINAL_PAID.has(ps) || ['PENDING', 'PROCESSING', 'INITIATED'].includes(ps)) return { skipped: `payment_${ps}` };
    }
    const qty = Math.max(0, Number(o.quantity) || 0);
    txn.update(orderRef, { status: 'expired', expiredAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tixSnap.docs.forEach((d) => txn.update(d.ref, { status: 'void', voidReason: 'unpaid_order_expired' }));
    if (qty > 0) {
      txn.update(db.collection(COL.TIERS).doc(String(o.tierId)), { sold: FieldValue.increment(-qty), updatedAt: FieldValue.serverTimestamp() });
      txn.update(db.collection(COL.EVENTS).doc(String(o.eventId)), { totalTicketsSold: FieldValue.increment(-qty), updatedAt: FieldValue.serverTimestamp() });
    }
    return { expired: true, released: qty };
  });
}

const eventExpireUnpaidOrders = onSchedule({ schedule: 'every 15 minutes', timeZone: 'Africa/Nairobi', region: REGION }, async () => {
  const cutoff = Timestamp.fromMillis(Date.now() - UNPAID_ORDER_TTL_MS);
  const snap = await _db().collection(COL.ORDERS)
    .where('status', '==', 'pending_payment').where('createdAt', '<=', cutoff).limit(200).get();
  let expired = 0;
  for (const d of snap.docs) {
    try { const r = await expireOne(d.id); if (r.expired) expired++; } // eslint-disable-line no-await-in-loop
    catch (e) { logger.error('[eventSettlement] expiry failed', { orderId: d.id, err: e.message }); }
  }
  logger.info('[eventSettlement] expiry sweep', { scanned: snap.size, expired });
});

/* ═══ REFUND HOOK (called by financial-os after a refund settles) ═══════════════════════ */

/**
 * No-op unless the payment is an event ticket. A FULL refund revokes through the engine
 * (exactly once — revoking twice is a no-op); a partial refund is not a ticket-level event and
 * is recorded for a human. Never throws into the refund authority.
 */
async function onEventRefundProcessed({ payRef, refundId, amountCents, source }) {
  const ref = String(payRef || '');
  if (!ref) return { skipped: 'no_ref' };
  const iSnap = await _db().collection(COL.INTENTS).doc(ref).get();
  if (!iSnap.exists || iSnap.data().purpose !== PURPOSE) return { skipped: 'not_event_ticket' };
  const intent = iSnap.data();
  if (Number(amountCents) < Number(intent.amountCents)) {
    await _db().collection(COL.EXCEPTIONS).doc(`partial_refund_${ref}`).set({
      kind: 'partial_refund', paymentRef: ref, refundId: refundId || null, amountCents: Number(amountCents) || 0,
      intentAmountCents: Number(intent.amountCents) || 0, status: 'OPEN', updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { partial: true };
  }
  const engine = registerPurpose();
  return engine.revoke(ref, `refund:${refundId || 'unknown'}`, { source: source || 'fos-refund' });
}

/* ═══ ADMINOS OPS (merged into adminOsDispatch) ══════════════════════════════════════════ */

function _uid(req) { if (!req.auth || !req.auth.uid) _fail('unauthenticated', 'Sign in required.'); return req.auth.uid; }
function _admin(req) { _uid(req); if (!AC.isAdmin(req)) _fail('permission-denied', 'Admin only.'); return req.auth.uid; }
function _superAdmin(req) { _uid(req); if (!AC.isSuperAdmin(req)) _fail('permission-denied', 'Super admin only.'); return req.auth.uid; }
function _id(v, what) { const s = String(v || ''); if (!/^[A-Za-z0-9_-]{1,128}$/.test(s)) _fail('invalid-argument', `${what} is invalid.`); return s; }
async function _audit(action, actorUid, target, before, after, reason) {
  await _db().collection(COL.ADMIN_AUDIT).add({
    action, performedBy: actorUid, module: 'event-settlement', target, before: before || null, after: after || null,
    reason: reason || null, createdAt: FieldValue.serverTimestamp(),
  }).catch((e) => logger.error('[eventSettlement] audit write failed', { action, err: e.message }));
}
const _row = (d) => { const x = d.data(); const out = { id: d.id }; for (const [k, v] of Object.entries(x)) out[k] = (v && typeof v.toMillis === 'function') ? v.toMillis() : v; return out; };

const _adminH = {};

_adminH.eventAdminOverview = async (req) => {
  _admin(req);
  const CAP = 2000;
  const [events, settlements, exceptions, refundOrders] = await Promise.all([
    _db().collection(COL.EVENTS).limit(CAP).get(),
    _db().collection(COL.SETTLEMENTS).limit(CAP).get(),
    _db().collection(COL.EXCEPTIONS).where('status', '==', 'OPEN').limit(CAP).get(),
    _db().collection(COL.ORDERS).where('status', '==', 'pending_refund').limit(CAP).get(),
  ]);
  const byStatus = (snap, f) => snap.docs.reduce((a, d) => { const k = d.data()[f] || 'unknown'; a[k] = (a[k] || 0) + 1; return a; }, {});
  const sum = (f, st) => settlements.docs.filter((d) => !st || d.data().status === st).reduce((a, d) => a + (Number(d.data()[f]) || 0), 0);
  const capped = (snap, v) => (snap.size >= CAP ? null : v);   /* unknown renders —, never a truncated number */
  return {
    events: capped(events, byStatus(events, 'status')),
    settlements: capped(settlements, byStatus(settlements, 'status')),
    heldOrganizerNetCents: capped(settlements, sum('organizerNetCents', SETTLEMENT.HELD)),
    commissionCents: capped(settlements, sum('commissionCents')),
    openExceptions: capped(exceptions, exceptions.size),
    ordersAwaitingRefund: capped(refundOrders, refundOrders.size),
    policy: POLICY.policyFor({ policyKey: 'event_ticket' }).pct,
  };
};

_adminH.eventAdminSettlements = async (req) => {
  _admin(req);
  const st = req.data && req.data.status ? String(req.data.status) : null;
  let q = _db().collection(COL.SETTLEMENTS);
  if (st) { if (!SETTLEMENT[st]) _fail('invalid-argument', 'Unknown status.'); q = q.where('status', '==', st); }
  const snap = await q.limit(200).get();
  return { settlements: snap.docs.map(_row) };
};

_adminH.eventAdminExceptions = async (req) => {
  _admin(req);
  const snap = await _db().collection(COL.EXCEPTIONS).where('status', '==', 'OPEN').limit(200).get();
  return { exceptions: snap.docs.map(_row) };
};

/* Orders a cancelled event left for refund. The refund itself is submitted from AdminOS through
   the canonical fosSubmitRefund with the order's payRef — this op only lists them. */
_adminH.eventAdminRefundQueue = async (req) => {
  _admin(req);
  const snap = await _db().collection(COL.ORDERS).where('status', '==', 'pending_refund').limit(200).get();
  return { orders: snap.docs.map(_row) };
};

_adminH.eventAdminEvents = async (req) => {
  _admin(req);
  const snap = await _db().collection(COL.EVENTS).orderBy('createdAt', 'desc').limit(200).get().catch(() => _db().collection(COL.EVENTS).limit(200).get());
  return { events: snap.docs.map(_row) };
};

/* A super admin records the provider fee IntaSend did not report, with evidence. Allowed only
   while the settlement is FEE_UNREPORTED: a recognised fee is immutable. */
_adminH.eventAdminAttestFee = async (req) => {
  const actor = _superAdmin(req);
  const d = req.data || {};
  const ref = _id(d.paymentRef, 'paymentRef');
  const feeKes = Number(d.feeKes);
  if (!(Number.isFinite(feeKes) && feeKes >= 0 && Math.round(feeKes * 100) === feeKes * 100)) _fail('invalid-argument', 'feeKes must be a non-negative amount with at most 2 decimals.');
  const evidence = String(d.evidence || '').slice(0, 300);
  if (evidence.trim().length < 5) _fail('invalid-argument', 'Evidence (IntaSend dashboard reference) is required.');
  const setRef = _db().collection(COL.SETTLEMENTS).doc(ref);
  let before = null; let after = null;
  await _db().runTransaction(async (txn) => {
    const s = await txn.get(setRef);
    if (!s.exists) _fail('not-found', 'Settlement not found.');
    const cur = s.data();
    if (cur.status !== SETTLEMENT.FEE_UNREPORTED) _fail('failed-precondition', `Settlement is ${cur.status}; the fee can only be attested while unreported.`);
    const comp = computeSettlement({ grossCents: cur.grossCents, providerFeeCents: Math.round(feeKes * 100) });
    before = { status: cur.status, providerFeeCents: null };
    after = { status: SETTLEMENT.HELD, providerFeeCents: comp.providerFeeCents, commissionCents: comp.commissionCents };
    txn.update(setRef, { ...comp, providerFeeSource: 'super_admin_attested', feeEvidence: evidence, feeAttestedBy: actor,
      status: SETTLEMENT.HELD, updatedAt: FieldValue.serverTimestamp() });
    txn.create(_db().collection(COL.COMMISSION).doc(`evt_${ref}`), _commissionRow(ref, cur.orderId, cur.eventId, cur.organizerUid, comp));
  });
  await _audit('event_fee_attested', actor, { paymentRef: ref }, before, after, evidence);
  return { ok: true, ...after };
};

module.exports = {
  PURPOSE, COL, SETTLEMENT, RELEASE_GRACE_MS, UNPAID_ORDER_TTL_MS,
  eventTicketAdapter, registerPurpose, computeSettlement, releaseAfterMs, shouldActivate,
  activateIfEventTicket, releaseOne, expireOne, onEventRefundProcessed,
  eventOnTicketPayment, eventReleaseSettlements, eventExpireUnpaidOrders, _adminH,
};
