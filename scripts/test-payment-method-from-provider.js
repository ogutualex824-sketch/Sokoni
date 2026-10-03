#!/usr/bin/env node
/* test-payment-method-from-provider.js — Gates 8/12: an order records the method IntaSend reports
 *
 * EXECUTES the real verifyIntasendPayment handler, extracted from functions/index.js, against an in-memory
 * Firestore and a stubbed IntaSend collection API. No network, no production.
 *
 *   node scripts/test-payment-method-from-provider.js            # the fix (working tree)
 *   COUNTERPROOF=<ref> node scripts/test-payment-method-from-provider.js   # e.g. 5a0935e: shows the defect
 *
 * Rows: M-PESA -> mpesa · CARD-PAYMENT -> card · provider absent -> unknown (never assumed mpesa) ·
 *       raw provider kept · CONTROL: a non-COMPLETE payment writes no order.
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const REF = process.env.COUNTERPROOF;
const SRC = REF ? cp.execFileSync('git', ['show', REF + ':functions/index.js'], { cwd: ROOT, encoding: 'utf8' })
                : fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');

/* ── extract the handler: the async (req, res) => { … } passed to onRequest ── */
function extractHandler(src) {
  const i = src.indexOf('exports.verifyIntasendPayment = onRequest(');
  if (i < 0) throw new Error('verifyIntasendPayment not found');
  const a = src.indexOf('async (req, res) => {', i);
  let d = 0, end = -1;
  for (let j = src.indexOf('{', a); j < src.length; j++) {
    if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) { end = j; break; } }
  }
  return src.slice(a, end + 1);
}

/* ── in-memory Firestore ── */
function makeDb(seed) {
  const data = Object.assign({}, seed); let seq = 0;
  const snap = (p) => ({ exists: p in data, id: p.split('/').pop(), data: () => (p in data ? JSON.parse(JSON.stringify(data[p])) : undefined) });
  const ref = (p) => ({ id: p.split('/').pop(), path: p, get: async () => snap(p), set: async (v, o) => { data[p] = o && o.merge ? Object.assign({}, data[p], v) : v; }, update: async (v) => { data[p] = Object.assign({}, data[p], v); }, collection: (c) => col(p + '/' + c) });
  const col = (c, filters = []) => ({
    doc: (id) => ref(c + '/' + (id || ('auto' + (++seq)))),
    add: async (v) => { const r = ref(c + '/auto' + (++seq)); await r.set(v); return r; },
    where: (f, op, v) => col(c, filters.concat([[f, op, v]])),
    orderBy: () => col(c, filters), limit: () => col(c, filters),
    get: async () => { const docs = Object.keys(data).filter((p) => p.startsWith(c + '/') && p.split('/').length === c.split('/').length + 1).map(snap); return { empty: !docs.length, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) }; },
  });
  const db = {
    data, collection: col, doc: ref,
    runTransaction: async (fn) => fn({ get: async (r) => (r.get ? r.get() : { empty: true, docs: [] }), set: (r, v, o) => r.set(v, o), update: (r, v) => r.update(v), create: (r, v) => r.set(v) }),
    batch: () => { const ops = []; return { set: (r, v, o) => ops.push(() => r.set(v, o)), update: (r, v) => ops.push(() => r.update(v)), commit: async () => { for (const o of ops) await o(); } }; },
  };
  return db;
}
const FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }), arrayUnion: (...v) => v, delete: () => null };
const admin = { firestore: Object.assign(() => null, { FieldValue, Timestamp: { now: () => ({ toMillis: () => Date.now() }) }, FieldPath: { documentId: () => '__id__' } }) };

/* Any identifier the handler uses that we did not define resolves to a harmless async stub. */
function stub() { const f = async () => ({ ok: true }); return new Proxy(f, { get: (t, k) => (k === 'then' ? undefined : stub()), apply: async () => ({ ok: true }) }); }

async function run(provider, state) {
  const db = makeDb({
    'checkoutSessions/S1': { status: 'pending', uid: 'u1', serverTotal: 1000, deliveryFee: 0,
      items: [{ productId: 'p1', qty: 1, price: 1000, sellerUid: 's1', sellerName: 'Shop' }] },
    'products/p1': { price: 1000, sellerUid: 's1', status: 'active', stock: 5 },
  });
  const apiRecord = { invoice_id: 'INV1', state: state || 'COMPLETE', value: 1000, currency: 'KES' };
  if (provider !== undefined) apiRecord.provider = provider;
  const fetch = async () => ({ ok: true, json: async () => ({ results: [apiRecord] }), text: async () => '' });
  const out = { code: 200, body: null };
  const res = { status(c) { out.code = c; return res; }, json(b) { out.body = b; return res; }, set() { return res; }, send(b) { out.body = b; return res; } };
  const req = { method: 'POST', headers: {}, ip: '1.1.1.1', body: { invoiceId: 'INV1', sessionId: 'S1', phone: '254712345678', deliveryName: 'B' } };
  const scope = {
    db, admin, fetch, process: { env: { INTASEND_LIVE: 'false' } }, require, console: { log() {}, warn() {}, error() {} },
    INTASEND_PRIVATE_KEY: { value: () => 'test-key' },
    /* The handler's structured logger: every method it calls, including audit. An error it logs is surfaced. */
    createLogger: () => ({ info() {}, warn() {}, debug() {}, audit() {},
      error: (msg, o) => { if (process.env.DEBUG_H) console.log('  [handler error] ' + msg + ' ' + JSON.stringify(o || {}).slice(0, 300)); } }),
    checkRateLimitDurable: async () => ({ ok: true }),
  };
  const proxy = new Proxy(scope, { has: (t, k) => typeof k === 'string' && !(k in globalThis && !(k in t)) || k in t, get: (t, k) => (k in t ? t[k] : (k === Symbol.unscopables ? undefined : stub())) });
  const handler = new Function('__scope', 'with (__scope) { return (' + extractHandler(SRC) + '); }')(proxy);
  try { await handler(req, res); } catch (e) { out.threw = e.message; }
  const orders = Object.keys(db.data).filter((p) => /^orders\/[^/]+$/.test(p)).map((p) => db.data[p]);
  return { out, order: orders[0] || null, orders: orders.length };
}

(async () => {
  let pass = 0, fail = 0;
  const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + JSON.stringify(d).slice(0, 140) + ']' : '')); ok ? pass++ : fail++; };
  console.log('\nPAYMENT METHOD FROM PROVIDER — ' + (REF ? 'COUNTERPROOF ' + REF : 'working tree'));
  const m = await run('M-PESA');
  ck('HARNESS the real handler ran and wrote one order', m.orders === 1 && m.out.body && m.out.body.verified === true, { code: m.out.code, body: m.out.body, threw: m.out.threw });
  ck('P1  IntaSend M-PESA  -> paymentMethod "mpesa"', m.order && m.order.paymentMethod === 'mpesa', m.order && m.order.paymentMethod);
  const c = await run('CARD-PAYMENT');
  ck('P2  IntaSend CARD-PAYMENT -> paymentMethod "card"', c.order && c.order.paymentMethod === 'card', c.order && c.order.paymentMethod);
  ck('P3  the raw provider is kept for audit', c.order && c.order.paymentProvider === 'CARD-PAYMENT', c.order && c.order.paymentProvider);
  const u = await run(undefined);
  ck('P4  provider absent -> "unknown", never assumed mpesa', u.order && u.order.paymentMethod === 'unknown', u.order && u.order.paymentMethod);
  const p = await run('CARD-PAYMENT', 'PENDING');
  ck('C1  CONTROL a non-COMPLETE payment writes no order', p.orders === 0 && p.out.code === 400, { code: p.out.code, orders: p.orders });
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  if (REF) console.log('  (counterproof: failures here ARE the defect on ' + REF + ')');
  console.log('  NOT proven: a live IntaSend card payment (needs owner-authorised live-money test).\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
