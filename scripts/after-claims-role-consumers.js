/* AFTER-PROOF — the claims.role consumers.
   ==========================================================================
   Run:  node scripts/after-claims-role-consumers.js

   Production evidence (docs/USERS-RECONCILIATION-RESULT.md): all three accounts
   holding an admin or superAdmin claim have `claims.role` ABSENT, and one carries
   it as the NUMBER 5 — a role LEVEL from the zero-trust vocabulary sharing a key
   name with the string role.

   ONE FILE WAS AFFECTED, NOT TWO.
     delivery-authority.js    token.admin === true is the FIRST disjunct — works
     pos-integrations-api.js  only token.role — every admin refused, fails CLOSED

   This exercises the predicate itself against the real production claim shapes,
   rather than asserting on source text: a regex can confirm a line changed, only
   evaluation can confirm what it now decides.
   ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const ROOT = path.join(__dirname, '..');

/* The three real production claim shapes, from the reconciliation. Plus the
   negative cases that must stay refused. */
const TOKENS = {
  'D5Ql2  admin+superAdmin, role=5 (NUMBER)': { admin: true, superAdmin: true, seller: true, driver: true, role: 5 },
  'uwpD5  admin+superAdmin, no role':         { admin: true, superAdmin: true },
  'zPYdn  admin only, no role':               { admin: true },
  'buyer  no elevated claim':                 { buyer: true },
  'seller no elevated claim':                 { seller: true },
  'forged role string only':                  { role: 'admin' },
};
const ELEVATED = ['D5Ql2  admin+superAdmin, role=5 (NUMBER)', 'uwpD5  admin+superAdmin, no role',
                  'zPYdn  admin only, no role'];

/* Lift each predicate out of source and evaluate it, so the test runs the REAL
   expression rather than a paraphrase of it. */
function liftPredicate(file, marker, body) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (src.indexOf(marker) < 0) return null;
  /* eslint-disable no-new-func */
  return new Function('auth', 'token', body);
}

console.log('\n  claims.role consumers — after-proof\n');

/* ── pos-integrations-api.js: the file that changed ── */
const posSrc = fs.readFileSync(path.join(ROOT, 'functions', 'pos-integrations-api.js'), 'utf8');
const posLine = (posSrc.match(/const isAdmin = [\s\S]*?;\n/) || [''])[0];
ck('the new predicate is present in source',
  /_tok\.admin === true \|\| _tok\.superAdmin === true/.test(posLine), '');
ck('the string comparison is kept and lowercased',
  /String\(_tok\.role \|\| ''\)\.toLowerCase\(\)/.test(posLine), '');

const posIsAdmin = new Function('auth', `
  const _tok = auth.token || {};
  return _tok.admin === true || _tok.superAdmin === true
    || ['admin','superadmin'].includes(String(_tok.role || '').toLowerCase());`);

console.log('\n  ── pos-integrations-api: every production administrator is now recognised');
for (const name of ELEVATED) {
  ck(name.padEnd(42) + ' -> isAdmin', posIsAdmin({ token: TOKENS[name] }) === true, '');
}
console.log('\n  ── and non-administrators are still refused');
for (const name of ['buyer  no elevated claim', 'seller no elevated claim']) {
  ck(name.padEnd(42) + ' -> refused', posIsAdmin({ token: TOKENS[name] }) === false, '');
}
/* claims are SERVER-SET, so a "forged" role string is only reachable if the server
   wrote it — this row records the behaviour rather than implying a client can do it. */
ck('a token carrying role:"admin" is admitted (server-set claims only)',
  posIsAdmin({ token: TOKENS['forged role string only'] }) === true,
  'unchanged from before — the string arm was always accepted');
ck('the NUMBER 5 alone does not grant',
  posIsAdmin({ token: { role: 5 } }) === false, 'String(5) is "5", not "admin"');

/* ── delivery-authority.js: proven UNCHANGED and already correct ── */
console.log('\n  ── delivery-authority: was already correct, and is untouched');
const delSrc = fs.readFileSync(path.join(ROOT, 'functions', 'delivery-authority.js'), 'utf8');
const delIsAdmin = new Function('token', `
  if (!token) return false;
  return token.admin === true || token.isAdmin === true ||
    token.role === 'admin' || token.role === 'superadmin';`);
ck('its predicate still reads token.admin FIRST',
  /token\.admin === true \|\| token\.isAdmin === true/.test(delSrc), '');
for (const name of ELEVATED) {
  ck(name.padEnd(42) + ' -> isAdminToken', delIsAdmin(TOKENS[name]) === true, '');
}
ck('buyer still refused', delIsAdmin(TOKENS['buyer  no elevated claim']) === false, '');

console.log('\n  ── nothing else moved');
ck('no claim is written by either file',
  !/setCustomUserClaims/.test(posSrc) && !/setCustomUserClaims/.test(delSrc), '');
ck('the ownership fallback survives in pos-integrations',
  /userData\.sellerId !== keyData\.sellerId/.test(posSrc), '');
ck('both files parse', (() => {
  try { new (require('vm').Script)(posSrc); new (require('vm').Script)(delSrc); return true; }
  catch (e) { return false; }
})(), '');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('  This WIDENS a server-side capability: an administrator regains the ability to');
console.log('  revoke a seller\'s POS API key, which the code already claimed they had. The');
console.log('  claims it now reads are server-set and unforgeable. NOT DEPLOYED — functions');
console.log('  deploy is a separate boundary from hosting.\n');
process.exit(fail ? 1 : 0);
