/* ================================================================
   SOKONI — Service booking PIN core (PIN YAKO NI BOOKING YAKO) — live providerDispatch lineage
   ----------------------------------------------------------------
   Owner 2026-09-30: a paid service booking's money is HELD by SOKONI and released to the
   provider's BUSINESS wallet only when the provider enters the buyer's PIN — which the buyer gives
   only after the service is done. Until then the money is refundable.

   This is the THIN core of the entertainment booking envelope (convergence branch,
   entertainment-bookings.js), ported onto the live line without the events stack it depends on.
   It is deliberately COMPATIBLE with the full module so the full module supersedes it without a
   migration:
     · same collections   entBookings / entBookingSecrets / entBookingRefs / entBookingPinAttempts
     · same envelope id   ID.envIdFor('providerBookings', id)  →  svc_<bookingId>
     · same PIN hash      HMAC-SHA256(SOKONI_HMAC_KEY, `entbk|<envId>|<pin>`)
     · same identity rules shared/ent-booking-identity.js (ported verbatim)
     · same function names entBookingOnProviderBooking (trigger), serviceBookingPin (callable)

   Money never moves here. The release is provider-ops.providerCompleteBooking — the existing single
   provider credit point (commission via finos-utils, business wallet wallets/{providerId},
   providerPayouts) — which now requires verifyForCompletion() first for a held booking.
   ================================================================ */
'use strict';

const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const ID = require('./shared/ent-booking-identity');

const SOKONI_HMAC_KEY = defineSecret('SOKONI_HMAC_KEY');
const REGION = 'us-central1';
const COL = Object.freeze({ ENV: 'entBookings', SECRETS: 'entBookingSecrets', REFS: 'entBookingRefs', ATTEMPTS: 'entBookingPinAttempts', AUDIT: 'entBookingAudit' });
const ATTEMPTS = Object.freeze({ WINDOW_MS: 10 * 60 * 1000, PER_BOOKING_FAILS: 5, PER_ACTOR_FAILS: 20 });
const HELD_OR_SETTLED = ['paid_held', 'settled'];
/* PIN validity follows the BOOKING (owner 2026-09-30): usable from OPENS before the start until TTL after
   the end — and at least TTL from the moment it was issued, so a renewed PIN always has a usable life.
   The buyer may renew once the booking time has arrived (or the PIN expired) while the money is still
   held and unreleased; the old PIN dies with the renewal. Capped so a PIN cannot be farmed. */
const PIN_OPENS_BEFORE_MS = ID.SHOW_UP_OPENS_MS || 2 * 3600e3;
const PIN_TTL_MS = 12 * 3600e3;
const MAX_RENEWALS = 5;
function _window(env) {
  const w = env.when || {};
  const startMs = Number(w.startMs) || null;
  const endMs = Number(w.endMs) || startMs;
  const issuedAtMs = Number(env.pin && env.pin.issuedAtMs) || 0;
  const opensAtMs = startMs ? startMs - PIN_OPENS_BEFORE_MS : 0;
  const expiresAtMs = Math.max(endMs ? endMs + PIN_TTL_MS : 0, issuedAtMs ? issuedAtMs + PIN_TTL_MS : 0) || null;
  return { opensAtMs, expiresAtMs };
}

const _db = () => getFirestore();
let _now = () => Date.now();
let _randInt = (n) => crypto.randomInt(0, n);
const fail = (code, msg) => { throw new HttpsError(code, msg); };
const _ms = (v) => { if (v == null) return null; if (typeof v === 'number') return v; if (typeof v.toMillis === 'function') return v.toMillis(); const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

function _key() {
  let k = null;
  try { k = SOKONI_HMAC_KEY.value(); } catch (_) { k = null; }
  if (k) return k;
  if (process.env.K_SERVICE || process.env.FUNCTION_TARGET) fail('failed-precondition', 'Booking PIN key unavailable.');
  return 'sokoni-event-pin-TEST-ONLY';             /* local test process only — never in Cloud Functions */
}
/* PIN AT REST IS ENCRYPTED (2026-10-01, sokoni-70 review). The buyer must be able to view their PIN
   again (getMyBookingPin), so a one-way hash alone cannot serve that; but a readable PIN must not sit
   in Firestore. AES-256-GCM, key derived from SOKONI_HMAC_KEY with its own label (never the hash
   key itself), the envelope id as associated data (a ciphertext cannot be moved to another booking).
   Verification still uses only the HMAC hash on the envelope. Whether a buyer should be able to
   re-view the PIN at all (vs. show-once + renew) is an OWNER decision, recorded in the docs. */
function _encKey() { return crypto.createHmac('sha256', _key()).update('entbk-pin-enc-v1').digest(); }
function _encPin(envId, pin) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', _encKey(), iv);
  c.setAAD(Buffer.from(String(envId)));
  const ct = Buffer.concat([c.update(String(pin), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
function _decPin(envId, enc) {
  if (!enc || enc.v !== 1) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', _encKey(), Buffer.from(enc.iv, 'base64'));
    d.setAAD(Buffer.from(String(envId)));
    d.setAuthTag(Buffer.from(enc.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(enc.ct, 'base64')), d.final()]).toString('utf8');
  } catch (_) { return null; }
}
function _pinHash(envId, pin) {
  const p = ID.normalizePin(pin);
  return p ? crypto.createHmac('sha256', _key()).update(`entbk|${envId}|${p}`).digest('hex') : null;
}
async function _audit(action, uid, envId, detail) {
  await _db().collection(COL.AUDIT).add({ action, performedBy: uid || 'system', envId: envId || null, detail: detail || null, createdAt: FieldValue.serverTimestamp() }).catch(() => {});
}

/* ── 1. issue the PIN once the payment is HELD (trigger) ───────────────────────────────── */
async function issueForBooking(bookingId, b) {
  if (!b || !HELD_OR_SETTLED.includes(String(b.paymentStatus || ''))) return { skipped: 'not_paid' };
  const db = _db();
  const envId = ID.envIdFor('providerBookings', bookingId);
  const envRef = db.collection(COL.ENV).doc(envId);
  let created = false;
  await db.runTransaction(async (txn) => {
    const cur = await txn.get(envRef);
    if (cur.exists) { txn.update(envRef, { when: { startMs: _ms(b.startTs) || _ms(b.scheduledAt), endMs: _ms(b.endTs) }, status: ID.statusOf('providerBookings', b), payment: { state: ID.paymentOf('providerBookings', b), paymentRef: b.paymentRef || null, amountCents: (Number(b.price) || 0) + (Number(b.fee) || 0) }, updatedAt: FieldValue.serverTimestamp() }); return; }
    const category = b.entClass === ID.CATEGORY.ARTIST ? ID.CATEGORY.ARTIST : ID.CATEGORY.SERVICE;
    const year = new Date(_now()).getUTCFullYear();
    let bookingRef = null;
    for (let i = 0; i < 8 && !bookingRef; i++) {
      const cand = `${ID.REF_PREFIX[category]}-${year}-${String(_randInt(1000000)).padStart(6, '0')}`;
      if (!(await txn.get(db.collection(COL.REFS).doc(cand))).exists) bookingRef = cand;
    }
    if (!bookingRef) fail('resource-exhausted', 'Could not allocate a booking reference — try again.');
    const pin = String(_randInt(10000)).padStart(4, '0');
    txn.create(envRef, {
      envId, bookingRef, category, source: { collection: 'providerBookings', id: bookingId },
      buyerUid: b.customerUid || null, providerUid: b.providerId || null, providerKind: category === ID.CATEGORY.ARTIST ? 'artist' : 'service_provider',
      title: b.service || 'Service', providerName: null, location: b.address || b.location || null, detail: b.durationMins ? `${b.durationMins} min` : null,
      when: { startMs: _ms(b.startTs) || _ms(b.scheduledAt), endMs: _ms(b.endTs) }, status: ID.statusOf('providerBookings', b),
      payment: { state: ID.paymentOf('providerBookings', b), paymentRef: b.paymentRef || null, amountCents: (Number(b.price) || 0) + (Number(b.fee) || 0) },
      refund: { state: 'NONE' }, ticketNumbers: null, quantity: null,
      pin: { hash: _pinHash(envId, pin), issuedAt: FieldValue.serverTimestamp(), issuedAtMs: _now(), renewals: 0 },
      verification: { state: 'NOT_VERIFIED' }, conversationId: null, issuedBy: 'booking-pin-core',
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), version: 1,
    });
    txn.create(db.collection(COL.REFS).doc(bookingRef), { envId, createdAt: FieldValue.serverTimestamp() });
    txn.create(db.collection(COL.SECRETS).doc(envId), { envId, bookingRef, pinEnc: _encPin(envId, pin), buyerUid: b.customerUid || null, createdAt: FieldValue.serverTimestamp() });
    created = true;
  });
  if (created) await _audit('booking_pin_issued', 'system', envId, { bookingId });
  return { envId, created };
}

/* ── 2. orders/{bookingId} mirror — a service booking IS an order ──────────────────────── */
async function mirrorServiceOrder(bookingId, b, envId) {
  const db = _db();
  const priceKES = Math.round((Number(b.price) || 0) / 100);
  const feeKES = Math.round((Number(b.fee) || 0) / 100);
  const totalKES = priceKES + feeKES;
  const ps = String(b.paymentStatus || 'pending');
  const escrow = { held: 0, released: 0, refunded: 0 };
  let commissionKES = null, providerNetKES = null, gatewayChargesKES = null;
  if (ps === 'paid_held') escrow.held = Math.round((Number(b.heldAmount) || (Number(b.price) || 0) + (Number(b.fee) || 0)) / 100);
  if (ps === 'settled') {
    const p = await db.collection('providerPayouts').doc(bookingId).get().catch(() => null);
    const x = p && p.exists ? p.data() : null;
    if (x) { commissionKES = Math.round((Number(x.commission) || 0) / 100); providerNetKES = Math.round((Number(x.settlementCents != null ? x.settlementCents : x.net) || 0) / 100); escrow.released = providerNetKES; }
    else escrow.released = totalKES;
  }
  if (ps === 'refunded') escrow.refunded = Math.round((Number(b.refundedCents) || 0) / 100);
  if (b.paymentRef) {
    const pay = await db.collection('payments').doc(String(b.paymentRef)).get().catch(() => null);
    if (pay && pay.exists) {
      const x = pay.data() || {};
      const amt = Number(x.amount != null ? x.amount : x.amountKES), net = Number(x.netAmount != null ? x.netAmount : amt);
      if (Number.isFinite(amt) && Number.isFinite(net)) gatewayChargesKES = Math.max(0, Math.round((amt - net) * 100) / 100);
    }
  }
  const ref = db.collection('orders').doc(bookingId);
  const cur = await ref.get();
  if (cur.exists && cur.data().type && cur.data().type !== 'service_booking') return { skipped: 'id_collision' };
  /* TRIGGER-INERT BY CONSTRUCTION (2026-10-01 audit). Live order triggers act on `status`,
     `orderStatus`, `sellerUid`/`sellerId`, `paymentVerified`, `hubId` and rider assignment:
     onOrderStatusChange settles on status → completed WITH sellerUid (it would credit the provider
     a SECOND time, beside providerCompleteBooking), auto-assigns a rider on confirmed, and
     onNewOrderCreated notifies the "seller" of a new order. This record is a VIEW of the booking for
     the buyer's order history — so it carries the booking state under its own names and none of
     those fields. The booking (providerBookings) stays the only authority; providerCompleteBooking
     stays the only provider credit point. */
  await ref.set({
    type: 'service_booking', source: 'providerBookings', bookingId, envId: envId || null,
    buyerUid: b.customerUid || null, providerUid: b.providerId || null,
    commissionHub: b.commissionHub || null, service: b.service || null, productName: b.service || 'Service booking',
    items: [{ name: b.service || 'Service booking', qty: 1, price: totalKES }],
    bookingStatus: b.status || null, bookingPaymentStatus: ps, paymentRef: b.paymentRef || null,
    total: totalKES, priceKES, feeKES, currency: 'KES', commissionKES, providerNetKES, gatewayChargesKES, escrow,
    scheduledAt: b.startTs || b.scheduledAt || null,
    createdAt: cur.exists && cur.data().createdAt ? cur.data().createdAt : (b.createdAt || FieldValue.serverTimestamp()),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { mirrored: true, escrow };
}

async function onBookingWritten(bookingId, after) {
  if (!after) return { skipped: 'deleted' };
  let issued = { skipped: 'not_paid' };
  if (HELD_OR_SETTLED.includes(String(after.paymentStatus || ''))) issued = await issueForBooking(bookingId, after);
  const envId = ID.envIdFor('providerBookings', bookingId);
  if (after.paymentStatus && after.paymentStatus !== 'pending') await mirrorServiceOrder(bookingId, after, envId).catch((e) => logger.warn('[bookingPin] order mirror failed', { bookingId, err: e.message }));
  return issued;
}

/* ── 3. attempt limits (same shape as the full module) ─────────────────────────────────── */
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
    return { locked: null };
  });
}

/* ── 4. the release gate: called by providerCompleteBooking for a HELD booking ──────────── */
async function verifyForCompletion({ bookingId, providerUid, pin }) {
  const envId = ID.envIdFor('providerBookings', bookingId);
  const ref = _db().collection(COL.ENV).doc(envId);
  const s = await ref.get();
  if (!s.exists) return { ok: false, reason: 'This booking has no PIN yet — it is issued when the customer\'s payment is held by SOKONI.' };
  const env = s.data();
  if (env.providerUid !== providerUid) return { ok: false, reason: 'Not your booking.' };
  if (env.verification && env.verification.state === 'VERIFIED') return { ok: true, alreadyVerified: true };   /* a retry after a partial failure */
  const win = _window(env);
  const nowMs = _now();
  if (win.opensAtMs && nowMs < win.opensAtMs) return { ok: false, reason: 'Too early — the booking PIN works from 2 hours before the booking starts. Complete the booking after the service.' };
  if (win.expiresAtMs && nowMs > win.expiresAtMs) return { ok: false, reason: 'This PIN has expired. Ask the customer to open the booking and tap "Get a new PIN" — the payment stays safely held until then.' };
  const p = ID.normalizePin(pin);
  if (!p) return { ok: false, reason: 'This booking was paid to SOKONI and is held. Ask the customer for their booking PIN — PIN YAKO NI BOOKING YAKO — and enter it to complete the service and release the payment.' };
  const pre = await _charge(envId, providerUid, false);
  if (pre.locked) return { ok: false, reason: 'Too many wrong PINs. Wait a few minutes before trying again.' };
  const want = env.pin && env.pin.hash, got = _pinHash(envId, p);
  const match = !!want && !!got && want.length === got.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
  if (!match) {
    await _charge(envId, providerUid, true);
    await _audit('booking_pin_failed', providerUid, envId, { bookingId });
    return { ok: false, reason: 'That PIN does not match this booking.' };
  }
  const done = await _db().runTransaction(async (txn) => {
    const cur = (await txn.get(ref)).data();
    if (cur.verification && cur.verification.state === 'VERIFIED') return true;
    if (ID.TERMINAL && ID.TERMINAL.has && ID.TERMINAL.has(cur.status)) return false;
    txn.update(ref, { verification: { state: 'VERIFIED', at: FieldValue.serverTimestamp(), by: providerUid }, updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
  if (!done) return { ok: false, reason: 'This booking can no longer be completed.' };
  await _audit('booking_pin_verified', providerUid, envId, { bookingId });
  return { ok: true, bookingRef: env.bookingRef };
}

/* ── 5. buyer reads their PIN ──────────────────────────────────────────────────────────── */
async function customerGetBookingPin(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const bookingId = String((req.data || {}).bookingId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(bookingId)) fail('invalid-argument', 'bookingId is required.');
  const envId = ID.envIdFor('providerBookings', bookingId);
  const s = await _db().collection(COL.ENV).doc(envId).get();
  if (!s.exists) return { issued: false, reason: 'not_yet_issued', phrase: ID.PHRASE.BOOKING };
  const env = s.data();
  if (env.buyerUid !== req.auth.uid) fail('permission-denied', 'This booking is not yours.');
  const sec = await _db().collection(COL.SECRETS).doc(envId).get();
  const win = _window(env);
  const nowMs = _now();
  const expired = !!(win.expiresAtMs && nowMs > win.expiresAtMs);
  const verified = !!(env.verification && env.verification.state === 'VERIFIED');
  const renewals = Number(env.pin && env.pin.renewals) || 0;
  const canRenew = !verified && env.payment && env.payment.state === ID.PAYMENT.CONFIRMED
    && (expired || !win.opensAtMs || nowMs >= win.opensAtMs) && renewals < MAX_RENEWALS;
  const _pinPlain = sec.exists ? _decPin(envId, sec.data().pinEnc) : null;
  return { issued: !!_pinPlain, pin: expired ? null : _pinPlain, bookingRef: env.bookingRef, phrase: ID.PHRASE.BOOKING,
           verification: env.verification ? env.verification.state : null, payment: env.payment ? env.payment.state : null,
           opensAtMs: win.opensAtMs || null, expiresAtMs: win.expiresAtMs, expired, canRenew, renewalsLeft: Math.max(0, MAX_RENEWALS - renewals) };
}

/* ── 5b. buyer renews the PIN when the booking time has come (or it expired) ───────────── */
async function customerRenewBookingPin(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const uid = req.auth.uid;
  const bookingId = String((req.data || {}).bookingId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(bookingId)) fail('invalid-argument', 'bookingId is required.');
  const db = _db();
  const envId = ID.envIdFor('providerBookings', bookingId);
  const envRef = db.collection(COL.ENV).doc(envId);
  const bRef = db.collection('providerBookings').doc(bookingId);
  const pin = String(_randInt(10000)).padStart(4, '0');
  const out = await db.runTransaction(async (txn) => {
    const [es, bs] = await Promise.all([txn.get(envRef), txn.get(bRef)]);
    if (!es.exists) fail('failed-precondition', 'This booking has no PIN yet — it is issued when your payment is held by SOKONI.');
    const env = es.data();
    if (env.buyerUid !== uid) fail('permission-denied', 'This booking is not yours.');
    const b = bs.exists ? bs.data() : {};
    if (b.paymentStatus !== 'paid_held') fail('failed-precondition', 'Only a booking whose payment is still held can get a new PIN.');
    if (env.verification && env.verification.state === 'VERIFIED') fail('failed-precondition', 'This booking\'s PIN has already been used.');
    if (ID.TERMINAL && ID.TERMINAL.has && ID.TERMINAL.has(ID.statusOf('providerBookings', b))) fail('failed-precondition', 'This booking is closed.');
    const win = _window({ ...env, when: { startMs: _ms(b.startTs) || _ms(b.scheduledAt), endMs: _ms(b.endTs) } });
    const nowMs = _now();
    const expired = !!(win.expiresAtMs && nowMs > win.expiresAtMs);
    if (!expired && win.opensAtMs && nowMs < win.opensAtMs) fail('failed-precondition', 'You can get a new PIN from 2 hours before your booking starts.');
    const renewals = Number(env.pin && env.pin.renewals) || 0;
    if (renewals >= MAX_RENEWALS) fail('resource-exhausted', 'This booking has reached its PIN renewal limit — contact SOKONI support.');
    txn.update(envRef, { pin: { hash: _pinHash(envId, pin), issuedAt: FieldValue.serverTimestamp(), issuedAtMs: nowMs, renewals: renewals + 1 },
      when: { startMs: _ms(b.startTs) || _ms(b.scheduledAt), endMs: _ms(b.endTs) }, updatedAt: FieldValue.serverTimestamp() });
    txn.set(db.collection(COL.SECRETS).doc(envId), { pinEnc: _encPin(envId, pin), pin: FieldValue.delete(), renewedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { renewals: renewals + 1, expiresAtMs: nowMs + PIN_TTL_MS, bookingRef: env.bookingRef };
  });
  await _audit('booking_pin_renewed', uid, envId, { bookingId, renewals: out.renewals });
  return { issued: true, pin, bookingRef: out.bookingRef, phrase: ID.PHRASE.BOOKING, expiresAtMs: Math.max(out.expiresAtMs, 0), renewalsLeft: MAX_RENEWALS - out.renewals };
}

const OPS = Object.freeze({
  getMyBookingPin: customerGetBookingPin,
  renewBookingPin: customerRenewBookingPin,
  /* verification + release in one call: the provider-ops completion path, with the PIN */
  verifyBookingPin: (req) => require('./provider-ops')._h.providerCompleteBooking({ ...req, data: { bookingId: (req.data || {}).bookingId, pin: (req.data || {}).pin } }),
});

exports.serviceBookingPin = onCall({ region: REGION, enforceAppCheck: true, timeoutSeconds: 60, memory: '256MiB', secrets: [SOKONI_HMAC_KEY] }, async (req) => {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const op = String((req.data || {}).op || '');
  if (!Object.prototype.hasOwnProperty.call(OPS, op)) fail('invalid-argument', `Unknown op "${op}".`);
  return OPS[op](req);
});

exports.entBookingOnProviderBooking = onDocumentWritten({ document: 'providerBookings/{id}', region: REGION, secrets: [SOKONI_HMAC_KEY] }, async (event) => {
  try { await onBookingWritten(event.params.id, event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null); }
  catch (e) { logger.error('[bookingPin] trigger failed', { id: event.params.id, err: e.message }); }
});

exports.SOKONI_HMAC_KEY = SOKONI_HMAC_KEY;
exports._internal = { _encPin, _decPin, issueForBooking, mirrorServiceOrder, onBookingWritten, verifyForCompletion, customerGetBookingPin, customerRenewBookingPin, COL, PIN_TTL_MS, MAX_RENEWALS, _setClock: (fn) => { _now = fn || (() => Date.now()); } };
