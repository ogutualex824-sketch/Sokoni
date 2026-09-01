#!/usr/bin/env node
/**
 * POS SALES / EMPLOYEES / SHIFT VIEW — render only what is proven.
 *
 *   node scripts/test-pos-sales-view.js
 *
 * A Sales screen exists to answer "who sold this?" when a customer disputes a transaction.
 * That makes its failure mode specific: a screen that GUESSES an employee is worse than one
 * that admits it does not know, because a confident wrong name is what a dispute is decided on.
 *
 * TWO FIELDS, TWO STRENGTHS, and the view must not flatten them:
 *   servedBy   server-resolved from employment records — PROVEN, may be displayed as fact
 *   shiftId    request-derived and only sanitized — RECORDED, must never be shown as verified
 *
 * MY SALES IS DELIBERATELY NOT BUILT. The served rule authorises a cashier read on
 * `cashierUid`, which no writer produces. The three ways to "make it work" — inventing the
 * field, changing Rules, or filtering client-side and calling that authorisation — are all
 * wrong. The tab says so instead, and this suite asserts that it says so.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-pos-sales.js'), 'utf8');
const POS = fs.readFileSync(path.join(ROOT, 'pos.html'), 'utf8');

/* Load the module against a bare global — it must not need a browser to be reasoned about. */
const win = {};
const fn = new Function('window', 'document', 'module', SRC + NL + 'return window.PosSalesView;');
const V = fn(win, { getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild(){} } }, { exports: {} });
const I = V._internal;

/* Source with comments removed. Assertions about BEHAVIOUR use this; assertions about
   documentation use SRC deliberately and say so. */
const CODE = (function () {
  let out = '', i = 0, inBlock = false;
  while (i < SRC.length) {
    if (!inBlock && SRC[i] === '/' && SRC[i + 1] === '*') { inBlock = true; i += 2; continue; }
    if (inBlock && SRC[i] === '*' && SRC[i + 1] === '/') { inBlock = false; i += 2; continue; }
    if (!inBlock) out += SRC[i];
    i++;
  }
  return out.split(NL).filter((l) => l.trim().indexOf('//') !== 0).join(NL);
})();

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

const now = Date.now();
const sale = (o) => Object.assign({ id: 'S1', saleDateMs: now, grandTotal: 1000, status: 'completed',
                                    items: [{ name: 'x', qty: 1 }], payments: [{ method: 'cash', amount: 1000 }] }, o);
const ATTRIBUTED   = sale({ id: 'A', servedBy: { uid: 'U1', name: 'Grace', role: 'cashier' } });
const UNATTRIBUTED = sale({ id: 'B', servedBy: null });

console.log(NL + 'POS SALES VIEW' + NL + '='.repeat(60));

/* ── 1 · attribution is never inferred ────────────────────────────────────── */
head('1 · an unprovable seller is not named');
ck('a proven servedBy is used', I.seller(ATTRIBUTED).proven === true && I.seller(ATTRIBUTED).name === 'Grace');
ck('NEGATIVE a null servedBy reads "Not recorded"',
   I.seller(UNATTRIBUTED).proven === false && I.seller(UNATTRIBUTED).name === 'Not recorded');
ck('NEGATIVE an empty servedBy object is not a name',
   I.seller(sale({ servedBy: {} })).proven === false);
ck('NEGATIVE a missing servedBy is not filled from cashierId',
   I.seller(sale({ servedBy: null, cashierId: 'U9' })).name === 'Not recorded',
   'the session, the device and the till are all tempting and all wrong');
ck('NEGATIVE ...nor from the shift',
   I.seller(sale({ servedBy: null, shiftId: 'SH1' })).name === 'Not recorded');
ck('CONTROL the module contains no inference fallback',
   SRC.indexOf('currentCashier') === -1 && SRC.indexOf('|| cashierId') === -1,
   'nothing may substitute for a proven employee');

/* ── 2 · the rendered views honour that ───────────────────────────────────── */
head('2 · the views render the distinction');
const txn = I.txnView([ATTRIBUTED, UNATTRIBUTED]);
ck('an attributed row shows the name', txn.indexOf('Grace') > -1);
ck('an unattributed row shows "Not recorded"', txn.indexOf('Not recorded') > -1);
ck('...and is visually marked as unattributed', txn.indexOf('pss-unattr') > -1);

const byEmp = I.byEmployeeView([ATTRIBUTED, UNATTRIBUTED]);
ck('By Employee counts only attributed sales', byEmp.indexOf('Grace') > -1);
ck('NEGATIVE unattributed sales are EXCLUDED from employee totals, not assigned',
   /1 sale could not be attributed/.test(byEmp),
   'silently folding them into someone would misattribute revenue');

const today = I.todayView([ATTRIBUTED, UNATTRIBUTED]);
ck('Today counts both sales', today.indexOf('>2<') > -1 || today.indexOf('2') > -1);
ck('CONTROL a voided sale is excluded from the total',
   (function () {
     const v = I.todayView([ATTRIBUTED, sale({ id: 'C', status: 'voided', grandTotal: 5000 })]);
     return v.indexOf('5,000') === -1 && v.indexOf('6,000') === -1;
   })());

/* ── 3 · My Sales does not pretend ────────────────────────────────────────── */
head('3 · a blocked feature says it is blocked');
const my = I.myView();
ck('My Sales reports itself unavailable', my.indexOf('not available yet') > -1);
ck('...and names the actual reason', my.indexOf('cashierUid') > -1);
/* Assert on CODE, not on prose. Both of these first matched this module's own header, which
   quotes the rule it is explaining. That is the sixth time in this codebase a source
   assertion has matched documentation instead of behaviour — so the stripped source is the
   default here, not an afterthought. */
ck('CONTROL the comment stripper works', CODE.indexOf('request.auth.uid') === -1 && CODE.length > 6000,
   'if this fails the two below prove nothing');
/* The field NAME legitimately appears in the message explaining why the tab is blocked.
   What must not exist is USE of it: a property read or a comparison, either of which would
   mean the module is filtering by cashier and treating that as authorisation. */
/* TWO COLLECTIONS, ONE FIELD NAME. `posShifts` DOES carry cashierUid (openShift writes
   auth.uid); `posRetailSales` does not. `shift.cashierUid === e.uid` is therefore correct
   and necessary — an earlier version of this assertion banned the identifier outright and
   failed against correct code. What must not exist is reading it FROM A SALE, or filtering
   the sales query by it, which is the thing that would masquerade as authorisation. */
ck('CONTROL it does not filter SALES by cashier and call that authorisation',
   CODE.indexOf('sale.cashierUid') === -1 &&
   CODE.indexOf('s.cashierUid') === -1 &&
   !/where\([^)]*cashierUid/.test(CODE),
   'browser-side filtering is not an authorisation boundary');
ck('CONTROL the shift view may legitimately read the SHIFT cashierUid',
   CODE.indexOf('shift.cashierUid === e.uid') > -1,
   'posShifts carries it; this is how an employee is shown as on shift');
ck('CONTROL the module never manufactures cashierUid',
   CODE.indexOf('cashierUid:') === -1,
   'inventing the field is one of the three wrong ways to "make My Sales work"');

/* ── 4 · shiftId is shown as recorded, not verified ───────────────────────── */
head('4 · the shift figure states its own weight');
ck('the shift card warns the id is not server-verified',
   SRC.indexOf('recorded by the till, not verified by the server') > -1);
ck('CONTROL it does not present shift totals as reconciliation',
   SRC.indexOf('Cash, refunds, expenses and variance are not') > -1,
   'the shift audit left those formulas unresolved; this must not imply otherwise');
ck('CONTROL no variance is computed here',
   SRC.indexOf('variance') === -1 || !/variance\s*=/.test(SRC),
   'four implementations already disagree; a fifth would be worse');

/* ── 5 · one authority each ───────────────────────────────────────────────── */
head('5 · no second authority is introduced');
ck('employees come from the existing callable', SRC.indexOf("_call('listShopEmployees')") > -1);
ck('shift uses the existing operations',
   SRC.indexOf("_call('openShift'") > -1 && SRC.indexOf("_call('closeShift'") > -1 &&
   SRC.indexOf("_call('getCurrentShift'") > -1);
ck('sales read the authoritative collection',
   SRC.indexOf("'posRetailSales'") > -1);
ck('CONTROL the module never WRITES a sale, employee or shift record',
   SRC.indexOf('setDoc') === -1 && SRC.indexOf('addDoc') === -1 && SRC.indexOf('updateDoc') === -1,
   'it is a read surface; a second writer is exactly what was forbidden');
ck('CONTROL it queries on the authoritative read key',
   SRC.indexOf("m.where('sellerId', '==', uid)") > -1,
   'the field the served rule actually authorises');
ck('CONTROL a denied read is reported, not silently empty',
   SRC.indexOf('Sales could not be read') > -1 &&
   SRC.indexOf('not authorised to read') > -1);

/* ── 6 · lazy ─────────────────────────────────────────────────────────────── */
head('6 · it costs nothing to open a till');
ck('pos.html does not load it eagerly', POS.indexOf('src="sokoni-pos-sales.js"') === -1);
ck('it is behind the lazy shim', POS.indexOf('lazyGlobal("PosSalesView"') > -1);

/* ── 7 · unproven ─────────────────────────────────────────────────────────── */
head('7 · what needs a deployed function and real data');
un('an owner actually reads their sales', 'needs the sellerId fix deployed and a real sale');
un('time in / time out against the server clock', 'needs the deployed shift callables and a session');
un('My Sales', 'BLOCKED — cashierUid is produced by no writer; an authority decision, not a bug');
/* Checkout now DERIVES shiftId server-side (pos-zero-friction 4b). The card's warning is
   nonetheless still correct and must not be softened: it is undeployed, and every sale
   already in posRetailSales carries a shift id the client supplied. The copy becomes wrong
   only once the function is live AND the historical records are distinguishable. */
un('shift attribution is trustworthy',
   'derivation is written but UNDEPLOYED; all existing sales carry client-claimed shift ids');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: view logic only. Nothing here proves a live read succeeded.');
process.exit(fail ? 1 : 0);
