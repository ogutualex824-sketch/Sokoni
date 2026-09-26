/* test-refund-authority-matrix.js — R1–R8 against THIS branch's canonical refund
 * authority (owner decision 2026-09-26: keep financial-os — fosSubmitRefund ·
 * fosApproveRefund · fosResolveRefund · _executeRefund; the three-lineage
 * convergence is a merge task, docs/REFUND_AUTHORITY_CONVERGENCE.md).
 *
 * EXECUTED in-process: the REAL functions/financial-os.js and the REAL AdminOS
 * handler creator-hub.js creatorAdminRefundCases, on the transactional fake
 * Firestore, with a controllable fake gateway (no network, no provider).
 *
 *   node scripts/test-refund-authority-matrix.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-refund-matrix';
process.env.INTASEND_PRIVATE_KEY = 'harness-key';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path');
const fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now(), deterministicIds: true });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};

let GATEWAY = 'ok'; const gatewayCalls = []; let gate = null;
const adapter = { initiateRefund: async (args) => {
  gatewayCalls.push({ ...args });
  if (gate) await gate;
  if (GATEWAY === 'http503') return { success: false, refundId: null, httpStatus: 503, error: 'Service Unavailable' };
  if (GATEWAY === 'throw') throw new Error('socket hang up');
  return { success: true, refundId: 'CB' + gatewayCalls.length, httpStatus: 201 };
} };
const noop = () => ({});
const adminNs = { apps: [{}], initializeApp: noop, app: noop,
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, providerData: [{}] }) }), messaging: () => ({ send: async () => 'm' }), storage: () => ({ bucket: () => ({}) }) };
const stub = (m, exp) => { try { require.cache[require.resolve(m, { paths: [FN] })] = { id: m, filename: m, loaded: true, exports: exp }; } catch (_) { /* absent */ } };
stub('firebase-admin', adminNs);
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => adminNs.auth() });
stub('firebase-admin/storage', { getStorage: () => ({ bucket: () => ({}) }) });
const adaptersPath = Path.join(FN, 'payment-adapters.js');
require.cache[adaptersPath] = { id: adaptersPath, filename: adaptersPath, loaded: true, exports: { getAdapter: () => adapter, listAdapters: () => ['intasend'] } };

const FOS = require(Path.join(FN, 'financial-os.js'));
const H = require(Path.join(FN, 'creator-hub.js'));
const who = (uid, token = {}) => ({ auth: { uid, token } });
const BUYER = who('b1'), OTHER = who('u9'), ADMIN = who('adm1', { admin: true }), ADMIN2 = who('adm2', { admin: true }), SUPER = who('sa1', { superAdmin: true, admin: true });
async function call(fn, req) { try { return { ok: await fn.run(req) }; } catch (e) { return { err: e.code || 'error', msg: String(e.message).slice(0, 140) }; } }
const q = async (id) => ((await db.doc('fosRefundQueue/' + id).get()).data() || {});
const payment = async (ref, uid, over = {}) => db.doc('payments/' + ref).set({ uid, amount: 100, status: 'COMPLETE', currency: 'KES', ...over });

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };

(async () => {
  say('\n── R1 buyer may request, cannot approve ──');
  await payment('PAYB1', 'b1');
  let n = gatewayCalls.length;
  const r1 = await call(FOS.fosSubmitRefund, { ...BUYER, data: { payRef: 'PAYB1', amountKES: 100, reason: 'did not arrive' } });
  ck('R1 buyer submits → a PENDING case (not auto-approved), no provider call', r1.ok && r1.ok.status === 'pending' && (await q('ref_PAYB1')).status === 'pending' && gatewayCalls.length === n, r1);
  const r1b = await call(FOS.fosApproveRefund, { ...BUYER, data: { refundId: 'ref_PAYB1' } });
  ck('R1 buyer cannot approve their own refund', r1b.err === 'permission-denied' && (await q('ref_PAYB1')).status === 'pending' && gatewayCalls.length === n, r1b.err);
  ck('R1 buyer cannot over-claim (more than the payment)', (await call(FOS.fosSubmitRefund, { ...BUYER, data: { payRef: 'PAYB1', amountKES: 1000, reason: 'x' } })).err === 'invalid-argument');

  say('\n── R2 unauthorized approval ──');
  ck('R2 an ordinary user cannot approve', (await call(FOS.fosApproveRefund, { ...OTHER, data: { refundId: 'ref_PAYB1' } })).err === 'permission-denied' && gatewayCalls.length === n);
  ck('R2 another user cannot request a refund of someone else\'s payment', (await call(FOS.fosSubmitRefund, { ...OTHER, data: { payRef: 'PAYB1', amountKES: 50, reason: 'x' } })).err === 'permission-denied');
  ck('R2 an ordinary user cannot resolve', (await call(FOS.fosResolveRefund, { ...OTHER, data: { refundId: 'ref_PAYB1', outcome: 'refunded', evidence: 'CB-1' } })).err === 'permission-denied');

  say('\n── R3 authorized approval · R4 exactly one execution ──');
  n = gatewayCalls.length;
  const r3 = await call(FOS.fosApproveRefund, { ...ADMIN, data: { refundId: 'ref_PAYB1' } });
  ck('R3 an admin approves under the existing policy', !r3.err && (await q('ref_PAYB1')).status === 'processed', r3.err || (await q('ref_PAYB1')).status);
  ck('R4 approval → exactly ONE provider execution', gatewayCalls.length - n === 1 && gatewayCalls[gatewayCalls.length - 1].originalRef === 'PAYB1', gatewayCalls.length - n);

  say('\n── R5 duplicate / concurrent execution ──');
  const r5 = await call(FOS.fosApproveRefund, { ...ADMIN2, data: { refundId: 'ref_PAYB1' } });
  ck('R5 replayed approval of a processed case → refused, no second provider call', r5.err === 'failed-precondition' && gatewayCalls.length - n === 1, r5.err);
  await payment('PAYB2', 'b2');
  await call(FOS.fosSubmitRefund, { ...who('b2'), data: { payRef: 'PAYB2', amountKES: 100, reason: 'x' } });
  n = gatewayCalls.length;
  let release; gate = new Promise((r) => { release = r; });
  const p1 = call(FOS.fosApproveRefund, { ...ADMIN, data: { refundId: 'ref_PAYB2' } });
  await new Promise((r) => setTimeout(r, 20));
  const p2 = call(FOS.fosApproveRefund, { ...ADMIN2, data: { refundId: 'ref_PAYB2' } });
  await new Promise((r) => setTimeout(r, 20));
  release(); gate = null;
  const [c1, c2] = await Promise.all([p1, p2]);
  ck('R5 two admins approving concurrently → ONE provider call, one approval loses', gatewayCalls.length - n === 1 && [c1, c2].filter((x) => x.err === 'failed-precondition').length === 1 && (await q('ref_PAYB2')).status === 'processed', [c1.err || 'ok', c2.err || 'ok']);
  const dup = await call(FOS.fosSubmitRefund, { ...who('b2'), data: { payRef: 'PAYB2', amountKES: 100, reason: 'again' } });
  ck('R5 a second request for the same payment returns the existing case (no second case)', dup.ok && dup.ok.existing === true && dup.ok.refundId === 'ref_PAYB2');

  say('\n── R6 OUTCOME_UNKNOWN — no blind retry ──');
  await payment('PAYB3', 'b3');
  await call(FOS.fosSubmitRefund, { ...who('b3'), data: { payRef: 'PAYB3', amountKES: 100, reason: 'x' } });
  GATEWAY = 'http503'; n = gatewayCalls.length;
  const r6 = await call(FOS.fosApproveRefund, { ...ADMIN, data: { refundId: 'ref_PAYB3' } });
  ck('R6 a 5xx → outcome_unknown (not failed, not retried)', (await q('ref_PAYB3')).status === 'outcome_unknown' && gatewayCalls.length - n === 1, { st: (await q('ref_PAYB3')).status, r: r6.err || r6.ok });
  GATEWAY = 'ok';
  const r6b = await call(FOS.fosApproveRefund, { ...ADMIN2, data: { refundId: 'ref_PAYB3' } });
  ck('R6 re-approval of an unknown outcome refused — still ONE provider call', r6b.err === 'failed-precondition' && gatewayCalls.length - n === 1, r6b.err);

  say('\n── R7 resolution is Super Admin + evidence, and repeat is a no-op ──');
  ck('R7 a plain admin cannot resolve', (await call(FOS.fosResolveRefund, { ...ADMIN, data: { refundId: 'ref_PAYB3', outcome: 'refunded', evidence: 'IntaSend CB-77' } })).err === 'permission-denied');
  ck('R7 evidence is required', (await call(FOS.fosResolveRefund, { ...SUPER, data: { refundId: 'ref_PAYB3', outcome: 'refunded', evidence: '' } })).err === 'invalid-argument');
  const r7 = await call(FOS.fosResolveRefund, { ...SUPER, data: { refundId: 'ref_PAYB3', outcome: 'refunded', evidence: 'IntaSend CB-77' } });
  const afterFirst = JSON.stringify(await q('ref_PAYB3'));
  ck('R7 super admin resolves with evidence → processed, no provider call', r7.ok && (await q('ref_PAYB3')).status === 'processed' && gatewayCalls.length - n === 1, r7);
  const r7b = await call(FOS.fosResolveRefund, { ...SUPER, data: { refundId: 'ref_PAYB3', outcome: 'refunded', evidence: 'IntaSend CB-77' } });
  ck('R7 resolving again has NO effect (refused; case byte-identical)', r7b.err === 'failed-precondition' && JSON.stringify(await q('ref_PAYB3')) === afterFirst, r7b.err);
  ck('R7 the contradicting outcome after resolution is refused too', (await call(FOS.fosResolveRefund, { ...SUPER, data: { refundId: 'ref_PAYB3', outcome: 'not_refunded', evidence: 'IntaSend X' } })).err === 'failed-precondition');

  say('\n── film purchase through the same authority ──');
  await payment('PAYF1', 'bf');
  await db.doc('paymentIntents/PAYF1').set({ purpose: 'film_access', uid: 'bf', ownerUid: 'bf', resourceId: 'filmZ', metadata: { type: 'film_access' } });
  n = gatewayCalls.length;
  const rf = await call(FOS.fosSubmitRefund, { ...ADMIN, data: { payRef: 'PAYF1', amountKES: 100, reason: 'playback failed' } });
  const fq = await q('ref_PAYF1');
  ck('film refund: one provider call, no seller (film intent has none), buyer = payer', !rf.err && gatewayCalls.length - n === 1 && fq.sellerUid === null && fq.buyerUid === 'bf', { err: rf.err, st: fq.status });
  const acc = (await db.doc('royaltyAccruals/acc_PAYF1').get()).data();
  ck('film refund reaches the Creator royalty hook (accrual voided — none existed yet)', acc && acc.status === 'VOID_REFUNDED', acc);

  say('\n── R8 AdminOS shows the canonical case and creates nothing ──');
  const before = (await db.collection('fosRefundQueue').get()).size;
  ck('R8 an ordinary user cannot open the case list', (await call({ run: H._adminH.creatorAdminRefundCases }, { ...OTHER, data: {} })).err === 'permission-denied');
  const list = (await H._adminH.creatorAdminRefundCases({ ...ADMIN, data: {} })).cases;
  const byId = Object.fromEntries(list.map((c) => [c.refundId, c]));
  ck('R8 the list IS fosRefundQueue with real states', byId.ref_PAYB1.status === 'processed' && byId.ref_PAYB3.status === 'processed' && byId.ref_PAYB3.resolution && byId.ref_PAYB3.resolution.outcome === 'refunded' && byId.ref_PAYF1.filmPurchase === true, list.map((c) => c.refundId + ':' + c.status));
  ck('R8 reading the screen creates NO refund record', (await db.collection('fosRefundQueue').get()).size === before);
  const mod = fs.readFileSync(Path.join(ROOT, 'sokoni-aos-creator.js'), 'utf8');
  ck('R8 the UI\'s only refund actions are the canonical callables', /act\('fosApproveRefund'/.test(mod) && /act\('fosResolveRefund'/.test(mod) && !/fosSubmitRefund|refundRequests|fosRefundQueue/.test(mod));

  say('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('HARNESS CRASHED', e && e.stack); process.exit(2); });
