#!/usr/bin/env node
/* Exercises the REAL functions/reviews.js submitReview path against a mocked
   Firestore, so canonicalisation is proven rather than assumed.

   Fixture models the two id spaces that caused the defect:
     shops/UID_KASS          — uid-keyed shop           (canonical)
     sellers/UID_KASS        — uid-keyed seller         (canonical)
     businesses/MERCH_KASS   — merchantId-keyed, uid -> UID_KASS  (indirect)
   "Kass Store" is a DISPLAY NAME and exists in no collection — it must be rejected.
*/
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');

/* ── fixture ─────────────────────────────────────────────────────────────── */
const DOCS = {
  'shops/UID_KASS':        { name: 'Kass Store' },
  'sellers/UID_KASS':      { storeName: 'Kass Store' },
  'businesses/MERCH_KASS': { uid: 'UID_KASS', name: 'Kass Store' },
  'businesses/MERCH_ORPHAN': { name: 'No Owner Ltd' },       // exists, no owner link
  'products/PROD_1':       { title: 'Thing' },
  'users/BUYER_1':         { createdAt: { toMillis: () => 0 } },
  /* 2026-09-29: product reviews are verified-purchase only (test-trust-integrity.js RV1–RV5) — the reviewer has a
     delivered order of PROD_1, so this case still asserts what it is about: the canonical target id. */
  'orders/ORD_1':          { buyerUid: 'BUYER_1', status: 'delivered', items: [{ productId: 'PROD_1' }] },
};

const writes = {};
function mkDoc(col, id) {
  const key = col + '/' + id;
  return {
    id,
    get: async () => ({ exists: Object.hasOwn(DOCS, key), id, data: () => DOCS[key] }),
    set: async (d) => { writes[key] = d; },
    update: async (d) => { writes[key] = Object.assign(writes[key] || {}, d); },
  };
}
function mkQuery(col) {
  /* 2026-09-29: equality `where`s answer from the fixture (the verified-purchase lookup queries orders by buyerUid);
     every other collection still has no rows, as before. */
  const eq = [];
  const q = {
    where: (f, op, v) => { if (op === '==') eq.push([f, v]); return q; }, orderBy: () => q, limit: () => q, startAfter: () => q,
    get: async () => {
      const docs = col !== 'orders' ? [] : Object.keys(DOCS).filter((k) => k.startsWith('orders/'))
        .filter((k) => eq.every(([f, v]) => DOCS[k][f] === v))
        .map((k) => ({ id: k.slice(7), data: () => DOCS[k], exists: true }));
      return { empty: !docs.length, size: docs.length, docs, forEach(fn) { docs.forEach(fn); } };
    },
  };
  return q;
}
function mkCollection(col) {
  const c = mkQuery(col);
  c.doc = (id) => mkDoc(col, id || ('AUTOID_' + col));
  return c;
}

const firestoreStub = () => ({
  collection: mkCollection,
  runTransaction: async (fn) => fn({
    get: async () => ({ exists: false, data: () => ({}) }),
    set: () => {}, update: () => {},
  }),
});
firestoreStub.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => n };
firestoreStub.Timestamp = {
  fromDate: (d) => ({ toDate: () => d, toMillis: () => d.getTime() }),
  now: () => ({ toDate: () => new Date(0), toMillis: () => 0 }),
};

/* ── module mocks ────────────────────────────────────────────────────────── */
const Module = require('module');
const realResolve = Module._resolveFilename;
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'firebase-admin') {
    return { firestore: firestoreStub };
  }
  if (req === 'firebase-functions/v2/https') {
    class HttpsError extends Error {
      constructor(code, msg) { super(msg); this.code = code; }
    }
    return { onCall: (_opts, handler) => handler, HttpsError };
  }
  return realLoad.apply(this, arguments);
};

const reviews = require(path.join(ROOT, 'functions/reviews.js'));
Module._load = realLoad;

/* ── run ─────────────────────────────────────────────────────────────────── */
const AUTH = { uid: 'BUYER_1', token: {} };
const base = { rating: 5, title: 'Great', body: 'Really good service here, recommended.' };

const CASES = [
  ['uid (canonical, shops/sellers)', 'seller', 'UID_KASS',      'UID_KASS'],
  ['businesses/{merchantId}',        'seller', 'MERCH_KASS',    'UID_KASS'],
  ['DISPLAY NAME',                   'seller', 'Kass Store',    null],
  ['unknown id',                     'seller', 'DOES_NOT_EXIST',null],
  ['business with no owner link',    'seller', 'MERCH_ORPHAN',  null],
  ['product (canonical)',            'product','PROD_1',        'PROD_1'],
  ['product that does not exist',    'product','PROD_NOPE',     null],
  ['unsupported targetType',         'platform','sokoni',       null],
];

(async () => {
  console.log('CASE'.padEnd(34), 'INPUT'.padEnd(16), 'STORED targetId'.padEnd(18), 'VERDICT');
  console.log('-'.repeat(92));
  let pass = 0, fail = 0;
  for (const [label, targetType, targetId, expected] of CASES) {
    for (const k of Object.keys(writes)) delete writes[k];
    let stored = null, err = null;
    try {
      await reviews.submitReview({ auth: AUTH, data: { ...base, targetType, targetId } });
      const rk = Object.keys(writes).find(k => k.startsWith('reviews/'));
      stored = rk ? writes[rk].targetId : '(no write)';
    } catch (e) {
      err = e.code ? `${e.code}` : e.message.slice(0, 30);
      if (!global.__shown) {
        global.__shown = 1;
        console.error('FIRST STACK:\n' + e.stack.split('\n').slice(0, 7).join('\n') + '\n');
      }
    }

    const ok = expected === null ? (err !== null && stored === null)
                                 : (stored === expected && !err);
    ok ? pass++ : fail++;
    console.log(
      label.padEnd(34), String(targetId).slice(0, 15).padEnd(16),
      String(stored === null ? 'REJECTED(' + err + ')' : stored).padEnd(18),
      ok ? 'PASS' : `FAIL (expected ${expected})`
    );
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
