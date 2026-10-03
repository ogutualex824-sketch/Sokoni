#!/usr/bin/env node
'use strict';
/* Wiring for the deposit refund executor (functions/rental-deposit-refund-jobs.js): the B2C minimum comes from config only,
   the admin setter is admin-only and audited, and each function is exported once. Real handlers, captured from stubbed
   firebase-functions; in-memory store. No network. */
const fs = require('fs'); const path = require('path'); const Module = require('module');
const ROOT = path.resolve(__dirname, '..'); const FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, msg, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + msg + (ok ? '' : '  got=' + JSON.stringify(got))); ok ? pass++ : fail++; };

let D = {}; let AUD = 0;
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const put = (k, d, merge) => { const out = Object.assign({}, merge && D[k] ? D[k] : {}); for (const [f, v] of Object.entries(d)) out[f] = v && v.__ts ? 'TS' : v; D[k] = out; };
let auto = 0;
const ref = (c, id) => { const _id = id || ('auto' + (++auto)); return { _k: c + '/' + _id, id: _id, get: async () => ({ exists: (c + '/' + _id) in D, data: () => clone(D[c + '/' + _id]) }),
  update: async (d) => put(c + '/' + _id, d, true), set: async (d, o) => put(c + '/' + _id, d, o && o.merge) }; };
const db = { collection: (c) => ({ doc: (id) => ref(c, id), where: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }),
  runTransaction: async (fn) => { const w = []; const r = await fn({ get: (x) => x.get(), update: (x, d) => w.push(() => put(x._k, d, true)),
    set: (x, d, o) => w.push(() => put(x._k, d, o && o.merge)), create: (x, d) => w.push(() => { if (x._k in D) throw new Error('exists'); put(x._k, d, false); }) }); w.forEach((f) => f()); return r; } };
class HttpsError extends Error { constructor(code, m) { super(m); this.code = code; } }
const H = {};
const adminStub = { apps: [1], initializeApp() {}, firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => ({ __ts: true }) } }) };
let ADAPTER = null;
const stubs = {
  'firebase-admin': adminStub,
  'firebase-functions/v2/firestore': { onDocumentCreated: (o, fn) => (H.onCreate = fn) },
  'firebase-functions/v2/scheduler': { onSchedule: (o, fn) => (H.reconcile = fn) },
  'firebase-functions/v2/https': { onCall: (o, fn) => (H.setPolicy = fn), HttpsError },
  'firebase-functions/params': { defineSecret: () => ({ value: () => 'test-only' }) },
};
const _load = Module._load;
Module._load = function (r, p, m) { if (stubs[r]) return stubs[r]; return _load.call(this, r, p, m); };
const pa = path.join(FN, 'payment-adapters.js');
require.cache[pa] = { id: pa, filename: pa, loaded: true, exports: { getAdapter: () => ADAPTER, REFUND_OUTCOME: { UNKNOWN: 'PROVIDER_UNKNOWN', ACCEPTED: 'PROVIDER_ACCEPTED' } } };
const J = require(path.join(FN, 'rental-deposit-refund-jobs.js'));
Module._load = _load;

let SENT = 0;
const proven = { initiateRefund: async () => { SENT++; return { outcome: 'PROVIDER_ACCEPTED', chargebackId: 'CB1', providerStatus: 'PENDING' }; }, getRefundStatus: async () => ({ outcome: 'PROVIDER_COMPLETED' }) };
const seed = () => { SENT = 0; D = {
  'rentalBookings/b1': { paymentStatus: 'released', heldAmountCents: 650000, invoiceId: 'INV-9', settlement: { depositCents: 200000, depositRefund: 'requested' } },
  'rentalDepositRefunds/b1': { bookingId: 'b1', state: 'REQUESTED', amountCents: 200000, invoiceId: 'INV-9' } }; };
const R = () => D['rentalDepositRefunds/b1'] || {};
const call = async (auth, data) => { try { return await H.setPolicy({ auth, data }); } catch (e) { return { err: e.code }; } };

(async () => {
  ADAPTER = proven;
  seed(); await H.onCreate({ params: { id: 'b1' } });
  ck('J-1', R().state === 'HELD_FOR_REVIEW' && R().heldReason === 'b2c_minimum_not_configured' && SENT === 0, 'NO configured minimum → the refund is held, nothing sent (never a code default)', R());
  seed(); D['refundPolicy/b2c'] = { minCents: 10000 }; await H.onCreate({ params: { id: 'b1' } });
  ck('J-2', R().state === 'PROVIDER_ACCEPTED' && SENT === 1, 'with refundPolicy/b2c.minCents = KES 100 the deposit is sent once', [R().state, SENT]);
  seed(); D['refundPolicy/b2c'] = { minCents: 'lots' }; await H.onCreate({ params: { id: 'b1' } });
  ck('J-3', R().heldReason === 'b2c_minimum_not_configured' && SENT === 0, 'a malformed minimum is treated as not configured', R());
  seed(); D['refundPolicy/b2c'] = { minCents: 300000 }; await H.onCreate({ params: { id: 'b1' } });
  ck('J-4', R().heldReason === 'below_b2c_minimum' && SENT === 0, 'the CONFIGURED value is what is enforced (KES 3,000 floor holds a KES 2,000 deposit)', R());
  ADAPTER = null; seed(); D['refundPolicy/b2c'] = { minCents: 10000 }; await H.onCreate({ params: { id: 'b1' } }); ADAPTER = proven;
  ck('J-5', R().heldReason === 'refund_adapter_unproven' && SENT === 0, 'no adapter available → held, nothing sent', R());

  D = {}; let r = await call({ uid: 'u1', token: {} }, { minCents: 10000 });
  ck('J-6', r.err === 'permission-denied' && !D['refundPolicy/b2c'], 'a non-admin cannot set the refund policy', r);
  r = await call({ uid: 'adm1', token: { admin: true } }, { minCents: 50 });
  ck('J-7', r.err === 'invalid-argument' && !D['refundPolicy/b2c'], 'a minimum below KES 1 (or non-integer) is refused', r);
  r = await call({ uid: 'adm1', token: { admin: true } }, { minCents: 10000 });
  const audit = Object.entries(D).find(([k, v]) => k.startsWith('adminAudit/') && v.action === 'refund_policy_set');
  ck('J-8', r.ok && D['refundPolicy/b2c'].minCents === 10000 && D['refundPolicy/b2c'].setBy === 'adm1' && audit && audit[1].before.minCents === null && audit[1].after.minCents === 10000,
    "an admin seeds the owner's KES 100 — written WITH an immutable audit row (before → after)", [D['refundPolicy/b2c'], audit && audit[1]]);
  r = await call({ uid: 'adm2', token: { superAdmin: true } }, { minCents: 20000 });
  const audits = Object.values(D).filter((v) => v.action === 'refund_policy_set');
  ck('J-9', r.ok && r.previous === 10000 && audits.length === 2 && audits.some((a) => a.before.minCents === 10000 && a.after.minCents === 20000), 'every change is audited with its previous value', audits);

  const IDX = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  ck('J-10', ['rentalDepositRefundOnCreate', 'rentalDepositRefundReconcile', 'adminSetRefundPolicy'].every((n) => IDX.split(new RegExp('^exports\\.' + n + '\\b', 'm')).length === 2),
    'each function is exported exactly once in index.js', null);
  ck('J-11', !/minCents:\s*\d|OWNER_B2C_MIN_CENTS/.test(fs.readFileSync(path.join(FN, 'rental-deposit-refund-jobs.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')),
    'the wiring has NO hard-coded minimum (config only; the owner value is documentation)', null);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
