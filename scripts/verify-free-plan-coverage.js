#!/usr/bin/env node
'use strict';
/**
 * FREE-PLAN COVERAGE GUARD — every hubType must have somewhere safe to land.
 *
 * WHAT THIS PREVENTS
 * `sub-billing.js` downgrades a lapsed account with
 * `PLANS[`${hubType}_free`]?.features || {}`. Features are read per key, so `{}` denies
 * everything — stricter than Free, and contradicting the policy that a merchant who stops
 * paying keeps their data and drops to Free. It is silent: no error, no flag. The merchant
 * just finds their tools gone.
 *
 * Measured 2026-09-02: three hubTypes have no `_free` plan — enterprise, property_agent,
 * service_provider. No production account sits on them today, so the gap is real and
 * unexploited. That is a fact about that day, not a property of the catalogue.
 *
 * WHY A GUARD RATHER THAN A DEFAULT
 * Free tiers are hub-specific and share NO keys: seller_free caps listings, buyer_free caps
 * wishlists, restaurant_free caps menu items. The intersection across all free plans is
 * empty, so there is no generic baseline to fall back to. Inventing one would be a product
 * decision disguised as a bug fix. The gap has to be filled by a person — this makes sure it
 * is filled before it ships rather than discovered by a merchant.
 *
 * Exits non-zero when any hubType cannot be downgraded safely.
 *
 *   node scripts/verify-free-plan-coverage.js
 */
const { auditCoverage, OUTCOME } = require('../functions/free-entitlement');
const { PLANS } = require('../functions/sub-billing');

const { rows, gaps } = auditCoverage();

console.log('');
console.log('  FREE-PLAN COVERAGE');
console.log('');
console.log('  plans in catalogue : ' + Object.keys(PLANS).length);
console.log('  hubTypes           : ' + rows.length);
console.log('');
rows.forEach((r) => {
  const mark = r.outcome === OUTCOME.MISSING_FREE     ? 'GAP  '
             : r.outcome === OUTCOME.INVALID_IDENTITY ? 'IDENT'
             : r.outcome === OUTCOME.ALIASED_FREE     ? 'ALIAS'
             : 'OK   ';
  console.log('    ' + mark + '  ' + r.hubType.padEnd(18) + (r.planId || '— no Free tier —'));
});

/* A guard that cannot fail is decoration: prove the detector distinguishes. */
const known = rows.find((r) => !r.catalogueGap);
if (!known) {
  console.log('');
  console.log('  CONTROL FAILED — not one hubType resolved. That is a broken audit, not an');
  console.log('  empty catalogue. No verdict is given.');
  process.exit(1);
}

console.log('');
if (gaps.length === 0) {
  console.log('  PASS — every hubType has a Free tier to land on.');
  process.exit(0);
}

console.log('  FAIL — ' + gaps.length + ' hubType(s) have no Free tier:');
gaps.forEach((g) => console.log('    ' + g.hubType));
console.log('');
console.log('  A lapsed account on these would be downgraded to {} — every feature removed,');
console.log('  which is stricter than Free and contrary to the stated policy.');
console.log('');
console.log('  Fix by EITHER defining `<hubType>_free` in functions/sub-billing.js PLANS,');
console.log('  OR adding a reviewed entry to HUB_FREE_ALIAS in functions/free-entitlement.js.');
console.log('  Both are product decisions about what a merchant keeps when they stop paying,');
console.log('  so neither is defaulted here.');
process.exit(1);
