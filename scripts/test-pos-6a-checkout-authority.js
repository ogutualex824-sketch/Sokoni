'use strict';
/**
 * CERTIFICATION — 6a: the POS checkout authority is proven BEFORE anything happens, and owns its sale identity.
 *
 * posCompleteCheckout used to claim the idempotency key, return a cached result and resume an existing sale BEFORE it
 * proved the caller could act for the merchant named in the request; its idempotency record was one global namespace
 * keyed by the raw client key; and resume adopted ANY record at the derived sale id — including one the SmartPOS mirror
 * copied from a client-chosen posTransactions id — completing it with no stock movement and no commission debt. The
 * M-PESA reference trigger took the merchant from unbound client fields.
 *
 * Runs the REAL checkout, the REAL mirror trigger and the REAL M-PESA reference trigger against the Firestore EMULATOR.
 * Every attack asserts (1) the refusal, (2) that no financial or merchant side effect happened, and (3) that the named
 * safeguard is what refused it.
 *
 *   O-*  authority ordering — an unproven caller cannot claim, replay or resume; no summary, receipt or completed key
 *   I-*  tenant isolation — one merchant can never read or block another's key; the same merchant replays its own
 *   P-*  provenance — resume refuses a mirror record and any record whose merchant, key, proof or sale time is not the
 *        checkout's; the checkout's own committed sale still resumes
 *   R-*  race / idempotency — concurrent same key → one sale; a refused attempt does not poison another namespace
 *   M-*  M-PESA references — a body naming another merchant cannot create or alter that merchant's claim or conflict; a
 *        non-merchant cannot claim; a genuine claim and a genuine duplicate still work
 *   N-*  namespace — the mirror accepts ordinary ids, refuses the checkout's reserved ids, and a refused id is never adopted
 *   B-*  boundaries — dry-run unchanged; no wallet; the till gate still OFF
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-pos-6a';
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

/* late failure after the commit (completion never finishes) — the 0b / DR-A injection */
const INJ = { failComplete: 0, fired: 0 };
const refProto = Object.getPrototypeOf(db.doc('x/y'));
const _rSet = refProto.set, _rUpdate = refProto.update;
const lateFail = function (orig) { return function (...a) {
  if (INJ.failComplete > 0 && this.path.startsWith('posIdempotency/') && a[0] && a[0].status === 'complete') {
    INJ.failComplete--; INJ.fired++; return Promise.reject(new Error('INJECTED late failure'));
  }
  return orig.apply(this, a);
}; };
refProto.set = lateFail(_rSet); refProto.update = lateFail(_rUpdate);

const PZF = require(path.join(FN, 'pos-zero-friction.js'));
const MIR = require(path.join(FN, 'pos-retail-mirror.js'));
const MAP = require(path.join(FN, 'pos-retail-mirror-map.js'));
const MREF = require(path.join(FN, 'pos-mpesa-refs.js'));
const RAIL = require(path.join(FN, 'pos-commission-rail.js'));
const HAS_SCOPE = typeof PZF._idemIdFor === 'function';

const REQ = (uid, data) => ({ data, auth: { uid, token: { uid } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const get = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };
const stockOf = async (id) => Number(((await get('products', id)) || {}).stock);
const size = async (c) => (await db.collection(c).get()).size;
async function checkout(uid, merchantId, key, pid, extra) {
  const data = Object.assign({ idempotencyKey: key, merchantId, items: [{ productId: pid, qty: 1, unitPrice: 100, name: pid }],
    payments: [{ method: 'cash', amount: 100 }], subtotal: 100, discountTotal: 0, taxTotal: 0, grandTotal: 100 }, extra || {});
  try { const r = await quiet(() => PZF.posCompleteCheckout.run(REQ(uid, data))); return { ok: true, r: r || {} }; }
  catch (e) { return { ok: false, code: e.code, msg: String(e.message || '') }; }
}
const why = (x) => (x.ok ? 'ok' : '[' + x.code + '] ' + x.msg.slice(0, 70));
const OCCUPIED = /already taken by a record the till did not create/;
const NOT_AUTH = /not authorised to record a sale for this shop/;
const idemDocsFor = async (key) => (await db.collection('posIdempotency').get()).docs.filter((d) => d.id === key || (d.data() || {}).idempotencyKey === key);
const dailyFor = async (m) => (await db.collection('posDailySummary').get()).docs.filter((d) => d.id.startsWith(m + '_'));
const debtOf = async (saleId) => get('posCommissionLiabilities', 'poscomm_' + saleId);
/* a record at the merchant's sale id in the shape the checkout writes, from a REAL committed sale, then altered */
async function checkoutShaped(merchant, key, templateSaleId, alter) {
  const id = PZF._saleIdFor(merchant, key);
  const t = Object.assign({}, await get('posRetailSales', templateSaleId), { id, idempotencyKey: key, merchantId: merchant, sellerId: merchant }, alter);
  for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
  await db.collection('posRetailSales').doc(id).set(t);
  return id;
}
async function mirrorTxn(id, data) {
  await db.collection('posTransactions').doc(id).set(data);
  const snap = await db.collection('posTransactions').doc(id).get();
  await quiet(() => MIR.mirrorPosTransactionToRetail.run({ data: snap, params: { txnId: id } }));
}
async function mpesaTxn(id, data) {
  await db.collection('posTransactions').doc(id).set(data);
  const snap = await db.collection('posTransactions').doc(id).get();
  await quiet(() => MREF.onPosTransactionMpesaRef.run({ data: { before: null, after: snap }, params: { txnId: id } }));
  return (await get('posTransactions', id)) || {};
}

(async () => {
  process.stdout.write(`\n6a — the POS checkout authority is proven first and owns its sale identity   (tree: ${ROOT})\n\n`);
  const O = 'a6-owner', V = 'a6-victim', A = 'a6-merchant-a', U = 'a6-unrelated';
  for (const m of [O, V, A]) {
    await db.collection('shops').doc(m).set({ name: 'Shop ' + m, ownerId: m });
    await db.collection('users').doc(m).set({ name: m }); await db.collection('sellers').doc(m).set({ name: m });
    for (let i = 1; i <= 12; i++) await db.collection('products').doc(m + '_P' + i).set({ name: m + '_P' + i, price: 100, stock: 50, trackInventory: true, sellerUid: m, shopId: m });
  }
  await db.collection('users').doc(U).set({ name: 'unrelated' });

  /* ── O: authority ordering ──────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('[O] nothing happens before the merchant is proven\n');
  { const before = await size('posIdempotency');
    const r = await checkout(U, V, 'o1-key', V + '_P1');
    ok(!r.ok && r.code === 'permission-denied' && NOT_AUTH.test(r.msg) && (await size('posIdempotency')) === before, 'O-1',
      `an unproven caller naming a merchant is refused by the merchant proof, and NO idempotency record exists for the key: ${why(r)}; records ${before}→${await size('posIdempotency')}`); }
  { const vs = await checkout(V, V, 'o2-key', V + '_P2');
    const r = await checkout(U, V, 'o2-key', V + '_P2');
    ok(vs.ok && !r.ok && NOT_AUTH.test(r.msg) && !(r.r && r.r.receipt), 'O-2',
      `an unproven caller replaying the merchant's completed key gets NO sale and NO receipt: ${why(r)}`); }
  { const id = PZF._saleIdFor(V, 'o3-key');
    const m = MAP.mapTxnToRetail({ sellerId: U, total: 777, status: 'completed', cashierId: U, items: [{ name: 'x', qty: 1, unitPrice: 777 }], paymentMethod: 'cash' }, id);
    await db.collection('posRetailSales').doc(id).set(m);
    const dBefore = (await dailyFor(V)).length;
    const r = await checkout(U, V, 'o3-key', V + '_P3');
    const idem = await idemDocsFor('o3-key');
    ok(!r.ok && NOT_AUTH.test(r.msg) && (await dailyFor(V)).length === dBefore && !idem.some((d) => d.data().status === 'complete'), 'O-3',
      `an unproven caller cannot RESUME a record at the merchant's sale id: no daily summary, no completed key: ${why(r)}`); }

  /* ── I: tenant isolation ──────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[I] one merchant never reads or blocks another merchant\'s key\n');
  { const b = await checkout(V, V, 'shared-key', V + '_P4');
    const a = await checkout(A, A, 'shared-key', A + '_P1');
    ok(b.ok && a.ok && a.r.saleId && a.r.saleId !== b.r.saleId && !a.r.cached && a.r.receipt && a.r.receipt.merchantId === A, 'I-1',
      `merchant A using merchant V's raw key gets its OWN new sale, never V's (${a.ok ? (a.r.saleId === b.r.saleId ? "V'S SALE" : 'own sale, cached=' + !!a.r.cached) : why(a)})`);
    const b2 = await checkout(V, V, 'shared-key', V + '_P4');
    ok(b2.ok && b2.r.saleId === b.r.saleId && b2.r.cached === true, 'I-2', `V replaying its own key still gets its ORIGINAL sale (cached ${b2.r && b2.r.cached})`);
    const scoped = HAS_SCOPE ? [await get('posIdempotency', PZF._idemIdFor(V, 'shared-key')), await get('posIdempotency', PZF._idemIdFor(A, 'shared-key'))] : [null, null];
    ok(HAS_SCOPE && scoped.every(Boolean) && scoped[0].merchantId === V && scoped[1].merchantId === A && !(await get('posIdempotency', 'shared-key')), 'I-3',
      `the same raw key gives two independent merchant-scoped records and no global one (scoped helper ${HAS_SCOPE ? 'present' : 'ABSENT'})`); }
  { const s1 = await checkout(O, O, 'i4-key', O + '_P1'); const s2 = await checkout(O, O, 'i4-key', O + '_P1');
    ok(s1.ok && s2.ok && s2.r.saleId === s1.r.saleId && s2.r.cached === true && s2.r.receipt, 'I-4', 'the same merchant + key returns the original authoritative sale and receipt'); }
  { /* the second, independent control: even a completed record AT the merchant's scoped id is returned only if it names
       that merchant (a corrupted or foreign record is refused, never handed out) */
    const k = 'i5-key';
    if (HAS_SCOPE) await db.collection('posIdempotency').doc(PZF._idemIdFor(O, k)).set({ status: 'complete', merchantId: V, idempotencyKey: k, saleId: 'someone-elses-sale', receipt: { merchantId: V, total: 1 }, startedAt: Date.now() });
    const r = await checkout(O, O, k, O + '_P12');
    ok(HAS_SCOPE && !r.ok && r.code === 'permission-denied' && /belongs to another merchant/.test(r.msg), 'I-5',
      `a completed record naming ANOTHER merchant is never returned, even at this merchant's own scoped id: ${why(r)}`); }

  /* ── P: provenance — resume adopts only the checkout's own record ─────────────────────────────────────── */
  process.stdout.write('\n[P] resume adopts only a sale this checkout committed\n');
  const tmpl = await checkout(O, O, 'p-template', O + '_P2');
  const occupiedCase = async (idc, key, pid, what, make) => {
    const id = await make(key);
    const s0 = await stockOf(pid), d0 = (await dailyFor(O)).length;
    const r = await checkout(O, O, key, pid);
    const idem = await idemDocsFor(key);
    ok(!r.ok && r.code === 'failed-precondition' && OCCUPIED.test(r.msg) && !(await debtOf(id)) && (await stockOf(pid)) === s0
      && (await dailyFor(O)).length === d0 && !idem.some((d) => d.data().status === 'complete'), idc,
      `${what} → refused by the provenance check; no debt, stock ${s0}→${await stockOf(pid)}, no summary, no completed key: ${why(r)}`);
  };
  await occupiedCase('P-1', 'p1-key', O + '_P3', 'a SmartPOS MIRROR record at the sale id', async (k) => {
    const id = PZF._saleIdFor(O, k);
    const m = MAP.mapTxnToRetail({ sellerId: O, total: 100, status: 'completed', cashierId: O, items: [{ name: 'x', qty: 1, unitPrice: 100 }], paymentMethod: 'cash' }, id);
    await db.collection('posRetailSales').doc(id).set(m); return id; });
  await occupiedCase('P-1b', 'p1b-key', O + '_P1', 'a record marked source pos-mirror even though it carries EVERY checkout field',
    (k) => checkoutShaped(O, k, tmpl.r.saleId, { source: 'pos-mirror' }));
  await occupiedCase('P-2', 'p2-key', O + '_P4', 'a checkout-shaped record naming ANOTHER merchant', (k) => checkoutShaped(O, k, tmpl.r.saleId, { merchantId: V }));
  await occupiedCase('P-3', 'p3-key', O + '_P5', 'a checkout-shaped record carrying ANOTHER key', (k) => checkoutShaped(O, k, tmpl.r.saleId, { idempotencyKey: 'some-other-key' }));
  await occupiedCase('P-4', 'p4-key', O + '_P6', 'a record with NO merchant proof (merchantProvenBy missing)', (k) => checkoutShaped(O, k, tmpl.r.saleId, { merchantProvenBy: undefined }));
  await occupiedCase('P-5', 'p5-key', O + '_P7', 'a record whose soldAtMs is not a number', (k) => checkoutShaped(O, k, tmpl.r.saleId, { soldAtMs: 'yesterday' }));
  { INJ.fired = 0; INJ.failComplete = 1;
    const first = await checkout(O, O, 'p6-key', O + '_P8'); INJ.failComplete = 0;
    const id = PZF._saleIdFor(O, 'p6-key'); const s1 = await stockOf(O + '_P8');
    const retry = await checkout(O, O, 'p6-key', O + '_P8');
    ok(INJ.fired === 1 && !first.ok && retry.ok && retry.r.saleId === id && (await stockOf(O + '_P8')) === s1 && !!(await debtOf(id))
      && (await db.collection('posCommissionLiabilities').where('saleId', '==', id).get()).size === 1, 'P-6',
      `CONTROL — the checkout's OWN committed sale (completion interrupted) still resumes: one sale, one debt, no second deduction: ${why(retry)}`); }

  /* ── R: race / idempotency ────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[R] one key, one sale\n');
  { const go = () => checkout(O, O, 'r1-key', O + '_P9');
    const [x, y] = await Promise.all([go(), go()]);
    const sales = (await db.collection('posRetailSales').where('idempotencyKey', '==', 'r1-key').get()).docs;
    ok(sales.length === 1 && (await db.collection('posCommissionLiabilities').where('saleId', '==', sales[0].id).get()).size === 1, 'R-1',
      `concurrent same-key attempts → one authoritative sale, one debt (${why(x)} / ${why(y)})`); }
  { const bad = await checkout(A, A, 'r2-key', A + '_P2', { items: [{ productId: A + '_P2', qty: 1, unitPrice: 5, name: 'x' }], subtotal: 5, grandTotal: 5 });
    const good = await checkout(V, V, 'r2-key', V + '_P5');
    ok(!bad.ok && good.ok && !good.r.cached, 'R-2', `merchant A's FAILED attempt with a key does not poison merchant V's use of it: A ${why(bad)}; V ${why(good)}`);
    const u = await checkout(U, O, 'r3-key', O + '_P10');
    const own = await checkout(O, O, 'r3-key', O + '_P10');
    ok(!u.ok && own.ok, 'R-3', `an unproven caller's attempt at a key does not block the merchant: ${why(u)}; merchant ${why(own)}`); }

  /* ── M: M-PESA references ────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[M] a reference is claimed only for the seller who wrote it\n');
  const MT = (seller, ref, extra) => Object.assign({ sellerId: seller, status: 'completed', paymentMethod: 'mpesa_till_manual', mpesaRef: ref, total: 100, cashierId: seller }, extra || {});
  { const t = await mpesaTxn('M1TXN0000000000001', MT(A, 'QWE1234567', { merchantId: V }));
    const claimV = await get('mpesaReferenceClaims', V + '__QWE1234567'), claimA = await get('mpesaReferenceClaims', A + '__QWE1234567');
    ok(!claimV && !claimA && t.mpesaRefClaim === 'refused' && t.mpesaRefIssue === 'merchant_mismatch', 'M-1',
      `A SmartPOS transaction containing another merchant's merchantId cannot create that merchant's M-PESA reference claim (victim claim ${claimV ? 'CREATED' : 'none'}; flagged ${t.mpesaRefClaim}/${t.mpesaRefIssue})`); }
  { await mpesaTxn('M2TXN0000000000001', MT(V, 'ZXC1234567'));
    const claimBefore = JSON.stringify(await get('mpesaReferenceClaims', V + '__ZXC1234567'));
    const cBefore = (await db.collection('mpesaReferenceConflicts').where('merchantId', '==', V).get()).size;
    const t = await mpesaTxn('M2TXN0000000000002', MT(A, 'ZXC1234567', { merchantId: V }));
    ok(claimBefore !== 'null' && JSON.stringify(await get('mpesaReferenceClaims', V + '__ZXC1234567')) === claimBefore
      && (await db.collection('mpesaReferenceConflicts').where('merchantId', '==', V).get()).size === cBefore && t.mpesaRefIssue === 'merchant_mismatch', 'M-2',
      `…nor alter it: the victim's existing claim is unchanged and NO conflict is written against the victim (conflicts ${cBefore}→${(await db.collection('mpesaReferenceConflicts').where('merchantId', '==', V).get()).size})`); }
  { const t = await mpesaTxn('M3TXN0000000000001', MT(U, 'ASD1234567'));
    ok(!(await get('mpesaReferenceClaims', U + '__ASD1234567')) && t.mpesaRefClaim === 'refused' && t.mpesaRefIssue === 'not_a_merchant', 'M-3',
      `a seller who is not a merchant cannot claim a reference (flagged ${t.mpesaRefClaim}/${t.mpesaRefIssue})`); }
  { const t = await mpesaTxn('M4TXN0000000000001', MT(O, 'FGH1234567', { merchantId: O }));
    const c = await get('mpesaReferenceClaims', O + '__FGH1234567');
    ok(c && c.saleId === 'M4TXN0000000000001' && t.mpesaRefClaim === 'claimed', 'M-4', `CONTROL — a genuine seller's reference is claimed (${t.mpesaRefClaim})`);
    const t2 = await mpesaTxn('M5TXN0000000000001', MT(O, 'FGH1234567'));
    const conf = (await db.collection('mpesaReferenceConflicts').where('merchantId', '==', O).get()).docs.filter((d) => d.data().reference === 'FGH1234567');
    ok(t2.mpesaRefClaim === 'conflict' && conf.length === 1, 'M-5', `CONTROL — a genuine duplicate is still recorded as a conflict for a human (${t2.mpesaRefClaim}, conflicts ${conf.length})`); }

  /* ── N: namespace ────────────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[N] the checkout\'s sale-id namespace belongs to the checkout\n');
  { await mirrorTxn('TXN-A6-0001-ABCD', { sellerId: O, total: 100, status: 'completed', cashierId: O, items: [{ name: 'x', qty: 1, unitPrice: 100 }], paymentMethod: 'cash' });
    const m = await get('posRetailSales', 'TXN-A6-0001-ABCD');
    ok(!!m && m.source === 'pos-mirror', 'N-1', `CONTROL — the mirror still mirrors an ordinary SmartPOS id (${m ? 'mirrored' : 'NOT mirrored'})`); }
  { const id = PZF._saleIdFor(O, 'n2-key');
    await mirrorTxn(id, { sellerId: O, total: 100, status: 'completed', cashierId: O, items: [{ name: 'x', qty: 1, unitPrice: 100 }], paymentMethod: 'cash' });
    ok(!(await get('posRetailSales', id)), 'N-2', `the mirror REFUSES a transaction id in the checkout's reserved namespace (${id.slice(0, 12)}…): no posRetailSales record`);
    const s0 = await stockOf(O + '_P11');
    const r = await checkout(O, O, 'n2-key', O + '_P11');
    const sale = await get('posRetailSales', id);
    ok(r.ok && sale && sale.source !== 'pos-mirror' && sale.idempotencyKey === 'n2-key' && !!(await debtOf(id)) && (await stockOf(O + '_P11')) === s0 - 1, 'N-3',
      `…and that id is never adopted: the checkout records a REAL sale there — debt present, stock ${s0}→${await stockOf(O + '_P11')}: ${why(r)}`); }

  /* ── B: boundaries ───────────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[B] boundaries\n');
  { const before = [await size('posIdempotency'), await size('posRetailSales')].join('/');
    let d; try { d = await quiet(() => PZF.posCompleteCheckout.run(REQ(U, { dryRun: true, idempotencyKey: 'b1', merchantId: O, items: [{ productId: O + '_P12', qty: 1, unitPrice: 100 }], subtotal: 100, grandTotal: 100 }))); } catch (e) { d = { err: e.code }; }
    ok(d && d.dryRun === true && [await size('posIdempotency'), await size('posRetailSales')].join('/') === before, 'B-1',
      `dry-run is unchanged (answers, writes nothing): ${d && (d.dryRun ? 'dryRun' : d.err)}`); }
  { let w = 0; for (const c of ['wallets', 'businessWallets', 'walletTransactions']) w += await size(c);
    ok(w === 0 && RAIL.GATE_ENFORCED === false, 'B-2', `no wallet written (${w}); the till gate still OFF (GATE_ENFORCED=${RAIL.GATE_ENFORCED})`); }

  process.stdout.write(`\n  ${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG); process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('\n  ✖ CRASH ' + (e && e.stack || e) + '\n'); process.stdout.write(`\n  ${pass} pass / ${fail + 1} fail\n`); process.exit(1); });
