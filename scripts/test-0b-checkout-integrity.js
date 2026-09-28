'use strict';
/**
 * CERTIFICATION — Batch 0b: checkout integrity (posCompleteCheckout + pos-checkout.html).
 *
 * Runs the REAL posCompleteCheckout (`.run`) against the Firestore EMULATOR — real transactions, real
 * increments — so a double deduction is a stock NUMBER, not a recorded write. Pointed at the pre-0b tree
 * (REPAIR_ROOT=export of f3c6630) it must reproduce every defect; on this tree it must prevent each one,
 * with a positive control per rule.
 *
 *   R1  one sale per idempotency key: (a) first attempt commits; (b) a late failure + retry returns the
 *       existing sale with no second deduction; (c) concurrent re-entry with one key cannot sell twice
 *   R2  a committed sale keeps its payment claim; a genuinely failed transaction still releases it
 *   R3  taxTotal must be finite and >= 0 (policy unchanged; a positive tax still works)
 *   R4  only the proven merchant's products sell: single, multi-item, ownerless, and an owner that
 *       changes between the pricing read and the transaction
 *   R5  pos-checkout.html reproduces ONE key across retries of a sale, and a new key per new sale
 *
 * The late failure is INJECTED (the real DocumentReference write that marks the key complete throws once)
 * and the suite asserts the injection actually fired before reading anything into the result.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-0b-checkout';
const WATCHDOG = setTimeout(() => { console.log('\n  ✖ WATCHDOG — suite exceeded 240s'); process.exit(3); }, 240000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
/* Concurrency-safe silencing: parallel calls (R1-c) nest, so the ORIGINAL streams are captured once
   and restored only when the last silenced call finishes. */
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr),
  cw: console.warn, ce: console.error, cl: console.log };
let _quietDepth = 0;
async function quiet(fn) {
  if (_quietDepth++ === 0) {
    process.stdout.write = () => true; process.stderr.write = () => true;
    console.warn = () => {}; console.error = () => {}; console.log = () => {};
  }
  try { return await fn(); } finally {
    if (--_quietDepth === 0) {
      process.stdout.write = _REAL.so; process.stderr.write = _REAL.se;
      console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl;
    }
  }
}

/* ── the late-failure injection: the real write that marks the idempotency key complete throws once ── */
const proto = Object.getPrototypeOf(db.doc('x/y'));
const _origUpdate = proto.update, _origSet = proto.set, _origGet = proto.get;
const INJ = { failComplete: 0, fired: 0, switchOwner: null, barrier: null };
function _isComplete(a) { return a && typeof a === 'object' && a.status === 'complete'; }
proto.update = function (...a) {
  if (INJ.failComplete > 0 && this.path.startsWith('posIdempotency/') && _isComplete(a[0])) {
    INJ.failComplete--; INJ.fired++; return Promise.reject(new Error('INJECTED late failure'));
  }
  return _origUpdate.apply(this, a);
};
proto.set = function (...a) {
  if (INJ.failComplete > 0 && this.path.startsWith('posIdempotency/') && _isComplete(a[0])) {
    INJ.failComplete--; INJ.fired++; return Promise.reject(new Error('INJECTED late failure'));
  }
  return _origSet.apply(this, a);
};
/* R4 in-transaction check: the pricing read (ref.get) sees an owned product; the owner then changes
   before the transaction reads it. */
proto.get = async function (...a) {
  /* R1-c barrier: hold every plain read of posRetailSales/* until N callers have made one, so the
     concurrent attempts all pass any pre-transaction check BEFORE either commits — the race the
     in-transaction guard exists for, made deterministic. (Transaction reads do not pass here.) */
  if (INJ.barrier && this.path.startsWith('posRetailSales/')) {
    const b = INJ.barrier; b.arrived++;
    if (b.arrived >= b.n) { b.release(); } else { await b.gate; }
  }
  const snap = await _origGet.apply(this, a);
  if (INJ.switchOwner && this.path === 'products/' + INJ.switchOwner.id) {
    const to = INJ.switchOwner.to; INJ.switchOwner = null;
    await _origUpdate.call(this, { sellerUid: to, shopId: to });
  }
  return snap;
};

let PZF;
try { PZF = require(path.join(FN, 'pos-zero-friction.js')); }
catch (e) { console.log('  ✖ SETUP — could not load pos-zero-friction.js: ' + e.message); process.exit(2); }

const OWNER = 'ob-owner', OTHER = 'ob-other-shop';
const REQ = (uid, data) => ({ data, auth: { uid, token: { uid } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const get = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };
const stockOf = async (id) => Number(((await get('products', id)) || {}).stock);
const salesForKey = async (k) => (await db.collection('posRetailSales').where('idempotencyKey', '==', k).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
async function checkout(key, lines, { payments, taxTotal = 0, uid = OWNER, merchantId = OWNER } = {}) {
  const prices = { P_OWN: 100, P_OWN2: 50, P_FOREIGN: 70, P_NOOWNER: 40, P_SWITCH: 90, P_EMPTY: 30, P_BIZSTRANGER: 60, P_WS: 80, P_WS2: 20 };
  const items = lines.map(([productId, qty]) => ({ productId, qty, unitPrice: prices[productId], name: productId }));
  const subtotal = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
  const grandTotal = subtotal + (typeof taxTotal === 'number' && isFinite(taxTotal) ? taxTotal : 0);
  const pay = payments || [{ method: 'cash', amount: grandTotal > 0 ? grandTotal : 1 }];
  try {
    const r = await quiet(() => PZF.posCompleteCheckout.run(REQ(uid, {
      idempotencyKey: key, merchantId, items, payments: pay, subtotal, discountTotal: 0, taxTotal, grandTotal })));
    return { ok: true, r };
  } catch (e) { return { ok: false, code: e.code, msg: e.message }; }
}
async function seed() {
  await db.collection('shops').doc(OWNER).set({ name: 'Owner Shop', ownerId: OWNER });
  await db.collection('users').doc(OWNER).set({ name: 'Owner One', displayName: 'Owner One', firstName: 'Owner' });
  const P = (id, price, owner, extra) => db.collection('products').doc(id).set(Object.assign(
    { name: id, price, stock: 20, trackInventory: true }, owner ? { sellerUid: owner, shopId: owner } : {}, extra || {}));
  await P('P_OWN', 100, OWNER); await P('P_OWN2', 50, OWNER); await P('P_FOREIGN', 70, OTHER);
  await P('P_NOOWNER', 40, null); await P('P_SWITCH', 90, OWNER); await P('P_EMPTY', 30, OWNER, { stock: 0 });
  /* R4 narrowing: a business document that merely EXISTS under the shop's id, owned by someone else. */
  await db.collection('businesses').doc(OWNER).set({ ownerId: 'ob-someone-else', name: 'stray record' });
  await P('P_BIZSTRANGER', 60, 'ob-someone-else');
  /* R4 membership path: a business proven by an active membership with the 'sales' permission. */
  await db.collection('businesses').doc('BIZ-W1').set({ ownerId: 'ob-bizowner', name: 'Workspace Biz' });
  await db.collection('workspaceMemberships').doc('ob-staff_BIZ-W1').set({ uid: 'ob-staff', businessId: 'BIZ-W1', status: 'active', permissions: ['sales'] });
  await P('P_WS', 80, 'ob-bizowner');
  await db.collection('products').doc('P_WS2').set({ name: 'P_WS2', price: 20, stock: 20, trackInventory: true, merchantId: 'BIZ-W1' });
  /* L-4 LINEAGE NOTE: on this lineage a till payment is confirmable only on the IntaSend QR rail
     (shared/pos-payment-ownership.assertConfirmable — discriminator transactionId, owner sellerId,
     success 'paid'); a Daraja 'completed' document is refused outright. The fixture is the shape
     that rail's producer (completePOSQRPayment) writes; the R2 assertions are unchanged. */
  await db.collection('posPayments').doc('REF_A').set({ transactionId: 'REF_A', status: 'paid', sellerId: OWNER, paidAmount: 100, total: 100 });
  await db.collection('posPayments').doc('REF_B').set({ transactionId: 'REF_B', status: 'paid', sellerId: OWNER, paidAmount: 100, total: 100 });
}
async function resetStock() { for (const id of ['P_OWN', 'P_OWN2', 'P_FOREIGN', 'P_NOOWNER', 'P_SWITCH', 'P_BIZSTRANGER', 'P_WS', 'P_WS2']) await db.collection('products').doc(id).update({ stock: 20 }); }

(async () => {
  console.log(`\nBatch 0b — checkout integrity   (tree: ${ROOT})\n`);
  await seed();

  /* ── CONTROL: the harness can complete a sale at all ── */
  {
    const r = await checkout('K_CTL', [['P_OWN', 1]]);
    ok(r.ok && (await stockOf('P_OWN')) === 19 && (await salesForKey('K_CTL')).length === 1, 'C-0',
      `CONTROL — a normal owned cash sale completes (stock 20→${await stockOf('P_OWN')}, sales ${(await salesForKey('K_CTL')).length})${r.ok ? '' : ' — ERR ' + r.msg}`);
    /* L-4 LINEAGE NOTE: M0-1 keys the debt posCommissionLiabilities/poscomm_<saleId>. */
    const liab = r.ok ? await get('posCommissionLiabilities', 'poscomm_' + r.r.saleId) : null;
    ok(!!liab, 'C-L1', `the commission liability is recorded for a COMMITTED sale (posCommissionLiabilities/${r.ok ? r.r.saleId.slice(0, 12) + '…' : '-'} ${liab ? 'present' : 'ABSENT'})`);
    await resetStock();
  }

  console.log('\n[R1] one sale per idempotency key');
  {
    const r1 = await checkout('K_R1A', [['P_OWN', 2]]);
    const s1 = await salesForKey('K_R1A');
    ok(r1.ok && s1.length === 1 && (await stockOf('P_OWN')) === 18, 'R1-a', `first attempt commits: 1 sale, stock 20→${await stockOf('P_OWN')}`);
    const again = await checkout('K_R1A', [['P_OWN', 2]]);
    ok(again.ok && (await salesForKey('K_R1A')).length === 1 && (await stockOf('P_OWN')) === 18, 'R1-a2',
      `CONTROL — replay of a COMPLETED key returns the same sale (cached=${again.r && again.r.cached}), no second deduction`);
    await resetStock();

    INJ.fired = 0; INJ.failComplete = 1;
    const f1 = await checkout('K_R1B', [['P_OWN', 3]]);
    INJ.failComplete = 0;
    const firedOnce = INJ.fired === 1 && !f1.ok && /INJECTED late failure/.test(f1.msg || '');
    const committedBefore = (await salesForKey('K_R1B')).length, stockAfterFail = await stockOf('P_OWN');
    ok(firedOnce && committedBefore === 1 && stockAfterFail === 17, 'R1-b0',
      `INJECTION CONFIRMED: the late failure fired once, AFTER the sale committed (sale present=${committedBefore}, stock 20→${stockAfterFail}, error="${(f1.msg || '').slice(0, 40)}")`);
    const retry = await checkout('K_R1B', [['P_OWN', 3]]);
    const afterRetry = await salesForKey('K_R1B');
    ok(retry.ok && afterRetry.length === 1 && (await stockOf('P_OWN')) === 17, 'R1-b',
      `late failure + same-key retry: ${afterRetry.length} sale(s), stock ${await stockOf('P_OWN')} (must stay 17 — no second deduction)`);
    ok(retry.ok && retry.r && afterRetry[0] && retry.r.saleId === afterRetry[0].id && retry.r.receipt, 'R1-b2',
      `the retry returns the EXISTING sale and its receipt (saleId ${retry.r && retry.r.saleId === (afterRetry[0] || {}).id ? 'matches' : 'DIFFERS'})`);
    await resetStock();

    await db.collection('posIdempotency').doc('K_R1C').set({ status: 'failed', failedAt: Date.now(), startedAt: Date.now() });
    { let rel; INJ.barrier = { n: 2, arrived: 0, gate: new Promise((r) => { rel = r; }), release: null }; INJ.barrier.release = rel; }
    const [c1, c2] = await Promise.all([checkout('K_R1C', [['P_OWN', 4]]), checkout('K_R1C', [['P_OWN', 4]])]);
    const barrierHeld = INJ.barrier.arrived >= 2; INJ.barrier = null;
    const sc = await salesForKey('K_R1C');
    ok(barrierHeld, 'R1-c0', 'RACE CONFIRMED: both attempts passed the pre-transaction check before either committed');
    ok(sc.length === 1 && (await stockOf('P_OWN')) === 16, 'R1-c',
      `concurrent re-entry with one key: ${sc.length} sale(s), stock 20→${await stockOf('P_OWN')} (ok: ${c1.ok}/${c2.ok})`);
    ok(c1.ok && c2.ok && c1.r.saleId === c2.r.saleId && sc[0] && c1.r.saleId === sc[0].id, 'R1-c2',
      `…and BOTH callers receive that one committed sale, not an error (${c1.ok ? 'ok' : c1.msg} / ${c2.ok ? 'ok' : (c2.msg || '').slice(0, 50)})`);
    await resetStock();
  }

  console.log('\n[R2] payment claims');
  {
    INJ.fired = 0; INJ.failComplete = 1;
    const a = await checkout('K_R2A', [['P_OWN', 1]], { payments: [{ method: 'mpesa', amount: 100, ref: 'REF_A' }] });
    INJ.failComplete = 0;
    const claim = await get('posPaymentClaims', 'REF_A');
    ok(INJ.fired === 1 && !a.ok && (await salesForKey('K_R2A')).length === 1, 'R2-a0',
      `INJECTION CONFIRMED: M-PESA sale committed then failed late (fired=${INJ.fired}, sale present=${(await salesForKey('K_R2A')).length})`);
    ok(!!claim && claim.idempotencyKey === 'K_R2A', 'R2-a', `a COMMITTED sale keeps its payment claim (claim ${claim ? 'held by ' + claim.idempotencyKey : 'RELEASED'})`);
    const b = await checkout('K_R2A_OTHERKEY', [['P_OWN', 1]], { payments: [{ method: 'mpesa', amount: 100, ref: 'REF_A' }] });
    ok(!b.ok && /already been used/.test(b.msg || '') && (await salesForKey('K_R2A_OTHERKEY')).length === 0, 'R2-b',
      `the same confirmed payment cannot fund a second sale under another key (${b.ok ? 'SOLD AGAIN' : 'refused: ' + (b.msg || '').slice(0, 50)})`);
    await resetStock();

    const g = await checkout('K_R2G', [['P_EMPTY', 1]], { payments: [{ method: 'mpesa', amount: 30, ref: 'REF_B' }] });
    const gClaim = await get('posPaymentClaims', 'REF_B');
    ok(!g.ok && !gClaim && (await salesForKey('K_R2G')).length === 0, 'R2-c',
      `a genuinely FAILED transaction (no stock) still releases its claim (claim ${gClaim ? 'HELD' : 'released'}; ${(g.msg || '').slice(0, 40)})`);
    const g2 = await checkout('K_R2G2', [['P_OWN', 1]], { payments: [{ method: 'mpesa', amount: 100, ref: 'REF_B' }] });
    ok(g2.ok && (await salesForKey('K_R2G2')).length === 1, 'R2-d', `…so that payment can still pay for a sale (${g2.ok ? 'sold' : 'ERR ' + g2.msg})`);
    const liabCount = (await db.collection('posCommissionLiabilities').get()).docs
      .filter((d) => { const x = d.data() || {}; return x.merchantUid === OWNER; }).length;
    const committedCount = (await db.collection('posRetailSales').where('merchantId', '==', OWNER).get()).size;
    ok(liabCount === committedCount, 'C-L2', `liabilities exist ONLY for committed sales: ${liabCount} liabilities for ${committedCount} committed sales (the refused/failed attempts above left none)`);
    await resetStock();
  }

  console.log('\n[R3] taxTotal');
  {
    const neg = await checkout('K_R3N', [['P_OWN', 3]], { taxTotal: -290 });
    const negSale = (await salesForKey('K_R3N'))[0];
    ok(!neg.ok && !negSale, 'R3-a', `a NEGATIVE taxTotal (−290 on a 300 cart) is refused (${neg.ok ? 'SOLD at ' + (negSale && negSale.grandTotal) : 'refused: ' + (neg.msg || '').slice(0, 45)})`);
    /* A non-number the OLD code genuinely accepts: `true` coerces to 1 inside the total. (A string
       like "16" was refused by the old code only by accident — it concatenated into the total and
       tripped the mismatch check — so it could not discriminate.) */
    const str = await checkout('K_R3S', [['P_OWN', 1]], { taxTotal: true });
    ok(!str.ok && (await salesForKey('K_R3S')).length === 0, 'R3-b', `a non-number taxTotal (true) is refused (${str.ok ? 'SOLD' : (await salesForKey('K_R3S')).length ? 'failed AFTER a sale was written' : 'refused'})`);
    const nan = await checkout('K_R3NaN', [['P_OWN', 1]], { taxTotal: NaN });
    ok(!nan.ok && (await salesForKey('K_R3NaN')).length === 0, 'R3-c', `NaN taxTotal is refused (${nan.ok ? 'SOLD' : (await salesForKey('K_R3NaN')).length ? 'failed AFTER a sale was written' : 'refused'})`);
    const pos = await checkout('K_R3P', [['P_OWN', 1]], { taxTotal: 16 });
    const posSale = (await salesForKey('K_R3P'))[0];
    ok(pos.ok && posSale && posSale.grandTotal === 116, 'R3-d', `CONTROL — a positive tax still applies as before (grandTotal ${posSale && posSale.grandTotal})`);
    await resetStock();
  }

  console.log('\n[R4] product ownership');
  {
    const f1 = await checkout('K_R4F', [['P_FOREIGN', 1]]);
    ok(!f1.ok && (await stockOf('P_FOREIGN')) === 20 && (await salesForKey('K_R4F')).length === 0, 'R4-a',
      `another shop's product (single item) is refused; its stock untouched (${f1.ok ? 'SOLD, stock ' + (await stockOf('P_FOREIGN')) : 'refused: ' + (f1.msg || '').slice(0, 40)})`);
    const f2 = await checkout('K_R4M', [['P_OWN', 1], ['P_FOREIGN', 1]]);
    ok(!f2.ok && (await stockOf('P_FOREIGN')) === 20 && (await stockOf('P_OWN')) === 20, 'R4-b',
      `multi-item cart with one foreign line is refused whole; neither stock moves (${f2.ok ? 'SOLD' : 'refused'}; own ${await stockOf('P_OWN')}, foreign ${await stockOf('P_FOREIGN')})`);
    const f3 = await checkout('K_R4O', [['P_NOOWNER', 1]]);
    ok(!f3.ok && (await stockOf('P_NOOWNER')) === 20, 'R4-c', `an OWNERLESS product is refused (fail closed) (${f3.ok ? 'SOLD' : 'refused'})`);
    INJ.switchOwner = { id: 'P_SWITCH', to: OTHER };
    const f4 = await checkout('K_R4T', [['P_SWITCH', 1]]);
    INJ.switchOwner = null;
    ok(!f4.ok && (await stockOf('P_SWITCH')) === 20, 'R4-d',
      `owner changes between the pricing read and the transaction → refused INSIDE the transaction (${f4.ok ? 'SOLD, stock ' + (await stockOf('P_SWITCH')) : 'refused'})`);
    await db.collection('products').doc('P_SWITCH').update({ sellerUid: OWNER, shopId: OWNER });
    const f6 = await checkout('K_R4B', [['P_BIZSTRANGER', 1]]);
    ok(!f6.ok && (await stockOf('P_BIZSTRANGER')) === 20, 'R4-f',
      `shop path: a product owned by whoever a stray businesses/{shopId} record names is refused — that record did not admit this sale (${f6.ok ? 'SOLD' : 'refused'})`);
    const w1 = await checkout('K_R4W1', [['P_WS', 1], ['P_WS2', 1]], { uid: 'ob-staff', merchantId: 'BIZ-W1' });
    ok(w1.ok && (await stockOf('P_WS')) === 19 && (await stockOf('P_WS2')) === 19, 'R4-W1',
      `CONTROL — membership path: staff proven by an active 'sales' membership sell the business's products (owner uid AND business id) (${w1.ok ? 'sold' : 'ERR ' + w1.msg})`);
    const w2 = await checkout('K_R4W2', [['P_OWN', 1]], { uid: 'ob-staff', merchantId: 'BIZ-W1' });
    ok(!w2.ok && /another shop/.test(w2.msg || ''), 'R4-W2',
      `membership path: another merchant's product is refused (${w2.ok ? 'SOLD' : (w2.msg || '').slice(0, 40)})`);
    await resetStock();   /* the control must not inherit stock moved by a refused-or-not line above */
    const c = await checkout('K_R4C', [['P_OWN', 1], ['P_OWN2', 2]]);
    ok(c.ok && (await stockOf('P_OWN')) === 19 && (await stockOf('P_OWN2')) === 18, 'R4-e',
      `CONTROL — a multi-item cart of the shop's OWN products sells (${c.ok ? 'sold' : 'ERR ' + c.msg})`);
    await resetStock();
  }

  console.log('\n[R5] pos-checkout.html — one key per sale');
  {
    const html = fs.readFileSync(path.join(ROOT, 'pos-checkout.html'), 'utf8');
    const fnText = (name) => {
      const re = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(');
      const m = re.exec(html); if (!m) return null;
      let i = html.indexOf('{', m.index), d = 0;
      for (let j = i; j < html.length; j++) { if (html[j] === '{') d++; else if (html[j] === '}') { d--; if (!d) return html.slice(m.index, j + 1); } }
      return null;
    };
    const parts = ['_saleKeySlot', '_saleKey', '_clearSaleKey', '_finalize', '_resetSale'].map(fnText).filter(Boolean);
    ok(parts.length >= 2 && fnText('_finalize') && fnText('_resetSale'), 'R5-0', `extracted the REAL _finalize and _resetSale bodies (${parts.length} functions)`);
    const store = new Map();
    const keys = [];
    const el = () => new Proxy({ classList: { add() {}, remove() {}, toggle() {} }, style: {}, value: '', innerHTML: '', focus() {} }, { get: (t, k) => (k in t ? t[k] : () => {}) });
    const ctx = vm.createContext({
      _s: { merchantId: 'M1', cashierId: 'C1', branchId: 'b', items: [{ productId: 'P', qty: 1, unitPrice: 1, name: 'P' }], discount: {}, displayChannel: null },
      sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
      window: {}, navigator: { onLine: true }, crypto: require('crypto').webcrypto, Uint32Array, Date, Math, Array, Promise, JSON, setTimeout: () => 0,
      document: { getElementById: el }, console: { log() {}, warn() {}, error() {} },
      _setState() {}, _resolveMerchantId() {}, _toast() {}, clearCustomer() {}, _renderCart() {}, _updateTotals() {}, _broadcastDisplayUpdate() {},
      PosSales: { park: async () => {} },
      firebase: { functions: () => ({ httpsCallable: () => async (payload) => { keys.push(payload.idempotencyKey); const e = new Error('deadline'); e.code = 'deadline-exceeded'; throw e; } }) },
    });
    vm.runInContext(parts.join('\n') + '\n;this.__f=_finalize; this.__r=_resetSale;', ctx);
    const totals = { subtotal: 1, discount: 0, couponDsc: 0, tax: 0, total: 1 };
    await ctx.__f('cash', [{ method: 'cash', amount: 1 }], totals);
    await new Promise((r) => setTimeout(r, 5));
    await ctx.__f('cash', [{ method: 'cash', amount: 1 }], totals);
    ok(keys.length === 2 && keys[0] === keys[1], 'R5-a', `a retry of the SAME sale reproduces the key (${keys[0]} | ${keys[1]})`);
    ctx.__r();
    await ctx.__f('cash', [{ method: 'cash', amount: 1 }], totals);
    ok(keys.length === 3 && keys[2] !== keys[0], 'R5-b', `CONTROL — after the sale is reset, the NEXT sale gets a new key (${keys[2] !== keys[0] ? 'new' : 'SAME'})`);
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✖ CRASH — ' + (e && e.stack || e)); process.exit(4); });
