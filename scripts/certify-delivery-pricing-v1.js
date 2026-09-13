'use strict';
/* FINAL Step 4 certification of the SOKONI-APPROVED v1 pricing policy.
 *
 *   node scripts/certify-delivery-pricing-v1.js
 *
 * Runs the approved values — imported from the writer, never re-transcribed — against every item
 * on the Gate B verification list. A specimen `effectiveFrom` is supplied IN MEMORY only, because
 * the real business effective date has not been authorised and is not invented here; that is the
 * one item this cannot certify, and it is reported as blocked rather than skipped. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DQ = require(path.join(ROOT, 'functions', 'delivery-quote-authority'));
const money = require(path.join(ROOT, 'functions', 'money-authority'));
const { APPROVED } = require(path.join(ROOT, 'scripts', 'write-delivery-pricing-policy'));

/* The approved policy, with a SPECIMEN effective date so the arithmetic can be exercised.
   The real one is a business decision and remains outstanding. */
const P = Object.assign({}, APPROVED, { effectiveFrom: '2026-10-01 (SPECIMEN — not authorised)' });

let pass = 0, fail = 0, blocked = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 78) + ']' : '')); ok ? pass++ : fail++; };
const blk = (l, why) => { console.log('  BLOCK ' + l + '   [' + why + ']'); blocked++; };
const refuses = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const trip = (v, km, min, extra) => Object.assign({ vehicleType: v, distanceKm: km, estimatedMinutes: min, demandIndex: 1 }, extra || {});
const kes = (m) => (m.minorUnits / 100).toFixed(2);

console.log('\nSTEP 4 FINAL CERTIFICATION — SOKONI approved pricing policy v1\n');

/* 1 ── policy loads */
console.log('1 - policy loads');
blk('the policy loads from platformConfig/deliveryPricing',
  'not written — blocked on an authorised effectiveFrom');
ck('1b the approved values satisfy the certified schema', !refuses(() => DQ.assertPolicy(P)));

/* 2 ── accepted only when approved */
console.log('\n2 - accepted only when status === "approved"');
['draft', 'pending', 'retired', 'APPROVED', ''].forEach((s, i) => {
  const e = refuses(() => DQ.assertPolicy(Object.assign({}, P, { status: s })));
  ck('2' + String.fromCharCode(97 + i) + ' status="' + s + '" is refused', !!e, e && e.reason);
});
ck('2f CONTROL: status="approved" is accepted', !refuses(() => DQ.assertPolicy(P)));

/* 3 ── the seven classes, per approved disposition */
console.log('\n3 - all seven vehicle classes per the approved disposition');
['motorcycle', 'ebike', 'tuktuk', 'car', 'van', 'truck'].forEach((v, i) => {
  let q = null; const e = refuses(() => { q = DQ.quote(trip(v, 10, 25), P); });
  ck('3' + String.fromCharCode(97 + i) + ' ' + v.padEnd(10) + ' prices', !e && !!q,
    q ? 'customer ' + kes(q.customerCharge) + '  rider ' + kes(q.riderEarning) + '  ' + q.sokoniSharePct + '%' : e && e.reason);
});

/* 4 ── bicycle fail-closed */
console.log('\n4 - bicycle remains fail-closed');
const bike = refuses(() => DQ.quote(trip('bicycle', 3, 15), P));
ck('4a a bicycle delivery REFUSES', !!bike && bike.reason === 'vehicle_class_uneconomised', bike && bike.reason);
ck('4b bicycle carries NO economics in the approved policy',
  !('bicycle' in P.economics.vehicleClasses));

/* 5 ── demand inert */
console.log('\n5 - demand is mathematically inert at demandWeight 0');
const d1 = DQ.quote(trip('motorcycle', 6, 18, { demandIndex: 1 }), P);
const d9 = DQ.quote(trip('motorcycle', 6, 18, { demandIndex: 9 }), P);
ck('5a demandIndex 1 vs 9 produce an IDENTICAL charge',
  d1.customerCharge.minorUnits === d9.customerCharge.minorUnits, kes(d1.customerCharge));
ck('5b ...and an identical rider earning and share',
  d1.riderEarning.minorUnits === d9.riderEarning.minorUnits && d1.sokoniSharePct === d9.sokoniSharePct);

/* 6 ── long routes in band */
console.log('\n6 - 20 km+ routes stay inside the corrected band');
let longOk = true;
[['motorcycle', 20, 45], ['motorcycle', 25, 55], ['motorcycle', 60, 120], ['van', 20, 45], ['truck', 30, 70], ['car', 45, 90]]
  .forEach(([v, km, min]) => {
    try {
      const q = DQ.quote(trip(v, km, min), P);
      const realised = (q.sokoniCommission.minorUnits * 100) / q.customerCharge.minorUnits;
      const ok = realised >= DQ.SHARE_MIN_PCT && realised <= DQ.SHARE_MAX_PCT + (100 / q.customerCharge.minorUnits);
      if (!ok) longOk = false;
      console.log('    ' + v.padEnd(11) + String(km).padStart(3) + ' km  customer ' + kes(q.customerCharge).padStart(9)
        + '  rider ' + kes(q.riderEarning).padStart(9) + '  share ' + realised.toFixed(3) + '%');
    } catch (e) { longOk = false; console.log('    ' + v + ' ' + km + 'km REFUSED: ' + e.reason); }
  });
ck('6a every long route prices and stays in band', longOk);

/* 7 ── version pinning */
console.log('\n7 - quote pins the policy version');
const q7 = DQ.quote(trip('motorcycle', 6, 18), P);
/* Derived from the approved policy, not hard-coded: a literal here goes stale the moment a new
   policy version is approved, and then reports a version mismatch as a code failure. */
ck('7a the quote records the APPROVED policyVersion',
  q7.pricingInputs.policy.policyVersion === APPROVED.policyVersion,
  q7.pricingInputs.policy.policyVersion + ' (approved: ' + APPROVED.policyVersion + ')');
ck('7b the quote records its pricing schema version', q7.pricingVersion === DQ.PRICING_VERSION, q7.pricingVersion);
ck('7c the quote records who approved the commercial values',
  /SOKONI/.test(q7.pricingInputs.policy.approvedBy), q7.pricingInputs.policy.approvedBy);

/* 8 ── settlement accepts the matching quote */
console.log('\n8 - settlement accepts the matching quote');
const pin = { quoteId: q7.quoteId, pricingVersion: q7.pricingVersion, sokoniSharePct: q7.sokoniSharePct,
  customerCharge: q7.customerCharge, riderEarning: q7.riderEarning, sokoniCommission: q7.sokoniCommission,
  pricingInputs: q7.pricingInputs };
ck('8a the pinned quote settles for exactly the pinned earning',
  DQ.assertSettleable(pin, null, { currentPolicy: P }).minorUnits === q7.riderEarning.minorUnits, kes(q7.riderEarning));
ck('8b conservation holds on the settled figures',
  q7.customerCharge.minorUnits === q7.riderEarning.minorUnits + q7.sokoniCommission.minorUnits);

/* 9 ── policy drift */
console.log('\n9 - policy drift refuses settlement');
const bumped = Object.assign({}, P, { policyVersion: 'v2' });
let e9 = refuses(() => DQ.assertSettleable(pin, null, { currentPolicy: bumped }));
ck('9a a policyVersion bump yields earning_renegotiated', !!e9 && e9.reason === 'earning_renegotiated', e9 && e9.reason);
const curved = Object.assign({}, P, { shareCurve: Object.assign({}, P.shareCurve, { saturationKm: 5 }) });
e9 = refuses(() => DQ.assertSettleable(pin, null, { currentPolicy: curved }));
ck('9b a curve change with the SAME version is also caught', !!e9 && e9.reason === 'earning_renegotiated', e9 && e9.reason);

/* 10 ── browser tampering */
console.log('\n10 - the browser cannot alter authoritative economics');
const dirty = DQ.quote(trip('motorcycle', 6, 18, {
  deliveryFee: 99999, driverNet: 88888, riderEarning: 77777, platformCut: 1, sokoniSharePct: 1,
  energyCostKESPerUnit: 1, riderTimeKESPerMinute: 999,
}), P);
ck('10a client-supplied money/economics have ZERO effect',
  dirty.riderEarning.minorUnits === d1.riderEarning.minorUnits
  && dirty.customerCharge.minorUnits === d1.customerCharge.minorUnits,
  'clean ' + kes(d1.riderEarning) + ' vs tampered ' + kes(dirty.riderEarning));
ck('10b a producer payload carrying pricing fields is REFUSED',
  !!refuses(() => DQ.assertNoClientPricing({ deliveryFee: 500 })));

/* 11 ── duplicate / retry settlement */
console.log('\n11 - duplicate and retry settlement cannot double-credit');
const ledger = new Map();
const settle = (p) => { const amt = DQ.assertSettleable(p, null, { currentPolicy: P }).minorUnits;
  if (ledger.has(p.quoteId)) throw new Error('DUPLICATE_SETTLEMENT');
  ledger.set(p.quoteId, amt); return amt; };
settle(pin);
let e11 = refuses(() => settle(pin));
ck('11a settling the same quoteId twice is rejected', !!e11 && /DUPLICATE/.test(e11.message));
ck('11b the ledger holds ONE credit of the pinned amount',
  ledger.size === 1 && ledger.get(pin.quoteId) === q7.riderEarning.minorUnits, kes(q7.riderEarning));
ck('11c a retry is idempotent — repeated assertSettleable returns the same figure, never doubles',
  DQ.assertSettleable(pin, null, { currentPolicy: P }).minorUnits
  === DQ.assertSettleable(pin, null, { currentPolicy: P }).minorUnits);

/* 12 ── commercial benchmarks ─────────────────────────────────────────────────────────────
   Targets supplied by SOKONI for a 1.9 km goods delivery. Reported against the curve rather than
   tuned to individually, because hitting each one separately would mean per-class exceptions —
   the brittleness this whole rebuild exists to remove. */
console.log('\n12 - commercial benchmark, 1.9 km / 10 min');
const TARGETS = { motorcycle: [170, 190], ebike: [160, 180], tuktuk: [220, 260],
  car: [280, 330], van: [350, 450], truck: [500, Infinity] };
const misses = [];
Object.entries(TARGETS).forEach(([cls, [lo, hi]]) => {
  const q = DQ.quote(trip(cls, 1.9, 10), P);
  const v = q.customerCharge.minorUnits / 100;
  const ok = v >= lo && v <= hi;
  if (!ok) misses.push(cls + ' KES ' + v.toFixed(2) + ' vs target ' + lo + (hi === Infinity ? '+' : '-' + hi));
  console.log('    ' + (ok ? 'IN  ' : 'OUT ') + cls.padEnd(11) + 'KES ' + v.toFixed(2).padStart(8)
    + '   target ' + (hi === Infinity ? lo + '+' : lo + '-' + hi));
});
ck('12a the motorcycle benchmark is met (the approved target)',
  (() => { const v = DQ.quote(trip('motorcycle', 1.9, 10), P).customerCharge.minorUnits / 100;
    return v >= TARGETS.motorcycle[0] && v <= TARGETS.motorcycle[1]; })(),
  'KES ' + (DQ.quote(trip('motorcycle', 1.9, 10), P).customerCharge.minorUnits / 100).toFixed(2));
ck('12b the curve is monotonic in distance for every class',
  (() => {
    for (const cls of ['motorcycle', 'ebike', 'tuktuk', 'car', 'van', 'truck']) {
      let prev = 0;
      for (const [km, min] of [[1, 6], [1.9, 10], [3, 14], [5, 20], [10, 30], [20, 45], [30, 65], [50, 100]]) {
        const c = DQ.quote(trip(cls, km, min), P).customerCharge.minorUnits;
        if (c < prev) return false; prev = c;
      }
    }
    return true;
  })());
ck('12c effective KES/km FALLS with distance (no long-trip penalty)',
  (() => { const a = DQ.quote(trip('motorcycle', 1.9, 10), P).customerCharge.minorUnits / 1.9;
    const b = DQ.quote(trip('motorcycle', 50, 100), P).customerCharge.minorUnits / 50;
    return b < a; })());
if (misses.length) {
  console.log('\n    NOT MET (reported, not tuned around): ');
  misses.forEach((m) => console.log('      ! ' + m));
}

console.log('\n' + '-'.repeat(74));
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed, ' + blocked + ' blocked');
if (blocked) {
  console.log('\n  BLOCKED (not failed): the policy is not written to production because\n'
    + '  `effectiveFrom` is a business date that has not been authorised. Everything that can be\n'
    + '  certified without it is certified above.');
}
process.exit(fail === 0 ? 0 : 1);
