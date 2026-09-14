#!/usr/bin/env node
/**
 * voidPOSSale — tenant-bound, atomic, failure-visible.
 *
 *   node scripts/test-void-tenant-atomicity.js
 *
 * This EXECUTES the handler against an in-memory Firestore whose transaction BUFFERS
 * writes and applies them only on success. That matters: source assertions cannot show
 * that a denied void leaves the other shop's stock untouched, and a fake that applied
 * writes immediately would report atomicity that does not exist.
 *
 * THE P1 THIS CLOSES
 * voidPOSSale required a manager/supervisor/owner claim — at ANY shop — then took a
 * client saleId, voided posSales/{saleId}, and restored inventory with
 * `.update({stock: incr(qty)}).catch(() => {})`. So a manager at one shop could void
 * another merchant's sale AND increment that merchant's stock, non-transactionally, with
 * failures discarded.
 *
 * DELIBERATE NARROWING
 * A non-admin may now void only sales whose sellerId is their own uid — ownership being
 * the sellers/{id} document id, as recordPOSSale binds it. An EMPLOYEE manager can no
 * longer void, because no employee store may be chosen here without silently declaring
 * one canonical. That is fail-closed and is restored by the authority-convergence slice.
 *
 * NOT IN SCOPE: approval consumption, the PIN, employee convergence, Rules.
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

/* ── in-memory Firestore with a BUFFERING transaction ─────────────────────── */
let STORE = {};
let AUTO = 0;
let FAIL_WRITE_ON = null;   /* inject a commit-time write failure */
const INC = (n) => ({ __inc: n });
const TS = '__ts__';

const applyPatch = (target, patch) => {
  Object.keys(patch).forEach((k) => {
    const v = patch[k];
    if (v && typeof v === 'object' && typeof v.__inc === 'number') {
      target[k] = (Number(target[k]) || 0) + v.__inc;
    } else target[k] = v;
  });
};

function makeRef(coll, id) {
  const key = coll + '/' + id;
  return { id, _key: key, _coll: coll,
    get: async () => ({ exists: Object.prototype.hasOwnProperty.call(STORE, key),
                        data: () => STORE[key], id, ref: makeRef(coll, id) }),
    update: async (v) => { if (!STORE[key]) throw new Error('no doc'); applyPatch(STORE[key], v); },
    set: async (v) => { STORE[key] = v; } };
}
function makeColl(coll) {
  const c = {};
  c.where = () => c; c.orderBy = () => c; c.limit = () => c;
  const _f = [];
  c.where = (f, _op, v) => { _f.push([f, v]); return c; };
  c.get = async () => {
    const docs = Object.keys(STORE).filter((k) => k.indexOf(coll + '/') === 0)
      .map((k) => ({ id: k.slice(coll.length + 1), data: () => STORE[k] }))
      .filter((d) => _f.every(([f, v]) => d.data()[f] === v));
    return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
  };
  c.doc = (id) => makeRef(coll, id || ('auto' + (++AUTO)));
  c.add = async (v) => { const r = c.doc(); STORE[r._key] = v; return r; };
  return c;
}
const fdb = {
  collection: makeColl,
  /* Writes are BUFFERED and committed only if the body completes. A throw anywhere
     leaves the store exactly as it was — which is what "atomic" has to mean here. */
  runTransaction: async (fn) => {
    const writes = [];
    const txn = {
      get: async (ref) => ref.get(),
      getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
      update: (ref, v) => writes.push({ ref, v, op: 'update' }),
      set: (ref, v) => writes.push({ ref, v, op: 'set' }),
    };
    const out = await fn(txn);
    /* Commit is ALL-OR-NOTHING, as Firestore's is: snapshot first, and roll the whole
       thing back if any single write fails. Without this the fake would apply the writes
       before the failing one and then report that atomicity was absent — an artefact of
       the harness, not of the code under test. FAIL_WRITE_ON injects that failure. */
    const before = JSON.parse(JSON.stringify(STORE));
    try {
      writes.forEach((w) => {
        if (FAIL_WRITE_ON && w.ref._key === FAIL_WRITE_ON) throw new Error('simulated write failure');
        if (w.op === 'set') STORE[w.ref._key] = w.v;
        else { if (!STORE[w.ref._key]) STORE[w.ref._key] = {}; applyPatch(STORE[w.ref._key], w.v); }
      });
    } catch (err) { STORE = before; throw err; }
    return out;
  },
};

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.httpErrorCode = true; }
}

const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') {
    return { apps: [1], initializeApp() {},
      firestore: Object.assign(() => fdb, {
        FieldValue: { serverTimestamp: () => TS, increment: INC, arrayUnion: (...v) => v, delete: () => null },
      }) };
  }
  if (request === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
  if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (request === 'firebase-functions/params') return { defineSecret: () => ({}) };
  if (request === './company-identity') return { COMPANY: {} };
  if (request.endsWith('workforce-identity')) return {
    _assertBusinessPermission: async (uid, businessId, perm) => {
      const m = Object.keys(STORE).filter((k) => k.indexOf('workspaceMemberships/') === 0)
        .map((k) => STORE[k])
        .find((x) => x.uid === uid && x.businessId === businessId && x.status === 'active');
      if (!m) throw new HttpsError('permission-denied', 'not a member');
      if (perm && !(m.permissions || []).includes(perm)) {
        throw new HttpsError('permission-denied', 'permission ' + perm + ' required');
      }
    } };
  return realLoad.apply(this, arguments);
};
const RE = require(path.join(ROOT, 'functions/pos-retail-engine.js'));
Module._load = realLoad;

const voidSale = RE.voidPOSSale;
const req = (uid, claims, data) => ({ auth: { uid, token: claims }, data });
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e.code || 'threw'; } };

/* Shop A owner is uid SHOP_A; Shop B owner is uid SHOP_B (sellers/{id} == owner uid). */
function reset() {
  STORE = {};
  STORE['posSales/SALE_B'] = { sellerId: 'SHOP_B', status: 'completed',
    items: [{ productId: 'P_B', qty: 3 }] };
  /* sellerUid — the field the served rule actually creates products with. The fixture used
     sellerId, so the ownership control passed against a shape production does not have. */
  STORE['products/P_B'] = { sellerUid: 'SHOP_B', stock: 10, soldCount: 3 };
  STORE['posSales/SALE_A'] = { sellerId: 'SHOP_A', status: 'completed',
    items: [{ productId: 'P_A1', qty: 2 }, { productId: 'P_A2', qty: 5 }] };
  STORE['products/P_A1'] = { sellerUid: 'SHOP_A', stock: 4, soldCount: 2 };
  STORE['products/P_A2'] = { sellerUid: 'SHOP_A', stock: 1, soldCount: 5 };
}
const MGR_A   = { posRole: 'manager' };
const ADMIN   = { admin: true, posRole: 'manager' };

console.log(NL + 'voidPOSSale — TENANT BINDING + ATOMICITY' + NL + '='.repeat(62));

(async function main () {

/* ── 0 · harness controls ─────────────────────────────────────────────────── */
head('0 · CONTROLS on the harness');
ck('the handler loaded', typeof voidSale === 'function');
reset();
ck('CONTROL the fake applies increments',
   (await (async () => { await fdb.runTransaction(async (t) => {
      t.update(makeRef('products', 'P_A1'), { stock: INC(7) }); }); return STORE['products/P_A1'].stock; })()) === 11,
   'if increments were ignored, every restoration assertion would be vacuous');
reset();
ck('CONTROL a throwing transaction commits NOTHING',
   (await (async () => {
      try { await fdb.runTransaction(async (t) => {
        t.update(makeRef('products', 'P_A1'), { stock: INC(99) });
        throw new Error('boom'); }); } catch (_) {}
      return STORE['products/P_A1'].stock; })()) === 4,
   'this is what makes the atomicity assertions mean anything');

/* ── 1 · the cross-shop attack ────────────────────────────────────────────── */
head('1 · Shop A manager attempts to void a Shop B sale');
reset();
const denied = await caught(() => voidSale(req('SHOP_A', MGR_A, { saleId: 'SALE_B', reason: 'test' })));
ck('NEGATIVE the void is DENIED', denied === 'permission-denied', denied);
ck('...Shop B sale is UNCHANGED', STORE['posSales/SALE_B'].status === 'completed');
ck('...Shop B stock is UNCHANGED', STORE['products/P_B'].stock === 10,
   'the old code would have incremented another merchant inventory to 13');
ck('...Shop B soldCount is UNCHANGED', STORE['products/P_B'].soldCount === 3);
ck('...and NO audit row was written',
   Object.keys(STORE).filter((k) => k.indexOf('posAuditLog/') === 0).length === 0);

/* ── 2 · the legitimate void ──────────────────────────────────────────────── */
head('2 · Shop A owner voids their own sale');
reset();
const ok = await caught(() => voidSale(req('SHOP_A', MGR_A, { saleId: 'SALE_A', reason: 'customer changed mind' })));
ck('POSITIVE the void SUCCEEDS', ok === null, ok);
ck('...the sale is voided', STORE['posSales/SALE_A'].status === 'voided');
ck('...it records who voided it', STORE['posSales/SALE_A'].voidedBy === 'SHOP_A');
ck('...stock is restored on item 1', STORE['products/P_A1'].stock === 6, '4 + 2');
ck('...stock is restored on item 2', STORE['products/P_A2'].stock === 6, '1 + 5');
ck('...soldCount is decremented', STORE['products/P_A1'].soldCount === 0 &&
   STORE['products/P_A2'].soldCount === 0);
ck('...an audit row was written IN the same commit',
   Object.keys(STORE).filter((k) => k.indexOf('posAuditLog/') === 0).length === 1);
ck('CONTROL admin may still void across shops',
   (function () { reset(); return true; })() &&
   (await caught(() => voidSale(req('PLATFORM_ADMIN', ADMIN, { saleId: 'SALE_B', reason: 'support' })))) === null,
   'the deliberate exception, and the only one');

/* ── 3 · atomicity ────────────────────────────────────────────────────────── */
head('3 · a failed restoration voids NOTHING');
reset();
delete STORE['products/P_A2'];          /* second item vanished */
const partial = await caught(() => voidSale(req('SHOP_A', MGR_A, { saleId: 'SALE_A', reason: 'x' })));
ck('NEGATIVE the void FAILS when a product cannot be restored',
   partial === 'failed-precondition', partial);
ck('...the sale is NOT voided', STORE['posSales/SALE_A'].status === 'completed',
   'the old code voided first, then swallowed the restore failure');
ck('...the FIRST product stock is untouched too', STORE['products/P_A1'].stock === 4,
   'a partial restore is the defect, not a lesser success');
ck('...and the failure is REPORTED, never a success', partial !== null);

head('3a · a COMMIT-TIME write failure rolls the whole void back');
/* Section 3 proves the pre-flight validation. This proves the TRANSACTION: the failure
   happens during the write phase, after every check has passed, which is the only thing
   that distinguishes runTransaction from a sequence of updates. */
reset();
FAIL_WRITE_ON = 'products/P_A2';
const midFail = await caught(() => voidSale(req('SHOP_A', MGR_A, { saleId: 'SALE_A', reason: 'x' })));
FAIL_WRITE_ON = null;
ck('NEGATIVE the call FAILS when a write fails mid-commit', midFail !== null, midFail);
ck('...the sale is NOT left voided', STORE['posSales/SALE_A'].status === 'completed',
   'a void outside the transaction would survive the rollback');
ck('...the FIRST product stock rolled back too', STORE['products/P_A1'].stock === 4);
ck('...and no audit row survived',
   Object.keys(STORE).filter((k) => k.indexOf('posAuditLog/') === 0).length === 0);

head('3b · stock is never restored into another shop product');
reset();
STORE['products/P_A1'].sellerUid = 'SHOP_B';   /* mislinked item */
const mislinked = await caught(() => voidSale(req('SHOP_A', MGR_A, { saleId: 'SALE_A', reason: 'x' })));
ck('NEGATIVE the void is refused', mislinked === 'failed-precondition', mislinked);
ck('...and that other shop stock is untouched', STORE['products/P_A1'].stock === 4);

/* ── 4 · the pre-existing guards still hold ───────────────────────────────── */
head('4 · unchanged behaviour');
reset();
ck('a caller with no manager claim is refused',
   (await caught(() => voidSale(req('SHOP_A', { posRole: 'cashier' },
     { saleId: 'SALE_A', reason: 'x' })))) === 'permission-denied');
reset();
STORE['posSales/SALE_A'].status = 'voided';
ck('an already-voided sale is refused',
   (await caught(() => voidSale(req('SHOP_A', MGR_A, { saleId: 'SALE_A', reason: 'x' })))) === 'already-exists');
reset();
ck('a missing sale is refused',
   (await caught(() => voidSale(req('SHOP_A', MGR_A, { saleId: 'NOPE', reason: 'x' })))) === 'not-found');
ck('a missing reason is still refused',
   (await caught(() => voidSale(req('SHOP_A', MGR_A, { saleId: 'SALE_A' })))) === 'invalid-argument');

/* ── 4b · EMPLOYEE AUTHORITY ──────────────────────────────────────────────── */
head('4b · a legitimate employee may void; nobody else may');
const MCH_A = 'MCH-AAAA', MCH_B = 'MCH-BBBB';
const EMP = { posRole: 'manager' };
function seedEmployees () {
  reset();
  STORE['businesses/' + MCH_A] = { merchantId: MCH_A, ownerId: 'SHOP_A', status: 'active' };
  STORE['businesses/' + MCH_B] = { merchantId: MCH_B, ownerId: 'SHOP_B', status: 'active' };
  STORE['workspaceMemberships/m1'] = { uid: 'EMP_A', businessId: MCH_A, status: 'active',
    permissions: ['pos', 'refunds'] };
  STORE['workspaceMemberships/m2'] = { uid: 'EMP_B', businessId: MCH_B, status: 'active',
    permissions: ['pos', 'refunds'] };
  STORE['workspaceMemberships/m3'] = { uid: 'EMP_NOCAP', businessId: MCH_A, status: 'active',
    permissions: ['pos'] };
  STORE['workspaceMemberships/m4'] = { uid: 'EMP_LEFT', businessId: MCH_A, status: 'inactive',
    permissions: ['pos', 'refunds'] };
}
seedEmployees();
ck('POSITIVE a same-merchant employee with the capability CAN void',
   (await caught(() => voidSale(req('EMP_A', EMP, { saleId: 'SALE_A', reason: 'r' })))) === null,
   'Priority 7 denied this; the convergence restores it');
ck('...and the sale is voided', STORE['posSales/SALE_A'].status === 'voided');
ck('...and stock was restored', STORE['products/P_A1'].stock === 6);
seedEmployees();
ck('NEGATIVE an employee of ANOTHER merchant is denied',
   (await caught(() => voidSale(req('EMP_B', EMP, { saleId: 'SALE_A', reason: 'r' })))) === 'permission-denied');
ck('...and Shop A sale is untouched', STORE['posSales/SALE_A'].status === 'completed');
seedEmployees();
ck('NEGATIVE an employee WITHOUT the capability is denied',
   (await caught(() => voidSale(req('EMP_NOCAP', EMP, { saleId: 'SALE_A', reason: 'r' })))) === 'permission-denied',
   'membership alone is not authority');
seedEmployees();
ck('NEGATIVE a former employee (inactive) is denied',
   (await caught(() => voidSale(req('EMP_LEFT', EMP, { saleId: 'SALE_A', reason: 'r' })))) === 'permission-denied');
seedEmployees();
ck('NEGATIVE an ordinary authenticated user is denied by the ROLE gate',
   (await caught(() => voidSale(req('EMP_A', { posRole: 'cashier' }, { saleId: 'SALE_A', reason: 'r' })))) === 'permission-denied',
   'cashier holds refunds in ROLE_PERMISSIONS, so the claim gate must remain');
seedEmployees();
ck('NEGATIVE a forged merchant id in the payload is ignored',
   (await caught(() => voidSale(req('EMP_B', EMP,
     { saleId: 'SALE_A', reason: 'r', merchantId: MCH_A, sellerId: 'SHOP_A' })))) === 'permission-denied',
   'the merchant is resolved from the SALE, never from the request');
seedEmployees();
ck('CONTROL the owner path still works unchanged',
   (await caught(() => voidSale(req('SHOP_A', MGR_A, { saleId: 'SALE_A', reason: 'r' })))) === null);
seedEmployees();
ck('CONTROL admin still crosses shops',
   (await caught(() => voidSale(req('PLATFORM_ADMIN', ADMIN, { saleId: 'SALE_B', reason: 'r' })))) === null);
seedEmployees();
delete STORE['businesses/' + MCH_A];
ck('NEGATIVE no canonical merchant for the sale shop = refused, not loosened',
   (await caught(() => voidSale(req('EMP_A', EMP, { saleId: 'SALE_A', reason: 'r' })))) === 'permission-denied');

head('4c · the P7 guarantees are intact');
const RE_SRC = require('fs').readFileSync(require('path').join(ROOT, 'functions/pos-retail-engine.js'), 'utf8');
const VOID_FN = RE_SRC.slice(RE_SRC.indexOf('exports.voidPOSSale = onCall'),
                             RE_SRC.indexOf('C. RECEIPT ENGINE'));
ck('CONTROL the handler was isolated', VOID_FN.length > 1500, VOID_FN.length + ' chars');
ck('authorization happens BEFORE the transaction',
   VOID_FN.indexOf('_assertBusinessPermission') < VOID_FN.indexOf('runTransaction'),
   'a transaction read must go through txn.get, so the capability engine cannot run inside it');
ck('the transaction still re-checks the tenant (TOCTOU)',
   VOID_FN.indexOf('sale.sellerId !== authorizedSellerId') > -1);
ck('the void is still atomic', VOID_FN.indexOf('runTransaction') > -1 &&
   VOID_FN.indexOf("posAuditLog") > -1);
/* Asserted by source, scoped to the handler. Behaviourally the refusal is shadowed:
   with it removed, _assertBusinessPermission is called with an undefined merchantId and
   denies anyway — so the sabotage produced zero failures. Defence in depth is good; a
   control that cannot see one of the layers is not. */
ck('an unresolvable merchant is REFUSED explicitly, not left to the next check',
   VOID_FN.indexOf('if (!owned.ok) {') > -1 &&
   VOID_FN.indexOf('You can only void sales belonging to your own shop.') > -1);
ck('...and a sale with no shop recorded is refused too',
   VOID_FN.indexOf('This sale has no shop recorded') > -1);
ck('NEGATIVE no client-supplied merchant is read anywhere in the handler',
   VOID_FN.indexOf('data.merchantId') === -1 && VOID_FN.indexOf('data.sellerId') === -1,
   'scoped to voidPOSSale');

/* ── 5 · boundary ─────────────────────────────────────────────────────────── */
head('5 · what this does NOT do');
un('an EMPLOYEE manager can void', 'DELIBERATELY DENIED — no employee store may be chosen here; awaits convergence');
un('approval is consumed by the void', 'the primitive exists; wiring it is downstream of the authority decision');
un('real Firestore transaction semantics', 'the harness buffers writes; contention needs the emulator');
un('the PIN is removable', 'unchanged by this slice');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: executed against an in-memory Firestore, not production.');
})().then(() => {
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(NL + '  HARNESS ERROR: ' + (e && e.stack || e)); process.exit(2); });
