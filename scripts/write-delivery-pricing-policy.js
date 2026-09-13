'use strict';
/* WRITE the SOKONI-APPROVED delivery pricing policy to platformConfig/deliveryPricing.
 *
 *   node scripts/write-delivery-pricing-policy.js --effective-from=<ISO>            (dry run)
 *   node scripts/write-delivery-pricing-policy.js --effective-from=<ISO> --apply    (writes)
 *
 * `--effective-from` IS MANDATORY AND HAS NO DEFAULT. It is a business date: when SOKONI's
 * approved commercial terms begin to apply. Defaulting it to "now" would look harmless and would
 * silently commit SOKONI to an effective date nobody chose — the same class of mistake as
 * defaulting a fuel price. Absent, this refuses and writes nothing.
 *
 * The economics below are the values approved by SOKONI. They are transcribed here ONCE, under
 * review, and are never recomputed or adjusted by this script. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DQ = require(path.join(ROOT, 'functions', 'delivery-quote-authority'));

const args = process.argv.slice(2);
const APPLY = args.indexOf('--apply') !== -1;
const effArg = args.find((a) => a.startsWith('--effective-from='));
const EFFECTIVE_FROM = effArg ? effArg.slice('--effective-from='.length).trim() : '';

/* ── SOKONI-APPROVED v1 ────────────────────────────────────────────────────────────────────
   Approved: share curve distance-only (no demand-index producer exists in production), and
   per-class economics for six classes. BICYCLE IS DELIBERATELY ABSENT — approved disposition is
   "remain unpriced/uneconomised under the existing certified schema", so a bicycle delivery
   refuses `vehicle_class_uneconomised` rather than being priced on invented zero-energy figures. */
const APPROVED = {
  policyVersion: 'v2-goods',
  status: 'approved',
  approvedBy: 'SOKONI business approval',
  effectiveFrom: EFFECTIVE_FROM,
  /* ── GOODS HANDLING TIME ─────────────────────────────────────────────────────────────────
     This is what makes SOKONI a goods-delivery service rather than a passenger fare. The rider
     waits at the merchant, takes custody, hands over and captures proof — real minutes, paid for.

     Expressed as TIME, not as a higher per-minute rate, and that distinction is the whole point.
     Reaching the KES 180 benchmark by raising `riderTimeKESPerMinute` to ~13.50 would hit the same
     1.9 km number, but the premium would then scale with trip length: a 50 km run would go from
     KES 1,150 to KES 2,283. Handling overhead does not grow with distance. Modelled as flat
     baseline minutes, 50 km rises only to ~KES 1,263 and the KES/km taper survives.

     `baselineMinutes: 17` is what produces ~KES 180 for the 1.9 km / 10 min motorcycle benchmark
     — derived from the target, not a special case: the same 17 minutes apply to every distance
     and every class, which is why the whole curve stays coherent. The previous hard-coded 2/5/3
     handling constants lived in the authority and are now here, where commercial values belong. */
  handling: {
    baselineMinutes: 17,
    perExtraPackageMinutes: 2,
    perExtraStopMinutes: 5,
    fragileMinutes: 3,
  },
  shareCurve: {
    distanceWeight: 1.00,
    demandWeight: 0.00,
    saturationKm: 20,
    /* Schema requires > 1. With demandWeight 0 this is multiplied by zero and is INERT — a schema
       placeholder, not a commercial lever. Approved as 2. */
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
    },
  },
};

/* Exported so certification runs against THE approved values rather than a transcription of them.
   A second copy is how a certified figure and a written figure quietly drift apart.
   Everything below is the CLI; requiring this module must not execute it. (Top-level `return` is
   legal in CommonJS — the module body is wrapped in a function.) */
module.exports = { APPROVED };
if (require.main !== module) return;

const fail = (m) => { console.error('\n  BLOCKED: ' + m + '\n'); process.exit(1); };

console.log('\nSOKONI DELIVERY PRICING POLICY v1 — ' + (APPLY ? 'APPLY' : 'DRY RUN') + '\n');

if (!EFFECTIVE_FROM) {
  fail('--effective-from was not supplied.\n'
    + '           `effectiveFrom` is a BUSINESS date — when SOKONI\'s approved terms begin to apply.\n'
    + '           It has no engineering default and will not be invented. Nothing was written.\n'
    + '           Supply it explicitly, e.g. --effective-from=2026-10-01');
}
if (Number.isNaN(Date.parse(EFFECTIVE_FROM))) {
  fail('--effective-from="' + EFFECTIVE_FROM + '" is not a parseable date.');
}

/* Validate against the REAL authority before going anywhere near Firestore. */
try { DQ.assertPolicy(APPROVED); }
catch (e) { fail('the approved policy does not satisfy the certified schema: ' + e.reason + ' (' + e.detail + ')'); }
console.log('  schema validation : PASSED');
console.log('  policyVersion     : ' + APPROVED.policyVersion);
console.log('  effectiveFrom     : ' + APPROVED.effectiveFrom);
console.log('  classes priced    : ' + Object.keys(APPROVED.economics.vehicleClasses).join(', '));
console.log('  bicycle           : ABSENT by approved disposition (refuses vehicle_class_uneconomised)');

if (!APPLY) {
  console.log('\n  DRY RUN — nothing written. Re-run with --apply to write.\n');
  process.exit(0);
}

const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();

(async () => {
  const ref = db.collection('platformConfig').doc('deliveryPricing');
  const existing = await ref.get();
  if (existing.exists) {
    /* Never silently overwrite an approved commercial policy. Superseding one is its own
       decision, and it must not happen as a side effect of re-running this script. */
    fail('platformConfig/deliveryPricing ALREADY EXISTS (policyVersion='
      + existing.data().policyVersion + '). Superseding an approved policy is a separate '
      + 'authorised action — this script will not overwrite it.');
  }
  await ref.create(Object.assign({}, APPROVED, { writtenAt: new Date().toISOString() }));
  console.log('\n  WRITTEN to platformConfig/deliveryPricing');

  /* Read back through the real loader — the only proof that matters. */
  const loaded = await DQ.loadPolicy(db);
  if (!loaded) fail('written, but loadPolicy() refused it on read-back');
  console.log('  read-back via loadPolicy : ACCEPTED (policyVersion=' + loaded.policyVersion + ')');
  process.exit(0);
})().catch((e) => { console.error('  WRITE FAILED: ' + e.message); process.exit(1); });
