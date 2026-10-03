#!/usr/bin/env node
/* SECURITY HOTFIX 2026-10-03 — updateClickAndCollectStatus binds its cross-collection effects to server facts.
 *   node scripts/test-cnc-order-ownership.js
 *   BASE=5c22a60866 node scripts/test-cnc-order-ownership.js   (byte-identical to the LIVE archive — must FAIL)
 * Runs the REAL callable (.run) on an in-memory Firestore; pickup-location and pos-audit are the REAL modules. */
'use strict';
const path = require('path'), fs = require('fs'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { fakeDb } = require('./lib/fake-firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };
let MOD = path.join(FN, 'pos-marketplace-sync.js');
if (process.env.BASE) {
  MOD = path.join(FN, '.cncbase-' + process.pid + '.js');
  fs.writeFileSync(MOD, execSync('git show ' + process.env.BASE + ':functions/pos-marketplace-sync.js', { cwd: ROOT }));
  process.on('exit', () => { try { fs.unlinkSync(MOD); } catch (_) {} });
}
let DB = fakeDb({});
const realFS = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
const adminPath = require.resolve('firebase-admin', { paths: [FN] });
const dbProxy = new Proxy({}, { get: (_, k) => (k === 'doc' ? (p) => { const [c, ...rest] = p.split('/'); let ref = DB.collection(c).doc(rest[0]); for (let i = 1; i < rest.length; i += 2) ref = Object.assign(DB.collection(c + '/' + rest[0] + '/' + rest[i]).doc(rest[i + 1])); return ref; } : (typeof DB[k] === 'function' ? DB[k].bind(DB) : DB[k])) });
const fsFn = () => dbProxy; fsFn.FieldValue = realFS.FieldValue; fsFn.Timestamp = realFS.Timestamp;
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { firestore: fsFn, apps: [1], initializeApp() {} } };
const C = require(MOD);
const run = async (uid, data, role) => { try { return await C.updateClickAndCollectStatus.run({ auth: { uid, token: { role: role || 'owner' } }, data }); } catch (e) { return { err: e.code || 'error', msg: e.message }; } };
const S = () => DB._store;
const CNC = 'sellers/attacker/clickAndCollect';

function world() {
  return {
    orders: { VICTIM_ORDER: { sellerUid: 'victimSeller', uid: 'buyerV', status: 'paid', paymentVerified: true } },
    deliveryPins: { VICTIM_ORDER: { orderId: 'VICTIM_ORDER', proofPin: '1234', buyerUid: 'buyerV' } },
    products: { victimProd: { sellerUid: 'victimSeller', stock: 3 }, myProd: { sellerUid: 'attacker', stock: 5 } },
    shops: { attacker: { pickupLocation: { lat: 1, lng: 1, address: 'x' } } },
    [CNC]: {
      VICTIM_ORDER: { sellerId: 'attacker', status: 'pending', fulfillmentType: 'delivery', items: [{ productId: 'victimProd', qty: 500 }] },
      MINE: { sellerId: 'attacker', status: 'pending', fulfillmentType: 'pickup', items: [{ productId: 'myProd', qty: 2 }, { productId: 'victimProd', qty: 50 }] },
    },
  };
}

(async () => {
  console.log('\nupdateClickAndCollectStatus ownership   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  DB = fakeDb(world());
  let r = await run('attacker', { sellerId: 'attacker', orderId: 'VICTIM_ORDER', status: 'ready' });
  ck('H-1', S().orders.VICTIM_ORDER.status === 'paid' && S().deliveryPins.VICTIM_ORDER.proofPin === '1234' && !(S().packageRequests || {}).DELVICTIM_ORDER,
    'EXPLOIT: a seller\'s forged C&C record cannot rewrite another shop\'s order, its delivery PIN or create a rider job for it', { r, order: S().orders.VICTIM_ORDER, pin: S().deliveryPins.VICTIM_ORDER, pr: (S().packageRequests || {}).DELVICTIM_ORDER });
  ck('H-2', r.err === 'permission-denied', 'the call is refused outright', r);

  DB = fakeDb(world());
  r = await run('attacker', { sellerId: 'attacker', orderId: 'VICTIM_ORDER', status: 'cancelled' });
  ck('H-3', S().products.victimProd.stock === 3, 'EXPLOIT: cancelling a forged C&C record cannot inflate another shop\'s stock', { r, victimProd: S().products.victimProd });

  DB = fakeDb(world());
  r = await run('attacker', { sellerId: 'attacker', orderId: 'MINE', status: 'cancelled' });
  ck('S-1', !r.err && S().products.myProd.stock === 7 && S().products.victimProd.stock === 3,
    'a real cancel restores the seller\'s OWN product; a forged line naming another shop\'s product restores nothing', { r, my: S().products.myProd, victim: S().products.victimProd });

  DB = fakeDb(world());
  r = await run('attacker', { sellerId: 'attacker', orderId: 'MINE', status: 'ready' });
  ck('S-2', !r.err && S()[CNC].MINE.status === 'ready' && !(S().orders || {}).MINE, 'CONTROL: a pickup order goes ready; no stray orders/{id} is CREATED by the mirror', { r, orders: Object.keys(S().orders || {}) });

  DB = fakeDb(world());
  DB._store.orders.OWN_ORDER = { sellerUid: 'attacker', status: 'paid' };
  DB._store[CNC].OWN_ORDER = { sellerId: 'attacker', status: 'pending', fulfillmentType: 'delivery', items: [] };
  r = await run('attacker', { sellerId: 'attacker', orderId: 'OWN_ORDER', status: 'ready' });
  ck('S-3', !r.err && S().orders.OWN_ORDER.status === 'awaiting_rider' && (S().packageRequests || {}).DELOWN_ORDER, 'CONTROL: the seller\'s OWN marketplace order is mirrored and dispatched', { r, o: S().orders.OWN_ORDER });

  DB = fakeDb(world());
  DB._store.packageRequests = { DELMINE: { sellerUid: 'victimSeller', status: 'awaiting_rider' } };
  r = await run('attacker', { sellerId: 'attacker', orderId: 'MINE', status: 'ready' });
  ck('S-4', r.err === 'permission-denied' && DB._store.packageRequests.DELMINE.sellerUid === 'victimSeller', 'an existing rider job of another shop cannot be taken over', r);

  DB = fakeDb(world());
  r = await run('ops', { sellerId: 'attacker', orderId: 'MINE', status: 'ready' }, 'admin');
  ck('S-5', !r.err, 'CONTROL: an admin can still act', r);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
