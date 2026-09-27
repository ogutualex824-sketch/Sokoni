'use strict';
/**
 * CERTIFICATION — M0-2: recordPOSSale records ONE sale per request (owner ruling 2026-09-28).
 *
 * recordPOSSale took no idempotency key, so a retried request recorded a second sale — and, since M0-1, a second
 * commission debt with it. Now the caller must name the attempt; the server owns the claim
 * (posRecordSaleClaims/{sha256(seller|key)}), created in ONE transaction with the stock movement, the sale and the
 * receipt, together with a fingerprint of what was sold.
 *
 * Runs the REAL recordPOSSale (direct, and through smartPosDispatch) against the Firestore EMULATOR. Pointed at the
 * pre-M0-2 tree (REPAIR_ROOT = export of ab62fb7) the key is ignored and every call is a new sale.
 *
 *   K  the key is required — refused before anything is written
 *   S  same key, same sale → the original result; different sale → refused; concurrency converges
 *   R  robustness — keys are per seller, display fields do not split a sale, a refused attempt does not poison
 *      its key, and a replay repairs a debt lost between the sale commit and the debt write
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-m02-idem';
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 280s\n'); process.exit(3); }, 280000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr), cw: console.warn, ce: console.error, cl: console.log };
let _q = 0;
async function quiet(fn) {
  if (_q++ === 0) { process.stdout.write = () => true; process.stderr.write = () => true; console.warn = () => {}; console.error = () => {}; console.log = () => {}; }
  try { return await fn(); } finally { if (--_q === 0) { process.stdout.write = _REAL.so; process.stderr.write = _REAL.se; console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl; } }
}

let PRE, DISPATCH = null;
try { PRE = require(path.join(FN, 'pos-retail-engine.js')); }
catch (e) { process.stdout.write('  ✖ SETUP — ' + e.message + '\n'); process.exit(2); }
try { DISPATCH = require(path.join(FN, 'smartpos-dispatch.js')).smartPosDispatch; } catch (e) { DISPATCH = null; }

const REQ = (uid, data) => ({ data, auth: { uid, token: { uid, role: 'seller' } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));
const why = (r) => (r.ok ? 'RECORDED sale ' + (r.out && r.out.saleId) + (r.out && r.out.replayed ? ' (replayed)' : '') : 'refused [' + r.code + ']: ' + r.msg.slice(0, 60));
const call = (uid, data) => res(quiet(() => PRE.recordPOSSale.run(REQ(uid, data))));
const saleOf = (key, o) => Object.assign({ idempotencyKey: key, items: [{ productId: 'P_M02', name: 'Maize', qty: 2, price: 100, cost: 60 }],
  payment: { method: 'cash', amount: 200 }, cashierName: 'Till 1' }, o || {});

const SELLER = 'm02-seller', OTHER = 'm02-other';
const salesOf = async (uid) => (await db.collection('posSales').where('sellerId', '==', uid).get()).size;
const stock = async () => Number((await db.collection('products').doc('P_M02').get()).data().stock);
const debtOf = async (saleId) => { const d = await db.collection('posCommissionLiabilities').doc('poscomm_' + saleId).get(); return d.exists ? d.data() : null; };
const debtsFor = async (saleId) => (await db.collection('posCommissionLiabilities').where('saleId', '==', String(saleId)).get()).size;
const snapshot = async () => ({ sales: await salesOf(SELLER), stock: await stock(),
  debts: (await db.collection('posCommissionLiabilities').get()).size, receipts: (await db.collection('receipts').get()).size });

(async () => {
  process.stdout.write(`\nM0-2 — recordPOSSale records one sale per request   (tree: ${ROOT})\n\n`);
  for (const u of [SELLER, OTHER]) {
    await db.collection('sellers').doc(u).set({ name: 'Shop ' + u });
    await db.collection('users').doc(u).set({ name: 'Owner ' + u, role: 'seller' });
  }
  await db.collection('products').doc('P_M02').set({ name: 'Maize', price: 100, stock: 100, sellerUid: SELLER });
  await db.collection('products').doc('P_M02_O').set({ name: 'Maize', price: 100, stock: 100, sellerUid: OTHER });
  await db.collection('products').doc('P_M02_LOW').set({ name: 'Rare', price: 100, stock: 1, sellerUid: SELLER });

  process.stdout.write('[K] the key is required\n');
  { const s0 = await snapshot(); const r = await call(SELLER, saleOf(undefined)); const s1 = await snapshot();
    ok(!r.ok && r.code === 'invalid-argument' && /idempotencyKey/.test(r.msg) && JSON.stringify(s0) === JSON.stringify(s1), 'K-1',
      'an old-style call with NO key fails explicitly and writes nothing (no sale, no stock move, no debt): ' + why(r)); }
  { const s0 = await snapshot(); const r = await call(SELLER, saleOf('short')); const s1 = await snapshot();
    ok(!r.ok && r.code === 'invalid-argument' && JSON.stringify(s0) === JSON.stringify(s1), 'K-2', 'a malformed key (too short) is refused the same way: ' + why(r)); }
  if (DISPATCH) {
    const s0 = await snapshot();
    const r = await res(quiet(() => DISPATCH.run(REQ(SELLER, Object.assign({ op: 'recordPOSSale' }, saleOf(undefined))))));
    const s1 = await snapshot();
    ok(!r.ok && r.code === 'invalid-argument' && JSON.stringify(s0) === JSON.stringify(s1), 'K-3',
      'the LIVE route (smartPosDispatch op recordPOSSale) enforces the same rule: ' + why(r));
  } else ok(false, 'K-3', 'smartpos-dispatch could not be loaded in this tree (not-attempted is not a pass)');

  process.stdout.write('\n[S] same key → the same sale\n');
  let first;
  { const s0 = await snapshot(); first = await call(SELLER, saleOf('m02-key-first-0001')); const s1 = await snapshot();
    const debt = first.ok ? await debtOf(first.out.saleId) : null;
    ok(first.ok && s1.sales === s0.sales + 1 && s1.stock === s0.stock - 2 && !!debt && debt.liabilityMinor === 1000, 'S-1',
      'the FIRST call records exactly one sale, moves stock once, and creates exactly one debt (poscomm_<saleId>, 5% min KES 10 = 1000): ' + why(first) + ', debt=' + (debt && debt.liabilityMinor)); }
  { const s0 = await snapshot(); const r = await call(SELLER, saleOf('m02-key-first-0001')); const s1 = await snapshot();
    ok(r.ok && r.out.saleId === first.out.saleId && r.out.replayed === true && JSON.stringify(s0) === JSON.stringify(s1) && (await debtsFor(first.out.saleId)) === 1, 'S-2',
      'an IDENTICAL retry returns the original sale and writes nothing new (no sale, no stock, no debt, no receipt): ' + why(r)); }
  { const s0 = await snapshot();
    const rs = await Promise.all(Array.from({ length: 6 }, () => call(SELLER, saleOf('m02-key-concurrent-01'))));
    const s1 = await snapshot(); const ids = [...new Set(rs.filter((r) => r.ok).map((r) => r.out.saleId))];
    ok(rs.every((r) => r.ok) && ids.length === 1 && s1.sales === s0.sales + 1 && s1.stock === s0.stock - 2 && s1.debts === s0.debts + 1, 'S-3',
      'CONCURRENT: 6 simultaneous identical requests converge on ONE sale, one stock move, one debt: ' + 'sales +' + (s1.sales - s0.sales) + ', stock -' + (s0.stock - s1.stock) + ', debts +' + (s1.debts - s0.debts) + ', distinct saleIds ' + ids.length + (rs.every((r) => r.ok) ? '' : ', errors: ' + rs.filter((r) => !r.ok).map(why).join(' / '))); }
  { /* A CUSTOM line (no productId) reads no product row, so nothing but the CLAIM serialises these —
       S-3's convergence could be credited to the product lock alone; this one cannot. */
    const custom = () => saleOf('m02-key-custom-conc1', { items: [{ name: 'Service fee', qty: 1, price: 150, cost: 0 }], payment: { method: 'cash', amount: 150 } });
    const s0 = await snapshot();
    const rs = await Promise.all(Array.from({ length: 6 }, () => call(SELLER, custom())));
    const s1 = await snapshot(); const ids = [...new Set(rs.filter((r) => r.ok).map((r) => r.out.saleId))];
    ok(rs.every((r) => r.ok) && ids.length === 1 && s1.sales === s0.sales + 1 && s1.debts === s0.debts + 1, 'S-3b',
      'CONCURRENT, no stock row to lock: 6 identical custom-line requests still converge on ONE sale and one debt — the claim alone: ' + 'sales +' + (s1.sales - s0.sales) + ', debts +' + (s1.debts - s0.debts) + ', distinct saleIds ' + ids.length + (rs.every((r) => r.ok) ? '' : ', errors: ' + rs.filter((r) => !r.ok).map(why).join(' / '))); }
  { const s0 = await snapshot(); const r = await call(SELLER, saleOf('m02-key-first-0001', { items: [{ productId: 'P_M02', name: 'Maize', qty: 3, price: 100, cost: 60 }], payment: { method: 'cash', amount: 300 } }));
    const s1 = await snapshot();
    ok(!r.ok && r.code === 'failed-precondition' && JSON.stringify(s0) === JSON.stringify(s1), 'S-4',
      'the same key with a DIFFERENT sale (qty 3) is refused, and nothing is written: ' + why(r)); }
  { const s0 = await snapshot(); const r = await call(SELLER, saleOf('m02-key-first-0001', { payment: { method: 'mpesa', amount: 200, ref: 'QX1' } }));
    const s1 = await snapshot();
    ok(!r.ok && r.code === 'failed-precondition' && JSON.stringify(s0) === JSON.stringify(s1), 'S-5',
      '...and so is the same key with a different PAYMENT (method/ref): ' + why(r)); }

  process.stdout.write('\n[R] robustness\n');
  { const r = await call(OTHER, Object.assign(saleOf('m02-key-first-0001'), { items: [{ productId: 'P_M02_O', name: 'Maize', qty: 2, price: 100, cost: 60 }] }));
    ok(r.ok && !r.out.replayed && r.out.saleId !== first.out.saleId, 'R-1',
      'keys are PER SELLER: another shop using the same key string records its own sale (no collision, no leak): ' + why(r)); }
  { const s0 = await snapshot(); const r = await call(SELLER, saleOf('m02-key-first-0001', { cashierName: 'Somebody else' })); const s1 = await snapshot();
    ok(r.ok && r.out.replayed === true && r.out.saleId === first.out.saleId && JSON.stringify(s0) === JSON.stringify(s1), 'R-2',
      'a display-only difference (cashierName) is the SAME sale — replayed, nothing written: ' + why(r)); }
  { const low = (q) => ({ idempotencyKey: 'm02-key-lowstock-01', items: [{ productId: 'P_M02_LOW', name: 'Rare', qty: q, price: 100, cost: 60 }], payment: { method: 'cash', amount: 100 * q } });
    const r1 = await call(SELLER, low(5));
    await db.collection('products').doc('P_M02_LOW').update({ stock: 10 });
    const r2 = await call(SELLER, low(5));
    ok(!r1.ok && r1.code === 'failed-precondition' && r2.ok && !r2.out.replayed, 'R-3',
      'a REFUSED attempt (insufficient stock) leaves no claim, so the same key succeeds once the shelf is restocked: ' + why(r1) + ' → ' + why(r2)); }
  { const r = await call(SELLER, saleOf('m02-key-repair-0001')); const sid = r.ok && r.out.saleId;
    await db.collection('posCommissionLiabilities').doc('poscomm_' + sid).delete();
    await db.collection('ledger').doc('poscomm_' + sid).delete();
    const r2 = await call(SELLER, saleOf('m02-key-repair-0001'));
    const debt = sid ? await debtOf(sid) : null; const led = sid ? (await db.collection('ledger').doc('poscomm_' + sid).get()).exists : false;
    ok(r.ok && r2.ok && r2.out.replayed && !!debt && debt.liabilityMinor === 1000 && led && (await debtsFor(sid)) === 1, 'R-4',
      'a debt LOST between the sale commit and the debt write is re-created by the retry — once, with the original amount: ' + (debt ? debt.liabilityMinor + ', projection ' + led : 'no debt')); }

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
