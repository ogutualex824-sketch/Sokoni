#!/usr/bin/env node
'use strict';
/* ============================================================================
   POS restock on APPROVAL, exactly once, ledgered (owner 2026-10-03, via sokoni-5b — decision (b))
   Drives the REAL posProcessRefund + posVoidSale + _consumeApproval + resolveActor against an in-memory Firestore
   with OPTIMISTIC transactions (a read doc changed before commit ⇒ the transaction retries, as Firestore does).

   REFUND (the manager/owner refunding IS the approval act)
     R1  stock 5 → 7, ONE ledger row stockMovements/{refundId}_P1 {refund_restock, before 5, after 7, delta 2, actor},
         inventoryVersion +1, sale refunded
     R2  replay with the same key: idempotent, stock still 7, still one ledger row
     R3  TWO concurrent refunds with DIFFERENT keys: exactly one restores (7, not 9); the other is refused
     R4  an UNMETERED product (no stock field) is never given a count; the metered line still restores
     R5  trackInventory:false is not touched
     R6  a cashier cannot refund (nothing written)       R7  more than sold refused       R8  a voided sale cannot be refunded
   VOID (a consumed 'void' approval bound to the sale)
     V1  all lines restored + ledgered (void_restock), approval consumed, sale voided
     V2  replay with the same approval: idempotent, no second restore
     V3  no approval / pending approval / approval for another sale → refused, nothing written, approval untouched
     V4  a refunded sale cannot be voided            V5  a stranger holding a valid approval is refused; approval NOT spent
     V6  a void writes ONLY sale / products / stockMovements / approval — no entitlement collection
     V7  atomic: a failed commit leaves the approval APPROVED and the stock unchanged
   NODE_PATH=<functions/node_modules> node scripts/test-pos-restock-on-approval.js
   ============================================================================ */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 260) : '')); } };

class HttpsError extends Error { constructor (code, message) { super(message); this.code = code; } }
const DOCS = new Map(); const VER = new Map(); let FAIL_COMMIT = false;
const bump = (k) => VER.set(k, (VER.get(k) || 0) + 1);
const INC = '__inc';
const applyPatch = (cur, v) => { const o = Object.assign({}, cur || {}); for (const [k, x] of Object.entries(v)) o[k] = (x && typeof x === 'object' && INC in x) ? (Number(o[k]) || 0) + x[INC] : x; return o; };
const tick = () => new Promise((r) => setImmediate(r));
function ref (key) {
  return { _key: key, id: key.split('/').pop(),
    async get () { await tick(); const d = DOCS.get(key); return { exists: !!d, id: key.split('/').pop(), data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
    async set (v, o) { DOCS.set(key, applyPatch(o && o.merge ? DOCS.get(key) : null, v)); bump(key); },
    async update (v) { DOCS.set(key, applyPatch(DOCS.get(key), v)); bump(key); } };
}
const DB = {
  collection: (name) => ({ doc: (id) => ref(name + '/' + id), where () { return this; }, limit () { return this; }, orderBy () { return this; },
    async get () { return { empty: true, docs: [], forEach () {} }; }, async add () { return { id: 'auto' }; } }),
  async runTransaction (fn) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const reads = new Map(); const writes = [];
      const txn = {
        async get (r) { const s = await r.get(); if (!reads.has(r._key)) reads.set(r._key, VER.get(r._key) || 0); return s; },
        set: (r, v, o) => writes.push(['set', r._key, v, o]),
        update: (r, v) => writes.push(['update', r._key, v]),
        create: (r, v) => writes.push(['create', r._key, v]),
      };
      const out = await fn(txn);
      await tick();
      if ([...reads].some(([k, v]) => (VER.get(k) || 0) !== v)) continue;   /* contention → retry, like Firestore */
      if (FAIL_COMMIT && writes.some((w) => w[1].startsWith('posRetailSales/'))) throw new Error('simulated commit failure');   /* only the operation's own commit fails */
      for (const w of writes) if (w[0] === 'create' && DOCS.has(w[1])) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
      for (const [op, k, v, o] of writes) { DOCS.set(k, applyPatch(op === 'update' || (o && o.merge) ? DOCS.get(k) : null, v)); bump(k); }
      return out;
    }
    throw new Error('ABORTED: too much contention');
  } };
const FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ [INC]: n }) };
const TSs = { now: () => ({ toMillis: () => Date.now() }), fromDate: (d) => d };
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue, Timestamp: TSs };
  if (id === 'firebase-admin') return { apps: [1], initializeApp: () => {}, auth: () => ({ getUser: async () => ({ displayName: '' }) }), firestore: Object.assign(() => DB, { FieldValue, Timestamp: TSs }) };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/logger') return { info () {}, warn () {}, error () {}, debug () {}, log () {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => '0' }), defineString: (n) => ({ value: () => '' }) };
  if (id === './pos-audit') return { writeAudit: () => {} };
  return orig.apply(this, arguments);
};
let ZF, loadErr = null;
try { require(path.join(FN, 'pos-staff-ops.js')); ZF = require(path.join(FN, 'pos-zero-friction.js')); } catch (e) { loadErr = e; }
Module.prototype.require = orig;

const SHOP = 'OWNER_uid_1';          /* shops/{ownerUid}; the sale's merchantId is the shop id */
const OWNER = SHOP, STRANGER = 'STRANGER_uid_9';
const ownerAuth = { uid: OWNER, token: { posRole: 'owner' } };
function reset () {
  DOCS.clear(); VER.clear(); FAIL_COMMIT = false;
  DOCS.set('shops/' + SHOP, { name: 'Kass Shop' });
  DOCS.set('users/' + OWNER, { name: 'Owner One' });
  DOCS.set('businesses/' + SHOP, { ownerId: OWNER });
  DOCS.set('posRetailSales/S1', { merchantId: SHOP, status: 'completed', branchId: 'default',
    items: [{ productId: 'P1', qty: 2, unitPrice: 100 }, { productId: 'P2', qty: 1, unitPrice: 50 }] });
  DOCS.set('products/P1', { name: 'Soap', shopId: SHOP, stock: 5, inventoryVersion: 3, trackInventory: true, sold: 10 });
  DOCS.set('products/P2', { name: 'Gift wrap', shopId: SHOP });                 /* UNMETERED: no stock field */
}
const approval = (id, over) => DOCS.set('posApprovals/' + id, Object.assign({ sellerId: SHOP, type: 'void', status: 'approved',
  binding: { saleId: 'S1' }, requestedBy: 'CASHIER', reviewedBy: OWNER, expiresAt: new Date(Date.now() + 60000) }, over || {}));
const ledger = () => [...DOCS.keys()].filter((k) => k.startsWith('stockMovements/'));
const tryCall = async (fn, req) => { try { return { ok: true, r: await fn(req) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };

(async () => {
  if (loadErr) { ck('modules load', false, loadErr.stack); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

  /* R1 */
  reset();
  let x = await tryCall(ZF.posProcessRefund, { data: { saleId: 'S1', merchantId: SHOP, reason: 'damaged', idempotencyKey: 'k1', items: [{ productId: 'P1', qty: 2 }] }, auth: ownerAuth });
  const mv = DOCS.get('stockMovements/rf_k1_P1');
  ck('R1 refund: stock 5 → 7; ONE ledger row {refund_restock, before 5, after 7, delta 2, actor}; version 3 → 4; sale refunded',
    x.ok && DOCS.get('products/P1').stock === 7 && DOCS.get('products/P1').inventoryVersion === 4 && mv && mv.kind === 'refund_restock'
    && mv.before === 5 && mv.after === 7 && mv.delta === 2 && mv.actorUid === OWNER && mv.saleId === 'S1' && ledger().length === 1 && DOCS.get('posRetailSales/S1').status === 'refunded', x);
  x = await tryCall(ZF.posProcessRefund, { data: { saleId: 'S1', merchantId: SHOP, reason: 'damaged', idempotencyKey: 'k1', items: [{ productId: 'P1', qty: 2 }] }, auth: ownerAuth });
  ck('R2 replay, same key: idempotent; stock still 7; still one ledger row', x.ok && x.r.idempotent === true && DOCS.get('products/P1').stock === 7 && ledger().length === 1, x);

  /* R3 — the race the old pre-transaction check could not stop */
  reset();
  const [a, b] = await Promise.all([
    tryCall(ZF.posProcessRefund, { data: { saleId: 'S1', merchantId: SHOP, reason: 'r', idempotencyKey: 'kA', items: [{ productId: 'P1', qty: 2 }] }, auth: ownerAuth }),
    tryCall(ZF.posProcessRefund, { data: { saleId: 'S1', merchantId: SHOP, reason: 'r', idempotencyKey: 'kB', items: [{ productId: 'P1', qty: 2 }] }, auth: ownerAuth }),
  ]);
  ck('R3 two CONCURRENT refunds with different keys: exactly one restores (stock 7, not 9), the other refused',
    [a, b].filter((z) => z.ok).length === 1 && DOCS.get('products/P1').stock === 7 && ledger().length === 1, { a, b, stock: DOCS.get('products/P1').stock });

  /* R4 / R5 */
  reset();
  x = await tryCall(ZF.posProcessRefund, { data: { saleId: 'S1', merchantId: SHOP, reason: 'r', idempotencyKey: 'k4', items: [{ productId: 'P1', qty: 1 }, { productId: 'P2', qty: 1 }] }, auth: ownerAuth });
  ck('R4 unmetered P2 is never given a count (no stock field, no ledger row, reported); metered P1 restores 5 → 6',
    x.ok && !('stock' in DOCS.get('products/P2')) && !DOCS.has('stockMovements/rf_k4_P2') && DOCS.get('products/P1').stock === 6
    && DOCS.get('posRefunds/rf_k4').stockNotRestored.some((s) => s.productId === 'P2' && s.reason === 'unmetered'), x);
  reset(); DOCS.set('products/P1', Object.assign(DOCS.get('products/P1'), { trackInventory: false }));
  x = await tryCall(ZF.posProcessRefund, { data: { saleId: 'S1', merchantId: SHOP, reason: 'r', idempotencyKey: 'k5', items: [{ productId: 'P1', qty: 1 }] }, auth: ownerAuth });
  ck('R5 trackInventory:false is not touched (stock stays 5, no ledger row)', x.ok && DOCS.get('products/P1').stock === 5 && ledger().length === 0, x);

  /* R6 – R8 */
  reset();
  x = await tryCall(ZF.posProcessRefund, { data: { saleId: 'S1', merchantId: SHOP, reason: 'r', idempotencyKey: 'k6', items: [{ productId: 'P1', qty: 1 }] }, auth: { uid: 'CASHIER', token: { posRole: 'cashier' } } });
  ck('R6 a cashier cannot refund — refused, nothing written', !x.ok && x.code === 'permission-denied' && DOCS.get('products/P1').stock === 5 && ledger().length === 0, x);
  x = await tryCall(ZF.posProcessRefund, { data: { saleId: 'S1', merchantId: SHOP, reason: 'r', idempotencyKey: 'k7', items: [{ productId: 'P1', qty: 3 }] }, auth: ownerAuth });
  ck('R7 more than sold refused, nothing written', !x.ok && DOCS.get('products/P1').stock === 5 && ledger().length === 0, x);
  DOCS.set('posRetailSales/S1', Object.assign(DOCS.get('posRetailSales/S1'), { status: 'voided' }));
  x = await tryCall(ZF.posProcessRefund, { data: { saleId: 'S1', merchantId: SHOP, reason: 'r', idempotencyKey: 'k8', items: [{ productId: 'P1', qty: 1 }] }, auth: ownerAuth });
  ck('R8 a voided sale cannot be refunded', !x.ok && DOCS.get('products/P1').stock === 5, x);

  /* V1 / V2 */
  reset(); approval('AP1');
  x = await tryCall(ZF.posVoidSale, { data: { saleId: 'S1', merchantId: SHOP, approvalId: 'AP1', reason: 'wrong item' }, auth: ownerAuth });
  const vm = DOCS.get('stockMovements/void_AP1_P1');
  ck('V1 void: P1 5 → 7 ledgered (void_restock), unmetered P2 untouched, approval CONSUMED, sale voided',
    x.ok && DOCS.get('products/P1').stock === 7 && vm && vm.kind === 'void_restock' && vm.before === 5 && vm.after === 7 && !('stock' in DOCS.get('products/P2'))
    && DOCS.get('posApprovals/AP1').status === 'consumed' && DOCS.get('posRetailSales/S1').status === 'voided' && DOCS.get('posRetailSales/S1').voidApprovalId === 'AP1', x);
  x = await tryCall(ZF.posVoidSale, { data: { saleId: 'S1', merchantId: SHOP, approvalId: 'AP1', reason: 'wrong item' }, auth: ownerAuth });
  ck('V2 replay with the same approval: idempotent, stock still 7, one ledger row', x.ok && x.r.idempotent === true && DOCS.get('products/P1').stock === 7 && ledger().length === 1, x);
  approval('AP1b');
  x = await tryCall(ZF.posVoidSale, { data: { saleId: 'S1', merchantId: SHOP, approvalId: 'AP1b', reason: 'again' }, auth: ownerAuth });
  ck('V2b a DIFFERENT approval on an already-void sale is refused (would restore twice); that approval stays unspent', !x.ok && DOCS.get('products/P1').stock === 7 && DOCS.get('posApprovals/AP1b').status === 'approved', x);

  /* V3 */
  reset();
  const v3a = await tryCall(ZF.posVoidSale, { data: { saleId: 'S1', merchantId: SHOP, reason: 'x' }, auth: ownerAuth });
  approval('AP2', { status: 'pending' });
  const v3b = await tryCall(ZF.posVoidSale, { data: { saleId: 'S1', merchantId: SHOP, approvalId: 'AP2', reason: 'x' }, auth: ownerAuth });
  approval('AP3', { binding: { saleId: 'OTHER' } });
  const v3c = await tryCall(ZF.posVoidSale, { data: { saleId: 'S1', merchantId: SHOP, approvalId: 'AP3', reason: 'x' }, auth: ownerAuth });
  ck('V3 no approval / pending / bound to another sale → all refused; nothing written; approvals untouched',
    !v3a.ok && !v3b.ok && !v3c.ok && DOCS.get('products/P1').stock === 5 && ledger().length === 0 && DOCS.get('posRetailSales/S1').status === 'completed'
    && DOCS.get('posApprovals/AP2').status === 'pending' && DOCS.get('posApprovals/AP3').status === 'approved', [v3a.msg, v3b.msg, v3c.msg]);

  /* V4 / V5 */
  reset(); approval('AP4'); DOCS.set('posRetailSales/S1', Object.assign(DOCS.get('posRetailSales/S1'), { status: 'refunded' }));
  x = await tryCall(ZF.posVoidSale, { data: { saleId: 'S1', merchantId: SHOP, approvalId: 'AP4', reason: 'x' }, auth: ownerAuth });
  ck('V4 a refunded sale cannot be voided; approval unspent', !x.ok && DOCS.get('products/P1').stock === 5 && DOCS.get('posApprovals/AP4').status === 'approved', x);
  reset(); approval('AP5');
  x = await tryCall(ZF.posVoidSale, { data: { saleId: 'S1', merchantId: SHOP, approvalId: 'AP5', reason: 'x' }, auth: { uid: STRANGER, token: { posRole: 'manager' } } });
  ck('V5 a stranger holding a valid approval (even with a manager claim) is refused; approval NOT spent', !x.ok && x.code === 'permission-denied' && DOCS.get('posApprovals/AP5').status === 'approved' && DOCS.get('products/P1').stock === 5, x);

  /* V6 / V7 */
  reset(); approval('AP6');
  const before = new Map([...DOCS].map(([k, v]) => [k, JSON.stringify(v)]));
  await tryCall(ZF.posVoidSale, { data: { saleId: 'S1', merchantId: SHOP, approvalId: 'AP6', reason: 'x' }, auth: ownerAuth });
  const touched = [...DOCS.keys()].filter((k) => before.get(k) !== JSON.stringify(DOCS.get(k))).map((k) => k.split('/')[0]);
  ck('V6 a void writes ONLY posRetailSales / products / stockMovements / posApprovals — no gift card, loyalty, wallet or ticket',
    touched.length > 0 && touched.every((c) => ['posRetailSales', 'products', 'stockMovements', 'posApprovals'].includes(c)), touched);
  reset(); approval('AP7'); FAIL_COMMIT = true;
  x = await tryCall(ZF.posVoidSale, { data: { saleId: 'S1', merchantId: SHOP, approvalId: 'AP7', reason: 'x' }, auth: ownerAuth });
  ck('V7 atomic: a failed commit leaves the approval APPROVED, stock 5, sale completed, no ledger', !x.ok && DOCS.get('posApprovals/AP7').status === 'approved' && DOCS.get('products/P1').stock === 5 && DOCS.get('posRetailSales/S1').status === 'completed' && ledger().length === 0, x);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
