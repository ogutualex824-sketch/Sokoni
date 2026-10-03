#!/usr/bin/env node
/* SECURITY CONVERGENCE 2026-10-03 — an open dispute HOLDS the seller payout; resolving it lifts the hold; opening one
 * moves no money.
 *   node scripts/test-dispute-payout-hold.js        BASE=dda12d11c4 node scripts/test-dispute-payout-hold.js (live — must FAIL)
 * Runs the REAL createDispute / adminResolveDispute callables (.run) and the REAL order-settlement
 * autoConfirmDeliveredOrders sweep on an in-memory Firestore. */
'use strict';
const path = require('path'), fs = require('fs'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { fakeDb } = require('./lib/fake-firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
console.log('\ndispute → payout hold   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
let MOD = path.join(FN, 'disputes.js');
if (process.env.BASE) { MOD = path.join(FN, '.dspbase-' + process.pid + '.js'); fs.writeFileSync(MOD, execSync('git show ' + process.env.BASE + ':functions/disputes.js', { cwd: ROOT })); process.on('exit', () => { try { fs.unlinkSync(MOD); } catch (_) {} }); }
let DB = fakeDb({});
const realFS = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
const adminPath = require.resolve('firebase-admin', { paths: [FN] });
const proxy = new Proxy({}, { get: (_, k) => (typeof DB[k] === 'function' ? DB[k].bind(DB) : DB[k]) });
const fsFn = () => proxy; fsFn.FieldValue = realFS.FieldValue;
const ADM = { firestore: fsFn, apps: [1], initializeApp() {} };
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: ADM };
const D = require(MOD);
const OS = require(path.join(FN, 'order-settlement.js'));
const run = async (fn, uid, data, token) => { try { return await D[fn].run({ auth: uid ? { uid, token: token || {} } : null, data }); } catch (e) { return { err: e.code || 'error', msg: e.message }; } };
const OLD = Date.now() - 10 * 86400e3;   /* delivered 10 days ago — past the 3-day auto-confirm window, inside the 30-day dispute window */
const world = (extra) => ({ orders: { O1: Object.assign({ buyerId: 'buyer1', sellerId: 'seller1', sellerUid: 'seller1', status: 'delivered', deliveredAt: OLD, createdAt: OLD, total: 1000, paymentVerified: true, settlementStatus: 'ELIGIBLE' }, extra || {}) } });
const S = () => DB._store;

(async () => {
  DB = fakeDb(world());
  let r = await run('createDispute', 'buyer1', { orderId: 'O1', reason: 'not_as_described', description: 'The item arrived broken and does not work at all.' });
  const o = S().orders.O1;
  ck('H-1', !r.err && o.disputeOpen === true && o.hasDispute === true, 'opening a dispute HOLDS the order (disputeOpen / hasDispute written in the dispute transaction)', { r, o });
  ck('H-2', o.status === 'delivered' && o.settlementStatus === 'ELIGIBLE' && o.total === 1000, 'opening a dispute moves NO money and changes no order state', o);
  let n = await OS.autoConfirmDeliveredOrders(proxy, ADM);
  ck('H-3', S().orders.O1.status === 'delivered' && n === 0, 'the REAL auto-confirm sweep does NOT complete (= pay out) a disputed order', { status: S().orders.O1.status, n });
  r = await run('createDispute', 'buyer1', { orderId: 'O1', reason: 'not_as_described', description: 'Again, the item arrived broken and does not work.' });
  ck('H-4', r.err === 'already-exists', 'a duplicate dispute is refused', r);
  r = await run('adminResolveDispute', 'stranger', { disputeId: 'dp_O1', action: 'resolved', resolution: 'ok' }, {});
  ck('H-5', !!r.err && S().orders.O1.disputeOpen === true, 'a non-admin cannot resolve the dispute (the hold stays)', r);
  r = await run('adminResolveDispute', 'ops', { disputeId: 'dp_O1', action: 'resolved', resolution: 'Seller replaced the item' }, { admin: true });
  ck('H-6', !r.err && S().orders.O1.disputeOpen === false && S().orders.O1.hasDispute === false, 'an ADMIN resolution lifts the hold', { r, o: S().orders.O1 });
  n = await OS.autoConfirmDeliveredOrders(proxy, ADM);
  ck('H-7', S().orders.O1.status === 'completed' && n === 1, 'after resolution the normal settlement path proceeds (auto-confirm completes it)', S().orders.O1.status);
  /* re-open re-applies the hold */
  DB = fakeDb(world()); await run('createDispute', 'buyer1', { orderId: 'O1', reason: 'not_as_described', description: 'The item arrived broken and does not work at all.' });
  await run('adminResolveDispute', 'ops', { disputeId: 'dp_O1', action: 'closed', resolution: 'closed' }, { admin: true });
  r = await run('adminResolveDispute', 'ops', { disputeId: 'dp_O1', action: 'investigating', resolution: 'reopened' }, { admin: true });
  ck('H-8', S().orders.O1.disputeOpen === true, 're-opening (investigating) re-applies the hold', S().orders.O1);
  /* an already-SETTLED order: the dispute records, nothing is reversed */
  DB = fakeDb(world({ status: 'completed', settlementStatus: 'SETTLED' }));
  r = await run('createDispute', 'buyer1', { orderId: 'O1', reason: 'not_as_described', description: 'The item arrived broken and does not work at all.' });
  ck('H-9', S().orders.O1.settlementStatus === 'SETTLED' && S().orders.O1.status === 'completed' && S().orders.O1.disputeOpen === true, 'a dispute on a SETTLED order flags it but reverses nothing (refunds are the refund authority\'s)', S().orders.O1);
  DB = fakeDb(world());
  r = await run('createDispute', 'stranger', { orderId: 'O1', reason: 'not_as_described', description: 'The item arrived broken and does not work at all.' });
  ck('H-10', r.err === 'permission-denied' && !S().orders.O1.disputeOpen, 'CONTROL: a stranger cannot open a dispute (and so cannot freeze a seller\'s payout)', r);

  /* ── eligibility (owner 2026-10-03): the order's buyer on ANY canonical field; widened cases never auto-refund ── */
  DB = fakeDb({ orders: { O2: { uid: 'buyerC', buyerUid: 'buyerC', sellerUid: 's1', status: 'delivered', deliveredAt: OLD, createdAt: OLD, total: 900, paymentVerified: true } } });
  r = await run('createDispute', 'buyerC', { orderId: 'O2', reason: 'not_as_described', description: 'The item arrived broken and does not work at all.' });
  const d2 = (S().disputes || {}).dp_O2 || {};
  ck('E-1', !r.err && d2.autoResolveEligible === false && d2.buyerMatchedBy === 'checkout_buyer_field' && S().orders.O2.disputeOpen === true,
    'a CHECKOUT buyer (uid / buyerUid) can now open a dispute — marked NOT auto-resolvable (no automatic refund)', { r, d2 });
  DB = fakeDb(world());
  r = await run('createDispute', 'buyer1', { orderId: 'O1', reason: 'not_as_described', description: 'The item arrived broken and does not work at all.' });
  ck('E-2', !r.err && S().disputes.dp_O1.autoResolveEligible === true, 'a legacy-field buyer keeps the existing auto-resolution path (behaviour unchanged)', S().disputes.dp_O1);
  const AE = process.env.BASE ? execSync('git show ' + process.env.BASE + ':functions/automation-engine.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    : fs.readFileSync(path.join(FN, 'automation-engine.js'), 'utf8');
  ck('E-3', /const isSmall = dispute\.autoResolveEligible !== false && amount <= \(rule\.autoResolveBelow \|\| 1000\);/.test(AE),
    'SOURCE-LEVEL: autoOnDisputeCreate never auto-resolves a dispute marked autoResolveEligible:false (runtime needs the AI secret — UNPROVEN at runtime)');

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
