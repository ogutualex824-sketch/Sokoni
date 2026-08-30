#!/usr/bin/env node
/**
 * MERCHANT CUSTOMERS — the list query must have the composite index it requires.
 *
 *   node scripts/test-merchant-customers-index.js
 *
 * WHY THIS EXISTS
 * ---------------
 * The Customers list reported "Your customers could not be loaded." and no suite could see
 * why, because nothing checked that its query was executable. It runs
 *
 *     crmCustomerProfiles  where merchantId == <uid>  orderBy clv desc  limit 500
 *
 * and an equality plus an orderBy on a DIFFERENT field requires a composite index. Measured
 * at the time: firestore.indexes.json declared merchantId + churnRiskScore, production had
 * that one READY, and ZERO indexes anywhere in the project mentioned `clv`. The query could
 * not execute at all — it was never a permissions refusal and never an empty list.
 *
 * THE INDEX IS DERIVED FROM THE QUERY, not restated beside it. Both are parsed out of
 * sokoni-merchant-customers.js, so changing the orderBy field fails this until the index
 * follows. A hardcoded expectation would keep passing after someone re-sorted the list.
 *
 * NOT PROVEN HERE: that the index is DEPLOYED. Declaring it is a source change; creating it
 * is a firestore:indexes deploy. This asserts the declaration exists and matches; production
 * readiness is a release step.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 96) + ']' : ''));
  ok ? pass++ : fail++;
};

console.log('\nMERCHANT CUSTOMERS — the list query is executable\n' + '='.repeat(66));

/* ── 1. read the query out of the shipped module ───────────────────────────── */
const SRC = read('sokoni-merchant-customers.js');
const collection = (SRC.match(/var PROFILES\s*=\s*'([^']+)'/) || [])[1] || null;
const whereField = (SRC.match(/where:\s*\[\[\s*'([^']+)'/) || [])[1] || null;
const orderBy = SRC.match(/orderBy:\s*\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/);

ck('the collection was parsed from the module', collection === 'crmCustomerProfiles', collection);
ck('the equality field was parsed', whereField === 'merchantId', whereField);
ck('the sort was parsed', !!orderBy, orderBy ? orderBy[1] + ' ' + orderBy[2] : 'MISSING');
if (!collection || !whereField || !orderBy) {
  console.log('\n  the query could not be read — the checks below would be vacuous');
  process.exit(1);
}
const sortField = orderBy[1];
const sortDir = orderBy[2].toUpperCase() === 'DESC' ? 'DESCENDING' : 'ASCENDING';

/* A composite index is only REQUIRED when the sort is on a different field than the
   equality. Stated so the suite stays correct if the query is ever simplified. */
const needsComposite = sortField !== whereField;
ck('this query needs a composite index (equality + a different sort field)',
   needsComposite, whereField + ' == , orderBy ' + sortField);

/* ── 2. the declaration must match it exactly ──────────────────────────────── */
const idx = JSON.parse(read('firestore.indexes.json'));
const forCollection = (idx.indexes || []).filter((i) => i.collectionGroup === collection);
const shape = (i) => (i.fields || []).map((f) => f.fieldPath + ':' + (f.order || f.arrayConfig)).join(',');
const want = whereField + ':ASCENDING,' + sortField + ':' + sortDir;

ck('a composite index is declared for ' + collection, forCollection.length > 0,
   forCollection.map(shape).join('  |  ') || 'NONE');
ck('...and one matches the query exactly', forCollection.some((i) => shape(i) === want), want);
ck('...with the equality field FIRST (Firestore requires it)',
   forCollection.some((i) => shape(i) === want && i.fields[0].fieldPath === whereField));

/* ── 3. governance: a declared index must be explainable ───────────────────── */
const reg = JSON.parse(read('docs/index-registry.json'));
const key = collection + '|' + want;
ck('the index is registered', !!reg[key], key);
if (reg[key]) {
  ck('...and names the query it serves', /orderBy\(clv/.test(reg[key].query || ''), reg[key].query);
  ck('...and is not marked legacy/needsAttribution', !reg[key].legacy && !reg[key].needsAttribution);
}

/* ── 4. CONTROLS ───────────────────────────────────────────────────────────── */
console.log('\nCONTROLS — the check must be able to fail');
const rogue = forCollection.filter((i) => shape(i) !== want);
ck('CONTROL an unrelated index on the same collection does NOT satisfy it',
   rogue.length === 0 || !rogue.some((i) => shape(i) === want),
   rogue.map(shape).join(', ') || 'none present');
ck('CONTROL a sort on a DIFFERENT field would not match this declaration',
   !forCollection.some((i) => shape(i) === whereField + ':ASCENDING,someOtherField:' + sortDir));
ck('CONTROL the wrong sort DIRECTION would not match',
   want.indexOf(':DESCENDING') > -1
     ? !forCollection.some((i) => shape(i) === whereField + ':ASCENDING,' + sortField + ':ASCENDING')
     : true);

console.log('\nNOT PROVEN — declaration is not deployment');
console.log('  UNPROVEN  the index exists in production   [a firestore:indexes deploy creates it;');
console.log('            until then the live query still fails with failed-precondition]');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
