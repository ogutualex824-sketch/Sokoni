'use strict';
/* SOKONI goods-delivery RATE CARD analysis.
 *
 *   node scripts/analyse-delivery-rate-card.js [--policy=v1|candidate]
 *
 * Shows what the certified authority ACTUALLY produces across distance and vehicle class, so a
 * commercial target can be judged against the whole curve rather than a single point. Tuning one
 * number until one distance matches a target is how a brittle exception gets built; this exists to
 * make that impossible to do accidentally. Read-only, writes nothing. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DQ = require(path.join(ROOT, 'functions', 'delivery-quote-authority'));
const { APPROVED } = require(path.join(ROOT, 'scripts', 'write-delivery-pricing-policy'));

/* Drive time assumed per distance — a plausible urban profile, used ONLY to drive the analysis.
   It is not policy and is not written anywhere. */
const PROFILE = [
  [1, 6], [1.9, 10], [3, 14], [5, 20], [10, 30], [20, 45], [30, 65], [50, 100],
];
const CLASSES = ['motorcycle', 'ebike', 'tuktuk', 'car', 'van', 'truck'];

const arg = process.argv.find((a) => a.startsWith('--policy='));
const which = arg ? arg.slice('--policy='.length) : 'v1';

function policyFor(name) {
  const p = JSON.parse(JSON.stringify(APPROVED));
  p.effectiveFrom = 'ANALYSIS-ONLY';
  if (name === 'v1') return p;
  throw new Error('unknown policy: ' + name);
}

const P = policyFor(which);
const kes = (m) => (m.minorUnits / 100).toFixed(2);

console.log('\nSOKONI GOODS DELIVERY RATE CARD — policy ' + P.policyVersion + ' (analysis only)\n');
console.log('  curve: distanceWeight ' + P.shareCurve.distanceWeight + ', demandWeight '
  + P.shareCurve.demandWeight + ', saturationKm ' + P.shareCurve.saturationKm);
console.log('  NOTE: trip times below are an assumed urban profile for analysis, not policy.\n');

const flags = [];

for (const cls of CLASSES) {
  console.log('  ' + cls.toUpperCase());
  console.log('    ' + 'km'.padStart(5) + ' ' + 'min'.padStart(4) + ' | '
    + 'operating'.padStart(10) + ' ' + 'riderGross'.padStart(11) + ' ' + 'SOKONI'.padStart(9)
    + ' ' + 'customer'.padStart(10) + ' | ' + 'cust/km'.padStart(8) + ' ' + 'rider/km'.padStart(9)
    + ' ' + 'share'.padStart(6));
  let prevPerKm = null, prevCharge = null;
  for (const [km, min] of PROFILE) {
    let q;
    try {
      q = DQ.quote({ vehicleType: cls, distanceKm: km, estimatedMinutes: min, demandIndex: 1 }, P);
    } catch (e) {
      console.log('    ' + String(km).padStart(5) + ' ' + String(min).padStart(4) + ' | REFUSED: ' + e.reason);
      flags.push(cls + ' @ ' + km + 'km REFUSED (' + e.reason + ')');
      continue;
    }
    const custPerKm = (q.customerCharge.minorUnits / 100) / km;
    const riderPerKm = (q.riderEarning.minorUnits / 100) / km;
    const share = (q.sokoniCommission.minorUnits * 100) / q.customerCharge.minorUnits;
    console.log('    ' + String(km).padStart(5) + ' ' + String(min).padStart(4) + ' | '
      + kes(q.operatingCost).padStart(10) + ' ' + kes(q.riderEarning).padStart(11) + ' '
      + kes(q.sokoniCommission).padStart(9) + ' ' + kes(q.customerCharge).padStart(10) + ' | '
      + custPerKm.toFixed(2).padStart(8) + ' ' + riderPerKm.toFixed(2).padStart(9) + ' '
      + share.toFixed(1).padStart(5) + '%');

    /* Coherence checks across the curve. */
    if (prevCharge !== null && q.customerCharge.minorUnits < prevCharge) {
      flags.push(cls + ': charge DECREASES from the previous distance at ' + km + ' km');
    }
    if (prevPerKm !== null && custPerKm > prevPerKm * 1.05) {
      flags.push(cls + ': effective KES/km RISES with distance at ' + km + ' km ('
        + prevPerKm.toFixed(2) + ' -> ' + custPerKm.toFixed(2) + ') — long trips should not get dearer per km');
    }
    if (q.riderEarning.minorUnits <= q.operatingCost.minorUnits) {
      flags.push(cls + ' @ ' + km + 'km: rider earns no more than their operating cost');
    }
    prevPerKm = custPerKm; prevCharge = q.customerCharge.minorUnits;
  }
  console.log('');
}

/* The commercial benchmark. */
console.log('  ── COMMERCIAL BENCHMARK ────────────────────────────────────────────');
const bench = DQ.quote({ vehicleType: 'motorcycle', distanceKm: 1.9, estimatedMinutes: 10, demandIndex: 1 }, P);
const target = 180;
const actual = bench.customerCharge.minorUnits / 100;
console.log('    motorcycle 1.9 km / 10 min');
console.log('      target customer charge : KES ' + target.toFixed(2) + '  (goods-delivery benchmark)');
console.log('      actual customer charge : KES ' + actual.toFixed(2));
console.log('      gap                    : KES ' + (target - actual).toFixed(2)
  + '  (' + ((actual / target) * 100).toFixed(1) + '% of target)');
console.log('      rider gross            : KES ' + kes(bench.riderEarning));
console.log('      operating cost         : KES ' + kes(bench.operatingCost)
  + '   time value : KES ' + (bench.pricingInputs.timeValueMinor / 100).toFixed(2));
console.log('      SOKONI share           : ' + bench.sokoniSharePct + '%');

console.log('\n  ── FLAGS ───────────────────────────────────────────────────────────');
if (!flags.length) console.log('    none — the curve is monotonic and rider-positive throughout');
else flags.forEach((f) => console.log('    ! ' + f));
console.log('');
process.exit(0);
