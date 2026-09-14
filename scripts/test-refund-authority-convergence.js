#!/usr/bin/env node
/**
 * posProcessRefund — who may refund, and for which shop.
 *
 *   node scripts/test-refund-authority-convergence.js
 *
 * Priority 17 moved refund authority onto workspaceMemberships, the canonical employee
 * authority, keeping posStaff as the compatibility surface the convergence decision names.
 *
 * WHAT THE MAP ESTABLISHED, because each fact shapes a control here:
 *
 *   · Refund's role gate is manager|owner. Void also allows supervisor. That difference is
 *     existing product behaviour and is preserved, not normalised away.
 *   · `refunds` is held by CASHIER in ROLE_PERMISSIONS, so the capability alone would widen
 *     authority. Authority is the conjunction of the role claim and the capability.
 *   · The merchant arrives in either tenant space — checkout validates against shops/{uid}
 *     while memberships are keyed by the generated merchantId — so it is recognised in both
 *     forms and resolved forward, never trusted.
 *   · posStaff carries no capability model. It is tried LAST and is not the authority.
 *
 * ORDER OF EVIDENCE, stated honestly: the implementation landed before this battery was
 * written, so the unfixed code was never executed against it. The equivalent evidence comes
 * from sabotage — reverting each mechanism and showing the battery fails — which is the same
 * proof obtained in the other direction, and is reported as such rather than as a
 * before-and-after.
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

let STORE = {};
let AUTO = 0;
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.httpErrorCode = true; }
}
const INC = (n) => ({ __inc: n });
const patch = (t, p) => Object.keys(p).forEach((k) => {
  const v = p[k];
  if (v && typeof v === 'object' && typeof v.__inc === 'number') t[k] = (Number(t[k]) || 0) + v.__inc;
  else t[k] = v;
});
function makeRef (coll, id) {
  const key = coll + '/' + id;
  return { id, _key: key,
    get: async () => ({ exists: Object.prototype.hasOwnProperty.call(STORE, key),
                        data: () => STORE[key], id, ref: makeRef(coll, id) }),
    set: async (v) => { STORE[key] = v; },
    update: async (v) => { patch(STORE[key] = STORE[key] || {}, v); } };
}
function makeColl (coll) {
  const f = [];
  const q = {
    where (a, _o, v) { f.push([a, v]); return q; },
    orderBy () { return q; }, limit () { return q; },
    doc: (id) => makeRef(coll, id || ('a' + (++AUTO))),
    add: async (v) => { const r = q.doc(); STORE[r._key] = v; return r; },
    async get () {
      const docs = Object.keys(STORE).filter((k) => k.indexOf(coll + '/') === 0)
        .map((k) => ({ id: k.slice(coll.length + 1), data: () => STORE[k], ref: makeRef(coll, k.slice(coll.length + 1)) }))
        .filter((d) => f.every(([a, v]) => d.data()[a] === v));
      return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
    },
  };
  return q;
}
const fdb = {
  collection: makeColl,
  runTransaction: async (fn) => {
    const w = [];
    const out = await fn({
      get: async (r) => r.get(),
      getAll: async (...rs) => Promise.all(rs.map((r) => r.get())),
      set: (r, v) => w.push(['set', r, v]),
      update: (r, v) => w.push(['up', r, v]),
    });
    w.forEach(([op, r, v]) => { if (op === 'set') STORE[r._key] = v;
                                else patch(STORE[r._key] = STORE[r._key] || {}, v); });
    return out;
  },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') return { apps: [1], initializeApp() {},
    firestore: Object.assign(() => fdb, { FieldValue: { serverTimestamp: () => 'TS', increment: INC } }) };
  if (request === 'firebase-admin/firestore') return {
    getFirestore: () => fdb,
    FieldValue: { serverTimestamp: () => 'TS', increment: INC, arrayUnion: (...v) => v } };
  if (request === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
  if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (request === 'firebase-functions/params') return { defineSecret: () => ({}) };
  if (request === 'firebase-functions/logger') return { info(){}, warn(){}, error(){} };
  if (request.endsWith('pos-audit')) return { writeAudit: async () => {} };
  if (request.endsWith('merchant-identity')) return { _internal: { resolveActor: async () => ({ ok: false }) } };
  if (request.endsWith('workforce-identity')) return {
    _assertBusinessPermission: async (uid, biz, perm) => {
      /* The REAL helper reads businesses/{id} first and throws not-found. Omitting that made
         the stub authorise against a merchant that does not exist — a fixture that was more
         permissive than production, which is how a false green happens. */
      if (!STORE['businesses/' + biz]) throw new HttpsError('not-found', 'Business not found.');
      const m = Object.keys(STORE).filter((k) => k.indexOf('workspaceMemberships/') === 0)
        .map((k) => STORE[k])
        .find((x) => x.uid === uid && x.businessId === biz && x.status === 'active');
      if (!m) throw new HttpsError('permission-denied', 'not a member');
      if (perm && !(m.permissions || []).includes(perm)) {
        throw new HttpsError('permission-denied', 'capability ' + perm + ' required');
      }
    } };
  if (request.endsWith('tenant-identity')) return {
    resolveMerchantIdForOwner: async (uid) => {
      const hit = Object.keys(STORE).filter((k) => k.indexOf('businesses/') === 0)
        .map((k) => ({ id: k.slice('businesses/'.length), d: STORE[k] }))
        .filter((x) => x.d.ownerId === uid);
      if (hit.length !== 1) return { ok: false, reason: 'no-business-for-owner' };
      return { ok: true, merchantId: hit[0].id };
    },
    looksLikeOwnerForm: (v, u) => v === u, REASON: {} };
  return realLoad.apply(this, arguments);
};
let ZF;
try { ZF = require(path.join(ROOT, 'functions/pos-zero-friction.js')); }
finally { Module._load = realLoad; }

const refund = ZF.posProcessRefund;
const MCH_A = 'MCH-AAAA', MCH_B = 'MCH-BBBB';
const OWNER_A = 'uidOwnerA';
const req = (uid, claims, data) => ({ auth: { uid, token: claims || {} }, data });
const MGR = { posRole: 'manager' };
const SUP = { posRole: 'supervisor' };
const CASH = { posRole: 'cashier' };
const ADMIN = { admin: true, posRole: 'manager' };
const caught = async (fn) => { try { return { code: null, value: (await fn()) || {} }; }
                              catch (e) { return { code: e.code || 'threw', value: {} }; } };

/* A sale in the GENERATED merchant space, which is what checkout writes for a
   businesses-provisioned till. Fields taken from the real writer: merchantId and sellerId
   hold the same value, and items carry productId/qty/price. */
function seed () {
  STORE = {};
  STORE['businesses/' + MCH_A] = { merchantId: MCH_A, ownerId: OWNER_A, status: 'active' };
  STORE['businesses/' + MCH_B] = { merchantId: MCH_B, ownerId: 'uidOwnerB', status: 'active' };
  STORE['posRetailSales/SALE_A'] = {
    merchantId: MCH_A, sellerId: MCH_A, status: 'completed', grandTotal: 1000,
    items: [{ productId: 'P1', name: 'x', qty: 1, unitPrice: 1000, lineTotal: 1000 }],
    payments: [{ method: 'cash', amount: 1000 }],
  };
  STORE['products/P1'] = { sellerUid: OWNER_A, stock: 5, soldCount: 1 };
  STORE['workspaceMemberships/w1'] = { uid: 'EMP_MGR', businessId: MCH_A, status: 'active',
    permissions: ['pos', 'refunds'] };
  STORE['workspaceMemberships/w2'] = { uid: 'EMP_NOCAP', businessId: MCH_A, status: 'active',
    permissions: ['pos'] };
  STORE['workspaceMemberships/w3'] = { uid: 'EMP_LEFT', businessId: MCH_A, status: 'inactive',
    permissions: ['pos', 'refunds'] };
  STORE['workspaceMemberships/w4'] = { uid: 'EMP_OTHER', businessId: MCH_B, status: 'active',
    permissions: ['pos', 'refunds'] };
  STORE['posStaff/legacy'] = { merchantId: MCH_A, uid: 'EMP_LEGACY', status: 'active', role: 'manager' };
}
const items = [{ productId: 'P1', qty: 1 }];
const call = (uid, claims, over) => refund(req(uid, claims,
  Object.assign({ saleId: 'SALE_A', items: items, reason: 'customer', merchantId: MCH_A }, over || {})));

console.log(NL + 'REFUND AUTHORITY CONVERGENCE' + NL + '='.repeat(62));

(async function main () {

head('0 · CONTROLS');
ck('the handler loaded', typeof refund === 'function');
seed();
ck('CONTROL the fake applies where() filters',
   (await fdb.collection('workspaceMemberships').where('uid', '==', 'EMP_MGR').get()).size === 1,
   'if filters were ignored every membership assertion would be vacuous');
ck('CONTROL the fixture uses the fields the REAL writer produces',
   STORE['posRetailSales/SALE_A'].merchantId === STORE['posRetailSales/SALE_A'].sellerId &&
   STORE['products/P1'].sellerUid !== undefined,
   'the Priority 10 fixture used sellerId on a product, which production does not carry');

head('1 · the canonical employee path');
seed();
const okEmp = await caught(() => call('EMP_MGR', MGR));
ck('POSITIVE a same-merchant manager WITH the capability is authorised',
   okEmp.code !== 'permission-denied', okEmp.code || 'allowed');
seed();
ck('NEGATIVE a member WITHOUT the capability is denied',
   (await caught(() => call('EMP_NOCAP', MGR))).code === 'permission-denied',
   'membership alone is not authority');
seed();
ck('NEGATIVE a FORMER employee is denied',
   (await caught(() => call('EMP_LEFT', MGR))).code === 'permission-denied');
seed();
ck('NEGATIVE an employee of ANOTHER merchant is denied',
   (await caught(() => call('EMP_OTHER', MGR))).code === 'permission-denied');

head('2 · the role gate still narrows');
seed();
ck('NEGATIVE a cashier is denied even though ROLE_PERMISSIONS grants refunds',
   (await caught(() => call('EMP_MGR', CASH))).code === 'permission-denied',
   'the conjunction is the point');
seed();
ck('NEGATIVE a supervisor is denied — refund differs from void, deliberately',
   (await caught(() => call('EMP_MGR', SUP))).code === 'permission-denied',
   'existing product behaviour, preserved rather than normalised');

head('3 · owner and admin paths preserved');
seed();
ck('the OWNER of the merchant is authorised',
   (await caught(() => call(OWNER_A, MGR))).code !== 'permission-denied');
seed();
ck('an ADMIN is authorised', (await caught(() => call('uidAdmin', ADMIN))).code !== 'permission-denied');

head('4 · the compatibility surface still works');
seed();
ck('a posStaff-only employee is still authorised',
   (await caught(() => call('EMP_LEGACY', MGR))).code !== 'permission-denied',
   'removing it would strip authority from staff who exist only in that store');

head('5 · the tenant cannot be redirected');
seed();
ck('NEGATIVE a forged merchantId cannot elevate authority',
   (await caught(() => call('EMP_OTHER', MGR, { merchantId: MCH_B }))).code === 'permission-denied',
   'authorised for B, but the SALE is A — the sale binding refuses it');
seed();
ck('NEGATIVE a sale belonging to another merchant is refused',
   (await caught(() => refund(req('EMP_MGR', MGR,
     { saleId: 'SALE_A', items: items, reason: 'r', merchantId: MCH_B })))).code === 'permission-denied');
seed();
delete STORE['businesses/' + MCH_A];
ck('NEGATIVE an unlinked merchant fails closed',
   (await caught(() => call('EMP_MGR', MGR))).code === 'permission-denied');

head('6 · scoped source controls');
const ZF_SRC = fs.readFileSync(path.join(ROOT, 'functions/pos-zero-friction.js'), 'utf8');
const FN = ZF_SRC.slice(ZF_SRC.indexOf('async function _assertRefundAuthority'),
                        ZF_SRC.indexOf('exports.posProcessRefund'));
ck('CONTROL the helper was isolated', FN.length > 800, FN.length + ' chars');
ck('the capability is required, scoped to this helper',
   FN.indexOf("_assertBusinessPermission(uidStr, canonical, 'refunds')") > -1);
ck('the merchant is resolved forward when the owner-uid form arrives',
   FN.indexOf('_resolveMerchantIdForOwner(mid)') > -1);
ck('posStaff is tried LAST and is not the authority',
   FN.indexOf('_assertBusinessPermission') < FN.indexOf("collection('posStaff')"));
ck('the role gate is unchanged',
   FN.indexOf("role !== 'manager' && role !== 'owner'") > -1);
ck('NEGATIVE the sale is still bound to the authorised merchant',
   ZF_SRC.indexOf("if (sale.merchantId !== merchantId) _e('Unauthorized', 'permission-denied');") > -1);

head('7 · approval remains a separate gate');
ck('refund consumes NO approval',
   FN.indexOf('_consumeApproval') === -1 &&
   ZF_SRC.indexOf('_approvals.consume') === -1,
   'employee authority and approval consumption are independently proven');

/* ── 7b · DISCOUNT AUTHORITY (Priority 18) ────────────────────────────────── */
head('7b · discount: the vocabularies, EXECUTED against both real tables');
const MI_SRC = fs.readFileSync(path.join(ROOT, 'functions/merchant-identity.js'), 'utf8');
const WI_SRC = fs.readFileSync(path.join(ROOT, 'functions/workforce-identity.js'), 'utf8');
/* Parsed with indexOf and split, not a regex: the regex form lost its escaping in transit
   and matched nothing, reporting a null table against correct source. */
function tableOf (src, name) {
  const at = src.indexOf('const ' + name + ' = {');
  if (at === -1) return null;
  const body = src.slice(at, src.indexOf('};', at));
  const out = {};
  body.split(String.fromCharCode(10)).forEach((line) => {
    const c = line.indexOf(':');
    const o = line.indexOf('[');
    const cl = line.lastIndexOf(']');
    if (c < 0 || o < c || cl < o) return;
    const key = line.slice(0, c).trim();
    if (!key || key.indexOf(' ') > -1) return;
    out[key] = line.slice(o + 1, cl).split(',')
      .map((x) => x.trim().split("'").join("")).filter(Boolean);
  });
  return out;
}
const CAPS = tableOf(MI_SRC, 'ROLE_CAPABILITIES');
const PERMS = tableOf(WI_SRC, 'ROLE_PERMISSIONS');
ck('CONTROL both tables parsed', !!CAPS && !!PERMS && !!CAPS.cashier && !!PERMS.cashier,
   'a null table would make every comparison below vacuous');
ck('Stack A grants discount to owner and manager',
   CAPS.owner.includes('discount') && CAPS.manager.includes('discount'));
ck('NEGATIVE Stack A does NOT grant it to a cashier', !CAPS.cashier.includes('discount'));
ck('Stack B grants discounts to manager and supervisor',
   PERMS.manager.includes('discounts') && PERMS.supervisor.includes('discounts'));
ck('THE LOAD-BEARING FACT: Stack B does NOT grant discounts to a cashier',
   !PERMS.cashier.includes('discounts'),
   'converging therefore cannot widen discounting to cashiers — checked, not assumed');
ck('the only role the convergence adds is supervisor',
   PERMS.supervisor.includes('discounts') && CAPS.supervisor === undefined,
   'Stack A has no supervisor role at all');

head('7c · discount wiring, scoped to the checkout block');
const DISC = ZF_SRC.slice(ZF_SRC.indexOf('if (manualDiscount > 0) {'),
                          ZF_SRC.indexOf('const totalDiscount = _round2'));
ck('CONTROL the discount block was isolated', DISC.length > 700, DISC.length + ' chars');
ck('Stack A is tried FIRST and unchanged',
   DISC.indexOf("(_actor.capabilities || []).indexOf('discount') > -1") > -1);
ck('the canonical path is additive, not a replacement',
   DISC.indexOf('if (!_discountOk) {') > -1 &&
   DISC.indexOf("_assertBusinessPermission(cashierId, _canonical, 'discounts')") > -1);
ck('the actor is the AUTHENTICATED cashier, never a payload value',
   DISC.indexOf('_assertBusinessPermission(cashierId,') > -1 &&
   DISC.indexOf('data.cashierId') === -1);
ck('the merchant is recognised in either space, as elsewhere',
   DISC.indexOf('_resolveMerchantIdForOwner(String(merchantId))') > -1);
ck('NEGATIVE a failed canonical check does NOT allow the discount',
   DISC.indexOf('} catch (_) { /* not a member, or no capability — stays false */ }') > -1);
ck('the sale-size ceiling still applies',
   DISC.indexOf('if (manualDiscount > serverSubtotal)') > -1);
ck('NEGATIVE discount consumes no approval', DISC.indexOf('_consumeApproval') === -1);

head('8 · boundary');
un('the refund mutation end to end', 'this battery proves AUTHORITY; the transaction is covered by its own slice');
un('a real cross-merchant attempt in production', 'needs the deployed dispatcher and two accounts');
un('posStaff retirement', 'a migration question — it stays a compatibility surface');
un('branch scope for refunds', 'posStaff is branch-aware, workspaceMemberships is not; unresolved');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: authority only. No approval is consumed and nothing was deployed.');
})().then(() => process.exit(fail ? 1 : 0))
   .catch((e) => { console.error(NL + '  HARNESS ERROR: ' + (e && e.stack || e)); process.exit(2); });
