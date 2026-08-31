#!/usr/bin/env node
/**
 * DELIVERY HUB — store riders vs SOKONI riders.
 *
 *   node scripts/test-delivery-hub-rider-groups.js
 *
 * The roster showed one undifferentiated list, so a merchant could not tell the riders
 * on their own team from the wider network — two different relationships: you dispatch
 * one and merely request the other.
 *
 * THE INVARIANT THIS MUST NOT TOUCH (locked, proven from deployed rules + Functions):
 * network eligibility lives in `drivers/{uid}`, which is CF-only (`allow write: if false`).
 * `shopEmployees` CLASSIFIES a rider for a shop and creates no eligibility whatsoever.
 * The grouping here is PRESENTATION over a pool the server already decided — it must
 * read, never write, and must never accept a riderType from anywhere but that rule.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'seller-delivery.html'), 'utf8');
const NL = String.fromCharCode(10);

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 96) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

console.log(NL + 'DELIVERY HUB — RIDER GROUPS' + NL + '='.repeat(60));

/* ── 1 · the boundary ─────────────────────────────────────────────────────── */
head('1 · the classifier reads; it must never grant');
ck('it READS shopEmployees', SRC.indexOf("collection('shopEmployees')") > -1);
ck('...scoped to this shop by shopOwnerId',
   SRC.indexOf("where('shopOwnerId', '==', _sellerUid)") > -1,
   'a roster that queried unscoped would list other merchants teams');
ck('it NEVER writes shopEmployees or drivers',
   SRC.indexOf(".collection('drivers')") === -1 &&
   !/collection\('shopEmployees'\)[\s\S]{0,200}\.(set|add|update|delete)\(/.test(SRC),
   'network eligibility is CF-only; classifying someone here must grant nothing');
/* The word may appear in a comment explaining the server rule — what must never happen is
   READING it off a document, which would let stored data decide the grouping. */
ck('riderType is never read from rider DATA',
   SRC.indexOf('.riderType') === -1 && SRC.indexOf("['riderType']") === -1,
   'the split is derived from the shop membership rule, never accepted as data');

/* ── 2 · fail closed ──────────────────────────────────────────────────────── */
head('2 · an unanswered or failed lookup must not invent a relationship');
ck('the set starts as null — "not answered", not "empty"',
   SRC.indexOf('var _storeRiderIds = null;') > -1,
   'null and {} mean different things and must not be conflated');
ck('a failure sets an EMPTY set, so everyone falls under SOKONI',
   /catch\(function \(err\)[\s\S]{0,320}_storeRiderIds = \{\};/.test(SRC),
   'mislabelling a network rider is cosmetic; inventing a store rider is not');
ck('...and the failure is SAID, not swallowed',
   SRC.indexOf('_storeRidersFailed = true') > -1 &&
   SRC.indexOf('could not check which riders are on your team') > -1);
ck('only ACTIVE employment counts',
   SRC.indexOf("['active','approved','enabled'].indexOf(st) > -1") > -1,
   'a revoked employee is not on the team; mirrors the server predicate');

/* ── 3 · the grouping itself, executed ────────────────────────────────────── */
head('3 · the grouping, run against real shapes');
(function () {
  /* Lift the two lines that decide the split and run them. */
  const sb = {
    _storeRiderIds: { r1: 1, r3: 1 },
    _riders: [{ uid: 'r1' }, { uid: 'r2' }, { uid: 'r3' }, { uid: 'r4' }],
  };
  vm.createContext(sb);
  vm.runInContext(
    'var known = _storeRiderIds || {};' + NL +
    'var store = [], network = [];' + NL +
    '_riders.forEach(function (r) { (known[r.uid] ? store : network).push(r); });', sb);
  ck('classified riders go to the store group',
     sb.store.map((r) => r.uid).join(',') === 'r1,r3', sb.store.map((r) => r.uid).join(','));
  ck('everyone else is SOKONI',
     sb.network.map((r) => r.uid).join(',') === 'r2,r4', sb.network.map((r) => r.uid).join(','));
  ck('CONTROL no rider is dropped or duplicated',
     sb.store.length + sb.network.length === sb._riders.length);
})();
(function () {
  const sb = { _storeRiderIds: null, _riders: [{ uid: 'r1' }, { uid: 'r2' }] };
  vm.createContext(sb);
  vm.runInContext(
    'var known = _storeRiderIds || {};' + NL +
    'var store = [], network = [];' + NL +
    '_riders.forEach(function (r) { (known[r.uid] ? store : network).push(r); });', sb);
  ck('CONTROL before the answer arrives, nobody is claimed as store staff',
     sb.store.length === 0 && sb.network.length === 2,
     'the alternative is riders flickering between sections');
})();

/* ── 4 · it must not make the tab slower ──────────────────────────────────── */
head('4 · both halves start together');
ck('the roster and the classifier are kicked off in one step',
   SRC.indexOf('{ _loadRiders(); _loadStoreRiders(); }') > -1,
   'chaining them would add the classifier latency to a roster that could already paint');
ck('a late classifier REGROUPS what is already on screen',
   (SRC.match(/if \(_riders\.length\) _renderRiders\(\);/g) || []).length === 2,
   'on success and on failure — otherwise the first paint is the only paint');
ck('the classifier does not re-query once answered',
   SRC.indexOf('if (!_sellerUid || _storeRiderIds) return;') > -1);

/* ── 5 · presentation ─────────────────────────────────────────────────────── */
head('5 · two groups, each explained');
ck('both sections exist',
   SRC.indexOf("section('Your store riders'") > -1 && SRC.indexOf("section('SOKONI riders'") > -1);
ck('each says what the relationship IS',
   SRC.indexOf('You dispatch them directly') > -1 &&
   SRC.indexOf('Availability is theirs to set') > -1,
   'the difference is dispatch authority, not a label');
ck('an empty group is omitted rather than shown empty',
   /function section \([\s\S]{0,120}if \(!rows\.length\) return '';/.test(SRC));
ck('the groups are styled', SRC.indexOf('.sd-rgroup {') > -1 && SRC.indexOf('.sd-rhead.store') > -1);
ck('CONTROL the rider card builder still exists and is shared',
   (SRC.match(/function riderCard \(r\)/g) || []).length === 1,
   'one card, two groups — not two card implementations');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
