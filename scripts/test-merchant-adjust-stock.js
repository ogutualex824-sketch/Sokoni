/* merchantAdjustStock — authority, idempotency, ownership.
 *
 *   node scripts/test-merchant-adjust-stock.js
 *
 * WHY THIS EXISTS
 * This is the FIRST server authority over a correction to canonical
 * `products.stock`. Everything it guarantees is a guarantee only while these
 * hold, and every one of them is a property a client cannot be trusted with:
 *
 *   · a caller may not move another seller's stock
 *   · a replayed adjustmentId must not move stock twice
 *   · a correction must never look like a SALE (`sold` untouched)
 *   · stock and inventoryVersion must move together, atomically
 *
 * The transaction is exercised against an in-memory Firestore double rather
 * than the emulator, so the suite runs in the predeploy chain with no external
 * service. The double models only what the function uses: get/update/set inside
 * runTransaction, and it records every write so a test can assert what did NOT
 * happen — which is most of what matters here.
 */
'use strict';

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).replace(/\s+/g, ' ').slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── Firestore double ──────────────────────────────────────────────────────── */
function makeDb (docs) {
  const store  = new Map(Object.entries(docs));
  const writes = [];
  const ref = (path) => ({
    path,
    get _d () { return store.get(path); },
  });
  const col = (c) => ({ doc: (id) => ref(c + '/' + id) });

  const tx = {
    get: async (r) => ({
      exists: store.has(r.path),
      data: () => store.get(r.path),
    }),
    update: (r, patch) => {
      writes.push({ op: 'update', path: r.path, patch });
      store.set(r.path, Object.assign({}, store.get(r.path), patch));
    },
    set: (r, val) => {
      writes.push({ op: 'set', path: r.path, val });
      store.set(r.path, val);
    },
  };

  return {
    collection: col,
    runTransaction: async (fn) => fn(tx),
    _store: store,
    _writes: writes,
  };
}

/* Load the module with firebase-admin/functions stubbed, so requiring it does
   not need credentials or a deployed app. */
function loadFn ({ db, adminRole }) {
  const Module = require('module');
  const orig = Module.prototype.require;
  const captured = {};

  Module.prototype.require = function (id) {
    if (id === 'firebase-functions/v2/https') {
      return {
        HttpsError: class HttpsError extends Error {
          constructor (code, message) { super(message); this.code = code; }
        },
        onCall: (_opts, handler) => { captured.handler = handler; return handler; },
      };
    }
    if (id === 'firebase-admin/firestore') {
      return { getFirestore: () => db, FieldValue: { serverTimestamp: () => '__ts__' } };
    }
    if (id === 'firebase-admin') {
      return { auth: () => ({ getUser: async () => ({ customClaims: adminRole ? { role: adminRole } : {} }) }) };
    }
    if (id === 'firebase-functions/logger') return { info: () => {}, warn: () => {}, error: () => {} };
    return orig.apply(this, arguments);
  };

  delete require.cache[require.resolve('../functions/merchant-inventory.js')];
  const mod = require('../functions/merchant-inventory.js');
  Module.prototype.require = orig;
  return { mod, handler: captured.handler };
}

const PRODUCT = () => ({
  name: 'Sukari 1kg', sellerUid: 'seller-A', shopId: 'shop-A',
  stock: 10, sold: 42, inventoryVersion: 7,
});

async function call (data, opts = {}) {
  const db = opts.db || makeDb({ 'products/p1': PRODUCT() });
  const { handler } = loadFn({ db, adminRole: opts.adminRole });
  const req = { auth: opts.uid === null ? null : { uid: opts.uid || 'seller-A' }, data };
  try {
    const res = await handler(req);
    return { ok: true, res, db };
  } catch (e) {
    return { ok: false, code: e.code, message: e.message, db };
  }
}

const VALID = { productId: 'p1', shopId: 'shop-A', adjustmentId: 'adj-1', delta: -3, reason: 'damage' };

(async () => {
  console.log('\nmerchantAdjustStock — server authority over canonical products.stock\n');

  /* ── happy path ── */
  {
    const r = await call({ ...VALID });
    const prod = r.db._store.get('products/p1');
    ck('authorized seller + valid adjustment → succeeds', r.ok, r.ok ? '' : r.message);
    ck('stock changes transactionally', prod && prod.stock === 7, 'stock=' + (prod && prod.stock));
    ck('inventoryVersion advances', prod && prod.inventoryVersion === 8, 'v=' + (prod && prod.inventoryVersion));
    ck('sold is UNCHANGED — a correction is not a sale', prod && prod.sold === 42, 'sold=' + (prod && prod.sold));
    const upd = r.db._writes.find(w => w.op === 'update');
    ck('sold is not even written', upd && !('sold' in upd.patch), Object.keys(upd ? upd.patch : {}).join(','));
    ck('stock + version + updatedAt move together', upd && 'stock' in upd.patch && 'inventoryVersion' in upd.patch && 'updatedAt' in upd.patch);
    const mv = r.db._store.get('stockMovements/adj-1');
    ck('movement recorded with reason', mv && mv.reason === 'damage' && mv.before === 10 && mv.after === 7);
  }

  /* ── ownership ── */
  {
    const r = await call({ ...VALID }, { uid: 'seller-B' });
    const prod = r.db._store.get('products/p1');
    ck('wrong seller → rejected', !r.ok && r.code === 'permission-denied', r.code);
    ck('wrong seller → stock UNCHANGED', prod.stock === 10, 'stock=' + prod.stock);
    ck('wrong seller → no movement written', !r.db._store.has('stockMovements/adj-1'));
  }
  {
    const r = await call({ ...VALID, shopId: 'shop-OTHER' });
    ck('mismatched shopId → rejected', !r.ok && r.code === 'permission-denied', r.code);
    ck('mismatched shopId → stock unchanged', r.db._store.get('products/p1').stock === 10);
  }
  {
    const r = await call({ ...VALID }, { uid: 'someone-else', adminRole: 'admin' });
    ck('platform admin may correct any product', r.ok, r.ok ? '' : r.message);
  }
  {
    const r = await call({ ...VALID }, { uid: null });
    ck('unauthenticated → rejected', !r.ok && r.code === 'unauthenticated', r.code);
  }

  /* ── idempotency ── */
  {
    const db = makeDb({ 'products/p1': PRODUCT() });
    const a = await call({ ...VALID }, { db });
    const b = await call({ ...VALID }, { db });
    const prod = db._store.get('products/p1');
    ck('duplicate adjustmentId → second call succeeds', a.ok && b.ok);
    ck('duplicate adjustmentId → flagged idempotent', b.res && b.res.idempotent === true, JSON.stringify(b.res));
    ck('duplicate adjustmentId → stock moved ONCE', prod.stock === 7, 'stock=' + prod.stock);
    ck('duplicate adjustmentId → version advanced ONCE', prod.inventoryVersion === 8, 'v=' + prod.inventoryVersion);
    ck('duplicate adjustmentId → no second product write',
       db._writes.filter(w => w.op === 'update' && w.path === 'products/p1').length === 1,
       db._writes.filter(w => w.op === 'update').length + ' update(s)');
  }

  /* ── validation ── */
  const bad = [
    ['missing adjustmentId',   { ...VALID, adjustmentId: '' }],
    ['missing productId',      { ...VALID, productId: '' }],
    ['missing shopId',         { ...VALID, shopId: '' }],
    ['zero delta',             { ...VALID, delta: 0 }],
    ['non-integer delta',      { ...VALID, delta: 1.5 }],
    ['out-of-range delta',     { ...VALID, delta: 2000000 }],
    ['invalid reason',         { ...VALID, reason: 'because' }],
    ['missing reason',         { ...VALID, reason: '' }],
  ];
  for (const [label, data] of bad) {
    const r = await call(data);
    ck(label + ' → rejected', !r.ok && r.code === 'invalid-argument', r.code || 'accepted!');
    ck(label + ' → stock untouched', r.db._store.get('products/p1').stock === 10);
  }

  /* ── floor ── */
  {
    const r = await call({ ...VALID, delta: -50, adjustmentId: 'adj-floor' });
    ck('correction below zero → rejected', !r.ok && r.code === 'failed-precondition', r.code);
    ck('correction below zero → stock unchanged', r.db._store.get('products/p1').stock === 10);
  }
  {
    const r = await call({ ...VALID, delta: 5, reason: 'restock', adjustmentId: 'adj-in' });
    ck('positive restock applies', r.ok && r.db._store.get('products/p1').stock === 15,
       'stock=' + r.db._store.get('products/p1').stock);
  }

  /* ── missing product ── */
  {
    const r = await call({ ...VALID }, { db: makeDb({}) });
    ck('unknown product → not-found', !r.ok && r.code === 'not-found', r.code);
  }

  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
