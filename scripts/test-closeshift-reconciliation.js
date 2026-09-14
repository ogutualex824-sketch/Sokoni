#!/usr/bin/env node
/**
 * closeShift — does it reconcile, and CAN it?
 *
 *   node scripts/test-closeshift-reconciliation.js
 *
 * WHAT IT DOES TODAY
 * It records. It resolves the caller's open shift server-side, aggregates that shift's sales
 * from `posRetailSales`, and writes `closingCash` beside `cashSales` — and never compares
 * them. There is no expected figure and no variance, so nothing to falsify: it does NOT
 * accept a client-supplied reconciliation, because it computes none.
 *
 * WHY A RECONCILIATION CANNOT SIMPLY BE ADDED HERE — THE BLOCKER
 * The ratified contract needs the drawer movements: cash_in, cash_out, safe_drop,
 * cash_pickup, float_adjustment. Those live in `posCashEvents`, keyed by `shiftId`. But that
 * id is a LOCAL one:
 *
 *   pos-sales.js openShift()  -> id: uid()          -> IndexedDB   (never calls the server)
 *   pos-checkout.html         -> _s.shiftId = that local id -> sent to cmRecordCashEvent
 *   functions openShift()     -> posShifts doc id   -> Firestore
 *
 * So `posCashEvents.shiftId` and the `posShifts` document id are DISJOINT identity spaces.
 * closeShift resolves a posShifts document; the cash events for that same shift are filed
 * under an id it has never seen.
 *
 * `posRetailSales.shiftId` DOES align — Priority 3 made checkout derive it from posShifts —
 * so a sales figure is computable here. A drawer expectation is not.
 *
 * WHY NOTHING WAS ADDED
 * expected = openingCash + cashSales − refunds, without cash_out / safe_drop / pickup /
 * adjustment, is not an incomplete answer — it is a WRONG one. It would report a cashier who
 * made a legitimate safe drop as short by exactly that amount, and a variance that accuses
 * an honest cashier is worse than no variance at all. That is the same rule as
 * "unknown is not zero", applied to a partial calculation.
 *
 * The correction is shift-identity convergence, which is its own slice.
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

/* ── in-memory Firestore ──────────────────────────────────────────────────── */
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
        .map((k) => ({ id: k.slice(coll.length + 1), data: () => STORE[k],
                       ref: makeRef(coll, k.slice(coll.length + 1)) }))
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
  if (request.endsWith('workforce-identity')) return {
    _assertBusinessPermission: async (uid, biz) => {
      const ok = Object.keys(STORE).filter((k) => k.indexOf('workspaceMemberships/') === 0)
        .map((k) => STORE[k]).some((m) => m.uid === uid && m.businessId === biz && m.status === 'active');
      if (!ok) throw new HttpsError('permission-denied', 'not a member');
    } };
  return realLoad.apply(this, arguments);
};
const OPS = require(path.join(ROOT, 'functions/pos-staff-ops.js'));
Module._load = realLoad;

const M_A = 'MCH-A', M_B = 'MCH-B', OWNER_A = 'uidOwnerA', OWNER_B = 'uidOwnerB';
const req = (uid, data) => ({ auth: { uid, token: { posRole: 'owner', name: 'N' } }, data });
const caught = async (fn) => { try { return { code: null, value: (await fn()) || {} }; }
                              catch (e) { return { code: e.code || 'threw', value: {} }; } };
const shiftDocs = () => Object.keys(STORE).filter((k) => k.indexOf('posShifts/') === 0).map((k) => STORE[k]);

/* float 5,000 + one 8,000 cash sale on the resolved shift */
async function seed (openingCash) {
  STORE = {};
  STORE['businesses/' + M_A] = { merchantId: M_A, ownerId: OWNER_A, status: 'active' };
  STORE['businesses/' + M_B] = { merchantId: M_B, ownerId: OWNER_B, status: 'active' };
  await OPS.openShift(req(OWNER_A, { sellerId: M_A, openingCash: openingCash }));
  const id = Object.keys(STORE).filter((k) => k.indexOf('posShifts/') === 0)[0].slice('posShifts/'.length);
  STORE['posRetailSales/S1'] = { sellerId: M_A, shiftId: id, status: 'completed',
    grandTotal: 8000, payments: [{ method: 'cash', amount: 8000 }] };
  return id;
}

console.log(NL + 'closeShift RECONCILIATION' + NL + '='.repeat(62));

(async function main () {

/* ── 0 · controls ─────────────────────────────────────────────────────────── */
head('0 · CONTROLS');
ck('the handlers loaded', typeof OPS.closeShift === 'function' && typeof OPS.openShift === 'function');
const sid = await seed(5000);
ck('CONTROL a shift was opened and resolved', !!sid && shiftDocs().length === 1);
ck('CONTROL the sale is filed under the SERVER shift id',
   STORE['posRetailSales/S1'].shiftId === sid,
   'Priority 3 made checkout derive this from posShifts');

/* ── 1 · what closeShift persists ─────────────────────────────────────────── */
head('1 · it records; it does not reconcile');
const res = await caught(() => OPS.closeShift(req(OWNER_A, { sellerId: M_A, closingCash: 8000 })));
ck('the close succeeds', res.code === null, res.code);
const closed = shiftDocs()[0] || {};
ck('the counted cash is recorded', closed.closingCash === 8000);
ck('the shift cash sales are recorded', closed.cashSales === 8000);
ck('the opening float is on the record', closed.openingCash === 5000);
ck('NEGATIVE there is NO expected figure', closed.expectedCash === undefined &&
   closed.expectedCents === undefined, 'nothing is computed to compare against');
ck('NEGATIVE there is NO variance', closed.variance === undefined &&
   closed.varianceCents === undefined,
   'so a 5,000 shortfall passes without comment');

/* ── 2 · it accepts no client reconciliation ──────────────────────────────── */
head('2 · nothing to falsify');
await seed(5000);
const lie = await caught(() => OPS.closeShift(req(OWNER_A, {
  sellerId: M_A, closingCash: 8000,
  expectedCash: 99999, variance: 0, varianceCents: 0, status: 'balanced' })));
ck('the close still succeeds', lie.code === null);
const lied = shiftDocs()[0] || {};
ck('NEGATIVE no client variance is stored',
   lied.variance === undefined && lied.varianceCents === undefined);
ck('NEGATIVE no client expected figure is stored', lied.expectedCash === undefined);
ck('NEGATIVE the client cannot set the reconciliation status',
   lied.status === 'closed', String(lied.status));

/* ── 3 · shift identity is server-resolved ────────────────────────────────── */
head('3 · the caller does not choose the shift');
const PSO = fs.readFileSync(path.join(ROOT, 'functions/pos-staff-ops.js'), 'utf8');
const CLOSE = PSO.slice(PSO.indexOf('exports.closeShift = onCall'),
                        PSO.indexOf('exports.getCurrentShift = onCall'));
ck('CONTROL the handler body was isolated', CLOSE.length > 900, CLOSE.length + ' chars');
ck('the shift is found by sellerId + cashierUid + open',
   CLOSE.indexOf(".where('cashierUid', '==', cashierUid)") > -1 &&
   CLOSE.indexOf(".where('status', '==', 'open')") > -1);
ck('NEGATIVE no client shiftId is accepted',
   CLOSE.indexOf('data.shiftId') === -1,
   'scoped to closeShift — the Priority 3 trust problem must not return');
ck('the tenant is canonical', CLOSE.indexOf('await _requireSeller(auth, data)') > -1);

/* ── 4 · the listed scenarios ─────────────────────────────────────────────── */
head('4 · balanced, short, over, duplicate, cross-tenant');
await seed(5000);
await OPS.closeShift(req(OWNER_A, { sellerId: M_A, closingCash: 13000 }));
ck('a BALANCED close records 13,000 counted', shiftDocs()[0].closingCash === 13000);
await seed(5000);
await OPS.closeShift(req(OWNER_A, { sellerId: M_A, closingCash: 8000 }));
ck('a SHORT close records 8,000 — and says nothing about it',
   shiftDocs()[0].closingCash === 8000 && shiftDocs()[0].variance === undefined);
await seed(5000);
await OPS.closeShift(req(OWNER_A, { sellerId: M_A, closingCash: 20000 }));
ck('an OVER close records 20,000 — likewise silent',
   shiftDocs()[0].closingCash === 20000 && shiftDocs()[0].variance === undefined);
await seed(5000);
await OPS.closeShift(req(OWNER_A, { sellerId: M_A, closingCash: 13000 }));
const dup = await caught(() => OPS.closeShift(req(OWNER_A, { sellerId: M_A, closingCash: 1 })));
ck('NEGATIVE a duplicate close is refused', dup.code === 'not-found', dup.code);
ck('...and the first close is untouched', shiftDocs()[0].closingCash === 13000);
await seed(5000);
ck('NEGATIVE a cross-tenant close is refused',
   (await caught(() => OPS.closeShift(req(OWNER_B, { sellerId: M_A, closingCash: 1 })))).code
     === 'permission-denied');
ck('NEGATIVE closing with no open shift is refused',
   (await caught(() => OPS.closeShift(req(OWNER_B, { sellerId: M_B, closingCash: 1 })))).code
     === 'not-found');
ck('NEGATIVE a negative counted amount is refused',
   (await caught(() => OPS.closeShift(req(OWNER_A, { sellerId: M_A, closingCash: -5 })))).code
     === 'invalid-argument');

head('4b · a failure surfaces its real reason');
ck('closeShift imports the logger its catch block uses',
   PSO.indexOf("require('firebase-functions/logger')") > -1,
   'it was missing, so every failure threw ReferenceError before the real error re-raised');
ck('the catch still re-raises a real HttpsError',
   CLOSE.indexOf('if (err instanceof HttpsError) throw err;') > -1);

/* ── 5 · THE BLOCKER: two shift identity spaces ───────────────────────────── */
head('5 · why a drawer expectation cannot be computed here');
const POSSALES = fs.readFileSync(path.join(ROOT, 'pos-sales.js'), 'utf8');
const OPEN_FN = POSSALES.slice(POSSALES.indexOf('async function openShift'),
                               POSSALES.indexOf('async function closeShift'));
ck('CONTROL the client openShift was isolated', OPEN_FN.length > 300, OPEN_FN.length + ' chars');
ck('the client mints its OWN shift id', OPEN_FN.indexOf('id:           uid(),') > -1);
ck('...into local storage, never calling the server',
   OPEN_FN.indexOf('_put(S.SHIFTS, shift)') > -1 && OPEN_FN.indexOf('httpsCallable') === -1,
   'so posCashEvents.shiftId is a local uid');
ck('the SERVER shift id is a Firestore document id',
   PSO.indexOf('const shiftRef = db.collection(\'posShifts\').doc();') > -1 &&
   PSO.indexOf('return { shiftId: shiftRef.id') > -1);
ck('THEREFORE the cash ledger and posShifts are DISJOINT id spaces',
   OPEN_FN.indexOf('uid()') > -1 && PSO.indexOf('shiftRef.id') > -1,
   'closeShift cannot find this shift cash events; they are filed under an id it never saw');
ck('CONTROL posRetailSales DOES align, which is why sales are computable',
   fs.readFileSync(path.join(ROOT, 'functions/pos-zero-friction.js'), 'utf8')
     .indexOf('resolvedShiftId = _shiftSnap.empty ? null : _shiftSnap.docs[0].id;') > -1,
   'Priority 3 derived it from posShifts — the drawer events were never converged');

/* ── 6 · why nothing was added ────────────────────────────────────────────── */
head('6 · a partial expectation would be worse than none');
ck('the drawer terms live in posCashEvents, not in anything closeShift reads',
   CLOSE.indexOf('posCashEvents') === -1 && CLOSE.indexOf('posTillEvents') === -1);
ck('NEGATIVE no partial expected figure was invented here',
   CLOSE.indexOf('expected') === -1,
   'opening + cashSales - refunds omits cash_out, safe_drop, pickup and adjustment');
ck('NEGATIVE no second formula was added', !/expected\s*=/.test(CLOSE));
ck('CONTROL the ratified contract still lives in one place',
   fs.readFileSync(path.join(ROOT, 'functions/pos-cash-manager.js'), 'utf8')
     .indexOf('const expected = openingFloatCents + cashSales - cashRefunds') > -1);

/* ── 6b · the offline-origin join key ─────────────────────────────────────── */
head('6b · one shift, recorded under the identity it was born with');
STORE = {};
STORE['businesses/' + M_A] = { merchantId: M_A, ownerId: OWNER_A, status: 'active' };
await OPS.openShift({ auth: { uid: OWNER_A, token: { posRole: 'owner' } },
  data: { sellerId: M_A, openingCash: 5000, clientShiftId: 'local-uid-abc' } });
const joined = shiftDocs()[0] || {};
ck('the posShifts document records the offline-origin id',
   joined.clientShiftId === 'local-uid-abc',
   'cash events raised before the server knew about the shift can now be joined to it');
ck('CONTROL the posShifts document id is still the shift identity',
   Object.keys(STORE).filter((k) => k.indexOf('posShifts/') === 0)[0].length > 'posShifts/'.length,
   'the alias is a join key, not a replacement');
STORE = {};
STORE['businesses/' + M_A] = { merchantId: M_A, ownerId: OWNER_A, status: 'active' };
await OPS.openShift(req(OWNER_A, { sellerId: M_A, openingCash: 5000 }));
ck('an omitted client id records NULL, not an invented one',
   shiftDocs()[0].clientShiftId === null, String(shiftDocs()[0].clientShiftId));
STORE = {};
STORE['businesses/' + M_A] = { merchantId: M_A, ownerId: OWNER_A, status: 'active' };
await OPS.openShift({ auth: { uid: OWNER_A, token: { posRole: 'owner' } },
  data: { sellerId: M_A, openingCash: 5000, clientShiftId: { evil: true } } });
ck('NEGATIVE a non-string client id is refused, not coerced',
   shiftDocs()[0].clientShiftId === null);
ck('NEGATIVE the join key grants nothing',
   CLOSE.indexOf('clientShiftId') === -1,
   'scoped to closeShift — the open shift is still resolved from sellerId + auth.uid');
ck('NEGATIVE no new shift collection was created',
   PSO.indexOf("collection('shiftSessions')") === -1 &&
   PSO.indexOf("collection('posShiftMap')") === -1);

/* ── 6c · offline shift REGISTRATION ──────────────────────────────────────── */
head('6c · an offline-born shift joins its server record');
const fresh = () => { STORE = {};
  STORE['businesses/' + M_A] = { merchantId: M_A, ownerId: OWNER_A, status: 'active' };
  STORE['businesses/' + M_B] = { merchantId: M_B, ownerId: OWNER_B, status: 'active' }; };
const reg = (uid, cid, extra) => OPS.registerClientShift({
  auth: { uid, token: { posRole: 'owner' } },
  data: Object.assign({ sellerId: uid === OWNER_B ? M_B : M_A, clientShiftId: cid }, extra || {}) });

const REG_EARLY = PSO.slice(PSO.indexOf('exports.registerClientShift = onCall'),
                            PSO.indexOf('exports.closeShift = onCall'));
fresh();
const r1 = await caught(() => reg(OWNER_A, 'local-1', { openingCash: 5000 }));
ck('registration CREATES a server shift when none is open',
   r1.code === null && r1.value.created === true && !!r1.value.shiftId, r1.code);
ck('...carrying the offline-origin id',
   (shiftDocs()[0] || {}).clientShiftId === 'local-1');
ck('...owned by the authenticated cashier and canonical merchant',
   shiftDocs()[0].cashierUid === OWNER_A && shiftDocs()[0].sellerId === M_A);

const r2 = await caught(() => reg(OWNER_A, 'local-1', { openingCash: 5000 }));
ck('IDEMPOTENT a repeat registration returns the SAME shift',
   r2.code === null && r2.value.shiftId === r1.value.shiftId && r2.value.reused === true);
ck('...and creates NO duplicate', shiftDocs().length === 1, String(shiftDocs().length));
/* Idempotency has TWO mechanisms: the early return on an already-bound id, and the
   attach path finding the same open shift. Removing either alone still yields the same
   shift, so a sabotage of one produced zero failures. Both are asserted separately, and
   the sabotage that matters removes both. */
ck('the early return on an already-bound id exists',
   REG_EARLY.indexOf('reused: true, created: false') > -1,
   'scoped to registerClientShift');
ck('...and the attach path independently refuses to duplicate',
   REG_EARLY.indexOf(".where('status', '==', 'open')") > -1);

ck('NEGATIVE another cashier cannot claim that id',
   (await caught(() => reg(OWNER_B, 'local-1'))).code === 'permission-denied');
ck('NEGATIVE a cross-tenant registration is refused',
   (await caught(() => OPS.registerClientShift({ auth: { uid: OWNER_B, token: {} },
     data: { sellerId: M_A, clientShiftId: 'local-9' } }))).code === 'permission-denied');
ck('NEGATIVE an empty client id is refused',
   (await caught(() => reg(OWNER_A, ''))).code === 'invalid-argument');

head('6d · attach, and refuse to reassign');
fresh();
await OPS.openShift(req(OWNER_A, { sellerId: M_A, openingCash: 5000 }));
const att = await caught(() => reg(OWNER_A, 'local-2'));
ck('an OPEN shift with no id is attached, not duplicated',
   att.code === null && att.value.attached === true && shiftDocs().length === 1);
ck('...and now carries the id', shiftDocs()[0].clientShiftId === 'local-2');
ck('NEGATIVE a DIFFERENT id on the same open shift is refused',
   (await caught(() => reg(OWNER_A, 'local-3'))).code === 'failed-precondition',
   'nothing is overwritten, merged or guessed');
ck('...and the original binding is untouched', shiftDocs()[0].clientShiftId === 'local-2');

head('6e · the id is a join key, never a permission');
const REG_FN = PSO.slice(PSO.indexOf('exports.registerClientShift = onCall'),
                         PSO.indexOf('exports.closeShift = onCall'));
ck('CONTROL the handler body was isolated', REG_FN.length > 900, REG_FN.length + ' chars');
ck('the merchant is server-resolved', REG_FN.indexOf('await _requireSeller(auth, data)') > -1);
ck('the cashier is auth.uid', REG_FN.indexOf('const cashierUid = auth.uid;') > -1);
ck('NEGATIVE the caller cannot name a server shift',
   REG_FN.indexOf('data.shiftId') === -1,
   'scoped to registerClientShift — data.shiftId legitimately appears elsewhere in this file');
ck('NEGATIVE closeShift still ignores any client shift id',
   CLOSE.indexOf('clientShiftId') === -1 && CLOSE.indexOf('data.shiftId') === -1);
ck('NEGATIVE no second shift store was introduced',
   REG_FN.indexOf("collection('posShifts')") > -1 &&
   PSO.indexOf("collection('shiftSessions')") === -1);

/* ── 6f · the offline queue carries the registration ──────────────────────── */
head('6f · queued offline, delivered on reconnect');
const SYNC = fs.readFileSync(path.join(ROOT, 'pos-sync.js'), 'utf8');
const SALES = fs.readFileSync(path.join(ROOT, 'pos-sales.js'), 'utf8');
const ROUTES_BLOCK = SYNC.slice(SYNC.indexOf('const ROUTES = {'), SYNC.indexOf('async function _ensureFns'));
const CALLABLE_BLOCK = SYNC.slice(SYNC.indexOf('async function _syncCallable'),
                                  SYNC.indexOf('async function _syncItem'));
const SYNCITEM = SYNC.slice(SYNC.indexOf('async function _syncItem'),
                            SYNC.indexOf('async function _syncItem') + 1400);
ck('CONTROL the three blocks were isolated',
   ROUTES_BLOCK.length > 200 && CALLABLE_BLOCK.length > 400 && SYNCITEM.length > 400);
/* THE ROUTE MUST BE REACHABLE. pos-staff-ops handlers are consolidated into
   smartPosDispatch and none is exported by name, so httpsCallable('registerClientShift')
   would resolve to nothing — fail, retry eight times, and sit in the DLQ forever. A
   handset would have shown this immediately; the assertion now does. */
ck('the queue routes registration through the DISPATCHER',
   ROUTES_BLOCK.indexOf("callable: 'smartPosDispatch'") > -1 &&
   ROUTES_BLOCK.indexOf("op:       'registerClientShift'") > -1);
ck('NEGATIVE it does not call the handler by name',
   ROUTES_BLOCK.indexOf("callable: 'registerClientShift'") === -1,
   'no pos-staff-ops handler is exported individually from index.js');
ck('CONTROL that is how every other POS client call reaches these handlers',
   fs.readFileSync(path.join(ROOT, 'pos-checkout.html'), 'utf8')
     .indexOf("httpsCallable('smartPosDispatch')({ op,") > -1);
ck('the op is placed in the body the dispatcher reads',
   CALLABLE_BLOCK.indexOf("Object.assign({ op: route.op }, payload)") > -1);
ck('a callable route branches BEFORE any document write',
   SYNCITEM.indexOf('if (route.callable) return _syncCallable(item, route);') > -1 &&
   SYNCITEM.indexOf('if (route.callable)') < SYNCITEM.indexOf('const docId'),
   'the existing sale sync path is untouched by this addition');
ck('the payload is an ALLOW-LIST, never a spread',
   CALLABLE_BLOCK.indexOf('allowed.forEach') > -1 &&
   CALLABLE_BLOCK.indexOf('...item.data') === -1 &&
   CALLABLE_BLOCK.indexOf('...src') === -1,
   'a corrupted queue entry cannot smuggle an identity into the call');
ck('NEGATIVE a cashier identity can never be sent',
   SYNC.indexOf("'sellerId', 'clientShiftId', 'openingCash', 'branchId', 'cashierName'") > -1 &&
   SYNC.slice(SYNC.indexOf('CALLABLE_PAYLOAD'), SYNC.indexOf('async function _syncCallable'))
     .indexOf('cashierUid') === -1);
ck('a registration with no join key fails rather than retrying forever',
   CALLABLE_BLOCK.indexOf('without a clientShiftId') > -1);

head('6g · retry, idempotency and the sale guarantee');
ck('failure is retryable through the EXISTING engine',
   SYNC.indexOf('await PosDB.syncQueue.markRetry(item.id, newRetries)') > -1 &&
   SYNC.indexOf('moveToDLQ') > -1,
   'a throw in _syncCallable becomes markRetry; no new machinery');
ck('success marks the item handled', SYNC.indexOf('await PosDB.syncQueue.markDone(item.id)') > -1);
ck('repeated delivery is safe because the SERVER is idempotent',
   REG_EARLY.indexOf('reused: true, created: false') > -1,
   'the queue may deliver twice; the callable returns the same shift');
ck('the till enqueues the registration when it opens a shift',
   SALES.indexOf('_queueShiftRegistration(shift);') > -1);
ck('NEGATIVE registration failure cannot break a sale',
   SALES.slice(SALES.indexOf('function _queueShiftRegistration'),
              SALES.indexOf('function _queueShiftRegistration') + 1200)
     .indexOf('catch (_)') > -1,
   'best-effort by design — the offline-first guarantee outranks registration');
ck('NEGATIVE the existing sale route is unchanged',
   ROUTES_BLOCK.indexOf("collection: 'posTransactions'") > -1 &&
   ROUTES_BLOCK.indexOf('merge:      false') > -1);
ck('NEGATIVE no second queue or store was introduced',
   SALES.indexOf('PosSync.queue') > -1 &&
   SYNC.indexOf('indexedDB.open') === -1);

/* ── 7 · boundary ─────────────────────────────────────────────────────────── */
head('7 · what this slice deliberately leaves');
un('closeShift reconciles the drawer', 'BLOCKED — shift identity must converge first; see section 5');
un('shift-identity convergence', 'its own slice: the client mints local ids that never reach posShifts');
un('approval consumption at close', 'still 0 call sites, pending employee-authority convergence');
un('historical shifts closed without a variance', 'a migration question, like the tenant key');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: closeShift records honestly. It does not reconcile, and cannot yet.');
})().then(() => process.exit(fail ? 1 : 0))
   .catch((e) => { console.error(NL + '  HARNESS ERROR: ' + (e && e.stack || e)); process.exit(2); });
