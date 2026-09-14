#!/usr/bin/env node
/**
 * APPROVAL PRIMITIVE — four-eyes, shop-bound, single-use, operation-bound.
 *
 *   node scripts/test-approval-primitive.js
 *
 * This EXECUTES pos-staff-ops.js against an in-memory Firestore rather than reading its
 * source. A source assertion cannot tell you whether an approval can actually be spent
 * twice; only running the transition can.
 *
 * THE FOUR DEFECTS IT CLOSES
 *   1. self-approval      reviewApproval never compared requestedBy to the reviewer
 *   2. cross-shop review  it proved the caller was a supervisor SOMEWHERE, not here
 *   3. no single use      status stopped at 'approved'; nothing ever spent it
 *   4. opaque requestData an approval for KES 50 was indistinguishable from KES 50,000
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM
 * Nothing consumes an approval in production yet. This proves the PRIMITIVE is sound,
 * not that manager approval is enforced. Each protected mutation adopting it is its own
 * slice, and the client PIN stays until they do.
 */
'use strict';
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

/* ── an in-memory Firestore, only as much as the module touches ───────────── */
const STORE = {};                    /* 'coll/id' -> data */
let AUTO = 0;
const SENTINEL = '__serverTimestamp__';

function docRef(coll, id) {
  const key = coll + '/' + id;
  return {
    id,
    get: async () => ({ exists: Object.prototype.hasOwnProperty.call(STORE, key),
                        data: () => STORE[key], id }),
    set: async (v) => { STORE[key] = JSON.parse(JSON.stringify(v)); },
    update: async (v) => { Object.assign(STORE[key], v); },
  };
}
function collRef(coll) {
  const chain = { _f: [] };
  chain.where = () => chain;
  chain.orderBy = () => chain;
  chain.limit = () => chain;
  chain.get = async () => ({ empty: true, docs: [], size: 0, forEach() {} });
  chain.doc = (id) => docRef(coll, id || ('auto' + (++AUTO)));
  return chain;
}
const fakeDb = {
  collection: collRef,
  runTransaction: async (fn) => fn({
    get: async (ref) => ref.get(),
    update: (ref, v) => {
      const k = Object.keys(STORE).find((x) => x.endsWith('/' + ref.id));
      if (k) Object.assign(STORE[k], v);
    },
  }),
};

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.httpErrorCode = true; }
}

/* Deny by default; the test opens specific (uid, shop) pairs. */
const MEMBERSHIPS = new Set();
let permissionCalls = 0;

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin') {
    return {
      apps: [1],
      initializeApp() {},
      firestore: Object.assign(() => fakeDb, {
        FieldValue: { serverTimestamp: () => SENTINEL, increment: (n) => n },
      }),
    };
  }
  if (request === 'firebase-functions/v2/https') {
    return { onCall: (_opts, handler) => handler, HttpsError };
  }
  if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (request === './workforce-identity' || request.endsWith('workforce-identity')) {
    return {
      _assertBusinessPermission: async (uid, businessId) => {
        permissionCalls++;
        if (!MEMBERSHIPS.has(uid + '@' + businessId)) {
          throw new HttpsError('permission-denied', 'Not a member of this business');
        }
      },
    };
  }
  return realLoad.apply(this, arguments);
};

const OPS = require(path.join(ROOT, 'functions/pos-staff-ops.js'));
Module._load = realLoad;

const A = OPS._approvals;
const req = (uid, posRole, data) => ({ auth: { uid, token: { posRole } }, data });
const caught = async (fn) => {
  try { await fn(); return null; } catch (e) { return e.code || 'threw'; }
};
const seed = (id, over) => {
  STORE['posApprovals/' + id] = Object.assign({
    sellerId: 'SHOP_A', type: 'refund', requestedBy: 'CASHIER_1',
    binding: { saleId: 'SALE_1', amount: 50 }, status: 'approved',
    expiresAt: new Date(Date.now() + 60000),
  }, over);
};

console.log(NL + 'APPROVAL PRIMITIVE' + NL + '='.repeat(62));

(async function main () {

/* ── 0 · the harness itself must be sound ─────────────────────────────────── */
head('0 · CONTROLS on the harness');
ck('the module loaded against the fake', typeof OPS.reviewApproval === 'function');
ck('the consumption primitive is exposed', A && typeof A.consume === 'function');
ck('CONTROL permission is DENIED by default',
   (await caught(async () => {
     MEMBERSHIPS.clear();
     const r = require(path.join(ROOT, 'functions/pos-staff-ops.js'));
     seed('probe', {});
     await r.reviewApproval(req('NOBODY', 'supervisor', { approvalId: 'probe', decision: 'approved' }));
   })) === 'permission-denied',
   'if the fake allowed everything, every negative below would pass vacuously');

/* ── 1 · self-approval ────────────────────────────────────────────────────── */
head('1 · a requester cannot approve their own request');
MEMBERSHIPS.add('CASHIER_1@SHOP_A');
seed('s1', { requestedBy: 'CASHIER_1', status: 'pending' });
ck('NEGATIVE the requester, WITH supervisor authority, is refused',
   (await caught(() => OPS.reviewApproval(
     req('CASHIER_1', 'supervisor', { approvalId: 's1', decision: 'approved' })))) === 'permission-denied',
   'holding the claim is not the same as being a second pair of eyes');
ck('...and the approval is untouched', STORE['posApprovals/s1'].status === 'pending');

MEMBERSHIPS.add('MANAGER_1@SHOP_A');
seed('s2', { requestedBy: 'CASHIER_1', status: 'pending' });
ck('POSITIVE a different authorised manager in the same shop MAY approve',
   (await caught(() => OPS.reviewApproval(
     req('MANAGER_1', 'supervisor', { approvalId: 's2', decision: 'approved' })))) === null,
   'the legitimate flow must survive the fix');
ck('...and the decision was recorded', STORE['posApprovals/s2'].status === 'approved' &&
   STORE['posApprovals/s2'].reviewedBy === 'MANAGER_1');

/* ── 2 · shop binding ─────────────────────────────────────────────────────── */
head('2 · a manager cannot review another shop request');
seed('x1', { sellerId: 'SHOP_B', requestedBy: 'CASHIER_9', status: 'pending' });
ck('NEGATIVE a Shop A manager reviewing a Shop B approval is refused',
   (await caught(() => OPS.reviewApproval(
     req('MANAGER_1', 'supervisor', { approvalId: 'x1', decision: 'approved' })))) === 'permission-denied');
MEMBERSHIPS.add('MANAGER_B@SHOP_B');
seed('x2', { sellerId: 'SHOP_B', requestedBy: 'CASHIER_9', status: 'pending' });
ck('POSITIVE a genuine Shop B reviewer is allowed',
   (await caught(() => OPS.reviewApproval(
     req('MANAGER_B', 'supervisor', { approvalId: 'x2', decision: 'approved' })))) === null);
seed('x3', { sellerId: 'SHOP_B', requestedBy: 'CASHIER_9', status: 'pending' });
ck('NEGATIVE a FORGED sellerId in the payload changes nothing',
   (await caught(() => OPS.reviewApproval(
     req('MANAGER_1', 'supervisor',
         { approvalId: 'x3', decision: 'approved', sellerId: 'SHOP_A' })))) === 'permission-denied',
   'the shop is read from the approval document; no client value is consulted');
ck('CONTROL the owner short-circuit still works',
   (function () { seed('x4', { sellerId: 'OWNER_B', requestedBy: 'CASHIER_9', status: 'pending' }); return true; })() &&
   (await caught(() => OPS.reviewApproval(
     req('OWNER_B', 'supervisor', { approvalId: 'x4', decision: 'approved' })))) === null,
   'uid === sellerId, mirroring _requireSeller — no new authority introduced');

/* ── 3 · single use ───────────────────────────────────────────────────────── */
head('3 · an approval can be spent exactly once');
const SPEND = { sellerId: 'SHOP_A', type: 'refund',
                binding: { saleId: 'SALE_1', amount: 50 }, consumerUid: 'MANAGER_1' };
seed('c1', {});
ck('the FIRST consumption succeeds', (await caught(() => A.consume('c1', SPEND))) === null);
ck('...and the status is now consumed', STORE['posApprovals/c1'].status === 'consumed');
ck('...recording who spent it', STORE['posApprovals/c1'].consumedBy === 'MANAGER_1');
ck('NEGATIVE the SECOND consumption fails',
   (await caught(() => A.consume('c1', SPEND))) === 'failed-precondition',
   'this is the invariant a status check alone does not give you');
seed('c2', { status: 'pending' });
ck('NEGATIVE a merely PENDING approval cannot be spent',
   (await caught(() => A.consume('c2', SPEND))) === 'failed-precondition',
   'review and consumption are different events');
seed('c3', { status: 'rejected' });
ck('NEGATIVE a REJECTED approval cannot be spent',
   (await caught(() => A.consume('c3', SPEND))) === 'failed-precondition');
seed('c4', { expiresAt: new Date(Date.now() - 1000) });
ck('NEGATIVE an EXPIRED approval cannot be spent',
   (await caught(() => A.consume('c4', SPEND))) === 'deadline-exceeded');
ck('NEGATIVE an unknown approvalId cannot be spent',
   (await caught(() => A.consume('nope', SPEND))) === 'not-found');

/* ── 4 · operation binding ────────────────────────────────────────────────── */
head('4 · the approval authorises one exact operation');
seed('b1', {});
ck('NEGATIVE an altered AMOUNT is refused',
   (await caught(() => A.consume('b1',
     Object.assign({}, SPEND, { binding: { saleId: 'SALE_1', amount: 50000 } })))) === 'permission-denied',
   'a KES 50 approval must never spend as KES 50,000');
ck('...and the approval survives, unspent', STORE['posApprovals/b1'].status === 'approved');
ck('NEGATIVE a different SALE is refused',
   (await caught(() => A.consume('b1',
     Object.assign({}, SPEND, { binding: { saleId: 'SALE_2', amount: 50 } })))) === 'permission-denied');
ck('NEGATIVE a different OPERATION TYPE is refused',
   (await caught(() => A.consume('b1', Object.assign({}, SPEND, { type: 'void' })))) === 'permission-denied',
   'a refund approval is not a void approval');
ck('NEGATIVE another SHOP cannot spend it',
   (await caught(() => A.consume('b1', Object.assign({}, SPEND, { sellerId: 'SHOP_B' })))) === 'permission-denied');
ck('NEGATIVE a MISSING binding is refused, not treated as a match',
   (await caught(() => A.consume('b1', { sellerId: 'SHOP_A', type: 'refund' }))) === 'permission-denied',
   'undefined must never compare equal to an approved amount');
ck('POSITIVE the exact operation still succeeds',
   (await caught(() => A.consume('b1', SPEND))) === null,
   'section 4 would be vacuous if nothing could be spent at all');

/* ── 5 · binding is required at creation ──────────────────────────────────── */
head('5 · an unbound approval cannot be created');
ck('a refund with no saleId is refused',
   (await caught(() => OPS.createApprovalRequest(
     req('CASHIER_1', 'cashier',
         { sellerId: 'SHOP_A', type: 'refund', requestData: { amount: 50 } })))) === 'invalid-argument');
ck('a refund with a negative amount is refused',
   (await caught(() => OPS.createApprovalRequest(
     req('CASHIER_1', 'cashier',
         { sellerId: 'SHOP_A', type: 'refund',
           requestData: { saleId: 'S', amount: -5 } })))) === 'invalid-argument');
ck('a drawer_open needs no target, and is allowed',
   (await caught(() => OPS.createApprovalRequest(
     req('CASHIER_1', 'cashier',
         { sellerId: 'SHOP_A', type: 'drawer_open', requestData: {} })))) === null,
   'opening the drawer is the whole act — inventing a field to bind would be theatre');
ck('CONTROL the five types are unchanged',
   Object.keys(A.BINDING).sort().join(',') === 'discount,drawer_open,price_override,refund,void',
   'no type was added or removed to make binding convenient');
ck('CONTROL amounts are SHILLINGS, matching this file and posProcessRefund',
   A.build('refund', { saleId: 'S', amount: 50.456 }).amount === 50.46,
   '_round2 — importing the cents convention here would authorise 100x');

/* ── 6 · what this does NOT prove ─────────────────────────────────────────── */
head('6 · the boundary');
un('approval is enforced by any mutation',
   'NOTHING consumes one yet — refund, void, discount, stock, shift close, drawer all unwired');
un('true concurrent double-spend', 'the fake serialises; needs the emulator or a real Firestore');
un('the PIN is removable', 'it stays until a protected mutation actually consumes an approval');

})().then(() => {
console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: primitive only. Manager approval is NOT enforceable end to end.');
process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(NL + '  HARNESS ERROR: ' + (e && e.stack || e)); process.exit(2); });
