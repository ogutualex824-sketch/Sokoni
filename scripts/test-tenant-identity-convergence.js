#!/usr/bin/env node
/**
 * TENANT KEY CONVERGENCE — one merchant, one canonical id, one approval tenant.
 *
 *   node scripts/test-tenant-identity-convergence.js
 *
 * THE DEFECT THIS CLOSES (docs/TENANT_IDENTITY_CENSUS.md §3)
 * `_requireSeller` returned whatever the caller sent. An owner passing their own uid got a
 * uid back; staff passing a merchantId got a merchantId back. Fourteen queries in
 * pos-staff-ops.js then filtered `where('sellerId','==',sellerId)` — so ONE shop had TWO
 * keys, and a staff-raised approval was invisible to an owner-manager. No error; an empty
 * list that looked correct.
 *
 * Everything below is EXECUTED against an in-memory Firestore. A source assertion cannot
 * show that two callers land on the same tenant key; only running both can.
 */
'use strict';
const path = require('path');
const Module = require('module');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

/* ── in-memory Firestore with real query filtering ────────────────────────── */
let STORE = {};
let AUTO = 0;
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.httpErrorCode = true; }
}
function makeRef (coll, id) {
  const key = coll + '/' + id;
  return { id, _key: key,
    get: async () => ({ exists: Object.prototype.hasOwnProperty.call(STORE, key),
                        data: () => STORE[key], id, ref: makeRef(coll, id) }),
    set: async (v) => { STORE[key] = JSON.parse(JSON.stringify(v)); },
    update: async (v) => { Object.assign(STORE[key], v); } };
}
/* Filters are actually APPLIED — a fake that ignored where() would make every
   "both callers see the same tenant" assertion meaningless. */
function makeColl (coll) {
  const filters = [];
  const q = {
    where (f, _op, v) { filters.push([f, v]); return q; },
    orderBy () { return q; },
    limit (n) { q._lim = n; return q; },
    doc: (id) => makeRef(coll, id || ('a' + (++AUTO))),
    async get () {
      let docs = Object.keys(STORE)
        .filter((k) => k.indexOf(coll + '/') === 0)
        .map((k) => ({ id: k.slice(coll.length + 1), data: () => STORE[k], ref: makeRef(coll, k.slice(coll.length + 1)) }))
        .filter((d) => filters.every(([f, v]) => d.data()[f] === v));
      if (q._lim) docs = docs.slice(0, q._lim);
      return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
    },
  };
  return q;
}
const fakeDb = { collection: makeColl,
  runTransaction: async (fn) => fn({ get: async (r) => r.get(),
    update: (r, v) => { if (STORE[r._key]) Object.assign(STORE[r._key], v); } }) };

const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') return { apps: [1], initializeApp() {},
    firestore: Object.assign(() => fakeDb, { FieldValue: { serverTimestamp: () => 'TS', increment: (n) => n } }) };
  if (request === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
  if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (request.endsWith('workforce-identity')) return {
    _assertBusinessPermission: async (uid, businessId, perm) => {
      const hit = Object.keys(STORE).filter((k) => k.indexOf('workspaceMemberships/') === 0)
        .map((k) => STORE[k])
        .find((m) => m.uid === uid && m.businessId === businessId && m.status === 'active');
      if (!hit) throw new HttpsError('permission-denied', 'not a member');
      if (perm && !(hit.permissions || []).includes(perm)) {
        throw new HttpsError('permission-denied', 'permission ' + perm + ' required');
      }
    } };
  return realLoad.apply(this, arguments);
};
const TENANT = require(path.join(ROOT, 'functions/tenant-identity.js'));
const OPS = require(path.join(ROOT, 'functions/pos-staff-ops.js'));
Module._load = realLoad;

const req = (uid, role, data) => ({ auth: { uid, token: { posRole: role, name: 'N' } }, data });
/* `value` is always an object. A refused call previously left it undefined, so a sabotage
   that broke an EARLIER assertion crashed the harness on a later `.value.x` read instead of
   reporting failures — exit 2 rather than a clean count. A control should degrade into a
   failure, never into a stack trace. */
const caught = async (fn) => { try { return { code: null, value: (await fn()) || {} }; }
                               catch (e) { return { code: e.code || 'threw', value: {} }; } };

/* Two merchants. merchantId is generated and can never equal a uid — census §1. */
const OWNER_A = 'uidOwnerA', OWNER_B = 'uidOwnerB', CASHIER_A = 'uidCashierA';
const M_A = 'MCH-AAAA1111', M_B = 'MCH-BBBB2222';
function reset () {
  STORE = {};
  STORE['businesses/' + M_A] = { merchantId: M_A, businessId: 'BIZ-DECOR-A', ownerId: OWNER_A, status: 'active' };
  STORE['businesses/' + M_B] = { merchantId: M_B, businessId: 'BIZ-DECOR-B', ownerId: OWNER_B, status: 'active' };
  STORE['workspaceMemberships/m1'] = { uid: CASHIER_A, businessId: M_A, status: 'active',
                                       permissions: ['pos', 'refunds', 'discounts'] };
}

console.log(NL + 'TENANT KEY CONVERGENCE' + NL + '='.repeat(62));

(async function main () {

/* ── 0 · harness controls ─────────────────────────────────────────────────── */
head('0 · CONTROLS');
reset();
ck('CONTROL the fake actually applies where() filters',
   (await fakeDb.collection('businesses').where('ownerId', '==', OWNER_A).get()).size === 1,
   'if filters were ignored, every tenant assertion below would be vacuous');
ck('CONTROL a merchantId can never equal a uid', M_A !== OWNER_A && M_B !== OWNER_B);
ck('CONTROL membership is denied by default',
   (await caught(() => OPS.openShift(req('uidStranger', 'cashier', { sellerId: M_A, openingCash: 0 })))).code
     === 'permission-denied');

/* ── 1 · the resolver ─────────────────────────────────────────────────────── */
head('1 · ownerUid -> canonical merchantId');
reset();
ck('an owner resolves to their merchant',
   (await TENANT.resolveMerchantIdForOwner(OWNER_A)).merchantId === M_A);
ck('NEGATIVE an unlinked uid resolves to nothing, not a guess',
   (await TENANT.resolveMerchantIdForOwner('uidNobody')).reason === TENANT.REASON.UNLINKED);
STORE['businesses/MCH-SECOND'] = { merchantId: 'MCH-SECOND', ownerId: OWNER_A, status: 'active' };
ck('NEGATIVE an owner of TWO businesses is AMBIGUOUS, never first-wins',
   (await TENANT.resolveMerchantIdForOwner(OWNER_A)).reason === TENANT.REASON.AMBIGUOUS,
   'seven lookups use limit(1); the three that default a merchantId now refuse instead');
reset();
STORE['businesses/' + M_A].merchantId = 'MCH-DISAGREES';
ck('NEGATIVE a doc whose merchantId field disagrees with its id is MALFORMED',
   (await TENANT.resolveMerchantIdForOwner(OWNER_A)).reason === TENANT.REASON.MALFORMED,
   'preferring one silently is how a tenant split starts');
reset();
STORE['businesses/' + M_A].status = 'suspended';
ck('NEGATIVE an inactive business does not resolve',
   (await TENANT.resolveMerchantIdForOwner(OWNER_A)).reason === TENANT.REASON.INACTIVE);
reset();
/* Comment-stripped. The first version searched the raw file and matched this module's own
   sentence explaining that it never reads that field — the seventh time in this codebase an
   assertion has matched documentation instead of behaviour. */
const TENANT_CODE = (function () {
  const src = fs.readFileSync(path.join(ROOT, 'functions/tenant-identity.js'), 'utf8');
  let out = '', i = 0, inB = false;
  while (i < src.length) {
    if (!inB && src[i] === '/' && src[i + 1] === '*') { inB = true; i += 2; continue; }
    if (inB && src[i] === '*' && src[i + 1] === '/') { inB = false; i += 2; continue; }
    if (!inB) out += src[i];
    i++;
  }
  return out.split(NL).filter((l) => l.trim().indexOf('//') !== 0).join(NL);
})();
ck('CONTROL the decorative BIZ- field is never returned',
   (await TENANT.resolveMerchantIdForOwner(OWNER_A)).merchantId.indexOf('BIZ-') === -1 &&
   TENANT_CODE.indexOf('.businessId') === -1 && TENANT_CODE.length > 400,
   'census §1: businesses.businessId is a label, not a key');

/* ── 2 · _requireSeller is canonical ──────────────────────────────────────── */
head('2 · every caller lands on the same key');
reset();
const ownerLegacy = await caught(() => OPS.openShift(req(OWNER_A, 'owner', { sellerId: OWNER_A, openingCash: 0 })));
ck('an owner sending their UID succeeds', ownerLegacy.code === null, ownerLegacy.code);
const ownerShift = Object.keys(STORE).filter((k) => k.indexOf('posShifts/') === 0).map((k) => STORE[k])[0];
ck('...and the record is keyed by the canonical merchantId, NOT the uid',
   ownerShift && ownerShift.sellerId === M_A,
   ownerShift ? ownerShift.sellerId : 'no shift');
reset();
const ownerCanon = await caught(() => OPS.openShift(req(OWNER_A, 'owner', { sellerId: M_A, openingCash: 0 })));
ck('an owner sending the merchantId also succeeds', ownerCanon.code === null);
reset();
const staff = await caught(() => OPS.openShift(req(CASHIER_A, 'cashier', { sellerId: M_A, openingCash: 0 })));
ck('a member sending the merchantId succeeds', staff.code === null, staff.code);
ck('...keyed identically to the owner path',
   (Object.keys(STORE).filter((k) => k.indexOf('posShifts/') === 0)
     .map((k) => STORE[k])[0] || {}).sellerId === M_A);
reset();
ck('NEGATIVE a member cannot address another merchant',
   (await caught(() => OPS.openShift(req(CASHIER_A, 'cashier', { sellerId: M_B, openingCash: 0 })))).code
     === 'permission-denied');
ck('NEGATIVE an owner cannot address another merchant',
   (await caught(() => OPS.openShift(req(OWNER_A, 'owner', { sellerId: M_B, openingCash: 0 })))).code
     === 'permission-denied');
ck('NEGATIVE another owner UID is not a tenant key',
   (await caught(() => OPS.openShift(req(OWNER_A, 'owner', { sellerId: OWNER_B, openingCash: 0 })))).code
     === 'permission-denied',
   'the uid form is recognised only for the CALLER, never as a general identifier');
STORE['businesses/MCH-SECOND'] = { merchantId: 'MCH-SECOND', ownerId: OWNER_A, status: 'active' };
ck('NEGATIVE an ambiguous owner FAILS CLOSED rather than picking',
   (await caught(() => OPS.openShift(req(OWNER_A, 'owner', { sellerId: OWNER_A, openingCash: 0 })))).code
     === 'failed-precondition');

/* ── 3 · THE APPROVAL LOOP NOW CLOSES ─────────────────────────────────────── */
head('3 · a staff request is visible to the owner-manager');
reset();
const made = await caught(() => OPS.createApprovalRequest(req(CASHIER_A, 'cashier',
  { sellerId: M_A, type: 'refund', requestData: { saleId: 'SALE_1', amount: 2500 } })));
ck('a staff cashier can raise a request', made.code === null, made.code);
const stored = STORE['posApprovals/' + made.value.approvalId] || {};
ck('...stored against the canonical merchantId', stored.sellerId === M_A);
const seenByOwnerLegacy = await caught(() => OPS.getPendingApprovals(
  req(OWNER_A, 'supervisor', { sellerId: OWNER_A })));
ck('THE FIX: an owner-manager listing with their UID SEES IT',
   seenByOwnerLegacy.code === null && (seenByOwnerLegacy.value.approvals || []).length === 1,
   'before convergence this returned an empty list while a real request was pending');
const seenByOwnerCanon = await caught(() => OPS.getPendingApprovals(
  req(OWNER_A, 'supervisor', { sellerId: M_A })));
ck('...and listing with the merchantId sees the same one',
   (seenByOwnerCanon.value.approvals || []).length === 1);
ck('NEGATIVE a Shop B manager sees nothing of Shop A',
   ((await caught(() => OPS.getPendingApprovals(req(OWNER_B, 'supervisor', { sellerId: M_B }))))
     .value.approvals || []).length === 0);
reset();
const ownerReq = await caught(() => OPS.createApprovalRequest(req(OWNER_A, 'owner',
  { sellerId: OWNER_A, type: 'void', requestData: { saleId: 'SALE_2' } })));
ck('an OWNER-raised request is also keyed canonically',
   (STORE['posApprovals/' + ownerReq.value.approvalId] || {}).sellerId === M_A,
   'both directions converge on one key');

/* ── 4 · shifts converge too ──────────────────────────────────────────────── */
head('4 · shift records share the tenant key');
reset();
await OPS.openShift(req(CASHIER_A, 'cashier', { sellerId: M_A, openingCash: 100 }));
const cur = await caught(() => OPS.getCurrentShift(req(CASHIER_A, 'cashier', { sellerId: M_A })));
ck('a member reads their own open shift', cur.code === null && !!cur.value.shift);
ck('employee attribution is preserved', (cur.value.shift || {}).cashierUid === CASHIER_A,
   'cashierUid is attribution and must not be converged away');
ck('NEGATIVE a different merchant cannot read it',
   ((await caught(() => OPS.getCurrentShift(req(OWNER_B, 'owner', { sellerId: M_B })))).value.shift || null) === null);

/* ── 5 · what did NOT change ──────────────────────────────────────────────── */
head('5 · nothing else moved');
const PSO = fs.readFileSync(path.join(ROOT, 'functions/pos-staff-ops.js'), 'utf8');
ck('no new collection was introduced',
   fs.readFileSync(path.join(ROOT, 'functions/tenant-identity.js'), 'utf8')
     .match(/collection\('([a-zA-Z]+)'\)/g).join() === "collection('businesses')",
   'the resolver reads exactly one existing collection');
ck('the accounting formula is untouched',
   PSO.indexOf('cashSales: _round2(cashSales)') > -1 && !/expected\s*=/.test(PSO));
ck('approval consumption is still ZERO call sites',
   fs.readdirSync(path.join(ROOT, 'functions')).filter((f) => f.slice(-3) === '.js' && f !== 'pos-staff-ops.js')
     .filter((f) => {
       const s = fs.readFileSync(path.join(ROOT, 'functions', f), 'utf8');
       return s.indexOf('_consumeApproval(') > -1 || s.indexOf('_approvals.consume') > -1 ||
              /\.consume\(\s*[A-Za-z_$]/.test(s);
     }).length === 0);
ck('the stale short-circuit note was corrected, not left to mislead',
   PSO.indexOf('SUPERSEDED, 2026-09-01') > -1 &&
   PSO.indexOf('if (auth.uid === sellerId) return sellerId;') === -1);

/* ── 5b · the owner lookups, per site ─────────────────────────────────────── */
head('5b · the seven limit(1) owner lookups, decided individually');
const BB = fs.readFileSync(path.join(ROOT, 'functions/business-bootstrap.js'), 'utf8');
const BB_CODE = (function () {
  let out = '', i = 0, inB = false;
  while (i < BB.length) {
    if (!inB && BB[i] === '/' && BB[i + 1] === '*') { inB = true; i += 2; continue; }
    if (inB && BB[i] === '*' && BB[i + 1] === '/') { inB = false; i += 2; continue; }
    if (!inB) out += BB[i];
    i++;
  }
  return out;
})();
ck('CONTROL the comment stripper works',
   BB_CODE.indexOf('CORRECT AS IT STANDS') === -1 && BB_CODE.length > 20000);
/* Counted with split, not a regex. The regex form lost its escaping in transit and became
   `resolveMerchantIdForOwner(uid)` with `(uid)` as a capture group — it matched nothing and
   reported 0 sites against correct code. Literal counting has no escaping to lose. */
const countOf = (hay, needle) => hay.split(needle).length - 1;
ck('the three merchantId-defaulting sites use the canonical resolver',
   countOf(BB_CODE, 'resolveMerchantIdForOwner(uid)') === 3,
   countOf(BB_CODE, 'resolveMerchantIdForOwner(uid)') + ' sites');
ck('...and each refuses on AMBIGUOUS rather than picking',
   countOf(BB_CODE, 'TENANT_REASON.AMBIGUOUS') >= 3,
   'a payment destination filed against the wrong own-business routes real money');
ck('CONTROL exactly ONE limit(1) owner lookup remains',
   countOf(BB_CODE, "where('ownerId', '==', uid).limit(1)") === 1,
   'the provisioning guard, which asks only WHETHER a business exists');
ck('...and it is the provisioning guard, kept deliberately',
   BB.indexOf('CORRECT AS IT STANDS') > -1 &&
   BB_CODE.indexOf("already-provisioned") > -1,
   'converging it would break every owner with more than one business');
ck('NEGATIVE profileGetCompletion was NOT converged',
   fs.readFileSync(path.join(ROOT, 'functions/profile-engine.js'), 'utf8')
     .indexOf('resolveMerchantIdForOwner') === -1,
   'it uses only size > 0; refusing on ambiguity there would be a regression');

/* ── 6 · boundary ─────────────────────────────────────────────────────────── */
head('6 · what this does NOT settle');
un('existing records keyed by owner UID', 'MIGRATION REQUIRED — see the report; they are now unreachable');
un('merchants whose data already straddles both spaces', 'needs a production query, not inspection');
un('the other 13 limit(1) owner lookups', 'each still first-wins; separate slice');
un('employee authority convergence', 'workspaceMemberships is canonical for TENANT here, not yet for CAPABILITY');
un('approval enforcement', 'consumption remains at zero call sites, by design');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: executed against an in-memory Firestore. No production data was read.');
})().then(() => process.exit(fail ? 1 : 0))
   .catch((e) => { console.error(NL + '  HARNESS ERROR: ' + (e && e.stack || e)); process.exit(2); });
