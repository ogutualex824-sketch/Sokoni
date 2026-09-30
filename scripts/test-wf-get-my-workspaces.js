/* test-wf-get-my-workspaces.js — the employee's workspaces read needs NO composite index.
 *
 *   node scripts/test-wf-get-my-workspaces.js        (no emulator, no network)
 *
 * 2026-09-30: production logged FAILED_PRECONDITION "The query requires an index" for
 * workspaceInvitations (invitedUid + status + sentAt) and account-centre received `internal`.
 * The reads are now equality-only, bounded, and sorted in memory newest-first.
 */
'use strict';
const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
stub('firebase-functions/v2/https', { onCall: (o, h) => Object.assign(h, { _opts: o }), HttpsError });
stub('firebase-functions/v2/firestore', { onDocumentCreated: () => () => {}, onDocumentUpdated: () => () => {}, onDocumentWritten: () => () => {}, onDocumentDeleted: () => () => {} });
stub('firebase-functions/v2/scheduler', { onSchedule: () => () => {} });
stub('firebase-functions/v2', { logger: { info() {}, warn() {}, error() {}, debug() {} } });
stub('firebase-functions/logger', { info() {}, warn() {}, error() {}, debug() {} });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({ getUser: async () => ({}) , setCustomUserClaims: async () => {} }) });
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };

console.log('\nwfGetMyWorkspaces — index-free reads, newest first');
console.log('='.repeat(70));
const SRC = fs.readFileSync(Path.join(FN, 'workforce-identity.js'), 'utf8');
const fnSrc = SRC.slice(SRC.indexOf('exports.wfGetMyWorkspaces'), SRC.indexOf('exports.wfGetMyWorkspaces') + 2500);
ck('the two reads carry no orderBy (no composite index needed)', !/\.orderBy\(/.test(fnSrc.slice(0, fnSrc.indexOf('const membershipsSnap'))));
ck('both reads are bounded', (fnSrc.match(/\.limit\(200\)/g) || []).length === 2);
ck('sorted in memory newest-first on addedAt and sentAt', /_newestFirst\('addedAt'\)/.test(fnSrc) && /_newestFirst\('sentAt'\)/.test(fnSrc));

(async () => {
  let M;
  try { M = require(Path.join(FN, 'workforce-identity.js')); } catch (e) { ck('workforce-identity.js loads under stubs', false, e.message); console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
  const T = (ms) => F.Timestamp.fromMillis(ms);
  await db.doc('workspaceMemberships/m1').set({ uid: 'emp', businessId: 'b1', businessName: 'Old Co', role: 'cashier', status: 'active', addedAt: T(1000) });
  await db.doc('workspaceMemberships/m2').set({ uid: 'emp', businessId: 'b2', businessName: 'New Co', role: 'manager', status: 'active', addedAt: T(5000) });
  await db.doc('workspaceMemberships/m3').set({ uid: 'other', businessId: 'b3', businessName: 'Not Mine', role: 'cashier', status: 'active', addedAt: T(9000) });
  await db.doc('workspaceInvitations/i1').set({ invitedUid: 'emp', status: 'pending', businessName: 'A', sentAt: T(2000) });
  await db.doc('workspaceInvitations/i2').set({ invitedUid: 'emp', status: 'pending', businessName: 'B', sentAt: T(7000) });
  await db.doc('workspaceInvitations/i3').set({ invitedUid: 'emp', status: 'accepted', businessName: 'C', sentAt: T(8000) });
  let r = null, err = null;
  try { r = await M.wfGetMyWorkspaces({ auth: { uid: 'emp', token: {} }, data: {} }); } catch (e) { err = e; }
  ck('the callable answers without FAILED_PRECONDITION', !!r && !err, err && (err.code + ' ' + err.message));
  if (r) {
    const all = [].concat(r.active || [], r.past || [], r.memberships || []);
    const names = all.map((m) => m.businessName);
    ck('only the caller\'s memberships, newest first (New Co, Old Co)', names[0] === 'New Co' && names[1] === 'Old Co' && !names.includes('Not Mine'), names);
    const inv = (r.pending || r.pendingInvites || r.invites || []).map((i) => i.businessName);
    ck('only PENDING invites, newest first (B, A)', inv[0] === 'B' && inv[1] === 'A' && !inv.includes('C'), inv);
  }
  let denied = null; try { await M.wfGetMyWorkspaces({ auth: null, data: {} }); } catch (e) { denied = e.code; }
  ck('unauthenticated → refused', denied === 'unauthenticated', denied);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { ck('suite ran', false, e.stack && e.stack.slice(0, 300)); process.exit(1); });
