'use strict';
/**
 * SOKONI — Event operations: ticket PINs, event-scoped temporary staff, PIN admission.
 * ============================================================================================
 * TICKET IDENTITY — PIN FIRST, QR OPTIONAL. Every ISSUED ticket gets:
 *   ticketNumber  SK-EVT-YYYY-NNNNNN  the PERMANENT identity (random within the year, never
 *                                     sequential; unique via eventTicketNumbers; not a credential)
 *   PIN           NNNN                the EVENT-DAY admission credential: exactly 4 digits,
 *                                     crypto.randomInt, drawn independently of the ticket number,
 *                                     unique within the event for its whole life (never recycled)
 * The PIN is a BEARER CREDENTIAL, so:
 *   · it is stored as HMAC-SHA256(SOKONI_HMAC_KEY, "evtpin|eventId|PIN") — the hash on the ticket
 *     is useless without the server key, and binds the PIN to ONE event (a PIN from event A can
 *     never match a ticket of event B, and event B is its own namespace);
 *   · the raw PIN lives only in eventTicketSecrets/{ticketId} (no client rule — deny by default)
 *     and is returned only to the ticket's buyer, or to the staff who sold a walk-in ticket;
 *   · it is never logged, never put in a notification, never stored in an audit row;
 *   · free PINs are CHOSEN by reading the index inside the issuing transaction (see
 *     allocateIdentities) and confirmed by create() on eventTicketPins/{eventId}_{hash};
 *   · lifetime: ISSUED → ACTIVE in the admission window → CONSUMED once admitted, EXPIRED after
 *     the window; refunded / void / cancelled are INVALID (pinState);
 *   · a 4-digit space is small: guessing is throttled per staff member AND per event, and a
 *     crossed limit is recorded as a security event; admission is a transaction with a
 *     create()-only admission record, so two gates admitting one PIN cannot both succeed.
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
  NUMBERS: 'eventTicketNumbers', STAFF: 'eventStaff', INVITES: 'eventStaffInvites', ADMISSIONS: 'eventAdmissions', ATTEMPTS: 'eventPinAttempts',
  AUDIT: 'eventOpsAudit',
});

/* ═══ TICKET IDENTITY ═══════════════════════════════════════════════════════════════════
   ticketNumber  SK-EVT-YYYY-NNNNNN  the PERMANENT identity (receipts, support, AdminOS). Six random
                 digits within the year, unique via eventTicketNumbers/{number}. Never sequential:
                 a sequence would publish sales volume.
   PIN           NNNN                the EVENT-DAY admission credential: exactly 4 digits from
                 crypto.randomInt, drawn INDEPENDENTLY of the ticket number (never its last digits,
                 never a truncated hash). Unique within the EVENT for the event's whole life — never
                 recycled while that event's tickets remain auditable. Another event is another
                 namespace: the index key is HMAC(event, PIN).
   Only 10,000 PINs exist per event, so collisions are routine. Free values are CHOSEN by reading
   candidate index docs inside the issuing transaction (reads before writes); create() then only
   confirms them. Never create()-and-hope: a create() conflict is ALREADY_EXISTS, which Firestore
   does not retry, so it would fail a paid sale. A concurrent issuer that takes the same value
   changes a doc this transaction read, and the transaction retries and re-probes. */
const PIN_DIGITS = 4;
const PIN_SPACE = 10000;
/* The most tickets one event may issue with 4-digit PINs. Enforced when ticket types are
   configured (event-hub createTicketTier), so a paid order can never meet an exhausted PIN space;
   at 80 % fill a free PIN still takes ~5 reads to find. */
const EVENT_PIN_CEILING = 8000;
const TICKET_NUMBER_RE = /^SK-EVT-\d{4}-\d{6}$/;
let _randInt = (n) => crypto.randomInt(0, n);

function generatePin() { return String(_randInt(PIN_SPACE)).padStart(PIN_DIGITS, '0'); }
function generateTicketNumber(year) { return `SK-EVT-${year}-${String(_randInt(1000000)).padStart(6, '0')}`; }

/** Canonical form: spaces/dashes removed; exactly four digits, else null. */
function normalizePin(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\s-]/g, '');
  return /^\d{4}$/.test(s) ? s : null;
}

function _pinKey() {
  let k = null;
  try { k = SOKONI_HMAC_KEY.value(); } catch (_) { k = null; }
  if (k) return k;
  if (process.env.K_SERVICE || process.env.FUNCTION_TARGET) fail('failed-precondition', 'Ticket credential key unavailable.');
  return 'sokoni-event-pin-TEST-ONLY';            /* local test process only — never in Cloud Functions */
}

/** The SAME secret, for another credential DOMAIN (entertainment-bookings: `entbk|<envId>|<pin>`). The
    domain prefix keeps a booking PIN and a ticket PIN from ever hashing to one another. */
function credentialHash(message) {
  return crypto.createHmac('sha256', _pinKey()).update(String(message)).digest('hex');
}

function pinHash(eventId, rawPin) {
  const p = normalizePin(rawPin);
  if (!p) return null;
  return crypto.createHmac('sha256', _pinKey()).update(`evtpin|${String(eventId)}|${p}`).digest('hex');
}

/* Draw `need` values whose index docs do not exist, reading candidates in widening rounds. */
async function _probeFree(txn, need, draw, refOf, space) {
  const out = []; const seen = new Set();
  let size = need + 2;
  for (let round = 0; round < 6 && out.length < need && seen.size < space; round++) {
    const cands = [];
    for (let guard = 0; cands.length < size && guard < size * 50 && seen.size + cands.length < space; guard++) {
      const v = draw();
      if (!seen.has(v) && !cands.includes(v)) cands.push(v);
    }
    const snaps = await Promise.all(cands.map((v) => txn.get(refOf(v))));
    cands.forEach((v, i) => { seen.add(v); if (!snaps[i].exists && out.length < need) out.push(v); });
    size = Math.min(400, size * 4);
  }
  return out;
}

/**
 * Allocate `n` ticket identities for one event — call in the transaction's READ phase.
 * @returns {Promise<Array<{pin:string, hash:string, ticketNumber:string}>>}
 */
async function allocateIdentities(txn, eventId, n, opts = {}) {
  const need = Math.max(0, Math.floor(Number(n) || 0));
  if (!need) return [];
  if (need > 100) fail('invalid-argument', 'At most 100 tickets can be issued at once.');
  const db = _db();
  const year = new Date(Number.isFinite(opts.nowMs) ? opts.nowMs : _now()).getUTCFullYear();
  const pins = await _probeFree(txn, need, generatePin,
    (p) => db.collection(COL.PINS).doc(`${eventId}_${pinHash(eventId, p)}`), PIN_SPACE);
  if (pins.length < need) fail('resource-exhausted', 'This event has no free admission PINs left — contact SOKONI support.');
  const numbers = await _probeFree(txn, need, () => generateTicketNumber(year),
    (x) => db.collection(COL.NUMBERS).doc(x), 1000000);
  if (numbers.length < need) fail('resource-exhausted', 'Could not allocate a ticket number — please try again.');
  return pins.map((pin, i) => ({ pin, hash: pinHash(eventId, pin), ticketNumber: numbers[i] }));
}

/**
 * Issue credentials for ONE ticket inside the caller's transaction, with an identity from
 * allocateIdentities (read phase). Writes the PIN index + ticket-number index (create — the
 * uniqueness confirmation) and the raw-PIN secret; returns the fields to put on the ticket.
 */
function issueCredentials(writer, { eventId, ticketId, buyerUid = null, soldBy = null, identity }) {
  if (!identity || !normalizePin(identity.pin) || !TICKET_NUMBER_RE.test(String(identity.ticketNumber || ''))) {
    throw new Error('issueCredentials: allocate the identity in the transaction read phase (allocateIdentities)');
  }
  const db = _db();
  writer.create(db.collection(COL.PINS).doc(`${eventId}_${identity.hash}`), { eventId, ticketId, createdAt: FieldValue.serverTimestamp() });
  writer.create(db.collection(COL.NUMBERS).doc(identity.ticketNumber), { eventId, ticketId, createdAt: FieldValue.serverTimestamp() });
  writer.set(db.collection(COL.SECRETS).doc(ticketId), {
    ticketId, eventId, pin: identity.pin, buyerUid: buyerUid || null, soldBy: soldBy || null, createdAt: FieldValue.serverTimestamp(),
  });
  return { ticketNumber: identity.ticketNumber, pinHash: identity.hash, admissionStatus: 'NOT_ADMITTED', refundStatus: 'NONE',
    credentialIssuedAt: FieldValue.serverTimestamp() };
}

/* ═══ PIN LIFETIME ═══════════════════════════════════════════════════════════════════════
   ISSUED (before the admission window) → ACTIVE (window open) → CONSUMED (admitted, once)
                                                             ↘ EXPIRED (window closed)
   A refund in flight SUSPENDS it; refunded / void / cancelled-event tickets are INVALID. The
   window defaults to 12 h before the start until 12 h after the end; an organizer may set
   admissionOpensAt / admissionClosesAt on the event. */
const ADMISSION_OPEN_BEFORE_MS = 12 * 3600 * 1000;
const ADMISSION_CLOSE_AFTER_MS = 12 * 3600 * 1000;
function admissionWindow(ev) {
  const start = _ms(ev && ev.startDate), end = eventEndMs(ev);
  return {
    opensAt: _ms(ev && ev.admissionOpensAt) != null ? _ms(ev.admissionOpensAt) : (start != null ? start - ADMISSION_OPEN_BEFORE_MS : null),
    closesAt: _ms(ev && ev.admissionClosesAt) != null ? _ms(ev.admissionClosesAt) : (end != null ? end + ADMISSION_CLOSE_AFTER_MS : null),
  };
}
function pinState(t, ev, nowMs) {
  if (ev && ev.status === 'cancelled') return 'INVALID_CANCELLED';
  if (t.status === 'refunded' || t.refundStatus === 'REFUNDED') return 'INVALID_REFUNDED';
  if (t.status !== 'valid') return 'INVALID';
  if ((t.admissionStatus || 'NOT_ADMITTED') === 'ADMITTED') return 'CONSUMED';
  if (['REQUESTED', 'APPROVED'].includes(t.refundStatus)) return 'SUSPENDED_REFUND';
  const w = admissionWindow(ev || {});
  if (w.opensAt != null && nowMs < w.opensAt) return 'ISSUED';
  if (w.closesAt != null && nowMs > w.closesAt) return 'EXPIRED';
  return 'ACTIVE';
}

/* ═══ STAFF / ACTOR AUTHORITY ════════════════════════════════════════════════════════════ */
/* The ONLY capabilities an event operation checks. None concerns money movement: withdrawals,
   payout destinations, refund APPROVAL, commission, ownership and AdminOS are simply absent. */
const CAPS = Object.freeze({
  SELL: 'sell', VIEW_OWN_SALES: 'view_own_sales', VIEW_SALES: 'view_sales', ADMIT: 'admit',
  MARKETING: 'marketing', MANAGE_STAFF: 'manage_staff', FINANCE: 'finance', MANAGE_EVENT: 'manage_event',
});
const STAFF_ROLES = Object.freeze({
  /* A gate cashier also checks online tickets by PIN (owner brief, 2026-09-27: Quick Sale handles a new
     sale AND an existing ticket) — through the SAME admission authority, never a second one. */
  cashier:   [CAPS.SELL, CAPS.VIEW_OWN_SALES, CAPS.ADMIT],
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
  /* If the invited email already has a SOKONI account, tell them in-app. Best effort; the response
     is identical either way, so an organizer cannot use invitations to probe which emails exist. */
  try {
    const u = await require('firebase-admin/auth').getAuth().getUserByEmail(email);
    if (u && u.uid && u.uid !== actor.uid) {
      await require('./notify').notify({ uid: u.uid, type: 'event_staff_invite', title: 'Event staff invitation',
        body: `You have been invited to work ${actor.event.title || 'an event'} as ${role}. Open the link from the organizer to accept.`,
        dedupeKey: `evt_staff_inv:${ref.id}:${role}`, data: { eventId: actor.event.id, role } });
    }
  } catch (_) { /* no account / notice failure — the organizer's link still works */ }
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
/* A 4-digit space is small, so guessing is throttled hard: 5 wrong PINs per staff member and 100 per
   event in any 10 minutes. Crossing a limit records a security event (event_pin_lockout). */
const ATTEMPTS = Object.freeze({ WINDOW_MS: 10 * 60 * 1000, PER_STAFF_FAILS: 5, PER_EVENT_FAILS: 100 });

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
    const crossed = failed ? state.findIndex((s, i) => s.fails + 1 === limits[i]) : -1;
    return { locked: null, crossed: crossed < 0 ? null : (crossed === 0 ? 'staff' : 'event') };
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
    refundStatus: t.refundStatus || 'NONE', pinState: pinState(t, ev, _now()),
    /* minimal attendee information: initials only */
    attendeeInitials: name ? name.split(/\s+/).map((p) => p[0].toUpperCase()).slice(0, 3).join('') : null,
  };
}

const _when = (ms) => new Date(ms).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' });
/** Why this ticket cannot be admitted now — null when it can. Driven by pinState, so every surface agrees. */
function _admissible(t, ev, nowMs) {
  const st = pinState(t, ev, nowMs);
  switch (st) {
    case 'ACTIVE': return null;
    case 'CONSUMED': return 'Already admitted.';
    case 'SUSPENDED_REFUND': return 'A refund is in progress for this ticket — contact the organizer.';
    case 'INVALID_REFUNDED': return 'Ticket is refunded.';
    case 'INVALID_CANCELLED': return 'This event was cancelled.';
    case 'ISSUED': return `Admission has not opened yet — it opens ${_when(admissionWindow(ev).opensAt)}.`;
    case 'EXPIRED': return 'The admission window for this ticket has closed.';
    default: return `Ticket is ${t.status}.`;
  }
}

/* A wrong PIN: counted, audited without the PIN, and a crossed limit is a security event. */
async function _wrongPin(actor) {
  const r = await _chargeAttempt(actor.event.id, actor.uid, true);
  await _audit('event_pin_failed', actor, { eventId: actor.event.id }, null);   /* no PIN, no hash */
  if (r.crossed) await _audit('event_pin_lockout', actor, { eventId: actor.event.id }, { scope: r.crossed, windowMs: ATTEMPTS.WINDOW_MS });
}

/** Staff enters a PIN for the SELECTED event → ticket summary + whether it can be admitted. */
async function verifyPin(req) {
  const d = req.data || {};
  const actor = await resolveEventActor(req, d.eventId, CAPS.ADMIT);
  const pre = await _chargeAttempt(actor.event.id, actor.uid, false);
  if (pre.locked) fail('resource-exhausted', 'Too many wrong PINs. Wait a few minutes before trying again.');
  const hit = await _lookupPin(actor.event.id, d.pin);
  if (!hit) {
    await _wrongPin(actor);
    return { valid: false, reason: 'No ticket for this event matches that PIN.' };
  }
  const t = (await _db().collection(COL.TICKETS).doc(hit.ticketId).get()).data();
  if (!t || t.eventId !== actor.event.id || t.pinHash !== hit.hash) return { valid: false, reason: 'No ticket for this event matches that PIN.' };
  const blocked = _admissible(t, actor.event, _now());
  return { valid: true, admissible: !blocked, reason: blocked, ticket: _summary(t, actor.event) };
}

/* ── TICKET-NUMBER CONFIRMATION (owner decision 2026-09-27) ───────────────────────────────
   A 4-digit PIN alone is NOT sufficient evidence to admit: at 2,000 tickets a random guess matches
   SOME ticket one time in five. So admission is two facts, not one:
     PIN → the server finds the ticket → staff are shown its ticket NUMBER → staff confirm that the
     ticket the attendee presents carries that number → the server admits ONLY if the confirmed
     number equals the PIN's ticket.
   Enforced HERE, not in the page: an admit call without the confirmed number is refused, and a
   confirmed number that does not match is refused, counted as a wrong attempt (it is what a guessed
   or borrowed PIN looks like) and audited. Staff who see a mismatch report it (eventAdmissionMismatch)
   with the same effect. The QR path needs no confirmation: its 128-bit token already names ONE ticket. */
const _normNumber = (v) => String(v == null ? '' : v).trim().toUpperCase();

/** Admit: re-verifies the PIN AND the confirmed ticket number, admits in ONE transaction. */
async function admit(req) {
  const d = req.data || {};
  const actor = await resolveEventActor(req, d.eventId, CAPS.ADMIT);
  const confirmed = _normNumber(d.confirmTicketNumber);
  if (!TICKET_NUMBER_RE.test(confirmed)) fail('invalid-argument', 'Check the ticket number on the attendee\'s ticket, then confirm admission.');
  const pre = await _chargeAttempt(actor.event.id, actor.uid, false);
  if (pre.locked) fail('resource-exhausted', 'Too many wrong PINs. Wait a few minutes before trying again.');
  const hit = await _lookupPin(actor.event.id, d.pin);
  if (!hit) {
    await _wrongPin(actor);
    fail('not-found', 'No ticket for this event matches that PIN.');
  }
  const db = _db();
  const tRef = db.collection(COL.TICKETS).doc(hit.ticketId);
  const aRef = db.collection(COL.ADMISSIONS).doc(hit.ticketId);
  const deviceSession = String(d.deviceSession || '').slice(0, 80) || null;
  const res = await db.runTransaction(async (txn) => {
    const evRef = db.collection(COL.EVENTS).doc(actor.event.id);
    const [ts, as, evs] = await Promise.all([txn.get(tRef), txn.get(aRef), txn.get(evRef)]);
    if (!ts.exists) fail('not-found', 'Ticket not found.');
    const t = ts.data();
    if (t.eventId !== actor.event.id || t.pinHash !== hit.hash) fail('not-found', 'No ticket for this event matches that PIN.');
    if (_normNumber(t.ticketNumber) !== confirmed) return { mismatch: true, t };
    if (as.exists) return { already: true, t };
    const blocked = _admissible(t, evs.exists ? { id: evs.id, ...evs.data() } : actor.event, _now());
    if (blocked) return { blocked, t };
    txn.create(aRef, {
      ticketId: hit.ticketId, eventId: actor.event.id, admittedBy: actor.uid, admittedRole: actor.role,
      method: 'pin', confirmation: 'ticket_number', deviceSession, admittedAt: FieldValue.serverTimestamp(),
    });
    txn.update(tRef, { admissionStatus: 'ADMITTED', admittedAt: FieldValue.serverTimestamp(), admittedBy: actor.uid,
      checkedIn: true, checkedInAt: FieldValue.serverTimestamp(), checkedInBy: actor.uid });
    txn.update(evRef, { checkinsCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
    return { admitted: true, t };
  });
  if (res.mismatch) {
    /* the PIN is real but the attendee's ticket is not that ticket: a guessed / borrowed PIN */
    await _mismatch(actor, hit.ticketId, 'server_number_mismatch');
    return { result: 'refused', reason: 'The ticket number does not match this PIN — do not admit.', mismatch: true };
  }
  if (res.admitted) await _audit('event_ticket_admitted', actor, { eventId: actor.event.id, ticketId: hit.ticketId }, { method: 'pin', confirmation: 'ticket_number', deviceSession });
  /* Admission settles the ticket (owner decision 2026-09-27): its share of the online order is credited to
     the ORGANIZER's business wallet now, SOKONI's 3 % already deducted. Never throws. */
  if (res.admitted) await require('./event-settlement').releaseTicketShare(hit.ticketId, { actorUid: actor.uid });
  if (res.already) return { result: 'already_admitted', ticket: _summary(res.t, actor.event) };
  if (res.blocked) return { result: 'refused', reason: res.blocked, ticket: _summary(res.t, actor.event) };
  return { result: 'admitted', ticket: _summary({ ...res.t, admissionStatus: 'ADMITTED' }, actor.event) };
}

/* A PIN whose ticket number did not match what the attendee showed: counted against the same guessing
   limits (per staff + per event) and audited as a security event — never an admission. */
async function _mismatch(actor, ticketId, source) {
  await _wrongPin(actor);
  await _audit('event_admission_mismatch', actor, { eventId: actor.event.id, ticketId }, { source });
}

/** Staff report: "the attendee's ticket does not carry the number shown for this PIN". */
async function admissionMismatch(req) {
  const d = req.data || {};
  const actor = await resolveEventActor(req, d.eventId, CAPS.ADMIT);
  const hit = await _lookupPin(actor.event.id, d.pin);
  await _mismatch(actor, hit ? hit.ticketId : null, 'staff_reported');
  return { recorded: true };
}

/* ═══ callables ══════════════════════════════════════════════════════════════════════════ */
const _h = {
  eventStaffInvite: staffInvite, eventStaffAccept: staffAccept, eventStaffRevoke: staffRevoke,
  eventStaffList: staffList, eventMyAssignments: myAssignments, eventVerifyPin: verifyPin, eventAdmitTicket: admit,
  eventAdmissionMismatch: admissionMismatch,
};
/* One Cloud Run service for all event-day operations (ops routed by name), like the other dispatchers. */
const eventOpsDispatch = onCall(OPS_OPTS(), async (req) => {
  const op = String((req.data || {}).op || '');
  const h = _h[op] || require('./event-sales')._h[op] || require('./event-refunds')._h[op] || require('./entertainment-integrations')._h[op] || require('./entertainment-bookings')._h[op] || require('./venue-payments')._h[op];
  if (!h) fail('not-found', `Unknown event operation "${op}".`);
  return h(req);
});
function OPS_OPTS() { return { ...OPTS, timeoutSeconds: 30, memory: '256MiB' }; }

module.exports = {
  COL, CAPS, STAFF_ROLES, ORGANIZER_CAPS, ATTEMPTS, PIN_DIGITS, PIN_SPACE, EVENT_PIN_CEILING, TICKET_NUMBER_RE, SOKONI_HMAC_KEY,
  generatePin, generateTicketNumber, normalizePin, pinHash, credentialHash, allocateIdentities, issueCredentials, admissionWindow, pinState, admissibleReason: _admissible,
  resolveEventActor, staffActive, eventEndMs, lookupPin: _lookupPin, _h, eventOpsDispatch,
  _setClock: (fn) => { _now = fn || (() => Date.now()); },
  /* tests only: force the random draws (collision / exhaustion proofs) */
  _setRandom: (fn) => { _randInt = fn || ((n) => crypto.randomInt(0, n)); },
};
