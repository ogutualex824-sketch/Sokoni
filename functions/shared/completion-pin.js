'use strict';
/**
 * THE PRODUCT COMPLETION PIN — one engine (owner, 2026-10-01).
 *
 * "PIN YAKO NI PRODUCT YAKO!" The PIN belongs to the BUYER. The seller or rider can ask the SERVER to send it to the
 * buyer, but no seller / rider / AdminOS surface can read it. The buyer gives it only after inspecting the order, and
 * a verified PIN is the proof (`deliveryAuthorizedBy:'rider_pin'`) that releases the held seller net
 * (order-settlement.js settleOrder) — exactly once.
 *
 * Owner decisions 2026-10-01:
 *   · TTL 48 h, server-side. An expired PIN is NOT an expired order — an eligible order gets a new PIN through
 *     the authorised send flow.
 *   · max FIVE send requests per order (counted server-side on the order).
 *   · no silent replacement when a rider accepts (deliveryPinOnAccept stops minting package-bound PINs).
 *   · 6 digits everywhere.
 *   · plaintext never persisted: the order carries the HMAC (keyed by SOKONI_HMAC_KEY — not brute-forceable from
 *     the hash without the key); deliveryPins/{orderId} carries the PIN SEALED (AES-256-GCM, key derived from the
 *     same secret, AAD = order id + version) so the buyer can re-view it through getMyDeliveryPin; SMS carries it
 *     transiently and nothing logs or stores the body.
 *   · SMS now (Africa's Talking, the existing authority); WhatsApp slot OFF until the owner provisions it.
 *
 * Mirrors the service-booking envelope (sokoni-4d, booking-pin-core.js): HMAC verification + sealed re-view,
 * attempt limits, renewal cap. Same secret, distinct derivation labels, so neither domain's material verifies the
 * other's. Pure helpers + I/O helpers that take db / FieldValue / key / sender as arguments (testable, no globals).
 */
const crypto = require('crypto');

const PIN_TTL_MS        = 48 * 3600 * 1000;
const MAX_SENDS         = 5;
const MAX_ATTEMPTS      = 5;
const LOCK_MS           = 30 * 60 * 1000;
const RESEND_MIN_GAP_MS = 60 * 1000;
const ENGINE            = 2;
const ENC_LABEL         = 'sokoni-delivery-pin-enc-v1';

/* user-facing failure states (brief §22) — callers put these in HttpsError details.reason */
const R = Object.freeze({
  PIN_NOT_ISSUED: 'PIN_NOT_ISSUED', PIN_EXPIRED: 'PIN_EXPIRED', PIN_ALREADY_USED: 'PIN_ALREADY_USED',
  PIN_INVALID: 'PIN_INVALID', PIN_LOCKED: 'PIN_LOCKED', PIN_DELIVERY_FAILED: 'PIN_DELIVERY_FAILED',
  PIN_RATE_LIMITED: 'PIN_RATE_LIMITED', ORDER_NOT_ELIGIBLE: 'ORDER_NOT_ELIGIBLE', ORDER_NOT_PAID: 'ORDER_NOT_PAID',
  RIDER_NOT_ASSIGNED: 'RIDER_NOT_ASSIGNED', SELLER_NOT_AUTHORIZED: 'SELLER_NOT_AUTHORIZED',
  ALREADY_COMPLETED: 'ALREADY_COMPLETED',
});

/* ── pure ─────────────────────────────────────────────────────────────────────────────────────────────── */
function newPin() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function isPinShape(p) { return /^\d{6}$/.test(String(p == null ? '' : p)); }
/** The existing ORDER-BOUND format (index.js _issueDeliveryPin, delivery-complete _hash) — unchanged, so every PIN
 *  already in the field keeps verifying. */
function hashPin(key, ref, pin) {
  if (!key) { const e = new Error('no HMAC key'); e.__noKey = true; throw e; }
  return crypto.createHmac('sha256', key).update(String(ref) + '|' + String(pin)).digest('hex');
}
function sameHash(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8'), B = Buffer.from(String(b || ''), 'utf8');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function _encKey(key) { return crypto.createHmac('sha256', key).update(ENC_LABEL).digest(); }
function sealPin(key, orderId, version, pin) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', _encKey(key), iv);
  c.setAAD(Buffer.from(String(orderId) + '|' + Number(version)));
  const ct = Buffer.concat([c.update(String(pin), 'utf8'), c.final()]);
  return { alg: 'A256GCM', iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
/** @returns the PIN, or null when the seal is absent, tampered, or bound to another order / version. */
function openPin(key, orderId, version, sealed) {
  try {
    if (!sealed || sealed.alg !== 'A256GCM') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', _encKey(key), Buffer.from(sealed.iv, 'base64'));
    d.setAAD(Buffer.from(String(orderId) + '|' + Number(version)));
    d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const pin = Buffer.concat([d.update(Buffer.from(sealed.ct, 'base64')), d.final()]).toString('utf8');
    return isPinShape(pin) ? pin : null;
  } catch (_) { return null; }
}

function buyerOf(o) { return (o && (o.buyerUid || o.buyerId || o.userId || o.uid || o.customerUid)) || null; }
function sellerOf(o) { return (o && (o.sellerUid || o.sellerId)) || null; }
function riderOf(o) { return (o && (o.assignedDriverUid || o.riderId || o.assignedRiderId)) || null; }
/** Same predicate as the live _issueDeliveryPin: only a DELIVERY order has something to prove. */
function isDeliveryOrder(o) {
  const d = o || {};
  const ful = String(d.fulfilmentType || d.fulfillmentType || d.deliveryType || '');
  return !!(d.deliveryRequired === true || /^delivery$/i.test(ful) || d.deliveryAddress || d.deliveryLocation);
}
const TERMINAL = ['cancelled', 'refunded', 'rejected', 'declined', 'failed'];
const DONE = ['delivered', 'completed'];
/** Can this order carry a live completion PIN? null = yes; else a reason (brief §13: an ORDER that is no longer
 *  eligible gets no PIN, ever — only a PIN can expire while its order stays valid). */
function eligibility(o) {
  if (!o) return R.ORDER_NOT_ELIGIBLE;
  const st = String(o.status || '').toLowerCase();
  if (DONE.includes(st)) return R.ALREADY_COMPLETED;
  if (TERMINAL.includes(st) || o.settlementStatus === 'REFUNDED') return R.ORDER_NOT_ELIGIBLE;
  if (o.paymentVerified !== true) return R.ORDER_NOT_PAID;
  if (!isDeliveryOrder(o)) return R.ORDER_NOT_ELIGIBLE;
  return null;
}
/** The lifecycle as the buyer / AdminOS see it (never the PIN). Legacy PINs (no engine stamp) never expire. */
function pinState(o, now) {
  if (!o || !o.deliveryPinHash) return 'NOT_ISSUED';
  if (o.deliveryPinStatus === 'USED' || DONE.includes(String(o.status || ''))) return 'USED';
  if (Number(o.deliveryPinLockedUntil || 0) > now) return 'LOCKED';
  if (o.deliveryPinExpiresAt && Number(o.deliveryPinExpiresAt) <= now) return 'EXPIRED';
  return o.deliveryPinDelivery === 'FAILED' ? 'DELIVERY_FAILED' : (o.deliveryPinDelivery === 'SENT' ? 'DELIVERED' : 'ISSUED');
}
/** The safe, masked view for the buyer screen / seller / AdminOS (brief §21). Never the PIN or its hash. */
function maskedView(o, now) {
  return {
    state: pinState(o, now), masked: '••••••', version: Number(o && o.deliveryPinVersion) || (o && o.deliveryPinHash ? 1 : 0),
    issuedAt: (o && o.deliveryPinIssuedAtMs) || null, expiresAt: (o && o.deliveryPinExpiresAt) || null,
    sends: Number(o && o.deliveryPinSends) || 0, maxSends: MAX_SENDS,
    attempts: Number(o && o.deliveryVerifyAttempts) || 0, maxAttempts: MAX_ATTEMPTS,
    lockedUntil: Number(o && o.deliveryPinLockedUntil) || null,
    delivery: (o && o.deliveryPinDelivery) || null, channel: (o && o.deliveryPinChannel) || null,
  };
}
function smsText(pin) {
  return 'SOKONI: Your delivery PIN is ' + pin + '. PIN YAKO NI PRODUCT YAKO! Give it only after checking your order. ' +
         'Something wrong? Do not give it - contact SOKONI Support.';
}

/* ── I/O: issue / resend (one transaction on the order) ──────────────────────────────────────────────── */
/**
 * mode 'auto'    — the order became paid: issue the first engine PIN if none exists (idempotent; a legacy PIN is kept).
 * mode 'request' — the seller / assigned rider / buyer asked the SERVER to send it: within the window the SAME PIN is
 *                  re-sent (two taps → one active PIN); once expired a NEW one is issued (version+1; the old hash is
 *                  overwritten, so the old PIN dies in the same write). Counted against MAX_SENDS, ≥ 60 s apart.
 * @returns {{ok:true, action:'none'|'resend'|'issued', version, pin?, phone?}|{ok:false, reason}}
 */
async function issueOrResend({ db, FV, key, orderId, mode, actorUid, now }) {
  if (!key) return { ok: false, reason: 'NO_KEY' };
  const oRef = db.collection('orders').doc(String(orderId));
  const pRef = db.collection('deliveryPins').doc(String(orderId));
  return db.runTransaction(async (t) => {
    const os = await t.get(oRef);
    const ps = await t.get(pRef);
    if (!os.exists) return { ok: false, reason: R.ORDER_NOT_ELIGIBLE };
    const o = os.data() || {}, p = ps.exists ? (ps.data() || {}) : {};
    const why = eligibility(o);
    if (why) return { ok: false, reason: why };
    const ver = Number(o.deliveryPinVersion) || 0;
    const engine = o.deliveryPinEngine === ENGINE;
    const live = !!o.deliveryPinHash && !(o.deliveryPinExpiresAt && Number(o.deliveryPinExpiresAt) <= now);
    if (mode === 'auto') {
      if (o.deliveryPinHash) return { ok: true, action: 'none', version: ver };   /* never replace a PIN the buyer may hold */
    } else {
      const sends = Number(o.deliveryPinSends) || 0;
      if (sends >= MAX_SENDS) return { ok: false, reason: R.PIN_RATE_LIMITED };
      if (now - Number(o.deliveryPinLastSentAt || 0) < RESEND_MIN_GAP_MS) return { ok: false, reason: R.PIN_RATE_LIMITED };
      if (live && engine) {
        const same = openPin(key, orderId, ver, p.sealed);
        if (same) {
          t.update(oRef, { deliveryPinSends: sends + 1, deliveryPinLastSentAt: now, deliveryPinLastSendBy: actorUid || null,
            deliveryPinDelivery: 'SENDING', updatedAt: FV.serverTimestamp() });
          return { ok: true, action: 'resend', version: ver, pin: same, buyerUid: buyerOf(o) };
        }
      }
    }
    const pin = newPin(), v = ver + 1;
    t.set(pRef, { orderId: String(orderId), binding: 'order', version: v, sealed: sealPin(key, orderId, v, pin),
      buyerUid: buyerOf(o), issuedAt: FV.serverTimestamp(), pin: FV.delete(), proofPin: FV.delete() }, { merge: true });
    t.update(oRef, {
      deliveryPinHash: hashPin(key, String(orderId), pin), deliveryPinBinding: 'order', deliveryPinIssued: true,
      deliveryPinEngine: ENGINE, deliveryPinVersion: v, deliveryPinStatus: 'ISSUED',
      deliveryPinIssuedAt: FV.serverTimestamp(), deliveryPinIssuedAtMs: now, deliveryPinExpiresAt: now + PIN_TTL_MS,
      deliveryVerifyAttempts: 0, deliveryPinLockedUntil: null,
      deliveryPinSends: (Number(o.deliveryPinSends) || 0) + (mode === 'auto' ? 0 : 1),
      deliveryPinLastSentAt: now, deliveryPinLastSendBy: actorUid || null, deliveryPinDelivery: 'SENDING',
      deliveryVerificationStatus: 'pending', updatedAt: FV.serverTimestamp(),
    });
    return { ok: true, action: 'issued', version: v, pin, buyerUid: buyerOf(o) };
  });
}

/** Deliver a PIN the engine just produced. SMS through the existing AT authority; WhatsApp OFF (not provisioned).
 *  Records channel / provider / messageId / status — NEVER the body. The order stays incomplete either way. */
async function deliverPin({ db, FV, orderId, version, pin, phone, sendSms, now }) {
  const log = db.collection('deliveryPinLog').doc(String(orderId) + '_v' + version + '_' + now);
  const base = { orderId: String(orderId), version, at: now, createdAt: FV.serverTimestamp() };
  await log.set(Object.assign({}, base, { channel: 'whatsapp', provider: null, status: 'NOT_CONFIGURED' })).catch(() => {});
  let res = { ok: false, error: 'no_phone' };
  if (phone) { try { res = (await sendSms(phone, smsText(pin))) || { ok: false, error: 'no_result' }; } catch (e) { res = { ok: false, error: String(e && e.message || e).slice(0, 80) }; } }
  const mid = res.results && res.results[0] ? res.results[0].messageId : null;
  await db.collection('deliveryPinLog').doc(String(orderId) + '_v' + version + '_' + now + '_sms').set(Object.assign({}, base, {
    channel: 'sms', provider: 'africastalking', messageId: mid || null, status: res.ok ? 'SENT' : 'FAILED',
    failureCode: res.ok ? null : String(res.status || res.error || 'failed').slice(0, 80) })).catch(() => {});
  await db.collection('orders').doc(String(orderId)).set({ deliveryPinDelivery: res.ok ? 'SENT' : 'FAILED',
    deliveryPinChannel: res.ok ? 'sms' : null, updatedAt: FV.serverTimestamp() }, { merge: true }).catch(() => {});
  if (!res.ok) {
    /* PIN DELIVERY FAILED — AdminOS / Support see it; the transaction stays incomplete (brief §10). */
    await db.collection('pinDeliveryFailures').doc(String(orderId) + '_v' + version).set(Object.assign({}, base,
      { status: 'open', reason: phone ? 'sms_failed' : 'no_buyer_phone' })).catch(() => {});
  }
  return { ok: !!res.ok, channel: res.ok ? 'sms' : null };
}

/** The buyer's phone — the canonical profile first, then the number that paid. Never client-supplied. */
async function resolveBuyerPhone(db, buyerUid, order) {
  let u = null;
  if (buyerUid) { try { const s = await db.collection('users').doc(String(buyerUid)).get(); u = s.exists ? (s.data() || {}) : null; } catch (_) { u = null; } }
  const o = order || {};
  return (u && (u.phone || u.phoneNumber || u.mpesaPhone)) || o.paidPhone || o.buyerPhone || o.phone || null;
}

/* ── I/O: one verification attempt (atomic counter + lockout) ────────────────────────────────────────── */
/**
 * Serialised on the ORDER: two concurrent wrong submissions both count; MAX_ATTEMPTS wrong → locked for LOCK_MS
 * (then the counter starts again). Expired / locked / used never compare. A match does NOT complete — the caller's
 * existing _completeDelivery transaction does that (one completion; a second gets alreadyDelivered).
 * `legacyPkg` = { ref, hash } — a package-bound PIN minted before this engine; honoured ONLY while the order has
 * no engine PIN (an engine reissue makes every older PIN invalid).
 */
async function verifyAttempt({ db, FV, key, orderId, pin, legacyPkg, now, actorUid }) {
  if (!isPinShape(pin)) return { ok: false, reason: R.PIN_INVALID, counted: false };
  const oRef = db.collection('orders').doc(String(orderId));
  const cand = { order: hashPin(key, String(orderId), pin), pkg: legacyPkg && legacyPkg.hash ? hashPin(key, legacyPkg.ref, pin) : null };
  return db.runTransaction(async (t) => {
    const os = await t.get(oRef);
    if (!os.exists) return { ok: false, reason: R.ORDER_NOT_ELIGIBLE };
    const o = os.data() || {};
    if (DONE.includes(String(o.status || '')) || o.deliveryPinStatus === 'USED') return { ok: false, reason: R.ALREADY_COMPLETED };
    if (TERMINAL.includes(String(o.status || '').toLowerCase())) return { ok: false, reason: R.ORDER_NOT_ELIGIBLE };
    if (Number(o.deliveryPinLockedUntil || 0) > now) return { ok: false, reason: R.PIN_LOCKED, lockedUntil: Number(o.deliveryPinLockedUntil) };
    const engine = o.deliveryPinEngine === ENGINE;
    if (!o.deliveryPinHash && !(legacyPkg && legacyPkg.hash)) return { ok: false, reason: R.PIN_NOT_ISSUED };
    if (o.deliveryPinExpiresAt && Number(o.deliveryPinExpiresAt) <= now) return { ok: false, reason: R.PIN_EXPIRED };
    const matched = (!!o.deliveryPinHash && o.deliveryPinBinding === 'order' && sameHash(cand.order, o.deliveryPinHash))
      || (!engine && !!cand.pkg && sameHash(cand.pkg, legacyPkg.hash));
    if (matched) return { ok: true, version: Number(o.deliveryPinVersion) || 1 };
    const fresh = Number(o.deliveryPinLockedUntil || 0) && Number(o.deliveryPinLockedUntil) <= now;   /* a lock that has lapsed */
    const attempts = (fresh ? 0 : Number(o.deliveryVerifyAttempts || 0)) + 1;
    const lock = attempts >= MAX_ATTEMPTS;
    t.update(oRef, { deliveryVerifyAttempts: attempts, deliveryPinLastAttemptAt: now,
      deliveryPinLockedUntil: lock ? now + LOCK_MS : (fresh ? null : (o.deliveryPinLockedUntil || null)), updatedAt: FV.serverTimestamp() });
    if (lock) {
      t.set(db.collection('pinSecurityEvents').doc(String(orderId) + '_lock_' + now), {
        type: 'PIN_LOCKED', orderId: String(orderId), actorUid: actorUid || null, attempts, lockedUntil: now + LOCK_MS,
        status: 'open', createdAt: FV.serverTimestamp() });
    }
    return { ok: false, reason: lock ? R.PIN_LOCKED : R.PIN_INVALID, attempts, counted: true };
  });
}

module.exports = {
  PIN_TTL_MS, MAX_SENDS, MAX_ATTEMPTS, LOCK_MS, RESEND_MIN_GAP_MS, ENGINE, R,
  newPin, isPinShape, hashPin, sameHash, sealPin, openPin, buyerOf, sellerOf, riderOf, isDeliveryOrder,
  eligibility, pinState, maskedView, smsText, issueOrResend, deliverPin, verifyAttempt, resolveBuyerPhone,
};
