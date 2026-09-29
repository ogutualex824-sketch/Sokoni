/* test-loyalty-dispatch-guard.js — 2026-09-29 security: loyaltyDispatch is an ALLOW-LIST, not a router.
 *
 * Found in the till-points census: the deployed loyaltyDispatch routed ANY op to its handler, and several handlers are
 * server internals that trust their payload — awardLoyaltyPoints (auth only: any signed-in user could credit
 * unlimited points to any uid), awardCashback / loyaltyCheckoutOrchestrate / enterLuckyDraw / trackReferral /
 * issueGiftCard / joinLoyaltyNetwork (NO auth at all), and "customer" reads that take the uid from the payload.
 *
 * REAL functions/loyalty-dispatch.js with the REAL loyalty.js + loyalty-enterprise.js handlers, over the fake
 * Firestore. The shop-access authority is stubbed with a fixed table (owner / manager / cashier / stranger).
 *
 * PROVES
 *   LG1 every registered handler has an explicit policy; an op without one could never be reached
 *   LG2 the MINT is closed: a signed-in stranger calling awardLoyaltyPoints / awardCashback / loyaltyCheckoutOrchestrate
 *       for another uid is refused and NO loyalty account, ledger row or cashback is written
 *   LG3 an unknown op is refused WITHOUT listing the valid ops (the old error enumerated them all)
 *   LG4 customer ops act on the CALLER: a payload naming another uid (or a phone / loyaltyId) reads the caller's own
 *   LG5 merchant ops: the caller's own id, a shop they own or manage, or an admin → allowed; another shop, a
 *       cashier, or no merchantId → refused (the merchant ID typed into loyalty-merchant.html is checked)
 *   LG6 admin ops need the admin claim; lookupLoyaltyCustomer answers a merchant with MASKED phones only
 *
 *   node scripts/test-loyalty-dispatch-guard.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-loyalty-guard';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 300) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({ getUser: async () => ({ customClaims: {} }) }), messaging: () => ({ send: async () => ({}) }) };
/* the shop-access table the stub answers from */
const ACCESS = { 'mgrB|shopA': 'manager', 'cashC|shopA': 'cashier', 'ownerA|shopA': 'owner' };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/logger' || id === 'firebase-functions') return { logger: { info() {}, warn() {}, error() {} }, info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'test-secret' }), defineString: (n) => ({ value: () => '' }) };
  if (id === './shop-employees') return { resolveShopAccess: async (uid, shopId) => { const r = ACCESS[uid + '|' + shopId]; if (!r) throw new HttpsError('permission-denied', 'no access'); return { role: r }; }, capabilitiesForRole: () => [] };
  return origReq.apply(this, arguments);
};
let D, L, E;
try { D = require(path.join(FN, 'loyalty-dispatch.js')); L = require(path.join(FN, 'loyalty.js')); E = require(path.join(FN, 'loyalty-enterprise.js')); } catch (e) { D = { __err: e.message }; }
const call = (op, data, auth) => Promise.resolve().then(() => D.loyaltyDispatch({ data: Object.assign({ op }, data || {}), auth })).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code, msg: e.message }));
const au = (uid, token) => ({ uid, token: token || {} });
const count = async (c) => (await db.collection(c).get()).docs.length;

(async () => {
  if (typeof D.loyaltyDispatch !== 'function' || !D._policy) { ck('LG0 the guarded dispatcher loads', false, D.__err || '_policy missing'); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  const P = D._policy.POLICY;

  /* LG1 */
  const handlers = Object.keys(Object.assign({}, L._h || {}, E._h || {}));
  const missing = handlers.filter((h) => !P[h]);
  ck('LG1 every registered handler has an explicit policy', handlers.length >= 40 && missing.length === 0, { handlers: handlers.length, missing });

  /* LG2 — the mint */
  const stranger = au('mallory');
  const a = await call('awardLoyaltyPoints', { customerUid: 'mallory', amountKES: 1000000, orderId: 'x1', merchantId: 'shopA' }, stranger);
  const b = await call('awardCashback', { uid: 'mallory', amount: 50000, merchantId: 'shopA', orderId: 'x2' }, stranger);
  const c = await call('loyaltyCheckoutOrchestrate', { uid: 'victim', phone: '+254700000000', merchantId: 'shopA', total: 99999 }, stranger);
  const d2 = await call('awardLoyaltyPoints', { customerUid: 'mallory', amountKES: 1000, orderId: 'x3', merchantId: 'shopA' }, au('ownerA', { role: 'merchant', seller: true }));
  const writes = { acc: await count('loyaltyAccounts'), ledger: await count('loyaltyLedger'), cash: await count('loyaltyCashbackLedger') };
  ck('LG2 the MINT is closed: award / cashback / orchestrate refused for a stranger AND a merchant; nothing written',
    [a, b, c, d2].every((x) => !x.ok && x.code === 'permission-denied') && writes.acc === 0 && writes.ledger === 0 && writes.cash === 0,
    { a: a.code, b: b.code, c: c.code, merchantAward: d2.code, writes });

  /* LG3 */
  const u = await call('stealEverything', {}, stranger);
  ck('LG3 an unknown op is refused without listing the valid ops', !u.ok && u.code === 'not-found' && !/awardLoyaltyPoints|getLoyaltyAccount|Valid ops/.test(u.msg), u);

  /* LG4 — customer ops act on the caller */
  let seen = null;
  const origGet = (L._h || {}).getLoyaltyAccount;
  L._h.getLoyaltyAccount = async (req) => { seen = req.data; return { ok: true }; };
  const D2 = (() => { delete require.cache[require.resolve(path.join(FN, 'loyalty-dispatch.js'))]; return require(path.join(FN, 'loyalty-dispatch.js')); })();
  await Promise.resolve(D2.loyaltyDispatch({ data: { op: 'getLoyaltyAccount', uid: 'victim', customerUid: 'victim', phone: '+254711111111', loyaltyId: 'L1' }, auth: au('alice') })).catch(() => {});
  L._h.getLoyaltyAccount = origGet;
  const unauth = await call('getLoyaltyAccount', {}, null);
  ck('LG4 customer ops act on the CALLER: another uid / phone / loyaltyId in the payload is replaced or dropped; signed-out refused',
    seen && seen.uid === 'alice' && !('customerUid' in seen) && !('phone' in seen) && !('loyaltyId' in seen) && !unauth.ok && unauth.code === 'unauthenticated', { seen, unauth: unauth.code });

  /* LG5 — merchant scope */
  const g = D._policy.assertMerchantScope;
  const m = async (uid, mid, token) => g({ auth: au(uid, token), data: mid === undefined ? {} : { merchantId: mid } }).then(() => 'ok', (e) => e.code);
  const r5 = { ownId: await m('shopA', 'shopA'), owner: await m('ownerA', 'shopA'), manager: await m('mgrB', 'shopA'), admin: await m('root', 'shopZ', { admin: true }),
    cashier: await m('cashC', 'shopA'), stranger: await m('mallory', 'shopA'), none: await m('ownerA', undefined), pathy: await m('mallory', 'shopA/x') };
  ck('LG5 merchant ops: own id / owner / manager / admin allowed; cashier, another shop, no id, path-shaped id refused',
    r5.ownId === 'ok' && r5.owner === 'ok' && r5.manager === 'ok' && r5.admin === 'ok' && r5.cashier === 'permission-denied'
    && r5.stranger === 'permission-denied' && r5.none === 'invalid-argument' && r5.pathy === 'permission-denied', r5);

  /* LG6 — admin ops; masked lookup */
  const adm = await call('adminAdjustPoints', { uid: 'x', delta: 100 }, au('mallory', { role: 'merchant' }));
  const masked = D._policy.maskPhones({ found: true, customer: { name: 'Jane', phone: '+254712345678', nested: { mobilePhone: '0712 345 678' } } });
  ck('LG6 admin ops need the admin claim; a merchant lookup sees only the last 3 digits of a phone',
    !adm.ok && adm.code === 'permission-denied' && masked.customer.phone === '••••678' && masked.customer.nested.mobilePhone === '••••678' && masked.customer.name === 'Jane',
    { adm: adm.code, masked });

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
