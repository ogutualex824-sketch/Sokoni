#!/usr/bin/env node
/**
 * Inventory convergence — Phase B: every ONLINE / legacy stock writer asks ONE authority (2026-09-30).
 *
 * functions/shared/sellability.js planStockDeduction / planStockReturn — the invariant:
 *   numeric stock → METERED (0 = sold out; never below zero) · no numeric stock → UNMETERED (never created,
 *   decremented or returned) · a deleted product is never written to.
 *
 *   IB1  the helper itself: unmetered · trackInventory:false · 5−2=3 · 1<2 refused ('refuse') · 1<2 taken to 0 with
 *        shortfall 1 ('flag') · a legacy negative is never driven lower · a missing doc · returns (metered, unmetered,
 *        partial, missing) · a fractional 0.5 kg; and the browser twin sokoni-sellability.js is byte-identical
 *   IB2  the marketplace finaliser (index.js _finalizeMarketplacePayment, extracted verbatim), money already taken:
 *        an unmetered product → order finalised, NO stock field, sold +qty; the same again → still no stock;
 *        metered 5, qty 2 → 3; metered 1, qty 2 → 0 + an oversoldAlert (never refused); a DELETED product → the
 *        order still finalises (it used to throw and leave a PAID payment with no order) and the gap is flagged
 *   IB3  B2B wholesale approval (b2b-wholesale.approveWholesaleOrder): a MULTI-item order (unmetered + metered) is
 *        approved (the old loop read after writing and threw) — the metered item is taken, the unmetered gets no
 *        stock, stock + inventoryVersion move together; a short metered line refuses the WHOLE approval, nothing moves
 *   IB4  POS device sync (pos-retail.posSyncToMarketplace): unmetered → counters only; metered 1, sold 2 → 0 + an
 *        oversoldAlert, never negative (the old blind batch trusted a rule the Admin SDK bypasses); a negative
 *        qtyDeducted is refused (it used to RAISE stock)
 *   IB5  wap inventory reserve / release (extracted verbatim): a MULTI-item reserve works (reads first) — unmetered
 *        reserved with nothing taken; one short item refuses the whole reservation, nothing written; release returns
 *        EXACTLY what was taken and never creates stock on the unmetered item; a repeated release changes nothing
 *   IB6  click & collect (pos-marketplace-sync): create takes metered stock and records stockDeducted, leaves the
 *        unmetered untouched (it used to REFUSE it); cancel returns exactly the metered quantity, nothing to the
 *        unmetered, completes although a product was DELETED (recorded as product_missing); a second cancel is refused
 *        — the stock is not returned twice
 *   IB7  STRUCTURAL (inline code the harness cannot load): verifyIntasendPayment and darajaSTKCallback in index.js and
 *        pos-retail-engine recordPOSSale each decide through planStockDeduction; no products.stock write remains that
 *        bypasses the helper
 *
 * Real modules over the transactional fake Firestore. No network, no SMS.
 *   node scripts/test-inventory-unmetered-online.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-inventory-unmetered-online';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const path = require('path'), Module = require('module'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 420) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}), messaging: () => ({ send: async () => ({}) }) };
const onCallStub = (_o, h) => (h || _o);
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/v2/https') return { onCall: onCallStub, onRequest: onCallStub, HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/v2') return { scheduler: { onSchedule: (_o, h) => h }, firestore: { onDocumentUpdated: (_o, h) => h, onDocumentCreated: (_o, h) => h }, https: { onCall: onCallStub, HttpsError } };
  if (id === 'firebase-functions/logger' || id === 'firebase-functions') return { logger: { info() {}, warn() {}, error() {} }, info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'test-secret' }), defineString: () => ({ value: () => '' }), defineInt: () => ({ value: () => 0 }) };
  if (id === './pos-audit') return { writeAudit: () => {} };
  if (id === './notify') return { notify: async () => ({}) };
  if (id === './company-identity') return { COMPANY: { name: 'SOKONI' } };
  if (id === './sokoni-at') return new Proxy({}, { get: (_, k) => (k === 'secrets' ? [] : () => { throw new Error('SMS must never be sent by a test'); }) });
  return origReq.apply(this, arguments);
};
const load = (p) => { try { return require(p); } catch (e) { return { __err: e.message }; } };
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
const out = async (p) => { try { return { ok: await p }; } catch (e) { return { err: e.code || 'error', msg: String(e.message) }; } };
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const fnRequire = (id) => require(id.startsWith('./') ? path.join(FN, id) : id);
/* a function lifted verbatim out of a module that does not export it (the pattern the points suites use) */
function extract(file, sig, params, args) {
  const s = src(file), i = s.indexOf(sig);
  if (i < 0) return null;
  let d = 0, j = s.indexOf('{', s.indexOf(')', i));
  for (let k = j; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}' && --d === 0) { j = k; break; } }
  try { return new Function(...params, 'return (' + s.slice(i, j + 1) + ')')(...args); } catch (e) { return null; }
}
const S = load(path.join(FN, 'shared', 'sellability.js'));
const P = (id, d) => db.doc('products/' + id).set(Object.assign({ name: id, price: 100, sellerUid: 'shopA', shopId: 'shopA', status: 'active', isVisible: true }, d || {}));
const alerts = async () => (await all('oversoldAlerts'));

(async () => {
  /* IB1 */
  /* fail CLOSED, never crash: without the helper IB1 fails and every writer check below still runs */
  const D = (p, q, o) => (typeof S.planStockDeduction === 'function' ? S.planStockDeduction(p, q, o) : {});
  const R = (p, q, d) => (typeof S.planStockReturn === 'function' ? S.planStockReturn(p, q, d) : {});
  const u = D({ price: 1 }, 20), tOff = D({ stock: 5, trackInventory: false }, 2), m = D({ stock: 5 }, 2), rf = D({ stock: 1 }, 2),
    fl = D({ stock: 1 }, 2, { onShort: 'flag' }), neg = D({ stock: -20 }, 2, { onShort: 'flag' }), gone = D(null, 2), half = D({ stock: 2 }, 0.5);
  ck('IB1 the ONE stock decision: unmetered/trackInventory:false move nothing; 5−2=3; 1<2 refused or (flag) taken to 0 with shortfall 1; a legacy −20 is never driven lower; a missing doc is not written; returns only while metered (min of qty and what was taken); 0.5 kg works; the browser twin is byte-identical',
    typeof S.planStockDeduction === 'function' && u.metered === false && u.deduct === 0 && tOff.deduct === 0 && m.deduct === 2 && m.next === 3
    && rf.refused === true && rf.available === 1 && fl.deduct === 1 && fl.shortfall === 1 && neg.deduct === 0 && neg.next === -20 && gone.exists === false
    && R({ price: 1 }, 5, 5).restore === 0 && R({ stock: 3 }, 5, 5).restore === 5 && R({ stock: 3 }, 5).restore === 5 && R({ stock: 3 }, 5, 2).restore === 2
    && R(null, 5, 5).restore === 0 && half.deduct === 0.5
    && src('sokoni-sellability.js') === src('functions/shared/sellability.js'),
    { u, m, rf, fl, neg, gone, half, err: S.__err });

  /* IB2 */
  const FIN = extract('functions/index.js', 'async function _finalizeMarketplacePayment(', ['require'], [fnRequire]);
  const fin = (orderId, items) => FIN(db, ADMIN, { checkoutId: 'PAY-' + orderId, orderId, sellerUid: 'shopA', callerUid: 'buyer1', hub: 'marketplace', amount: 500,
    phone: '254700000000', mpesaCode: 'Q' + orderId, description: 'x', items, writeSellerPayment: false });
  await P('svc', {});                       /* a service: no stock field */
  await P('mug', { stock: 5 });
  await P('pen', { stock: 1 });
  const b2a = await out(fin('ORD1', [{ productId: 'svc', qty: 3 }]));
  const s1 = await get('products/svc');
  const b2b = await out(fin('ORD2', [{ productId: 'svc', qty: 2 }]));
  const s2 = await get('products/svc');
  const b2c = await out(fin('ORD3', [{ productId: 'mug', qty: 2 }]));
  const a0 = (await alerts()).length;
  const b2d = await out(fin('ORD4', [{ productId: 'pen', qty: 2 }]));
  const pen = await get('products/pen'), a1 = await alerts();
  const b2e = await out(fin('ORD5', [{ productId: 'ghost', qty: 1 }]));
  const o5 = await get('orders/ORD5'), a2 = await alerts();
  ck('IB2 marketplace finaliser (money already taken): unmetered → no stock field, sold +3 then +2; metered 5−2=3; metered 1, qty 2 → 0 + an oversoldAlert (never refused); a DELETED product → the order still finalises and the gap is flagged product_missing',
    !!FIN && b2a.ok !== undefined && !has(s1, 'stock') && s1.sold === 3 && b2b.ok !== undefined && !has(s2, 'stock') && s2.sold === 5
    && (await get('products/mug')).stock === 3 && pen.stock === 0 && a1.length === a0 + 1 && a1.some((x) => x.productId === 'pen' && x.requested === 2 && x.available === 1)
    && b2e.err === undefined && !!o5 && a2.some((x) => x.productId === 'ghost' && x.reason === 'product_missing'),
    { fin: !!FIN, errs: [b2a.msg, b2b.msg, b2c.msg, b2d.msg, b2e.msg], svc: s2 && { stock: s2.stock, sold: s2.sold }, mug: (await get('products/mug')).stock, pen: pen.stock, o5: !!o5 });

  /* IB3 */
  const W = load(path.join(FN, 'b2b-wholesale.js'));
  const approve = (orderId) => W._h.approveWholesaleOrder({ auth: { uid: 'admin1', token: { admin: true } }, data: { orderId } });
  await P('ream', { stock: 10 }); await P('design', {}); await P('ink', { stock: 1 });
  await db.doc('wholesaleOrders/W1').set({ status: 'pending', items: [{ productId: 'ream', quantity: 4, sellerId: 'shopA' }, { productId: 'design', quantity: 2, sellerId: 'shopA' }] });
  await db.doc('wholesaleOrders/W2').set({ status: 'pending', items: [{ productId: 'ream', quantity: 1, sellerId: 'shopA' }, { productId: 'ink', quantity: 3, sellerId: 'shopA' }] });
  const w1 = await out(approve('W1'));
  const ream1 = await get('products/ream'), dz = await get('products/design');
  const w2 = await out(approve('W2'));
  ck('IB3 B2B approval: a MULTI-item order (metered + unmetered) is approved — ream 10 → 6 with inventoryVersion, the unmetered design gets NO stock; a short metered line refuses the WHOLE approval and nothing moves (ream stays 6, ink stays 1)',
    !W.__err && w1.ok && ream1.stock === 6 && ream1.inventoryVersion === 1 && !has(dz, 'stock') && (await get('wholesaleOrders/W1')).status === 'approved'
    && w2.err && (await get('products/ream')).stock === 6 && (await get('products/ink')).stock === 1 && (await get('wholesaleOrders/W2')).status === 'pending',
    { load: W.__err, w1: w1.msg, ream: ream1 && [ream1.stock, ream1.inventoryVersion], design: dz && dz.stock, w2: w2.msg });

  /* IB4 */
  const PR = load(path.join(FN, 'pos-retail.js'));
  const sync = (saleId, items) => PR.posSyncToMarketplace({ auth: { uid: 'shopA', token: {} }, data: { branchId: 'main', saleId, items } });
  await P('photo', {}); await P('usb', { stock: 1 }); await P('card', { stock: 9 });
  const ac = (await alerts()).length;
  const y1 = await out(sync('S1', [{ productId: 'photo', qtyDeducted: 4 }, { productId: 'usb', qtyDeducted: 2 }]));
  const y2 = await out(sync('S2', [{ productId: 'card', qtyDeducted: -5 }]));
  const ph = await get('products/photo'), usb = await get('products/usb');
  ck('IB4 POS device sync: unmetered photo → counters only (no stock); metered usb 1, sold 2 → 0 + an oversoldAlert, never negative; a NEGATIVE qtyDeducted is refused and cannot raise stock (card stays 9)',
    !PR.__err && y1.ok && !has(ph, 'stock') && ph.soldCount === 4 && usb.stock === 0 && (await alerts()).length === ac + 1
    && y2.ok && y2.ok.synced === 0 && (y2.ok.errors || []).length === 1 && (await get('products/card')).stock === 9,
    { load: PR.__err, y1: y1.ok || y1.msg, y2: y2.ok || y2.msg, photo: ph && ph.stock, usb: usb.stock, card: (await get('products/card')).stock });

  /* IB5 */
  const RES = extract('functions/wap.js', 'async function _svcInventoryReserve(', ['db', 'admin', 'require'], [db, ADMIN, fnRequire]);
  const REL = extract('functions/wap.js', 'async function _svcInventoryRelease(', ['db', 'admin', 'require'], [db, ADMIN, fnRequire]);
  await P('bag', { stock: 5 }); await P('gift-wrap', {}); await P('box', { stock: 1 });
  const r1 = await out(RES({ orderId: 'O1', items: [{ productId: 'bag', qty: 2 }, { productId: 'gift-wrap', qty: 3 }] }, {}));
  const bag1 = await get('products/bag'), gw1 = await get('products/gift-wrap');
  const r2 = await out(RES({ orderId: 'O2', items: [{ productId: 'bag', qty: 1 }, { productId: 'box', qty: 2 }] }, {}));
  const bag2 = await get('products/bag');
  const rl = await out(REL({ orderId: 'O1', items: [{ productId: 'bag', qty: 2 }, { productId: 'gift-wrap', qty: 3 }] }, {}));
  const bag3 = await get('products/bag'), gw3 = await get('products/gift-wrap');
  const rl2 = await out(REL({ orderId: 'O1', items: [{ productId: 'bag', qty: 2 }] }, {}));
  ck('IB5 wap reserve/release: a MULTI-item reserve works — bag 5 → 3, gift-wrap (unmetered) reserved with nothing taken; one short item refuses the WHOLE reservation (bag stays 3, box 1); release returns EXACTLY 2 (bag 5) and never creates stock on gift-wrap; a repeated release changes nothing',
    !!RES && !!REL && r1.ok && bag1.stock === 3 && !has(gw1, 'stock') && (gw1.reservations || {}).O1 === 0
    && r2.err && bag2.stock === 3 && (await get('products/box')).stock === 1 && !(bag2.reservations || {}).O2
    && rl.ok && bag3.stock === 5 && !has(gw3, 'stock') && rl2.ok && (await get('products/bag')).stock === 5,
    { r1: r1.msg, r2: r2.msg, rl: rl.msg, bag: [bag1.stock, bag2.stock, bag3.stock], gw: gw3 && gw3.stock });

  /* IB6 */
  const CC = load(path.join(FN, 'pos-marketplace-sync.js'));
  const seller = { uid: 'shopA', token: { role: 'owner' } };
  await P('frame', { stock: 6 }); await P('lamination', {}); await P('sleeve', { stock: 4 });
  const c1 = await out(CC.createClickAndCollect({ auth: { uid: 'buyer1', token: {} }, data: { sellerId: 'shopA', items: [{ productId: 'frame', qty: 2 }, { productId: 'lamination', qty: 3 }, { productId: 'sleeve', qty: 1 }] } }));
  const oid = c1.ok && c1.ok.orderId;
  const fr1 = await get('products/frame'), lm1 = await get('products/lamination');
  const cco = oid ? await get('sellers/shopA/clickAndCollect/' + oid) : null;
  await db.doc('products/sleeve').delete();   /* the catalogue record disappears before the cancel */
  const x1 = await out(CC.updateClickAndCollectStatus({ auth: seller, data: { sellerId: 'shopA', orderId: oid, status: 'cancelled' } }));
  const fr2 = await get('products/frame'), lm2 = await get('products/lamination');
  const cco2 = oid ? await get('sellers/shopA/clickAndCollect/' + oid) : null;
  const x2 = await out(CC.updateClickAndCollectStatus({ auth: seller, data: { sellerId: 'shopA', orderId: oid, status: 'cancelled' } }));
  const ret = (id) => ((cco2 && cco2.stockReturn) || []).find((r) => r.productId === id) || {};
  ck('IB6 click & collect: create takes frame 6 → 4 and leaves the unmetered lamination alone (it used to be REFUSED), recording stockDeducted 2/0/1; cancel returns exactly 2 (frame 6), nothing to lamination, and COMPLETES although sleeve was deleted (product_missing); a second cancel is refused — frame stays 6',
    !CC.__err && c1.ok && fr1.stock === 4 && !has(lm1, 'stock') && cco && (cco.items || []).map((i) => i.stockDeducted).join('/') === '2/0/1'
    && x1.ok && fr2.stock === 6 && !has(lm2, 'stock') && cco2.status === 'cancelled' && ret('frame').returned === 2 && ret('lamination').returned === 0
    && ret('sleeve').reason === 'product_missing' && x2.err && (await get('products/frame')).stock === 6,
    { load: CC.__err, c1: c1.msg, x1: x1.msg, x2: x2.msg, frame: [fr1.stock, fr2.stock], took: cco && (cco.items || []).map((i) => i.stockDeducted), ret: cco2 && cco2.stockReturn });

  /* IB7 */
  const ix = src('functions/index.js');
  const sliceFn = (s, sig) => { const i = s.indexOf(sig); if (i < 0) return ''; const n = s.indexOf('\nexports.', i + sig.length); return s.slice(i, n < 0 ? undefined : n); };
  const verify = sliceFn(ix, 'exports.verifyIntasendPayment = onRequest('), daraja = sliceFn(ix, 'exports.darajaSTKCallback = onRequest(');
  const eng = src('functions/pos-retail-engine.js');
  const rpsIdx = eng.indexOf('exports.recordPOSSale'), rps = eng.slice(rpsIdx, eng.indexOf('\nexports.', rpsIdx + 10));
  /* every products.stock write in functions/ must sit in a writer that decides through the helper */
  const writers = ['index.js', 'b2b-wholesale.js', 'pos-retail-engine.js', 'pos-retail.js', 'wap.js', 'pos-marketplace-sync.js', 'pos-zero-friction.js'];
  const raw = writers.filter((f) => /\bstock\s*:\s*(admin\.firestore\.)?FieldValue\.increment\(\s*-?\s*(item\.qty|qty|item\.quantity|stockItems\[i\]\.qty|qtyDeducted|reservedQty)\b|\bstock\s*:\s*Math\.max\(/.test(src('functions/' + f)));
  ck('IB7 STRUCTURAL — verifyIntasendPayment, darajaSTKCallback and recordPOSSale decide through planStockDeduction; no products.stock write in the 7 writer files moves stock by a raw quantity or Math.max any more',
    /planStockDeduction\(pdata, qty, \{ onShort: 'flag' \}\)/.test(verify) && /if \(!_plan\.metered\) return;/.test(verify)
    && /planStockDeduction\(snap\.exists \? pdata : null, qty, \{ onShort: "flag" \}\)/.test(daraja) && /if \(!_plan\.metered\) continue;/.test(daraja)
    && /planStockDeduction\(snaps\[i\]\.data\(\), stockItems\[i\]\.qty, \{ onShort: 'refuse' \}\)/.test(rps) && /if \(stockItems\[i\]\._deduct > 0\)/.test(rps)
    && raw.length === 0,
    { verify: verify.length, daraja: daraja.length, rps: rps.length, raw });

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
