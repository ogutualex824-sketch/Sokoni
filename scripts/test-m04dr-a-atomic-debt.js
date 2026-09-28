'use strict';
/**
 * CERTIFICATION — M0-4-DR-A: a POS sale and its commission debt commit TOGETHER, or not at all.
 *
 * Both server sale paths (posCompleteCheckout, recordPOSSale) wrote the debt AFTER the sale committed, best-effort:
 * a failed debt write left a completed sale with no debt (and posCompleteCheckout's retry never repaired it, because
 * completion then marked the key complete). The debt is now planned from the sale's own facts before the transaction
 * and created INSIDE it (pos-commission-rail prepareSaleDebt / applySaleDebtInTxn, one pure builder buildDebt).
 *
 * Runs the REAL handlers against the Firestore EMULATOR. Failures are INJECTED at the exact write (a debt create
 * inside the sale's transaction), or at the planning step, so the both-or-neither property is exercised, not assumed.
 *
 *   C-*  posCompleteCheckout: success → one sale + one debt + one ledger projection, dated by the SALE; a debt write
 *        that fails → no sale, no receipt, no debt, no ledger, stock untouched; a planning failure → nothing
 *        recorded; a custodial sale → still no debt; a late failure after the commit → the debt already exists and a
 *        retry adds nothing; a concurrent same-key re-entry → still one debt
 *   R-*  recordPOSSale: the same both-or-neither property inside its one M0-2 transaction
 *   K-*  every business category found in the repository (parsed from its category sources at run time) takes the
 *        SAME debt authority: one debt per sale, one rate, one rail, one schema — category is metadata only
 *   B-*  boundaries: no wallet written; the till gate still OFF
 *
 * Pointed at the pre-M0-4-DR-A tree (REPAIR_ROOT = export of 97b5d76), the injected failures leave a completed sale
 * with no debt.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const fs = require('fs');
const path = require('path');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
const REPO = path.resolve(__dirname, '..');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-m04dr-a';
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

/* ── injections ─────────────────────────────────────────────────────────────────────────────────────────────── */
const INJ = { failDebtCreate: 0, failPlan: 0, failComplete: 0, fired: 0 };
const TxProto = require(require.resolve('@google-cloud/firestore', { paths: [FN] })).Transaction.prototype;
const _tCreate = TxProto.create;
TxProto.create = function (ref, ...a) {
  if (INJ.failDebtCreate > 0 && ref && String(ref.path).startsWith('posCommissionLiabilities/')) {
    INJ.failDebtCreate--; INJ.fired++; throw new Error('INJECTED debt write failure');
  }
  return _tCreate.call(this, ref, ...a);
};
const refProto = Object.getPrototypeOf(db.doc('x/y'));
const _rSet = refProto.set, _rUpdate = refProto.update;
const lateFail = function (orig) { return function (...a) {
  if (INJ.failComplete > 0 && this.path.startsWith('posIdempotency/') && a[0] && a[0].status === 'complete') {
    INJ.failComplete--; INJ.fired++; return Promise.reject(new Error('INJECTED late failure'));
  }
  return orig.apply(this, a);
}; };
refProto.set = lateFail(_rSet); refProto.update = lateFail(_rUpdate);
const PSC = require(path.join(FN, 'pos-sale-commission.js'));
const _plan = PSC.planSaleCommission;
PSC.planSaleCommission = function (...a) { if (INJ.failPlan > 0) { INJ.failPlan--; INJ.fired++; throw new Error('INJECTED planning failure'); } return _plan.apply(this, a); };
/* custody: route the non-cash sale of C-6 through the platform's central collection (SOKONI holds the money) */
const PCFG = require(path.join(FN, 'payment-config.js'));
const _route = PCFG.resolveCollectionRoute;
let FORCE_ROUTE = null;
PCFG.resolveCollectionRoute = async function (...a) { return FORCE_ROUTE ? { route: FORCE_ROUTE } : _route.apply(this, a); };

const PZF = require(path.join(FN, 'pos-zero-friction.js'));
const PRE = require(path.join(FN, 'pos-retail-engine.js'));
const RAIL = require(path.join(FN, 'pos-commission-rail.js'));
const SA = require(path.join(FN, 'commission-settlement-authority.js'));

const REQ = (uid, data) => ({ data, auth: { uid, token: { uid } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const get = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };
const stockOf = async (id) => Number(((await get('products', id)) || {}).stock);
const count = async (c, f, v) => (await db.collection(c).where(f, '==', v).get()).size;
let seq = 0;
async function checkout(uid, merchantId, productId, price, extra) {
  const key = 'm4dra-' + (++seq) + '-' + Date.now();
  const o = Object.assign({ payments: [{ method: 'cash', amount: price }] }, extra || {});
  try {
    const r = await quiet(() => PZF.posCompleteCheckout.run(REQ(uid, { idempotencyKey: key, merchantId,
      items: [{ productId, qty: 1, unitPrice: price, name: productId }], payments: o.payments,
      subtotal: price, discountTotal: 0, taxTotal: 0, grandTotal: price })));
    return { ok: true, key, saleId: r && r.saleId };
  } catch (e) { return { ok: false, key, code: e.code, msg: String(e.message || '').slice(0, 90) }; }
}
async function record(uid, productId, price) {
  const key = 'm4dra-r-' + (++seq) + '-' + Date.now();
  try {
    const r = await quiet(() => PRE._h.recordPOSSale({ data: { idempotencyKey: key, items: [{ productId, name: productId, qty: 1, price }],
      payment: { method: 'cash', amount: price } }, auth: { uid, token: { uid, role: 'seller' } } }));
    return { ok: true, key, saleId: r && r.saleId };
  } catch (e) { return { ok: false, key, code: e.code, msg: String(e.message || '').slice(0, 90) }; }
}
const why = (r) => (r.ok ? 'SOLD' : 'refused [' + r.code + ']: ' + r.msg);

/* categories, parsed from the repository's own category sources (never a hand-kept list here) */
function repoCategories() {
  const out = new Set();
  const add = (s) => { const k = String(s || '').trim().toLowerCase(); if (k && k.length < 60 && !/^all$/.test(k)) out.add(k); };
  const read = (p) => { try { return fs.readFileSync(path.join(REPO, p), 'utf8'); } catch (_) { return ''; } };
  const bb = read('functions/business-bootstrap.js');
  const td = bb.slice(bb.indexOf('const _TYPE_DEFAULTS'), bb.indexOf('function _typeDefaults'));
  for (const m of td.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)) add(m[1]);
  const cj = read('category.js'); const cm = cj.slice(cj.indexOf('const categoryMeta'), cj.indexOf('};', cj.indexOf('const categoryMeta')));
  for (const m of cm.matchAll(/^\s*([a-z_]+):\s*\{\s*title/gm)) add(m[1]);
  for (const f of ['functions/event-hub.js', 'functions/education.js', 'functions/jobs.js', 'functions/entertainment-hub.js', 'functions/digital-hub.js']) {
    const s = read(f); const i = s.search(/const (VALID_CATEGORIES|ENT_CATEGORIES|DIGITAL_CATEGORIES) *= *\[/);
    if (i >= 0) { const arr = s.slice(i, s.indexOf('];', i)); for (const m of arr.matchAll(/['"]([^'"\n]{2,40})['"]/g)) add(m[1]); }
  }
  const doc = read('docs/CATEGORY_LAUNCH_TARGETS.md');
  for (const m of doc.matchAll(/^\| ([A-Z][^|]{1,40}?) \| \d/gm)) add(m[1]);
  return [...out];
}

(async () => {
  process.stdout.write(`\nM0-4-DR-A — a POS sale and its commission debt commit together, or not at all   (tree: ${ROOT})\n\n`);
  const O = 'm4dra-owner';
  await db.collection('shops').doc(O).set({ name: 'Owner Shop', ownerId: O });
  await db.collection('users').doc(O).set({ name: 'Owner', displayName: 'Owner' });
  await db.collection('sellers').doc(O).set({ name: 'Owner Seller' });
  const P = (id, price, owner) => db.collection('products').doc(id).set({ name: id, price, stock: 50, trackInventory: true, sellerUid: owner, shopId: owner });
  for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'R1', 'R2']) await P('M4_' + id, 100, O);

  process.stdout.write('[C] posCompleteCheckout\n');
  { const r = await checkout(O, O, 'M4_A1', 100);
    const sale = r.ok ? await get('posRetailSales', r.saleId) : null, debt = r.ok ? await get('posCommissionLiabilities', 'poscomm_' + r.saleId) : null;
    const led = r.ok ? await get('ledger', 'poscomm_' + r.saleId) : null;
    ok(r.ok && sale && debt && led && (await count('posCommissionLiabilities', 'saleId', r.saleId)) === 1, 'C-1',
      'a cash sale commits with exactly one debt and one ledger projection: ' + why(r));
    ok(!!(sale && debt && sale.soldAtMs && debt.soldAtMs === sale.soldAtMs && debt.settlementDay === SA.settlementDayFor(sale.soldAtMs)), 'C-2',
      `the debt is dated by the SALE (debt.soldAtMs ${debt && debt.soldAtMs} = sale.soldAtMs ${sale && sale.soldAtMs}; day ${debt && debt.settlementDay})`); }
  { INJ.fired = 0; INJ.failDebtCreate = 1; const s0 = await stockOf('M4_A2');
    const r = await checkout(O, O, 'M4_A2', 100); INJ.failDebtCreate = 0;
    const sales = await count('posRetailSales', 'idempotencyKey', r.key);
    const debts = (await db.collection('posCommissionLiabilities').where('merchantUid', '==', O).get()).docs.filter((d) => d.data().saleId && d.data().saleId !== undefined).length;
    ok(INJ.fired === 1 && !r.ok && sales === 0 && (await stockOf('M4_A2')) === s0, 'C-3',
      `a debt write that fails INSIDE the sale's commit takes the sale with it: no sale, stock untouched (injection fired ${INJ.fired}x, sales ${sales}, stock ${s0}→${await stockOf('M4_A2')}): ${why(r)}`);
    ok(!r.ok && debts === 1, 'C-3b', `…and no debt, receipt or ledger row was left behind (debts for this merchant: ${debts}, only C-1's)`); }
  { INJ.fired = 0; INJ.failPlan = 1; const s0 = await stockOf('M4_A3');
    const r = await checkout(O, O, 'M4_A3', 100); INJ.failPlan = 0;
    ok(INJ.fired === 1 && !r.ok && (await count('posRetailSales', 'idempotencyKey', r.key)) === 0 && (await stockOf('M4_A3')) === s0, 'C-4',
      `a debt that cannot be PLANNED → the sale is not recorded at all (never a sale without its debt): ${why(r)}`); }
  { await db.collection('posPayments').doc('M4REF1').set({ transactionId: 'M4REF1', status: 'paid', sellerId: O, paidAmount: 100, total: 100 });
    FORCE_ROUTE = 'CENTRAL_MOR';
    const r = await checkout(O, O, 'M4_A4', 100, { payments: [{ method: 'mpesa', amount: 100, ref: 'M4REF1' }] }); FORCE_ROUTE = null;
    const sale = r.ok ? await get('posRetailSales', r.saleId) : null;
    ok(r.ok && sale && sale.collectionRoute === 'CENTRAL_MOR' && !(await get('posCommissionLiabilities', 'poscomm_' + r.saleId)), 'C-5',
      `a CUSTODIAL sale (SOKONI collected the money) still creates no debt: ${why(r)}; route ${sale && sale.collectionRoute}`); }
  { INJ.fired = 0; INJ.failComplete = 1;
    const r = await checkout(O, O, 'M4_A5', 100); INJ.failComplete = 0;
    const sales = (await db.collection('posRetailSales').where('idempotencyKey', '==', r.key).get()).docs;
    const saleId = sales[0] && sales[0].id;
    const debtBefore = saleId ? await get('posCommissionLiabilities', 'poscomm_' + saleId) : null;
    ok(INJ.fired === 1 && !r.ok && sales.length === 1 && !!debtBefore, 'C-6',
      'a late failure AFTER the commit (completion never finished): the debt ALREADY exists — it committed with the sale');
    const retry = await quiet(() => PZF.posCompleteCheckout.run(REQ(O, { idempotencyKey: r.key, merchantId: O,
      items: [{ productId: 'M4_A5', qty: 1, unitPrice: 100, name: 'M4_A5' }], payments: [{ method: 'cash', amount: 100 }],
      subtotal: 100, discountTotal: 0, taxTotal: 0, grandTotal: 100 }))).then(() => true, () => false);
    ok(retry && saleId && (await count('posCommissionLiabilities', 'saleId', saleId)) === 1
      && (await get('posCommissionLiabilities', 'poscomm_' + saleId)).soldAtMs === (await get('posRetailSales', saleId)).soldAtMs, 'C-7',
      '…and the retry completes the sale without a second debt; the debt keeps the sale\'s own date'); }
  { const key = 'm4dra-race-' + Date.now();
    const go = () => quiet(() => PZF.posCompleteCheckout.run(REQ(O, { idempotencyKey: key, merchantId: O,
      items: [{ productId: 'M4_A6', qty: 1, unitPrice: 100, name: 'M4_A6' }], payments: [{ method: 'cash', amount: 100 }],
      subtotal: 100, discountTotal: 0, taxTotal: 0, grandTotal: 100 }))).then((x) => x, () => null);
    await Promise.all([go(), go()]);
    const sales = (await db.collection('posRetailSales').where('idempotencyKey', '==', key).get()).docs;
    ok(sales.length === 1 && (await count('posCommissionLiabilities', 'saleId', sales[0].id)) === 1, 'C-8',
      `two concurrent calls with one key → one sale, one debt (sales ${sales.length})`); }

  process.stdout.write('\n[R] recordPOSSale\n');
  { const r = await record(O, 'M4_R1', 100);
    const claim = r.ok ? (await db.collection('posRecordSaleClaims').where('saleId', '==', r.saleId).get()).docs[0] : null;
    const debt = r.ok ? await get('posCommissionLiabilities', 'poscomm_' + r.saleId) : null;
    ok(r.ok && debt && (await get('ledger', 'poscomm_' + r.saleId)) && claim && debt.soldAtMs === claim.data().soldAtMs, 'R-1',
      `a recorded sale commits with exactly one debt + ledger projection, dated by the claim's own soldAtMs: ${why(r)}`); }
  { INJ.fired = 0; INJ.failDebtCreate = 1; const s0 = await stockOf('M4_R2');
    const r = await record(O, 'M4_R2', 100); INJ.failDebtCreate = 0;
    const claims = (await db.collection('posRecordSaleClaims').get()).docs.filter((d) => d.data().sellerId === O).length;
    ok(INJ.fired === 1 && !r.ok && claims === 1 && (await stockOf('M4_R2')) === s0, 'R-2',
      `a debt write that fails inside the M0-2 transaction → no claim, no sale, stock untouched (claims: ${claims}, R-1's only): ${why(r)}`); }
  { INJ.fired = 0; INJ.failPlan = 1;
    const r = await record(O, 'M4_R2', 100); INJ.failPlan = 0;
    const claims = (await db.collection('posRecordSaleClaims').get()).docs.filter((d) => d.data().sellerId === O).length;
    ok(INJ.fired === 1 && !r.ok && claims === 1, 'R-3', `a debt that cannot be planned → nothing recorded: ${why(r)}`); }

  process.stdout.write('\n[K] every business category takes the SAME debt authority\n');
  { const cats = repoCategories();
    const rows = [];
    let i = 0;
    for (const cat of cats) {
      i++; const uid = 'm4dra-cat-' + i, biz = 'SOK-M4CAT' + String(i).padStart(3, '0'), pid = 'M4_CAT_' + i;
      await db.collection('shops').doc(uid).set({ name: cat + ' shop', ownerId: uid });
      await db.collection('users').doc(uid).set({ name: cat });
      await db.collection('businesses').doc(biz).set({ ownerId: uid, status: 'active', name: cat, category: cat, businessType: cat });
      await P(pid, 200, uid);
      const r = await checkout(uid, uid, pid, 200);
      const d = r.ok ? await get('posCommissionLiabilities', 'poscomm_' + r.saleId) : null;
      rows.push({ cat, ok: r.ok, n: r.ok ? await count('posCommissionLiabilities', 'saleId', r.saleId) : 0, d, biz });
    }
    const bad = rows.filter((x) => !x.ok || x.n !== 1 || !x.d || x.d.businessId !== x.biz);
    const rates = new Set(rows.filter((x) => x.d).map((x) => x.d.rateFraction + '|' + x.d.rail + '|' + x.d.liabilityMinor + '|' + Object.keys(x.d).sort().join(',')));
    ok(cats.length > 0 && bad.length === 0, 'K-1', `${cats.length} distinct categories parsed from the repository's category sources: every one → exactly ONE debt owned by its own business` + (bad.length ? ' — FAILED: ' + bad.slice(0, 5).map((x) => x.cat).join(', ') : ''));
    ok(rates.size === 1, 'K-2', `…through ONE authority: one rate, one rail, one amount, one schema across all categories (distinct: ${rates.size})`); }

  process.stdout.write('\n[B] boundaries\n');
  { const w = (await db.collection('wallets').get()).size + (await db.collection('businessWallets').get()).size + (await db.collection('businessWalletEntries').get()).size;
    ok(w === 0, 'B-1', 'no wallet of any kind was written: ' + w); }
  ok(RAIL.GATE_ENFORCED === false, 'B-2', 'the till gate is still OFF (P0): GATE_ENFORCED=' + RAIL.GATE_ENFORCED);

  clearTimeout(WATCHDOG);
  process.stdout.write(`\n  ${pass} pass / ${fail} fail\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
