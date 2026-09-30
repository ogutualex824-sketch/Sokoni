/* ============================================================================
   SOKONI — Booking Waitlist  (Phase 2)  functions/booking-waitlist.js

   An ORCHESTRATION layer over the existing booking primitives — NOT a second
   reservation engine. An "offer" IS a standard bookingHolds HOLD; acceptance goes
   through the existing bookingCreate (payment/approval/capacity/idempotency all
   inherited). Architecture-reviewed 2026-07-26 (APPROVED w/ revisions):
     • ordering by (priority ASC, createdAt ASC) — NO stored mutable position;
     • lifecycle: waiting → offered → claimed → completed | expired | cancelled;
     • bookingCleanupHolds owns re-offers (single owner of HOLD expiry);
     • offer carries offerId + offerHoldId + offerExpiresAt (stale/dup-safe accept);
     • config-gated per venue (waitlistEnabled, default false → zero change).

   Handlers are exposed on `exports._h` and merged into bookingDispatch. The
   `offerNextWaitlist` helper is called by bookingCancel (first offer) and
   bookingCleanupHolds (re-offer on expiry).
   ============================================================================ */
'use strict';
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const db = admin.firestore();

const OFFER_TTL_MS  = 15 * 60 * 1000;   /* time to claim an offered slot */
const ACTIVE_BOOKING = ['pending', 'confirmed', 'active'];

const _uid  = (req) => { const u = req.auth && req.auth.uid; if (!u) throw new HttpsError('unauthenticated', 'Sign in required.'); return u; };
const _now  = () => Date.now();
const _wlId = () => 'wl_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
const _offerId = () => 'of_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

/* ── PURE helpers (unit-tested; no I/O) ─────────────────────────────────────── */

/* Queue order: priority ASC then createdAt ASC. No persisted position. */
function _order(a, b) {
  const pa = Number(a.priority || 0), pb = Number(b.priority || 0);
  if (pa !== pb) return pa - pb;
  return (a.createdAt || 0) - (b.createdAt || 0);
}
/* 1-based position of `id` among the WAITING entries (computed on demand). */
function computePosition(entries, id) {
  const waiting = entries.filter(e => e.status === 'waiting').sort(_order);
  const i = waiting.findIndex(e => e.id === id);
  return i < 0 ? null : i + 1;
}
/* First eligible waiting entry for an offer. */
function nextEligible(entries) {
  return entries.filter(e => e.status === 'waiting').sort(_order)[0] || null;
}
/* Whether an accept is valid. `entry`/`hold` may be null. Pure. */
function canAccept(entry, hold, uid, offerId, now) {
  if (!entry) return { ok: false, reason: 'not-found' };
  if (entry.status !== 'offered') return { ok: false, reason: 'not-offered' };
  if (entry.customerId !== uid) return { ok: false, reason: 'not-owner' };
  if (!offerId || entry.offerId !== offerId) return { ok: false, reason: 'stale-offer' };
  if (!hold) return { ok: false, reason: 'hold-missing' };
  if (hold.userId !== uid) return { ok: false, reason: 'hold-owner' };
  if (!(hold.expiresAt > now)) return { ok: false, reason: 'hold-expired' };
  return { ok: true };
}

/* ── SERVER helper: offer the freed slot to the next person ──────────────────
   Transactional: re-checks the slot is free (no active booking / non-offer hold
   overlap), picks the next WAITING entry, mints an offer HOLD + offerId, flips
   the entry to `offered`. Idempotent-ish: if the slot is taken or the queue is
   empty, it no-ops. Called by bookingCancel and bookingCleanupHolds. */
async function offerNextWaitlist(venueId, slot) {
  if (!venueId || !slot || slot.startTs == null || slot.endTs == null) return null;
  const startTs = Number(slot.startTs), endTs = Number(slot.endTs);
  const slotKey = slot.slotKey || `${slot.date}_${startTs}_${endTs}`;
  const now = _now();

  /* Read candidates + conflicts OUTSIDE the txn (transaction re-validates the
     critical write via the offerLock doc). */
  const wlSnap = await db.collection('waitlists')
    .where('slotKey', '==', slotKey).where('status', '==', 'waiting').get();
  if (wlSnap.empty) return null;
  const candidates = wlSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort(_order);

  /* Slot must be genuinely free right now. */
  const bSnap = await db.collection('bookings')
    .where('venueId', '==', venueId).where('endTs', '>', startTs)
    .where('status', 'in', ACTIVE_BOOKING).get();
  const booked = bSnap.docs.some(d => { const b = d.data(); return b.startTs < endTs && b.endTs > startTs; });
  if (booked) return null;
  const hSnap = await db.collection('bookingHolds')
    .where('venueId', '==', venueId).where('expiresAt', '>', now).get();
  const held = hSnap.docs.some(d => { const h = d.data(); return h.startTs < endTs && h.endTs > startTs; });
  if (held) return null;

  const entry = candidates[0];
  const offerId    = _offerId();
  const offerHoldId = 'hold_' + offerId;
  const offerExpiresAt = now + OFFER_TTL_MS;

  await db.runTransaction(async txn => {
    const eref = db.collection('waitlists').doc(entry.id);
    const esnap = await txn.get(eref);
    if (!esnap.exists || esnap.data().status !== 'waiting') return; /* lost the race */
    /* create the offer HOLD (a standard bookingHolds doc) */
    txn.set(db.collection('bookingHolds').doc(offerHoldId), {
      venueId, userId: entry.customerId, startTs, endTs,
      date: slot.date || null, expiresAt: offerExpiresAt,
      offerId, waitlistId: entry.id, source: 'waitlist', createdAt: now,
    });
    txn.update(eref, { status: 'offered', offerId, offerHoldId, offerExpiresAt, offeredAt: now, updatedAt: now });
  });

  /* Notify (Admin SDK — bypasses rules; best-effort) */
  try {
    await db.collection('notifications').add({
      targetUid: entry.customerId, type: 'booking',
      heading: 'A booking slot opened up!',
      sub: 'A spot you waitlisted is available. Claim it before it expires.',
      link: `venue-booking.html?venueId=${venueId}&offer=${entry.id}`,
      offerId, offerExpiresAt, createdAt: now, read: false,
    });
  } catch (e) { /* notification failure must not block the offer */ }
  return { waitlistId: entry.id, offerId, offerHoldId, offerExpiresAt };
}

/* ── SERVER helper: reap expired OFFER holds ─────────────────────────────────
   Called by bookingCleanupHolds with the expired-hold docs it is about to delete.
   For each hold that is a waitlist offer, mark the entry `expired` (only if it is
   still `offered` for THAT offerId — a claimed/cancelled entry is left alone) and
   re-offer the slot to the next person. Single owner of offer-expiry, per review.
   Best-effort per hold — one failure must not stop the batch. */
async function reapExpiredOffers(expiredHolds) {
  let expired = 0, reoffered = 0;
  for (const h of (expiredHolds || [])) {
    if (h.source !== 'waitlist' || !h.waitlistId) continue;
    try {
      const ref = db.collection('waitlists').doc(h.waitlistId);
      const flipped = await db.runTransaction(async txn => {
        const s = await txn.get(ref);
        if (!s.exists) return false;
        const e = s.data();
        if (e.status !== 'offered' || e.offerId !== h.offerId) return false; /* claimed / superseded */
        txn.update(ref, { status: 'expired', expiredAt: _now(), updatedAt: _now() });
        return true;
      });
      if (!flipped) continue;
      expired++;
      const r = await offerNextWaitlist(h.venueId, { date: h.date, startTs: h.startTs, endTs: h.endTs });
      if (r) reoffered++;
    } catch (err) { console.warn('[waitlist] reap offer', h.waitlistId, err.message); }
  }
  return { expired, reoffered };
}

/* ── HANDLERS (exposed via bookingDispatch) ─────────────────────────────────── */
const _h = {};

/* Join the queue for a full/held slot. */
_h.bookingJoinWaitlist = async (req) => {
  const uid = _uid(req);
  const d = req.data || {};
  const { venueId, date } = d;
  const startTs = Number(d.startTs), endTs = Number(d.endTs);
  if (!venueId || !date || !startTs || !endTs || endTs <= startTs) {
    throw new HttpsError('invalid-argument', 'venueId, date, startTs, endTs required');
  }
  const venue = (await db.collection('venues').doc(venueId).get()).data();
  if (!venue) throw new HttpsError('not-found', 'Venue not found');
  if (!venue.waitlistEnabled) throw new HttpsError('failed-precondition', 'This provider does not offer a waitlist');

  const slotKey = `${date}_${startTs}_${endTs}`;
  /* Dedup: one ACTIVE (waiting/offered) entry per customer per slot. */
  const dup = await db.collection('waitlists')
    .where('slotKey', '==', slotKey).where('customerId', '==', uid)
    .where('status', 'in', ['waiting', 'offered']).limit(1).get();
  if (!dup.empty) {
    const e = dup.docs[0];
    return { waitlistId: e.id, status: e.data().status, alreadyOnList: true };
  }
  const id = _wlId();
  const now = _now();
  await db.collection('waitlists').doc(id).set({
    venueId, slotKey, date, startTs, endTs, startTime: d.startTime || null, endTime: d.endTime || null,
    customerId: uid, priority: 0, status: 'waiting', createdAt: now, updatedAt: now,
  });
  return { waitlistId: id, status: 'waiting' };
};

/* Leave the queue (or decline an offer). */
_h.bookingLeaveWaitlist = async (req) => {
  const uid = _uid(req);
  const { waitlistId } = req.data || {};
  if (!waitlistId) throw new HttpsError('invalid-argument', 'waitlistId required');
  const ref = db.collection('waitlists').doc(waitlistId);
  const holdToRelease = await db.runTransaction(async txn => {
    const s = await txn.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'Waitlist entry not found');
    const e = s.data();
    if (e.customerId !== uid) throw new HttpsError('permission-denied', 'Not your waitlist entry');
    if (!['waiting', 'offered'].includes(e.status)) throw new HttpsError('failed-precondition', `Cannot leave — status is ${e.status}`);
    txn.update(ref, { status: 'cancelled', updatedAt: _now() });
    return e.status === 'offered' ? e.offerHoldId : null;
  });
  /* If they declined an active offer, release the HOLD so it can be re-offered. */
  if (holdToRelease) {
    try { await db.collection('bookingHolds').doc(holdToRelease).delete(); } catch (e) {}
    const s = await db.collection('waitlists').doc(waitlistId).get();
    if (s.exists) await offerNextWaitlist(s.data().venueId, s.data());
  }
  return { ok: true, status: 'cancelled' };
};

/* Accept an offer → claim (atomic, double-accept-safe) → bookingCreate → complete. */
_h.bookingAcceptOffer = async (req) => {
  const uid = _uid(req);
  const d = req.data || {};
  const { waitlistId, offerId } = d;
  if (!waitlistId || !offerId) throw new HttpsError('invalid-argument', 'waitlistId and offerId required');

  const ref = db.collection('waitlists').doc(waitlistId);
  /* ── Atomic CLAIM: flips offered → claimed only if the offer is still valid.
     Two devices accepting the same offer: one claims, the other sees status
     !== 'offered' → "Offer no longer available". Single transition. ── */
  const entry = await db.runTransaction(async txn => {
    const s = await txn.get(ref);
    const e = s.exists ? s.data() : null;
    const holdSnap = e && e.offerHoldId ? await txn.get(db.collection('bookingHolds').doc(e.offerHoldId)) : null;
    const hold = holdSnap && holdSnap.exists ? holdSnap.data() : null;
    const v = canAccept(e, hold, uid, offerId, _now());
    if (!v.ok) throw new HttpsError(
      v.reason === 'not-found' ? 'not-found' : 'failed-precondition',
      v.reason === 'hold-expired' || v.reason === 'stale-offer' || v.reason === 'not-offered'
        ? 'Offer no longer available' : 'Cannot accept this offer');
    txn.update(ref, { status: 'claimed', claimedAt: _now(), updatedAt: _now() });
    return { ...e, id: waitlistId };
  });

  /* Convert the HOLD into a real booking via the EXISTING create flow. */
  const booking = require('./booking');
  let created;
  try {
    created = await booking._h.bookingCreate({
      auth: req.auth, app: req.app,
      data: {
        venueId: entry.venueId, holdId: entry.offerHoldId,
        date: entry.date, startTime: entry.startTime, endTime: entry.endTime,
        startTs: entry.startTs, endTs: entry.endTs,
        paymentId: d.paymentId, addOns: d.addOns || [], notes: d.notes || '',
        idempotencyKey: d.idempotencyKey || ('wl_' + waitlistId + '_' + offerId),
      },
    });
  } catch (err) {
    /* Create failed (payment/capacity) — revert claim so they can retry or it can
       re-offer on expiry. */
    try { await ref.update({ status: 'offered', updatedAt: _now() }); } catch (e) {}
    throw err;
  }
  await ref.update({ status: 'completed', bookingId: created.bookingId || null, completedAt: _now(), updatedAt: _now() });
  return { ok: true, status: 'completed', bookingId: created.bookingId, booking: created };
};

/* List the caller's waitlist entries with computed position. */
_h.bookingGetMyWaitlist = async (req) => {
  const uid = _uid(req);
  const snap = await db.collection('waitlists')
    .where('customerId', '==', uid)
    .where('status', 'in', ['waiting', 'offered', 'claimed']).limit(50).get();
  const mine = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  /* Position needs the whole queue per slot — fetch waiting peers per slotKey. */
  const out = [];
  for (const e of mine) {
    let position = null;
    if (e.status === 'waiting') {
      const peers = await db.collection('waitlists').where('slotKey', '==', e.slotKey).where('status', '==', 'waiting').get();
      position = computePosition(peers.docs.map(p => ({ id: p.id, ...p.data() })), e.id);
    }
    out.push({ ...e, position });
  }
  return { entries: out };
};

module.exports = { _h, offerNextWaitlist, reapExpiredOffers, computePosition, nextEligible, canAccept };
