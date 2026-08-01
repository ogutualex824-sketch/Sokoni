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
  CUST_ACCEPTED: 'CUSTOMER_ACCEPTED', CUST_DECLINED: 'CUSTOMER_DECLINED', CUST_PROPOSED: 'CUSTOMER_PROPOSED_TIME',
  PROV_ACCEPTED: 'PROVIDER_ACCEPTED_TIME', PROV_DECLINED: 'PROVIDER_DECLINED', RESCHEDULED: 'BOOKING_RESCHEDULED',
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

/* ── Step 2: negotiation state machine ───────────────────────────────────────
   Ownership matrix (enforced): provider PROPOSES, customer ACCEPT/DECLINE/SUGGESTS,
   provider APPROVES the customer's suggestion. Single active proposal per booking.
   A proposed time MUST pass the canonical validator (_prepareSlot); the actual move
   REUSES providerRescheduleBooking (no duplicate reschedule/payment logic). The booking's
   core status + held payment stay untouched — only the resolution overlay + slot move. */
async function _validateSlot(providerId, date, startTime, durationMins) {
  const { _prepareSlot } = require('./booking-service');
  return _prepareSlot(db, { providerId: providerId, date: date, startTime: startTime, durationMins: durationMins });
}
async function _execReschedule(actorUid, bookingId, date, startTime) {
  const opsH = require('./provider-ops')._h;   // accepts provider OR customer; validates + slot-CAS
  return opsH.providerRescheduleBooking({ auth: { uid: actorUid }, data: { bookingId: bookingId, date: date, startTime: startTime } });
}
function _batchEvent(batch, bookingId, type, actor, parts, data) {
  batch.set(db.collection('bookingEvents').doc(), {
    bookingId: bookingId, type: type, actor: actor || 'system',
    providerId: (parts && parts.providerId) || null, customerUid: (parts && parts.customerUid) || null,
    data: data || {}, at: FV.serverTimestamp(), ts: Date.now(),
  });
}
function _notifySafe(job) { if (_notify && job.uid) { try { return _notify(job).catch(function () {}); } catch (_) {} } return Promise.resolve(); }

async function _propose(req, party) {
  const uid = _uid(req), d = req.data || {};
  const bookingId = _san(d.bookingId, 128), date = _san(d.date, 10), startTime = _san(d.startTime, 5);
  if (!bookingId || !date || !startTime) throw new HttpsError('invalid-argument', 'bookingId, date, startTime required.');
  const bSnap = await db.collection('providerBookings').doc(bookingId).get();
  if (!bSnap.exists) throw new HttpsError('not-found', 'Booking not found.');
  const b = bSnap.data();
  if ((party === 'provider' ? b.providerId : b.customerUid) !== uid) throw new HttpsError('permission-denied', 'Not your booking.');
  if (!(b.resolution && b.resolution.status === RES.ACTION_REQUIRED)) throw new HttpsError('failed-precondition', 'This booking is not awaiting resolution.');
  const cur = b.resolution.proposal;
  if (cur && /^pending_/.test(cur.status || '')) throw new HttpsError('failed-precondition', 'A proposal is already pending — resolve it first.');
  const durationMins = Math.max(15, Number(b.durationMins) || 30);
  await _validateSlot(b.providerId, date, startTime, durationMins);   // canonical validator — throws if not bookable
  const expiresAt = Date.now() + DEADLINE_HOURS * 3600000;
  const proposal = { by: party, date: date, startTime: startTime, status: party === 'provider' ? 'pending_customer' : 'pending_provider', proposedAt: Date.now(), expiresAt: expiresAt };
  const parts = { providerId: b.providerId, customerUid: b.customerUid || null };
  const batch = db.batch();
  batch.update(db.collection('providerBookings').doc(bookingId), { 'resolution.proposal': proposal, updatedAt: FV.serverTimestamp() });
  batch.set(db.collection('affectedBookings').doc(bookingId), { proposal: proposal, reschedulePending: true, updatedAt: FV.serverTimestamp() }, { merge: true });
  _batchEvent(batch, bookingId, party === 'provider' ? EVT.PROPOSED : EVT.CUST_PROPOSED, uid, parts, { date: date, startTime: startTime, expiresAt: expiresAt });
  await batch.commit();
  await _notifySafe({ uid: party === 'provider' ? b.customerUid : b.providerId, type: 'booking_reschedule_proposed', title: 'New time proposed', body: 'A new time was proposed for your booking: ' + date + ' ' + startTime + '. Accept, suggest another, or request a refund.', deepLink: '/my-bookings', group: 'bookings', dedupeKey: 'proposal_' + bookingId, data: { bookingId: bookingId, kind: 'reschedule_proposed' } });
  return { ok: true, proposal: proposal };
}

async function _respond(req, party) {
  const uid = _uid(req), d = req.data || {};
  const bookingId = _san(d.bookingId, 128), action = _san(d.action, 20);
  if (['accept', 'decline'].indexOf(action) < 0) throw new HttpsError('invalid-argument', 'action must be accept or decline.');
  const bSnap = await db.collection('providerBookings').doc(bookingId).get();
  if (!bSnap.exists) throw new HttpsError('not-found', 'Booking not found.');
  const b = bSnap.data();
  if ((party === 'provider' ? b.providerId : b.customerUid) !== uid) throw new HttpsError('permission-denied', 'Not your booking.');
  const prop = b.resolution && b.resolution.proposal;
  const expectStatus = party === 'customer' ? 'pending_customer' : 'pending_provider';
  const expectBy = party === 'customer' ? 'provider' : 'customer';   // you respond to the COUNTERPARTY's proposal
  if (!prop || prop.status !== expectStatus || prop.by !== expectBy) throw new HttpsError('failed-precondition', 'No proposal awaiting your response.');
  const parts = { providerId: b.providerId, customerUid: b.customerUid || null };

  if (action === 'accept') {
    await _execReschedule(uid, bookingId, prop.date, prop.startTime);   // reuse canonical reschedule (re-validates + slot-CAS)
    const batch = db.batch();
    batch.update(db.collection('providerBookings').doc(bookingId), { resolution: { status: RES.RESCHEDULED, reason: (b.resolution && b.resolution.reason) || null, resolvedAt: FV.serverTimestamp() }, updatedAt: FV.serverTimestamp() });
    batch.set(db.collection('affectedBookings').doc(bookingId), { resolutionStatus: RES.RESCHEDULED, reschedulePending: false, resolvedAt: FV.serverTimestamp(), proposal: FV.delete() }, { merge: true });
    _batchEvent(batch, bookingId, party === 'customer' ? EVT.CUST_ACCEPTED : EVT.PROV_ACCEPTED, uid, parts, { date: prop.date, startTime: prop.startTime });
    _batchEvent(batch, bookingId, EVT.RESCHEDULED, uid, parts, { date: prop.date, startTime: prop.startTime });
    await batch.commit();
    await _notifySafe({ uid: party === 'customer' ? b.providerId : b.customerUid, type: 'booking_rescheduled', title: 'Booking rescheduled', body: 'The booking was rescheduled to ' + prop.date + ' ' + prop.startTime + '.', deepLink: '/my-bookings', group: 'bookings', data: { bookingId: bookingId } });
    return { ok: true, status: RES.RESCHEDULED };
  }
  const batch = db.batch();
  batch.update(db.collection('providerBookings').doc(bookingId), { 'resolution.proposal': FV.delete(), updatedAt: FV.serverTimestamp() });
  batch.set(db.collection('affectedBookings').doc(bookingId), { proposal: FV.delete(), reschedulePending: false, updatedAt: FV.serverTimestamp() }, { merge: true });
  _batchEvent(batch, bookingId, party === 'customer' ? EVT.CUST_DECLINED : EVT.PROV_DECLINED, uid, parts, {});
  await batch.commit();
  await _notifySafe({ uid: party === 'customer' ? b.providerId : b.customerUid, type: 'booking_proposal_declined', title: 'Proposal declined', body: 'The proposed time was declined. Another time can be proposed.', deepLink: '/my-bookings', group: 'bookings', data: { bookingId: bookingId } });
  return { ok: true, status: RES.ACTION_REQUIRED };
}

/* bookingGetTimeline — participant-scoped read of the resolution overlay + immutable event
   timeline for one booking. Powers the Negotiation Timeline on both customer and provider views.
   Admin SDK reads (bypasses rules); we enforce participant access here. */
_h.bookingGetTimeline = async (req) => {
  const uid = _uid(req);
  const bookingId = _san((req.data || {}).bookingId, 128);
  if (!bookingId) throw new HttpsError('invalid-argument', 'bookingId required.');
  const bSnap = await db.collection('providerBookings').doc(bookingId).get();
  if (!bSnap.exists) throw new HttpsError('not-found', 'Booking not found.');
  const b = bSnap.data();
  if (b.providerId !== uid && b.customerUid !== uid) throw new HttpsError('permission-denied', 'Not your booking.');
  const evSnap = await db.collection('bookingEvents').where('bookingId', '==', bookingId).get();
  const events = evSnap.docs
    .map(function (d) { const x = d.data(); return { type: x.type, actor: x.actor || null, ts: Number(x.ts) || 0, data: x.data || {} }; })
    .sort(function (a, b2) { return a.ts - b2.ts; });
  const r = b.resolution || null;
  return {
    bookingId: bookingId,
    role: b.providerId === uid ? 'provider' : 'customer',
    resolutionStatus: r ? r.status : null,
    reason: r ? r.reason || null : null,
    proposal: r ? r.proposal || null : null,
    service: b.service || b.serviceName || null,
    date: b.date || null, startTime: b.startTime || null,
    events: events,
  };
};

_h.providerProposeReschedule = function (req) { return _propose(req, 'provider'); };     // provider proposes
_h.customerProposeTime = function (req) { return _propose(req, 'customer'); };            // customer suggests
_h.customerRespondToProposal = function (req) { return _respond(req, 'customer'); };      // customer accept/decline provider proposal
_h.providerRespondToCustomerProposal = function (req) { return _respond(req, 'provider'); }; // provider accept/decline customer suggestion

module.exports = { _h, RES, EVT, REASONS, DEADLINE_HOURS };
