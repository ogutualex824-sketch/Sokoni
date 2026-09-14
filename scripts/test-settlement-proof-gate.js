#!/usr/bin/env node
/* The settlement proof gate — the buyer's PIN is what releases the money.
 *
 *   node scripts/test-settlement-proof-gate.js
 *
 * THE SEQUENCE (owner ruling, 2026-09-07)
 *
 *   buyer buys        -> a PIN is issued WITH the order          (buyer holds it)
 *   seller accepts    -> a SECOND, independent code is issued    (starts the delivery leg)
 *   rider collects    -> that code is entered  -> in transit     (releases NO money)
 *   rider arrives     -> the BUYER's PIN is entered -> delivered -> THE MONEY SPLITS
 *
 * Two secrets, two events. The pickup code proves the goods left the shop; the buyer's PIN
 * proves they arrived. Only the second one moves money.
 *
 * WHAT WAS BROKEN
 * `delivery-complete.js` recorded `deliveryAuthorizedBy` when the buyer's PIN was entered —
 * and `order-settlement.js` never read it. The seller was credited on the order reaching a
 * settle-able state, whether or not anyone could show the goods had been handed over. The
 * PIN existed, was secured, and authorised nothing.
 *
 * THE HOLD IS NOT A REFUSAL. An unproven delivery order is HELD with
 * `settlementNote: 'awaiting_delivery_proof'` and settles on the next pass once proof lands.
 * A permanent block would strand real money belonging to a seller who did nothing wrong.
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label +
    (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 160) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── Load order-settlement with the runtime stubbed ──────────────────────── */
const FV = {
  serverTimestamp: () => 'TS',
  increment: (n) => ({ __inc: n }),
};
/* Timestamp is load-bearing: finos-utils reads admin.firestore.Timestamp.now() for the
   commission-holiday window. Omitting it crashes inside calculateCommission, which is
   reached BEFORE the gate — so the suite would die without testing anything. */
const adminSdk = { firestore: Object.assign(() => ({}), {
  FieldValue: FV,
  Timestamp: { now: () => ({ toMillis: () => Date.now() }) },
}) };

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') return adminSdk;
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error {} };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => '0' }) };
  return orig.apply(this, arguments);
};
const OS = require(path.join(FN, 'order-settlement.js'));
Module.prototype.require = orig;

const settleOrder = OS.settleOrder || (OS._h && OS._h.settleOrder);

/* ── In-memory Firestore with a transaction ──────────────────────────────── */
function makeDb(seed = {}) {
  const docs = new Map(Object.entries(seed));
  const emptyQ = { empty: true, docs: [], forEach() {} };
  const coll = (name) => ({
    doc(id) {
      const key = name + '/' + id;
      return {
        _key: key, id,
        async get() {
          const d = docs.get(key);
          return { exists: !!d, id, data: () => (d ? Object.assign({}, d) : undefined) };
        },
        async set(v) { docs.set(key, Object.assign({}, v)); },
      };
    },
    where() { return this; },
    limit() { return this; },
    async get() { return emptyQ; },
  });
  return {
    _docs: docs,
    collection: coll,
    async runTransaction(fn) {
      const writes = [];
      const t = {
        async get(ref) { return ref.get(); },
        set(ref, v) { writes.push([ref._key, v, false]); },
        update(ref, v) { writes.push([ref._key, v, true]); },
      };
      const out = await fn(t);
      for (const [key, v, merge] of writes) {
        docs.set(key, merge ? Object.assign({}, docs.get(key) || {}, v) : Object.assign({}, v));
      }
      return out;
    },
  };
}

const SELLER = 'SELLER_A_uid_7f3';
const RIDER  = 'RIDER_Z_uid_442';
const ORDER  = 'SKN_TEST_0001';

const deliveryOrder = (over = {}) => Object.assign({
  sellerUid: SELLER, status: 'completed', settlementStatus: 'ELIGIBLE_FOR_SETTLEMENT',
  orderTotal: 10200, deliveryFee: 200,
  assignedDriverUid: RIDER, deliveryAddress: 'Ngong Road, Nairobi',
  escrow: { held: 1000000, released: 0 },
}, over);

const seed = (order) => ({ ['orders/' + ORDER]: order });

(async () => {

ck('S0  settleOrder is reachable from the module (the suite can see)', typeof settleOrder === 'function');
if (typeof settleOrder !== 'function') {
  console.log('\nCANNOT PROCEED — settleOrder is not exported. Refusing to report vacuous results.\n');
  process.exit(1);
}

console.log('\nPART A — an unproven delivery does NOT release money\n');
{
  const db = makeDb(seed(deliveryOrder()));
  const res = await settleOrder(db, adminSdk, ORDER);
  ck('A1  a delivery order with no proof is NOT settled',
    res.outcome === 'awaiting-delivery-proof', res.outcome);
  const o = db._docs.get('orders/' + ORDER);
  ck('A2  ...it is HELD, not failed', o.settlementStatus === 'HELD', o.settlementStatus);
  ck('A3  ...and says why, in a queryable field',
    o.settlementNote === 'awaiting_delivery_proof', o.settlementNote);
  ck('A4  ...the seller wallet is NOT credited', !db._docs.has('wallets/' + SELLER));
  ck('A5  ...no settlement record is written', !db._docs.has('settlements/' + ORDER));
  ck('A6  ...and the escrow is NOT released', (o.escrow || {}).released === 0,
    String((o.escrow || {}).released));
}

console.log('\nPART B — the buyer\'s PIN releases it\n');
for (const method of ['rider_pin', 'buyer_confirmation']) {
  const db = makeDb(seed(deliveryOrder({ deliveryAuthorizedBy: method, deliveredAt: 1757000000000 })));
  const res = await settleOrder(db, adminSdk, ORDER);
  ck(`B1  proof by "${method}" settles the order`, res.outcome === 'settled', res.outcome);
  const s = db._docs.get('settlements/' + ORDER);
  ck(`B2  ...and the settlement RECORDS what authorised it`,
    !!s && s.deliveryProof === method, s && s.deliveryProof);
  ck(`B3  ...the seller is credited`, db._docs.has('wallets/' + SELLER));
}
{
  /* THE HOLD IS NOT TERMINAL — the whole point. Held, then proof lands, then it settles. */
  const db = makeDb(seed(deliveryOrder()));
  const first = await settleOrder(db, adminSdk, ORDER);
  ck('B4  first pass holds', first.outcome === 'awaiting-delivery-proof', first.outcome);

  /* The buyer enters their PIN; delivery-complete.js stamps the order. */
  const o = db._docs.get('orders/' + ORDER);
  db._docs.set('orders/' + ORDER, Object.assign({}, o, {
    deliveryAuthorizedBy: 'rider_pin', deliveredAt: 1757000000000,
    settlementStatus: 'ELIGIBLE_FOR_SETTLEMENT',
  }));

  const second = await settleOrder(db, adminSdk, ORDER);
  ck('B5  the SAME order settles once proof arrives — the hold was a wait, not a refusal',
    second.outcome === 'settled', second.outcome);
  ck('B6  ...and no money was stranded', db._docs.has('wallets/' + SELLER));
}

console.log('\nPART C — orders with nothing to prove still settle, and say so\n');
{
  const db = makeDb(seed({
    sellerUid: SELLER, status: 'completed', settlementStatus: 'ELIGIBLE_FOR_SETTLEMENT',
    orderTotal: 5000, deliveryFee: 0, fulfilmentType: 'pickup',
    escrow: { held: 500000, released: 0 },
  }));
  const res = await settleOrder(db, adminSdk, ORDER);
  ck('C1  a pickup order settles without delivery proof', res.outcome === 'settled', res.outcome);
  const s = db._docs.get('settlements/' + ORDER);
  ck('C2  ...recorded as not_required, never silently exempt',
    !!s && s.deliveryProof === 'not_required', s && s.deliveryProof);
}
{
  /* A digital/no-delivery order: no rider, no fee, no address. */
  const db = makeDb(seed({
    sellerUid: SELLER, status: 'completed', settlementStatus: 'ELIGIBLE_FOR_SETTLEMENT',
    orderTotal: 5000, escrow: { held: 500000, released: 0 },
  }));
  const res = await settleOrder(db, adminSdk, ORDER);
  ck('C3  an order with no delivery at all settles', res.outcome === 'settled', res.outcome);
}

console.log('\nPART D — the gate cannot be talked around\n');
{
  /* A delivery is recognised from ANY of its markers — guessing "not a delivery" is the
     failure that releases money early, so the ambiguous case requires proof. */
  const markers = [
    ['an assigned rider',   { assignedDriverUid: RIDER }],
    ['a legacy riderId',    { riderId: RIDER }],
    ['a delivery reference',{ deliveryRef: 'DEL-ABC' }],
    ['a delivery fee',      { deliveryFee: 150 }],
    ['a delivery address',  { deliveryAddress: 'Kilimani' }],
  ];
  for (const [label, marker] of markers) {
    const db = makeDb(seed(Object.assign({
      sellerUid: SELLER, status: 'completed', settlementStatus: 'ELIGIBLE_FOR_SETTLEMENT',
      orderTotal: 5000, escrow: { held: 500000, released: 0 },
    }, marker)));
    const res = await settleOrder(db, adminSdk, ORDER);
    ck('D1  ' + label + ' makes it a delivery -> proof required',
      res.outcome === 'awaiting-delivery-proof', res.outcome);
  }
}
{
  /* Only the two witnessed methods count. A truthy string is not a proof. */
  for (const forged of ['true', 'yes', 'rider', 'admin_override', 'pickup_code', '1']) {
    const db = makeDb(seed(deliveryOrder({ deliveryAuthorizedBy: forged })));
    const res = await settleOrder(db, adminSdk, ORDER);
    ck(`D2  "${forged}" is NOT accepted as delivery proof`,
      res.outcome === 'awaiting-delivery-proof', res.outcome);
  }
}
{
  /* The PICKUP code must not release money. It proves the goods left the shop, not that
     they arrived — memory records this explicitly as K11: "Pickup releases NO money". */
  const db = makeDb(seed(deliveryOrder({
    pickupAuthorizedBy: 'seller_handover', pickupAuthorizedAt: 1757000000000,
  })));
  const res = await settleOrder(db, adminSdk, ORDER);
  ck('D3  a completed PICKUP handover alone does NOT release the money',
    res.outcome === 'awaiting-delivery-proof', res.outcome);
}

console.log('\nPART E — proof is read INSIDE the transaction\n');
{
  /* Proof can land between the pre-read and the transaction. A gate reading the stale
     pre-read would hold an order that is already proven. */
  const fs = require('fs');
  const src = fs.readFileSync(path.join(FN, 'order-settlement.js'), 'utf8');
  const txIdx = src.indexOf('runTransaction');
  /* Anchor on the CALL SITE, not the substring — `function _isDeliveryOrder(o) {` contains
     the same text and sits near the top of the file, so indexOf() found the DEFINITION and
     the assertion was measuring nothing. */
  const gateIdx = src.indexOf('const isDelivery = _isDeliveryOrder(o);');
  ck('E1  the gate is evaluated inside runTransaction, on the transaction\'s own snapshot',
    txIdx !== -1 && gateIdx !== -1 && gateIdx > txIdx,
    'tx@' + txIdx + ' gate@' + gateIdx);
  ck('E2  ...and reads `o`, the in-transaction snapshot, not the pre-read `order`',
    /const isDelivery = _isDeliveryOrder\(o\);/.test(src));
}

console.log('\nPART F — adversarial controls\n');
{
  /* If the harness could not settle ANYTHING, every "held" assertion would be vacuous. */
  const db = makeDb(seed(deliveryOrder({ deliveryAuthorizedBy: 'rider_pin' })));
  const res = await settleOrder(db, adminSdk, ORDER);
  ck('F1  the harness CAN reach a settled outcome', res.outcome === 'settled', res.outcome);

  /* And it must be able to produce a hold, or every "settled" assertion is vacuous. */
  const db2 = makeDb(seed(deliveryOrder()));
  const res2 = await settleOrder(db2, adminSdk, ORDER);
  ck('F2  ...and a held outcome, from the same fixture minus the proof',
    res2.outcome === 'awaiting-delivery-proof', res2.outcome);

  /* An already-settled order must stay settled — the gate must not re-hold it. */
  const db3 = makeDb(seed(deliveryOrder({ settlementStatus: 'SETTLED' })));
  const res3 = await settleOrder(db3, adminSdk, ORDER);
  ck('F3  an already-settled order is not re-held by the gate',
    res3.outcome === 'already-settled', res3.outcome);

  /* A refunded order must not be held awaiting proof it will never get. */
  const db4 = makeDb(seed(deliveryOrder({ settlementStatus: 'REFUNDED' })));
  const res4 = await settleOrder(db4, adminSdk, ORDER);
  ck('F4  a refunded order is not held awaiting proof', res4.outcome === 'refunded-skip', res4.outcome);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
