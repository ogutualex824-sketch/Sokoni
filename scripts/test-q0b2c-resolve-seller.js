'use strict';
/**
 * CERTIFICATION — Q0b-2c: pos-crm-pro `_resolveSellerId` — a CRM call acts only for the caller's own store
 * (or, for an admin, a store the admin names).
 *
 * Runs the REAL handlers (`_h`, the ones smartPosDispatch routes to) against the Firestore EMULATOR. Pointed at
 * the pre-2c tree (REPAIR_ROOT = export of 1cbd12f) a caller naming another store must be served as that store;
 * on this tree every one of the 23 resolver handlers must refuse it FIRST — before any read or write — while the
 * caller's own store and an admin's named store still work.
 *
 *   I  the cross-handler invariant: all 23 handlers refuse a forged seller for the resolver's stated reason
 *   M  money-moving handlers (deductWallet, redeemGiftCard, useStoreCredit): forged attempts leave the victim's
 *      records BYTE-UNCHANGED (data and updateTime) and write nothing; the caller's own operations still work
 *   A  own / admin / malformed resolution
 *   P  PARITY with pos-retail-engine's _boundSellerId admin set, token shape by token shape
 *
 * The manager-gated handlers read a `posRole` claim that NOTHING mints; the test puts `posRole: 'manager'` in the
 * token only so those handlers REACH the resolver — it is not evidence the gate works in production.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-q0b2c';
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 240s\n'); process.exit(3); }, 240000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr),
  cw: console.warn, ce: console.error, cl: console.log };
async function quiet(fn) {
  process.stdout.write = () => true; process.stderr.write = () => true; console.warn = () => {}; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { process.stdout.write = _REAL.so; process.stderr.write = _REAL.se; console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl; }
}

let CRM, PRE;
try { CRM = require(path.join(FN, 'pos-crm-pro.js')); PRE = require(path.join(FN, 'pos-retail-engine.js')); }
catch (e) { process.stdout.write('  ✖ SETUP — ' + e.message + '\n'); process.exit(2); }

const A = 'q2c-a', B = 'q2c-b', PH = '254711000001';
const MGR = { posRole: 'manager' };                         /* reaches the (dead) manager gate — see header */
const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));
const call = (name, uid, token, data) => res(quiet(() => CRM._h[name]({ data, auth: uid ? { uid, token: Object.assign({ uid }, token || {}) } : null })));
const why = (r) => (r.ok ? 'SERVED ' + JSON.stringify(r.out).slice(0, 50) : 'refused [' + r.code + ']: ' + r.msg.slice(0, 55));
const RESOLVER = /sellerId does not match your account/;
const byResolver = (r) => !r.ok && r.code === 'permission-denied' && RESOLVER.test(r.msg);
const fingerprint = async (p) => { const s = await db.doc(p).get(); return s.exists ? JSON.stringify(s.data()) + '@' + s.updateTime.toMillis() : 'ABSENT'; };
const count = async (c) => (await db.collection(c).get()).size;

/* every resolver handler, with a complete payload so that — where a store IS resolved — it gets past validation */
const HANDLERS = [
  ['posGetWalletBalance', { phone: PH }], ['topUpWallet', { phone: PH, amount: 10, method: 'cash' }],
  ['deductWallet', { phone: PH, amount: 10, saleId: 'q2c-s1' }], ['posRefundToWallet', { phone: PH, amount: 10 }],
  ['posGetWalletTransactions', { phone: PH }], ['issueGiftCard', { amount: 10 }],
  ['redeemGiftCard', { code: 'GC-B', amount: 10, saleId: 'q2c-s2' }], ['getGiftCards', {}],
  ['issueStoreCredit', { phone: PH, amount: 10, reason: 'r' }], ['useStoreCredit', { phone: PH, amount: 10, saleId: 'q2c-s3' }],
  ['getStoreCreditBalance', { phone: PH }], ['checkBirthdayReward', { phone: PH }], ['getBirthdayCustomers', {}],
  ['recordReferral', { referrerPhone: PH, referredPhone: '254711000002' }], ['completeReferralReward', { referredPhone: '254711000002', saleId: 'q2c-s4' }],
  ['getReferralStats', { phone: PH }], ['createOffer', { name: 'o', offerType: 'percent_discount', value: 5, eligibility: 'all' }],
  ['getActiveOffers', {}], ['getOffers', {}], ['getCustomerSegments', {}], ['getCustomerInsights', { phone: PH }],
  ['upgradeMembershipTier', { phone: PH, newTier: 'gold', reason: 'r' }], ['getMembershipStats', {}],
];

(async () => {
  process.stdout.write(`\nQ0b-2c — _resolveSellerId   (tree: ${ROOT})\n\n`);
  const set = (p, d) => db.doc(p).set(d);
  /* B's money records — the victims. Gift cards in the shape issueGiftCard writes (amount / remaining / status). */
  await set(`posWallets/${B}_${PH}`, { sellerId: B, phone: PH, balance: 500 });
  await set('posGiftCards/GC-B', { sellerId: B, code: 'GC-B', amount: 1000, remaining: 1000, status: 'active', redemptions: [] });
  await set(`posCustomers/${B}_${PH}`, { sellerId: B, phone: PH, name: 'B customer', storeCredit: 300, loyaltyPoints: 40 });
  /* A's own records — the controls */
  await set(`posWallets/${A}_${PH}`, { sellerId: A, phone: PH, balance: 500 });
  await set('posGiftCards/GC-A', { sellerId: A, code: 'GC-A', amount: 1000, remaining: 1000, status: 'active', redemptions: [] });
  await set(`posCustomers/${A}_${PH}`, { sellerId: A, phone: PH, name: 'A customer', storeCredit: 300, loyaltyPoints: 40 });
  const VICTIMS = [`posWallets/${B}_${PH}`, 'posGiftCards/GC-B', `posCustomers/${B}_${PH}`];

  process.stdout.write('[I] every one of the 23 resolver handlers refuses a forged store FIRST\n');
  const before = {}; for (const v of VICTIMS) before[v] = await fingerprint(v);
  const c0 = { tx: await count('posWalletTransactions'), sc: await count('posStoreCreditLog'), ref: await count('posReferrals'), off: await count('posOffers'), gc: await count('posGiftCards'), tier: await count('posTierUpgradeLog') };
  const notRefused = [];
  for (const [name, data] of HANDLERS) {
    const r = await call(name, A, MGR, Object.assign({ sellerId: B }, data));
    if (!byResolver(r)) notRefused.push(name + ' → ' + why(r));
  }
  ok(notRefused.length === 0, 'I-1', `all ${HANDLERS.length} handlers refuse A naming B, for the resolver's reason: ` + (notRefused.length ? notRefused.slice(0, 3).join(' ; ') + (notRefused.length > 3 ? ` (+${notRefused.length - 3} more)` : '') : 'every one refused'));
  const unchanged = [];
  for (const v of VICTIMS) if ((await fingerprint(v)) !== before[v]) unchanged.push(v);
  const c1 = { tx: await count('posWalletTransactions'), sc: await count('posStoreCreditLog'), ref: await count('posReferrals'), off: await count('posOffers'), gc: await count('posGiftCards'), tier: await count('posTierUpgradeLog') };
  ok(unchanged.length === 0 && JSON.stringify(c0) === JSON.stringify(c1), 'I-2',
    "across all 23 forged calls, B's wallet, gift card and customer are BYTE-UNCHANGED and no log/transaction/offer/card/referral was written: " + (unchanged.join(',') || 'unchanged') + ' ' + JSON.stringify(c1));
  ok(HANDLERS.length === 23 && Object.keys(CRM._h).length === 25, 'I-3', `the invariant covers every resolver handler (${HANDLERS.length} of the ${Object.keys(CRM._h).length} _h handlers; the other two — toggleOffer (auth.uid) and checkGiftCardBalance (code only) — take no seller)`);

  process.stdout.write('\n[M] money-moving handlers — the caller\'s own store still works; another store\'s cannot be touched\n');
  { const r = await call('deductWallet', A, {}, { phone: PH, amount: 100, saleId: 'q2c-own-1' });
    ok(r.ok && (await db.doc(`posWallets/${A}_${PH}`).get()).data().balance === 400, 'M-1', 'A deducts from ITS OWN customer wallet (no seller named): ' + why(r)); }
  { const r = await call('redeemGiftCard', A, {}, { code: 'GC-A', amount: 100, saleId: 'q2c-own-2' });
    ok(r.ok && (await db.doc('posGiftCards/GC-A').get()).data().remaining === 900, 'M-2', 'A redeems ITS OWN gift card: ' + why(r)); }
  { const r = await call('useStoreCredit', A, {}, { phone: PH, amount: 100, saleId: 'q2c-own-3' });
    ok(r.ok && (await db.doc(`posCustomers/${A}_${PH}`).get()).data().storeCredit === 200, 'M-3', "A uses ITS OWN customer's store credit: " + why(r)); }
  { const b = await fingerprint('posGiftCards/GC-B');
    const r = await call('redeemGiftCard', A, {}, { code: 'GC-B', amount: 100, saleId: 'q2c-x-1' });
    ok(!r.ok && (await fingerprint('posGiftCards/GC-B')) === b, 'M-4', "A (store bound to itself) presents B's gift card CODE → refused by the card's own seller check, card byte-unchanged: " + why(r)); }
  { const b = await fingerprint(`posWallets/${B}_${PH}`);
    const r = await call('deductWallet', A, {}, { sellerId: B, phone: PH, amount: 100, saleId: 'q2c-x-2' });
    ok(byResolver(r) && (await fingerprint(`posWallets/${B}_${PH}`)) === b, 'M-5', "forged deductWallet on B's wallet (no manager token needed) → refused, byte-unchanged: " + why(r)); }

  process.stdout.write('\n[A] resolution: own, admin, malformed\n');
  { const r = await call('getStoreCreditBalance', A, {}, { sellerId: A, phone: PH });
    ok(r.ok, 'A-1', 'A naming ITSELF is allowed: ' + why(r)); }
  { const r = await call('getStoreCreditBalance', 'q2c-admin', { admin: true }, { sellerId: B, phone: PH });
    ok(r.ok && JSON.stringify(r.out).indexOf('300') !== -1, 'A-2', "an ADMIN naming B reads B's store (the existing admin authority): " + why(r)); }
  for (const [id, bad] of [['A-3', { x: 1 }], ['A-4', 'b/../x'], ['A-5', 'x'.repeat(200)]]) {
    const r = await call('getStoreCreditBalance', A, {}, { sellerId: bad, phone: PH });
    ok(!r.ok && r.code === 'invalid-argument', id, 'a malformed sellerId (' + (typeof bad === 'string' ? bad.slice(0, 12) : 'object') + ') is a bad request: ' + why(r));
  }
  { const r = await call('getStoreCreditBalance', A, { sellerId: A }, { sellerId: B, phone: PH });
    ok(byResolver(r), 'A-6', 'the CLAIM branch is kept: a sellerId claim with a request naming another store is refused: ' + why(r)); }

  { const r = await call('getStoreCreditBalance', 'q2c-staff', { sellerId: A }, { phone: PH });
    ok(r.ok && JSON.stringify(r.out).indexOf('200') !== -1, 'A-7',
      "the CLAIM branch is kept: a caller whose sellerId claim names store A (not its own uid) acts for A — pins the branch; no such claim is minted in production: " + why(r)); }

  process.stdout.write('\n[P] parity with pos-retail-engine _boundSellerId, token shape by token shape\n');
  const SHAPES = [['admin:true', { admin: true }], ["role:'admin'", { role: 'admin' }], ['superAdmin:true', { superAdmin: true }], ["role:'super_admin'", { role: 'super_admin' }],
    ['(none)', {}], ["role:'seller'", { role: 'seller' }], ["posRole:'owner'", { posRole: 'owner' }]];
  const mismatch = [];
  for (const [label, t] of SHAPES) {
    const tok = Object.assign({ sellerVerified: true }, t);           /* so _adminOrSeller admits every shape */
    const crm = await call('getStoreCreditBalance', 'q2c-p', tok, { sellerId: B, phone: PH });
    /* LINEAGE NOTE (L-2 port onto the POS lineage, 2026-09-28): on the Q line getPOSCustomer binds through
       _boundSellerId (Q0b-1). On THIS lineage getPOSCustomer is still the unscoped lookup (Q0b-1 is reconciliation
       unit L-4), so it cannot stand in for _boundSellerId here. getInventoryAlerts binds through the SAME
       _boundSellerId on this lineage, so it is the parity partner; the property is unchanged. */
    const rtl = await res(quiet(() => PRE._h.getInventoryAlerts({ data: { sellerId: B }, auth: { uid: 'q2c-p', token: Object.assign({ uid: 'q2c-p' }, tok) } })));
    const crmAllows = !byResolver(crm), rtlAllows = !(!rtl.ok && /own shop/.test(rtl.msg));
    if (crmAllows !== rtlAllows) mismatch.push(label + ' crm=' + crmAllows + ' retail=' + rtlAllows);
  }
  ok(mismatch.length === 0, 'P-1', 'the resolver and _boundSellerId give the SAME answer for all ' + SHAPES.length + ' token shapes (4 admin, 3 not): ' + (mismatch.join('; ') || 'identical'));

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
