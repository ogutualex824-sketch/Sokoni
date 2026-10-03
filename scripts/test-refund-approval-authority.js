#!/usr/bin/env node
/* SECURITY HOTFIX 2026-10-03 — initiateRefund: a buyer's call is a REQUEST; money / escrow / settlement move only on
 * an administrator's call.
 *   node scripts/test-refund-approval-authority.js
 *   BASE=84e960d node scripts/test-refund-approval-authority.js   (the LIVE archive verbatim — must FAIL)
 * Loads the REAL functions/index.js (firebase-admin replaced by an in-memory Firestore) and runs initiateRefund.run().
 * order-settlement.handleOrderRefund is the REAL module too: its writes are observed, not mocked. */
'use strict';
const path = require('path'), fs = require('fs'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { fakeDb } = require('./lib/fake-firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };

let IDX = path.join(FN, 'index.js');
if (process.env.BASE) {
  IDX = path.join(FN, '.refbase-' + process.pid + '.js');
  fs.writeFileSync(IDX, execSync('git show ' + process.env.BASE + ':functions/index.js', { cwd: ROOT, maxBuffer: 64 << 20 }));
  process.on('exit', () => { try { fs.unlinkSync(IDX); } catch (_) {} });
}
let DB = fakeDb({});
const realFS = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
const adminPath = require.resolve('firebase-admin', { paths: [FN] });
const dbProxy = new Proxy({}, { get: (_, k) => (k === 'getAll' ? (...refs) => Promise.all(refs.map((r) => r.get())) : (typeof DB[k] === 'function' ? DB[k].bind(DB) : DB[k])) });
const fsFn = () => dbProxy; fsFn.FieldValue = realFS.FieldValue; fsFn.Timestamp = realFS.Timestamp;
const stubAdmin = { firestore: fsFn, apps: [1], initializeApp() {}, auth: () => ({ getUser: async () => ({}) }), messaging: () => ({ send: async () => ({}) }), storage: () => ({ bucket: () => ({}) }) };
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: stubAdmin };
for (const sub of ['firebase-admin/firestore']) { const p = require.resolve(sub, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: Object.assign({}, realFS, { getFirestore: () => dbProxy }) }; }
let I;
const _log = console.log; console.log = () => {};
try { I = require(IDX); } catch (e) { console.log = _log; console.log('CRASH loading index.js (no verdict): ' + e.message.split('\n')[0]); process.exit(2); }
console.log = _log;
const run = async (uid, data, token) => { try { return await I.initiateRefund.run({ auth: uid ? { uid, token: token || {} } : null, data }); } catch (e) { return { err: e.code || 'error', msg: e.message }; } };
const S = () => DB._store;

function world(extra) {
  return Object.assign({
    orders: { O1: { uid: 'buyer1', buyerUid: 'buyer1', sellerUid: 'seller1', status: 'delivered', settlementStatus: 'SETTLED', total: 1000 } },
    settlements: { O1: { status: 'settled', netShillingsCredited: 950, commissionCents: 5000, sellerUid: 'seller1' } },
    escrows: { E1: { buyerId: 'buyer1', amount: 1000, currency: 'KES', status: 'held', orderId: 'O1' } },
  }, extra || {});
}

(async () => {
  console.log('\ninitiateRefund approval authority   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  DB = fakeDb(world());
  let r = await run('buyer1', { orderId: 'O1', reason: 'changed mind' });
  ck('R-1', S().orders.O1.settlementStatus === 'SETTLED' && S().settlements.O1.status === 'settled',
    'a BUYER\'s request does NOT reverse the seller\'s settled payout (no admin decision)', { r, order: S().orders.O1, settlement: S().settlements.O1 });
  const req = Object.values(S().refunds || {})[0] || {};
  ck('R-2', req.status === 'pending' && req.requiresApproval === true && r.status === 'pending_review', 'the buyer\'s call is recorded as a request awaiting review', { req, r });

  DB = fakeDb(world({ orders: { O1: { uid: 'buyer1', sellerUid: 'seller1', status: 'delivered', settlementStatus: 'ELIGIBLE' } } }));
  r = await run('buyer1', { orderId: 'O1' });
  ck('R-3', S().orders.O1.settlementStatus === 'ELIGIBLE', 'a buyer\'s request does NOT mark an unsettled order REFUNDED (the seller\'s settlement is not blocked)', S().orders.O1);

  DB = fakeDb(world());
  r = await run('buyer1', { escrowRef: 'E1', orderId: 'O1' });
  ck('R-4', S().escrows.E1.status === 'held' && !Object.keys(S().paymentLedger || {}).length, 'a buyer\'s escrow request moves NO escrow and posts NO ledger credit to the buyer', { escrow: S().escrows.E1, ledger: S().paymentLedger });

  /* admin approval still works, and the buyer's pending request does not eat the ceiling */
  r = await run('ops', { escrowRef: 'E1', orderId: 'O1', amount: 1000 }, { admin: true });
  ck('R-5', !r.err && S().escrows.E1.status === 'refunded' && Object.values(S().paymentLedger || {}).some((l) => l.creditAccount === 'buyer:buyer1' && l.amount === 1000),
    'an ADMINISTRATOR approving refunds the full escrow (the unapproved buyer request reserved nothing)', { r, escrow: S().escrows.E1 });
  ck('R-6', S().orders.O1.settlementStatus !== 'SETTLED' || (S().settlements.O1 && S().settlements.O1.status !== 'settled'), 'the admin refund reverses the settled order (canonical handleOrderRefund still runs for admins)', { order: S().orders.O1, s: S().settlements.O1 });

  DB = fakeDb(world());
  r = await run('stranger', { orderId: 'O1' });
  ck('R-7', r.err === 'permission-denied' && !S().refunds, 'CONTROL: a stranger cannot file a refund on someone else\'s order', r);
  r = await run(null, { orderId: 'O1' });
  ck('R-8', r.err === 'unauthenticated', 'CONTROL: signed out is refused');

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
