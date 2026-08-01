'use strict';
/* ============================================================================
   SOKONI — Booking Resolution Engine   functions/booking-resolution.js
   Slice 2, Step 1: the SINGLE resolution engine for every "affected booking".

   PRINCIPLE (unchanged): an availability change never directly modifies a confirmed
   booking. Instead it raises a managed resolution workflow. The booking's core `status`
   and its HELD PAYMENT are left untouched here — ACTION_REQUIRED lives in a `resolution`
   overlay, so existing settlement / dashboard / customer logic keeps seeing a normal
   confirmed booking until the workflow resolves it (reschedule / cancel — Step 2/3).

   State machine (resolution.status):
     (none) ──availability conflict──▶ ACTION_REQUIRED ──▶ RESCHEDULED | CANCELLED | EXCEPTION

   Stores:
     • providerBookings/{id}.resolution   — the overlay on the booking
     • affectedBookings/{bookingId}       — the admin/provider queue (data only)
     • bookingEvents/{auto}               — immutable, append-only canonical event log

   Routed through providerDispatch. Step 1 ops: providerRaiseAffectedBookings (raise),
   providerListAffectedBookings (provider queue read). No payment writes in Step 1.
   ========================================================================== */
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const { HttpsError } = require('firebase-functions/v2/https');
const FV = admin.firestore.FieldValue;
let _notify = null;
try { _notify = require('./notify').notify; } catch (_) { _notify = null; }

const RES = { NONE: 'NONE', ACTION_REQUIRED: 'ACTION_REQUIRED', RESCHEDULED: 'RESCHEDULED', CANCELLED: 'CANCELLED', EXCEPTION: 'EXCEPTION' };
const EVT = {
  CREATED: 'BOOKING_CREATED', CONFIRMED: 'BOOKING_CONFIRMED', AVAIL_CHANGED: 'AVAILABILITY_CHANGED',
  AFFECTED: 'BOOKING_AFFECTED', CUST_NOTIFIED: 'CUSTOMER_NOTIFIED', PROPOSED: 'PROVIDER_PROPOSED_RESCHEDULE',
  CUST_ACCEPTED: 'CUSTOMER_ACCEPTED', CUST_DECLINED: 'CUSTOMER_DECLINED', RESCHEDULED: 'BOOKING_RESCHEDULED',
  CANCELLED: 'BOOKING_CANCELLED', REFUND_DONE: 'REFUND_COMPLETED',
};
const REASONS = ['sick', 'emergency', 'venue_unavailable', 'equipment_failure', 'personal_emergency', 'weather', 'other'];
const DEADLINE_HOURS = 48;
const ACTIVE_STATES = ['pending', 'requested', 'confirmed', 'in_progress'];

function _uid(req) { const u = req.auth && req.auth.uid; if (!u) throw new HttpsError('unauthenticated', 'Authentication required.'); return u; }
function _san(s, n) { return String(s == null ? '' : s).slice(0, n); }

/* Immutable event. Participants (providerId/customerUid) are denormalised so security rules
   can scope reads without a join. bookingEvents is append-only (create-only in rules). */
function _emit(t, bookingId, type, actor, participants, data) {
  t.set(db.collection('bookingEvents').doc(), {
    bookingId, type, actor: actor || 'system',
    providerId: (participants && participants.providerId) || null,
    customerUid: (participants && participants.customerUid) || null,
    data: data || {}, at: FV.serverTimestamp(), ts: Date.now(),
  });
}

const _h = {};

/* providerRaiseAffectedBookings — move confirmed bookings stranded by an availability change
   into ACTION_REQUIRED. Idempotent per booking. Owner-scoped. Never touches core status/payment.
   Input: { bookingIds:[...], reason∈REASONS }. */
_h.providerRaiseAffectedBookings = async (req) => {
  const uid = _uid(req);
  const d = req.data || {};
  const ids = Array.isArray(d.bookingIds) ? d.bookingIds.slice(0, 200).map(function (x) { return _san(x, 128); }) : [];
  const reason = _san(d.reason, 40);
  if (!ids.length) throw new HttpsError('invalid-argument', 'bookingIds required.');
  if (REASONS.indexOf(reason) < 0) throw new HttpsError('invalid-argument', 'A valid reason is required.');

  const deadlineTs = Date.now() + DEADLINE_HOURS * 3600000;
  const raised = [], skipped = [], notifyJobs = [];

  for (let i = 0; i < ids.length; i++) {
    const bookingId = ids[i];
    const bRef = db.collection('providerBookings').doc(bookingId);
    const afRef = db.collection('affectedBookings').doc(bookingId);
    /* eslint-disable no-loop-func */
    const outcome = await db.runTransaction(async (t) => {
      const bSnap = await t.get(bRef);
      if (!bSnap.exists) return { skip: 'not-found' };
      const b = bSnap.data();
      if (b.providerId !== uid) return { skip: 'not-owner' };
      if (ACTIVE_STATES.indexOf(b.status) < 0) return { skip: 'terminal' };
      if (b.resolution && b.resolution.status === RES.ACTION_REQUIRED) return { skip: 'already' };

      const parts = { providerId: uid, customerUid: b.customerUid || null };
      t.update(bRef, {
        resolution: { status: RES.ACTION_REQUIRED, reason: reason, raisedAt: FV.serverTimestamp(), deadlineTs: deadlineTs },
        updatedAt: FV.serverTimestamp(),
      });
      t.set(afRef, {
        bookingId: bookingId, providerId: uid, customerUid: b.customerUid || null,
        reason: reason, createdAt: FV.serverTimestamp(), resolutionStatus: RES.ACTION_REQUIRED,
        deadlineTs: deadlineTs, refundPending: false, reschedulePending: false,
        service: b.service || b.serviceName || null, date: b.date || null, startTime: b.startTime || null,
        paymentStatus: b.paymentStatus || null, price: Number(b.price) || 0,
      }, { merge: true });
      _emit(t, bookingId, EVT.AVAIL_CHANGED, uid, parts, { reason: reason });
      _emit(t, bookingId, EVT.AFFECTED, uid, parts, { reason: reason, deadlineTs: deadlineTs });
      _emit(t, bookingId, EVT.CUST_NOTIFIED, 'system', parts, { channel: 'inapp' });
      return { raised: true, customerUid: b.customerUid || null, service: b.service || b.serviceName || 'your booking', date: b.date, startTime: b.startTime };
    });
    /* eslint-enable no-loop-func */

    if (outcome.raised) {
      raised.push(bookingId);
      if (outcome.customerUid && _notify) {
        notifyJobs.push(_notify({
          uid: outcome.customerUid, type: 'booking_affected',
          title: 'Your booking needs attention',
          body: 'The provider changed availability affecting ' + outcome.service + ' on ' + (outcome.date || '') + ' ' + (outcome.startTime || '') + '. Please choose: accept a new time, pick another slot, or request a refund.',
          deepLink: '/my-bookings', group: 'bookings', dedupeKey: 'affected_' + bookingId,
          data: { bookingId: bookingId, kind: 'booking_affected' },
        }).catch(function () {}));
      }
    } else {
      skipped.push({ bookingId: bookingId, reason: outcome.skip });
    }
  }
  await Promise.all(notifyJobs);
  return { ok: true, raisedCount: raised.length, raised: raised, skipped: skipped };
};

/* providerListAffectedBookings — provider's own ACTION_REQUIRED queue. Single-field query
   (providerId) + in-memory status filter → no composite index. */
_h.providerListAffectedBookings = async (req) => {
  const uid = _uid(req);
  const snap = await db.collection('affectedBookings').where('providerId', '==', uid).get();
  const items = snap.docs
    .map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); })
    .filter(function (a) { return a.resolutionStatus === RES.ACTION_REQUIRED; })
    .sort(function (a, b) { return (a.deadlineTs || 0) - (b.deadlineTs || 0); });
  return { count: items.length, items: items };
};

module.exports = { _h, RES, EVT, REASONS, DEADLINE_HOURS };
