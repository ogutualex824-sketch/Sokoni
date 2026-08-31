#!/usr/bin/env node
/**
 * SHOP TEAM CALLABLES — the three the Staff surface needs.
 *
 *   node scripts/test-shop-team-callables.js
 *
 * The shell called listShopEmployees, listShopInvites and removeShopEmployee; none of the
 * three existed, so Staff 404'd on open and the client SDK surfaced it as "internal".
 *
 * The two things that must hold, and would be invisible if they did not:
 *
 *   1. OWNERSHIP IS THE CALLER'S TOKEN, NEVER THE PAYLOAD. The client sends a shopId for
 *      its own bookkeeping. If any of these bound authority to it, a forged shopId would
 *      read or mutate another merchant's team.
 *
 *   2. REMOVAL MUST ACTUALLY REVOKE. merchant-identity.js decides employment from
 *      `status`, treating an ABSENT status as active for records predating the field.
 *      Writing active:false alone would show a person as removed in the UI while leaving
 *      their authorisation intact — a silent hole, not a cosmetic one.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const IDX = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 96) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

/* the body of one exported callable */
/* Balance PARENTHESES from onCall(, not braces: onCall({}, async (request) => { … })
   opens with an EMPTY options object, so a brace matcher closes immediately and returns
   `exports.X = onCall({}` — which made every body assertion fail against correct code. */
function body (name) {
  const key = 'exports.' + name + ' = onCall(';
  const i = IDX.indexOf(key);
  if (i === -1) return null;
  let d = 0;
  for (let k = i + key.length - 1; k < IDX.length; k++) {
    const c = IDX[k];
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) return IDX.slice(i, k + 1); }
  }
  return null;
}

const NAMES = ['listShopEmployees', 'listShopInvites', 'removeShopEmployee'];

console.log(NL + 'SHOP TEAM CALLABLES' + NL + '='.repeat(58));

head('1 · all three exist');
NAMES.forEach((n) => ck(n + ' is exported', !!body(n)));

head('2 · authority is the token, never the payload');
NAMES.forEach((n) => {
  const b = body(n) || '';
  ck(n + ' requires authentication',
     b.indexOf('if (!request.auth)') > -1 && b.indexOf('unauthenticated') > -1);
  ck(n + ' binds ownership to request.auth.uid',
     b.indexOf('const owner = request.auth.uid;') > -1);
  ck(n + ' NEVER takes shopId from the payload',
     b.indexOf('request.data.shopId') === -1 && b.indexOf('data.shopId') === -1,
     'a forged shopId must not be able to reach another merchant team');
});

head('3 · the reads are scoped to the caller');
['listShopEmployees', 'listShopInvites'].forEach((n) => {
  const b = body(n) || '';
  ck(n + ' queries by shopOwnerId == owner',
     /where\("shopOwnerId", "==", owner\)/.test(b));
  ck(n + ' bounds the result set', /\.limit\(\d+\)/.test(b),
     'an unbounded read is a cost and a latency defect');
});
ck('listShopEmployees hides revoked members',
   /\.filter\(\(e\) => e\.active\)/.test(body('listShopEmployees') || ''),
   'a revoked record is not a team member');
ck('listShopInvites reports expiry rather than hiding it',
   (body('listShopInvites') || '').indexOf('staleCount') > -1,
   'an expired invite is still pending in the record; the surface should say so');

head('4 · removal is a REAL revocation');
const rm = body('removeShopEmployee') || '';
ck('it verifies the record belongs to the caller before touching it',
   rm.indexOf('.shopOwnerId !== owner') > -1 && rm.indexOf('permission-denied') > -1);
ck('it writes status:revoked — the field authorisation actually reads',
   rm.indexOf('status:    _SHOP_EMP_REVOKED') > -1 || rm.indexOf('_SHOP_EMP_REVOKED') > -1,
   'merchant-identity.js reads status, NOT active');
ck('...and keeps active:false in step for anything reading that instead',
   rm.indexOf('active:    false') > -1 || rm.indexOf('active: false') > -1);
ck('CONTROL it does not rely on active:false ALONE',
   rm.indexOf('_SHOP_EMP_REVOKED') > -1,
   'active:false alone would show removal in the UI while authorisation survived');
ck('it does NOT touch users.role',
   !/role:\s*['"]/.test(rm) && rm.indexOf('protectedRoles') === -1,
   'demoting an account is the role authority decision, not a shop owner privilege');
ck('...but it does clear the employment pointers',
   rm.indexOf('employeeRole: admin.firestore.FieldValue.delete()') > -1);

head('5 · the predicate matches the server that enforces it');
const MI = fs.readFileSync(path.join(ROOT, 'functions/merchant-identity.js'), 'utf8');
ck('merchant-identity still decides employment from status',
   MI.indexOf("const ACTIVE_EMPLOYMENT = ['active', 'approved', 'enabled'];") > -1,
   'if this changes, the revocation field changes with it');
ck('...and still treats an absent status as active',
   /function _employmentActive[\s\S]{0,200}if \(!st\) return true;/.test(MI),
   'which is exactly why active:false alone would not have revoked anything');
ck('CONTROL the shared vocabulary is the same in both files',
   (body('listShopEmployees') || '').indexOf('"approved"') > -1 ||
   IDX.indexOf('["active", "approved", "enabled"]') > -1);

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
