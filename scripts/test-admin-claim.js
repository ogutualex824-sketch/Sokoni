/* Canonical admin claim check.

   The tests that matter here are the DENIALS. A bug that denies an admin is an
   outage; a bug that admits a non-admin is a breach, and this helper now sits in
   front of 24 guards across 11 modules.

   Context: those guards previously read `token.isAdmin`, a claim nothing in this
   codebase has ever written, so they denied every caller including real
   administrators — silently, with a correct-looking permission-denied. */
'use strict';
const A = require('../functions/admin-claim');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};

console.log('\n── Canonical claims are accepted ──');
ck('admin:true is admin',              A.isAdmin({ admin: true }) === true);
ck('superAdmin:true is admin',         A.isAdmin({ superAdmin: true }) === true);
ck('superAdmin:true is superAdmin',    A.isSuperAdmin({ superAdmin: true }) === true);
ck("role:'admin' is admin",            A.isAdmin({ role: 'admin' }) === true);

console.log('\n── admin does NOT imply superAdmin ──');
/* super-admin.js documents this deliberately: role management and account
   suspension require superAdmin specifically. */
ck('admin is NOT superAdmin',          A.isSuperAdmin({ admin: true }) === false);
ck("role:'admin' is NOT superAdmin",   A.isSuperAdmin({ role: 'admin' }) === false);

console.log('\n── Legacy spellings still honoured ──');
ck('isAdmin:true accepted',            A.isAdmin({ isAdmin: true }) === true);
ck('isSuperAdmin:true accepted',       A.isSuperAdmin({ isSuperAdmin: true }) === true);

console.log('\n── Denials ──');
const DENY = [
  ['empty token',        {}],
  ['plain user',         { uid: 'u1', email: 'a@b.c' }],
  ['seller',             { seller: true }],
  ['beta admitted',      { betaStatus: 'approved', betaAdmitted: true }],
  ['admin:false',        { admin: false }],
  ['admin as string',    { admin: 'true' }],
  ['admin as 1',         { admin: 1 }],
  ["role:'user'",        { role: 'user' }],
  ["role:'moderator'",   { role: 'moderator' }],
  ['null',               null],
  ['undefined',          undefined],
];
DENY.forEach(([l, t]) => ck(l + ' denied', A.isAdmin(t) === false));

console.log('\n── Truthy-but-not-true must not pass (the classic hole) ──');
ck("admin:'yes' denied",               A.isAdmin({ admin: 'yes' }) === false);
ck('admin:{} denied',                  A.isAdmin({ admin: {} }) === false);
ck('superAdmin:1 denied',              A.isSuperAdmin({ superAdmin: 1 }) === false);

console.log('\n── Accepts every shape the call sites pass ──');
const tok = { admin: true };
ck('a raw token',                      A.isAdmin(tok) === true);
ck('a request.auth',                   A.isAdmin({ token: tok }) === true);
ck('an onCall request',                A.isAdmin({ auth: { uid: 'u', token: tok } }) === true);
ck('unauthenticated request denied',   A.isAdmin({ auth: null }) === false);
ck('request with no token denied',     A.isAdmin({ auth: { uid: 'u' } }) === false);

console.log('\n── Support / finance desks ──');
ck('admin counts as support',          A.isSupport({ admin: true }) === true);
ck('support:true is support',          A.isSupport({ support: true }) === true);
ck('plain user is not support',        A.isSupport({ uid: 'u' }) === false);
ck('admin counts as finance',          A.isFinance({ admin: true }) === true);
ck('plain user is not finance',        A.isFinance({ uid: 'u' }) === false);

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
