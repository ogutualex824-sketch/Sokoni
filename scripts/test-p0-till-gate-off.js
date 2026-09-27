'use strict';
/**
 * CERTIFICATION — P0 till safety: the 07:00 commission gate no longer stops a sale (owner ruling 2026-09-27).
 *
 * Nothing deployed can PAY a POS commission liability yet (no settle callable, no collector, no Pay Now), so an
 * enforced gate would lock a merchant's till at 07:00 the day after their first cash sale with no way to unlock it.
 * Until one certified settlement path exists, the gate is switched OFF (pos-commission-rail GATE_ENFORCED) — and
 * ONLY the refusal is withheld: every owed sale still records its liability exactly as before.
 *
 * Runs the REAL posCompleteCheckout and recordPOSSale (`.run`) against the Firestore EMULATOR. Pointed at the
 * pre-P0 tree (REPAIR_ROOT = export of 53ff924, byte-identical in functions/ to the deployed 00024-zit source) the
 * gate refuses; on this tree the sale completes.
 *
 *   G   posCompleteCheckout — overdue debt, and a ledger OUTAGE, no longer refuse; the new liability is recorded
 *   R   recordPOSSale (the second door) — the same
 *   C   controls: a clear merchant sells on both trees; the outage injection is proven to fire
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-p0-gate';
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 240s\n'); process.exit(3); }, 240000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr), cw: console.warn, ce: console.error, cl: console.log };
async function quiet(fn) {
  process.stdout.write = () => true; process.stderr.write = () => true; console.warn = () => {}; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { process.stdout.write = _REAL.so; process.stderr.write = _REAL.se; console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl; }
}

/* ── the OUTAGE injection: a query over posCommissionLiabilities rejects while armed ── */
const LIAB = 'posCommissionLiabilities';
const QProto = Object.getPrototypeOf(db.collection(LIAB).where('x', '==', 1));
const _qGet = QProto.get;
const INJ = { outage: false, fired: 0 };
QProto.get = function (...a) {
  const coll = this._queryOptions && this._queryOptions.collectionId;
  if (INJ.outage && coll === LIAB) { INJ.fired++; return Promise.reject(new Error('INJECTED liability ledger outage')); }
  return _qGet.apply(this, a);
};

let PZF, PRE;
try { PZF = require(path.join(FN, 'pos-zero-friction.js')); PRE = require(path.join(FN, 'pos-retail-engine.js')); }
catch (e) { process.stdout.write('  ✖ SETUP — ' + e.message + '\n'); process.exit(2); }

const REQ = (uid, data, token) => ({ data, auth: { uid, token: Object.assign({ uid }, token || {}) }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));
const why = (r) => (r.ok ? 'COMPLETED' : 'refused [' + r.code + ']: ' + r.msg.slice(0, 70));
const get = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };

async function checkout(merchant, key) {
  return res(quiet(() => PZF.posCompleteCheckout.run(REQ(merchant, {
    idempotencyKey: key, merchantId: merchant, items: [{ productId: 'P_' + merchant, qty: 1, unitPrice: 1000, name: 'Maize' }],
    payments: [{ method: 'cash', amount: 1000 }], subtotal: 1000, discountTotal: 0, taxTotal: 0, grandTotal: 1000 }))));
}
async function record(merchant) {
  return res(quiet(() => PRE.recordPOSSale.run(REQ(merchant, {
    items: [{ productId: 'P_' + merchant, name: 'Maize', qty: 1, price: 1000, cost: 600 }],
    payment: { method: 'cash', amount: 1000 } }, { role: 'seller' }))));
}
const saleIdOf = (r) => r.ok && r.out && (r.out.saleId || (r.out.sale && r.out.sale.id) || r.out.id);

(async () => {
  process.stdout.write(`\nP0 — the commission gate does not stop a sale   (tree: ${ROOT})\n\n`);
  const CLEAR = 'p0-clear', OWES = 'p0-owes', OUT = 'p0-outage';
  for (const m of [CLEAR, OWES, OUT]) {
    await db.collection('shops').doc(m).set({ name: 'Shop ' + m, ownerId: m });
    await db.collection('users').doc(m).set({ name: 'Owner ' + m, displayName: 'Owner ' + m, role: 'seller' });
    await db.collection('sellers').doc(m).set({ uid: m, name: 'Shop ' + m });
    await db.collection('products').doc('P_' + m).set({ name: 'Maize', price: 1000, stock: 50, trackInventory: true, sellerUid: m, shopId: m });
  }
  /* an OVERDUE outstanding liability, from a settlement day long past — the gate is closed for OWES */
  const OVERDUE = { merchantUid: OWES, saleId: 'old-sale-1', settlementDay: '2020-01-01', liabilityMinor: 5000, status: 'OUTSTANDING' };
  await db.collection(LIAB).doc('old-sale-1').set(OVERDUE);

  process.stdout.write('[C] controls\n');
  { const r = await checkout(CLEAR, 'K-C0');
    ok(r.ok, 'C-0', 'a merchant who owes nothing completes a sale (the harness can sell at all): ' + why(r)); }
  { INJ.outage = true; const f0 = INJ.fired; let threw = false;
    try { await db.collection(LIAB).where('merchantUid', '==', OUT).get(); } catch (e) { threw = true; }
    INJ.outage = false;
    ok(threw && INJ.fired === f0 + 1, 'C-1', 'the outage injection really makes a liability query fail (positive control)'); }

  process.stdout.write('\n[G] posCompleteCheckout\n');
  { const r = await checkout(OWES, 'K-G1');
    ok(r.ok, 'G-1', 'a merchant with OVERDUE unpaid commission after 07:00 still completes the sale: ' + why(r));
    const sid = saleIdOf(r); const liab = sid ? await get(LIAB, sid) : null;
    ok(!!liab && liab.status === 'OUTSTANDING' && liab.merchantUid === OWES && liab.liabilityMinor > 0, 'G-2',
      "...and that sale's commission is STILL recorded as an outstanding liability: " + (liab ? liab.liabilityMinor + ' minor, ' + liab.status : 'none (saleId=' + sid + ')'));
    const old = await get(LIAB, 'old-sale-1');
    ok(!!old && old.status === 'OUTSTANDING' && old.liabilityMinor === 5000, 'G-3', 'the existing debt is untouched — not deleted, not settled, not changed'); }
  { INJ.outage = true; const f0 = INJ.fired; const r = await checkout(OUT, 'K-G4'); INJ.outage = false;
    ok(r.ok, 'G-4', 'a liability-ledger OUTAGE no longer stops a sale: ' + why(r) + ' (injection fired ' + (INJ.fired - f0) + 'x)'); }

  process.stdout.write('\n[R] recordPOSSale — the second door\n');
  { const r = await record(OWES);
    ok(r.ok, 'R-1', 'recordPOSSale for a merchant with overdue commission records the sale: ' + why(r));
    const sid = saleIdOf(r); const liab = sid ? await get(LIAB, sid) : null;
    ok(!!liab && liab.status === 'OUTSTANDING' && liab.liabilityMinor > 0, 'R-2', '...and its liability is still recorded: ' + (liab ? liab.liabilityMinor + ' minor' : 'none (saleId=' + sid + ')')); }
  { INJ.outage = true; const r = await record(OUT); INJ.outage = false;
    ok(r.ok, 'R-3', 'a ledger outage no longer stops recordPOSSale: ' + why(r)); }

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
