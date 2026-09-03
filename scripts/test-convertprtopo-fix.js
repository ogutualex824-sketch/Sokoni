#!/usr/bin/env node
/**
 * test-convertprtopo-fix.js — certifies the convertPRtoPO fix (inventory.html) end to end.
 *
 * convertPRtoPO used to call SokoniInventory.createPurchaseOrder(poData) — a method that does
 * not exist (see docs/CREATEPURCHASEORDER_CLIENT_DEFECT_TRACE.md). Fixed to route through the
 * canonical httpsCallable('createPurchaseOrder') — functions/procurement.js, procPurchaseOrders —
 * matching the already-working sibling submitPO() on the same page.
 *
 * Two halves:
 *   STATIC   — the page calls the right thing, in the right function, and never the wrong thing.
 *   EXECUTED — the fixed payload shape is actually accepted by the real createPurchaseOrder
 *              (stubbed firebase-admin/functions, an applying in-memory Firestore, no network),
 *              and the properties the fix is supposed to preserve actually hold: merchant/supplier
 *              validation, VAT computation, and — checked rather than assumed — idempotency.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

/* ══════════════════════════════════════════════════════════════════════════
   STATIC — inventory.html source
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\nconvertPRtoPO fix — static checks (inventory.html)\n');

/* Strip comments before asserting — the fix's own explanatory comment names the broken call
   verbatim (documenting what it used to be), which would otherwise false-positive a naive
   substring search. Same convention scripts/test-procurement.js already uses. */
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const inv = strip(fs.readFileSync(path.join(ROOT, 'inventory.html'), 'utf8'));

/* Isolate convertPRtoPO's own function body, not the whole page — submitPO already calls
   createPurchaseOrder correctly, so a page-wide regex would pass even if convertPRtoPO itself
   were never touched. */
const fnMatch = inv.match(/async function convertPRtoPO\(id\) \{[\s\S]*?\n\}/);
if (!fnMatch) {
  bad('convertPRtoPO function not found in inventory.html at all');
} else {
  const body = fnMatch[0];
  /httpsCallable\(['"]createPurchaseOrder['"]\)/.test(body)
    ? ok('convertPRtoPO calls httpsCallable(\'createPurchaseOrder\') — the canonical procurement backend')
    : bad('convertPRtoPO does not call the canonical createPurchaseOrder callable');

  /merchantId/.test(body)
    ? ok('convertPRtoPO resolves and sends merchantId — the callable requires it')
    : bad('convertPRtoPO still omits merchantId from the payload');

  /unitCost/.test(body)
    ? ok('convertPRtoPO remaps requisition items to the {..., unitCost} shape the validator expects')
    : bad('convertPRtoPO still sends the requisition\'s raw costPrice field, which _validateItems does not read');

  !/SokoniInventory\.createPurchaseOrder\(/.test(body)
    ? ok('the broken SokoniInventory.createPurchaseOrder( call is gone from convertPRtoPO')
    : bad('convertPRtoPO still calls the nonexistent SokoniInventory.createPurchaseOrder(');

  !/SokoniInventory\.createPO\(/.test(body)
    ? ok('convertPRtoPO never calls SokoniInventory.createPO — the client-only inventory_purchaseOrders path')
    : bad('convertPRtoPO reintroduces the orphaned client-only createPO() path');
}

/* Page-wide converse check, independent of the function-scoped one above: the exact broken call
   string must not exist ANYWHERE, not just outside convertPRtoPO. */
!/SokoniInventory\.createPurchaseOrder\(/.test(inv)
  ? ok('SokoniInventory.createPurchaseOrder( does not appear anywhere on the page (page-wide converse check)')
  : bad('SokoniInventory.createPurchaseOrder( still appears somewhere on the page');

/* ══════════════════════════════════════════════════════════════════════════
   EXECUTED — the fixed payload shape against the real createPurchaseOrder
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\nconvertPRtoPO fix — executed against the real createPurchaseOrder\n');

class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
function stub(id, exportsObj) {
  let r; try { r = require.resolve(id, { paths: [FN] }); } catch (e) { r = id; }
  const m = new Module(r, null); m.filename = r; m.loaded = true; m.exports = exportsObj;
  require.cache[r] = m;
}
stub('firebase-functions/v2/https', { onCall: (_o, h) => h, HttpsError });
stub('firebase-functions/v2/scheduler', { onSchedule: (_o, h) => h });
stub('firebase-functions/logger', { info() {}, warn() {}, error() {}, debug() {} });
stub('./email-service', { queue: async () => ({}) });
stub('./notify', { send: async () => ({}), notify: async () => ({}) });
stub('./po-pdf', { buildPoPdf: async () => Buffer.from('%PDF') });

/* ── an applying in-memory Firestore, transaction-capable ───────────────────── */
const STORE = new Map();
function apply(k, data, merge) {
  const prev = merge && STORE.has(k) ? Object.assign({}, STORE.get(k)) : {};
  const out = merge ? prev : {};
  Object.keys(data).forEach((f) => { out[f] = data[f]; });
  STORE.set(k, out);
}
function docRef(coll, id) {
  const k = coll + '/' + id;
  return {
    _k: k, id,
    async get() { return STORE.has(k) ? { exists: true, id, data: () => STORE.get(k) } : { exists: false, id, data: () => undefined }; },
    async set(d, o) { apply(k, d, !!(o && o.merge)); },
    async update(d) { apply(k, d, true); },
  };
}
function colRef(coll) {
  return { doc: (id) => docRef(coll, id === undefined ? 'auto_' + Math.random().toString(36).slice(2, 8) : id) };
}
const db = {
  collection: (c) => colRef(c),
  async runTransaction(fn) {
    const ops = [];
    const r = await fn({
      get: (ref) => ref.get(),
      set: (ref, d, o) => ops.push([ref._k, d, !!(o && o.merge)]),
      update: (ref, d) => ops.push([ref._k, d, true]),
    });
    ops.forEach(([k, d, m]) => apply(k, d, m));
    return r;
  },
};
stub('firebase-admin', {
  apps: [{}], initializeApp: () => {},
  firestore: Object.assign(() => db, {
    FieldValue: { serverTimestamp: () => ({ __ts: 1 }) },
  }),
});

const PROC = require(path.join(FN, 'procurement.js'));

function reset() { STORE.clear(); }
function seedSupplier(id, merchantId, status) {
  STORE.set('procSuppliers/' + id, { merchantId, name: 'Test Supplier', status: status || 'active' });
}
const req = (uid, data) => ({ auth: uid ? { uid } : null, data });

/* the EXACT shape the fixed client now sends — items already remapped to {productId,sku,name,qty,unitCost} */
function fixedPayload(overrides) {
  return Object.assign({
    merchantId: 'merch1',
    supplierId: 'sup1',
    expectedDelivery: null,
    notes: 'from requisition',
    items: [{ productId: 'p1', sku: '', name: 'Widget', qty: 3, unitCost: 100 }],
  }, overrides || {});
}

(async () => {
  /* 1. The fixed payload shape succeeds and creates a real procPurchaseOrders document. */
  reset(); seedSupplier('sup1', 'merch1');
  const r1 = await PROC.createPurchaseOrder(req('uid1', fixedPayload()));
  ok_assert('conversion succeeds with the fixed payload shape', !!(r1 && r1.poId));
  const created = STORE.get('procPurchaseOrders/' + r1.poId);
  ok_assert('a real procPurchaseOrders document is created', !!created);
  ok_assert('the created document is in the correct collection with the correct merchant', created && created.merchantId === 'merch1');

  /* 2. VAT is computed server-side, not trusted from the client (the client sends no VAT figures at all). */
  ok_assert('subtotal is server-computed (3 x 100 = 300)', created && created.subtotal === 300);
  ok_assert('VAT is server-computed at 16%% (48)', created && created.vatAmount === 48);
  ok_assert('total is server-computed (348)', created && created.total === 348);

  /* 3. Missing/invalid merchant authority is denied. */
  reset(); seedSupplier('sup1', 'merch1');
  try { await PROC.createPurchaseOrder(req('uid1', fixedPayload({ merchantId: undefined }))); ok_assert('missing merchantId is DENIED', false); }
  catch (e) { ok_assert('missing merchantId is DENIED', e.code === 'invalid-argument'); }

  /* 4. Supplier mismatch — existing validation still fires, unmodified by this client fix. */
  reset(); seedSupplier('sup1', 'someOtherMerchant');
  try { await PROC.createPurchaseOrder(req('uid1', fixedPayload())); ok_assert('a supplier belonging to a DIFFERENT merchant is DENIED', false); }
  catch (e) { ok_assert('a supplier belonging to a DIFFERENT merchant is DENIED', e.code === 'permission-denied'); }

  reset(); seedSupplier('sup1', 'merch1', 'inactive');
  try { await PROC.createPurchaseOrder(req('uid1', fixedPayload())); ok_assert('an INACTIVE supplier is DENIED', false); }
  catch (e) { ok_assert('an INACTIVE supplier is DENIED', e.code === 'invalid-argument'); }

  reset(); /* no supplier seeded at all */
  try { await PROC.createPurchaseOrder(req('uid1', fixedPayload())); ok_assert('an UNKNOWN supplier is DENIED', false); }
  catch (e) { ok_assert('an UNKNOWN supplier is DENIED', e.code === 'not-found'); }

  /* 5. Proves WHY the remap was necessary: the requisition's raw (unfixed) item shape is rejected. */
  reset(); seedSupplier('sup1', 'merch1');
  const rawRequisitionShape = { merchantId: 'merch1', supplierId: 'sup1',
    items: [{ productId: 'p1', productName: 'Widget', qty: 3, costPrice: 100 }] }; /* costPrice, not unitCost */
  try { await PROC.createPurchaseOrder(req('uid1', rawRequisitionShape)); ok_assert('the UNFIXED requisition item shape (costPrice, no unitCost) is REJECTED — proves the remap is required, not optional', false); }
  catch (e) { ok_assert('the UNFIXED requisition item shape (costPrice, no unitCost) is REJECTED — proves the remap is required, not optional', /unitCost/.test(e.message)); }

  /* 6. Idempotency — checked, not assumed. The comment claims "prevents duplicates on client
        retry", but the seed includes Date.now(), which differs on a real retry. */
  reset(); seedSupplier('sup1', 'merch1');
  const realNow = Date.now;
  try {
    Date.now = () => 1700000000000;
    const a = await PROC.createPurchaseOrder(req('uid1', fixedPayload()));
    const b = await PROC.createPurchaseOrder(req('uid1', fixedPayload()));
    ok_assert('SAME millisecond -> same poId (the mechanism the code implements)', a.poId === b.poId);

    Date.now = () => 1700000000001; /* +1ms, simulating a real retry a moment later */
    const c = await PROC.createPurchaseOrder(req('uid1', fixedPayload()));
    ok_assert('a DIFFERENT millisecond (a realistic client retry) -> a DIFFERENT poId — the "prevents duplicates on client retry" comment does not hold for a real retry, only for two calls landing in the exact same millisecond', a.poId !== c.poId);
  } finally { Date.now = realNow; }

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed.');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S).'); process.exit(1); }
  console.log('\n  PASS — convertPRtoPO fix certified: static + executed against the real createPurchaseOrder.');
})().catch((e) => { console.error('harness error:', e.stack || e.message); process.exit(2); });

function ok_assert(label, cond) { if (cond) ok(label); else bad(label); }
