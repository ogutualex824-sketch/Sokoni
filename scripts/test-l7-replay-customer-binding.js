'use strict';
/**
 * CERTIFICATION — L-7: recordPOSSale's customer binding (Q0b-2a) cannot be bypassed through M0-2's replay path,
 * and the replay path is not weakened by it.
 *
 * On this lineage recordPOSSale carries two authorities that meet in one handler:
 *   · M0-2 — one sale per (seller, idempotencyKey): a claim created in the ONE sale transaction, with a
 *     fingerprint of what was sold (it includes customerId and customerPhone); a replay returns the ORIGINAL
 *     result and re-runs nothing (no loyalty, no event, no receipt);
 *   · Q0b-2a — a named customer must be the bound seller's own, resolved before the sale and re-read inside
 *     that same transaction; points are awarded in a transaction that re-checks ownership.
 * This suite proves they compose: a key can never be used to reach another merchant's customer, a replay never
 * credits a customer twice, and a customer whose owner changed is never credited by a replay.
 *
 *   P-1  CONTROL: own customer, key K1 → sold, credited once
 *   P-2  same key, same sale → replayed (same saleId), NO second credit, no second sale
 *   P-3  same key, ANOTHER merchant's customer → refused; that record byte-unchanged; nothing written
 *   P-4  fresh key, another merchant's customer → refused (the Q0b-2a authority itself)
 *   P-5  our customer's owner becomes B after K1 committed; K1 replayed → the customer is NOT credited again and
 *        nothing new is written (the replay cannot re-open the customer)
 *   P-6  two CONCURRENT calls with one key for our own customer → one sale, the customer credited exactly once
 *
 * Pointed at the pre-L-7 tree (REPAIR_ROOT = export of 52b9ed6), P-4 must fail (a foreign customer is sold to).
 * P-2, P-3, P-5 and P-6 are M0-2 properties that must hold on BOTH trees — they are the "not weakened" half.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-l7-replay';
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

let PRE;
try { PRE = require(path.join(FN, 'pos-retail-engine.js')); }
catch (e) { process.stdout.write('  ✖ SETUP — ' + e.message + '\n'); process.exit(2); }

const A = 'l7r-seller-a', B = 'l7r-seller-b';
const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));
const why = (r) => (r.ok ? 'SOLD sale ' + (r.out && r.out.saleId) + (r.out && r.out.replayed ? ' (replayed)' : '') : 'refused [' + r.code + ']: ' + r.msg.slice(0, 70));
const call = (uid, data) => res(quiet(() => PRE._h.recordPOSSale({ data, auth: { uid, token: { uid, role: 'seller' } } })));
const saleOf = (key, o) => Object.assign({ idempotencyKey: key, items: [{ productId: 'P_L7R', name: 'Maize', qty: 1, price: 100 }],
  payment: { method: 'cash', amount: 100 }, cashierName: 'Till 1' }, o || {});

const recOf = async (p) => { const s = await db.doc(p).get(); return s.exists ? JSON.stringify(s.data()) + '@' + s.updateTime.toMillis() : 'ABSENT'; };
const points = async (id) => Number(((await db.doc('posCustomers/' + id).get()).data() || {}).loyaltyPoints);
const salesOf = async (uid) => (await db.collection('posSales').where('sellerId', '==', uid).get()).size;
const state = async () => ({ salesA: await salesOf(A), salesB: await salesOf(B),
  debts: (await db.collection('posCommissionLiabilities').get()).size, claims: (await db.collection('posRecordSaleClaims').get()).size });

(async () => {
  process.stdout.write(`\nL-7 — recordPOSSale: customer binding x replay   (tree: ${ROOT})\n\n`);
  for (const u of [A, B]) {
    await db.collection('sellers').doc(u).set({ name: 'Shop ' + u });
    await db.collection('users').doc(u).set({ name: 'Owner ' + u, role: 'seller' });
  }
  await db.collection('products').doc('P_L7R').set({ name: 'Maize', price: 100, stock: 1000, sellerUid: A });
  await db.collection('posCustomers').doc('L7R_A1').set({ sellerId: A, name: 'Ann', phone: '+254711000101', loyaltyPoints: 10 });
  await db.collection('posCustomers').doc('L7R_A2').set({ sellerId: A, name: 'Abel', phone: '+254711000102', loyaltyPoints: 10 });
  await db.collection('posCustomers').doc('L7R_A3').set({ sellerId: A, name: 'Ada', phone: '+254711000103', loyaltyPoints: 10 });
  await db.collection('posCustomers').doc('L7R_B1').set({ sellerId: B, name: 'B-SECRET', phone: '+254711000901', loyaltyPoints: 500 });

  let first = null;
  { const r = await call(A, saleOf('l7r-key-one', { customerId: 'L7R_A1' })); first = r;
    ok(r.ok && !r.out.replayed && (await points('L7R_A1')) === 20, 'P-1',
      'CONTROL own customer, key K1: credited once 10 → ' + (await points('L7R_A1')) + ': ' + why(r)); }

  { const s0 = await state(); const r = await call(A, saleOf('l7r-key-one', { customerId: 'L7R_A1' })); const s1 = await state();
    ok(r.ok && r.out.replayed === true && first.ok && r.out.saleId === first.out.saleId && (await points('L7R_A1')) === 20
      && JSON.stringify(s0) === JSON.stringify(s1), 'P-2',
      'same key, same sale → the ORIGINAL sale, no second credit (points ' + (await points('L7R_A1')) + '), nothing new written: ' + why(r)); }

  { const b0 = await recOf('posCustomers/L7R_B1'); const s0 = await state();
    const r = await call(A, saleOf('l7r-key-one', { customerId: 'L7R_B1' }));
    const b1 = await recOf('posCustomers/L7R_B1'); const s1 = await state();
    ok(!r.ok && b0 === b1 && JSON.stringify(s0) === JSON.stringify(s1), 'P-3',
      "same key, ANOTHER merchant's customer → refused, B's record byte-unchanged, nothing written: " + why(r)); }

  { const b0 = await recOf('posCustomers/L7R_B1'); const s0 = await state();
    const r = await call(A, saleOf('l7r-key-two', { customerId: 'L7R_B1' }));
    const b1 = await recOf('posCustomers/L7R_B1'); const s1 = await state();
    ok(!r.ok && r.code === 'permission-denied' && b0 === b1 && JSON.stringify(s0) === JSON.stringify(s1), 'P-4',
      "fresh key, another merchant's customer → refused, B's record byte-unchanged, nothing written: " + why(r)); }

  { const r0 = await call(A, saleOf('l7r-key-three', { customerId: 'L7R_A2' }));
    const credited = await points('L7R_A2');
    await db.doc('posCustomers/L7R_A2').update({ sellerId: B });
    const c0 = await recOf('posCustomers/L7R_A2'); const s0 = await state();
    const r = await call(A, saleOf('l7r-key-three', { customerId: 'L7R_A2' }));
    const c1 = await recOf('posCustomers/L7R_A2'); const s1 = await state();
    ok(r0.ok && credited === 20 && c0 === c1 && JSON.stringify(s0) === JSON.stringify(s1) && (!r.ok || r.out.replayed === true), 'P-5',
      'owner becomes B after K3 committed; K3 replayed → the (now B\'s) customer is not credited again and nothing new is written: '
      + why(r) + ' (points ' + (await points('L7R_A2')) + ')'); }

  { const s0 = await state();
    const [r1, r2] = await Promise.all([call(A, saleOf('l7r-key-four', { customerId: 'L7R_A3' })), call(A, saleOf('l7r-key-four', { customerId: 'L7R_A3' }))]);
    const s1 = await state();
    ok(r1.ok && r2.ok && r1.out.saleId === r2.out.saleId && s1.salesA === s0.salesA + 1 && (await points('L7R_A3')) === 20, 'P-6',
      'two concurrent calls, one key, own customer → ONE sale, credited exactly once (points ' + (await points('L7R_A3')) + ', sales +'
      + (s1.salesA - s0.salesA) + '): ' + why(r1) + ' | ' + why(r2)); }

  clearTimeout(WATCHDOG);
  process.stdout.write(`\n  ${pass} pass / ${fail} fail\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
