#!/usr/bin/env node
/**
 * POS RETAIL ENGINE — a seller may only write their OWN books.
 *
 *   node scripts/test-pos-retail-tenant-binding.js
 *
 * THE DEFECT THIS CLOSES
 * `recordPOSSale` is reachable in production: smartpos-dispatch merges
 * posRetailEngine._h, and smartPosDispatch routes to it by `op` name while adding NO
 * authorization of its own. Its only gate was `_adminOrSeller`, which establishes that
 * the caller IS a seller — never WHICH shop's books they may write.
 *
 * `sellerId` and `cashierUid` were then read from the request payload and merely
 * DEFAULTED to auth.uid. Any caller holding a seller claim could therefore record a sale
 * into another shop's posSales, attributed to any cashier they named.
 *
 * WHY THE BINDING IS SAFE TO ADD
 * `sellers/{id}` is keyed by the owner's uid — pos-onboard.html writes
 * sellers/{currentUser.uid} — so identity IS the document id, exactly as shops/{uid} is
 * in resolveActor. There is no ownerId field to forge. The only known client sends
 * neither `sellerId` nor `cashierUid`, so binding both to the token breaks no caller.
 *
 * THE OTHER SEVEN, REPAIRED 2026-09-01
 * `sellerId || auth.uid` appeared in seven further handlers. Five sat behind
 * `_adminOrSeller`, so any seller could read any shop's analytics, alerts, insights and
 * reorder data. Two — `getBranchComparison` and `initiateInventoryTransfer` — sat behind
 * `_authRequired` alone, so ANY authenticated account could read another merchant's branch
 * revenue, or file a pending transfer into their queue (pos-hq lists those by sellerId) and
 * emit a platform event carrying the forged shop id. All seven now share one binding helper,
 * and both weak gates were raised to `_adminOrSeller`.
 *
 * STILL NOT FIXED: an employee cannot use these on an owner's behalf, because no employee
 * store may be chosen here. That is fail-closed and is restored by authority convergence.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const RE = fs.readFileSync(path.join(ROOT, 'functions/pos-retail-engine.js'), 'utf8');
const DISPATCH = fs.readFileSync(path.join(ROOT, 'functions/smartpos-dispatch.js'), 'utf8');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 96) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

/* recordPOSSale only. A whole-file assertion would be satisfied by any of the other
   handlers, which is exactly the confusion this suite exists to prevent. */
const FN = (function () {
  const a = RE.indexOf('exports.recordPOSSale = onCall(');
  if (a === -1) return '';
  const b = RE.indexOf('exports.getPOSSale = onCall(', a);
  return b === -1 ? RE.slice(a) : RE.slice(a, b);
})();

console.log(NL + 'POS RETAIL TENANT BINDING' + NL + '='.repeat(60));

/* ── 1 · the function is genuinely reachable ──────────────────────────────── */
head('1 · this is a live path, not dead code');
ck('CONTROL the handler body was isolated', FN.length > 2000, FN.length + ' chars');
ck('the dispatcher merges this module handler registry',
   DISPATCH.indexOf('posRetailEngine._h') > -1);
ck('the dispatcher routes by op name', DISPATCH.indexOf('const handler = _H[op];') > -1);
ck('CONTROL the dispatcher adds no authorization of its own',
   DISPATCH.indexOf('_adminOrSeller') === -1 && DISPATCH.indexOf('resolveActor') === -1,
   'the handler own gate is therefore the entire gate');

/* ── 2 · the binding ──────────────────────────────────────────────────────── */
head('2 · a caller cannot write another shop books');
ck('the seller id is derived once, up front',
   FN.indexOf('const _sellerId  = _san(sellerId || auth.uid, 40);') > -1);
ck('a non-admin naming another shop is REFUSED',
   FN.indexOf('if (!_isAdmin && _sellerId !== auth.uid) {') > -1 &&
   FN.indexOf("'A sale can only be recorded for your own shop.'") > -1);
ck('the refusal is permission-denied',
   FN.indexOf("throw new HttpsError('permission-denied',") > -1);
ck('CONTROL admin remains able to act, and is the ONLY exception',
   FN.indexOf('_claims.admin || _claims.role') > -1 &&
   (FN.split('_isAdmin').length - 1) === 2,
   'declared once, consumed once — no second escape hatch');

/* ── 3 · the cashier is whoever called ────────────────────────────────────── */
head('3 · a caller cannot attribute the sale to another cashier');
ck('cashierUid is auth.uid unconditionally',
   FN.indexOf('const _cashierUid = auth.uid;') > -1,
   'matches posCompleteCheckout, where cashierId is auth.uid regardless');
ck('NEGATIVE the payload value never reaches the write',
   FN.indexOf('cashierUid || auth.uid') === -1,
   'defaulting is not binding — the payload won whenever it was present');

/* ── 4 · every write site uses the bound values ───────────────────────────── */
head('4 · no client identity survives anywhere in the handler');
ck('the sale record uses the bound seller', FN.indexOf('sellerId:      _sellerId,') > -1);
ck('the sale record uses the bound cashier', FN.indexOf('cashierUid:    _cashierUid,') > -1);
ck('the receipt uses the bound seller', FN.indexOf('sellerId: _sellerId,') > -1);
ck('the emitted event uses the bound seller',
   FN.indexOf('sellerId: _sellerId, total, itemCount:') > -1,
   'an event carrying a forged shop id would poison every downstream subscriber');
ck('the seller document lookup uses the bound id',
   FN.indexOf('.doc(_sellerId).get();') > -1,
   'looking up one shop and writing another would be worse than not checking');
ck('NEGATIVE no unbound identity remains in the handler',
   FN.indexOf('sellerId || auth.uid') === FN.lastIndexOf('sellerId || auth.uid') &&
   FN.indexOf('const _sellerId  = _san(sellerId || auth.uid, 40);') > -1,
   'the single remaining occurrence IS the binding');

/* ── 5 · the other seven handlers are now bound too ───────────────────────── */
head('5 · every sellerId handler in this file is bound');
/* Comments mention the old pattern while explaining it, so the census runs on stripped
   source — otherwise the prose would be counted as a defect. */
const CODE = (function () {
  let out = '', i = 0, inB = false;
  while (i < RE.length) {
    if (!inB && RE[i] === '/' && RE[i + 1] === '*') { inB = true; i += 2; continue; }
    if (inB && RE[i] === '*' && RE[i + 1] === '/') { inB = false; i += 2; continue; }
    if (!inB) out += RE[i];
    i++;
  }
  return out;
})();
ck('CONTROL the comment stripper works',
   CODE.indexOf('a DEFAULT, not a binding') === -1 && CODE.length > 20000);
const REST = CODE.replace(CODE.slice(CODE.indexOf('exports.recordPOSSale'),
                                     CODE.indexOf('exports.getPOSSale')), '');
const restCount = (REST.match(/sellerId \|\| auth\.uid/g) || []).length;
ck('NO unbound sellerId site remains outside recordPOSSale', restCount === 0,
   restCount + ' remaining');
ck('the single remaining occurrence IS recordPOSSale own binding',
   (CODE.match(/sellerId \|\| auth\.uid/g) || []).length === 1 &&
   CODE.indexOf('const _sellerId  = _san(sellerId || auth.uid, 40);') > -1);

head('5b · the shared binding, and what it refuses');
ck('a single helper binds every handler', CODE.indexOf('function _boundSellerId(auth, requested)') > -1);
ck('it refuses a caller naming another shop',
   CODE.indexOf('if (!isAdmin && sid !== auth.uid) {') > -1 &&
   CODE.indexOf("'You can only access your own shop.'") > -1);
ck('admin is the only exception, declared once',
   (CODE.split('_boundSellerId').length - 1) === 8,
   'one definition plus seven call sites');
['getInventoryAlerts', 'getInventoryInsights', 'getReorderSuggestions',
 'getPOSAnalytics', 'getLivePOSMetrics', 'getBranchComparison'].forEach((fn) => {
  const at = CODE.indexOf('exports.' + fn + ' = onCall');
  const body = at > -1 ? CODE.slice(at, at + 900) : '';
  ck(fn + ' uses the bound id', body.indexOf('_boundSellerId(auth, sellerId)') > -1);
});

head('5c · the inventory-transfer WRITE');
const XFER = (function () {
  const a = CODE.indexOf('exports.initiateInventoryTransfer = onCall');
  return a === -1 ? '' : CODE.slice(a, a + 2200);
})();
ck('CONTROL the handler was isolated', XFER.length > 800, XFER.length + ' chars');
ck('it now requires a seller, not merely any authenticated user',
   XFER.indexOf('_adminOrSeller(req)') > -1 && XFER.indexOf('_authRequired(req)') === -1,
   'before this ANY signed-in account could file a transfer');
ck('the transfer document is filed against the BOUND shop',
   XFER.indexOf('sellerId:     _sellerId,') > -1);
ck('NEGATIVE the emitted event carries the bound shop too',
   XFER.indexOf('sellerId: _sellerId });') > -1 &&
   XFER.indexOf('sellerId: sellerId || auth.uid });') === -1,
   'a forged shop id in an event poisons every downstream subscriber');
ck('CONTROL the injection target is real — pos-hq lists transfers by sellerId',
   fs.readFileSync(path.join(ROOT, 'functions/pos-hq.js'), 'utf8')
     .indexOf("collection('inventoryTransfers').where('sellerId', '==', sid)") > -1,
   'that listing is what a forged pending transfer would appear in');

/* ── 6 · unproven ─────────────────────────────────────────────────────────── */
head('6 · what needs deployment or a decision');
un('a cross-tenant call is actually refused in production',
   'needs the deployed dispatcher and two real seller accounts');
un('an employee acting for an owner on these seven handlers',
   'DELIBERATELY DENIED — no employee store may be chosen here; awaits authority convergence');
un('client-supplied prices', 'recordPOSSale still computes totals from payload price/cost — separate defect');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: source contract only. No live cross-tenant call was attempted.');
process.exit(fail ? 1 : 0);
