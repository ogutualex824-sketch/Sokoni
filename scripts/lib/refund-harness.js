/* refund-harness.js — execute the REAL fosSubmitRefund / fosApproveRefund /
 * fosResolveRefund from a given tree against a controllable fake gateway.
 *
 *   node scripts/lib/refund-harness.js <treeRoot> <scenario>
 *
 * Env knobs (set by scripts/test-refund-exactly-once.js):
 *   GATEWAY          ok | http503 | http400 | http429 | throw
 *   FAIL_TXN_AFTER_GATEWAY=1   the first Firestore transaction after the gateway
 *                              call throws (a transient failure)
 * Prints one JSON line: gateway call count, every call's outcome, final state.
 * No network: firebase-admin and payment-adapters are replaced in require.cache.
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-refund-harness';
process.env.INTASEND_PRIVATE_KEY = 'harness-key';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const path = require('path');
const [, , ROOT, SCENARIO] = process.argv;
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./fake-firestore-txn');
const T0 = Date.UTC(2026, 8, 20, 9, 0, 0);
let NOW = T0;
const F = makeFakeFirestore({ clock: () => NOW, deterministicIds: true });
const db = F.db;
const out = process.stdout.write.bind(process.stdout);
console.log = console.info = console.warn = console.error = console.debug = () => {};

/* gateway */
const GATEWAY = process.env.GATEWAY || 'ok';
const gatewayCalls = [];
let gate = null;               /* a promise the gateway waits on (race scenario) */
let releaseGate = null;
const adapter = {
  initiateRefund: async (args) => {
    gatewayCalls.push({ ...args });
    if (gate) await gate;
    if (GATEWAY === 'throw') throw new Error('socket hang up');
    if (GATEWAY === 'http503') return { success: false, refundId: null, httpStatus: 503, error: 'Service Unavailable' };
    if (GATEWAY === 'http429') return { success: false, refundId: null, httpStatus: 429, error: 'Too Many Requests' };
    if (GATEWAY === 'http400') return { success: false, refundId: null, httpStatus: 400, error: 'invalid invoice' };
    return { success: true, refundId: 'CB' + gatewayCalls.length, httpStatus: 201 };
  },
};

/* transient failure of the first transaction after the gateway call */
let failArmed = process.env.FAIL_TXN_AFTER_GATEWAY === '1';
const realTxn = db.runTransaction;
db.runTransaction = async (fn) => {
  if (failArmed && gatewayCalls.length > 0) { failArmed = false; throw Object.assign(new Error('DEADLINE_EXCEEDED (simulated)'), { code: 4 }); }
  return realTxn(fn);
};

const noop = () => ({});
const adminNs = { apps: [{}], initializeApp: noop, app: noop,
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u }) }), messaging: () => ({ send: async () => 'm' }) };
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { try { require.cache[resolveIn(m)] = { id: m, filename: m, loaded: true, exports: exp }; } catch (_) { /* absent */ } };
stub('firebase-admin', adminNs);
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin/auth', { getAuth: () => adminNs.auth() });
const adaptersPath = path.join(FN, 'payment-adapters.js');
require.cache[adaptersPath] = { id: adaptersPath, filename: adaptersPath, loaded: true, exports: { getAdapter: () => adapter, listAdapters: () => ['intasend'] } };

const FOS = require(path.join(FN, 'financial-os.js'));
const ADMIN = { auth: { uid: 'adm1', token: { admin: true } } };
const SUPER = { auth: { uid: 'sa1', token: { superAdmin: true, admin: true } } };
async function call(fn, req) { try { return { ok: await fn.run(req) }; } catch (e) { return { err: e.code || 'error', msg: String(e.message).slice(0, 120) }; } }
const readQ = async (id) => ((await db.doc('fosRefundQueue/' + id).get()).data() || {});

(async () => {
  const steps = {};
  let refundId = 'ref_T1';
  if (SCENARIO === 'approve' || SCENARIO === 'approveRace') {
    await db.doc('fosTransactions/T1').set({ status: 'COMPLETED', amountCents: 10000, buyerUid: 'b1', sellerUid: 's1', payRef: 'PAY1' });
    await db.doc('fosRefundQueue/ref_T1').set({ fosTransactionId: 'T1', payRef: 'PAY1', buyerUid: 'b1', sellerUid: 's1', amountKES: 100, amountCents: 10000,
      reason: 'x', refundType: 'full', provider: 'intasend', status: 'pending', requestedBy: 'b1' });
    if (SCENARIO === 'approveRace') {
      gate = new Promise((r) => { releaseGate = r; });
      const p1 = call(FOS.fosApproveRefund, { ...ADMIN, data: { refundId } });
      await new Promise((r) => setTimeout(r, 20));
      const p2 = call(FOS.fosApproveRefund, { auth: { uid: 'adm2', token: { admin: true } }, data: { refundId } });
      await new Promise((r) => setTimeout(r, 20));
      releaseGate();
      [steps.first, steps.second] = await Promise.all([p1, p2]);
    } else {
      steps.first = await call(FOS.fosApproveRefund, { ...ADMIN, data: { refundId } });
    }
  } else if (SCENARIO === 'submitMarketplace') {
    await db.doc('payments/PAY1').set({ uid: 'b1', amount: 100, status: 'COMPLETE', currency: 'KES' });
    await db.doc('paymentIntents/PAY1').set({ purpose: 'product_order', uid: 'b1', ownerUid: 'b1', metadata: { sellerUid: 's1', orderId: 'O1' } });
    refundId = 'ref_PAY1';
    steps.first = await call(FOS.fosSubmitRefund, { ...ADMIN, data: { payRef: 'PAY1', amountKES: 100, reason: 'dispute' } });
  } else if (SCENARIO === 'submit' || SCENARIO === 'submitRace') {
    /* payRef-only payment — the Creator/STK shape: no fosTransactions doc */
    await db.doc('payments/PAY1').set({ uid: 'b1', amount: 100, status: 'COMPLETE', currency: 'KES' });
    refundId = 'ref_PAY1';
    if (SCENARIO === 'submitRace') {
      gate = new Promise((r) => { releaseGate = r; });
      const p1 = call(FOS.fosSubmitRefund, { ...ADMIN, data: { payRef: 'PAY1', amountKES: 100, reason: 'dispute' } });
      await new Promise((r) => setTimeout(r, 30));
      const p2 = call(FOS.fosApproveRefund, { auth: { uid: 'adm2', token: { admin: true } }, data: { refundId } });
      await new Promise((r) => setTimeout(r, 20));
      releaseGate();
      [steps.first, steps.second] = await Promise.all([p1, p2]);
    } else {
      steps.first = await call(FOS.fosSubmitRefund, { ...ADMIN, data: { payRef: 'PAY1', amountKES: 100, reason: 'dispute' } });
    }
  } else throw new Error('unknown scenario ' + SCENARIO);

  steps.afterFirst = (await readQ(refundId)).status;
  /* The attack: an admin re-approves whatever state the request was left in. */
  steps.reapprove = await call(FOS.fosApproveRefund, { ...ADMIN, data: { refundId } });
  steps.afterReapprove = (await readQ(refundId)).status;

  /* Resolution path (only exists on the fixed tree). */
  if (FOS.fosResolveRefund) {
    steps.resolveAsAdmin = await call(FOS.fosResolveRefund, { ...ADMIN, data: { refundId, outcome: 'refunded', evidence: 'IntaSend CB-123' } });
    steps.resolve = await call(FOS.fosResolveRefund, { ...SUPER, data: { refundId, outcome: 'refunded', evidence: 'IntaSend CB-123' } });
    steps.resolveAgain = await call(FOS.fosResolveRefund, { ...SUPER, data: { refundId, outcome: 'refunded', evidence: 'IntaSend CB-123' } });
  }
  const q = await readQ(refundId);
  const sellerWallet = (await db.doc('wallets/s1').get()).data() || null;
  const buyerWallet = (await db.doc('wallets/b1').get()).data() || null;
  out(JSON.stringify({ scenario: SCENARIO, gateway: GATEWAY, gatewayCalls: gatewayCalls.length, steps, final: q.status,
    sellerRefundedCents: sellerWallet ? sellerWallet.refundedCents || 0 : 0, buyerWallet, fosTx: ((await db.doc('fosTransactions/T1').get()).data() || {}).status || null }) + '\n');
  process.exit(0);
})().catch((e) => { out(JSON.stringify({ scenario: SCENARIO, crashed: String(e && e.stack || e).slice(0, 600) }) + '\n'); process.exit(3); });
