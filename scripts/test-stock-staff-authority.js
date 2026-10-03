#!/usr/bin/env node
/* OWNER DECISION 2026-10-03 — merchantAdjustStock: owner (unchanged) + manager + the explicit 'inventory' role adjust stock
 * through the server; cashiers and plain staff do not; employment is owner-granted.
 *   node scripts/test-stock-staff-authority.js        BASE=1b6164d node scripts/test-stock-staff-authority.js (must FAIL S-1/S-2)
 * Runs the REAL merchantAdjustStock handler with the REAL merchant-identity.resolveActor on an in-memory Firestore
 * (firebase-admin replaced in the require cache). Every refusal asserts stock and movements are untouched. */
'use strict';
const path = require('path'), fs = require('fs'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { fakeDb } = require('./lib/fake-firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };
console.log('\nmerchantAdjustStock staff authority   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const tmp = [];
const load = (f) => {
  if (!process.env.BASE) return path.join(FN, f);
  const p = path.join(FN, '.stkbase-' + process.pid + '-' + f); fs.writeFileSync(p, execSync('git show ' + process.env.BASE + ':functions/' + f, { cwd: ROOT })); tmp.push(p); return p;
};
process.on('exit', () => tmp.forEach((p) => { try { fs.unlinkSync(p); } catch (_) {} }));
let DB = fakeDb({});
const realFS = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
const proxy = new Proxy({}, { get: (_, k) => (typeof DB[k] === 'function' ? DB[k].bind(DB) : DB[k]) });
const fsPath = require.resolve('firebase-admin/firestore', { paths: [FN] });
require.cache[fsPath] = { id: fsPath, filename: fsPath, loaded: true, exports: Object.assign({}, realFS, { getFirestore: () => proxy }) };
const adminPath = require.resolve('firebase-admin', { paths: [FN] });
const fsFn = () => proxy; fsFn.FieldValue = realFS.FieldValue;
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { firestore: fsFn, apps: [1], initializeApp() {}, auth: () => ({ getUser: async (u) => ({ uid: u, displayName: 'P ' + u, customClaims: u === 'ops' ? { admin: true } : {} }) }) } };
/* merchant-identity must be the tree's (or BASE's) own copy, resolved as './merchant-identity' from merchant-inventory */
if (process.env.BASE) { const mi = load('merchant-identity.js'); require.cache[path.join(FN, 'merchant-identity.js')] = { id: 'mi', filename: path.join(FN, 'merchant-identity.js'), loaded: true, exports: require(mi) }; }
const H = require(load('merchant-inventory.js')).merchantAdjustStock;
const run = async (uid, data) => { try { return await H.run({ auth: uid ? { uid, token: {} } : null, data }); } catch (e) { return { err: e.code || 'error', reason: (e.details && e.details.reason) || e.message }; } };
const world = () => ({
  shops: { ownerA: { ownerId: 'ownerA', sellerUid: 'ownerA', name: 'A' }, ownerB: { ownerId: 'ownerB', sellerUid: 'ownerB', name: 'B' } },
  users: { ownerA: { name: 'Owner A' } },
  shopEmployees: {
    invA: { shopOwnerId: 'ownerA', role: 'inventory', status: 'active', name: 'Inv' },
    mgrA: { shopOwnerId: 'ownerA', role: 'manager', status: 'active', name: 'Mgr' },
    cashA: { shopOwnerId: 'ownerA', role: 'cashier', status: 'active', name: 'Cash' },
    staffA: { shopOwnerId: 'ownerA', role: 'staff', status: 'active', name: 'Staff' },
    invB: { shopOwnerId: 'ownerB', role: 'inventory', status: 'active', name: 'InvB' },
    oddA: { shopOwnerId: 'ownerA', role: 'support', status: 'active', name: 'Odd' },
  },
  products: { pA: { sellerUid: 'ownerA', shopId: 'ownerA', name: 'Sugar', stock: 10, inventoryVersion: 1 }, pB: { sellerUid: 'ownerB', shopId: 'ownerB', name: 'Salt', stock: 5 }, pLegacyB: { sellerUid: 'ownerB', name: 'Legacy no shopId', stock: 5 } },
});
const adj = (shopId, productId, id, delta) => ({ shopId, productId, adjustmentId: id, delta, reason: 'restock' });
const untouched = (id, stock) => DB._store.products[id].stock === stock && !Object.keys(DB._store.stockMovements || {}).length;

(async () => {
  DB = fakeDb(world());
  let r = await run('invA', adj('ownerA', 'pA', 'a1', 5));
  const mv = (DB._store.stockMovements || {}).a1 || {};
  ck('S-1', !r.err && DB._store.products.pA.stock === 15 && mv.actorUid === 'invA' && mv.actorRole === 'inventory' && mv.before === 10 && mv.after === 15 && mv.reason === 'restock',
    'an INVENTORY employee adjusts the shop\'s stock; the movement records actor, role, before/after and reason', { r, mv });
  DB = fakeDb(world());
  r = await run('mgrA', adj('ownerA', 'pA', 'a2', -2));
  ck('S-2', !r.err && DB._store.products.pA.stock === 8, 'a MANAGER adjusts stock', r);
  DB = fakeDb(world());
  r = await run('cashA', adj('ownerA', 'pA', 'a3', 5));
  ck('S-3', !!r.err && untouched('pA', 10), 'a CASHIER cannot adjust stock (nothing written)', r);
  DB = fakeDb(world());
  r = await run('staffA', adj('ownerA', 'pA', 'a4', 5));
  ck('S-4', !!r.err && untouched('pA', 10), 'plain STAFF cannot adjust stock', r);
  DB = fakeDb(world());
  r = await run('invB', adj('ownerA', 'pA', 'a5', 5));
  ck('S-5', !!r.err && untouched('pA', 10), 'another shop\'s inventory employee cannot adjust this shop\'s stock', r);
  DB = fakeDb(world());
  r = await run('invA', adj('ownerA', 'pB', 'a6', 5));
  ck('S-6', !!r.err && DB._store.products.pB.stock === 5, 'an inventory employee cannot adjust ANOTHER owner\'s product through their shop', r);
  DB = fakeDb(world());
  r = await run('invA', adj('ownerA', 'pLegacyB', 'a6b', 5));
  ck('S-6b', !!r.err && DB._store.products.pLegacyB.stock === 5, "a LEGACY product of another owner (no shopId) cannot be adjusted by this shop's staff (the owner check on its own)", r);
  DB = fakeDb(world());
  r = await run('oddA', adj('ownerA', 'pA', 'a7', 5));
  ck('S-7', !!r.err && untouched('pA', 10), 'an employee role the staff authority does not define gets nothing', r);
  DB = fakeDb(world());
  r = await run('ownerA', adj('ownerA', 'pA', 'a8', 3));
  ck('S-8', !r.err && DB._store.products.pA.stock === 13 && DB._store.stockMovements.a8.actorRole === 'owner', 'CONTROL: the owner path is unchanged', r);
  DB = fakeDb(world());
  r = await run('ownerA', adj('SOK-123', 'pA', 'a9', 1));
  ck('S-9', !!r.err, 'CONTROL: the owner filing under a shopId the product does not carry is still refused (existing shop check)', r);
  DB = fakeDb(world());
  r = await run('stranger', adj('ownerA', 'pA', 'a10', 5));
  ck('S-10', !!r.err && untouched('pA', 10), 'a stranger cannot adjust stock', r);
  DB = fakeDb(world());
  await run('invA', adj('ownerA', 'pA', 'dup', 5)); r = await run('invA', adj('ownerA', 'pA', 'dup', 5));
  ck('S-11', r.idempotent === true && DB._store.products.pA.stock === 15, 'a replayed staff adjustment moves stock ONCE', r);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
