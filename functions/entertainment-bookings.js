/* ═══════════════════════════════════════════════════════════════════════════════════════════
   ENTERTAINMENT BOOKINGS — one canonical booking identity per Entertainment transaction.
   Rules: functions/shared/ent-booking-identity.js. Docs: docs/ENTERTAINMENT_BOOKINGS.md.

   The source engines stay the authority for their own records and are NOT modified by this module:
     eventOrders        event-hub + event-settlement      → EVENT   (ticket PINs are the credential)
     providerBookings   booking-service + provider-ops    → ARTIST / SERVICE (Entertainment-classified)
     bookings           booking core (venue)              → VENUE
   A trigger on each source keeps ONE envelope, entBookings/{envId}, in step:

     BOOKING → PAYMENT → PROVIDER → CONVERSATION → NOTIFICATIONS → REFUND → VERIFICATION → ADMINOS

   · the reference (BK-ART / BK-SVC / BK-VEN, or the order's SK-EVT ticket numbers)
   · the category booking PIN — server-generated (crypto.randomInt), HMAC-bound to THIS booking; the
     raw PIN lives only in entBookingSecrets (buyer-readable); the envelope holds the hash
   · the buyer↔provider conversation, created by the SERVER through the canonical messages authority
     (messages.ensureAnchoredConversation) with the parties taken from the booking itself
   · system events in that conversation + canonical notifications for every meaningful change
   · one trace for AdminOS (booking, payment, commission / settlement, conversation metadata, audit)

   Nothing here moves money, prices anything, or decides a refund: payment, commission, settlement and
   refunds remain with their canonical authorities; the envelope REPORTS their state.
   ═══════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';
const { HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');
const crypto = require('crypto');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const AC = require('./admin-claim');
const ID = require('./shared/ent-booking-identity');

const REGION = 'us-central1';
const _db = () => getFirestore();
let _now = () => Date.now();
let _randInt = (n) => crypto.randomInt(0, n);
const fail = (code, msg) => { throw new HttpsError(code, msg); };
const _ms = (v) => { if (v == null) return null; if (typeof v === 'number') return v; if (typeof v.toMillis === 'function') return v.toMillis(); const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };
const COL = Object.freeze({ ENV: 'entBookings', SECRETS: 'entBookingSecrets', REFS: 'entBookingRefs', ATTEMPTS: 'entBookingPinAttempts', AUDIT: 'entBookingAudit' });
const ATTEMPTS = Object.freeze({ WINDOW_MS: 10 * 60 * 1000, PER_BOOKING_FAILS: 5, PER_ACTOR_FAILS: 20 });
const CONV_TYPE = 'ent_booking';

function _key() { return require('./event-ops'); }
function _pinHash(envId, pin) {
  const p = ID.normalizePin(pin);
  return p ? _key().credentialHash(`entbk|${envId}|${p}`) : null;
}

async function _audit(action, uid, envId, detail) {
  await _db().collection(COL.AUDIT).add({ action, performedBy: uid || 'system', envId: envId || null, detail: detail || null, createdAt: FieldValue.serverTimestamp() })
    .catch((e) => logger.error('[entBookings] audit failed', { action, err: e.message }));
}

/* ═══ SOURCE ADAPTERS — read the source record; derive every party SERVER-SIDE ═════════════ */
const EVENT_REFUND = { SUBMITTING: 'REQUESTED', PENDING_REVIEW: 'UNDER_REVIEW', DUPLICATE: 'UNDER_REVIEW', APPROVED: 'PROCESSING', REFUNDED: 'COMPLETED', REJECTED: 'DECLINED', OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN' };

async function readSource(collection, id, data) {
  const db = _db();
  const d = data || ((await db.collection(collection).doc(id).get()).data());
  if (!d) return { skip: 'missing' };
  if (collection === 'eventOrders') {
    if (d.channel === 'cashier') return { skip: 'walk_in' };                /* door sale: no buyer account */
    if (!['paid', 'refunded', 'pending_refund'].includes(String(d.status))) return { skip: 'not_paid' };
    const ev = d.eventId ? (await db.collection('events').doc(String(d.eventId)).get()).data() : null;
    if (!ev || !ev.organizerUid) return { skip: 'no_organizer' };
    const [tix, rr] = await Promise.all([
      db.collection('eventTickets').where('orderId', '==', id).get(),
      db.collection('eventRefundRequests').doc(id).get(),
    ]);
    const numbers = tix.docs.map((t) => t.data().ticketNumber).filter(Boolean).sort();
    return {
      category: ID.CATEGORY.EVENT, buyerUid: d.buyerUid, providerUid: ev.organizerUid, providerKind: 'organizer',
      title: ev.title || 'Event', providerName: ev.organizerName || null, location: ev.venue || ev.city || (ev.isOnline ? 'Online' : null),
      when: { startMs: _ms(ev.startDate), endMs: _ms(ev.endDate) }, status: ID.statusOf(collection, d),
      payment: { state: ID.paymentOf(collection, d), paymentRef: d.paymentRef || id, amountCents: Math.round((Number(d.totalAmount) || 0) * 100) },
      refund: { state: rr.exists ? (EVENT_REFUND[rr.data().status] || 'UNDER_REVIEW') : 'NONE' },
      ticketNumbers: numbers, quantity: Number(d.quantity) || numbers.length, detail: d.tierName || null,
    };
  }
  if (collection === 'providerBookings') {
    /* 2026-09-30 (owner): EVERY paid service booking gets the envelope and the PIN — not only the
       entertainment hub. PIN YAKO NI BOOKING YAKO: the buyer's PIN, given after the service is done,
       is the only thing that releases the held payment. Hub only decides the commission rate. */
    if (String(d.paymentStatus || 'pending') === 'pending' && ['pending', 'requested', 'cancelled', 'expired'].includes(String(d.status))) return { skip: 'not_paid' };
    const prov = (await db.collection('providers').doc(String(d.providerId)).get()).data() || {};
    const refundState = String(d.paymentStatus) === 'refunded' ? 'COMPLETED' : (d.resolution && d.resolution.refundLock ? 'PROCESSING' : 'NONE');
    return {
      category: d.entClass === ID.CATEGORY.ARTIST ? ID.CATEGORY.ARTIST : ID.CATEGORY.SERVICE,
      buyerUid: d.customerUid, providerUid: d.providerId, providerKind: d.entClass === ID.CATEGORY.ARTIST ? 'artist' : 'service_provider',
      title: d.service || 'Service', providerName: prov.name || prov.businessName || null, location: d.address || d.location || null,
      when: { startMs: _ms(d.startTs) || _ms(d.scheduledAt), endMs: _ms(d.endTs) }, status: ID.statusOf(collection, d),
      payment: { state: ID.paymentOf(collection, d), paymentRef: d.paymentRef || null, amountCents: (Number(d.price) || 0) + (Number(d.fee) || 0) },
      refund: { state: refundState }, detail: d.durationMins ? `${d.durationMins} min` : null,
    };
  }
  if (collection === 'bookings') {
    if (!d.venueId || !d.ownerId || !d.customerId) return { skip: 'not_venue_core' };  /* legacy service shape shares this collection */
    /* Only a SERVER-written venue booking (bookingCreate stamps pricingBreakdown, which no client may
       write) gets an identity, a PIN and a conversation with the owner. */
    if (!d.pricingBreakdown) return { skip: 'not_server_written' };
    const venue = (await db.collection('venues').doc(String(d.venueId)).get()).data();
    if (!venue || venue.ownerId !== d.ownerId) return { skip: 'owner_mismatch' };       /* the provider is the VENUE's owner, re-derived */
    return {
      category: ID.CATEGORY.VENUE, buyerUid: d.customerId, providerUid: venue.ownerId, providerKind: 'venue_owner',
      title: d.venueName || venue.name || 'Venue', providerName: venue.name || null, location: (venue.location && (venue.location.address || venue.location.city)) || venue.city || null,
      when: { startMs: _ms(d.startTs), endMs: _ms(d.endTs) }, status: ID.statusOf(collection, d),
      payment: { state: ID.paymentOf(collection, d), paymentRef: d.paymentId || null, amountCents: d.pricingBreakdown && Number.isFinite(Number(d.pricingBreakdown.total)) ? Math.round(Number(d.pricingBreakdown.total) * 100) : null },
      refund: { state: String(d.paymentStatus) === 'refunded' ? 'COMPLETED' : 'NONE' }, detail: d.date && d.startTime ? `${d.date} ${d.startTime}–${d.endTime || ''}` : null,
    };
  }
  return { skip: 'unknown_source' };
}

/* ═══ ENVELOPE ═══════════════════════════════════════════════════════════════════════════════ */
function _genRef(category, year) { return `${ID.REF_PREFIX[category]}-${year}-${String(_randInt(1000000)).padStart(6, '0')}`; }
function _genPin() { return String(_randInt(10000)).padStart(4, '0'); }

async function ensureEnvelope(collection, sourceId, src) {
  const db = _db();
  const envId = ID.envIdFor(collection, sourceId);
  const envRef = db.collection(COL.ENV).doc(envId);
  let created = false; let env = null;
  await db.runTransaction(async (txn) => {
    const cur = await txn.get(envRef);
    if (cur.exists) { env = cur.data(); return; }
    let bookingRef; let pin = null;
    if (src.category === ID.CATEGORY.EVENT) {
      bookingRef = src.ticketNumbers[0] || `SK-EVT-ORDER-${sourceId}`;
    } else {
      /* choose a free reference in the READ phase (never create()-and-hope) */
      const year = new Date(_now()).getUTCFullYear();
      for (let i = 0; i < 8 && !bookingRef; i++) {
        const cand = _genRef(src.category, year);
        const s = await txn.get(db.collection(COL.REFS).doc(cand));
        if (!s.exists) bookingRef = cand;
      }
      if (!bookingRef) fail('resource-exhausted', 'Could not allocate a booking reference — try again.');
      pin = _genPin();
    }
    created = true;
    env = {
      envId, bookingRef, category: src.category, source: { collection, id: sourceId },
      buyerUid: src.buyerUid, providerUid: src.providerUid, providerKind: src.providerKind,
      title: src.title, providerName: src.providerName || null, location: src.location || null, detail: src.detail || null,
      when: src.when, status: src.status, payment: src.payment, refund: src.refund,
      ticketNumbers: src.ticketNumbers || null, quantity: src.quantity || null,
      pin: pin ? { hash: _pinHash(envId, pin), issuedAt: FieldValue.serverTimestamp() } : null,
      verification: { state: pin ? 'NOT_VERIFIED' : 'NOT_APPLICABLE' }, conversationId: null,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), version: 1,
    };
    txn.create(envRef, env);
    if (pin) {
      txn.create(db.collection(COL.REFS).doc(bookingRef), { envId, createdAt: FieldValue.serverTimestamp() });
      txn.create(db.collection(COL.SECRETS).doc(envId), { envId, bookingRef, pin, buyerUid: src.buyerUid, createdAt: FieldValue.serverTimestamp() });
    }
  });
  if (created) await _afterCreate(envId, env);
  return { envId, created, env };
}

async function _conversation(envId, env) {
  if (!env.buyerUid || !env.providerUid || env.buyerUid === env.providerUid) return null;
  const M = require('./messages');
  const r = await M.ensureAnchoredConversation(_db(), {
    transactionType: CONV_TYPE, transactionId: envId, title: ID.titleFor(env.category, env.bookingRef),
    participants: [env.buyerUid, env.providerUid],
    metadata: { category: env.category, bookingRef: env.bookingRef, anchorType: 'entBooking', anchorId: envId },
  });
  if (!env.conversationId) await _db().collection(COL.ENV).doc(envId).update({ conversationId: r.conversationId }).catch(() => {});
  return r.conversationId;
}

async function _system(env, key, text, status, tag) {
  if (!env.conversationId) return;
  await require('./messages').postSystemMessage(_db(), env.conversationId, `${env.envId}_${key}`, text, { status: status || null, bookingRef: env.bookingRef, tag: tag || 'booking' })
    .catch((e) => logger.warn('[entBookings] system message failed', { envId: env.envId, err: e.message }));
}

async function _notify(uid, type, title, body, env, key) {
  if (!uid) return;
  await require('./notify').notify({ uid, type, title, body, deepLink: `/entertainment.html?tab=mine&booking=${encodeURIComponent(env.bookingRef)}`,
    group: 'bookings', dedupeKey: `${type}_${env.envId}_${key}_${uid}`, anchorType: 'booking', anchorId: env.envId, data: { bookingRef: env.bookingRef, category: env.category } })
    .catch((e) => logger.warn('[entBookings] notify failed', { type, err: e.message }));
}

const LABEL = { EVENT: 'ticket', ARTIST: 'artist booking', SERVICE: 'service booking', VENUE: 'venue booking' };
async function _afterCreate(envId, env) {
  const convId = await _conversation(envId, env).catch((e) => { logger.error('[entBookings] conversation failed', { envId, err: e.message }); return null; });
  const e2 = { ...env, conversationId: convId };
  await _system(e2, 'created', env.category === ID.CATEGORY.EVENT
    ? `Ticket order confirmed — ${env.bookingRef}${env.quantity > 1 ? ` (+${env.quantity - 1} more)` : ''}. Payment ${String(env.payment.state).toLowerCase().replace(/_/g, ' ')}.`
    : `${ID.TITLE[env.category]} created — ${env.bookingRef}. Payment ${String(env.payment.state).toLowerCase().replace(/_/g, ' ')}.`, env.status);
  /* The envelope is usually born already paid: post the canonical events now, under the SAME keys
     syncEnvelope uses, so a later sync never repeats them. Derived from state, never authored. */
  if (env.status === ID.STATUS.CONFIRMED) await _system(e2, 'status_' + env.status, `BOOKING CONFIRMED — ${env.bookingRef}.`, env.status, 'booking');
  if (env.payment && env.payment.state === ID.PAYMENT.CONFIRMED) {
    await _system(e2, 'payment_' + env.payment.state, `PAYMENT CONFIRMED — ${env.bookingRef}.`, null, 'payment');
    if (env.category !== ID.CATEGORY.EVENT && env.pin) await _system(e2, 'pin_issued', `PIN ISSUED — ${ID.PHRASE.BOOKING}. The buyer's PIN is on their booking; the provider verifies it at the booking.`, null, 'booking');
  }
  await _notify(env.buyerUid, 'ent_booking_created', env.category === ID.CATEGORY.EVENT ? 'Your ticket is confirmed' : 'Your booking is recorded',
    env.category === ID.CATEGORY.EVENT ? `${env.title} — ${env.bookingRef}. ${ID.PHRASE.EVENT}: open My Tickets.` : `${env.title} — ${env.bookingRef}. ${ID.PHRASE.BOOKING}: open your booking to see your PIN.`, e2, 'created');
  await _notify(env.providerUid, 'ent_booking_created', `New ${LABEL[env.category]}`, `${env.title} — ${env.bookingRef}.`, e2, 'created');
  await _audit('ent_booking_created', 'system', envId, { category: env.category, bookingRef: env.bookingRef, source: env.source });
}

/** Keep the envelope in step with its source; post the transitions into the conversation. */
async function syncEnvelope(envId, src) {
  const db = _db();
  const ref = db.collection(COL.ENV).doc(envId);
  const cur = (await ref.get()).data();
  if (!cur) return null;
  const patch = {}; const events = [];
  /* System events are derived from the AUTHORITATIVE state only — never provider-authored. */
  const STATUS_TEXT = { CONFIRMED: 'BOOKING CONFIRMED', COMPLETED: 'COMPLETED', CANCELLED: 'BOOKING CANCELLED', DECLINED: 'BOOKING DECLINED', NO_SHOW: 'MARKED NO-SHOW', IN_PROGRESS: 'BOOKING STARTED', EXPIRED: 'BOOKING EXPIRED' };
  const REFUND_TEXT = { REQUESTED: 'REFUND REQUESTED', UNDER_REVIEW: 'REFUND UNDER REVIEW', APPROVED: 'REFUND APPROVED', PROCESSING: 'REFUND PROCESSING', COMPLETED: 'REFUND COMPLETED', DECLINED: 'REFUND DECLINED', OUTCOME_UNKNOWN: 'REFUND OUTCOME UNKNOWN — SOKONI is confirming with the payment provider' };
  if (src.status !== cur.status) { patch.status = src.status; events.push(['status_' + src.status, `${STATUS_TEXT[src.status] || 'Booking ' + src.status.toLowerCase().replace(/_/g, ' ')} — ${cur.bookingRef}.`, src.status, 'booking']); }
  if (src.payment && (!cur.payment || src.payment.state !== cur.payment.state)) {
    patch.payment = src.payment;
    events.push(['payment_' + src.payment.state, `${src.payment.state === 'CONFIRMED' ? 'PAYMENT CONFIRMED' : 'Payment ' + src.payment.state.toLowerCase().replace(/_/g, ' ')} — ${cur.bookingRef}.`, null, 'payment']);
    if (src.payment.state === 'CONFIRMED' && cur.category !== ID.CATEGORY.EVENT && cur.pin) events.push(['pin_issued', `PIN ISSUED — ${ID.PHRASE.BOOKING}. The buyer's PIN is on their booking; the provider verifies it at the booking.`, null, 'booking']);
  }
  if (src.refund && (!cur.refund || src.refund.state !== cur.refund.state)) { patch.refund = src.refund; events.push(['refund_' + src.refund.state, `${REFUND_TEXT[src.refund.state] || 'Refund ' + src.refund.state.toLowerCase().replace(/_/g, ' ')} — ${cur.bookingRef}.`, null, 'refund']); }
  if (src.ticketNumbers && JSON.stringify(src.ticketNumbers) !== JSON.stringify(cur.ticketNumbers || [])) patch.ticketNumbers = src.ticketNumbers;
  if (!Object.keys(patch).length) return { changed: false };
  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  const env = { ...cur, ...patch };
  for (const [key, text, status, tag] of events) {
    await _system(env, key, text, status, tag);
    const refund = key.startsWith('refund_');
    const type = refund ? 'ent_booking_refund_update' : 'ent_booking_update';
    await _notify(env.buyerUid, type, refund ? 'Refund update' : 'Booking update', text, env, key);
    await _notify(env.providerUid, type, refund ? 'Refund update' : 'Booking update', text, env, key);
  }
  return { changed: true, patch };
}

async function onSourceWritten(collection, id, after) {
  if (!after) return { skipped: 'deleted' };
  if (collection === 'providerBookings' && (after.quoteId || after.enquiryId) && ['paid_held', 'settled'].includes(after.paymentStatus)) {
    await _convertEnquiry(id, after).catch((e) => logger.warn('[entBookings] enquiry conversion failed', { id, err: e.message }));
  }
  const src = await readSource(collection, id, after);
  if (src.skip) return { skipped: src.skip };
  const envId = ID.envIdFor(collection, id);
  const exists = (await _db().collection(COL.ENV).doc(envId).get()).exists;
  const out = !exists ? await ensureEnvelope(collection, id, src) : await syncEnvelope(envId, src);
  if (collection === 'providerBookings') {
    await _mirrorServiceOrder(id, after, envId).catch((e) => logger.warn('[entBookings] service order mirror failed', { id, err: e.message }));
  }
  return out;
}

/* ── orders/{bookingId} mirror — a service booking IS an order (type 'service_booking') ────────────
   Written from the booking document only (never from a caller), so admin.html / AdminOS / super
   admin see every service booking beside product orders with the escrow position the platform
   holds: held (paid to SOKONI, awaiting the buyer's PIN), released (PIN given: provider's business
   wallet credited, SOKONI commission recorded) or refunded. Amounts in KES. Idempotent (merge). */
async function _mirrorServiceOrder(bookingId, b, envId) {
  const db = _db();
  const priceKES = Math.round((Number(b.price) || 0) / 100);
  const feeKES   = Math.round((Number(b.fee) || 0) / 100);
  const totalKES = priceKES + feeKES;
  const ps = String(b.paymentStatus || 'pending');
  const escrow = { held: 0, released: 0, refunded: 0 };
  let commissionKES = null, providerNetKES = null, gatewayChargesKES = null;
  if (ps === 'paid_held') escrow.held = Math.round((Number(b.heldAmount) || (Number(b.price) || 0) + (Number(b.fee) || 0)) / 100);
  if (ps === 'settled') {
    const payout = await db.collection('providerPayouts').doc(bookingId).get().catch(() => null);
    const p = payout && payout.exists ? payout.data() : null;
    if (p) {
      commissionKES  = Math.round((Number(p.commission) || 0) / 100);
      providerNetKES = Math.round((Number(p.settlementCents != null ? p.settlementCents : p.net) || 0) / 100);
      escrow.released = providerNetKES;
    } else escrow.released = totalKES;
  }
  if (ps === 'refunded') escrow.refunded = Math.round((Number(b.refundedCents) || 0) / 100);
  if (b.paymentRef) {
    const pay = await db.collection('payments').doc(String(b.paymentRef)).get().catch(() => null);
    if (pay && pay.exists) {
      const x = pay.data() || {};
      const amt = Number(x.amount != null ? x.amount : x.amountKES);
      const net = Number(x.netAmount != null ? x.netAmount : amt);
      if (Number.isFinite(amt) && Number.isFinite(net)) gatewayChargesKES = Math.max(0, Math.round((amt - net) * 100) / 100);
    }
  }
  const ref = db.collection('orders').doc(bookingId);
  const cur = await ref.get();
  if (cur.exists && cur.data().type && cur.data().type !== 'service_booking') return { skipped: 'id_collision' };
  await ref.set({
    type: 'service_booking', source: 'providerBookings', bookingId, envId,
    buyerUid: b.customerUid || null, sellerUid: b.providerId || null, providerId: b.providerId || null,
    hubId: b.commissionHub || null, service: b.service || null, productName: b.service || 'Service booking',
    items: [{ name: b.service || 'Service booking', qty: 1, price: totalKES }],
    status: b.status || null, paymentStatus: ps, paymentRef: b.paymentRef || null,
    total: totalKES, priceKES, feeKES, currency: 'KES',
    commissionKES, providerNetKES, gatewayChargesKES,
    escrow, settledAt: b.settledAt || null, refundedAt: b.disbursedAt || null,
    scheduledAt: b.startTs || b.scheduledAt || null,
    createdAt: cur.exists && cur.data().createdAt ? cur.data().createdAt : (b.createdAt || FieldValue.serverTimestamp()),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { mirrored: true, escrow };
}



/* Enquiry → quote → booking: the paid booking CONVERTS its quote and enquiry (idempotent). */
async function _convertEnquiry(bookingId, b) {
  if (b.quoteId) {
    const qRef = _db().collection('entQuotes').doc(String(b.quoteId));
    await _db().runTransaction(async (txn) => {
      const q = await txn.get(qRef);
      if (!q.exists || q.data().status === 'CONVERTED' || q.data().buyerUid !== b.customerUid) return;
      txn.update(qRef, { status: 'CONVERTED', bookingId, updatedAt: FieldValue.serverTimestamp() });
    });
  }
  if (b.enquiryId) {
    const e = await _db().collection('entEnquiries').doc(String(b.enquiryId)).get();
    if (e.exists && e.data().buyerUid === b.customerUid && e.data().status !== 'CONVERTED') {
      await require('./ent-enquiries').transition(e.id, 'CONVERTED', { by: 'system', bookingId, note: 'This enquiry became a paid booking.' }).catch(() => {});
    }
  }
}

/** UPCOMING REMINDER — once per booking, in its conversation, the day before (from the 30-minute
 *  reminder job). A system event derived from the booking's own time, never provider-authored. */
async function sendReminders(nowMs) {
  const now = nowMs || _now();
  const s = await _db().collection(COL.ENV).where('when.startMs', '>', now).where('when.startMs', '<', now + 24 * 3600000).limit(300).get().catch(() => ({ docs: [] }));
  let n = 0;
  for (const d of s.docs) {
    const env = d.data();
    if (env.reminderSent || !['CONFIRMED', 'PENDING'].includes(env.status) || env.category === ID.CATEGORY.EVENT) continue;
    if (!env.payment || !['CONFIRMED', 'NOT_REQUIRED'].includes(env.payment.state)) continue;
    await _system(env, 'reminder', `UPCOMING — ${env.title} is within 24 hours (${env.bookingRef}). ${ID.PHRASE.BOOKING}: have your PIN ready.`, null, 'booking');
    await d.ref.update({ reminderSent: true }).catch(() => {});
    n++;
  }
  return n;
}

/* ═══ VERIFICATION — the one server primitive for a category booking PIN ═══════════════════ */
async function _charge(envId, uid, failed) {
  const db = _db();
  const refs = [db.collection(COL.ATTEMPTS).doc(`${envId}_${uid}`), db.collection(COL.ATTEMPTS).doc(`__actor_${uid}`)];
  const limits = [ATTEMPTS.PER_BOOKING_FAILS, ATTEMPTS.PER_ACTOR_FAILS];
  return db.runTransaction(async (txn) => {
    const snaps = await Promise.all(refs.map((r) => txn.get(r)));
    const nowMs = _now();
    const st = snaps.map((s) => { const d = s.exists ? s.data() : {}; const fresh = !d.windowStart || nowMs - _ms(d.windowStart) >= ATTEMPTS.WINDOW_MS; return { fails: fresh ? 0 : Number(d.fails) || 0, windowStart: fresh ? nowMs : _ms(d.windowStart) }; });
    const locked = st.findIndex((s, i) => s.fails >= limits[i]);
    if (locked >= 0) return { locked: locked === 0 ? 'booking' : 'actor' };
    if (failed) st.forEach((s, i) => txn.set(refs[i], { fails: s.fails + 1, windowStart: Timestamp.fromMillis(s.windowStart), updatedAt: FieldValue.serverTimestamp() }, { merge: true }));
    const crossed = failed ? st.findIndex((s, i) => s.fails + 1 === limits[i]) : -1;
    return { locked: null, crossed: crossed < 0 ? null : (crossed === 0 ? 'booking' : 'actor') };
  });
}

async function _envByRef(bookingRef) {
  const ref = String(bookingRef || '').trim().toUpperCase();
  if (!ID.REF_RE.test(ref)) return null;
  const idx = await _db().collection(COL.REFS).doc(ref).get();
  if (!idx.exists) return null;
  const s = await _db().collection(COL.ENV).doc(idx.data().envId).get();
  return s.exists ? s.data() : null;
}

/** PROVIDER verifies the buyer's booking PIN. Wrong PINs are counted, audited (never the PIN) and a
 *  crossed limit is a security event; only the booking's own provider may verify it. */
async function verifyPin(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const uid = req.auth.uid;
  const d = req.data || {};
  const pin = ID.normalizePin(d.pin);
  if (!pin) fail('invalid-argument', 'Enter the 4-digit booking PIN.');
  const env = await _envByRef(d.bookingRef);
  /* the same answer for "no such booking" and "not your booking": no enumeration of references */
  if (!env || env.providerUid !== uid) fail('permission-denied', 'This booking is not one of yours to verify.');
  const pre = await _charge(env.envId, uid, false);
  if (pre.locked) fail('resource-exhausted', 'Too many wrong PINs. Wait a few minutes before trying again.');
  const want = env.pin && env.pin.hash;
  const got = _pinHash(env.envId, pin);
  const ok = !!want && !!got && want.length === got.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
  if (!ok) {
    const r = await _charge(env.envId, uid, true);
    await _audit('ent_booking_pin_failed', uid, env.envId, { bookingRef: env.bookingRef });
    if (r.crossed) {
      await _audit('ent_booking_pin_lockout', uid, env.envId, { scope: r.crossed, windowMs: ATTEMPTS.WINDOW_MS });
      await _db().collection('securityEvents').add({ type: 'ent_booking_pin_lockout', uid, envId: env.envId, scope: r.crossed, severity: 'medium', createdAt: FieldValue.serverTimestamp() }).catch(() => {});
    }
    return { verified: false, reason: 'That PIN does not match this booking.' };
  }
  const ref = _db().collection(COL.ENV).doc(env.envId);
  const outcome = await _db().runTransaction(async (txn) => {
    const cur = (await txn.get(ref)).data();
    const st = ID.pinState(cur, _now());
    if (st !== ID.PIN_STATE.ACTIVE) return { verified: false, state: st };
    txn.update(ref, { verification: { state: 'VERIFIED', at: FieldValue.serverTimestamp(), by: uid }, updatedAt: FieldValue.serverTimestamp() });
    return { verified: true, state: ID.PIN_STATE.USED };
  });
  if (!outcome.verified) {
    const why = { NOT_YET: 'Too early — a booking PIN can be verified from 2 hours before the booking starts.', USED: 'This booking PIN has already been used.', INVALID: 'This booking is cancelled or refunded — its PIN is no longer valid.', SUSPENDED: 'A refund is in progress for this booking.', ISSUED: 'This booking is not confirmed and paid yet.', EXPIRED: 'This booking has ended.' };
    return { verified: false, state: outcome.state, reason: why[outcome.state] || 'This booking cannot be verified now.' };
  }
  await _audit('ent_booking_verified', uid, env.envId, { bookingRef: env.bookingRef });
  const e2 = { ...env };
  await _system(e2, 'verified', `Booking verified with the buyer's PIN — ${env.bookingRef}.`, null);
  await _notify(env.buyerUid, 'ent_booking_verified', 'Booking verified', `${env.title} — ${env.bookingRef} was verified with your PIN.`, e2, 'verified');
  /* SHOW-UP SETTLES THE BOOKING (owner decision 2026-09-27): the category's canonical settlement pays
     SOKONI's commission and the PROVIDER's business wallet — never the buyer. Never throws here: the
     verification stands; an unsettled booking stays visible in the AdminOS trace. */
  const settlement = await _settleShowUp(env, uid);
  if (settlement && settlement.credited > 0) {
    await _notify(env.providerUid, 'ent_booking_update', 'Payment released', `${env.title} — ${env.bookingRef}: KES ${settlement.credited.toLocaleString()} credited to your business wallet (SOKONI commission deducted).`, e2, 'settled');
  }
  return { verified: true, bookingRef: env.bookingRef, category: env.category, settled: !!(settlement && settlement.credited !== undefined) };
}

async function _settleShowUp(env, actorUid) {
  try {
    let r = null;
    if (env.source.collection === 'providerBookings') r = await require('./provider-ops').settleOnPinRelease(env.source.id, actorUid);
    else if (env.source.collection === 'bookings') r = await require('./venue-payments').settleOnShowUp(env.source.id);
    await _audit('ent_booking_show_up_settlement', actorUid, env.envId, r || { skipped: 'no_settlement_path' });
    return r;
  } catch (e) {
    logger.error('[entBookings] show-up settlement failed', { envId: env.envId, err: e.message });
    await _audit('ent_booking_show_up_settlement_failed', actorUid, env.envId, { error: String(e.message).slice(0, 200) });
    return null;
  }
}

/** Guard for a category's PROTECTED action (venue check-in, service / performance start). */
async function assertVerified(collection, sourceId) {
  const s = await _db().collection(COL.ENV).doc(ID.envIdFor(collection, sourceId)).get();
  if (!s.exists) return { applies: false };
  const env = s.data();
  if (env.category === ID.CATEGORY.EVENT) return { applies: false };
  if (!env.verification || env.verification.state !== 'VERIFIED') {
    fail('failed-precondition', `Verify the buyer's booking PIN first (${ID.PHRASE.BOOKING}) — booking ${env.bookingRef}.`);
  }
  return { applies: true, verified: true };
}

/* ═══ VIEWS — each party sees what they need, nothing more ══════════════════════════════════ */
function _base(env) {
  return {
    bookingRef: env.bookingRef, category: env.category, title: env.title, providerName: env.providerName, location: env.location,
    detail: env.detail, when: env.when, status: env.status, payment: { state: env.payment && env.payment.state, amountCents: env.payment ? env.payment.amountCents : null },
    refund: { state: (env.refund && env.refund.state) || 'NONE' }, pinState: ID.pinState(env, _now()),
    verification: { state: (env.verification && env.verification.state) || 'NOT_APPLICABLE' },
    ticketNumbers: env.ticketNumbers || null, quantity: env.quantity || null, conversationId: env.conversationId || null,
    phrase: ID.phraseFor(env.category),
  };
}
async function _viewFor(env, uid) {
  if (uid === env.buyerUid) {
    const v = { ..._base(env), role: 'buyer' };
    if (env.category !== ID.CATEGORY.EVENT) {
      const s = await _db().collection(COL.SECRETS).doc(env.envId).get();
      v.pin = s.exists && s.data().buyerUid === uid ? s.data().pin : null;       /* the buyer's own booking PIN */
    }
    return v;
  }
  if (uid === env.providerUid) {
    const u = (await _db().collection('users').doc(env.buyerUid).get().catch(() => null));
    const name = u && u.exists ? (u.data().displayName || u.data().name) : null;
    return { ..._base(env), role: 'provider', buyer: { initials: ID.initials(name) }, pin: env.pin ? '••••' : null,
      payment: { state: env.payment && env.payment.state, amountCents: env.payment ? env.payment.amountCents : null } };
  }
  return null;
}

async function mine(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const as = (req.data || {}).as === 'provider' ? 'providerUid' : 'buyerUid';
  const snap = await _db().collection(COL.ENV).where(as, '==', req.auth.uid).limit(100).get();
  const envs = snap.docs.map((x) => x.data()).sort((a, b) => (_ms(b.createdAt) || 0) - (_ms(a.createdAt) || 0));
  return { bookings: await Promise.all(envs.map((e) => _viewFor(e, req.auth.uid))) };
}

async function get(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const env = await _envOf(req.data || {});
  const v = env ? await _viewFor(env, req.auth.uid) : null;
  if (!v) fail('not-found', 'Booking not found.');                         /* a non-party learns nothing */
  return { booking: v };
}

async function _envOf(d) {
  if (d.bookingRef && ID.REF_RE.test(String(d.bookingRef).toUpperCase())) return _envByRef(d.bookingRef);
  if (d.envId && /^(evt|svc|ven)_[A-Za-z0-9_-]{1,128}$/.test(String(d.envId))) { const s = await _db().collection(COL.ENV).doc(String(d.envId)).get(); return s.exists ? s.data() : null; }
  return null;
}

/** Open (or re-attach) the booking's conversation — parties only. Returns the canonical conversation id. */
async function openConversation(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const env = await _envOf(req.data || {});
  if (!env || (req.auth.uid !== env.buyerUid && req.auth.uid !== env.providerUid)) fail('not-found', 'Booking not found.');
  const conversationId = env.conversationId || await _conversation(env.envId, env);
  if (!conversationId) fail('failed-precondition', 'This booking has no counterparty to message.');
  return { conversationId, url: `/chat.html?id=${encodeURIComponent(conversationId)}` };
}

const _h = { entBookingMine: mine, entBookingGet: get, entBookingVerifyPin: verifyPin, entBookingOpenConversation: openConversation };

/* ── the two ends of the PIN, exposed through serviceBookingPin ─────────────────────────────── */
_h.customerGetBookingPin = async (req) => {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const uid = req.auth.uid;
  const bookingId = String((req.data || {}).bookingId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(bookingId)) fail('invalid-argument', 'bookingId is required.');
  const envId = ID.envIdFor('providerBookings', bookingId);
  const s = await _db().collection(COL.ENV).doc(envId).get();
  if (!s.exists) return { issued: false, reason: 'not_yet_issued' };
  const env = s.data();
  if (env.buyerUid !== uid) fail('permission-denied', 'This booking is not yours.');
  const paid = env.payment && env.payment.state === ID.PAYMENT.CONFIRMED;
  const state = ID.pinState(env, _now());
  if (!paid) return { issued: false, reason: 'unpaid', bookingRef: env.bookingRef, phrase: ID.PHRASE.BOOKING };
  const sec = await _db().collection(COL.SECRETS).doc(envId).get();
  return {
    issued: !!(sec.exists && sec.data().pin), pin: sec.exists ? sec.data().pin : null,
    bookingRef: env.bookingRef, phrase: ID.PHRASE.BOOKING, pinState: state,
    verification: env.verification ? env.verification.state : null, payment: env.payment ? env.payment.state : null,
  };
};

_h.providerVerifyBookingPin = async (req) => {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const bookingId = String((req.data || {}).bookingId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(bookingId)) fail('invalid-argument', 'bookingId is required.');
  const s = await _db().collection(COL.ENV).doc(ID.envIdFor('providerBookings', bookingId)).get();
  if (!s.exists) fail('failed-precondition', 'This booking has no PIN yet — it is issued when the customer\'s payment is held by SOKONI.');
  const env = s.data();
  if (env.providerUid !== req.auth.uid) fail('permission-denied', 'Not your booking.');
  return verifyPin({ auth: req.auth, data: { pin: (req.data || {}).pin, bookingRef: env.bookingRef } });
};


/* ═══ ADMINOS — the trace, from the same canonical records ══════════════════════════════════ */
function _admin(req) { if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.'); if (!AC.isAdmin(req)) fail('permission-denied', 'Admin only.'); return req.auth.uid; }
const _clean = (env) => { if (!env) return null; const o = { ...env }; if (o.pin) o.pin = { issued: true, issuedAt: _ms(o.pin.issuedAt) }; ['createdAt', 'updatedAt'].forEach((k) => { o[k] = _ms(o[k]); }); if (o.verification && o.verification.at) o.verification = { ...o.verification, at: _ms(o.verification.at) }; return o; };

async function adminSearch(req) {
  _admin(req);
  const d = req.data || {};
  const by = String(d.by || 'ref'); const v = String(d.value || '').trim();
  if (!v || v.length > 128) fail('invalid-argument', 'A value is required.');
  const db = _db(); let envs = [];
  if (by === 'ref') { const e = await _envByRef(v); envs = e ? [e] : []; if (!envs.length && /^SK-EVT-/.test(v)) { const s = await db.collection(COL.ENV).where('bookingRef', '==', v).limit(5).get(); envs = s.docs.map((x) => x.data()); } }
  else if (by === 'buyer' || by === 'provider') { if (!/^[A-Za-z0-9_-]{1,128}$/.test(v)) fail('invalid-argument', 'Invalid uid.'); envs = (await db.collection(COL.ENV).where(by === 'buyer' ? 'buyerUid' : 'providerUid', '==', v).limit(100).get()).docs.map((x) => x.data()); }
  else if (by === 'source') { const [col, id] = v.split('/'); try { const s = await db.collection(COL.ENV).doc(ID.envIdFor(col, id)).get(); envs = s.exists ? [s.data()] : []; } catch (_) { fail('invalid-argument', 'Use collection/id, e.g. providerBookings/abc.'); } }
  else fail('invalid-argument', 'by must be ref, buyer, provider or source.');
  return { bookings: envs.map(_clean) };
}

async function adminTrace(req) {
  const actor = _admin(req);
  const env = await _envOf(req.data || {});
  if (!env) fail('not-found', 'Booking not found.');
  const db = _db();
  const ref = env.payment && env.payment.paymentRef;
  const [src, pay, conv, attempts, audit] = await Promise.all([
    db.collection(env.source.collection).doc(env.source.id).get(),
    ref ? db.collection('payments').doc(String(ref)).get() : Promise.resolve(null),
    env.conversationId ? db.collection('conversations').doc(env.conversationId).get() : Promise.resolve(null),
    db.collection(COL.ATTEMPTS).doc(`${env.envId}_${env.providerUid}`).get(),
    db.collection(COL.AUDIT).where('envId', '==', env.envId).limit(50).get(),
  ]);
  let money = null;
  if (env.category === ID.CATEGORY.EVENT && ref) {
    const [s, c] = await Promise.all([db.collection('eventSettlements').doc(ref).get(), db.collection('commissionLedger').doc(`evt_${ref}`).get()]);
    money = { settlement: s.exists ? { status: s.data().status, grossCents: s.data().grossCents, commissionCents: s.data().commissionCents, organizerNetCents: s.data().organizerNetCents } : null, commission: c.exists ? { status: c.data().status, commissionCents: c.data().commissionCents } : null };
  } else if (env.source.collection === 'providerBookings') {
    const p = await db.collection('providerPayouts').doc(env.source.id).get();
    money = { payout: p.exists ? { status: p.data().status, gross: p.data().gross, commission: p.data().commission, net: p.data().net } : null };
  } else if (env.source.collection === 'bookings' && ref) {
    const s = await db.collection('venueSettlements').doc(String(ref)).get();
    money = { settlement: s.exists ? { status: s.data().status, grossCents: s.data().grossCents, commissionCents: s.data().commissionCents, netCents: s.data().netCents } : null };
  }
  let messageCount = null;
  if (conv && conv.exists) { try { messageCount = (await conv.ref.collection('messages').count().get()).data().count; } catch (_) { messageCount = null; } }
  const sd = src.exists ? src.data() : null;
  await _db().collection('adminAudit').add({ action: 'ent_booking_trace', performedBy: actor, target: { envId: env.envId }, createdAt: FieldValue.serverTimestamp() }).catch(() => {});
  return {
    booking: _clean(env),
    source: sd ? { collection: env.source.collection, id: env.source.id, status: sd.status || null, paymentStatus: sd.paymentStatus || null, commissionHub: sd.commissionHub || null } : null,
    payment: pay && pay.exists ? { ref, status: pay.data().status || null, amount: pay.data().amount != null ? pay.data().amount : null, provider: pay.data().provider || null } : (ref ? { ref, status: null } : null),
    money,
    conversation: conv && conv.exists ? { id: conv.id, participants: conv.data().participants, status: conv.data().status, messageCount, lastMessageAt: _ms(conv.data().lastMessageAt), content: 'withheld (super admin investigation only)' } : null,
    pin: { state: ID.pinState(env, _now()), providerWrongPins: attempts.exists ? attempts.data().fails || 0 : 0 },
    audit: audit.docs.map((x) => ({ action: x.data().action, by: x.data().performedBy, at: _ms(x.data().createdAt) })).sort((a, b) => (a.at || 0) - (b.at || 0)),
  };
}

/** SUPER ADMIN: read a booking conversation's messages for an investigation — with a stated reason,
 *  audited. Ordinary admins see metadata only (adminTrace). */
async function adminConversation(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  if (!AC.isSuperAdmin(req)) fail('permission-denied', 'Super admin only.');
  const reason = String((req.data || {}).reason || '').trim();
  if (reason.length < 10) fail('invalid-argument', 'State the investigation reason (at least 10 characters).');
  const env = await _envOf(req.data || {});
  if (!env || !env.conversationId) fail('not-found', 'No conversation for that booking.');
  const snap = await _db().collection('conversations').doc(env.conversationId).collection('messages').orderBy('timestamp', 'desc').limit(50).get();
  await _db().collection('adminAudit').add({ action: 'ent_conversation_read', performedBy: req.auth.uid, target: { envId: env.envId, conversationId: env.conversationId }, reason: reason.slice(0, 300), createdAt: FieldValue.serverTimestamp() });
  return { conversationId: env.conversationId, messages: snap.docs.map((m) => ({ id: m.id, senderId: m.data().senderId, type: m.data().type || 'text', text: m.data().deleted ? null : (m.data().text || null), at: _ms(m.data().timestamp) })).reverse() };
}

const _adminH = { entAdminBookings: adminSearch, entAdminBookingTrace: adminTrace, entAdminBookingConversation: adminConversation };

/* ═══ TRIGGERS — one per source engine ══════════════════════════════════════════════════════ */
const TRIG = (collection) => async (event) => {
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  try { return await onSourceWritten(collection, event.params.id, after); }
  catch (e) { logger.error('[entBookings] source sync failed', { collection, id: event.params.id, err: e.message }); return null; }
};
const _secret = () => [require('./event-ops').SOKONI_HMAC_KEY];
const entBookingOnEventOrder = onDocumentWritten({ document: 'eventOrders/{id}', region: REGION, secrets: _secret() }, TRIG('eventOrders'));
const entBookingOnEventRefund = onDocumentWritten({ document: 'eventRefundRequests/{id}', region: REGION, secrets: _secret() }, async (event) => {
  try { const o = await _db().collection('eventOrders').doc(event.params.id).get(); return await onSourceWritten('eventOrders', event.params.id, o.exists ? o.data() : null); }
  catch (e) { logger.error('[entBookings] refund sync failed', { id: event.params.id, err: e.message }); return null; }
});
const entBookingOnProviderBooking = onDocumentWritten({ document: 'providerBookings/{id}', region: REGION, secrets: _secret() }, TRIG('providerBookings'));
const entBookingOnVenueBooking = onDocumentWritten({ document: 'bookings/{id}', region: REGION, secrets: _secret() }, TRIG('bookings'));

module.exports = {
  COL, ATTEMPTS, CONV_TYPE, readSource, ensureEnvelope, syncEnvelope, onSourceWritten, verifyPin, assertVerified, sendReminders, _h, _adminH,
  entBookingOnEventOrder, entBookingOnEventRefund, entBookingOnProviderBooking, entBookingOnVenueBooking,
  _setClock: (fn) => { _now = fn || (() => Date.now()); },
  _setRandom: (fn) => { _randInt = fn || ((n) => crypto.randomInt(0, n)); },
};
