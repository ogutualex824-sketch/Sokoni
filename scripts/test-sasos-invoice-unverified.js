#!/usr/bin/env node
/**
 * test-sasos-invoice-unverified.js — owner 2026-10-04: a client reference never makes a SaaS invoice "paid".
 * The REAL sasosCreateInvoice handler on a fake Firestore.
 *   S1  the invoice is issued payment_unverified with an unverified claim — NEVER status 'paid'
 *   S2  the caller's own repeat (same reference) returns ITS invoice (replay), no second doc
 *   S3  another user's reference is refused and NOTHING of theirs is returned (no data leak)
 *   S4  no financial side-effect (no subscription / ledger / wallet write)
 *   S5  unauthenticated refused; planId + paymentRef still required
 *   SABOTAGE=1 → status 'paid' restored → S1 must FAIL
 */
'use strict';
const path = require('path'), fs = require('fs'), Module = require('module');
const FN = path.join(__dirname, '..', 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || d === undefined ? '' : '   [' + JSON.stringify(d).slice(0, 220) + ']')); ok ? pass++ : fail++; };
const store = {}; let seq = 0;
const clone = (o) => JSON.parse(JSON.stringify(o));
function col(c, filters = [], lim = null) { return { add: async (v) => { const id = 'a' + (++seq); store[c + '/' + id] = clone(v); return { id }; }, doc: (id) => ({ get: async () => ({ exists: (c + '/' + id) in store, data: () => clone(store[c + '/' + id]) }) }),
  where: (f, op, v) => col(c, filters.concat([[f, v]]), lim), limit: (n) => col(c, filters, n), orderBy: () => col(c, filters, lim),
  get: async () => { let ds = Object.keys(store).filter((p) => p.startsWith(c + '/')); for (const [f, v] of filters) ds = ds.filter((p) => store[p][f] === v); if (lim) ds = ds.slice(0, lim); const docs = ds.map((p) => ({ id: p.split('/')[1], data: () => clone(store[p]) })); return { empty: !docs.length, docs }; } }; }
const db = { collection: (c) => col(c) };
class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const _load = Module._load;
Module._load = function (req, parent) {
  if (req === 'firebase-functions/v2/https') return { onCall: (o, h) => h, HttpsError };
  if (req === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
  if (req === 'firebase-functions/params') return { defineSecret: () => ({ value: () => 'P000TEST' }), defineString: () => ({ value: () => '' }) };
  if (req === 'firebase-admin') return { firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => 'TS', increment: (n) => n } }), apps: [{}], initializeApp() {} };
  if (req === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'TS', increment: (n) => n } };
  if (req === './sasos-core') return { _resolvePlan: async (id) => (id === 'pro' ? { productId: 'sasos', name: 'Pro', billing: { monthly: 1499, annual: 14990, currency: 'KES' }, tax: { vat_applicable: true, vat_rate: 0.16 } } : null), SASOS_PRODUCTS: {} };
  if (req === './company-identity') return { COMPANY: { legalName: 'SOKONI', address: 'Nairobi', billingEmail: 'b@x' }, ETIMS_PLATFORM_PIN: { value: () => 'P000TEST' }, getKraPin: () => 'P000TEST' };
  return _load.apply(this, arguments);
};
let src = fs.readFileSync(path.join(FN, 'sasos-billing.js'), 'utf8');
if (process.env.SABOTAGE === '1') src = src.replace("      status:        'payment_unverified',", "      status:        'paid',");
const tmp = path.join(FN, '.under-test-sasos-' + process.pid + '.js'); fs.writeFileSync(tmp, src);
let M; try { M = require(tmp); } finally { fs.unlinkSync(tmp); }
const H = M.sasosCreateInvoice;
const call = async (uid, data) => { try { return await H({ auth: uid ? { uid, token: {} } : null, data }); } catch (e) { return { err: e.code || e.message }; } };
const others = () => Object.keys(store).filter((p) => !p.startsWith('sasosInvoices/'));
(async () => {
  console.log('\nsasosCreateInvoice' + (process.env.SABOTAGE === '1' ? '  (SABOTAGE)' : '') + '\n');
  if (typeof H !== 'function') { console.log('  FAIL  LOAD sasosCreateInvoice not exported'); process.exit(1); }
  let r = await call('alice', { planId: 'pro', paymentRef: 'MPESA-ABC', phone: '0700111222' });
  const docs = Object.keys(store).filter((p) => p.startsWith('sasosInvoices/'));
  const inv = docs.length ? store[docs[0]] : {};
  ck('S1', r.success && r.verified === false && inv.status === 'payment_unverified' && inv.status !== 'paid' && inv.paymentStatus === 'unverified' && inv.paymentClaim && inv.paymentClaim.status === 'unverified' && /awaiting verification/.test(r.message || ''), 'issued payment_unverified with an unverified claim — never "paid"', { r, inv: { status: inv.status, paymentStatus: inv.paymentStatus } });
  r = await call('alice', { planId: 'pro', paymentRef: 'MPESA-ABC' });
  ck('S2', r.replay === true && Object.keys(store).filter((p) => p.startsWith('sasosInvoices/')).length === 1, 'the caller\'s own repeat → its invoice, no second doc', r);
  r = await call('mallory', { planId: 'pro', paymentRef: 'MPESA-ABC' });
  ck('S3', r.err === 'already-exists' && !r.invoice && Object.keys(store).filter((p) => p.startsWith('sasosInvoices/')).length === 1, 'another user\'s reference → refused, NOTHING of theirs returned (no phone / invoice leak)', r);
  ck('S4', others().length === 0, 'no subscription / ledger / wallet side-effect', others());
  const a = await call(null, { planId: 'pro', paymentRef: 'X' });
  const b = await call('bob', { planId: 'pro' });
  ck('S5', !!a.err && b.err === 'invalid-argument', 'unauthenticated refused; paymentRef still required', { a, b });
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (process.env.SABOTAGE === '1' ? '   (SABOTAGE — failures EXPECTED)' : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e.stack || e.message); process.exit(2); });
