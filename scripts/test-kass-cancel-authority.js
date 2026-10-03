#!/usr/bin/env node
/* SECURITY CONVERGENCE 2026-10-03 — the AI assistant (KASS) cancels only an UNPAID order the buyer owns; a paid order is
 * never cancelled by it, and it promises no refund it cannot create.
 *   node scripts/test-kass-cancel-authority.js        BASE=dda12d11c4 node scripts/test-kass-cancel-authority.js (live — must FAIL)
 * Drives the REAL tool executor (_execChatTool, the function the kass endpoint calls for the AI's tool use) through the
 * malicious AI path itself, on an in-memory Firestore. A temp COPY of index.js gets a test-only export appended — the
 * production file exports nothing extra. */
'use strict';
const path = require('path'), fs = require('fs'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { fakeDb } = require('./lib/fake-firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
console.log('\nKASS cancel_order authority   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const src = process.env.BASE ? execSync('git show ' + process.env.BASE + ':functions/index.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
const tmp = path.join(FN, '.kasstest-' + process.pid + '.js');
fs.writeFileSync(tmp, src + '\nmodule.exports.__execChatTool = _execChatTool;\n');
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (_) {} });
/* The live index.js requires ./mpesa-c2b, which Route B removed from this tree: for a BASE run only, restore it
   temporarily (removed again on exit) so the base is measured, not crashed. */
if (process.env.BASE && !fs.existsSync(path.join(FN, 'mpesa-c2b.js'))) {
  const p = path.join(FN, 'mpesa-c2b.js');
  try { fs.writeFileSync(p, execSync('git show ' + process.env.BASE + ':functions/mpesa-c2b.js', { cwd: ROOT })); process.on('exit', () => { try { fs.unlinkSync(p); } catch (_) {} }); } catch (_) {}
}

let DB = fakeDb({});
const realFS = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
const adminPath = require.resolve('firebase-admin', { paths: [FN] });
const proxy = new Proxy({}, { get: (_, k) => (k === 'getAll' ? (...r) => Promise.all(r.map((x) => x.get())) : (typeof DB[k] === 'function' ? DB[k].bind(DB) : DB[k])) });
const fsFn = () => proxy; fsFn.FieldValue = realFS.FieldValue; fsFn.Timestamp = realFS.Timestamp;
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { firestore: fsFn, apps: [1], initializeApp() {}, auth: () => ({ getUser: async () => ({}) }), messaging: () => ({ send: async () => ({}) }), storage: () => ({ bucket: () => ({}) }) } };
const fsPath = require.resolve('firebase-admin/firestore', { paths: [FN] });
require.cache[fsPath] = { id: fsPath, filename: fsPath, loaded: true, exports: Object.assign({}, realFS, { getFirestore: () => proxy }) };
const _log = console.log; console.log = () => {};
let I; try { I = require(tmp); } catch (e) { console.log = _log; console.log('CRASH loading index.js (no verdict): ' + e.message.split('\n')[0]); process.exit(2); }
console.log = _log;
const tool = async (uid, input) => I.__execChatTool('cancel_order', input, { uid, addAction() {} });
const W = (o) => ({ orders: { O1: Object.assign({ uid: 'buyer1', sellerUid: 's1' }, o) } });

(async () => {
  DB = fakeDb(W({ status: 'confirmed', paymentVerified: true, paymentStatus: 'paid' }));
  let r = await tool('buyer1', { orderId: 'O1', reason: 'changed my mind' });
  ck('K-1', DB._store.orders.O1.status === 'confirmed' && r && r.refundRequest === true, 'EXPLOIT: the AI cannot cancel a PAID (confirmed) order; it points to a refund request', { r, status: DB._store.orders.O1.status });
  ck('K-2', !/refund will be processed/i.test(JSON.stringify(r)), 'the AI does not promise a refund it cannot create', r);
  DB = fakeDb(W({ status: 'pending', paymentStatus: 'paid', paid: true }));
  r = await tool('buyer1', { orderId: 'O1' });
  ck('K-3', DB._store.orders.O1.status === 'pending', 'a PAID order still showing `pending` is not cancelled either (payment evidence, not the status string)', { r, status: DB._store.orders.O1.status });
  DB = fakeDb(W({ status: 'pending_payment' }));
  r = await tool('buyer1', { orderId: 'O1' });
  ck('K-4', r.success === true && DB._store.orders.O1.status === 'cancelled' && DB._store.orders.O1.cancellationSource === 'kass_ai', 'CONTROL: an UNPAID order the buyer owns is cancelled', r);
  r = await tool('buyer1', { orderId: 'O1' });
  ck('K-5', r.success === true && r.idempotent === true, 'a repeat cancel is idempotent', r);
  DB = fakeDb(W({ status: 'pending_payment' }));
  r = await tool('stranger', { orderId: 'O1' });
  ck('K-6', !!r.error && DB._store.orders.O1.status === 'pending_payment', 'another user cannot cancel the order through the AI', r);
  r = await tool(null, { orderId: 'O1' });
  ck('K-7', r.requiresAuth === true, 'signed out → refused', r);
  DB = fakeDb(W({ status: 'pending_payment', uid: undefined, buyerUid: 'buyer1' }));
  r = await tool('buyer1', { orderId: 'O1' });
  ck('K-8', r.success === true, 'CONTROL: a buyer recorded as buyerUid (checkout shape) is recognised as the owner', r);
  r = await tool('buyer1', { orderId: '../users/x' });
  ck('K-9', !!r.error, 'a path-like order id is refused', r);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
