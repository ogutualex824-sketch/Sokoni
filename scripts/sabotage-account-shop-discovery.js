#!/usr/bin/env node
/* sabotage-account-shop-discovery.js — every mutant must turn test-account-shop-discovery.js RED (exit 1).
   Proves account reactivation cannot bypass the approval / category / owner / business / freeze checks and never
   publishes a shop itself. Mutates in place, ALWAYS restores. Crash or dead anchor = NOT a catch. Quiescent tree. */
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const FN = path.join(__dirname, '..', 'functions');
const ACCT = 'account-status.js', SDR = 'shop-discovery-release.js';
const M = [
  [ACCT, 'reactivation skips the evaluator', "  await _evaluateShop(uid);\n}\n\nasync function _evaluateShop(uid) {", "  void 0;\n}\n\nasync function _evaluateShop(uid) {"],
  [ACCT, 'freeze skips the evaluator (no re-hold)', "  await _evaluateShop(uid);\n}\n\nasync function _restoreMerchantSurfaces", "  void 0;\n}\n\nasync function _restoreMerchantSurfaces"],
  [ACCT, 'reactivation publishes the shop directly', "  await _evaluateShop(uid);\n}\n\nasync function _evaluateShop(uid) {",
    "  await db.collection('shops').doc(uid).set({ discovery: 'ELIGIBLE', _noIndex: false, searchable: true, isPublic: true }, { merge: true });\n  await db.collection('sellers').doc(uid).set({ discovery: 'ELIGIBLE', _noIndex: false, searchable: true, isPublic: true }, { merge: true });\n}\n\nasync function _evaluateShop(uid) {"],
  [ACCT, 'admin freeze is self-reversible', "  if (!freeze || freeze.active !== true || freeze.by !== 'self') {", '  if (!freeze || freeze.active !== true) {'],
  [SDR, 'evaluator ignores the decision record', "      if (!v.approved) reasons.push('NOT_APPROVED:' + v.reason);", "      if (false) reasons.push('NOT_APPROVED:' + v.reason);"],
  [SDR, 'evaluator ignores the owner', "      else if (owner && v.applicantUid && String(v.applicantUid) !== owner) reasons.push('OWNER_MISMATCH');", ''],
  [SDR, 'evaluator ignores the seller', "    else if (seller.status !== 'active' || seller.active === false || !seller.approvedAt || seller.suspended === true) reasons.push('SELLER_NOT_ACTIVE');", ''],
  [SDR, 'evaluator ignores the business', "    if (!(bizSnap && bizSnap.exists)) reasons.push('NO_BUSINESS');", ''],
  [SDR, 'evaluator ignores the shop checks (category / visibility)', "    const reasons = BCAT.shopReleaseChecks(Object.assign({}, shop, { searchable: undefined, isPublic: undefined })).reasons.slice();", '    const reasons = [];'],
  ['shared/approval-authority.js', 'approval ignores an account freeze', "    if (frz.exists && (frz.data() || {}).active === true) return no('ACCOUNT_FROZEN', base);", ''],
];
let caught = 0, bad = 0;
for (const [rel, label, a, b] of M) {
  const F = path.join(FN, rel); const ORIG = fs.readFileSync(F, 'utf8');
  const n = ORIG.split(a).length - 1;
  if (n !== 1) { console.log('  ANCHOR x' + n + '  ' + label); bad++; continue; }
  try {
    fs.writeFileSync(F, ORIG.replace(a, b));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'test-account-shop-discovery.js')], { encoding: 'utf8', timeout: 240000 });
    const fails = (r.stdout.match(/^\s+FAIL\s+(\S+)/mg) || []).map((l) => l.trim().split(/\s+/)[1]);
    if (r.status === 1) { caught++; console.log('  CAUGHT  ' + label + '  ← ' + fails.join(',')); }
    else { bad++; console.log('  ' + (r.status === 2 ? 'CRASH ' : 'MISSED') + '  ' + label + '  (exit ' + r.status + ')'); }
  } finally { fs.writeFileSync(F, ORIG); }
}
console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught, ' + bad + ' missed/anchor/crash');
process.exit(bad ? 1 : 0);
