'use strict';
/**
 * CERTIFICATION — M0-1: ONE authoritative POS commission debt per sale (owner ruling 2026-09-27).
 *
 *   POS sale → proven merchant → resolve the SOK-* business (exactly one → businessId; zero / several /
 *   non-canonical / unreadable → businessUnresolved, never blocks, never drops the debt)
 *            → posCommissionLiabilities/poscomm_<saleId>   CREATED once, OUTSTANDING, 5% with the KES 10 minimum
 *            → ledger/poscomm_<saleId>                     its accounting PROJECTION, created with it, from its figures
 *
 * Runs the REAL posCompleteCheckout, recordPOSSale and pos-commission-rail against the Firestore EMULATOR.
 * Pointed at the pre-M0-1 tree (REPAIR_ROOT = export of ed57196) the checkout writes TWO independent records
 * (a liability keyed by the bare saleId, and a separately computed random-id ledger entry), carries no business.
 *
 *   D  the debt and its projection (both sale rails)        B  the canonical business, resolved or flagged
 *   I  idempotency: first create · duplicate create rejected · transaction retry under concurrency ·
 *      projection repair · checkout retry · recordPOSSale retry
 *   U  the historical production-shaped ledger row is untouched
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-m01-debt';
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

/* ── injections: a concurrency BARRIER on the debt's fast-path read, and a businesses read OUTAGE ── */
const LIAB = 'posCommissionLiabilities';
const DProto = Object.getPrototypeOf(db.doc('x/y'));
const _dGet = DProto.get;
const INJ = { barrier: null, bizOutage: false, bizFired: 0 };
DProto.get = async function (...a) {
  if (INJ.bizOutage && this.path.startsWith('businesses/')) { INJ.bizFired++; throw new Error('INJECTED businesses outage'); }
  if (INJ.barrier && this.path === INJ.barrier.path) {
    const b = INJ.barrier; b.arrived++;
    if (b.arrived >= b.n) b.release(); else await b.gate;
  }
  return _dGet.apply(this, a);
};
const QProto = Object.getPrototypeOf(db.collection('businesses').where('x', '==', 1));
const _qGet = QProto.get;
QProto.get = function (...a) {
  const coll = this._queryOptions && this._queryOptions.collectionId;
  if (INJ.bizOutage && coll === 'businesses') { INJ.bizFired++; return Promise.reject(new Error('INJECTED businesses outage')); }
  return _qGet.apply(this, a);
};
function barrier(p, n) { let release; const gate = new Promise((r) => { release = r; }); INJ.barrier = { path: p, n, arrived: 0, gate, release }; }

let PZF, PRE, RAIL, P, MA;
try {
  PZF = require(path.join(FN, 'pos-zero-friction.js')); PRE = require(path.join(FN, 'pos-retail-engine.js'));
  RAIL = require(path.join(FN, 'pos-commission-rail.js')); P = require(path.join(FN, 'pos-sale-commission.js')); MA = require(path.join(FN, 'money-authority.js'));
} catch (e) { process.stdout.write('  ✖ SETUP — ' + e.message + '\n'); process.exit(2); }

const REQ = (uid, data, token) => ({ data, auth: { uid, token: Object.assign({ uid }, token || {}) }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));
const why = (r) => (r.ok ? 'COMPLETED' : 'refused [' + r.code + ']: ' + r.msg.slice(0, 70));
const get = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };
const saleIdOf = (r) => r.ok && r.out && (r.out.saleId || (r.out.sale && r.out.sale.id) || r.out.id);
const debtsFor = async (saleId) => (await db.collection(LIAB).where('saleId', '==', String(saleId)).get()).docs;
const ledgerFor = async (saleId) => (await db.collection('ledger').where('orderId', '==', String(saleId)).get()).docs.filter((d) => d.data().type === 'pos_commission_receivable');

async function checkout(uid, merchantId, product, key, kes) {
  return res(quiet(() => PZF.posCompleteCheckout.run(REQ(uid, {
    idempotencyKey: key, merchantId, items: [{ productId: product, qty: 1, unitPrice: kes, name: 'Maize' }],
    payments: [{ method: 'cash', amount: kes }], subtotal: kes, discountTotal: 0, taxTotal: 0, grandTotal: kes }))));
}
async function record(uid, product, kes) {
  /* M0-2: recordPOSSale requires an idempotency key; each call here is a distinct request. */
  return res(quiet(() => PRE.recordPOSSale.run(REQ(uid, {
    idempotencyKey: 'rps-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10), items: [{ productId: product, name: 'Maize', qty: 1, price: kes, cost: 1 }], payment: { method: 'cash', amount: kes } }, { role: 'seller' }))));
}
const plan = (saleId, merchantUid, kes) => P.planSaleCommission({ rail: 'POS_CASH', gross: MA.fromMinor(Math.round(kes * 100)), planId: null, soldAtMs: Date.now(), saleId, merchantUid });

(async () => {
  process.stdout.write(`\nM0-1 — one authoritative POS commission debt per sale   (tree: ${ROOT})\n\n`);
  /* merchants: each shop is keyed by its owner uid, as production's till sales are */
  const M = { ONE: 'm01-one', NONE: 'm01-none', MANY: 'm01-many', LEGACY: 'm01-legacy', OUTAGE: 'm01-outage' };
  for (const m of Object.values(M)) {
    await db.collection('shops').doc(m).set({ name: 'Shop ' + m, ownerId: m });
    await db.collection('users').doc(m).set({ name: 'Owner ' + m, displayName: 'Owner ' + m, role: 'seller' });
    await db.collection('sellers').doc(m).set({ uid: m, name: 'Shop ' + m });
    await db.collection('products').doc('P_' + m).set({ name: 'Maize', price: 1000, stock: 500, trackInventory: true, sellerUid: m, shopId: m });
  }
  await db.collection('products').doc('P_CHEAP').set({ name: 'Sweets', price: 20, stock: 500, trackInventory: true, sellerUid: M.ONE, shopId: M.ONE });
  await db.collection('businesses').doc('SOK-M01-ONE').set({ ownerId: M.ONE, name: 'One Ltd', status: 'active' });
  await db.collection('businesses').doc('SOK-M01-MANY-A').set({ ownerId: M.MANY, name: 'Many A' });
  await db.collection('businesses').doc('SOK-M01-MANY-B').set({ ownerId: M.MANY, name: 'Many B' });
  await db.collection('businesses').doc(M.LEGACY).set({ ownerId: M.LEGACY, name: 'Legacy uid-keyed business' });
  await db.collection('businesses').doc('SOK-M01-OUT').set({ ownerId: M.OUTAGE, name: 'Outage Ltd' });
  /* a business sale by a member (merchantId IS the SOK business) */
  await db.collection('businesses').doc('SOK-M01-BIZ').set({ ownerId: 'm01-bizowner', name: 'Biz Ltd' });
  await db.collection('workspaceMemberships').doc('m01-staff_SOK-M01-BIZ').set({ uid: 'm01-staff', businessId: 'SOK-M01-BIZ', status: 'active', permissions: ['sales'] });
  await db.collection('users').doc('m01-staff').set({ name: 'Staff', displayName: 'Staff' });
  await db.collection('products').doc('P_BIZ').set({ name: 'Maize', price: 1000, stock: 500, trackInventory: true, sellerUid: 'm01-bizowner', shopId: 'm01-bizowner', merchantId: 'SOK-M01-BIZ' });
  /* the historical production-shaped ledger row (random id, the old check-then-set key) */
  const HIST = { type: 'pos_commission_receivable', amountCents: 1234, orderId: 'hist-sale', sellerId: 'hist-merchant', idempotencyKey: 'poscomm_hist-key', status: 'settled', category: 'pos' };
  await db.collection('ledger').doc('HISTRANDOMID0001').set(HIST);

  process.stdout.write('[D] one debt per sale, and its ledger projection\n');
  let S1;
  { const r = await checkout(M.ONE, M.ONE, 'P_' + M.ONE, 'K-D1', 1000); S1 = saleIdOf(r);
    const debt = S1 ? await get(LIAB, 'poscomm_' + S1) : null;
    ok(r.ok && !!debt && debt.status === 'OUTSTANDING' && debt.liabilityMinor === 5000 && debt.saleId === S1, 'D-1',
      'a till sale creates posCommissionLiabilities/poscomm_<saleId>, OUTSTANDING, 5% of KES 1,000 = 5000 minor: ' + (debt ? debt.status + ' ' + debt.liabilityMinor : 'no poscomm_ debt (' + why(r) + ')'));
    const debts = S1 ? await debtsFor(S1) : [];
    ok(debts.length === 1, 'D-2', 'exactly ONE debt row exists for that sale: ' + debts.length);
    const led = S1 ? await ledgerFor(S1) : [];
    const L = led[0] && led[0].data();
    ok(led.length === 1 && led[0].id === 'poscomm_' + S1 && L.amountCents === debt.liabilityMinor && L.liabilityId === 'poscomm_' + S1 && L.idempotencyKey === 'poscomm_' + S1, 'D-3',
      'exactly ONE ledger entry for the sale, and it is the PROJECTION of the debt (same id, same amount, references it): ' + led.length + ' entr' + (led.length === 1 ? 'y ' + led[0].id : 'ies ' + led.map((d) => d.id).join(','))); }
  { const r = await checkout(M.ONE, M.ONE, 'P_CHEAP', 'K-D4', 20); const sid = saleIdOf(r);
    const debt = sid ? await get(LIAB, 'poscomm_' + sid) : null;
    ok(!!debt && debt.liabilityMinor === 1000, 'D-4', 'the KES 10 minimum is unchanged: a KES 20 sale owes 1000 minor: ' + (debt ? debt.liabilityMinor : 'none (' + why(r) + ')')); }
  let R1;
  { const r = await record(M.ONE, 'P_' + M.ONE, 1000); R1 = saleIdOf(r);
    const debt = R1 ? await get(LIAB, 'poscomm_' + R1) : null; const led = R1 ? await ledgerFor(R1) : [];
    ok(r.ok && !!debt && debt.liabilityMinor === 5000 && debt.businessId === 'SOK-M01-ONE' && led.length === 1 && led[0].id === 'poscomm_' + R1, 'D-5',
      'recordPOSSale (the second door) converges on the SAME authority: one poscomm_ debt + its one projection, same business: ' + (debt ? debt.businessId + ' / ledger ' + led.length : 'no poscomm_ debt (' + why(r) + ')')); }

  process.stdout.write('\n[B] the canonical SOK-* business — resolved, or flagged and still recorded\n');
  { const debt = S1 ? await get(LIAB, 'poscomm_' + S1) : null;
    ok(!!debt && debt.businessId === 'SOK-M01-ONE' && debt.businessUnresolved === false && debt.businessResolution === 'owner-single-business', 'B-1',
      "an owner with exactly one business → the debt carries that SOK-* business: " + (debt ? debt.businessId + ' via ' + debt.businessResolution : 'none')); }
  for (const [id, m, want] of [['B-2', M.NONE, 'no-business-for-owner'], ['B-3', M.MANY, 'owner-has-multiple-businesses'], ['B-4', M.LEGACY, 'non-canonical-business-id']]) {
    const r = await checkout(m, m, 'P_' + m, 'K-' + id, 1000); const sid = saleIdOf(r);
    const debt = sid ? await get(LIAB, 'poscomm_' + sid) : null;
    ok(r.ok && !!debt && debt.businessId === null && debt.businessUnresolved === true && debt.businessResolution === want && debt.liabilityMinor === 5000, id,
      want + ' → the sale completes AND the debt is still recorded, flagged businessUnresolved: ' + (debt ? 'unresolved=' + debt.businessUnresolved + ' via ' + debt.businessResolution : 'no debt (' + why(r) + ')'));
  }
  { const r = await checkout('m01-staff', 'SOK-M01-BIZ', 'P_BIZ', 'K-B5', 1000); const sid = saleIdOf(r);
    const debt = sid ? await get(LIAB, 'poscomm_' + sid) : null;
    ok(r.ok && !!debt && debt.businessId === 'SOK-M01-BIZ' && debt.businessResolution === 'sale-merchant-is-business', 'B-5',
      'a member selling for a SOK-* business → the debt is that business\'s: ' + (debt ? debt.businessId + ' via ' + debt.businessResolution : 'no debt (' + why(r) + ')')); }
  { INJ.bizOutage = true; const f0 = INJ.bizFired;
    const w = await res(quiet(() => RAIL.recordSaleLiability(db, plan('SALE-B6', M.OUTAGE, 1000)))); INJ.bizOutage = false;
    const debt = await get(LIAB, 'poscomm_SALE-B6');
    ok(w.ok && !!debt && debt.businessUnresolved === true && debt.businessResolution === 'business-lookup-failed' && INJ.bizFired > f0, 'B-6',
      'the business lookup is UNREADABLE → the debt is still recorded (never lost), flagged: ' + (debt ? debt.businessResolution : 'none (' + (w.ok ? '' : w.msg.slice(0, 50)) + ')') + ', outage fired ' + (INJ.bizFired - f0) + 'x'); }

  process.stdout.write('\n[I] idempotency — one economic obligation, however the sale is retried\n');
  { const w = await res(RAIL.recordSaleLiability(db, plan('SALE-I1', M.ONE, 1000)));
    ok(w.ok && w.out.action === 'recorded' && w.out.id === 'poscomm_SALE-I1', 'I-1', 'FIRST successful create: action=recorded, id poscomm_<saleId>: ' + (w.ok ? w.out.action + ' ' + w.out.id : w.msg)); }
  { let code = null; try { await db.collection(LIAB).doc('poscomm_SALE-I1').create({ forged: true }); } catch (e) { code = e.code; }
    const again = await res(RAIL.recordSaleLiability(db, plan('SALE-I1', M.ONE, 999999)));   /* same sale, different figures */
    const debt = await get(LIAB, 'poscomm_SALE-I1'); const led = await ledgerFor('SALE-I1');
    ok(code === 6 && again.ok && again.out.action === 'already_recorded' && debt.liabilityMinor === 5000 && !debt.forged && led.length === 1 && led[0].data().amountCents === 5000, 'I-2',
      'DUPLICATE create is rejected (ALREADY_EXISTS) and a second record of the same sale — even with different figures — changes nothing: ' + 'create code=' + code + ', again=' + (again.ok ? again.out.action : again.msg.slice(0, 40)) + ', debt=' + debt.liabilityMinor + ', ledger=' + led.length); }
  { const p = LIAB + '/poscomm_SALE-I3'; barrier(p, 6);
    const rs = await Promise.all(Array.from({ length: 6 }, () => res(RAIL.recordSaleLiability(db, plan('SALE-I3', M.ONE, 1000)))));
    INJ.barrier = null;
    const acts = rs.map((r) => (r.ok ? r.out.action : 'ERR:' + r.msg.slice(0, 30)));
    const debts = await debtsFor('SALE-I3'); const led = await ledgerFor('SALE-I3');
    ok(rs.every((r) => r.ok) && acts.filter((a) => a === 'recorded').length === 1 && debts.length === 1 && led.length === 1, 'I-3',
      'TRANSACTION RETRY under concurrency: 6 recorders released together past the fast path → one "recorded", no error, ONE debt, ONE projection: ' + acts.join(',') + ' | debts=' + debts.length + ' ledger=' + led.length); }
  { await db.collection(LIAB).doc('poscomm_SALE-I4').create(Object.assign({}, (await get(LIAB, 'poscomm_SALE-I1')), { debtId: 'poscomm_SALE-I4', saleId: 'SALE-I4', liabilityMinor: 7777 }));
    const w = await res(RAIL.recordSaleLiability(db, plan('SALE-I4', M.ONE, 1000)));   /* the plan says 5000; the debt says 7777 */
    const led = await ledgerFor('SALE-I4');
    ok(w.ok && w.out.action === 'projection_repaired' && led.length === 1 && led[0].data().amountCents === 7777 && (await debtsFor('SALE-I4')).length === 1, 'I-4',
      'a debt whose projection is missing (a crash between the two) gets its projection FROM THE DEBT, not recomputed, and no second debt: ' + (w.ok ? w.out.action : w.msg.slice(0, 40)) + ', projection=' + (led[0] ? led[0].data().amountCents : 'none')); }
  { const r1 = await checkout(M.ONE, M.ONE, 'P_' + M.ONE, 'K-I5', 1000); const r2 = await checkout(M.ONE, M.ONE, 'P_' + M.ONE, 'K-I5', 1000);
    const s1 = saleIdOf(r1), s2 = saleIdOf(r2);
    const debts = s1 ? await debtsFor(s1) : []; const led = s1 ? await ledgerFor(s1) : [];
    ok(r1.ok && r2.ok && s1 && s1 === s2 && debts.length === 1 && led.length === 1, 'I-5',
      'CHECKOUT RETRY (same idempotency key) → the same sale, ONE debt, ONE projection: ' + (s1 === s2 ? 'same sale' : 'DIFFERENT sales ' + s1 + '/' + s2) + ', debts=' + debts.length + ', ledger=' + led.length); }
  { const w = await res(RAIL.recordSaleLiability(db, plan(R1, M.ONE, 1000)));
    ok(!!R1 && w.ok && w.out.action === 'already_recorded' && (await debtsFor(R1)).length === 1 && (await ledgerFor(R1)).length === 1, 'I-6',
      'recordPOSSale RETRY of the debt for the same sale → already_recorded, ONE debt, ONE projection: ' + (w.ok ? w.out.action : w.msg.slice(0, 40))); }
  { const r = await record(M.ONE, 'P_' + M.ONE, 1000); const sid = saleIdOf(r);
    ok(r.ok && sid && sid !== R1 && (await debtsFor(sid)).length === 1, 'I-7',
      'a NEW recordPOSSale request (a new idempotency key — M0-2) is a new sale, and it owes its own single debt — one debt per sale: ' + (sid !== R1 ? 'new sale' : 'same sale')); }

  process.stdout.write('\n[U] nothing historical is touched\n');
  { const h = await get('ledger', 'HISTRANDOMID0001');
    const noDebt = (await debtsFor('hist-sale')).length === 0;
    ok(!!h && JSON.stringify(h) === JSON.stringify(HIST) && noDebt, 'U-1', 'the historical production-shaped ledger row is unchanged and no debt is invented for it'); }
  { const gateOff = RAIL.GATE_ENFORCED === false;
    ok(gateOff, 'U-2', 'the gate stays OFF (P0) — M0-1 records debt, it does not enforce or collect: GATE_ENFORCED=' + RAIL.GATE_ENFORCED); }

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
