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
  const src = env.source && env.source.collection && Object.prototype.hasOwnProperty.call(SOURCE, env.source.collection) ? SOURCE[env.source.collection] : null;
  const opensBefore = src ? src.opensBeforeMs : PIN_OPENS_BEFORE_MS;   /* a rental return can come early: no opening gate */
  const opensAtMs = startMs && opensBefore ? startMs - opensBefore : 0;
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

/* ── 0. SOURCE ADAPTERS — the ONLY per-source code (sokoni-5b review, 2026-10-03) ──────────────────────────────
   One PIN authority for every held-money booking. Everything below (hash, encryption at rest, references, attempt
   limits, renewals, buyer re-view) is shared; a source supplies only who the parties are, what is held, and when.
   providerUid always comes from SERVER data (the source record, or the shop it names) — never from a client field.
     providerBookings  the service booking (unchanged behaviour: these adapters reproduce the original code exactly)
     rentalBookings    an equipment rental (owner 2026-10-03): ONE PIN at RETURN. The renter gives it when the equipment
                       comes back; the seller enters it in rentalConfirmReturn (return_pending → returned), which releases
                       the held money. Hand-over stays a seller action. A return can come early, so no "too early" gate. */
const SOURCE = Object.freeze({
  providerBookings: Object.freeze({
    held: (b) => HELD_OR_SETTLED.includes(String(b.paymentStatus || '')),
    heldUnreleased: (b) => b.paymentStatus === 'paid_held',
    providerUid: async (_txn, b) => b.providerId || null,
    buyerUid: (b) => b.customerUid || null,
    category: (b) => (b.entClass === ID.CATEGORY.ARTIST ? ID.CATEGORY.ARTIST : ID.CATEGORY.SERVICE),
    providerKind: (category) => (category === ID.CATEGORY.ARTIST ? 'artist' : 'service_provider'),
    when: (b) => ({ startMs: _ms(b.startTs) || _ms(b.scheduledAt), endMs: _ms(b.endTs) }),
    amountCents: (b) => (Number(b.price) || 0) + (Number(b.fee) || 0),
    title: (b) => b.service || 'Service',
    location: (b) => b.address || b.location || null,
    detail: (b) => (b.durationMins ? `${b.durationMins} min` : null),
    opensBeforeMs: PIN_OPENS_BEFORE_MS,
  }),
  rentalBookings: Object.freeze({
    held: (b) => ['held', 'released'].includes(String(b.paymentStatus || '')),
    heldUnreleased: (b) => b.paymentStatus === 'held',
    /* the renting shop's owner, read from shops/{shopId} — the same identity model as marketplace-extensions
       _assertSeller (ownerId, or a legacy shop with no ownerId whose id IS the owner's uid). Missing shop → null. */
    providerUid: async (txn, b) => {
      if (!b.shopId || !/^[A-Za-z0-9_-]{1,128}$/.test(String(b.shopId))) return null;
      const s = await txn.get(_db().collection('shops').doc(String(b.shopId)));
      if (!s.exists) return null;
      const shop = s.data() || {};
      return 'ownerId' in shop ? (shop.ownerId || null) : String(b.shopId);
    },
    buyerUid: (b) => b.buyerId || null,
    category: () => ID.CATEGORY.RENTAL,
    providerKind: () => 'rental_shop',
    when: (b) => ({ startMs: _ms(b.startDate), endMs: _ms(b.endDate) }),
    /* informational only (money never moves here): the held amount if the payment authority recorded it */
    amountCents: (b) => (Number.isFinite(Number(b.heldAmountCents)) && b.heldAmountCents != null
      ? Math.round(Number(b.heldAmountCents))
      : Math.round(((Number(b.totalAmount) || 0) + (Number(b.depositAmount) || 0)) * 100)),
    title: (b) => String(b.rentalTitle || 'Equipment rental').slice(0, 150),
    location: () => null,
    detail: (b) => (b.durationUnit ? String(b.durationUnit) : null),
    opensBeforeMs: null,
    requireProvider: true,
  }),
});
function _source(name) {
  const s = Object.prototype.hasOwnProperty.call(SOURCE, name) ? SOURCE[name] : null;
  if (!s) fail('invalid-argument', 'Unknown booking type.');
  return s;
}

/* ── 1. issue the PIN once the payment is HELD (trigger) ───────────────────────────────── */
async function issueFor(source, bookingId, b) {
  const A = _source(source);
  if (!b || !A.held(b)) return { skipped: 'not_paid' };
  const db = _db();
  const envId = ID.envIdFor(source, bookingId);
  const envRef = db.collection(COL.ENV).doc(envId);
  let created = false, skipped = null;
  await db.runTransaction(async (txn) => {
    const cur = await txn.get(envRef);
    const providerUid = await A.providerUid(txn, b);
    if (cur.exists) { txn.update(envRef, { when: A.when(b), status: ID.statusOf(source, b), payment: { state: ID.paymentOf(source, b), paymentRef: b.paymentRef || null, amountCents: A.amountCents(b) }, updatedAt: FieldValue.serverTimestamp() }); return; }
    if (A.requireProvider && !providerUid) { skipped = 'no_provider'; return; }   /* fail closed: no PIN that no one could verify */
    const category = A.category(b);
    const year = new Date(_now()).getUTCFullYear();
    let bookingRef = null;
    for (let i = 0; i < 8 && !bookingRef; i++) {
      const cand = `${ID.REF_PREFIX[category]}-${year}-${String(_randInt(1000000)).padStart(6, '0')}`;
      if (!(await txn.get(db.collection(COL.REFS).doc(cand))).exists) bookingRef = cand;
    }
    if (!bookingRef) fail('resource-exhausted', 'Could not allocate a booking reference — try again.');
    const pin = String(_randInt(10000)).padStart(4, '0');
    txn.create(envRef, {
      envId, bookingRef, category, source: { collection: source, id: bookingId },
      buyerUid: A.buyerUid(b), providerUid, providerKind: A.providerKind(category),
      title: A.title(b), providerName: null, location: A.location(b), detail: A.detail(b),
      when: A.when(b), status: ID.statusOf(source, b),
      payment: { state: ID.paymentOf(source, b), paymentRef: b.paymentRef || null, amountCents: A.amountCents(b) },
      refund: { state: 'NONE' }, ticketNumbers: null, quantity: null,
      pin: { hash: _pinHash(envId, pin), issuedAt: FieldValue.serverTimestamp(), issuedAtMs: _now(), renewals: 0 },
      verification: { state: 'NOT_VERIFIED' }, conversationId: null, issuedBy: 'booking-pin-core',
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), version: 1,
    });
    txn.create(db.collection(COL.REFS).doc(bookingRef), { envId, createdAt: FieldValue.serverTimestamp() });
    txn.create(db.collection(COL.SECRETS).doc(envId), { envId, bookingRef, pinEnc: _encPin(envId, pin), buyerUid: A.buyerUid(b), createdAt: FieldValue.serverTimestamp() });
    created = true;
  });
  if (skipped) { logger.warn('[bookingPin] not issued', { source, bookingId, skipped }); return { envId, created: false, skipped }; }
  if (created) await _audit('booking_pin_issued', 'system', envId, source === 'providerBookings' ? { bookingId } : { source, bookingId });
  return { envId, created };
}
const issueForBooking = (bookingId, b) => issueFor('providerBookings', bookingId, b);

/* A non-held write (cancel, refund, completion) keeps an EXISTING envelope's status / payment current, so the
   terminal checks in verify / renew see it. Never creates an envelope. Used by the rental trigger (rental-pin.js). */
async function syncEnvelope(source, bookingId, b) {
  const A = _source(source);
  const ref = _db().collection(COL.ENV).doc(ID.envIdFor(source, bookingId));
  const s = await ref.get();
  if (!s.exists) return { skipped: 'no_envelope' };
  await ref.update({ status: ID.statusOf(source, b), payment: { state: ID.paymentOf(source, b), paymentRef: b.paymentRef || null, amountCents: A.amountCents(b) }, updatedAt: FieldValue.serverTimestamp() });
  return { synced: true };
}
async function onSourceWritten(source, bookingId, after) {
  if (!after) return { skipped: 'deleted' };
  return _source(source).held(after) ? issueFor(source, bookingId, after) : syncEnvelope(source, bookingId, after);
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

/* Per-source wording. providerBookings strings are the original ones, unchanged. */
const COPY = Object.freeze({
  providerBookings: Object.freeze({
    none: 'This booking has no PIN yet — it is issued when the customer\'s payment is held by SOKONI.',
    early: 'Too early — the booking PIN works from 2 hours before the booking starts. Complete the booking after the service.',
    expired: 'This PIN has expired. Ask the customer to open the booking and tap "Get a new PIN" — the payment stays safely held until then.',
    ask: 'This booking was paid to SOKONI and is held. Ask the customer for their booking PIN — PIN YAKO NI BOOKING YAKO — and enter it to complete the service and release the payment.',
    closed: 'This booking can no longer be completed.',
  }),
  rentalBookings: Object.freeze({
    none: 'This rental has no PIN yet — it is issued when the renter\'s payment is held by SOKONI.',
    early: 'Too early for this rental\'s PIN.',
    expired: 'This PIN has expired. Ask the renter to open the rental and tap "Get a new PIN" — the payment stays safely held until then.',
    ask: 'This rental was paid to SOKONI and is held. When the equipment is back, ask the renter for their rental PIN — PIN YAKO NI BOOKING YAKO — and enter it to confirm the return and release the payment.',
    closed: 'This rental can no longer be returned with a PIN.',
  }),
});

/* ── 4. the release gate ─────────────────────────────────────────────────────────────────────────────────────
   providerBookings: called by providerCompleteBooking for a HELD booking. rentalBookings: called by
   rentalConfirmReturn (return_pending → returned) for a HELD rental, AFTER the caller's own seller check.
   providerUid = the provider of record (server-resolved by the caller); actorUid = who is typing the PIN
   (a shop employee may confirm a return) — attempt limits are charged to the actor. */
async function verify({ source, bookingId, providerUid, actorUid, pin }) {
  const C = COPY[source] || COPY.providerBookings;
  _source(source);
  const actor = actorUid || providerUid;
  const envId = ID.envIdFor(source, bookingId);
  const ref = _db().collection(COL.ENV).doc(envId);
  const s = await ref.get();
  if (!s.exists) return { ok: false, reason: C.none };
  const env = s.data();
  if (!providerUid || env.providerUid !== providerUid) return { ok: false, reason: 'Not your booking.' };
  if (env.verification && env.verification.state === 'VERIFIED') return { ok: true, alreadyVerified: true };   /* a retry after a partial failure */
  const win = _window(env);
  const nowMs = _now();
  if (win.opensAtMs && nowMs < win.opensAtMs) return { ok: false, reason: C.early };
  if (win.expiresAtMs && nowMs > win.expiresAtMs) return { ok: false, reason: C.expired };
  const p = ID.normalizePin(pin);
  if (!p) return { ok: false, reason: C.ask };
  const pre = await _charge(envId, actor, false);
  if (pre.locked) return { ok: false, reason: 'Too many wrong PINs. Wait a few minutes before trying again.' };
  const want = env.pin && env.pin.hash, got = _pinHash(envId, p);
  const match = !!want && !!got && want.length === got.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
  if (!match) {
    await _charge(envId, actor, true);
    await _audit('booking_pin_failed', actor, envId, source === 'providerBookings' ? { bookingId } : { source, bookingId });
    return { ok: false, reason: 'That PIN does not match this booking.' };
  }
  const done = await _db().runTransaction(async (txn) => {
    const cur = (await txn.get(ref)).data();
    if (cur.verification && cur.verification.state === 'VERIFIED') return true;
    if (ID.TERMINAL && ID.TERMINAL.has && ID.TERMINAL.has(cur.status)) return false;
    txn.update(ref, { verification: { state: 'VERIFIED', at: FieldValue.serverTimestamp(), by: actor }, updatedAt: FieldValue.serverTimestamp() });
    return true;
  });
  if (!done) return { ok: false, reason: C.closed };
  await _audit('booking_pin_verified', actor, envId, source === 'providerBookings' ? { bookingId } : { source, bookingId });
  return { ok: true, bookingRef: env.bookingRef };
}
const verifyForCompletion = ({ bookingId, providerUid, pin }) => verify({ source: 'providerBookings', bookingId, providerUid, pin });

/* The buyer names which kind of booking (default: a service booking, as before). Only known sources. */
function _reqSource(req) {
  const raw = (req.data || {}).source;
  const source = raw == null || raw === '' ? 'providerBookings' : String(raw);
  _source(source);
  return source;
}

/* ── 5. buyer reads their PIN ──────────────────────────────────────────────────────────── */
async function customerGetBookingPin(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  const bookingId = String((req.data || {}).bookingId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(bookingId)) fail('invalid-argument', 'bookingId is required.');
  const source = _reqSource(req);
  const envId = ID.envIdFor(source, bookingId);
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
  const source = _reqSource(req);
  const A = SOURCE[source];
  const db = _db();
  const envId = ID.envIdFor(source, bookingId);
  const envRef = db.collection(COL.ENV).doc(envId);
  const bRef = db.collection(source).doc(bookingId);
  const pin = String(_randInt(10000)).padStart(4, '0');
  const out = await db.runTransaction(async (txn) => {
    const [es, bs] = await Promise.all([txn.get(envRef), txn.get(bRef)]);
    if (!es.exists) fail('failed-precondition', 'This booking has no PIN yet — it is issued when your payment is held by SOKONI.');
    const env = es.data();
    if (env.buyerUid !== uid) fail('permission-denied', 'This booking is not yours.');
    const b = bs.exists ? bs.data() : {};
    if (!A.heldUnreleased(b)) fail('failed-precondition', 'Only a booking whose payment is still held can get a new PIN.');
    if (env.verification && env.verification.state === 'VERIFIED') fail('failed-precondition', 'This booking\'s PIN has already been used.');
    if (ID.TERMINAL && ID.TERMINAL.has && ID.TERMINAL.has(ID.statusOf(source, b))) fail('failed-precondition', 'This booking is closed.');
    const win = _window({ ...env, when: A.when(b) });
    const nowMs = _now();
    const expired = !!(win.expiresAtMs && nowMs > win.expiresAtMs);
    if (!expired && win.opensAtMs && nowMs < win.opensAtMs) fail('failed-precondition', 'You can get a new PIN from 2 hours before your booking starts.');
    const renewals = Number(env.pin && env.pin.renewals) || 0;
    if (renewals >= MAX_RENEWALS) fail('resource-exhausted', 'This booking has reached its PIN renewal limit — contact SOKONI support.');
    txn.update(envRef, { pin: { hash: _pinHash(envId, pin), issuedAt: FieldValue.serverTimestamp(), issuedAtMs: nowMs, renewals: renewals + 1 },
      when: A.when(b), updatedAt: FieldValue.serverTimestamp() });
    txn.set(db.collection(COL.SECRETS).doc(envId), { pinEnc: _encPin(envId, pin), pin: FieldValue.delete(), renewedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { renewals: renewals + 1, expiresAtMs: nowMs + PIN_TTL_MS, bookingRef: env.bookingRef };
  });
  await _audit('booking_pin_renewed', uid, envId, source === 'providerBookings' ? { bookingId, renewals: out.renewals } : { source, bookingId, renewals: out.renewals });
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
/* source-neutral surface (rental-pin.js trigger; marketplace-extensions rentalConfirmReturn) */
exports.issueFor = issueFor;
exports.verify = verify;
exports.onSourceWritten = onSourceWritten;
exports.SOURCES = Object.freeze(Object.keys(SOURCE));
exports._internal = { _encPin, _decPin, issueForBooking, issueFor, syncEnvelope, onSourceWritten, mirrorServiceOrder, onBookingWritten, verifyForCompletion, verify, customerGetBookingPin, customerRenewBookingPin, SOURCE, COL, PIN_TTL_MS, MAX_RENEWALS, _setClock: (fn) => { _now = fn || (() => Date.now()); } };
