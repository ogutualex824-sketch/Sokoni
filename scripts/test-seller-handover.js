#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   seller-handover.js — BEHAVIOURAL suite (no deployment required)
   ══════════════════════════════════════════════════════════════════════════════
   Run: node scripts/test-seller-handover.js

   Loads functions/seller-handover.js (and, transitively, the REAL
   delivery-authority.js and fulfilment-lifecycle.js it depends on — not
   reimplementations) with firebase-admin/firebase-functions intercepted, against
   a transaction-capable in-memory Firestore stub. Exercises the shipped handlers.

   Certifies, per docs/SELLER_AUTHORIZE_HANDOVER_DESIGN.md:
     - authorization is seller/admin-only, ownership-checked, and requires a rider
       already assigned (does not touch claimAvailableDelivery's own transaction)
     - authorization is idempotent — a second call never rotates the PIN
     - the pickup PIN is readable by the seller only, never by the assigned rider
       (including the self-deal case: seller and rider are the same uid)
     - completePickupWithPin is rider-only, denies before authorization exists,
       has its OWN 5-attempt lockout independent of deliveryVerifyAttempts,
       fails closed on a missing HMAC secret, and — on success — advances to the
       EXISTING canonical `picked_up` stage without touching any wallet collection
     - a replay, and an order already further along, are both inert rather than
       clobbering state
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(d).slice(0, 160) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER   = 'SELLER_uid_1';
const RIDER    = 'RIDER_uid_2';
const RIDER2   = 'RIDER_uid_9';
const BUYER    = 'BUYER_uid_4';
const STRANGER = 'STRANGER_uid_3';

/* ── Transaction-capable in-memory Firestore stub ──────────────────────────── */
const DATA = {
  orders: {
    ORD1: { sellerUid: SELLER, buyerUid: BUYER, status: 'awaiting_rider' },
    ORD2: { sellerUid: SELLER, buyerUid: BUYER, assignedDriverUid: RIDER, status: 'rider_assigned' },
    ORD3: { sellerUid: SELLER, buyerUid: BUYER, assignedDriverUid: RIDER2, status: 'rider_assigned' },
    ORD_SELF: { sellerUid: RIDER, buyerUid: BUYER, assignedDriverUid: RIDER, status: 'rider_assigned' },
    ORD_ADMIN: { sellerUid: SELLER, buyerUid: BUYER, assignedDriverUid: RIDER, status: 'rider_assigned' },
    ORD_FAR: { sellerUid: SELLER, buyerUid: BUYER, assignedDriverUid: RIDER, status: 'in_transit' },
  },
  packageRequests: {
    PKG_NOT_ASSIGNED: { orderId: 'ORD1', sellerUid: SELLER, status: 'awaiting_rider' },
    PKG_ASSIGNED:     { orderId: 'ORD2', sellerUid: SELLER, status: 'driver_accepted', assignedDriverUid: RIDER, riderId: RIDER },
    PKG_NOT_AUTH:      { orderId: 'ORD3', sellerUid: SELLER, status: 'driver_accepted', assignedDriverUid: RIDER2, riderId: RIDER2 },
    PKG_SELF:          { orderId: 'ORD_SELF', sellerUid: RIDER, status: 'driver_accepted', assignedDriverUid: RIDER },
    PKG_ADMIN:         { orderId: 'ORD_ADMIN', sellerUid: SELLER, status: 'driver_accepted', assignedDriverUid: RIDER, riderId: RIDER },
    PKG_NOKEY:         { orderId: null, sellerUid: SELLER, status: 'driver_accepted', assignedDriverUid: RIDER, riderId: RIDER },
    PKG_FAR:           { orderId: 'ORD_FAR', sellerUid: SELLER, status: 'in_transit', assignedDriverUid: RIDER, riderId: RIDER,
                          handoverAuthorizedAt: 'TS', pickupPinHash: null /* filled below */ },
  },
  deliveryPins: {
    ORD_SELF: { orderId: 'ORD_SELF', pickupPin: '111111' }, /* seeded directly — bypasses authorize, for the reader test */
  },
  deliveryAuditLog: {},
};

function apply(col, id, data, merge) {
  DATA[col] = DATA[col] || {};
  const prev = merge && DATA[col][id] ? Object.assign({}, DATA[col][id]) : {};
  const out = merge ? prev : {};
  Object.keys(data).forEach((f) => {
    const v = data[f];
    if (v && typeof v === 'object' && v.__inc !== undefined) {
      out[f] = Number(out[f] || 0) + v.__inc;
      return;
    }
    out[f] = v === 'DEL' ? undefined : v;
    if (out[f] === undefined) delete out[f];
  });
  DATA[col][id] = out;
}
function snap(col, id) {
  const v = DATA[col] && DATA[col][id];
  return { exists: !!v, data: () => v, id };
}
function docRef(col, id) {
  return {
    _col: col, _id: id, id,
    get: async () => snap(col, id),
    set: async (d, o) => apply(col, id, d, !!(o && o.merge)),
    update: async (d) => apply(col, id, d, true),
  };
}
const db = {
  collection: (col) => ({
    doc: (id) => docRef(col, id),
    add: async (entry) => { DATA[col] = DATA[col] || {}; const k = 'auto_' + Math.random().toString(36).slice(2, 8); DATA[col][k] = entry; },
  }),
  async runTransaction(fn) {
    const ops = [];
    const r = await fn({
      get: (ref) => ref.get(),
      set: (ref, d, o) => ops.push([ref._col, ref._id, d, !!(o && o.merge)]),
      update: (ref, d) => ops.push([ref._col, ref._id, d, true]),
    });
    ops.forEach(([col, id, d, m]) => apply(col, id, d, m));
    return r;
  },
};

/* ── HMAC key toggle — for the "fails closed" tests ─────────────────────────── */
let hmacKeyAvailable = true;

/* ── Intercept every module seller-handover.js requires (directly or transitively) ── */
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin') {
    return {
      firestore: Object.assign(() => db, {
        FieldValue: { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n || 1 }), delete: () => 'DEL' },
      }),
      apps: [{}],
    };
  }
  if (request === 'firebase-functions/v2/https') {
    return {
      onCall: (opts, handler) => handler || opts,
      HttpsError: class extends Error { constructor(code, msg) { super(msg); this.code = code; } },
    };
  }
  if (request === 'firebase-functions/v2/firestore') {
    return { onDocumentUpdated: (opts, handler) => handler };
  }
  if (request === 'firebase-functions/params') {
    return { defineSecret: () => ({ value: () => (hmacKeyAvailable ? 'test-hmac-key' : null) }) };
  }
  return realLoad.apply(this, arguments);
};

let mod;
try {
  mod = require(path.join(__dirname, '..', 'functions', 'seller-handover.js'));
} finally {
  Module._load = realLoad;
}

const code = (e) => (e && e.code) || null;
const authorize = (uid, data, token) => mod.sellerAuthorizeHandover({ auth: uid ? { uid, token: token || {} } : null, data });
const readPin   = (uid, data) => mod.getMyPickupPin({ auth: uid ? { uid } : null, data });
const complete  = (uid, data) => mod.completePickupWithPin({ auth: uid ? { uid } : null, data });

(async function () {

/* ══ 0. Controls ══════════════════════════════════════════════════════════ */
console.log('\n0. Controls');
{
  ck('C1 the module loaded under interception', !!mod);
  ck('C2 all three callables are exported', typeof mod.sellerAuthorizeHandover === 'function'
    && typeof mod.getMyPickupPin === 'function' && typeof mod.completePickupWithPin === 'function');
  ck('C3 the stub fixture is real (PKG_ASSIGNED exists, PKG_NOPE does not)',
    snap('packageRequests', 'PKG_ASSIGNED').exists && !snap('packageRequests', 'PKG_NOPE').exists);
}

/* ══ 1. sellerAuthorizeHandover — denials ════════════════════════════════════ */
console.log('\n1. sellerAuthorizeHandover — denials');
{
  let c;
  try { await authorize(null, { deliveryRef: 'PKG_ASSIGNED' }); } catch (e) { c = code(e); }
  ck('1.1 unauthenticated is refused', c === 'unauthenticated', c);

  c = undefined;
  try { await authorize(SELLER, {}); } catch (e) { c = code(e); }
  ck('1.2 missing deliveryRef is refused', c === 'invalid-argument', c);

  c = undefined;
  try { await authorize(SELLER, { deliveryRef: 'NOPE' }); } catch (e) { c = code(e); }
  ck('1.3 an unknown delivery is not-found', c === 'not-found', c);

  c = undefined;
  try { await authorize(STRANGER, { deliveryRef: 'PKG_ASSIGNED' }); } catch (e) { c = code(e); }
  ck('1.4 an unrelated stranger is refused', c === 'permission-denied', c);

  c = undefined;
  try { await authorize(BUYER, { deliveryRef: 'PKG_ASSIGNED' }); } catch (e) { c = code(e); }
  ck('1.5 the BUYER is refused — only seller/admin authorize handover', c === 'permission-denied', c);

  c = undefined;
  try { await authorize(RIDER, { deliveryRef: 'PKG_ASSIGNED' }); } catch (e) { c = code(e); }
  ck('1.6 the assigned RIDER cannot authorize their own pickup', c === 'permission-denied', c);

  c = undefined;
  try { await authorize(SELLER, { deliveryRef: 'PKG_NOT_ASSIGNED' }); } catch (e) { c = code(e); }
  ck('1.7 no rider assigned yet is refused (failed-precondition, not silently allowed)', c === 'failed-precondition', c);
}

/* ══ 2. sellerAuthorizeHandover — success + idempotency ══════════════════════ */
console.log('\n2. sellerAuthorizeHandover — success, then idempotent');
let firstHash, firstPin;
{
  const before = snap('packageRequests', 'PKG_ASSIGNED').data();
  ck('2.0 precondition — no pickupPinHash before authorization', !before.pickupPinHash);

  const r1 = await authorize(SELLER, { deliveryRef: 'PKG_ASSIGNED' });
  ck('2.1 the owning seller succeeds', r1 && r1.ok === true && r1.alreadyAuthorized === false, JSON.stringify(r1));

  const after = snap('packageRequests', 'PKG_ASSIGNED').data();
  firstHash = after.pickupPinHash;
  ck('2.2 pickupPinHash is now set', !!firstHash);
  ck('2.3 pickupVerifyAttempts initialised to 0', after.pickupVerifyAttempts === 0);
  ck('2.4 handoverAuthorizedBy records the seller', after.handoverAuthorizedBy === SELLER);
  ck('2.5 deliveryPinHash (the UNRELATED delivery-stage field) was never touched by this file',
    after.deliveryPinHash === undefined);

  const ord = snap('orders', 'ORD2').data();
  ck('2.6 the order mirrors the authorization fact', ord.handoverAuthorizedBy === SELLER);

  const pinDoc = snap('deliveryPins', 'ORD2').data();
  firstPin = pinDoc && pinDoc.pickupPin;
  ck('2.7 the plaintext pickup PIN lands in the existing deliveryPins collection', !!firstPin);

  /* Idempotency — the exact regression this design calls out: a re-tap must not mint
     a new PIN and silently invalidate one already told to the rider. */
  const r2 = await authorize(SELLER, { deliveryRef: 'PKG_ASSIGNED' });
  ck('2.8 a second authorize call reports alreadyAuthorized', r2 && r2.alreadyAuthorized === true, JSON.stringify(r2));

  const after2 = snap('packageRequests', 'PKG_ASSIGNED').data();
  ck('2.9 ...and the hash is UNCHANGED (no new PIN minted)', after2.pickupPinHash === firstHash);

  const pinDoc2 = snap('deliveryPins', 'ORD2').data();
  ck('2.10 ...and the plaintext PIN is UNCHANGED too', pinDoc2.pickupPin === firstPin);
}

/* ══ 3. sellerAuthorizeHandover — admin ═══════════════════════════════════════ */
console.log('\n3. sellerAuthorizeHandover — admin can also authorize');
{
  const r = await authorize('ADMIN_uid', { deliveryRef: 'PKG_ADMIN' }, { admin: true });
  ck('3.1 an admin token succeeds where it is not the seller', r && r.ok === true, JSON.stringify(r));
}

/* ══ 4. getMyPickupPin ════════════════════════════════════════════════════════ */
console.log('\n4. getMyPickupPin — seller-only, rider explicitly refused');
{
  let c;
  try { await readPin(null, { orderId: 'ORD2' }); } catch (e) { c = code(e); }
  ck('4.1 unauthenticated is refused', c === 'unauthenticated', c);

  c = undefined;
  try { await readPin(STRANGER, { orderId: 'ORD2' }); } catch (e) { c = code(e); }
  ck('4.2 a non-seller is refused', c === 'permission-denied', c);

  const rOk = await readPin(SELLER, { orderId: 'ORD2' });
  ck('4.3 the owning seller reads the PIN back', rOk && rOk.pin === firstPin, JSON.stringify(rOk));
  ck('4.4 ...flagged issued:true', rOk && rOk.issued === true);

  const rNone = await readPin(SELLER, { orderId: 'ORD1' });
  ck('4.5 "not yet authorized" is issued:false, not an error', rNone && rNone.ok === true && rNone.issued === false, JSON.stringify(rNone));

  /* Self-deal: seller and rider are the SAME uid. The seller-match alone would PASS
     here — exactly why the rider-refusal is a separate, explicit check. */
  let c2;
  try { await readPin(RIDER, { orderId: 'ORD_SELF' }); } catch (e) { c2 = code(e); }
  ck('4.6 seller-who-is-also-the-assigned-rider is still refused', c2 === 'permission-denied', c2);
}

/* ══ 5. completePickupWithPin — denials ═══════════════════════════════════════ */
console.log('\n5. completePickupWithPin — denials');
{
  let c;
  try { await complete(null, { deliveryRef: 'PKG_ASSIGNED', pin: firstPin }); } catch (e) { c = code(e); }
  ck('5.1 unauthenticated is refused', c === 'unauthenticated', c);

  c = undefined;
  try { await complete(STRANGER, { deliveryRef: 'PKG_ASSIGNED', pin: firstPin }); } catch (e) { c = code(e); }
  ck('5.2 a stranger is refused — checked BEFORE the pin, not usable as an oracle', c === 'permission-denied', c);

  c = undefined;
  try { await complete(RIDER2, { deliveryRef: 'PKG_ASSIGNED', pin: firstPin }); } catch (e) { c = code(e); }
  ck('5.3 a DIFFERENT rider (not this delivery\'s) is refused', c === 'permission-denied', c);

  c = undefined;
  try { await complete(RIDER2, { deliveryRef: 'PKG_NOT_AUTH', pin: '123456' }); } catch (e) { c = code(e); }
  ck('5.4 the assigned rider is refused before seller authorization exists (no pickupPinHash yet)',
    c === 'failed-precondition', c);

  c = undefined;
  try { await complete(RIDER, { deliveryRef: 'PKG_ASSIGNED', pin: 'abc' }); } catch (e) { c = code(e); }
  ck('5.5 a non-numeric pin is rejected as invalid-argument, not silently compared', c === 'invalid-argument', c);
}

/* ══ 6. completePickupWithPin — own lockout, independent of deliveryVerifyAttempts ══ */
console.log('\n6. completePickupWithPin — 5-attempt lockout, ISOLATED from the delivery-stage counter');
{
  apply('packageRequests', 'PKG_ASSIGNED', { deliveryVerifyAttempts: 3 }, true); /* seed an UNRELATED counter */

  /* MAX_ATTEMPTS=5 means 5 wrong guesses are recorded (attempts 0..4 all pass the
     `attempts >= MAX_ATTEMPTS` gate and reach the pin check); the 6th call is the one
     that finds attempts===5 and locks. Same off-by-one convention as
     delivery-complete.js's completeDeliveryWithPin, deliberately mirrored. */
  for (let i = 1; i <= 6; i++) {
    let c;
    try { await complete(RIDER, { deliveryRef: 'PKG_ASSIGNED', pin: '000000' }); } catch (e) { c = code(e); }
    if (i < 6) ck('6.' + i + ' wrong attempt ' + i + '/5 is permission-denied', c === 'permission-denied', c);
    else ck('6.6 the 6th call (5 recorded wrong attempts) LOCKS with resource-exhausted', c === 'resource-exhausted', c);
  }

  const after = snap('packageRequests', 'PKG_ASSIGNED').data();
  ck('6.7 pickupVerifyAttempts reached 5', after.pickupVerifyAttempts === 5, after.pickupVerifyAttempts);
  ck('6.8 the UNRELATED deliveryVerifyAttempts counter was never touched by pickup attempts',
    after.deliveryVerifyAttempts === 3, after.deliveryVerifyAttempts);

  let cLocked;
  try { await complete(RIDER, { deliveryRef: 'PKG_ASSIGNED', pin: firstPin }); } catch (e) { cLocked = code(e); }
  ck('6.9 even the CORRECT pin is refused once locked', cLocked === 'resource-exhausted', cLocked);

  /* Reset the lockout for the success-path tests below — a fresh fixture, not a
     mutation of the locked one, so the lockout proof above stands untouched.
     The hash is deliveryRef-bound (by design — it's part of the HMAC input), so it
     must be computed fresh for THIS id rather than copied from PKG_ASSIGNED's. */
  const hmacCrypto = require('crypto');
  const pkg2Hash = hmacCrypto.createHmac('sha256', 'test-hmac-key').update('pickup|PKG_ASSIGNED2|' + firstPin).digest('hex');
  apply('packageRequests', 'PKG_ASSIGNED2', {
    orderId: 'ORD2', sellerUid: SELLER, status: 'driver_accepted', assignedDriverUid: RIDER, riderId: RIDER,
    handoverAuthorizedAt: 'TS', handoverAuthorizedBy: SELLER,
    pickupPinHash: pkg2Hash, pickupPinVersion: 6, pickupVerifyAttempts: 0,
  }, false);
}

/* ══ 7. completePickupWithPin — fails closed on a missing HMAC secret ═══════════ */
console.log('\n7. completePickupWithPin — fails closed, no fallback key (this gates a real transition)');
{
  hmacKeyAvailable = false;
  let c;
  try { await complete(RIDER, { deliveryRef: 'PKG_ASSIGNED2', pin: firstPin }); } catch (e) { c = code(e); }
  hmacKeyAvailable = true;
  ck('7.1 a missing secret refuses cleanly (failed-precondition), never crashes or falls back', c === 'failed-precondition', c);

  const after = snap('packageRequests', 'PKG_ASSIGNED2').data();
  ck('7.2 ...and does not advance the status while the key was unavailable', after.status !== 'picked_up', after.status);
}

/* ══ 8. completePickupWithPin — success, canonical status, no money touched ═════ */
console.log('\n8. completePickupWithPin — success advances to the EXISTING canonical `picked_up`');
{
  const r = await complete(RIDER, { deliveryRef: 'PKG_ASSIGNED2', pin: firstPin });
  ck('8.1 the correct pin succeeds', r && r.ok === true && r.alreadyAdvanced === false, JSON.stringify(r));

  const pkg = snap('packageRequests', 'PKG_ASSIGNED2').data();
  ck('8.2 packageRequests.status is the CANONICAL, pre-existing "picked_up" (nothing invented)', pkg.status === 'picked_up', pkg.status);
  ck('8.3 pickedUpAt is stamped', !!pkg.pickedUpAt);

  const ord = snap('orders', 'ORD2').data();
  ck('8.4 the order is mirrored to picked_up', ord.status === 'picked_up' && ord.deliveryStatus === 'picked_up');

  ck('8.5 no wallet collection exists anywhere in the store after this call', !DATA.wallets);
  ck('8.6 no walletTransactions collection exists anywhere in the store after this call', !DATA.walletTransactions);

  /* Replay — must be inert, must NOT re-stamp pickedUpAt. */
  const stampBefore = pkg.pickedUpAt;
  const r2 = await complete(RIDER, { deliveryRef: 'PKG_ASSIGNED2', pin: firstPin });
  ck('8.7 a replay with the same correct pin is inert (alreadyAdvanced), not an error', r2 && r2.alreadyAdvanced === true, JSON.stringify(r2));
  const pkgAfter = snap('packageRequests', 'PKG_ASSIGNED2').data();
  ck('8.8 ...and does not re-stamp pickedUpAt', pkgAfter.pickedUpAt === stampBefore);
}

/* ══ 9. completePickupWithPin — an order already further along is not regressed ═ */
console.log('\n9. completePickupWithPin — an order already past picked_up is left alone');
{
  /* PKG_FAR's order is already in_transit — index('in_transit') > index('picked_up').
     A correct-pin call must not drag it backward to picked_up. */
  const key = 'test-hmac-key';
  const crypto = require('crypto');
  const farHash = crypto.createHmac('sha256', key).update('pickup|PKG_FAR|555555').digest('hex');
  apply('packageRequests', 'PKG_FAR', { pickupPinHash: farHash, pickupVerifyAttempts: 0 }, true);

  const r = await complete(RIDER, { deliveryRef: 'PKG_FAR', pin: '555555' });
  ck('9.1 the pin still verifies correctly (hash matches)', r && r.ok === true, JSON.stringify(r));
  ck('9.2 ...but is reported alreadyAdvanced — the order is already past this stage', r && r.alreadyAdvanced === true, JSON.stringify(r));

  const pkg = snap('packageRequests', 'PKG_FAR').data();
  ck('9.3 status was NOT regressed back to picked_up', pkg.status === 'in_transit', pkg.status);
}

console.log('\n' + '='.repeat(70));
console.log('  ' + pass + '/' + (pass + fail) + ' checks passed.');
if (fail) console.log('  ' + fail + ' FAILURE(S).');
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('harness error:', e.stack || e.message); process.exit(2); });
