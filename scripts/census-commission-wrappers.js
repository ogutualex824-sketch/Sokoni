#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   COMMISSION WRAPPER CENSUS — per-function counts, not zero/non-zero
   ══════════════════════════════════════════════════════════════════════════
   The thirteen wrappers may only be withdrawn once no legitimate caller
   remains. "Zero or non-zero" is too coarse for that decision: a caller that
   fires once a fortnight looks identical to a dead endpoint in a boolean, and
   this estate has already produced one caller that no source search found.

   So this records the ACTUAL count per wrapper, and writes a dated snapshot so
   successive runs can be compared. A single reading proves nothing about a
   trend — the baseline is taken at cutover precisely so the later reading has
   something to be measured against.

     node scripts/census-commission-wrappers.js            # read + append
     node scripts/census-commission-wrappers.js --baseline # label this run
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const WRAPPERS = ['createCommissionRule', 'updateCommissionRule', 'deleteCommissionRule',
                  'listCommissionRules', 'previewCommission', 'getCommissionConfig',
                  'getSellerEarningsReport', 'getAdminRevenueByHub', 'processSettlement',
                  'requestWithdrawal', 'approveWithdrawal', 'rejectWithdrawal', 'getWithdrawals'];
const DOOR = 'commissionDispatch';

const CENSUS = path.join(ROOT, 'docs', 'cf-invocation-census.json');
const OUT = path.join(ROOT, 'docs', 'commission-wrapper-census.json');

if (!fs.existsSync(CENSUS)) {
  console.error('  No cf-invocation-census.json. Run scripts/cf-invocation-census.js first —');
  console.error('  this reads its counts rather than querying Cloud Monitoring a second time.');
  process.exit(1);
}
const census = JSON.parse(fs.readFileSync(CENSUS, 'utf8'));
const counts = census.counts || {};
const at = (n) => {
  const v = counts[String(n).toLowerCase()];
  return v === undefined ? null : v;   /* null = no service in the window, NOT zero */
};

const reading = {
  takenAt: new Date().toISOString(),
  label: process.argv.includes('--baseline') ? 'baseline-at-cutover' : 'observation',
  window: census.coverage,
  dispatcher: { name: DOOR, count: at(DOOR) },
  wrappers: WRAPPERS.map((w) => ({ name: w, count: at(w) })),
};

const total = reading.wrappers.reduce((a, w) => a + (w.count || 0), 0);
const absent = reading.wrappers.filter((w) => w.count === null).length;

console.log('COMMISSION WRAPPER CENSUS   (' + reading.label + ')');
console.log('='.repeat(74));
console.log('  window : ' + census.coverage.startTime.slice(0, 10) + ' -> ' + census.coverage.endTime.slice(0, 10));
console.log('');
console.log('  ' + DOOR.padEnd(28) + String(reading.dispatcher.count === null ? 'no service yet' : reading.dispatcher.count).padStart(8) + '   <- the door');
console.log('  ' + '-'.repeat(46));
reading.wrappers.forEach((w) => {
  const v = w.count === null ? 'no service' : String(w.count);
  console.log('  ' + w.name.padEnd(28) + v.padStart(8));
});
console.log('  ' + '-'.repeat(46));
console.log('  ' + 'TOTAL wrapper calls'.padEnd(28) + String(total).padStart(8));
console.log('  ' + 'wrappers with no service'.padEnd(28) + String(absent).padStart(8));
console.log('');
console.log('  READ THIS CAREFULLY:');
console.log('    null / "no service" means Cloud Monitoring has no series for it in the');
console.log('    window — a deployed-but-never-invoked function is ABSENT, not zero. It');
console.log('    is still deployed and still counts against the quota. Retirement needs');
console.log('    functions:delete regardless of what this column says.');

let history = [];
if (fs.existsSync(OUT)) { try { history = JSON.parse(fs.readFileSync(OUT, 'utf8')).readings || []; } catch (_) {} }
history.push(reading);
fs.writeFileSync(OUT, JSON.stringify({ readings: history }, null, 2));
console.log('\n  appended to docs/commission-wrapper-census.json  (' + history.length + ' reading(s))');

if (history.length > 1) {
  const prev = history[history.length - 2];
  const pT = (prev.wrappers || []).reduce((a, w) => a + (w.count || 0), 0);
  console.log('\n  TREND vs ' + prev.takenAt.slice(0, 10) + ' (' + prev.label + ')');
  console.log('    wrapper calls : ' + pT + '  ->  ' + total + '   (' + (total - pT >= 0 ? '+' : '') + (total - pT) + ')');
  console.log('    dispatcher    : ' + (prev.dispatcher.count || 0) + '  ->  ' + (reading.dispatcher.count || 0));
  if (total === 0) {
    console.log('\n    Every wrapper is at zero. Retirement is now evidenced —');
    console.log('    de-export, then functions:delete, then probe for 404.');
  }
}
