/* Unit test for migrate-user-baselines.js computeUserPlan — the server-side plan:
   reuse the client planners + backfill createdAt from the REAL Auth creation time,
   idempotent, never-overwrite. Pure (inject tsFromDate); no admin init, no network. */
'use strict';
const path = require('path');
const { computeUserPlan } = require(path.join(__dirname, 'migrate-user-baselines.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

const CT = 'Wed, 01 Jan 2025 00:00:00 GMT';
const tsFromDate = (d) => ({ __ts: d.toISOString() });          /* mock Timestamp */
const rec = { uid: 'U1', displayName: 'Jane', email: 'j@x.com', phoneNumber: '+254700', photoURL: '', creationTime: CT };

/* 1) brand-new account (no docs) → create everything, createdAt from Auth time */
const a = computeUserPlan(rec, { user: null, wallet: null, notif: null }, tsFromDate);
ok(a.userDoc.op === 'create', 'no user doc → create');
ok(a.userDoc.data.createdAt && a.userDoc.data.createdAt.__ts === '2025-01-01T00:00:00.000Z', 'createdAt from real Auth creationTime');
ok(a.userDoc.data.roles && a.userDoc.data.roles[0] === 'buyer', 'roles seeded');
ok(a.wallet.op === 'create' && a.wallet.data.balance === 0, 'wallet create balance 0');
ok(a.notif.op === 'create', 'notifPrefs create');

/* 2) fully complete account → NOTHING to write (idempotent) */
const complete = { uid:'U1', name:'Jane', email:'j@x.com', phoneNumber:'+254700', roles:['buyer'],
  registeredAs:{user:true}, accountStatus:'active', onboardingCompleted:true, onboardingRequired:false, createdAt:{seconds:1} };
const b = computeUserPlan(rec, { user: complete, wallet: { balance: 10 }, notif: { email: true } }, tsFromDate);
ok(b.userDoc.op === 'none', 'complete account → no user write, got ' + b.userDoc.op);
ok(b.wallet.op === 'none', 'existing wallet → no write');
ok(b.notif.op === 'none', 'existing prefs → no write');

/* 3) doc complete EXCEPT createdAt → update with ONLY createdAt */
const noCreated = { uid:'U1', name:'Jane', email:'j@x.com', phoneNumber:'+254700', roles:['buyer'],
  registeredAs:{user:true}, accountStatus:'active', onboardingCompleted:true, onboardingRequired:false };
const c = computeUserPlan(rec, { user: noCreated, wallet: { balance: 0 }, notif: { email: true } }, tsFromDate);
ok(c.userDoc.op === 'update', 'missing createdAt only → update');
ok(Object.keys(c.userDoc.data).length === 1 && c.userDoc.data.createdAt, 'update carries ONLY createdAt, keys=' + Object.keys(c.userDoc.data));

/* 4) has user doc + createdAt but missing wallet → only wallet create, user untouched */
const d = computeUserPlan(rec, { user: complete, wallet: null, notif: { email: true } }, tsFromDate);
ok(d.userDoc.op === 'none', 'complete user doc untouched when only wallet missing');
ok(d.wallet.op === 'create', 'missing wallet → create');

/* 5) never-overwrite: an update plan must not carry a key the doc already has (except createdAt backfill) */
const partial = { uid:'U1', email:'j@x.com', roles:['seller'], registeredAs:{user:true,seller:true}, accountStatus:'active', onboardingCompleted:true, onboardingRequired:false };
const e = computeUserPlan(rec, { user: partial, wallet: { balance: 0 }, notif: { email: true } }, tsFromDate);
if (e.userDoc.op === 'update') Object.keys(e.userDoc.data).forEach(k => {
  ok(k === 'createdAt' || partial[k] === undefined, 'no-overwrite: only fills missing (or createdAt), not ' + k);
});
ok(e.userDoc.data.roles === undefined, 'existing roles:[seller] preserved (not reset to buyer)');

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
