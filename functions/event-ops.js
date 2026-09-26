'use strict';
/**
 * SOKONI — Event operations: ticket PINs, event-scoped temporary staff, PIN admission.
 * ============================================================================================
 * TICKET IDENTITY — PIN FIRST, QR OPTIONAL. Every ISSUED ticket gets:
 *   ticketNumber  SK-EVT-XXXXXX   human reference (random, never sequential; not a credential)
 *   PIN           XXXX-XXXX       the admission credential (8 chars from a 32-char alphabet with no
 *                                 0/O/1/I — ~1.1 × 10^12 values), generated server-side with
 *                                 crypto.randomInt
 * The PIN is a BEARER CREDENTIAL, so:
 *   · it is stored as HMAC-SHA256(SOKONI_HMAC_KEY, "evtpin|eventId|PIN") — the hash on the ticket
 *     is useless without the server key, and binds the PIN to ONE event (a PIN from event A can
 *     never match a ticket of event B);
 *   · the raw PIN lives only in eventTicketSecrets/{ticketId} (no client rule — deny by default)
 *     and is returned only to the ticket's buyer, or to the cashier who sold a walk-in ticket;
 *   · it is never logged, never put in a notification, never stored in an audit row;
 *   · uniqueness per event is enforced by create() on eventTicketPins/{eventId}_{hash};
 *   · verification is rate-limited per staff member AND per event (distributed guessing), with
 *     transactional counters; admission is a transaction with a create()-only admission record,
 *     so two gates admitting the same PIN at once cannot both succeed.
 * The QR/token of the legacy check-in stays as a convenience; SOKONI never depends on scanning.
 *
 * STAFF — organizer → event → temporary staff member → role → event-day capabilities.
 *   eventStaff/{eventId}_{uid}  { role, active, startAt, endAt, organizerUid } — NOT permanent
 *   employees, NOT a claim: every operation re-reads the assignment, so revocation and expiry are
 *   immediate. Capabilities are a closed table; none of them touches the wallet, payouts, refunds
 *   approval, commission, event ownership, AdminOS or another event.
 *
 * Canonical key: SOKONI_HMAC_KEY (existing secret, also used by delivery PINs). In Cloud Functions a
 * missing key FAILS CLOSED; only the local test process uses a fixed test key.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const crypto = require('crypto');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const AC = require('./admin-claim');

const REGION = 'us-central1';
const SOKONI_HMAC_KEY = defineSecret('SOKONI_HMAC_KEY');
const OPTS = { region: REGION, enforceAppCheck: true, secrets: [SOKONI_HMAC_KEY] };
const _db = () => getFirestore();
const fail = (code, msg) => { throw new HttpsError(code, msg); };
let _now = () => Date.now();

const COL = Object.freeze({
  EVENTS: 'events', TICKETS: 'eventTickets', SECRETS: 'eventTicketSecrets', PINS: 'eventTicketPins',
  STAFF: 'eventStaff', INVITES: 'eventStaffInvites', ADMISSIONS: 'eventAdmissions', ATTEMPTS: 'eventPinAttempts',
  AUDIT: 'eventOpsAudit',
});

/* ═══ PIN ═══════════════════════════════════════════════════════════════════════════════ */
const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   /* 32 chars, no 0/O/1/I */
const PIN_LEN = 8;

function _rand(n) { let s = ''; for (let i = 0; i < n; i++) s += PIN_ALPHABET[crypto.randomInt(0, PIN_ALPHABET.length)]; return s; }
function generatePin() { const r = _rand(PIN_LEN); return r.slice(0, 4) + '-' + r.slice(4); }
function generateTicketNumber() { return 'SK-EVT-' + _rand(6); }

/** Canonical form: separators/spaces removed, upper-cased; anything outside the alphabet → null. */
function normalizePin(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== PIN_LEN) return null;
  for (const c of s) if (PIN_ALPHABET.indexOf(c) < 0) return null;
  return s;
}

function _pinKey() {
  let k = null;
  try { k = SOKONI_HMAC_KEY.value(); } catch (_) { k = null; }
  if (k) return k;
  if (process.env.K_SERVICE || process.env.FUNCTION_TARGET) fail('failed-precondition', 'Ticket credential key unavailable.');
  return 'sokoni-event-pin-TEST-ONLY';            /* local test process only — never in Cloud Functions */
}

function pinHash(eventId, rawPin) {
  const p = normalizePin(rawPin);
  if (!p) return null;
  return crypto.createHmac('sha256', _pinKey()).update(`evtpin|${String(eventId)}|${p}`).digest('hex');
}

/**
 * Issue credentials for ONE ticket inside the caller's transaction/batch.
 * Writes the PIN index (create — uniqueness) and the secret; returns the fields to put on the ticket.
 * Inside a transaction a hash collision aborts the create and the whole transaction retries,
 * generating a fresh PIN — so a duplicate PIN within an event is impossible, not improbable.
 */
function issueCredentials(writer, { eventId, ticketId, buyerUid = null, soldBy = null }) {
  const db = _db();
  const pin = generatePin();
  const hash = pinHash(eventId, pin);
  const ticketNumber = generateTicketNumber();
  writer.create(db.collection(COL.PINS).doc(`${eventId}_${hash}`), { eventId, ticketId, createdAt: FieldValue.serverTimestamp() });
  writer.set(db.collection(COL.SECRETS).doc(ticketId), {
    ticketId, eventId, pin, buyerUid: buyerUid || null, soldBy: soldBy || null, createdAt: FieldValue.serverTimestamp(),
  });
  return { ticketNumber, pinHash: hash, admissionStatus: 'NOT_ADMITTED', refundStatus: 'NONE', credentialIssuedAt: FieldValue.serverTimestamp() };
}

/* ═══ STAFF / ACTOR AUTHORITY ════════════════════════════════════════════════════════════ */
/* The ONLY capabilities an event operation checks. None concerns money movement: withdrawals,
   payout destinations, refund APPROVAL, commission, ownership and AdminOS are simply absent. */
const CAPS = Object.freeze({
  SELL: 'sell', VIEW_OWN_SALES: 'view_own_sales', VIEW_SALES: 'view_sales', ADMIT: 'admit',
  MARKETING: 'marketing', MANAGE_STAFF: 'manage_staff', FINANCE: 'finance', MANAGE_EVENT: 'manage_event',
});
const STAFF_ROLES = Object.freeze({
  cashier:   [CAPS.SELL, CAPS.VIEW_OWN_SALES],
  admission: [CAPS.ADMIT],
  marketing: [CAPS.MARKETING],
  manager:   [CAPS.SELL, CAPS.VIEW_SALES, CAPS.ADMIT, CAPS.MARKETING],
});
const ORGANIZER_CAPS = Object.freeze(Object.values(CAPS));
/* A staff assignment is temporary by construction: it cannot outlive the event by more than this. */
const MAX_AFTER_EVENT_MS = 48 * 3600 * 1000;

const _ms = (v) => { if (!v) return null; if (typeof v.toMillis === 'function') return v.toMillis(); const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };
function eventEndMs(ev) { return _ms(ev && ev.endDate) || _ms(ev && ev.startDate); }

/** Is this staff assignment usable right now? Pure. */
function staffActive(s, nowMs) {
  if (!s || s.active !== true || s.status === 'revoked') return { ok: false, why: 'revoked_or_inactive' };
  const a = _ms(s.startAt), b = _ms(s.endAt);
  if (a != null && nowMs < a) return { ok: false, why: 'not_started' };
  if (b == null || nowMs >= b) return { ok: false, why: 'expired' };
  return { ok: true };
}

/**
 * Who is acting on this event, and may they do `cap`? Fails closed.
 * Organizer → every event capability. Platform admin → read-type capabilities only through
 * AdminOS ops (this resolver grants admins ADMIT/VIEW_SALES for support; never SELL).
 */
async function resolveEventActor(req, eventId, cap) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const uid = req.auth.uid;
  const id = String(eventId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail('invalid-argument', 'eventId is invalid.');
  const evSnap = await _db().collection(COL.EVENTS).doc(id).get();
  if (!evSnap.exists) fail('not-found', 'Event not found.');
  const ev = evSnap.data();
  if (ev.organizerUid === uid) return { uid, role: 'organizer', caps: ORGANIZER_CAPS, event: { id, ...ev } };
  if (AC.isAdmin(req) && [CAPS.ADMIT, CAPS.VIEW_SALES].includes(cap)) return { uid, role: 'admin', caps: [CAPS.ADMIT, CAPS.VIEW_SALES], event: { id, ...ev } };
  const sSnap = await _db().collection(COL.STAFF).doc(`${id}_${uid}`).get();
  if (!sSnap.exists) fail('permission-denied', 'You are not staff for this event.');
  const s = sSnap.data();
  const live = staffActive(s, _now());
  if (!live.ok) fail('permission-denied', live.why === 'expired' ? 'Your access to this event has expired.' : live.why === 'not_started' ? 'Your access to this event has not started yet.' : 'Your access to this event was revoked.');
  const caps = STAFF_ROLES[s.role] || [];
  if (!caps.includes(cap)) fail('permission-denied', `The ${s.role} role cannot do this.`);
  return { uid, role: s.role, caps, event: { id, ...ev }, staff: s };
}

async function _audit(action, actor, target, detail) {
  await _db().collection(COL.AUDIT).add({
    action, performedBy: actor.uid, actorRole: actor.role, eventId: target.eventId || null, target,
    detail: detail || null, createdAt: FieldValue.serverTimestamp(),
  }).catch((e) => logger.error('[eventOps] audit failed', { action, err: e.message }));
}

const _emailKey = (email) => crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 40);

/* ── Invite: organizer names an email + role + window. The staff member ACCEPTS while signed in
   with that verified email — access binds to a uid only by the person's own action. ── */
async function staffInvite(req) {
  const actor = await resolveEventActor(req, (req.data || {}).eventId, CAPS.MANAGE_STAFF);
  const d = req.data || {};
  const email = String(d.email || '').trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/.test(email)) fail('invalid-argument', 'A valid email is required.');
  const role = String(d.role || '');
  if (!STAFF_ROLES[role]) fail('invalid-argument', `Role must be one of: ${Object.keys(STAFF_ROLES).join(', ')}.`);
  const endEv = eventEndMs(actor.event);
  if (endEv == null) fail('failed-precondition', 'Set the event date before adding staff.');
  const startAt = _ms(d.startAt) || _now();
  const endAt = _ms(d.endAt) || (endEv + 12 * 3600 * 1000);
  if (!(endAt > startAt)) fail('invalid-argument', 'Access must end after it starts.');
  if (endAt > endEv + MAX_AFTER_EVENT_MS) fail('invalid-argument', 'Event staff access cannot outlive the event by more than 48 hours.');
  const ref = _db().collection(COL.INVITES).doc(`${actor.event.id}_${_emailKey(email)}`);
  await ref.set({
    eventId: actor.event.id, organizerUid: actor.event.organizerUid, email, role,
    startAt: Timestamp.fromMillis(startAt), endAt: Timestamp.fromMillis(endAt),
    status: 'pending', invitedBy: actor.uid, createdAt: FieldValue.serverTimestamp(),
  });
  await _audit('event_staff_invited', actor, { eventId: actor.event.id, email }, { role, startAt, endAt });
  return { ok: true, inviteId: ref.id, role, startAt, endAt };
}

async function staffAccept(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const tok = req.auth.token || {};
  const email = String(tok.email || '').toLowerCase();
  if (!email || tok.email_verified !== true) fail('failed-precondition', 'Verify your email address to accept event staff access.');
  const eventId = String((req.data || {}).eventId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) fail('invalid-argument', 'eventId is invalid.');
  const invRef = _db().collection(COL.INVITES).doc(`${eventId}_${_emailKey(email)}`);
  const staffRef = _db().collection(COL.STAFF).doc(`${eventId}_${req.auth.uid}`);
  let out = null;
  await _db().runTransaction(async (txn) => {
    const inv = await txn.get(invRef);
    if (!inv.exists || inv.data().status !== 'pending') fail('not-found', 'No pending staff invitation for your email on this event.');
    const i = inv.data();
    if (_ms(i.endAt) <= _now()) fail('failed-precondition', 'This invitation has expired.');
    if (i.organizerUid === req.auth.uid) fail('failed-precondition', 'The organizer does not need staff access.');
    txn.set(staffRef, {
      eventId, uid: req.auth.uid, email, role: i.role, organizerUid: i.organizerUid,
      startAt: i.startAt, endAt: i.endAt, active: true, status: 'active',
      invitedBy: i.invitedBy, acceptedAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp(),
    });
    txn.update(invRef, { status: 'accepted', acceptedByUid: req.auth.uid, acceptedAt: FieldValue.serverTimestamp() });
    out = { role: i.role, endAt: _ms(i.endAt) };
  });
  await _audit('event_staff_accepted', { uid: req.auth.uid, role: out.role }, { eventId }, null);
  return { ok: true, eventId, ...out };
}

async function staffRevoke(req) {
  const actor = await resolveEventActor(req, (req.data || {}).eventId, CAPS.MANAGE_STAFF);
  const d = req.data || {};
  const reason = String(d.reason || '').trim().slice(0, 300);
  if (d.uid) {
    const staffUid = String(d.uid);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(staffUid)) fail('invalid-argument', 'uid is invalid.');
    const ref = _db().collection(COL.STAFF).doc(`${actor.event.id}_${staffUid}`);
    const s = await ref.get();
    if (!s.exists) fail('not-found', 'No such staff member on this event.');
    await ref.update({ active: false, status: 'revoked', revokedAt: FieldValue.serverTimestamp(), revokedBy: actor.uid, revokeReason: reason || null });
    await _audit('event_staff_revoked', actor, { eventId: actor.event.id, uid: staffUid }, { before: s.data().status, after: 'revoked', reason });
    return { ok: true };
  }
  const email = String(d.email || '').trim().toLowerCase();
  if (!email) fail('invalid-argument', 'uid or email is required.');
  const ref = _db().collection(COL.INVITES).doc(`${actor.event.id}_${_emailKey(email)}`);
  const s = await ref.get();
  if (!s.exists) fail('not-found', 'No such invitation.');
  await ref.update({ status: 'revoked', revokedAt: FieldValue.serverTimestamp(), revokedBy: actor.uid });
  await _audit('event_staff_invite_revoked', actor, { eventId: actor.event.id, email }, { reason });
  return { ok: true };
}

async function staffList(req) {
  const actor = await resolveEventActor(req, (req.data || {}).eventId, CAPS.MANAGE_STAFF);
  const [st, inv] = await Promise.all([
    _db().collection(COL.STAFF).where('eventId', '==', actor.event.id).limit(200).get(),
    _db().collection(COL.INVITES).where('eventId', '==', actor.event.id).limit(200).get(),
  ]);
  const nowMs = _now();
  return {
    staff: st.docs.map((d) => { const s = d.data(); return { uid: s.uid, email: s.email, role: s.role, status: s.status, live: staffActive(s, nowMs).ok, startAt: _ms(s.startAt), endAt: _ms(s.endAt) }; }),
    invites: inv.docs.map((d) => { const i = d.data(); return { email: i.email, role: i.role, status: i.status, startAt: _ms(i.startAt), endAt: _ms(i.endAt) }; }),
    roles: STAFF_ROLES,
  };
}

/** The signed-in user's live staff assignments (drives staff mode in Event Manager). */
async function myAssignments(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const snap = await _db().collection(COL.STAFF).where('uid', '==', req.auth.uid).limit(50).get();
  const nowMs = _now();
  const rows = [];
  for (const d of snap.docs) {
    const s = d.data();
    const live = staffActive(s, nowMs);
    if (!live.ok) continue;
    const ev = await _db().collection(COL.EVENTS).doc(s.eventId).get(); // eslint-disable-line no-await-in-loop
    rows.push({ eventId: s.eventId, role: s.role, caps: STAFF_ROLES[s.role] || [], endAt: _ms(s.endAt),
      event: ev.exists ? { title: ev.data().title, startDate: ev.data().startDate, venue: ev.data().venue || null } : null });
  }
  return { assignments: rows };
}

/* ═══ PIN VERIFICATION + ADMISSION ═══════════════════════════════════════════════════════ */
const ATTEMPTS = Object.freeze({ WINDOW_MS: 10 * 60 * 1000, PER_STAFF_FAILS: 10, PER_EVENT_FAILS: 200 });

/** Charge one attempt against the per-staff and per-event windows; refuses when either is exhausted. */
async function _chargeAttempt(eventId, uid, failed) {
  const db = _db();
  const refs = [db.collection(COL.ATTEMPTS).doc(`${eventId}_${uid}`), db.collection(COL.ATTEMPTS).doc(`${eventId}__event`)];
  const limits = [ATTEMPTS.PER_STAFF_FAILS, ATTEMPTS.PER_EVENT_FAILS];
  return db.runTransaction(async (txn) => {
    const snaps = await Promise.all(refs.map((r) => txn.get(r)));
    const nowMs = _now();
    const state = snaps.map((s) => {
      const d = s.exists ? s.data() : {};
      const fresh = !d.windowStart || nowMs - _ms(d.windowStart) >= ATTEMPTS.WINDOW_MS;
      return { fails: fresh ? 0 : Number(d.fails) || 0, windowStart: fresh ? nowMs : _ms(d.windowStart) };
    });
    const locked = state.findIndex((s, i) => s.fails >= limits[i]);
    if (locked >= 0) return { locked: locked === 0 ? 'staff' : 'event', retryAtMs: state[locked].windowStart + ATTEMPTS.WINDOW_MS };
    if (failed) state.forEach((s, i) => txn.set(refs[i], { fails: s.fails + 1, windowStart: Timestamp.fromMillis(s.windowStart), eventId, updatedAt: FieldValue.serverTimestamp() }, { merge: true }));
    return { locked: null };
  });
}

async function _lookupPin(eventId, pin) {
  const hash = pinHash(eventId, pin);
  if (!hash) return null;
  const idx = await _db().collection(COL.PINS).doc(`${eventId}_${hash}`).get();
  if (!idx.exists) return null;
  return { hash, ticketId: idx.data().ticketId };
}

function _summary(t, ev) {
  const name = String(t.attendeeName || '').trim();
  return {
    ticketId: t.ticketId, ticketNumber: t.ticketNumber || null, tierName: t.tierName || null,
    event: ev ? ev.title : null, status: t.status, admissionStatus: t.admissionStatus || 'NOT_ADMITTED',
    refundStatus: t.refundStatus || 'NONE',
    /* minimal attendee information: initials only */
    attendeeInitials: name ? name.split(/\s+/).map((p) => p[0].toUpperCase()).slice(0, 3).join('') : null,
  };
}

function _admissible(t) {
  if (t.status !== 'valid') return `Ticket is ${t.status}.`;
  if ((t.admissionStatus || 'NOT_ADMITTED') === 'ADMITTED') return 'Already admitted.';
  if (['REQUESTED', 'APPROVED', 'REFUNDED'].includes(t.refundStatus)) return 'A refund is in progress for this ticket — contact the organizer.';
  return null;
}

/** Staff enters a PIN for the SELECTED event → ticket summary + whether it can be admitted. */
async function verifyPin(req) {
  const d = req.data || {};
  const actor = await resolveEventActor(req, d.eventId, CAPS.ADMIT);
  const pre = await _chargeAttempt(actor.event.id, actor.uid, false);
  if (pre.locked) fail('resource-exhausted', 'Too many wrong PINs. Wait a few minutes before trying again.');
  const hit = await _lookupPin(actor.event.id, d.pin);
  if (!hit) {
    await _chargeAttempt(actor.event.id, actor.uid, true);
    await _audit('event_pin_failed', actor, { eventId: actor.event.id }, null);   /* no PIN, no hash */
    return { valid: false, reason: 'No ticket for this event matches that PIN.' };
  }
  const t = (await _db().collection(COL.TICKETS).doc(hit.ticketId).get()).data();
  if (!t || t.eventId !== actor.event.id || t.pinHash !== hit.hash) return { valid: false, reason: 'No ticket for this event matches that PIN.' };
  const blocked = _admissible(t);
  return { valid: true, admissible: !blocked, reason: blocked, ticket: _summary(t, actor.event) };
}

/** Admit: re-verifies the PIN and admits in ONE transaction (create-only admission record). */
async function admit(req) {
  const d = req.data || {};
  const actor = await resolveEventActor(req, d.eventId, CAPS.ADMIT);
  const pre = await _chargeAttempt(actor.event.id, actor.uid, false);
  if (pre.locked) fail('resource-exhausted', 'Too many wrong PINs. Wait a few minutes before trying again.');
  const hit = await _lookupPin(actor.event.id, d.pin);
  if (!hit) {
    await _chargeAttempt(actor.event.id, actor.uid, true);
    await _audit('event_pin_failed', actor, { eventId: actor.event.id }, null);
    fail('not-found', 'No ticket for this event matches that PIN.');
  }
  const db = _db();
  const tRef = db.collection(COL.TICKETS).doc(hit.ticketId);
  const aRef = db.collection(COL.ADMISSIONS).doc(hit.ticketId);
  const deviceSession = String(d.deviceSession || '').slice(0, 80) || null;
  const res = await db.runTransaction(async (txn) => {
    const [ts, as] = await Promise.all([txn.get(tRef), txn.get(aRef)]);
    if (!ts.exists) fail('not-found', 'Ticket not found.');
    const t = ts.data();
    if (t.eventId !== actor.event.id || t.pinHash !== hit.hash) fail('not-found', 'No ticket for this event matches that PIN.');
    if (as.exists) return { already: true, t };
    const blocked = _admissible(t);
    if (blocked) return { blocked, t };
    txn.create(aRef, {
      ticketId: hit.ticketId, eventId: actor.event.id, admittedBy: actor.uid, admittedRole: actor.role,
      method: 'pin', deviceSession, admittedAt: FieldValue.serverTimestamp(),
    });
    txn.update(tRef, { admissionStatus: 'ADMITTED', admittedAt: FieldValue.serverTimestamp(), admittedBy: actor.uid,
      checkedIn: true, checkedInAt: FieldValue.serverTimestamp(), checkedInBy: actor.uid });
    txn.update(db.collection(COL.EVENTS).doc(actor.event.id), { checkinsCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
    return { admitted: true, t };
  });
  if (res.admitted) await _audit('event_ticket_admitted', actor, { eventId: actor.event.id, ticketId: hit.ticketId }, { method: 'pin', deviceSession });
  if (res.already) return { result: 'already_admitted', ticket: _summary(res.t, actor.event) };
  if (res.blocked) return { result: 'refused', reason: res.blocked, ticket: _summary(res.t, actor.event) };
  return { result: 'admitted', ticket: _summary({ ...res.t, admissionStatus: 'ADMITTED' }, actor.event) };
}

/* ═══ callables ══════════════════════════════════════════════════════════════════════════ */
const _h = {
  eventStaffInvite: staffInvite, eventStaffAccept: staffAccept, eventStaffRevoke: staffRevoke,
  eventStaffList: staffList, eventMyAssignments: myAssignments, eventVerifyPin: verifyPin, eventAdmitTicket: admit,
};
/* One Cloud Run service for all event-day operations (ops routed by name), like the other dispatchers. */
const eventOpsDispatch = onCall(OPS_OPTS(), async (req) => {
  const op = String((req.data || {}).op || '');
  const h = _h[op] || require('./event-sales')._h[op];
  if (!h) fail('not-found', `Unknown event operation "${op}".`);
  return h(req);
});
function OPS_OPTS() { return { ...OPTS, timeoutSeconds: 30, memory: '256MiB' }; }

module.exports = {
  COL, CAPS, STAFF_ROLES, ORGANIZER_CAPS, ATTEMPTS, PIN_ALPHABET, PIN_LEN, SOKONI_HMAC_KEY,
  generatePin, generateTicketNumber, normalizePin, pinHash, issueCredentials,
  resolveEventActor, staffActive, eventEndMs, _h, eventOpsDispatch,
  _setClock: (fn) => { _now = fn || (() => Date.now()); },
};
