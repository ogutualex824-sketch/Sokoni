#!/usr/bin/env node
/* test-gateway-order-authority.js — GATE 11 (INTASEND convergence brief §Gate 11 + §Gate 15 matrix), 2026-10-03.
 *
 *   node scripts/test-gateway-order-authority.js                       # working tree — must PASS
 *   SABOTAGE=<name> node scripts/test-gateway-order-authority.js       # one fault, injected into a TEMP COPY
 *   COUNTERPROOF=1 node scripts/test-gateway-order-authority.js        # the PRE-REPAIR gateway (7170b0f) — must FAIL
 *   node scripts/test-gateway-order-authority.js --failure-injection   # every fault: each must fail its NAMED row; the
 *                                                                      # tree's files are hashed before and after
 *
 * sokoniAPIGateway POST /api/v1/orders used to store items priced from the CALLER's unitPrice, never read products/{id},
 * carried no seller and no takedown check. Repaired: the server resolves product, seller, price tier, quantity,
 * availability and stock through the ONE pricing authority (payment-purposes.js validateOrderLines — the function
 * createPaymentIntent's product_order pricer uses), refuses a taken-down product through the shared sale-eligibility rule
 * (shared/product-sale-eligibility.js, byte-identical from b5d0541, sha256 1d34747d00b527df), and stores the order as
 * 'pending_payment' with payment.payable:false and NO total/amount — the payable amount is createPaymentIntent's
 * amountCents, never a figure on the order.
 *
 * The REAL functions/api-gateway.js (whole request pipeline: CORS → auth → rate limit → versioning → route) and the REAL
 * payment-purposes.js run on the transactional fake Firestore (scripts/lib/fake-firestore-txn.js).
 * NO PRODUCTION, NO NETWORK, NO EMULATOR. TRIPWIRES (incident 2026-10-01): the real `firebase-admin` package is
 * UNLOADABLE (any resolution into node_modules/firebase-admin throws) — the bare id is served an in-memory stub bound to
 * the fake Firestore; `notify.js` THROWS on require. Row Z1 asserts both held.
 *
 * Gate 15 rows that belong to the payment-intent / webhook authority (createPaymentIntent, webhookIntasend — owner
 * sokoni-5b) are recorded as DELEGATED with the reason; the part of each row that the gateway CAN prove is executed.
 * Every row prints: test id, expected, observed, pass/fail, mutation, database / money / order / ledger effect.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const FILES = ['api-gateway.js', 'product-visibility.js', 'payment-purposes.js', 'availability-enforce.js', 'shared/product-sale-eligibility.js'];

/* PINS — the pricing authority and the eligibility rule must be the ones certified, byte for byte */
const PIN_ELIGIBILITY = '1d34747d00b527df';            /* b5d0541:functions/shared/product-sale-eligibility.js */
const PIN_PURPOSES_FILE = '3ed2b1f883279f13';           /* this lineage's payment-purposes.js, unedited */
const PIN_VALIDATE_LINES = 'c944cf66651187b7';          /* validateOrderLines() text == b5d0541's minus its 4-line
                                                           saleBlock insertion (b5d0541 function sha 464b62913cb5acf5) */

const SABOTAGES = {
  'trust-client-unitprice': { file: 'api-gateway.js', catch: 'INVALID_AMOUNT', pairs: [
    ['        unitPrice: l.unitPrice,                                  /* server: salePrice || price */',
     '        unitPrice: Number((body.items.find((x) => x && x.productId === l.productId) || {}).unitPrice) || l.unitPrice,'],
    ['    const subtotal = priced.subtotal;', '    const subtotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);'] ] },
  'skip-eligibility': { file: 'api-gateway.js', catch: 'G_HELD', pairs: [['      if (eligibility.saleBlock(p)) {', '      if (false) {']] },
  'payable-on-create': { file: 'api-gateway.js', catch: 'VALID_PAYMENT', pairs: [
    ["      status:          'pending_payment',\n      paymentStatus:   'pending',",
     "      status:          'paid',\n      paymentStatus:   'paid',\n      total:           priced.subtotal,\n      paymentVerified: true,"],
    ['        payable:        false,\n        intentRequired: true,', '        payable:        true,\n        intentRequired: false,'] ] },
  'trust-client-seller': { file: 'api-gateway.js', catch: 'G_SELLER', pairs: [
    ['    const sellerUid = sellers[0];', '    const sellerUid = String((body.items[0] && body.items[0].sellerUid) || sellers[0]);']] },
  'no-idempotency': { file: 'api-gateway.js', catch: 'DUPLICATE_CALLBACK', pairs: [
    ["    const orderRef = clientOrderId\n      ? firestore.collection('orders')", "    const orderRef = false\n      ? firestore.collection('orders')"]] },
  'currency-from-client': { file: 'api-gateway.js', catch: 'WRONG_CURRENCY', pairs: [
    ["  if (body.currency !== undefined && body.currency !== null && String(body.currency).toUpperCase() !== GW_ORDER_CURRENCY) {", '  if (false) {'],
    ['      currency:        GW_ORDER_CURRENCY,\n      /* NO total', '      currency:        String(body.currency || GW_ORDER_CURRENCY),\n      /* NO total']] },
};

if (process.argv.includes('--failure-injection')) {
  const hash = () => FILES.map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(FN, f))).digest('hex')).join(',');
  const before = hash(); let ok = true;
  for (const [name, s] of Object.entries(SABOTAGES)) {
    const r = cp.spawnSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: name }), encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const caught = new RegExp('FAIL  ' + s.catch + ' ').test(out);
    console.log(`  ${caught ? 'CAUGHT' : 'MISSED'}  ${name.padEnd(24)} → ${s.catch}${caught ? '' : '\n' + out.slice(-1500)}`);
    if (!caught) ok = false;
  }
  const same = hash() === before;
  console.log(`\nfailure injection: ${ok ? 'every fault caught by its named row' : 'A FAULT WAS MISSED'}; tree files unchanged: ${same}`);
  process.exit(ok && same ? 0 : 1);
}

/* ── source: the tree, or a temp copy with one fault ── */
let SRC = FN, TMP = null;
if (process.env.SABOTAGE) {
  const s = SABOTAGES[process.env.SABOTAGE];
  if (!s) { console.error('unknown SABOTAGE'); process.exit(2); }
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-order-'));
  for (const f of FILES) { fs.mkdirSync(path.dirname(path.join(TMP, f)), { recursive: true }); fs.copyFileSync(path.join(FN, f), path.join(TMP, f)); }
  let src = fs.readFileSync(path.join(TMP, s.file), 'utf8'); const crlf = src.includes('\r\n'); if (crlf) src = src.replace(/\r\n/g, '\n');
  for (const [a, b] of s.pairs) { if (!src.includes(a)) { console.log('  FAIL  ' + s.catch + ' (sabotage anchor not found — the test is stale): ' + a.slice(0, 80)); process.exit(1); } src = src.replace(a, b); }
  fs.writeFileSync(path.join(TMP, s.file), src);
  SRC = TMP;
}

/* COUNTERPROOF=1: the pre-repair gateway (7170b0f) on the same fakes — its failures ARE the defect */
if (process.env.COUNTERPROOF && !TMP) {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-order-cp-'));
  for (const f of FILES) { fs.mkdirSync(path.dirname(path.join(TMP, f)), { recursive: true }); fs.copyFileSync(path.join(FN, f), path.join(TMP, f)); }
  fs.writeFileSync(path.join(TMP, 'api-gateway.js'), cp.execFileSync('git', ['show', '7170b0f:functions/api-gateway.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }));
  SRC = TMP;
}

/* ── tripwires + stubs ── */
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), strictReadOrder: false });
const db = F.db;
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const TOKENS = { 'tok-buyer': { uid: 'buyer1' }, 'tok-buyer2': { uid: 'buyer2' }, 'tok-seller': { uid: 'sellerA' } };
let adminStubServed = 0, tripped = { admin: 0, notify: 0 };
const adminStub = {
  apps: [1], initializeApp() {},
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: { fromMillis: (ms) => new Date(ms), now: () => new Date() } }),
  auth: () => ({ verifyIdToken: async (t) => { if (TOKENS[t]) return Object.assign({}, TOKENS[t]); throw new Error('bad token'); } }),
};
const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop, log: noop, write: noop };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const r = origResolve.call(this, request, parent, ...rest);
  if (/node_modules[\\/]firebase-admin[\\/]/.test(r)) { tripped.admin++; throw new Error('TRIPWIRE: the real firebase-admin resolved from a test: ' + request); }
  return r;
};
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './notify' || /[\\/]notify(\.js)?$/.test(id)) { tripped.notify++; throw new Error('TRIPWIRE: notify.js required from a test'); }
  if (id === 'firebase-admin') { adminStubServed++; return adminStub; }
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (/^firebase-admin\//.test(id)) { tripped.admin++; throw new Error('TRIPWIRE: real firebase-admin submodule ' + id); }
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2') return { logger, https: { onRequest: (_o, h) => (h || _o), onCall: (_o, h) => (h || _o), HttpsError } };
  if (id === 'firebase-functions/logger') return logger;
  if (id === 'firebase-functions') return { logger, https: { HttpsError } };
  return origReq.apply(this, arguments);
};

const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
let pass = 0, fail = 0; const table = [];
/* one Gate-15 record per row */
function row(id, { expected, observed, ok, mutation, dbEffect, money, order, ledger, delegated }) {
  table.push({ id, expected, observed, result: ok ? 'PASS' : 'FAIL', mutation, dbEffect, money, order, ledger, delegated: delegated || null });
  if (ok) { pass++; say('  PASS  ' + id + ' — ' + expected); } else { fail++; say('  FAIL  ' + id + ' — ' + expected + '\n        observed: ' + String(observed).slice(0, 600)); }
}

function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.set = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.setHeader = r.set; r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; }; r.send = (b) => { r.body = b; return r; }; r.end = () => r;
  return r;
}
let GW;
let ipSeq = 0;
async function post(token, body) {
  const res = fakeRes(); const p = '/api/v1/orders'; const ip = '10.0.1.' + (++ipSeq % 250);
  await GW.sokoniAPIGateway({ method: 'POST', path: p, url: p, originalUrl: p, body, query: {},
    headers: { origin: 'https://mysokoni.co.ke', 'content-type': 'application/json', authorization: token ? 'Bearer ' + token : '', 'content-length': '200' },
    ip, socket: { remoteAddress: ip }, get: (h) => ({ 'content-type': 'application/json' })[String(h).toLowerCase()] || '' }, res);
  return res;
}
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const orders = () => db._dump('orders/');
const MONEY_COLLECTIONS = ['payments/', 'paymentIntents/', 'walletTransactions/', 'wallets/', 'ledger/', 'ledgerEntries/', 'settlements/', 'transactions/'];
const moneyDocs = () => MONEY_COLLECTIONS.reduce((n, c) => n + db._dump(c).length, 0);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fnText = (s, name) => { const i = s.indexOf('async function ' + name); let d = 0, j = s.indexOf('{', i); for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) break; } } return s.slice(i, j + 1); };
const DELEGATED = 'delegated to createPaymentIntent / webhookIntasend (owner sokoni-5b), proven there';
const NO_MONEY = 'none (no payments / intents / wallet / ledger / settlement document)';

(async () => {
  say('\nSOURCE: ' + (TMP ? 'SABOTAGE=' + process.env.SABOTAGE + ' (temp copy)' : 'working tree') + ' — ' + SRC);
  GW = require(path.join(SRC, 'api-gateway.js'));

  /* catalogue: the server's truth */
  await db.doc('products/p1').set({ name: 'Kitenge Dress', sellerUid: 'sellerA', shopId: 'shopA', price: 2500, status: 'active', isVisible: true, stock: 10 });
  await db.doc('products/p2').set({ name: 'Leso', sellerUid: 'sellerA', shopId: 'shopA', price: 600, salePrice: 450, status: 'active', isVisible: true });
  await db.doc('products/pB').set({ name: 'Sufuria', sellerUid: 'sellerB', shopId: 'shopB', price: 900, status: 'active', isVisible: true });
  /* taken down by the report authority — and a stray writer has re-set isVisible: only the hold itself stops the sale */
  await db.doc('products/pHeld').set({ name: 'Rolex Watch', sellerUid: 'sellerA', shopId: 'shopA', price: 9000, status: 'active', isVisible: true,
    moderationHold: { active: true, ref: 'Zk3q9mX2aB7cD1eF', at: new Date(), previousIsVisible: true } });
  const ADDR = { street: '1 Moi Ave', city: 'Nairobi', county: 'Nairobi' };

  /* ── PINS ── */
  const elig = sha(fs.readFileSync(path.join(SRC, 'shared/product-sale-eligibility.js'))).slice(0, 16);
  const ppBytes = fs.readFileSync(path.join(SRC, 'payment-purposes.js'));
  const ppFile = sha(ppBytes).slice(0, 16);
  const vol = sha(fnText(ppBytes.toString('utf8'), 'validateOrderLines')).slice(0, 16);
  const gwSrc = fs.readFileSync(path.join(SRC, 'api-gateway.js'), 'utf8');
  const usesAuthority = /require\('\.\/payment-purposes'\)\.validateOrderLines\(/.test(gwSrc) && /require\('\.\/shared\/product-sale-eligibility'\)/.test(gwSrc);
  row('G_PIN', { expected: `eligibility sha ${PIN_ELIGIBILITY}; payment-purposes.js sha ${PIN_PURPOSES_FILE} (unedited); validateOrderLines sha ${PIN_VALIDATE_LINES}; the gateway calls both`,
    observed: `eligibility ${elig}; purposes ${ppFile}; validateOrderLines ${vol}; gateway uses authority: ${usesAuthority}`,
    ok: elig === PIN_ELIGIBILITY && ppFile === PIN_PURPOSES_FILE && vol === PIN_VALIDATE_LINES && usesAuthority,
    mutation: 'n/a (byte pins)', dbEffect: 'none', money: 'none', order: 'none', ledger: 'none' });

  /* ── VALID_PAYMENT ── */
  const m0 = moneyDocs();
  const v = await post('tok-buyer', { items: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }], deliveryAddress: ADDR, paymentMethod: 'mpesa' });
  const vd = v.body && v.body.data; const vo = vd && await get('orders/' + vd.orderId);
  const noMoneyFields = vo && ['total', 'amount', 'amountCents', 'totalAmount', 'orderTotal', 'grandTotal', 'paymentVerified', 'paidAt'].every((k) => !(k in vo));
  row('VALID_PAYMENT', {
    expected: '201; order stored with SERVER economics (p1 2×2500 + p2 1×450 salePrice = 5450), seller from products, status pending_payment, payment.payable:false, no total/amount field; response says call createPaymentIntent',
    observed: JSON.stringify({ http: v.statusCode, status: vo && vo.status, subtotal: vo && vo.subtotal, seller: vo && vo.sellerUid, payable: vo && vo.payment && (vo.payment || {}).payable,
      lines: vo && vo.items.map((i) => [i.productId, i.quantity, i.unitPrice, i.priceBasis]), noMoneyFields, next: vd && vd.nextStep, respPayable: vd && vd.payable }),
    ok: v.statusCode === 201 && vo && vo.status === 'pending_payment' && vo.paymentStatus === 'pending' && vo.subtotal === 5450 && vo.sellerUid === 'sellerA'
      && vo.buyerId === 'buyer1' && vo.currency === 'KES' && (vo.payment || {}).payable === false && (vo.payment || {}).intentRequired === true && (vo.payment || {}).intentId === null
      && vo.items[0].unitPrice === 2500 && vo.items[1].unitPrice === 450 && vo.items[1].priceBasis === 'salePrice' && noMoneyFields
      && vd.payable === false && vd.nextStep && vd.nextStep.call === 'createPaymentIntent' && vd.nextStep.purpose === 'product_order' && moneyDocs() === m0,
    mutation: 'none (honest request)', dbEffect: 'one orders/{id} (pending_payment)', money: NO_MONEY, order: 'created, NOT payable', ledger: 'none' });

  /* ── INVALID_AMOUNT: the caller names a price ── */
  const ia = await post('tok-buyer', { items: [{ productId: 'p1', quantity: 3, unitPrice: 1, name: 'cheap', shopId: 'x' }], subtotal: 3, total: 3, amount: 3,
    deliveryAddress: ADDR, paymentMethod: 'mpesa' });
  const iao = ia.body && ia.body.data && await get('orders/' + ia.body.data.orderId);
  row('INVALID_AMOUNT', {
    expected: 'caller unitPrice 1 / subtotal 3 / total 3 IGNORED: stored unitPrice 2500, subtotal 7500 (server), no total field',
    observed: JSON.stringify({ http: ia.statusCode, unitPrice: iao && iao.items[0].unitPrice, name: iao && iao.items[0].name, subtotal: iao && iao.subtotal, total: iao && iao.total, respSubtotal: ia.body && ia.body.data && ia.body.data.subtotal }),
    ok: ia.statusCode === 201 && iao && iao.items[0].unitPrice === 2500 && iao.items[0].lineTotal === 7500 && iao.items[0].name === 'Kitenge Dress' && iao.items[0].shopId === 'shopA'
      && iao.subtotal === 7500 && !('total' in iao) && !('amount' in iao) && ia.body.data.subtotal === 7500,
    mutation: 'unitPrice:1, subtotal:3, total:3, amount:3, name/shopId forged', dbEffect: 'one order, server prices only', money: NO_MONEY, order: 'created at server price, NOT payable', ledger: 'none' });

  /* ── G_SELLER: the caller names a seller ── */
  const gs = await post('tok-buyer', { items: [{ productId: 'p1', quantity: 1, sellerUid: 'attacker' }], sellerUid: 'attacker', deliveryAddress: ADDR, paymentMethod: 'card' });
  const gso = gs.body && gs.body.data && await get('orders/' + gs.body.data.orderId);
  const mix = await post('tok-buyer', { items: [{ productId: 'p1', quantity: 1 }, { productId: 'pB', quantity: 1 }], deliveryAddress: ADDR, paymentMethod: 'card' });
  const own = await post('tok-seller', { items: [{ productId: 'p1', quantity: 1 }], deliveryAddress: ADDR, paymentMethod: 'card' });
  row('G_SELLER', {
    expected: 'seller = products/{id}.sellerUid (caller sellerUid ignored); a two-seller cart and a seller ordering their own product are refused (409), nothing written',
    observed: JSON.stringify({ seller: gso && gso.sellerUid, lineSeller: gso && gso.items[0].sellerUid, mix: mix.statusCode, mixCode: mix.body && mix.body.error && mix.body.error.code, own: own.statusCode }),
    ok: gso && gso.sellerUid === 'sellerA' && gso.items[0].sellerUid === 'sellerA' && mix.statusCode === 409 && mix.body.error.code === 'orders/multiple-sellers' && own.statusCode === 409,
    mutation: 'sellerUid:"attacker" on body + line; mixed-seller cart; self-order', dbEffect: 'one order (honest seller); refusals write nothing', money: NO_MONEY, order: 'seller from catalogue', ledger: 'none' });

  /* ── G_HELD: a taken-down product ── */
  const nBefore = orders().length;
  const held = await post('tok-buyer', { items: [{ productId: 'p1', quantity: 1 }, { productId: 'pHeld', quantity: 1 }], deliveryAddress: ADDR, paymentMethod: 'mpesa' });
  const heldMsg = JSON.stringify(held.body || {});
  row('G_HELD', {
    expected: 'a product under moderationHold is refused (409 orders/product-unavailable, same wording as unavailable — no moderation/report metadata), even with isVisible re-set true; the whole cart is refused, nothing written',
    observed: JSON.stringify({ http: held.statusCode, body: held.body && held.body.error, ordersAdded: orders().length - nBefore }),
    ok: held.statusCode === 409 && held.body.error.code === 'orders/product-unavailable' && /not currently available/.test(held.body.error.message)
      && !/moderat|report|review|hold|Zk3q9/i.test(heldMsg) && orders().length === nBefore,
    mutation: 'order a taken-down product (hold present, isVisible forced true)', dbEffect: 'none', money: NO_MONEY, order: 'none', ledger: 'none' });

  /* ── PARTIAL_PAYMENT ── */
  row('PARTIAL_PAYMENT', {
    expected: 'gateway part: an order carries NO payable amount, so nothing at the gateway can be partly paid; the amount match to the cent is the webhook gate against the intent\'s amountCents',
    observed: JSON.stringify({ payableField: vo && (vo.pricing || {}).payable, amountFields: vo && ['total', 'amount', 'amountCents'].filter((k) => k in vo) }),
    ok: vo && (vo.pricing || {}).payable === null && ['total', 'amount', 'amountCents'].every((k) => !(k in vo)),
    mutation: 'n/a at the gateway (no payment surface)', dbEffect: 'none', money: 'none', order: 'unchanged', ledger: 'none',
    delegated: DELEGATED + ' — the intent fixes amountCents; webhookIntasend compares the provider amount to it' });

  /* ── WRONG_ORDER ── */
  row('WRONG_ORDER', {
    expected: 'gateway part: the gateway mints no payment and binds no reference to any order (payment.intentId null); binding a payment to its order is the intent (preferredRef = orderId) + webhook',
    observed: JSON.stringify({ intentId: vo && (vo.payment || {}).intentId, moneyDocs: moneyDocs() }),
    ok: vo && (vo.payment || {}).intentId === null && moneyDocs() === m0,
    mutation: 'n/a at the gateway', dbEffect: 'none', money: 'none', order: 'unchanged', ledger: 'none', delegated: DELEGATED });

  /* ── WRONG_BUYER ── */
  const wbKey = 'shared-key-0001';
  const wb1 = await post('tok-buyer', { items: [{ productId: 'p1', quantity: 1 }], clientOrderId: wbKey, buyerId: 'victim', deliveryAddress: ADDR, paymentMethod: 'mpesa' });
  const wb2 = await post('tok-buyer2', { items: [{ productId: 'p1', quantity: 1 }], clientOrderId: wbKey, deliveryAddress: ADDR, paymentMethod: 'mpesa' });
  const wbo1 = wb1.body && wb1.body.data && await get('orders/' + wb1.body.data.orderId);
  const wbo2 = wb2.body && wb2.body.data && await get('orders/' + wb2.body.data.orderId);
  row('WRONG_BUYER', {
    expected: 'gateway part: buyer = the verified token uid (body buyerId ignored); another buyer using the SAME clientOrderId gets their OWN order, never the first buyer\'s',
    observed: JSON.stringify({ b1: wbo1 && wbo1.buyerId, b2: wbo2 && wbo2.buyerId, same: wb1.body && wb2.body && wb1.body.data && wb2.body.data && wb1.body.data.orderId === wb2.body.data.orderId }),
    ok: wbo1 && wbo2 && wbo1.buyerId === 'buyer1' && wbo2.buyerId === 'buyer2' && wb1.body.data.orderId !== wb2.body.data.orderId,
    mutation: 'body buyerId:"victim"; second buyer replays the first buyer\'s clientOrderId', dbEffect: 'two orders, one per buyer', money: NO_MONEY, order: 'each bound to its own buyer', ledger: 'none',
    delegated: DELEGATED + ' — payment↔buyer binding (intent owner vs payer) is checked by createPaymentIntent and the webhook' });

  /* ── MISSING_PAYMENT ── */
  row('MISSING_PAYMENT', {
    expected: 'an order with no payment stays pending_payment / paymentStatus pending / payable:false; nothing marks it paid (onNewOrderCreated + emailOnOrderCreated fail closed on non-paid)',
    observed: JSON.stringify({ status: vo && vo.status, paymentStatus: vo && vo.paymentStatus, payable: vo && (vo.payment || {}).payable }),
    ok: vo && vo.status === 'pending_payment' && vo.paymentStatus === 'pending' && (vo.payment || {}).payable === false && !('paymentVerified' in vo),
    mutation: 'create an order and never pay', dbEffect: 'order only', money: NO_MONEY, order: 'not payable, not paid', ledger: 'none' });

  /* ── UNVERIFIED_PAYMENT / FAKE_REFERENCE / BROWSER_SUCCESS_WITHOUT_PROVIDER ── */
  const forged = await post('tok-buyer', { items: [{ productId: 'p2', quantity: 2 }], deliveryAddress: ADDR, paymentMethod: 'mpesa',
    status: 'paid', paymentStatus: 'paid', paymentVerified: true, paid: true, paymentReference: 'FAKE-REF-123', transactionId: 'QWE123RTY', mpesaReceipt: 'SFAKE00001',
    payment: { payable: true, intentId: 'pi_fake' } });
  const fo = forged.body && forged.body.data && await get('orders/' + forged.body.data.orderId);
  const foStr = JSON.stringify(fo || {});
  row('UNVERIFIED_PAYMENT', {
    expected: 'a caller asserting paymentVerified/paid/status:paid is ignored: order is pending_payment, payable:false',
    observed: JSON.stringify({ status: fo && fo.status, paymentStatus: fo && fo.paymentStatus, payable: fo && (fo.payment || {}).payable, intentId: fo && (fo.payment || {}).intentId }),
    ok: fo && fo.status === 'pending_payment' && fo.paymentStatus === 'pending' && (fo.payment || {}).payable === false && (fo.payment || {}).intentId === null && !('paymentVerified' in fo),
    mutation: 'status:"paid", paymentStatus:"paid", paymentVerified:true, payment.intentId:"pi_fake"', dbEffect: 'one order, non-payable', money: NO_MONEY, order: 'pending_payment', ledger: 'none',
    delegated: DELEGATED + ' — provider verification of a real payment' });
  row('FAKE_REFERENCE', {
    expected: 'a caller-named paymentReference / transactionId / receipt is never stored or bound',
    observed: JSON.stringify({ stored: /FAKE-REF-123|QWE123RTY|SFAKE00001|pi_fake/.test(foStr) }),
    ok: fo && !/FAKE-REF-123|QWE123RTY|SFAKE00001|pi_fake/.test(foStr),
    mutation: 'paymentReference / transactionId / mpesaReceipt forged', dbEffect: 'no reference stored', money: NO_MONEY, order: 'pending_payment', ledger: 'none',
    delegated: DELEGATED + ' — a reference is accepted only from the provider, at the webhook' });
  row('BROWSER_SUCCESS_WITHOUT_PROVIDER', {
    expected: 'a browser "success" (paid:true) creates no paid state, no payment, no ledger row',
    observed: JSON.stringify({ status: fo && fo.status, moneyDocs: moneyDocs() - m0 }),
    ok: fo && fo.status === 'pending_payment' && moneyDocs() === m0,
    mutation: 'paid:true + status:"paid" from the browser, no provider', dbEffect: 'order only', money: NO_MONEY, order: 'pending_payment', ledger: 'none',
    delegated: DELEGATED + ' — only webhookIntasend moves an order to paid' });

  /* ── DUPLICATE_CALLBACK (gateway analogue: duplicate POST) / REPLAY_CALLBACK (same key, different cart) ── */
  const n0 = orders().length;
  const k = 'order-key-abc123';
  const d1 = await post('tok-buyer', { items: [{ productId: 'p1', quantity: 1 }], clientOrderId: k, deliveryAddress: ADDR, paymentMethod: 'mpesa' });
  const d2 = await post('tok-buyer', { items: [{ productId: 'p1', quantity: 1 }], clientOrderId: k, deliveryAddress: ADDR, paymentMethod: 'mpesa' });
  row('DUPLICATE_CALLBACK', {
    expected: 'gateway part: the same buyer re-POSTing the same clientOrderId gets the SAME order (200, replayed:true) — exactly one order document',
    observed: JSON.stringify({ s1: d1.statusCode, s2: d2.statusCode, same: d1.body && d2.body && d1.body.data && d2.body.data && d1.body.data.orderId === d2.body.data.orderId, replayed: d2.body && d2.body.data && d2.body.data.replayed, added: orders().length - n0 }),
    ok: d1.statusCode === 201 && d2.statusCode === 200 && d1.body.data.orderId === d2.body.data.orderId && d2.body.data.replayed === true && orders().length === n0 + 1,
    mutation: 'the identical POST twice', dbEffect: 'one order', money: NO_MONEY, order: 'one', ledger: 'none',
    delegated: DELEGATED + ' — a repeated PROVIDER callback is idempotent at webhookIntasend' });
  const before = await get('orders/' + d1.body.data.orderId);
  const r2 = await post('tok-buyer', { items: [{ productId: 'p1', quantity: 5 }], clientOrderId: k, deliveryAddress: ADDR, paymentMethod: 'mpesa' });
  const after = await get('orders/' + d1.body.data.orderId);
  row('REPLAY_CALLBACK', {
    expected: 'gateway part: replaying a used clientOrderId with a DIFFERENT cart is refused (409 orders/idempotency-conflict); the recorded order is unchanged',
    observed: JSON.stringify({ http: r2.statusCode, code: r2.body && r2.body.error && r2.body.error.code, qtyBefore: before && before.items[0].quantity, qtyAfter: after && after.items[0].quantity, added: orders().length - n0 }),
    ok: r2.statusCode === 409 && r2.body.error.code === 'orders/idempotency-conflict' && JSON.stringify(before) === JSON.stringify(after) && orders().length === n0 + 1,
    mutation: 'same clientOrderId, quantity 1 → 5', dbEffect: 'none', money: NO_MONEY, order: 'unchanged', ledger: 'none',
    delegated: DELEGATED + ' — a replayed PROVIDER callback is refused at webhookIntasend' });

  /* ── WRONG_CURRENCY ── */
  const n1 = orders().length;
  const wc = await post('tok-buyer', { items: [{ productId: 'p1', quantity: 1 }], currency: 'USD', deliveryAddress: ADDR, paymentMethod: 'card' });
  const allKes = orders().every((o) => o.currency === 'KES');
  row('WRONG_CURRENCY', {
    expected: 'a non-KES currency is refused (400 orders/unsupported-currency), nothing written; every stored order is KES (fixed server-side)',
    observed: JSON.stringify({ http: wc.statusCode, code: wc.body && wc.body.error && wc.body.error.code, added: orders().length - n1, allKes }),
    ok: wc.statusCode === 400 && wc.body.error.code === 'orders/unsupported-currency' && orders().length === n1 && allKes,
    mutation: 'currency:"USD"', dbEffect: 'none', money: NO_MONEY, order: 'none', ledger: 'none' });

  /* ── G_AUTH: no token → 401, nothing written ── */
  const n2 = orders().length;
  const na = await post(null, { items: [{ productId: 'p1', quantity: 1 }], deliveryAddress: ADDR, paymentMethod: 'card' });
  const bq = await post('tok-buyer', { items: [{ productId: 'p1', quantity: 1000 }], deliveryAddress: ADDR, paymentMethod: 'card' });
  row('G_INPUT', {
    expected: 'signed-out → 401; quantity outside 1–99 → 400 (refused, never silently clamped); nothing written',
    observed: JSON.stringify({ anon: na.statusCode, qty: bq.statusCode, added: orders().length - n2 }),
    ok: na.statusCode === 401 && bq.statusCode === 400 && orders().length === n2,
    mutation: 'no token; quantity 1000', dbEffect: 'none', money: 'none', order: 'none', ledger: 'none' });

  /* ── Z1 tripwires ── */
  let adminBlocked = false, notifyBlocked = false;
  try { require(require.resolve('firebase-admin', { paths: [FN] })); } catch (e) { adminBlocked = /TRIPWIRE/.test(e.message); }
  try { require(path.join(FN, 'notify')); } catch (e) { notifyBlocked = /TRIPWIRE/.test(e.message); }
  const realLoaded = Object.keys(require.cache).filter((k2) => /node_modules[\\/]firebase-admin[\\/]/.test(k2) || /[\\/]notify\.js$/.test(k2));
  row('Z1', { expected: 'TRIPWIRES held: the real firebase-admin is unloadable and never loaded (the gateway got the in-memory stub), notify.js is unloadable',
    observed: JSON.stringify({ adminBlocked, notifyBlocked, realLoaded, adminStubServed, tripped }),
    ok: adminBlocked && notifyBlocked && realLoaded.length === 0 && adminStubServed > 0 && tripped.notify === 1,
    mutation: 'n/a', dbEffect: 'n/a', money: 'n/a', order: 'n/a', ledger: 'n/a' });

  say('\nGATE 15 RECORD');
  say('| test id | expected | observed | result | mutation | database | money | order | ledger | delegated |');
  say('|---|---|---|---|---|---|---|---|---|---|');
  for (const t of table) say(`| ${t.id} | ${t.expected} | ${String(t.observed).replace(/\|/g, '/')} | ${t.result} | ${t.mutation} | ${t.dbEffect} | ${t.money} | ${t.order} | ${t.ledger} | ${t.delegated || '—'} |`);
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('  FAIL  harness crashed: ' + (e && e.stack || e)); process.exit(1); });
