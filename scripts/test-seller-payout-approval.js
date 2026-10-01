#!/usr/bin/env node
'use strict';
/* ============================================================================
   Seller payout readiness requires an ADMIN approval (owner, 2026-10-01)
   ----------------------------------------------------------------------------
   Real module (functions/seller-payout-approval.js) with firebase-admin replaced by the in-memory
   Firestore fake; dispatch.js checked at source.
     A  list: completed/delivered items without approval, across packageRequests/deliveries/orders;
        pending/in-transit and already-approved items excluded; a failing collection is reported
        as unreadable, not as "nothing pending"
     B  approve: admin only; item must be completed/delivered; sets ready + approvedBy/At + audit;
        a second approval is a no-op; an admin cannot approve a payout to themselves
     C  captureProofOfDelivery no longer sets sellerPayoutReady:true (pending approval instead)
   node scripts/test-seller-payout-approval.js
   ============================================================================ */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };
const F = makeFakeFirestore();
const ff = () => F.db; ff.FieldValue = F.FieldValue; ff.Timestamp = F.Timestamp;
const fa = Module._resolveFilename('firebase-admin', { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { apps: [1], initializeApp() {}, firestore: ff } };
const M = require(path.join(FN, 'seller-payout-approval.js'));
const X = M._internal;
const ADMIN = { auth: { uid: 'admin1', token: { admin: true } } };
async function tryRun(fn, req) { try { return { ok: true, v: await fn.run(req) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } }

(async () => {
  console.log('Seller payout approval\n');
  const T = (ms) => F.Timestamp.fromMillis(ms);
  await F.db.collection('packageRequests').doc('p1').set({ status: 'buyer_confirmed', sellerUid: 's1', sellerNet: 900, buyerConfirmedAt: T(3000) });
  await F.db.collection('packageRequests').doc('p2').set({ status: 'in_transit', sellerUid: 's1' });
  await F.db.collection('deliveries').doc('d1').set({ status: 'completed', sellerUid: 's2', completedAt: T(2000) });
  await F.db.collection('orders').doc('o1').set({ status: 'delivered', sellerUid: 'admin1', total: 500, deliveredAt: T(1000) });
  await F.db.collection('orders').doc('o2').set({ status: 'completed', sellerUid: 's3', sellerPayoutReady: true, sellerPayoutApproval: 'approved' });

  console.log('A. list');
  const l = await tryRun(M.adminListPendingSellerPayouts, { ...ADMIN, data: {} });
  const ids = l.ok ? l.v.pending.map((r) => r.collection + '/' + r.id) : [];
  ck('A1 completed/delivered unapproved items listed across the three collections, newest first', l.ok && JSON.stringify(ids) === JSON.stringify(['packageRequests/p1', 'deliveries/d1', 'orders/o1']), ids);
  ck('A2 in-transit and already-approved items excluded', !ids.includes('packageRequests/p2') && !ids.includes('orders/o2'));
  ck('A3 amount comes from the record (sellerNet / total), not invented', l.ok && l.v.pending[0].amountKES === 900 && l.v.pending[2].amountKES === 500);
  const origColl = F.db.collection.bind(F.db);
  F.db.collection = (n) => (n === 'deliveries' ? { where: () => ({ limit: () => ({ get: async () => { throw new Error('down'); } }) }) } : origColl(n));
  const lu = await X.listPending({});
  F.db.collection = origColl;
  ck('A4 a collection that cannot be read is reported as unreadable (never "nothing pending")', lu.unreadable.includes('deliveries'), lu.unreadable);
  const nonAdmin = await tryRun(M.adminListPendingSellerPayouts, { auth: { uid: 'u', token: {} }, data: {} });
  ck('A5 non-admin cannot list', !nonAdmin.ok && nonAdmin.code === 'permission-denied');

  console.log('\nB. approve');
  const na = await tryRun(M.adminApproveSellerPayout, { auth: { uid: 'seller', token: { role: 'seller' } }, data: { collection: 'packageRequests', id: 'p1' } });
  ck('B1 a non-admin (even the seller) cannot approve', !na.ok && na.code === 'permission-denied');
  const notDone = await tryRun(M.adminApproveSellerPayout, { ...ADMIN, data: { collection: 'packageRequests', id: 'p2' } });
  ck('B2 an item that is not delivered/completed cannot be approved', !notDone.ok && notDone.code === 'failed-precondition');
  const self = await tryRun(M.adminApproveSellerPayout, { ...ADMIN, data: { collection: 'orders', id: 'o1' } });
  ck('B3 an admin cannot approve a payout to themselves (separation of duties)', !self.ok && self.code === 'permission-denied', self);
  const ok1 = await tryRun(M.adminApproveSellerPayout, { ...ADMIN, data: { collection: 'packageRequests', id: 'p1', note: 'checked proof' } });
  const p1 = (await F.db.collection('packageRequests').doc('p1').get()).data();
  const audit = [...F.db._store.entries()].filter(([k]) => k.startsWith('adminAudit/')).map(([, v]) => v.data);
  ck('B4 approval sets ready + approval + approvedBy/At and writes an audit row', ok1.ok && p1.sellerPayoutReady === true && p1.sellerPayoutApproval === 'approved' && p1.sellerPayoutApprovedBy === 'admin1' && p1.sellerPayoutApprovedAt && audit.some((a) => a.action === 'seller_payout_approved' && a.docId === 'p1' && a.by === 'admin1'), { p1, audit });
  const ok2 = await tryRun(M.adminApproveSellerPayout, { ...ADMIN, data: { collection: 'packageRequests', id: 'p1' } });
  const audit2 = [...F.db._store.entries()].filter(([k]) => k.startsWith('adminAudit/'));
  ck('B5 approving again is a no-op (no second audit row)', ok2.ok && ok2.v.already === true && audit2.length === 1);
  const bad = await tryRun(M.adminApproveSellerPayout, { ...ADMIN, data: { collection: 'users', id: 'x' } });
  const bad2 = await tryRun(M.adminApproveSellerPayout, { ...ADMIN, data: { collection: 'orders', id: '../x' } });
  ck('B6 unknown collection or malformed id refused', !bad.ok && bad.code === 'invalid-argument' && !bad2.ok && bad2.code === 'invalid-argument');

  console.log('\nC. captureProofOfDelivery');
  const disp = fs.readFileSync(path.join(FN, 'dispatch.js'), 'utf8');
  ck('C1 proof of delivery no longer marks the payout ready (pending admin approval)', !/sellerPayoutReady:\s*true/.test(disp) && /sellerPayoutReady:false,\s*[\r\n]+\s*sellerPayoutApproval:'pending'/.test(disp));
  const idx = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  ck('C2 both callables exported by name; App Check enforced', /exports\.adminListPendingSellerPayouts = require\('\.\/seller-payout-approval'\)/.test(idx) && /exports\.adminApproveSellerPayout = require\('\.\/seller-payout-approval'\)/.test(idx) && /enforceAppCheck: true/.test(fs.readFileSync(path.join(FN, 'seller-payout-approval.js'), 'utf8')));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
