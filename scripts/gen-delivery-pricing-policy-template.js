'use strict';
/* GENERATE the production delivery-pricing policy template.
 *
 *   node scripts/gen-delivery-pricing-policy-template.js
 *
 * WHY GENERATED, NOT HAND-WRITTEN
 * A hand-maintained template drifts from the contract it claims to describe: someone adds a
 * required field to the authority, the template still lists the old set, and a policy that looks
 * complete is rejected at runtime — or worse, a field nobody knew was required gets filled in with
 * a guess. This reads the authority's OWN exported contracts (`POLICY_CONTRACT`,
 * `CLASS_ECONOMICS_CONTRACT`) and the canonical vehicle vocabulary, so the template cannot
 * disagree with the code that validates it.
 *
 * WRITES NOTHING TO PRODUCTION. It prints a template in which every commercial decision is marked
 * REQUIRED FROM SOKONI, and then PROVES the template is refused by the real validator — so it
 * cannot be pasted in as-is and mistaken for an approved policy. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DQ = require(path.join(ROOT, 'functions', 'delivery-quote-authority'));
const vehicleClasses = require(path.join(ROOT, 'functions', 'vehicle-classes'));

const MARK = 'REQUIRED FROM SOKONI';

/* The classes that must carry economics are exactly the PRICED (dispatch-eligible) ones — derived,
   not listed, so a vocabulary change is picked up automatically. */
const unpriced = new Set(vehicleClasses.unpricedClasses());
const pricedClasses = Object.keys(vehicleClasses.CLASSES).filter((c) => !unpriced.has(c));

const classTemplate = () => {
  const o = {};
  for (const [k, meaning] of Object.entries(DQ.CLASS_ECONOMICS_CONTRACT)) {
    o[k] = MARK + ' — ' + meaning;
  }
  return o;
};

const template = {
  policyVersion: MARK + ' — e.g. "P1"; bumping it is the declared way policy changes',
  status: MARK + ' — must be the literal string "approved" once SOKONI approves it',
  effectiveFrom: MARK + ' — ISO date, e.g. "2026-10-01"',
  approvedBy: MARK + ' — who approved these commercial values',
  shareCurve: {
    distanceWeight: MARK + ' — 0..1; with demandWeight must sum to exactly 1',
    demandWeight: MARK + ' — 0..1; with distanceWeight must sum to exactly 1',
    saturationKm: MARK + ' — km at which the distance factor reaches maximum (> 0)',
    demandSaturationIndex: MARK + ' — demand index at which the demand factor maxes out (> 1)',
  },
  economics: {
    demandIndex: { source: MARK + ' — where the live demand/supply figure comes from' },
    vehicleClasses: pricedClasses.reduce((acc, c) => { acc[c] = classTemplate(); return acc; }, {}),
  },
};

console.log('\nPRODUCTION DELIVERY PRICING POLICY — TEMPLATE (nothing written)\n');
console.log('  target document : platformConfig/deliveryPricing');
console.log('  schema source   : functions/delivery-quote-authority.js (derived, not transcribed)');
console.log('  priced classes  : ' + pricedClasses.join(', '));
console.log('  unpriced (must NOT be given economics; they refuse): ' + [...unpriced].join(', '));
console.log('\n' + JSON.stringify(template, null, 2) + '\n');

/* ── The template must NOT be usable as-is ────────────────────────────────────────────────── */
console.log('-'.repeat(74));
console.log('SAFETY CHECKS (the template must be refused until real values replace the markers)\n');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const refuses = (fn) => { try { fn(); return null; } catch (e) { return e; } };

let e = refuses(() => DQ.assertPolicy(template));
ck('the template as printed is REFUSED by the real validator', !!e, e && e.reason);

/* Filling in everything EXCEPT approval must still refuse — completeness is not approval. */
const filled = JSON.parse(JSON.stringify(template));
filled.policyVersion = 'P-TEMPLATE'; filled.effectiveFrom = '2026-10-01'; filled.approvedBy = 'nobody';
filled.status = 'draft';
filled.shareCurve = { distanceWeight: 0.5, demandWeight: 0.5, saturationKm: 10, demandSaturationIndex: 2 };
filled.economics.demandIndex.source = 'placeholder';
for (const c of pricedClasses) {
  filled.economics.vehicleClasses[c] = {
    energyUnitLabel: 'litre', energyCostKESPerUnit: 1, efficiencyKmPerUnit: 1,
    maintenanceKESPerKm: 1, riderTimeKESPerMinute: 1,
  };
}
e = refuses(() => DQ.assertPolicy(filled));
ck('a COMPLETE but unapproved (status:"draft") policy is still REFUSED', !!e && e.reason === 'pricing_policy_unapproved', e && e.reason);

/* And with no policy at all, the authority refuses — the current production state. */
e = refuses(() => DQ.quote({ vehicleType: 'motorcycle', distanceKm: 5, estimatedMinutes: 15, demandIndex: 1 }, null));
ck('with NO policy the authority refuses (today\'s production behaviour)',
  !!e && e.reason === 'pricing_policy_required', e && e.reason);

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('\n  NOTHING WAS WRITTEN. platformConfig/deliveryPricing must be created only with');
console.log('  SOKONI-approved values, and status set to "approved" deliberately.\n');
process.exit(fail === 0 ? 0 : 1);
