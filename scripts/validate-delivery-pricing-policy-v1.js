'use strict';
/* VALIDATE the PROPOSED v1 delivery pricing policy against the real authority.
 *
 *   node scripts/validate-delivery-pricing-policy-v1.js
 *
 * These values are a PROPOSAL awaiting SOKONI business approval. They are held at status "draft"
 * on purpose, and this script proves the authority refuses a draft — so the proposal cannot be
 * mistaken for, or accidentally become, an approved policy. It writes NOTHING.
 *
 * It then re-validates the same numbers with status flipped to "approved" IN MEMORY ONLY, so we
 * can answer the question that actually matters before anyone approves them: do these figures
 * produce sane, in-band quotes across real routes, or would approving them break pricing? */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DQ = require(path.join(ROOT, 'functions', 'delivery-quote-authority'));

/* ── THE PROPOSAL ───────────────────────────────────────────────────────────────────────────
   Held at "draft". Only an authorised SOKONI approver may set status "approved" and approvedBy. */
const PROPOSED_V1 = {
  policyVersion: 'v1-distance-only',
  status: 'draft',                      /* <- NOT approved. Engineering cannot set this. */
  effectiveFrom: 'AWAITING APPROVAL',
  approvedBy: 'AWAITING SOKONI BUSINESS APPROVAL',
  shareCurve: {
    distanceWeight: 1.00,
    demandWeight: 0.00,
    saturationKm: 20,
    /* The schema requires > 1. With demandWeight 0 this value is multiplied by zero and is
       therefore INERT — it is a schema placeholder, not a commercial decision. Proposed 1.00 is
       not expressible; any legal value gives identical pricing. */
    demandSaturationIndex: 2,
  },
  economics: {
    demandIndex: { source: 'disabled-v1-distance-only' },
    vehicleClasses: {
      motorcycle: { energyUnitLabel: 'litre', energyCostKESPerUnit: 190, efficiencyKmPerUnit: 40, maintenanceKESPerKm: 2.50, riderTimeKESPerMinute: 5.00 },
      ebike:      { energyUnitLabel: 'kWh',   energyCostKESPerUnit: 35,  efficiencyKmPerUnit: 45, maintenanceKESPerKm: 1.20, riderTimeKESPerMinute: 5.00 },
      tuktuk:     { energyUnitLabel: 'litre', energyCostKESPerUnit: 190, efficiencyKmPerUnit: 25, maintenanceKESPerKm: 4.00, riderTimeKESPerMinute: 6.00 },
      car:        { energyUnitLabel: 'litre', energyCostKESPerUnit: 190, efficiencyKmPerUnit: 12, maintenanceKESPerKm: 6.00, riderTimeKESPerMinute: 7.00 },
      van:        { energyUnitLabel: 'litre', energyCostKESPerUnit: 190, efficiencyKmPerUnit: 9,  maintenanceKESPerKm: 8.00, riderTimeKESPerMinute: 8.00 },
      truck:      { energyUnitLabel: 'litre', energyCostKESPerUnit: 190, efficiencyKmPerUnit: 5,  maintenanceKESPerKm: 12.00, riderTimeKESPerMinute: 10.00 },
      /* BICYCLE IS DELIBERATELY ABSENT. It has no energy economics, and the certified schema has
         no non-energy class model. Declaring energyCostKESPerUnit: 0 would satisfy the schema with
         a fiction. Absent, a bicycle delivery refuses `vehicle_class_uneconomised` — fail-closed
         and visible. Resolving this is a SOKONI decision; see the report below. */
    },
  },
};

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const refuses = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const kes = (m) => (m.minorUnits / 100).toFixed(2);

console.log('\nPROPOSED DELIVERY PRICING POLICY v1 — validation against the real authority\n');
console.log('  NOTHING IS WRITTEN. platformConfig/deliveryPricing is untouched.\n');

/* ── 1. The proposal must NOT be usable while it is a draft ───────────────────────────────── */
console.log('1 - the proposal cannot price anything while unapproved');
let e = refuses(() => DQ.assertPolicy(PROPOSED_V1));
ck('the draft proposal is REFUSED by the authority',
  !!e && e.reason === 'pricing_policy_unapproved', e && e.reason);
e = refuses(() => DQ.quote({ vehicleType: 'motorcycle', distanceKm: 5, estimatedMinutes: 15, demandIndex: 1 }, PROPOSED_V1));
ck('a quote using the draft is REFUSED', !!e, e && e.reason);

/* ── 2. Would the NUMBERS work, if approved? (in-memory only) ─────────────────────────────── */
const AS_IF = JSON.parse(JSON.stringify(PROPOSED_V1));
AS_IF.status = 'approved';
AS_IF.effectiveFrom = '2026-10-01';
AS_IF.approvedBy = 'SIMULATION ONLY — not a real approval';

console.log('\n2 - schema validity of the proposed figures (simulated approval, in memory)');
e = refuses(() => DQ.assertPolicy(AS_IF));
ck('the figures are schema-valid once approved', !e, e ? e.reason + ': ' + e.detail : 'accepted');

console.log('\n3 - what riders and customers would actually see');
const ROUTES = [
  ['motorcycle', 2, 10], ['motorcycle', 6, 18], ['motorcycle', 15, 35], ['motorcycle', 25, 55],
  ['ebike', 5, 20], ['tuktuk', 8, 25], ['car', 12, 30], ['van', 20, 45], ['truck', 30, 70],
];
let allInBand = true, allRiderPositive = true;
ROUTES.forEach(([v, km, min]) => {
  try {
    const q = DQ.quote({ vehicleType: v, distanceKm: km, estimatedMinutes: min, demandIndex: 1 }, AS_IF);
    const realised = (q.sokoniCommission.minorUnits * 100) / q.customerCharge.minorUnits;
    /* Same one-minor-unit rounding allowance the authority applies. The customer charge is a
       CEILING (it keeps the rider whole), so a quote deriving exactly SHARE_MAX realises a
       fraction above it — 25.001% on a 25 km route. Re-deriving the tolerance here from the
       authority's own constants rather than hard-coding 25 keeps the two from drifting apart. */
    const tol = 100 / q.customerCharge.minorUnits;
    const inBand = realised >= DQ.SHARE_MIN_PCT && realised <= DQ.SHARE_MAX_PCT + tol;
    if (!inBand) allInBand = false;
    if (q.riderEarning.minorUnits <= 0) allRiderPositive = false;
    console.log('    ' + v.padEnd(11) + String(km).padStart(3) + ' km/' + String(min).padStart(3) + ' min'
      + '   customer ' + kes(q.customerCharge).padStart(8)
      + '   rider ' + kes(q.riderEarning).padStart(8)
      + '   SOKONI ' + kes(q.sokoniCommission).padStart(7)
      + '   share ' + realised.toFixed(1) + '%');
  } catch (err) { console.log('    ' + v.padEnd(11) + ' REFUSED: ' + err.reason); allInBand = false; }
});
ck('every route lands inside the 16-25% commercial band', allInBand);
ck('every route pays the rider a positive amount', allRiderPositive);

console.log('\n4 - the demand-disabled configuration behaves as intended');
const hi = DQ.quote({ vehicleType: 'motorcycle', distanceKm: 6, estimatedMinutes: 18, demandIndex: 5 }, AS_IF);
const lo = DQ.quote({ vehicleType: 'motorcycle', distanceKm: 6, estimatedMinutes: 18, demandIndex: 1 }, AS_IF);
ck('demand has NO effect on price (demandWeight 0) — no fabricated signal reaches money',
  hi.customerCharge.minorUnits === lo.customerCharge.minorUnits
  && hi.sokoniSharePct === lo.sokoniSharePct,
  'demandIndex 1 vs 5 -> identical charge ' + kes(lo.customerCharge));
ck('distance still moves the share (the curve is live, not flat)',
  DQ.quote({ vehicleType: 'motorcycle', distanceKm: 25, estimatedMinutes: 55, demandIndex: 1 }, AS_IF).sokoniSharePct
  > DQ.quote({ vehicleType: 'motorcycle', distanceKm: 1, estimatedMinutes: 6, demandIndex: 1 }, AS_IF).sokoniSharePct);

console.log('\n5 - bicycle is fail-closed, not faked');
e = refuses(() => DQ.quote({ vehicleType: 'bicycle', distanceKm: 3, estimatedMinutes: 15, demandIndex: 1 }, AS_IF));
ck('a bicycle delivery REFUSES rather than being priced on invented energy economics',
  !!e && e.reason === 'vehicle_class_uneconomised', e && e.reason);

console.log('\n' + '-'.repeat(74));
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
console.log('\n  AWAITING SOKONI BUSINESS APPROVAL:');
console.log('    status               — only an authorised approver may set "approved"');
console.log('    approvedBy           — who approved');
console.log('    effectiveFrom        — from when');
console.log('    bicycle economics    — omit (refuse), reclassify as unpriced, or approve a');
console.log('                           non-energy cost model (needs a schema change)');
console.log('    all figures above    — proposed, not market-verified\n');
process.exit(fail === 0 ? 0 : 1);
