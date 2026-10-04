#!/usr/bin/env node
/* sabotage-shop-discovery-release.js — one mutant per guard of the shop discovery release; each must turn
   test-shop-discovery-release.js RED (exit 1). A crash (exit 2) or an anchor that no longer matches is NOT a catch.
   Mutates the working-tree file in place and ALWAYS restores it. Run on a quiescent tree. */
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const FN = path.join(__dirname, '..', 'functions');
const M = [
  ['business-category.js', 'gate ignores HELD', "  if ((shopDoc || {}).discovery === DISCOVERY.HELD) r.reasons.push('DISCOVERY_HELD');", ''],
  ['shop-discovery-release.js', 'no decision-record check', "      if (!v.approved) reasons.push('NOT_APPROVED:' + v.reason);", "      if (false) reasons.push('NOT_APPROVED:' + v.reason);"],
  ['shop-discovery-release.js', 'owner mismatch ignored', "      else if (owner && v.applicantUid && String(v.applicantUid) !== owner) reasons.push('OWNER_MISMATCH');", ''],
  ['shop-discovery-release.js', 'seller state ignored', "    else if (seller.status !== 'active' || seller.active === false || !seller.approvedAt || seller.suspended === true) reasons.push('SELLER_NOT_ACTIVE');", ''],
  ['shop-discovery-release.js', 'shop checks ignored', "    const reasons = BCAT.shopReleaseChecks(Object.assign({}, shop, { searchable: undefined, isPublic: undefined })).reasons.slice();", '    const reasons = [];'],
  ['shop-discovery-release.js', 'never re-holds', '    if (!pass && shop.discovery === DISCOVERY.ELIGIBLE) {', '    if (false) {'],
  ['shop-discovery-release.js', 'touches legacy shops', "    if (shop.discovery !== DISCOVERY.HELD && shop.discovery !== DISCOVERY.ELIGIBLE) return { action: 'not_participating', reasons: ['LEGACY_VISIBILITY'] };", ''],
  ['shop-discovery-release.js', 'release leaves _noIndex', 'discovery: DISCOVERY.ELIGIBLE, _noIndex: false,', 'discovery: DISCOVERY.ELIGIBLE,'],
  ['business-category-admin.js', 'classification never evaluates', "  const disc = await require('./shop-discovery-release').evaluateShopDiscovery(db, shopId, {", "  const disc = { action: 'unchanged', reasons: [] }; void ({"],
  ['application-lifecycle.js', 'approval never evaluates', "  const disc = await require('./shop-discovery-release').evaluateShopDiscovery(db, shopId, {", "  const disc = { action: 'unchanged', reasons: [] }; void ({"],
  ['application-lifecycle.js', 'suspension does not re-hold', "{ discovery: 'HELD', _noIndex: true, discoveryHeldReasons: ['SUSPENDED'] } : {};", '{} : {};'],
  ['application-lifecycle.js', 'approval publishes directly', "  const held = (d) => (d ? {} : { _noIndex: true, discovery: 'HELD', createdAt: _ts() });", "  const held = (d) => (d ? {} : { _noIndex: false, discovery: 'ELIGIBLE', searchable: true, isPublic: true, createdAt: _ts() });"],
];
let caught = 0, bad = 0;
for (const [file, label, a, b] of M) {
  const F = path.join(FN, file); const ORIG = fs.readFileSync(F, 'utf8');
  const n = ORIG.split(a).length - 1;
  if (n !== 1) { console.log('  ANCHOR x' + n + '  ' + label); bad++; continue; }
  try {
    fs.writeFileSync(F, ORIG.replace(a, b));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'test-shop-discovery-release.js')], { encoding: 'utf8', timeout: 180000 });
    const fails = (r.stdout.match(/^\s+FAIL\s+(\S+)/mg) || []).map((l) => l.trim().split(/\s+/)[1]);
    if (r.status === 1) { caught++; console.log('  CAUGHT  ' + label + '  ← ' + fails.join(',')); }
    else { bad++; console.log('  ' + (r.status === 2 ? 'CRASH ' : 'MISSED') + '  ' + label + '  (exit ' + r.status + ')'); }
  } finally { fs.writeFileSync(F, ORIG); }
}
console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught, ' + bad + ' missed/anchor/crash');
process.exit(bad ? 1 : 0);
