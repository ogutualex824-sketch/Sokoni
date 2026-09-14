#!/usr/bin/env node
/**
 * cmRecordCashEvent — is a client-supplied variance merely recorded, or believed?
 *
 *   node scripts/test-cash-event-authority.js
 *
 * THE QUESTION
 * `cmRecordCashEvent` accepts `expectedCents` and `varianceCents` from the request body.
 * Accepting a client value is not automatically a defect — the question is whether any
 * consumer treats it as authority.
 *
 * THE ANSWER, FROM THE CONSUMER MAP
 * `cmGetShiftReport` computes the balance ITSELF with `_computeBalance` — and then reports
 * the variance from `closeEv.varianceCents`, the cashier's own number, deriving
 * balanced/over/short from it. The server's truth and the client's claim sit in the same
 * return object, and the claim wins. `cmGetEndOfDay`, `cmGetCashierPerformance` and
 * `cmGetBranchSummary` aggregate the same stored value.
 *
 * So it is authority, not record-keeping: a cashier can close a till 5,000 short, report
 * `varianceCents: 0`, and every manager-facing surface says balanced.
 *
 * THE FIX, AT THE MUTATION BOUNDARY
 * The server already holds everything needed: `_computeBalance` over the shift's events gives
 * `expected`, and the close event's own `amountCents` is the counted cash. Variance is
 * therefore derived, never accepted.
 *
 * WHAT IS PRESERVED
 * `varianceExplanation` remains a client-reported observation — it is prose, not arithmetic,
 * and a cashier explaining a shortfall is exactly what it is for. Where the server cannot yet
 * compute an expectation, the value stays NULL rather than becoming a fabricated zero.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

/* ── in-memory Firestore with real filtering ──────────────────────────────── */
let STORE = {};
let AUTO = 0;
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.httpErrorCode = true; }
}
function makeRef (coll, id) {
  const key = coll + '/' + id;
  return { id, _key: key,
    get: async () => ({ exists: Object.prototype.hasOwnProperty.call(STORE, key),
                        data: () => STORE[key], id }),
    set: async (v) => { STORE[key] = JSON.parse(JSON.stringify(v)); },
    update: async (v) => { Object.assign(STORE[key] = STORE[key] || {}, v); } };
}
function makeColl (coll) {
  const filters = [];
  const q = {
    where (f, _op, v) { filters.push([f, v]); return q; },
    orderBy () { return q; }, limit () { return q; },
    doc: (id) => makeRef(coll, id || ('a' + (++AUTO))),
    add: async (v) => { const r = q.doc(); STORE[r._key] = v; return r; },
    async get () {
      const docs = Object.keys(STORE).filter((k) => k.indexOf(coll + '/') === 0)
        .map((k) => ({ id: k.slice(coll.length + 1), data: () => STORE[k] }))
        .filter((d) => filters.every(([f, v]) => d.data()[f] === v));
      return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
    },
  };
  return q;
}
const fdb = { collection: makeColl };
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') return { apps: [1], initializeApp() {},
    firestore: Object.assign(() => fdb, { FieldValue: { serverTimestamp: () => 'TS', increment: (n) => n } }) };
  if (request === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
  if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (request === 'firebase-functions/logger') return { info(){}, warn(){}, error(){} };
  return realLoad.apply(this, arguments);
};
const CM = require(path.join(ROOT, 'functions/pos-cash-manager.js'));
Module._load = realLoad;
const H = CM._h;

const MERCHANT = 'MCH-1', REG = 'REG-1', SHIFT = 'SHIFT-1';
const req = (uid, claims, data) => ({ auth: { uid, token: claims || {} }, data });
const CASHIER = { cashier: true };
const MANAGER = { manager: true };
const caught = async (fn) => { try { return { code: null, value: (await fn()) || {} }; }
                              catch (e) { return { code: e.code || 'threw', value: {} }; } };

/* A shift where the SERVER-COMPUTABLE truth is unambiguous:
     opening float 5,000 + cash sales 8,000 = expected 13,000 */
async function seedShift () {
  STORE = {};
  await H.cmRecordCashEvent(req('uidCashier', CASHIER, {
    type: 'register_open', merchantId: MERCHANT, registerId: REG, shiftId: SHIFT,
    amountCents: 500000 }));
  await H.cmRecordCashEvent(req('uidCashier', CASHIER, {
    type: 'cash_sale', merchantId: MERCHANT, registerId: REG, shiftId: SHIFT,
    amountCents: 800000 }));
}

console.log(NL + 'CASH EVENT AUTHORITY' + NL + '='.repeat(62));

(async function main () {

/* ── 0 · controls ─────────────────────────────────────────────────────────── */
head('0 · CONTROLS');
ck('the handlers loaded', typeof H.cmRecordCashEvent === 'function' &&
   typeof H.cmGetShiftReport === 'function');
await seedShift();
ck('CONTROL the fake applies where() filters',
   (await fdb.collection('posCashEvents').where('shiftId', '==', SHIFT).get()).size === 2,
   'if filters were ignored every assertion below would be vacuous');
const truth = await caught(() => H.cmGetShiftReport(req('uidMgr', MANAGER,
  { shiftId: SHIFT, merchantId: MERCHANT })));
ck('CONTROL the server computes expected = 13,000 by itself',
   truth.value.balance && truth.value.balance.expected === 1300000,
   String(truth.value.balance && truth.value.balance.expected));

/* ── 1 · the false close ──────────────────────────────────────────────────── */
head('1 · a cashier closes 5,000 short and reports balanced');
await seedShift();
await H.cmRecordCashEvent(req('uidCashier', CASHIER, {
  type: 'register_close', merchantId: MERCHANT, registerId: REG, shiftId: SHIFT,
  amountCents: 800000,            /* counted 8,000 — five thousand short */
  expectedCents: 99999900,        /* a lie */
  varianceCents: -99999900,       /* a lie */
  varianceExplanation: 'nothing to see here' }));
const rpt = (await caught(() => H.cmGetShiftReport(req('uidMgr', MANAGER,
  { shiftId: SHIFT, merchantId: MERCHANT })))).value;

ck('the server STILL computes expected = 13,000',
   rpt.balance && rpt.balance.expected === 1300000);
ck('the counted cash is on the close event', rpt.events &&
   rpt.events.some((e) => e.type === 'register_close' && e.amountCents === 800000));
ck('THE REPORTED VARIANCE IS SERVER-DERIVED, not the claim',
   rpt.variance && rpt.variance.varianceCents === -500000,
   'counted 8,000 - expected 13,000 = -5,000; the client said ' +
   (rpt.variance ? '(claimed -999,999)' : 'n/a'));
ck('...and the status follows the derived figure',
   rpt.variance && rpt.variance.status === 'short');
ck('NEGATIVE the fabricated variance does not survive into the report',
   !rpt.variance || rpt.variance.varianceCents !== -99999900);
ck('the cashier explanation IS preserved — prose, not arithmetic',
   rpt.variance && rpt.variance.explanation === 'nothing to see here',
   'a cashier explaining a shortfall is what that field is for');

/* ── 2 · the stored event ─────────────────────────────────────────────────── */
head('2 · the mutation boundary refuses the claim');
const closeDoc = Object.keys(STORE).filter((k) => k.indexOf('posCashEvents/') === 0)
  .map((k) => STORE[k]).find((e) => e.type === 'register_close') || {};
ck('the persisted expectedCents is the SERVER figure',
   closeDoc.expectedCents === 1300000, String(closeDoc.expectedCents));
ck('the persisted varianceCents is the SERVER figure',
   closeDoc.varianceCents === -500000, String(closeDoc.varianceCents));
ck('NEGATIVE neither client value was stored',
   closeDoc.expectedCents !== 99999900 && closeDoc.varianceCents !== -99999900);
ck('the explanation was stored unchanged',
   closeDoc.varianceExplanation === 'nothing to see here');

/* ── 3 · not-computable is NULL, never a fabricated zero ──────────────────── */
head('3 · an unknown expectation is not zero');
STORE = {};
await H.cmRecordCashEvent(req('uidCashier', CASHIER, {
  type: 'register_close', merchantId: MERCHANT, registerId: REG, shiftId: 'SHIFT-NONE',
  amountCents: 100000, varianceCents: 12345 }));
const orphan = Object.keys(STORE).filter((k) => k.indexOf('posCashEvents/') === 0)
  .map((k) => STORE[k])[0] || {};
ck('a close with no opening events records expected = null',
   orphan.expectedCents === null, String(orphan.expectedCents));
ck('...and variance = null, not 0',
   orphan.varianceCents === null, String(orphan.varianceCents));
const orphanRpt = (await caught(() => H.cmGetShiftReport(req('uidMgr', MANAGER,
  { shiftId: 'SHIFT-NONE', merchantId: MERCHANT })))).value;
ck('...and the report calls it not-reconcilable, NOT short',
   orphanRpt.variance && orphanRpt.variance.status === 'not-reconcilable',
   'the old expression fell through to short — an unknown reported as a shortfall');
ck('...with no fabricated KES figure',
   orphanRpt.variance && orphanRpt.variance.varianceKES === null);
ck('NEGATIVE the client figure is still refused',
   orphan.varianceCents !== 12345,
   'not-computable and computed-as-zero are different facts');

/* ── 4 · non-close events are unaffected ──────────────────────────────────── */
head('4 · only the close carries a reconciliation');
STORE = {};
await H.cmRecordCashEvent(req('uidCashier', CASHIER, {
  type: 'cash_in', merchantId: MERCHANT, registerId: REG, shiftId: SHIFT,
  amountCents: 50000, category: 'float_topup' }));
const cashIn = Object.keys(STORE).filter((k) => k.indexOf('posCashEvents/') === 0)
  .map((k) => STORE[k])[0] || {};
ck('a cash_in still records its amount', cashIn.amountCents === 50000);
ck('...and carries no invented variance',
   cashIn.varianceCents === null || cashIn.varianceCents === 0,
   String(cashIn.varianceCents));

/* ── 5 · scoping rule ─────────────────────────────────────────────────────── */
head('5 · the assertions are scoped to their own block');
const CM_SRC = fs.readFileSync(path.join(ROOT, 'functions/pos-cash-manager.js'), 'utf8');
const RECORD = CM_SRC.slice(CM_SRC.indexOf('async function cmRecordCashEvent'),
                           CM_SRC.indexOf('async function cmApproveFloat'));
ck('CONTROL the handler body was isolated', RECORD.length > 800, RECORD.length + ' chars');
ck('the writer derives rather than accepts',
   RECORD.indexOf('_deriveClose(') > -1,
   'scoped to cmRecordCashEvent — the same field names appear in five other consumers');
ck('NEGATIVE it no longer trusts the payload variance',
   RECORD.indexOf('Math.round(Number(varianceCents) || 0)') === -1);

/* ── 6 · the CLOSE-APPROVAL path ──────────────────────────────────────────── */
head('6 · a manager must not sign the cashier own number');
await seedShift();   /* expected 13,000 */
const reqRes = await caught(() => H.cmRequestCloseApproval(req('uidCashier', CASHIER, {
  merchantId: MERCHANT, registerId: REG,
  countedCents: 800000,          /* counted 8,000 — five thousand short */
  varianceCents: 0,              /* the claim a manager would sign */
  varianceExplanation: 'all good' })));
ck('the request is created', reqRes.code === null && !!reqRes.value.id, reqRes.code);
const appr = STORE['posCloseApprovals/' + reqRes.value.id] || {};
ck('THE STORED VARIANCE IS SERVER-DERIVED, not the claim',
   appr.varianceCents === -500000,
   'counted 8,000 - expected 13,000 = -5,000; the cashier claimed 0 — got ' + appr.varianceCents);
ck('...and the server expectation is recorded beside it',
   appr.expectedCents === 1300000, String(appr.expectedCents));
ck('NEGATIVE the claimed zero does not survive', appr.varianceCents !== 0);
ck('the counted cash is preserved as reported', appr.countedCents === 800000);
ck('the explanation is preserved — prose, not arithmetic',
   appr.varianceExplanation === 'all good');
ck('the approval is BOUND to the shift it reconciles',
   appr.shiftId === SHIFT,
   'without it a manager approves a register, not a specific close');

head('6b · an unreconcilable close says so');
STORE = {};
const orphanReq = await caught(() => H.cmRequestCloseApproval(req('uidCashier', CASHIER, {
  merchantId: MERCHANT, registerId: REG, countedCents: 100000, varianceCents: 999 })));
const orphanAppr = STORE['posCloseApprovals/' + orphanReq.value.id] || {};
ck('with no open shift the variance is NULL, not zero',
   orphanAppr.varianceCents === null, String(orphanAppr.varianceCents));
ck('...and the expectation is NULL too',
   orphanAppr.expectedCents === null, String(orphanAppr.expectedCents));
ck('NEGATIVE the client figure is still refused', orphanAppr.varianceCents !== 999);

head('6c · an ALREADY-CLOSED shift is not reopened for reconciliation');
await seedShift();
await H.cmRecordCashEvent(req('uidCashier', CASHIER, {
  type: 'register_close', merchantId: MERCHANT, registerId: REG, shiftId: SHIFT,
  amountCents: 1300000 }));
const afterClose = await caught(() => H.cmRequestCloseApproval(req('uidCashier', CASHIER, {
  merchantId: MERCHANT, registerId: REG, countedCents: 500000, varianceCents: 0 })));
const closedAppr = STORE['posCloseApprovals/' + afterClose.value.id] || {};
ck('a register with no OPEN shift yields no shift binding',
   closedAppr.shiftId === null, String(closedAppr.shiftId),
   );
ck('...and no fabricated reconciliation',
   closedAppr.varianceCents === null && closedAppr.expectedCents === null,
   'reusing the closed shift would reconcile against a shift already signed off');

/* ── 6 · boundary ─────────────────────────────────────────────────────────── */
head('6 · what this slice does not touch');
un('cmRequestCloseApproval', 'a second client-supplied variance on the manager sign-off path — next slice');
un('closeShift reconciliation', 'separate; this map did not reach it');
un('historical events already stored with client figures', 'a migration question, like the tenant key');
un('a real cashier attempting this in production', 'needs the deployed callable and a real shift');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: executed against an in-memory Firestore. No production data was read.');
})().then(() => process.exit(fail ? 1 : 0))
   .catch((e) => { console.error(NL + '  HARNESS ERROR: ' + (e && e.stack || e)); process.exit(2); });
