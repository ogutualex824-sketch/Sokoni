'use strict';
/**
 * CERTIFICATION — M0-4-DR-R: deterministic reconciliation of POS commission debts, a BACKSTOP.
 *
 * A proven, completed, commission-bearing POS sale with no poscomm_<saleId> debt is rebuilt from its OWN recorded facts
 * through the DR-A builder, create-only — or recorded NEEDS_REVIEW. Everything ambiguous goes to review; nothing is
 * defaulted, repriced or guessed. Runs the REAL sale handlers and the REAL reconciler against the Firestore EMULATOR;
 * a residual is made by taking a real sale and removing its debt (the state a pre-DR-A failure left behind).
 *
 *   D-*  dry-run: a residual of each server sale path is RECONSTRUCTABLE, and dry-run writes NOTHING
 *   X-*  execute: the SAME debt DR-A built (only createdAtMs = reconciliation time) + its projection + ONE outcome;
 *        an existing debt is never altered; a re-run and a concurrent run add nothing
 *   R-*  every unproven prerequisite → NEEDS_REVIEW with its reason (identity, sale time, route, gross, void/refund,
 *        legacy receivable, business, half-present debt); the outcome is written once, and a re-run is a no-op;
 *        a mirror sale is out of scope; a custodial sale owes nothing
 *   E-*  the rate era: the SHIPPED era (no deployment boundary yet) reconstructs nothing; a changed rate table or a sale
 *        before the boundary → review; the callable never takes an era from its caller
 *   T-*  execute re-judges INSIDE the transaction (a sale voided after evaluation → review, no debt); an injected write
 *        failure leaves neither debt nor outcome
 *   A-*  admin only; input validated
 *   P-*  the production shape (5 historical sales, one with a legacy 3% receivable) → 5 NEEDS_REVIEW, 0 reconstructed
 *   M-*  saleId → poscomm_<saleId> is one-to-one over every candidate
 *   B-*  no wallet written; the till gate still OFF
 *
 * Pointed at the pre-DR-R tree (REPAIR_ROOT = export of 91ac925) there is no reconciler: every check fails.
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const fs = require('fs');
const path = require('path');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-m04dr-r';
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 290s\n'); process.exit(3); }, 290000);

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

const ALL_IDS = ['D-1', 'D-2', 'D-3', 'X-1', 'X-2', 'X-3', 'X-4', 'X-5', 'R-1', 'R-2', 'R-3', 'R-3b', 'R-4', 'R-5', 'R-6', 'R-7', 'R-8', 'R-9',
  'R-10', 'R-11', 'R-12', 'R-13', 'N-1', 'E-1', 'E-2', 'E-3', 'E-4', 'T-1', 'T-2', 'A-1', 'A-2', 'P-1', 'M-1', 'B-1', 'B-2'];
let R;
try { R = require(path.join(FN, 'pos-debt-reconciliation.js')); } catch (e) {
  process.stdout.write(`\nM0-4-DR-R — deterministic POS debt reconciliation   (tree: ${ROOT})\n\n  no reconciler on this tree (${String(e.code || e.message).slice(0, 60)})\n`);
  for (const id of ALL_IDS) ok(false, id, 'reconciler absent');
  process.stdout.write(`\n  ${pass} pass / ${fail} fail\n`); clearTimeout(WATCHDOG); process.exit(1);
}

/* ── injections ─────────────────────────────────────────────────────────────────────────────────────────────── */
const INJ = { failDebtCreate: 0, fired: 0, beforeTxn: null };
const TxProto = require(require.resolve('@google-cloud/firestore', { paths: [FN] })).Transaction.prototype;
const _tCreate = TxProto.create;
TxProto.create = function (ref, ...a) {
  if (INJ.failDebtCreate > 0 && ref && String(ref.path).startsWith('posCommissionLiabilities/')) {
    INJ.failDebtCreate--; INJ.fired++; throw new Error('INJECTED debt write failure');
  }
  return _tCreate.call(this, ref, ...a);
};
const FsProto = Object.getPrototypeOf(db);
const _runTx = FsProto.runTransaction;
FsProto.runTransaction = async function (...a) {
  if (INJ.beforeTxn) { const f = INJ.beforeTxn; INJ.beforeTxn = null; INJ.fired++; await f(); }
  return _runTx.apply(this, a);
};
const PCFG = require(path.join(FN, 'payment-config.js'));
const _route = PCFG.resolveCollectionRoute;
let FORCE_ROUTE = null;
PCFG.resolveCollectionRoute = async function (...a) { return FORCE_ROUTE ? { route: FORCE_ROUTE } : _route.apply(this, a); };

const PZF = require(path.join(FN, 'pos-zero-friction.js'));
const PRE = require(path.join(FN, 'pos-retail-engine.js'));
const RAIL = require(path.join(FN, 'pos-commission-rail.js'));

const REQ = (uid, data) => ({ data, auth: { uid, token: { uid } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const get = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };
const size = async (c) => (await db.collection(c).get()).size;
let seq = 0;
async function checkout(uid, productId, price, extra) {
  const key = 'm4drr-' + (++seq) + '-' + Date.now();
  const o = Object.assign({ payments: [{ method: 'cash', amount: price }] }, extra || {});
  const r = await quiet(() => PZF.posCompleteCheckout.run(REQ(uid, { idempotencyKey: key, merchantId: uid,
    items: [{ productId, qty: 1, unitPrice: price, name: productId }], payments: o.payments,
    subtotal: price, discountTotal: 0, taxTotal: 0, grandTotal: price })));
  return r.saleId;
}
async function record(uid, productId, price) {
  const key = 'm4drr-r-' + (++seq) + '-' + Date.now();
  const r = await quiet(() => PRE._h.recordPOSSale({ data: { idempotencyKey: key, items: [{ productId, name: productId, qty: 1, price }],
    payment: { method: 'cash', amount: price } }, auth: { uid, token: { uid, role: 'seller' } } }));
  return r.saleId;
}
/* a residual: the real sale, its debt and projection removed (what a pre-DR-A failure left) — returns what DR-A built */
async function residual(saleId) {
  const debt = await get('posCommissionLiabilities', 'poscomm_' + saleId), led = await get('ledger', 'poscomm_' + saleId);
  await db.collection('posCommissionLiabilities').doc('poscomm_' + saleId).delete();
  await db.collection('ledger').doc('poscomm_' + saleId).delete();
  return { debt, led };
}
/* ONE sale, through the real page cursor (after = its predecessor, limit 1) */
async function one(store, saleId, mode, era) {
  const ids = (await db.collection(store).select().get()).docs.map((d) => d.id).sort();
  const i = ids.indexOf(saleId);
  const out = await quiet(() => R.reconcile(db, { mode, store, era, limit: 1, after: i > 0 ? ids[i - 1] : undefined, actorUid: 'm4drr-admin' }));
  const r = out.results[0] || {};
  if (r.saleId !== saleId) throw new Error('cursor did not land on ' + saleId + ' (got ' + r.saleId + ')');
  return r;
}
const TEST_ERA = { id: 'TEST-ERA', rateTableSha256: R.rateTableFingerprint(), fromSoldAtMs: 1 };
const same = (a, b, skip) => { const k = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]); for (const s of skip) k.delete(s);
  return [...k].every((x) => JSON.stringify(a[x]) === JSON.stringify(b[x])); };
const writesSnapshot = async () => [await size('posCommissionLiabilities'), await size('ledger'), await size(R.OUTCOMES)].join('/');

(async () => {
  process.stdout.write(`\nM0-4-DR-R — deterministic POS debt reconciliation   (tree: ${ROOT})\n\n`);
  const O = 'm4drr-owner', U = 'm4drr-nobiz';
  for (const u of [O, U]) {
    await db.collection('shops').doc(u).set({ name: 'Shop ' + u, ownerId: u });
    await db.collection('users').doc(u).set({ name: u, displayName: u });
    await db.collection('sellers').doc(u).set({ name: 'Seller ' + u });
  }
  await db.collection('businesses').doc('SOK-DRR-O').set({ ownerId: O, status: 'active', name: 'DRR Owner Business' });
  const P = (id, owner) => db.collection('products').doc(id).set({ name: id, price: 100, stock: 500, trackInventory: true, sellerUid: owner, shopId: owner });
  for (let i = 1; i <= 16; i++) await P('DRR_' + i, O);
  await P('DRR_U1', U);

  /* ── the residuals and the specimens ─────────────────────────────────────────────────────────────────────── */
  const c1 = await checkout(O, 'DRR_1', 100); const c1orig = await residual(c1);
  const r1 = await record(O, 'DRR_2', 100);   const r1orig = await residual(r1);
  const cKeep = await checkout(O, 'DRR_3', 100);                                   /* keeps its debt */
  const cRace = await checkout(O, 'DRR_4', 100); await residual(cRace);
  const cNoSold = await checkout(O, 'DRR_5', 100); await residual(cNoSold);
  await db.collection('posRetailSales').doc(cNoSold).update({ soldAtMs: admin.firestore.FieldValue.delete() });
  const cNoRoute = await checkout(O, 'DRR_6', 100); await residual(cNoRoute);
  await db.collection('posRetailSales').doc(cNoRoute).update({ collectionRoute: 'SOMETHING_ELSE' });
  const cVoid = await checkout(O, 'DRR_7', 100); await residual(cVoid);
  await db.collection('posRetailSales').doc(cVoid).update({ status: 'voided' });
  const cRefundRec = await checkout(O, 'DRR_8', 100); await residual(cRefundRec);
  await db.collection('posRefunds').doc('rf_drr_' + cRefundRec.slice(3, 12)).set({ saleId: cRefundRec, merchantId: O, amount: 50 });
  const cLegacy = await checkout(O, 'DRR_9', 100); await residual(cLegacy);
  await db.collection('ledger').doc('legacy_drr_' + cLegacy.slice(3, 12)).set({ type: 'pos_commission_receivable', orderId: cLegacy, amountCents: 300, createdBy: 'posCompleteCheckout' });
  const cNoBiz = await checkout(U, 'DRR_U1', 100); await residual(cNoBiz);
  const cHalfLed = await checkout(O, 'DRR_10', 100);
  await db.collection('posCommissionLiabilities').doc('poscomm_' + cHalfLed).delete();                       /* ledger, no debt */
  const cHalfDebt = await checkout(O, 'DRR_11', 100); const halfDebtBefore = await get('posCommissionLiabilities', 'poscomm_' + cHalfDebt);
  await db.collection('ledger').doc('poscomm_' + cHalfDebt).delete();                                         /* debt, no ledger */
  await db.collection('posPayments').doc('DRRREF1').set({ transactionId: 'DRRREF1', status: 'paid', sellerId: O, paidAmount: 100, total: 100 });
  FORCE_ROUTE = 'CENTRAL_MOR';
  const cCustodial = await checkout(O, 'DRR_12', 100, { payments: [{ method: 'mpesa', amount: 100, ref: 'DRRREF1' }] }); FORCE_ROUTE = null;
  const cEra = await checkout(O, 'DRR_13', 100); await residual(cEra);            /* for the shipped-era execute */
  const cT1 = await checkout(O, 'DRR_14', 100); await residual(cT1);
  const cT2 = await checkout(O, 'DRR_15', 100); await residual(cT2);
  const rNoClaim = await record(O, 'DRR_16', 100); await residual(rNoClaim);
  const claimNoClaim = (await db.collection('posRecordSaleClaims').where('saleId', '==', rNoClaim).get()).docs[0];
  await claimNoClaim.ref.delete();
  const rGross = await record(O, 'DRR_16', 100); await residual(rGross);
  const rOther = await record(O, 'DRR_16', 100); await residual(rOther);
  await (await db.collection('posRecordSaleClaims').where('saleId', '==', rOther).get()).docs[0].ref.update({ sellerId: 'm4drr-someone-else' });
  await db.collection('posSales').doc(rGross).update({ total: 999 });
  /* not server sales */
  const mirrorId = 'MIRRORdrr00000000001';
  await db.collection('posRetailSales').doc(mirrorId).set({ id: mirrorId, merchantId: O, sellerId: O, status: 'completed', grandTotal: 100, source: 'pos-mirror', payments: [{ method: 'cash' }] });
  const forgedId = 'ps_' + '0'.repeat(40);
  await db.collection('posRetailSales').doc(forgedId).set(Object.assign({}, await get('posRetailSales', cKeep), { id: forgedId }));
  /* the production shape (census 2026-09-28): auto ids, completed, no soldAtMs, no key; one CASH_IN_DRAWER + a legacy receivable */
  const prodIds = ['CoJjrqRIc5RtJPVGOX1x', 'XmovY1eWnrbQydz4Nqzx', 'd8JnUACuDyAHmmqCAR9x', 'h3KAd3x7ygYXhYkpWCrx', 'mkHDKSm1oeIC1E4uXGXx'];
  for (const id of prodIds) {
    await db.collection('posRetailSales').doc(id).set(Object.assign({ id, merchantId: O, sellerId: O, status: 'completed', grandTotal: 350, createdAt: new Date('2026-08-23T12:00:00Z') },
      id.startsWith('Xmov') ? { collectionRoute: 'CASH_IN_DRAWER', financialPosting: 'posted' } : {}));
  }
  await db.collection('ledger').doc('legacy_prod_xmov').set({ type: 'pos_commission_receivable', orderId: prodIds[1], amountCents: 10500, createdBy: 'posCompleteCheckout' });

  /* ── D: dry-run ─────────────────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('[D] dry-run — evaluate and report, write nothing\n');
  { const before = await writesSnapshot();
    const a = await one('posRetailSales', c1, 'dry_run', TEST_ERA), b = await one('posSales', r1, 'dry_run', TEST_ERA);
    ok(a.verdict === 'RECONSTRUCTABLE', 'D-1', `a checkout residual (proven, completed, cash, in era, no debt) is RECONSTRUCTABLE: ${a.verdict} ${a.reason || ''}`);
    ok(b.verdict === 'RECONSTRUCTABLE', 'D-2', `a recordPOSSale residual (claim-proven) is RECONSTRUCTABLE: ${b.verdict} ${b.reason || ''}`);
    const full = []; for (const st of ['posRetailSales', 'posSales']) { let after; do { const o = await quiet(() => R.reconcile(db, { mode: 'dry_run', store: st, era: TEST_ERA, limit: 7, after })); full.push(...o.results); after = o.next; } while (after); }
    const after = await writesSnapshot();
    ok(before === after && !(await get('posCommissionLiabilities', 'poscomm_' + c1)) && full.length > 20, 'D-3',
      `a dry-run over BOTH stores (${full.length} sales, paged) writes nothing — debts/ledger/outcomes ${before} → ${after}`); }

  /* ── X: execute ─────────────────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[X] execute — the same DR-A debt, create-only, one outcome\n');
  { const t0 = Date.now();
    const a = await one('posRetailSales', c1, 'execute', TEST_ERA);
    const d = await get('posCommissionLiabilities', 'poscomm_' + c1), l = await get('ledger', 'poscomm_' + c1), oc = await get(R.OUTCOMES, 'poscomm_' + c1);
    ok(a.verdict === 'RECONSTRUCTED' && d && same(d, c1orig.debt, ['createdAtMs']) && d.createdAtMs >= t0 && d.createdAtMs !== d.soldAtMs
      && same(l, c1orig.led, ['createdAt']) && oc && oc.verdict === 'RECONSTRUCTED' && oc.debtCreatedAtMs === d.createdAtMs, 'X-1',
      `checkout residual → the debt DR-A built, field for field (createdAtMs = reconciliation time ${d && d.createdAtMs >= t0}), its projection, one RECONSTRUCTED outcome: ${a.verdict}`);
    const b = await one('posSales', r1, 'execute', TEST_ERA);
    const d2 = await get('posCommissionLiabilities', 'poscomm_' + r1);
    ok(b.verdict === 'RECONSTRUCTED' && d2 && same(d2, r1orig.debt, ['createdAtMs']) && same(await get('ledger', 'poscomm_' + r1), r1orig.led, ['createdAt']), 'X-2',
      `recordPOSSale residual → the same debt from the claim's immutable facts: ${b.verdict}`);
    const snap = JSON.stringify(d);
    const again = await one('posRetailSales', c1, 'execute', TEST_ERA);
    ok(again.verdict === 'DEBT_PRESENT' && JSON.stringify(await get('posCommissionLiabilities', 'poscomm_' + c1)) === snap, 'X-3',
      `a re-run finds the debt and changes nothing: ${again.verdict}`); }
  { const before = JSON.stringify(await get('posCommissionLiabilities', 'poscomm_' + cKeep));
    const a = await one('posRetailSales', cKeep, 'execute', TEST_ERA);
    ok(a.verdict === 'DEBT_PRESENT' && JSON.stringify(await get('posCommissionLiabilities', 'poscomm_' + cKeep)) === before && !(await get(R.OUTCOMES, 'poscomm_' + cKeep)), 'X-4',
      `an existing debt is never altered and gets no outcome: ${a.verdict}`); }
  { const ids = (await db.collection('posRetailSales').select().get()).docs.map((d) => d.id).sort();
    const i = ids.indexOf(cRace);
    const go = () => quiet(() => R.reconcile(db, { mode: 'execute', store: 'posRetailSales', era: TEST_ERA, limit: 1, after: ids[i - 1], actorUid: 'x' })).then((o) => o.results[0].verdict, (e) => 'ERR ' + e.message);
    const v = await Promise.all([go(), go()]);
    ok((await db.collection('posCommissionLiabilities').where('saleId', '==', cRace).get()).size === 1 && (await db.collection(R.OUTCOMES).where('saleId', '==', cRace).get()).size === 1, 'X-5',
      `two concurrent executes on one residual → one debt, one outcome (${v.join(' / ')})`); }

  /* ── R: every unproven prerequisite is reviewed, never guessed ───────────────────────────────────────────── */
  process.stdout.write('\n[R] unproven → NEEDS_REVIEW (execute records it; no debt)\n');
  const rev = async (store, id, reason, idc, what) => {
    const r = await one(store, id, 'execute', TEST_ERA);
    const oc = await get(R.OUTCOMES, 'poscomm_' + id);
    ok(r.verdict === 'NEEDS_REVIEW' && r.reason === reason && !(await get('posCommissionLiabilities', 'poscomm_' + id) && reason !== 'PROJECTION_MISSING')
      && oc && oc.verdict === 'NEEDS_REVIEW' && oc.reason === reason, idc, `${what} → ${r.verdict} ${r.reason || ''}`);
  };
  { const r = await one('posRetailSales', mirrorId, 'execute', TEST_ERA);
    ok(r.verdict === 'OUT_OF_SCOPE' && r.reason === 'MIRROR_SALE' && !(await get(R.OUTCOMES, 'poscomm_' + mirrorId)) && !(await get('posCommissionLiabilities', 'poscomm_' + mirrorId)), 'R-1',
      `a SmartPOS mirror sale is not a server sale: out of scope, nothing written → ${r.verdict}`); }
  await rev('posRetailSales', forgedId, 'SALE_IDENTITY_UNPROVEN', 'R-2', 'a sale whose id does not re-derive from its own merchant + key');
  await rev('posSales', rNoClaim, 'SALE_IDENTITY_UNPROVEN', 'R-3', 'a posSales record with no M0-2 claim');
  await rev('posSales', rOther, 'SALE_IDENTITY_UNPROVEN', 'R-3b', 'a posSales record whose claim names ANOTHER seller');
  await rev('posRetailSales', cNoSold, 'SOLD_AT_MISSING', 'R-4', 'no soldAtMs (createdAt is NOT promoted into a sale time)');
  await rev('posRetailSales', cNoRoute, 'ROUTE_UNPROVEN', 'R-5', 'an unrecognised route (never defaulted to TILL_DIRECT)');
  await rev('posRetailSales', cVoid, 'SALE_VOIDED_OR_REFUNDED', 'R-6', 'a voided sale (M0-5 decides reversal economics)');
  await rev('posRetailSales', cRefundRec, 'SALE_VOIDED_OR_REFUNDED', 'R-7', 'a posRefunds record for a sale still marked completed');
  await rev('posRetailSales', cLegacy, 'LEGACY_RECEIVABLE_PRESENT', 'R-8', 'a legacy pos_commission_receivable already bills it (no double charge)');
  await rev('posRetailSales', cNoBiz, 'BUSINESS_UNRESOLVED', 'R-9', 'a merchant with no resolvable business');
  await rev('posRetailSales', cHalfLed, 'LEDGER_WITHOUT_DEBT', 'R-10', 'a ledger projection with no debt');
  { const r = await one('posRetailSales', cHalfDebt, 'execute', TEST_ERA);
    ok(r.verdict === 'NEEDS_REVIEW' && r.reason === 'PROJECTION_MISSING' && JSON.stringify(await get('posCommissionLiabilities', 'poscomm_' + cHalfDebt)) === JSON.stringify(halfDebtBefore)
      && !(await get('ledger', 'poscomm_' + cHalfDebt)), 'R-11', `a debt without its projection → review, the debt NOT altered, no projection invented → ${r.verdict} ${r.reason}`);
    const g = await one('posSales', rGross, 'dry_run', TEST_ERA);
    ok(g.verdict === 'NEEDS_REVIEW' && g.reason === 'GROSS_UNPROVEN', 'R-12', `…and a sale total that disagrees with its claim's gross → ${g.verdict} ${g.reason}`); }
  { const before = JSON.stringify(await get(R.OUTCOMES, 'poscomm_' + cVoid));
    const r = await one('posRetailSales', cVoid, 'execute', TEST_ERA).catch((e) => ({ verdict: 'ERR ' + String(e.message).slice(0, 60) }));
    ok(r.verdict === 'OUTCOME_ALREADY_RECORDED' && r.prior === 'NEEDS_REVIEW' && JSON.stringify(await get(R.OUTCOMES, 'poscomm_' + cVoid)) === before
      && !(await get('posCommissionLiabilities', 'poscomm_' + cVoid)), 'R-13',
      `re-executing a reviewed sale is a quiet no-op: the outcome is written ONCE and never rewritten → ${r.verdict} (prior ${r.prior})`); }
  { const before = await writesSnapshot();
    const r = await one('posRetailSales', cCustodial, 'execute', TEST_ERA);
    ok(r.verdict === 'NOT_OWED' && before === await writesSnapshot(), 'N-1', `a custodial sale owes no debt: ${r.verdict} ${r.reason || ''}, nothing written`); }

  /* ── E: the rate era ──────────────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[E] the rate era — never reprice history\n');
  { const shipped = await one('posRetailSales', cEra, 'dry_run', undefined);
    ok(R.RATE_ERA.fromSoldAtMs === null && shipped.verdict === 'NEEDS_REVIEW' && shipped.reason === 'RATE_ERA_UNPROVEN', 'E-1',
      `the SHIPPED era has no deployment boundary yet → an otherwise-eligible residual is reviewed, not rebuilt: ${shipped.verdict} ${shipped.reason}`);
    const moved = await one('posRetailSales', cEra, 'dry_run', Object.assign({}, TEST_ERA, { rateTableSha256: 'f'.repeat(64) }));
    ok(moved.verdict === 'NEEDS_REVIEW' && moved.reason === 'RATE_ERA_UNPROVEN', 'E-2', `a rate table that is not the era's (fingerprint mismatch) → ${moved.verdict} ${moved.reason}`);
    const s = await get('posRetailSales', cEra);
    const early = await one('posRetailSales', cEra, 'dry_run', Object.assign({}, TEST_ERA, { fromSoldAtMs: s.soldAtMs + 1 }));
    ok(early.verdict === 'NEEDS_REVIEW' && early.reason === 'RATE_ERA_UNPROVEN', 'E-3', `a sale sold before the era boundary → ${early.verdict} ${early.reason}`);
    const ids = (await db.collection('posRetailSales').select().get()).docs.map((d) => d.id).sort();
    const out = await quiet(() => R._h.reconcilePosSaleDebts({ auth: { uid: 'm4drr-admin', token: { admin: true } },
      data: { mode: 'execute', store: 'posRetailSales', limit: 1, after: ids[ids.indexOf(cEra) - 1], era: TEST_ERA, rateEra: TEST_ERA } }));
    const r = out.results[0] || {};
    ok(r.saleId === cEra && r.verdict === 'NEEDS_REVIEW' && r.reason === 'RATE_ERA_UNPROVEN' && !(await get('posCommissionLiabilities', 'poscomm_' + cEra)) && out.rateEra.established === false, 'E-4',
      `the callable uses the shipped era and IGNORES an era the caller sends → ${r.verdict} ${r.reason}, no debt`); }

  /* ── T: execute re-judges inside the transaction ──────────────────────────────────────────────────────────── */
  process.stdout.write('\n[T] the transaction decides, not the earlier evaluation\n');
  { INJ.fired = 0; INJ.beforeTxn = () => db.collection('posRetailSales').doc(cT1).update({ status: 'voided' });
    const r = await one('posRetailSales', cT1, 'execute', TEST_ERA);
    const oc = await get(R.OUTCOMES, 'poscomm_' + cT1);
    ok(INJ.fired === 1 && r.verdict === 'NEEDS_REVIEW' && r.reason === 'SALE_VOIDED_OR_REFUNDED' && !(await get('posCommissionLiabilities', 'poscomm_' + cT1))
      && oc && oc.evaluatedVerdict === 'RECONSTRUCTABLE' && oc.changedSinceEvaluation === true, 'T-1',
      `evaluated RECONSTRUCTABLE, voided before the transaction → the transaction reviews it, no debt (evaluated ${oc && oc.evaluatedVerdict}, changed ${oc && oc.changedSinceEvaluation})`); }
  { INJ.fired = 0; INJ.failDebtCreate = 1;
    let threw = false; try { await one('posRetailSales', cT2, 'execute', TEST_ERA); } catch (e) { threw = /INJECTED/.test(String(e.message)); }
    INJ.failDebtCreate = 0;
    ok(INJ.fired === 1 && threw && !(await get('posCommissionLiabilities', 'poscomm_' + cT2)) && !(await get('ledger', 'poscomm_' + cT2)) && !(await get(R.OUTCOMES, 'poscomm_' + cT2)), 'T-2',
      'a debt write that fails inside the transaction → no debt, no projection, no outcome (all or nothing)'); }

  /* ── A: authority and input ──────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[A] admin only\n');
  { const call = (auth, data) => quiet(() => R._h.reconcilePosSaleDebts({ auth, data })).then(() => 'ok', (e) => e.code);
    const a = await call({ uid: O, token: { uid: O } }, { store: 'posRetailSales' }), b = await call(null, { store: 'posRetailSales' });
    ok(a === 'permission-denied' && b === 'unauthenticated', 'A-1', `a merchant → ${a}; signed out → ${b}`);
    const c = await call({ uid: 'a', token: { admin: true } }, { store: 'orders' }), d = await call({ uid: 'a', token: { admin: true } }, { store: 'posRetailSales', mode: 'fix' }),
      e = await call({ uid: 'a', token: { admin: true } }, { store: 'posRetailSales', limit: 5000 });
    ok(c === 'invalid-argument' && d === 'invalid-argument' && e === 'invalid-argument', 'A-2', `another store → ${c}; unknown mode → ${d}; unbounded page → ${e}`); }

  /* ── P: the production shape ─────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[P] production shape — 5 historical sales\n');
  { const res = []; for (const id of prodIds) res.push(await one('posRetailSales', id, 'execute', TEST_ERA));
    const debts = (await Promise.all(prodIds.map((id) => get('posCommissionLiabilities', 'poscomm_' + id)))).filter(Boolean).length;
    const outs = (await Promise.all(prodIds.map((id) => get(R.OUTCOMES, 'poscomm_' + id)))).filter((o) => o && o.verdict === 'NEEDS_REVIEW').length;
    ok(res.every((r) => r.verdict === 'NEEDS_REVIEW') && debts === 0 && outs === 5, 'P-1',
      `even under an OPEN era: 5 → NEEDS_REVIEW (${res.map((r) => r.reason).join(', ')}), 0 reconstructed, 5 outcomes`); }

  /* ── M / B ───────────────────────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[M/B] mapping and boundaries\n');
  { const debts = (await db.collection('posCommissionLiabilities').get()).docs;
    const outs = (await db.collection(R.OUTCOMES).get()).docs;
    const ids = new Set(debts.map((d) => d.data().saleId));
    ok(debts.every((d) => d.id === RAIL.debtIdFor(d.data().saleId)) && ids.size === debts.length && outs.every((o) => o.id === 'poscomm_' + o.data().saleId), 'M-1',
      `every debt and outcome is keyed poscomm_<its saleId>, one per sale (${debts.length} debts, ${outs.length} outcomes)`); }
  { let w = 0; for (const c of ['wallets', 'businessWallets', 'walletTransactions']) w += await size(c);
    ok(w === 0, 'B-1', `no wallet of any kind was written: ${w}`);
    ok(RAIL.GATE_ENFORCED === false, 'B-2', `the till gate is still OFF (P0): GATE_ENFORCED=${RAIL.GATE_ENFORCED}`); }

  process.stdout.write(`\n  ${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG); process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('\n  ✖ CRASH ' + (e && e.stack || e) + '\n'); process.stdout.write(`\n  ${pass} pass / ${fail + 1} fail\n`); process.exit(1); });
