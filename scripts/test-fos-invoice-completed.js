#!/usr/bin/env node
/**
 * test-fos-invoice-completed.js — fosGenerateInvoice issues an invoice ONLY for a completed, verified payment and
 * only ONCE per transaction (owner 2026-10-04, invoice census H15). The REAL handler on a fake Firestore.
 *   F1  a COMPLETED fosTransaction → one invoice, status COMPLETED (copied, never defaulted)
 *   F2  PENDING / FAILED / PENDING_REVIEW / missing status → refused (PAYMENT_NOT_COMPLETED), nothing written
 *   F3  payments fallback: COMPLETE accepted; PENDING refused
 *   F4  one invoice per transaction: a second call (and a racing create) returns the SAME invoice, no second doc
 *   F5  access: only buyer / seller / admin
 *   SABOTAGE=1 → the old `tx.status || 'COMPLETED'` with no check → F2 must FAIL
 */
'use strict';
const path = require('path'), fs = require('fs'), Module = require('module');
const FN = path.join(__dirname, '..', 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || d === undefined ? '' : '   [' + JSON.stringify(d).slice(0, 220) + ']')); ok ? pass++ : fail++; };
const store = {}; let seq = 0;
const clone = (o) => JSON.parse(JSON.stringify(o));
function ref(p) { return { _p: p, id: p.split('/').pop(), get: async () => ({ exists: p in store, id: p.split('/').pop(), ref: ref(p), data: () => (p in store ? clone(store[p]) : undefined) }),
  create: async (v) => { if (p in store) { const e = new Error('6 ALREADY_EXISTS'); e.code = 6; throw e; } store[p] = clone(v); }, set: async (v) => { store[p] = clone(v); }, update: async (v) => { store[p] = Object.assign({}, store[p], clone(v)); } }; }
function col(c, filters = [], lim = null) { return { doc: (id) => ref(c + '/' + (id || 'auto' + (++seq))), add: async (v) => { const r = ref(c + '/auto' + (++seq)); await r.set(v); return r; },
  where: (f, op, v) => col(c, filters.concat([[f, v]]), lim), limit: (n) => col(c, filters, n), orderBy: () => col(c, filters, lim),
  get: async () => { let ds = Object.keys(store).filter((p) => p.startsWith(c + '/') && p.split('/').length === 2); for (const [f, v] of filters) ds = ds.filter((p) => store[p][f] === v); if (lim) ds = ds.slice(0, lim);
    const docs = ds.map((p) => ({ id: p.split('/')[1], data: () => clone(store[p]) })); return { empty: !docs.length, docs, size: docs.length }; } }; }
const db = { collection: (c) => col(c), runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, v) => r.update(v), set: (r, v) => r.set(v), create: (r, v) => r.create(v) }) };
const firestoreFn = () => db; firestoreFn.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => n }; firestoreFn.Timestamp = { now: () => 'TS', fromDate: () => 'TS' };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const _load = Module._load;
Module._load = function (req) {
  if (req === 'firebase-functions/v2/https') return { onCall: (o, h) => h, onRequest: (o, h) => h, HttpsError };
  if (req === 'firebase-functions/params') return { defineSecret: () => ({ value: () => 'x' }) };
  if (req === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
  if (req === 'firebase-admin') return { firestore: firestoreFn, apps: [{}], initializeApp() {} };
  if (req === './payment-adapters') return { getAdapter: () => ({}), listAdapters: () => [] };
  if (req === './finos-utils' || req === './commission-config' || req === './subscription-core') return {};
  return _load.apply(this, arguments);
};
let src = fs.readFileSync(path.join(FN, 'financial-os.js'), 'utf8');
if (process.env.SABOTAGE === '1') src = src.replace("    if (!VERIFIED.includes(txStatus))\n      throw new HttpsError(", "    if (false)\n      throw new HttpsError(").replace("      status:            txStatus,", "      status:            tx.status || 'COMPLETED',");
const tmp = path.join(FN, '.under-test-fos-' + process.pid + '.js'); fs.writeFileSync(tmp, src);
let M; try { M = require(tmp); } finally { fs.unlinkSync(tmp); }
const H = M.fosGenerateInvoice;
const as = (uid, data, token) => ({ auth: { uid, token: token || {} }, data });
const call = async (r) => { try { return await H(r); } catch (e) { return { err: e.code || e.message, reason: e.details && e.details.reason }; } };
const invs = () => Object.keys(store).filter((p) => p.startsWith('fosInvoices/'));
(async () => {
  console.log('\nfosGenerateInvoice' + (process.env.SABOTAGE === '1' ? '  (SABOTAGE)' : '') + '\n');
  const tx = (id, st) => { store['fosTransactions/' + id] = Object.assign({ buyerUid: 'buy', sellerUid: 'sel', amountCents: 10000, commissionCents: 500, payRef: 'P-' + id }, st === undefined ? {} : { status: st }); };
  tx('ok1', 'COMPLETED');
  let r = await call(as('buy', { fosTransactionId: 'ok1' }));
  ck('F1', r.id === 'fos_ok1' && r.invoice.status === 'COMPLETED' && invs().length === 1, 'a COMPLETED transaction → one invoice (status copied from the verified record)', r);
  const refused = [];
  for (const [id, st] of [['p1', 'PENDING'], ['f1', 'FAILED'], ['r1', 'PENDING_REVIEW'], ['n1', undefined]]) { tx(id, st); const x = await call(as('buy', { fosTransactionId: id })); refused.push(x.reason || x.err || 'ISSUED'); }
  ck('F2', refused.every((x) => x === 'PAYMENT_NOT_COMPLETED') && invs().length === 1, 'PENDING / FAILED / PENDING_REVIEW / NO status → refused, nothing written (no more "COMPLETED" default)', refused);
  store['payments/pay-ok'] = { buyerUid: 'buy', sellerUid: 'sel', status: 'COMPLETE', amountCents: 500 };
  store['payments/pay-pend'] = { buyerUid: 'buy', sellerUid: 'sel', status: 'PENDING', amountCents: 500 };
  const a = await call(as('sel', { payRef: 'pay-ok' })), b = await call(as('sel', { payRef: 'pay-pend' }));
  ck('F3', a.id === 'fos_pay-ok' && a.invoice.status === 'COMPLETE' && b.reason === 'PAYMENT_NOT_COMPLETED', 'payments fallback: COMPLETE accepted, PENDING refused', { a: a.id, b });
  const n = invs().length;
  const [c1, c2] = await Promise.all([call(as('buy', { fosTransactionId: 'ok1' })), call(as('sel', { fosTransactionId: 'ok1' }))]);
  ck('F4', c1.id === 'fos_ok1' && c2.id === 'fos_ok1' && invs().length === n, 'one invoice per transaction: repeated / concurrent calls return the SAME invoice', { c1: c1.id, c2: c2.id, n: invs().length });
  delete store['fosInvoices/fos_ok1'];
  const origGet = db.collection; let raced = false;
  db.collection = (c) => { const q = origGet(c); if (c === 'fosInvoices' && !raced) { const g = q.where; q.where = (...x) => { const w = g(...x); w.limit = () => ({ get: async () => { raced = true; store['fosInvoices/fos_ok1'] = { invoiceNumber: 'RACER', fosTransactionId: 'ok1' }; return { empty: true, docs: [] }; } }); return w; }; } return q; };
  const rc = await call(as('buy', { fosTransactionId: 'ok1' }));
  db.collection = origGet;
  ck('F4b', rc.id === 'fos_ok1' && rc.replay === true && rc.invoice.invoiceNumber === 'RACER', 'RACE: another call wins between the check and the write → create() fails, the winner\'s invoice is returned (no duplicate)', rc);
  const s = await call(as('stranger', { fosTransactionId: 'ok1' }));
  const ad = await call(as('adm', { fosTransactionId: 'ok1' }, { admin: true }));
  ck('F5', s.err === 'permission-denied' && ad.id === 'fos_ok1', 'only buyer / seller / admin', { s, ad: ad.id });
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (process.env.SABOTAGE === '1' ? '   (SABOTAGE — failures EXPECTED)' : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e.stack || e.message); process.exit(2); });
