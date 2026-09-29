'use strict';
/**
 * CERTIFICATION — 6b: SmartPOS cash converges on posCompleteCheckout. ONE PHYSICAL SALE = ONE SERVER SALE.
 *
 * SmartPOS used to finish a sale on the device, push stock straight to canonical products/{id}, and queue a client-written
 * posTransactions document that a trigger copied into posRetailSales — no commission debt, no server judgement, and a
 * second sale identity beside the checkout's. From 6b the till asks posCompleteCheckout FIRST; the server's answer is
 * the sale. The tender allowlist is cash + CONFIRMED mpesa/card + wallet; everything else — gift_card, manual Till,
 * split, QR, unknown — fails closed before anything is claimed.
 *
 * Runs the REAL checkout and the REAL mirror trigger against the Firestore EMULATOR, and the REAL client modules
 * (pos-converged-sale.js + sokoni-merchant-data.js) with the checkout as their callable. A small till model (in-memory
 * transactions / stock / queue) plays pos.js's ordering; pos.js's own wiring is asserted statically (W-*), and PosDB
 * adjustStock is EXECUTED in WebKit (B-*).
 *
 *   T-*  tender — gift_card (explicit), manual Till, split, QR, unknown refused with NO sale, stock, receipt or debt
 *   S-*  one physical sale — online, replay, offline→sync, duplicate sync, timeout, mirror, cross-merchant key, forged
 *        merchant, stock, price, not-canonical, classification
 *   C-*  shop scope — server-resolved, cached per uid, never borrowed
 *   R-*  reversal hold
 *   W-*  wiring (static, scanner-based)
 *   B-*  PosDB.adjustStock executed in WebKit
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
const fs = require('fs');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-pos-6b';
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 290s\n'); process.exit(3); }, 290000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0, blocked = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr), cw: console.warn, ce: console.error, cl: console.log };
let _q = 0;
async function quiet(fn) {
  if (_q++ === 0) { process.stdout.write = () => true; process.stderr.write = () => true; console.warn = () => {}; console.error = () => {}; console.log = () => {}; }
  try { return await fn(); } finally { if (--_q === 0) { process.stdout.write = _REAL.so; process.stderr.write = _REAL.se; console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl; } }
}

/* The payment-ownership module is required lazily by the checkout, so a payment document carrying `__inject` can make
   it answer with a chosen amount — the only way to reach the non-finite guard (the real module normalises to null). */
const OWN = require(path.join(FN, 'shared', 'pos-payment-ownership.js'));
const _assertConfirmable = OWN.assertConfirmable;
OWN.assertConfirmable = (pay, a) => (pay && pay.__inject != null)
  ? { ok: true, rail: 'qr', owner: a.merchantId, amount: pay.__inject === 'nan' ? NaN : Number(pay.__inject) }
  : _assertConfirmable(pay, a);

const PZF = require(path.join(FN, 'pos-zero-friction.js'));
const MIR = require(path.join(FN, 'pos-retail-mirror.js'));
/* CLIENT_ROOT (default ROOT): where the client MODULE comes from. The old/new differential runs the OLD server, mirror,
   pos-db and wiring (ROOT) with the NEW module, because the module does not exist before 6b. */
const CLIENT_ROOT = path.resolve(process.env.CLIENT_ROOT || ROOT);
const CS = require(path.join(CLIENT_ROOT, 'pos-converged-sale.js'));
const MD = require(path.join(CLIENT_ROOT, 'sokoni-merchant-data.js'));

const REQ = (uid, data) => ({ data, auth: { uid, token: { uid } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const get = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };
const stockOf = async (id) => Number(((await get('products', id)) || {}).stock);
const size = async (c) => (await db.collection(c).get()).size;
const salesOf = async (m) => (await db.collection('posRetailSales').where('merchantId', '==', m).get()).docs.map((d) => d.id);
const debtOf = async (saleId) => get('posCommissionLiabilities', 'poscomm_' + saleId);
const why = (x) => (x.ok ? 'ok' : '[' + x.code + '] ' + String(x.msg || '').slice(0, 80));

/* the callable, as the client SDK presents it: errors carry `functions/<code>` */
function callableFor(uid, opts) {
  opts = opts || {};
  return async (payload) => {
    let r;
    try { r = await quiet(() => PZF.posCompleteCheckout.run(REQ(uid, JSON.parse(JSON.stringify(payload))))); }
    catch (e) { const x = new Error(e.message); x.code = 'functions/' + (e.code || 'internal'); throw x; }
    if (opts.dropResponse) { const x = new Error('deadline exceeded'); x.code = 'functions/deadline-exceeded'; throw x; }
    return { data: r };
  };
}
/* direct server call with an arbitrary payload */
async function serverCall(uid, data) {
  try { const r = await quiet(() => PZF.posCompleteCheckout.run(REQ(uid, data))); return { ok: true, r: r || {} }; }
  catch (e) { return { ok: false, code: e.code, msg: String(e.message || '') }; }
}
const rawSale = (m, key, pid, payments, extra) => Object.assign({ idempotencyKey: key, merchantId: m,
  items: [{ productId: pid, qty: 1, unitPrice: 100, name: pid }], payments, subtotal: 100, discountTotal: 0, taxTotal: 0, grandTotal: 100 }, extra || {});

const adapter = { getDoc: async (c, id) => get(c, id) };
function memStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }

/* ── the till model: pos.js payment.complete ordering (server first; nothing local on a refusal) ── */
function makeTill(uid, rows) {
  const txns = new Map(), stock = new Map(), queue = [], moves = [], products = new Map();
  for (const r of rows) { products.set(r.id, r); stock.set(r.id, 50); }
  return {
    uid, txns, stock, queue, moves, products, storage: memStorage(),
    transactions: { getById: async (id) => (txns.has(id) ? JSON.parse(JSON.stringify(txns.get(id))) : null), save: async (t) => { txns.set(t.id, JSON.parse(JSON.stringify(t))); } },
    adjustStock: async (id, d, reason) => { stock.set(id, (stock.get(id) || 0) + d); moves.push({ id, d, reason }); },
    queueCompat: async (rec) => { queue.push({ type: 'transaction', data: rec }); },
  };
}
async function ringUp(till, o) {
  const lines = await CS.resolveLines(o.cart, async (id) => till.products.get(id) || null);
  if (!lines.ok) return { refused: lines };
  const scope = await CS.resolveScope({ uid: till.uid, storage: till.storage, merchantData: MD, online: !!o.online, db: o.online ? adapter : null });
  if (!scope.ok) return { refused: scope };
  const payload = CS.buildPayload({ merchantData: MD, scope, lines: lines.lines, tendered: o.tendered, txnId: o.txnId, branchId: 'default', discountTotal: 0, taxTotal: 0 });
  if (o.mutatePayload) o.mutatePayload(payload);
  const out = o.online ? await CS.submit(payload, o.callable) : { status: 'LOCAL_PENDING', code: 'offline' };
  if (out.status === 'SYNC_REJECTED') return { refused: out, payload };
  const txn = { id: o.txnId, items: o.cart.map((c) => Object.assign({}, c)), serverStatus: out.status, status: 'completed', cashierId: till.uid };
  if (out.status === 'ACCEPTED') txn.canonicalSaleId = out.saleId;
  await till.transactions.save(txn);
  for (const it of o.cart) await till.adjustStock(it.id, -it.qty, 'converged:sale:' + o.txnId, till.uid);
  if (out.status === 'ACCEPTED') till.queue.push({ type: 'transaction', data: CS.compatRecord(txn) });
  else till.queue.push({ type: 'converged_sale', data: { localTxnId: o.txnId, payload } });
  return { out, payload, txn };
}
const settle = async (till, item, callable) => {
  try { return { out: await CS.settleQueued(item, Object.assign({}, till, { callable })) }; }
  catch (e) { return { threw: e }; }
};
const convergedItem = (till, txnId) => till.queue.find((q) => q.type === 'converged_sale' && q.data.localTxnId === txnId);

/* ── static scanner: body of the block opened by the first `{` at/after `sig` (strings, templates, comments aware) ── */
function bodyOf(src, sig, from) {
  const at = src.indexOf(sig, from || 0);
  if (at < 0) return null;
  const start = src.indexOf('{', at + sig.length - 1);
  const stack = ['{'];
  const tmpl = (j) => {   /* j is just inside a template; returns the index after its end, or after a ${ (pushed) */
    for (; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === '`') return j + 1;
      if (src[j] === '$' && src[j + 1] === '{') { stack.push('T'); return j + 2; }
    }
    return j;
  };
  let i = start + 1;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) return null; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
    if (c === '"' || c === "'") { i++; while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; } i++; continue; }
    if (c === '`') { i = tmpl(i + 1); continue; }
    if (c === '{') { stack.push('{'); i++; continue; }
    if (c === '}') {
      const top = stack.pop();
      if (top === 'T') { i = tmpl(i + 1); continue; }
      if (!stack.length) return src.slice(start, i + 1);
    }
    i++;
  }
  return null;
}
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  process.stdout.write(`\n6b — SmartPOS cash converges on posCompleteCheckout   (tree: ${ROOT}${CLIENT_ROOT !== ROOT ? '  client module: ' + CLIENT_ROOT : ''})\n\n`);
  const A = 'b6-shop-a', B = 'b6-shop-b', V = 'b6-victim';
  for (const m of [A, B, V]) {
    await db.collection('shops').doc(m).set({ name: 'Shop ' + m, ownerId: m });
    await db.collection('users').doc(m).set({ name: m }); await db.collection('sellers').doc(m).set({ name: m });
    for (let i = 1; i <= 24; i++) await db.collection('products').doc(m + '_P' + i).set({ name: m + '_P' + i, price: 100, stock: 50, trackInventory: true, sellerUid: m, shopId: m });
  }
  const row = (m, i) => ({ id: m + '_P' + i, name: m + '_P' + i, price: 100, source: 'canonical' });
  const tillA = makeTill(A, Array.from({ length: 24 }, (_, i) => row(A, i + 1)));
  /* a till confirms its shop online once (and caches it) before it may sell offline — C-* proves the rule */
  await CS.resolveScope({ uid: A, storage: tillA.storage, merchantData: MD, online: true, db: adapter });

  /* ── T: tender ────────────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('[T] a tender the server cannot verify never becomes a sale\n');
  { const pid = A + '_P1';
    const [idem0, sales0, debts0, stock0, claims0] = [await size('posIdempotency'), (await salesOf(A)).length, await size('posCommissionLiabilities'), await stockOf(pid), await size('posPaymentClaims')];
    const r = await serverCall(A, rawSale(A, 't1-gift', pid, [{ method: 'gift_card', code: 'GC-123', amount: 100 }]));
    const after = [await size('posIdempotency'), (await salesOf(A)).length, await size('posCommissionLiabilities'), await stockOf(pid), await size('posPaymentClaims')];
    ok(!r.ok && r.code === 'invalid-argument' && /gift_card\) cannot be accepted at the till/.test(r.msg) && !(r.r && r.r.receipt), 'T-1',
      `gift_card (unconfirmed stored value) is REFUSED by the tender allowlist, with no receipt: ${why(r)}`);
    ok(after[0] === idem0 && after[1] === sales0 && after[2] === debts0 && after[3] === stock0 && after[4] === claims0, 'T-1b',
      `...and NOTHING happened: idempotency ${idem0}→${after[0]}, completed sales ${sales0}→${after[1]}, commission debts ${debts0}→${after[2]}, stock ${stock0}→${after[3]}, payment claims ${claims0}→${after[4]}`); }
  { const pid = A + '_P2'; const res = [];
    for (const [m, p] of [['mpesa_till', { method: 'mpesa_till', ref: 'QWE123RTY', amount: 100 }], ['manual_till', { method: 'manual_till', amount: 100 }],
      ['split', { method: 'split', amount: 100 }], ['qr', { method: 'qr', ref: 'QR1', amount: 100 }], ['unknown', { method: 'bitcoin', amount: 100 }], ['none', { amount: 100 }],
      ['mixed', null]]) {
      const pays = p ? [p] : [{ method: 'cash', amount: 50 }, { method: 'gift_card', amount: 50 }];
      const before = [await size('posIdempotency'), (await salesOf(A)).length, await stockOf(pid)];
      const r = await serverCall(A, rawSale(A, 't2-' + m, pid, pays));
      const after = [await size('posIdempotency'), (await salesOf(A)).length, await stockOf(pid)];
      res.push({ m, refused: !r.ok && r.code === 'invalid-argument' && /cannot be accepted at the till/.test(r.msg), clean: JSON.stringify(before) === JSON.stringify(after) });
    }
    ok(res.every((x) => x.refused && x.clean), 'T-2', 'manual Till, manual_till, split, qr, unknown, no method, and cash+gift_card are all refused before any claim: ' +
      res.map((x) => x.m + '=' + (x.refused ? 'refused' : 'ACCEPTED') + (x.clean ? '' : '+SIDE-EFFECT')).join(' ')); }
  { const pid = A + '_P3';
    const c = await serverCall(A, rawSale(A, 't2c-cash', pid, [{ method: 'cash', amount: 100 }]));
    ok(c.ok && c.r.saleId, 'T-2c', `control: cash through the same allowlist is accepted (${c.ok ? c.r.saleId : why(c)})`); }
  { const want = { cash: true, gift_card: false, mpesa: false, mpesa_till: false, card: false, split: false, qr: false, bitcoin: false, '': false };
    const got = Object.keys(want).map((m) => [m, CS.tenderCheck(m)]);
    const gift = CS.tenderCheck('gift_card');
    ok(got.every(([m, r]) => r.ok === want[m] && (r.ok || (r.reason === 'TENDER_REFUSED' && r.message))), 'T-3',
      'the till offers cash only; every other tender is refused WITH a reason: ' + got.map(([m, r]) => (m || "''") + '=' + (r.ok ? 'ok' : 'no')).join(' '));
    ok(gift.message === 'Gift cards are temporarily unavailable. Stored-value payments will return when server verification is enabled.', 'T-3b',
      'the gift-card reason is the owner\'s exact wording'); }
  { const pid = A + '_P4';
    const r = await ringUp(tillA, { cart: [{ id: pid, qty: 1, price: 100, name: pid }], txnId: 'TXN-T4', tendered: 100, online: false });
    const item = convergedItem(tillA, 'TXN-T4');
    item.data.payload.payments = [{ method: 'gift_card', code: 'GC-9', amount: 100, ref: null }];   /* a legacy / tampered queued tender */
    const [sales0, debts0, stock0] = [(await salesOf(A)).length, await size('posCommissionLiabilities'), await stockOf(pid)];
    const s = await settle(tillA, item, callableFor(A));
    const t = await tillA.transactions.getById('TXN-T4');
    ok(r.out && r.out.status === 'LOCAL_PENDING' && s.out && s.out.status === 'SYNC_REJECTED' && s.out.reason === 'TENDER_REFUSED' && !s.threw, 'T-4',
      `a queued gift_card sale is REJECTED at sync and never retried (${s.threw ? 'THREW → retry' : (s.out && s.out.status + '/' + s.out.reason)})`);
    ok((await salesOf(A)).length === sales0 && (await size('posCommissionLiabilities')) === debts0 && (await stockOf(pid)) === stock0 &&
       t.serverStatus === 'SYNC_REJECTED' && t.status === 'failed' && tillA.stock.get(pid) === 50, 'T-4b',
      `...no server sale, debt or canonical stock movement; the till's record is failed and its local stock returned (${tillA.stock.get(pid)})`); }
  { const pid = A + '_P5';
    await db.collection('posPayments').doc('REF-OK-5').set({ __inject: 1000, sellerId: A, status: 'paid' });
    await db.collection('posPayments').doc('REF-NAN-5').set({ __inject: 'nan', sellerId: A, status: 'paid' });
    const ctl = await serverCall(A, rawSale(A, 't5-ctl', A + '_P6', [{ method: 'mpesa', ref: 'REF-OK-5', amount: 100 }]));
    const [sales0, debts0, stock0] = [(await salesOf(A)).length, await size('posCommissionLiabilities'), await stockOf(pid)];
    const r = await serverCall(A, rawSale(A, 't5-nan', pid, [{ method: 'mpesa', ref: 'REF-NAN-5', amount: 100 }]));
    ok(ctl.ok && ctl.r.saleId, 'T-5c', `control: an injected CONFIRMED amount reaches the check and a sufficient one settles (${ctl.ok ? ctl.r.saleId : why(ctl)})`);
    ok(!r.ok && r.code === 'invalid-argument' && /did not report an amount/.test(r.msg) && !(await get('posPaymentClaims', 'REF-NAN-5')) &&
       (await salesOf(A)).length === sales0 && (await size('posCommissionLiabilities')) === debts0 && (await stockOf(pid)) === stock0, 'T-5',
      `a confirmation whose amount is non-finite is REFUSED with its own reason; no claim, sale, debt or stock: ${why(r)}`); }

  /* ── S: one physical sale ─────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[S] one physical sale = one server sale\n');
  let S1 = null;
  { const pid = A + '_P7'; const s0 = await stockOf(pid); const n0 = (await salesOf(A)).length;
    const r = await ringUp(tillA, { cart: [{ id: pid, qty: 2, price: 100, name: pid }], txnId: 'TXN-S1', tendered: 500, online: true, callable: callableFor(A) });
    S1 = r;
    const sale = r.out && r.out.saleId ? await get('posRetailSales', r.out.saleId) : null;
    ok(r.out && r.out.status === 'ACCEPTED' && /^ps_/.test(r.out.saleId) && sale && sale.merchantId === A && (await salesOf(A)).length === n0 + 1, 'S-1',
      `online: the server records ONE sale in its own namespace (${r.out && r.out.saleId}) — sales ${n0}→${(await salesOf(A)).length}`);
    ok((await stockOf(pid)) === s0 - 2 && !!(await debtOf(r.out.saleId)) && r.out.receipt && r.out.receipt.receiptNo, 'S-1b',
      `...canonical stock moved ONCE by the server (${s0}→${await stockOf(pid)}), ONE commission debt, a server receipt (${r.out.receipt && r.out.receipt.receiptNo})`);
    const q = tillA.queue.filter((x) => x.data && (x.data.localTxnId === 'TXN-S1' || x.data.id === 'TXN-S1'));
    ok(q.length === 1 && q[0].type === 'transaction' && q[0].data.canonicalSaleId === r.out.saleId && q[0].data.recordKind === 'converged_projection' &&
       tillA.moves.filter((m) => /TXN-S1$/.test(m.reason)).every((m) => /^converged:/.test(m.reason)), 'S-1c',
      'the till queues only a PROJECTION naming the server sale, and its local stock movement is converged (local-only)'); }
  { const pid = A + '_P7'; const s0 = await stockOf(pid); const n0 = (await salesOf(A)).length; const d0 = await size('posCommissionLiabilities');
    const again = await CS.submit(S1.payload, callableFor(A));
    ok(again.status === 'ACCEPTED' && again.saleId === S1.out.saleId && again.cached === true && (await stockOf(pid)) === s0 &&
       (await salesOf(A)).length === n0 && (await size('posCommissionLiabilities')) === d0, 'S-2',
      `same-key replay (a dropped response retried) returns the SAME sale, cached; stock, sales and debts unchanged`); }
  let S3 = null;
  { const pid = A + '_P8'; const s0 = await stockOf(pid); const n0 = (await salesOf(A)).length;
    await ringUp(tillA, { cart: [{ id: pid, qty: 1, price: 100, name: pid }], txnId: 'TXN-PRIME', tendered: 100, online: true, callable: callableFor(A) });   /* caches the scope */
    const s1 = await stockOf(pid); const n1 = (await salesOf(A)).length;
    const r = await ringUp(tillA, { cart: [{ id: pid, qty: 3, price: 100, name: pid }], txnId: 'TXN-S3', tendered: 300, online: false });
    const untouched = (await stockOf(pid)) === s1 && (await salesOf(A)).length === n1;
    const s = await settle(tillA, convergedItem(tillA, 'TXN-S3'), callableFor(A));
    S3 = s;
    const t = await tillA.transactions.getById('TXN-S3');
    ok(r.out.status === 'LOCAL_PENDING' && untouched && s.out && s.out.status === 'ACCEPTED' && (await salesOf(A)).length === n1 + 1 && (await stockOf(pid)) === s1 - 3, 'S-3',
      `offline: nothing reaches the server until sync; sync records ONE sale and moves canonical stock once (${s1}→${await stockOf(pid)})`);
    ok(t.serverStatus === 'ACCEPTED' && t.canonicalSaleId === s.out.saleId && tillA.queue.some((x) => x.type === 'transaction' && x.data.id === 'TXN-S3' && x.data.canonicalSaleId === s.out.saleId) &&
       tillA.stock.get(pid) === 50 - 1 - 3, 'S-3b',
      `...the till's record names the server sale; its projection is queued AFTER the decision; local stock moved once (${tillA.stock.get(pid)})`);
    void s0; void n0; }
  { const pid = A + '_P8'; const s0 = await stockOf(pid); const n0 = (await salesOf(A)).length; const q0 = tillA.queue.length;
    const s = await settle(tillA, convergedItem(tillA, 'TXN-S3'), callableFor(A));
    ok(s.out && s.out.status === 'ACCEPTED' && s.out.saleId === S3.out.saleId && s.out.cached && (await stockOf(pid)) === s0 && (await salesOf(A)).length === n0 && tillA.queue.length === q0, 'S-4',
      'a DUPLICATE sync of the same queued sale returns the same sale; no second sale, stock movement or projection'); }
  { const pid = A + '_P9'; const s0 = await stockOf(pid); const n0 = (await salesOf(A)).length; const d0 = await size('posCommissionLiabilities');
    const r = await ringUp(tillA, { cart: [{ id: pid, qty: 1, price: 100, name: pid }], txnId: 'TXN-S5', tendered: 100, online: true, callable: callableFor(A, { dropResponse: true }) });
    const committed = (await salesOf(A)).length === n0 + 1;
    const s1 = await settle(tillA, convergedItem(tillA, 'TXN-S5'), callableFor(A));
    ok(r.out.status === 'LOCAL_PENDING' && committed && s1.out && s1.out.status === 'ACCEPTED' && s1.out.cached &&
       (await salesOf(A)).length === n0 + 1 && (await stockOf(pid)) === s0 - 1 && (await size('posCommissionLiabilities')) === d0 + 1, 'S-5',
      'timeout AFTER the server committed: the till holds it pending; the retry gets the SAME sale — one sale, one stock movement, one debt'); }
  { const n0 = (await salesOf(A)).length; const proj = tillA.queue.find((x) => x.type === 'transaction' && x.data.id === 'TXN-S1').data;
    await db.collection('posTransactions').doc('TXN-S1').set(Object.assign({}, proj, { sellerId: A }));
    const snap = await db.collection('posTransactions').doc('TXN-S1').get();
    await quiet(() => MIR.mirrorPosTransactionToRetail.run({ data: snap, params: { txnId: 'TXN-S1' } }));
    await db.collection('posTransactions').doc('TXN-LEGACY').set({ sellerId: A, total: 100, status: 'completed', items: [{ name: 'x', qty: 1, unitPrice: 100 }], paymentMethod: 'cash' });
    const snap2 = await db.collection('posTransactions').doc('TXN-LEGACY').get();
    await quiet(() => MIR.mirrorPosTransactionToRetail.run({ data: snap2, params: { txnId: 'TXN-LEGACY' } }));
    ok(!(await get('posRetailSales', 'TXN-S1')) && !(await get('posRetailSales', 'TXN-LEGACY')) && (await salesOf(A)).length === n0, 'S-6',
      'the projection (and any ordinary posTransactions id) reaching the mirror creates NO second sale — the mirror writes nothing'); }
  { const tillB = makeTill(B, Array.from({ length: 24 }, (_, i) => row(B, i + 1)));
    const a = await ringUp(tillA, { cart: [{ id: A + '_P10', qty: 1, price: 100, name: 'a' }], txnId: 'TXN-SAME', tendered: 100, online: true, callable: callableFor(A) });
    const b = await ringUp(tillB, { cart: [{ id: B + '_P10', qty: 1, price: 100, name: 'b' }], txnId: 'TXN-SAME', tendered: 100, online: true, callable: callableFor(B) });
    ok(a.out.status === 'ACCEPTED' && b.out.status === 'ACCEPTED' && a.payload.idempotencyKey !== b.payload.idempotencyKey && a.out.saleId !== b.out.saleId &&
       (await get('posRetailSales', b.out.saleId)).merchantId === B, 'S-7',
      'the same till token on two shops gives two keys and two sales, each its own merchant\'s');
    const forcedKey = a.payload.idempotencyKey;
    const b2 = await serverCall(B, rawSale(B, forcedKey, B + '_P11', [{ method: 'cash', amount: 100 }]));
    ok(b2.ok && b2.r.saleId !== a.out.saleId && !b2.r.cached && (await get('posRetailSales', b2.r.saleId)).merchantId === B, 'S-7b',
      `...and B sending A's EXACT key still gets its own new sale, never A's (${b2.ok ? b2.r.saleId : why(b2)})`); }
  { const pid = V + '_P1'; const vs0 = await stockOf(pid); const vn0 = (await salesOf(V)).length;
    const r = await ringUp(tillA, { cart: [{ id: A + '_P12', qty: 1, price: 100, name: 'x' }], txnId: 'TXN-S8', tendered: 100, online: false });
    const item = convergedItem(tillA, 'TXN-S8');
    item.data.payload.merchantId = V; item.data.payload.items = [{ productId: pid, qty: 1, unitPrice: 100, name: 'v' }];
    const s = await settle(tillA, item, callableFor(A));
    ok(r.out.status === 'LOCAL_PENDING' && s.out && s.out.status === 'SYNC_REJECTED' && s.out.reason === 'NOT_AUTHORISED' &&
       (await stockOf(pid)) === vs0 && (await salesOf(V)).length === vn0 && tillA.stock.get(A + '_P12') === 50, 'S-8',
      `a queued sale naming ANOTHER merchant is refused (${s.out ? s.out.reason : 'threw'}); the victim's stock and sales are untouched; local stock returned`); }
  { const pid = A + '_P13';
    await db.collection('products').doc(pid).update({ stock: 0 });
    const r = await ringUp(tillA, { cart: [{ id: pid, qty: 1, price: 100, name: pid }], txnId: 'TXN-S9', tendered: 100, online: false });
    const n0 = (await salesOf(A)).length;
    const s = await settle(tillA, convergedItem(tillA, 'TXN-S9'), callableFor(A));
    ok(r.out.status === 'LOCAL_PENDING' && s.out && s.out.status === 'SYNC_REJECTED' && s.out.reason === 'STOCK_UNAVAILABLE' && s.out.code === 'failed-precondition' && !s.threw &&
       (await salesOf(A)).length === n0 && (await stockOf(pid)) === 0 && tillA.stock.get(pid) === 50, 'S-9',
      `no stock at sync: a TYPED refusal (${s.out ? s.out.code + '/' + s.out.reason : 'threw'}), never retried; no sale; canonical floor held; local stock returned`); }
  { const pid = A + '_P14';
    const r = await ringUp(tillA, { cart: [{ id: pid, qty: 1, price: 100, name: pid }], txnId: 'TXN-S10', tendered: 100, online: false });
    await db.collection('products').doc(pid).update({ price: 150 });
    const n0 = (await salesOf(A)).length; const s0 = await stockOf(pid);
    const s = await settle(tillA, convergedItem(tillA, 'TXN-S10'), callableFor(A));
    ok(r.out.status === 'LOCAL_PENDING' && s.out && s.out.status === 'SYNC_REJECTED' && s.out.reason === 'PRICE_CHANGED' && (await salesOf(A)).length === n0 && (await stockOf(pid)) === s0, 'S-10',
      `price changed before sync: refused as PRICE_CHANGED (${s.out && s.out.reason}); no sale, no stock`); }
  { const local = { id: 'LOCAL-ONLY-1', name: 'Till-only soap', price: 100 };
    const linked = { id: 'L-77', name: 'Linked', price: 100, marketplaceId: A + '_P15' };
    const t = makeTill(A, [local, linked]);
    const bad = await CS.resolveLines([{ id: local.id, qty: 1, price: 100, name: local.name }], async (id) => t.products.get(id));
    const good = await CS.resolveLines([{ id: linked.id, qty: 1, price: 100, name: 'Linked' }, { id: A + '_P16', qty: 1, price: 100, name: 'c' }],
      async (id) => (id === A + '_P16' ? row(A, 16) : t.products.get(id)));
    ok(!bad.ok && bad.reason === 'PRODUCT_NOT_CANONICAL' && /Till-only soap/.test(bad.message) && good.ok &&
       good.lines[0].productId === A + '_P15' && good.lines[1].productId === A + '_P16', 'S-11',
      'a till-only product is refused BEFORE the sale (PRODUCT_NOT_CANONICAL); linked (marketplaceId) and catalogue rows resolve to their canonical ids'); }
  { const transient = ['functions/unavailable', 'functions/internal', 'functions/deadline-exceeded', 'functions/already-exists', 'functions/unauthenticated', 'functions/resource-exhausted', '', undefined];
    const permanent = ['functions/invalid-argument', 'functions/failed-precondition', 'functions/permission-denied', 'functions/not-found'];
    const res = [];
    for (const c of transient) {
      const s = await settle(tillA, { data: { localTxnId: 'nope', payload: { idempotencyKey: 'k' } } }, async () => { const e = new Error('x'); e.code = c; throw e; });
      res.push(['T', c, !!s.threw && s.threw.pending === true]);
    }
    for (const c of permanent) {
      const s = await settle(tillA, { data: { localTxnId: 'nope', payload: { idempotencyKey: 'k' } } }, async () => { const e = new Error('x'); e.code = c; throw e; });
      res.push(['P', c, !s.threw && s.out.status === 'SYNC_REJECTED']);
    }
    ok(res.every((x) => x[2]), 'S-12', 'no answer (network, timeout, crash, concurrent attempt, auth expiry) is RETRIED; a refusal is final — misclassified: ' + (res.filter((x) => !x[2]).map((x) => String(x[1])).join(',') || 'none'));
    const noId = await CS.submit({ idempotencyKey: 'k' }, async () => ({ data: { ok: true } }));
    ok(noId.status === 'LOCAL_PENDING', 'S-13', `an answer without a sale id is NOT an acceptance (${noId.status})`); }

  /* ── C: scope ─────────────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[C] the shop comes from Firestore, never from the device\n');
  { const st = memStorage();
    const on = await CS.resolveScope({ uid: A, storage: st, merchantData: MD, online: true, db: adapter });
    const off = await CS.resolveScope({ uid: A, storage: st, merchantData: MD, online: false, db: null });
    const other = await CS.resolveScope({ uid: B, storage: st, merchantData: MD, online: false, db: null });
    await db.collection('users').doc('b6-noshop').set({ name: 'x' });
    st.setItem(CS.SCOPE_CACHE_KEY, JSON.stringify({ uid: 'b6-noshop', shopId: A }));
    const none = await CS.resolveScope({ uid: 'b6-noshop', storage: st, merchantData: MD, online: true, db: adapter });
    const anon = await CS.resolveScope({ uid: null, storage: st, merchantData: MD, online: true, db: adapter });
    ok(on.ok && on.shopId === A && off.ok && off.shopId === A, 'C-1', 'online the shop is read from Firestore and cached; offline the SAME uid uses its cache');
    ok(!other.ok && other.reason === 'SCOPE_UNCONFIRMED', 'C-2', 'offline, another account never borrows the cached shop');
    ok(!none.ok && !st.getItem(CS.SCOPE_CACHE_KEY) && !anon.ok, 'C-3', 'an account with no shop on record is refused and its stale cache is cleared; no uid is refused'); }

  /* ── R: reversal hold ─────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[R] the till cannot reverse a sale the server owns\n');
  ok(!!CS.reversalBlock({ serverStatus: 'ACCEPTED' }) && !!CS.reversalBlock({ serverStatus: 'LOCAL_PENDING' }) && !!CS.reversalBlock({ serverStatus: 'SYNC_REJECTED' }) &&
     CS.reversalBlock({ status: 'completed' }) === null, 'R-1', 'accepted, pending and rejected sales are held; a legacy (pre-6b) till sale is unchanged');

  /* ── W: wiring ────────────────────────────────────────────────────────────────────────────────────── */
  process.stdout.write('\n[W] wiring (static)\n');
  { const html = read('pos.html');
    const idx = (s) => html.indexOf('<script src="' + s + '"');
    ok(idx('sokoni-merchant-data.js') > 0 && idx('pos-converged-sale.js') > idx('sokoni-merchant-data.js') && idx('pos-sync.js') > idx('pos-converged-sale.js') && idx('pos.js') > idx('pos-sync.js'), 'W-1',
      'pos.html loads the payload authority and the converged-sale module before pos-sync.js and pos.js');
    const btn = (m) => { const mm = html.match(new RegExp('<button[^>]*data-method="' + m + '"[^>]*>')); return mm ? mm[0] : ''; };
    ok(['mpesa', 'mpesa_till', 'card', 'split', 'qr'].every((m) => /\bunavailable\b/.test(btn(m)) && /aria-disabled="true"/.test(btn(m))) && !/unavailable|aria-disabled/.test(btn('cash')) &&
       !/SPosQR\.open\(\)/.test(btn('qr')), 'W-2', 'M-PESA, manual Till, card, split and QR are shown unavailable; cash is not; QR no longer opens a collection'); }
  { const js = read('pos.js');
    const complete = bodyOf(js, 'async complete(payInfo) {') || '';
    const i = (s) => complete.indexOf(s);
    ok(complete.length > 2000 && i('payment._tender(') >= 0 && i('payment._tender(') < i('lockPayButton') && i('_convergedDecide(') > 0 && i('_convergedDecide(') < i('PosDB.transactions.save('), 'W-3',
      'complete(): the tender gate runs before anything, and the SERVER decides before the till saves anything');
    ok(!/syncQueue\.add\('transaction',\s*txn\)/.test(complete) && /adjustStock\(item\.id, -item\.qty, _stockReason\('sale'\)/.test(complete) && !/'sale:' \+ txn\.id/.test(complete) &&
       !/'rollback:' \+/.test(complete) && /'converged:' \+ kind/.test(complete), 'W-3b',
      'complete(): no raw sale queued to posTransactions; sale and rollback movements are converged (local-only)');
    const q3 = i("syncQueue.add('converged_sale'"), q4 = i('PosIdempotency.recordKey('), q5 = i('PosSerial.add(');
    ok(q3 > q4 && q3 > q5, 'W-3c', 'the queued sale is the LAST saga write, so a local failure can never leave a sale queued');
    ok(/txn\.serverStatus === 'ACCEPTED' && \(state\.settings\.autoPrint/.test(complete), 'W-4', 'a receipt prints only for a server-ACCEPTED sale');
    const guards = [['refundDialog', 'async refundDialog(txnId) {'], ['voidDialog', 'async voidDialog(txnId) {'], ['_processRefund', 'async _processRefund(originalTxn) {'], ['_processVoid', 'async _processVoid(txn) {']].map(([n, sig]) => {
      const b = bodyOf(js, sig) || ''; const g = b.indexOf('reversalBlock(');
      const firstEffect = Math.min(...['adjustStock(', 'transactions.save(', 'sales._process', 'syncQueue.add('].map((s) => { const k = b.indexOf(s); return k < 0 ? Infinity : k; }));
      return [n, g > 0 && g < firstEffect];
    });
    ok(guards.every((x) => x[1]), 'W-5', 'the reversal hold precedes every stock/record effect in: ' + guards.map((x) => x[0] + (x[1] ? '' : '(MISSING)')).join(', ')); }
  { const sj = read('pos-sync.js');
    const syncItem = bodyOf(sj, 'async function _syncItem(db, item, circuitName) {') || '';
    const conv = bodyOf(sj, 'async function _syncConverged(item) {') || '';
    ok(/converged_sale:\s*\{[^}]*converged:\s*true/.test(sj) && syncItem.indexOf('route.converged') > 0 && syncItem.indexOf('route.converged') < syncItem.indexOf('_fsSetDoc') &&
       /settleQueued\(/.test(conv) && /queueCompat/.test(conv), 'W-6', 'pos-sync settles converged_sale through posCompleteCheckout, before (and never through) the document write path'); }
  { const h = read('pos-checkout.html');
    const payB = bodyOf(h, 'function pay(method, giftCode) {') || '';
    const giftB = bodyOf(payB, "if (method === 'gift_card') {") || '';
    const proc = bodyOf(h, 'async function _processGiftCard(code, totals) {') || '';
    const conf = bodyOf(h, 'async function confirmGiftCard() {') || '';
    const retBefore = (b) => { const r = b.search(/\breturn\b/); const k = b.indexOf('redeemGiftCard'); return r > 0 && (k < 0 || r < k) && b.search(/checkGiftCard/) > r; };
    ok(giftB && !/_processGiftCard|redeemGiftCard|checkGiftCard|openModal\('gift-card-overlay'\)/.test(giftB) && /GIFT_CARD_UNAVAILABLE/.test(giftB), 'W-7',
      'pos-checkout: the gift-card button and scanner path show the unavailable message and look up / redeem nothing');
    ok(retBefore(proc) && retBefore(conf), 'W-7b', '...and the two redeem entry points return before any gift-card lookup or redeem');
    ok(/Gift Card — Unavailable/.test(h) && h.indexOf('Gift cards are temporarily unavailable. Stored-value payments will return when server verification is enabled.') > 0, 'W-7c',
      'the button reads "Gift Card — Unavailable" with the owner\'s explanation'); }
  { const z = read('functions/pos-zero-friction.js');
    const h = bodyOf(z, 'exports.posCompleteCheckout = onCall(cfgHeavy, async ({ data, auth }) => {') || '';
    const t = h.indexOf('if (!_TENDERS[m])'), proof = h.indexOf('6a — THE MERCHANT IS PROVEN'), claim = h.indexOf('_idemIdFor(');
    ok(t > 0 && proof > t && claim > t && /const _TENDERS = \{ cash: 1, mpesa: 1, card: 1, wallet: 1 \};/.test(h), 'W-8',
      'the server allowlist is exactly cash/mpesa/card/wallet and runs before the merchant proof and the idempotency claim'); }

  /* ── B: PosDB.adjustStock executed in WebKit ──────────────────────────────────────────────────────── */
  process.stdout.write('\n[B] PosDB.adjustStock (WebKit)\n');
  await browserSection();

  clearTimeout(WATCHDOG);
  process.stdout.write(`\n6b: ${pass} passed, ${fail} failed${blocked ? ', ' + blocked + ' BLOCKED' : ''}\n`);
  process.exit(fail ? 1 : (blocked ? 4 : 0));

  async function browserSection() {
    let playwright;
    try { playwright = require('playwright'); } catch (e) { blocked++; process.stdout.write('  BLOCKED B-* playwright unavailable: ' + e.message + '\n'); return; }
    const http = require('http');
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/_t') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><html><body><script src="/pos-db.js"></script></body></html>'); }
      fs.readFile(path.join(ROOT, p), (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(d); });
    });
    await new Promise((r) => server.listen(0, r));
    let browser;
    try {
      browser = await playwright.webkit.launch();
      const page = await (await browser.newContext()).newPage();
      await page.goto('http://127.0.0.1:' + server.address().port + '/_t', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => !!window.PosDB, { timeout: 10000 });
      const out = await page.evaluate(async () => {
        await new Promise((res) => { const rq = indexedDB.deleteDatabase('sokoni_smartpos'); rq.onsuccess = rq.onerror = rq.onblocked = () => res(); });
        await PosDB.init();
        const calls = { push: [], emit: [] };
        window._posSyncCanonicalStock = (id, d, r) => { calls.push.push(r); };
        window.SokoniSync = { stockChanged: (p) => { calls.emit.push(p.type); } };
        await PosDB.products.save({ id: 'b6', name: 'B6', price: 100, stock: 10 });
        await PosDB.products.adjustStock('b6', -1, 'converged:sale:T1', 'c');
        const afterConv = { stock: (await PosDB.products.get('b6')).stock, push: calls.push.length, emit: calls.emit.length };
        await PosDB.products.adjustStock('b6', 1, 'converged:rejected:T1', 'c');
        const afterRej = { stock: (await PosDB.products.get('b6')).stock, push: calls.push.length, emit: calls.emit.length };
        await PosDB.products.adjustStock('b6', -2, 'sale:LEGACY', 'c');
        const afterLegacy = { stock: (await PosDB.products.get('b6')).stock, push: calls.push.length, emit: calls.emit.length };
        return { afterConv, afterRej, afterLegacy };
      });
      ok(out.afterConv.stock === 9 && out.afterConv.push === 0 && out.afterConv.emit === 0 && out.afterRej.stock === 10 && out.afterRej.push === 0 && out.afterRej.emit === 0, 'B-1',
        `a converged movement changes LOCAL stock only: no canonical push, no second stock event (${JSON.stringify(out.afterConv)} / ${JSON.stringify(out.afterRej)})`);
      const dPush = out.afterLegacy.push - out.afterRej.push, dEmit = out.afterLegacy.emit - out.afterRej.emit;
      ok(out.afterLegacy.stock === out.afterRej.stock - 2 && dPush === 1 && dEmit === 1, 'B-1c',
        `control: an ordinary movement still pushes and emits exactly once (push +${dPush}, emit +${dEmit})`);
    } catch (e) {
      blocked++; process.stdout.write('  BLOCKED B-* browser could not run: ' + String(e && e.message || e).slice(0, 120) + '\n');
    } finally { try { await browser && browser.close(); } catch (_) {} server.close(); }
  }
})().catch((e) => { clearTimeout(WATCHDOG); process.stdout.write('\n  ✖ CRASH ' + (e && e.stack || e) + '\n'); process.exit(5); });
