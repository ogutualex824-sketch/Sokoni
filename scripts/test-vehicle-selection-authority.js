'use strict';
/* VEHICLE SELECTION AUTHORITY — certification.
 *
 *   node scripts/test-vehicle-selection-authority.js
 *
 * Vehicle choice IS a financial decision: it selects which economics price the trip. So this is
 * tested the way a money authority is tested — can a caller manufacture a cheaper or dearer
 * vehicle than the shipment warrants, and does the engine refuse rather than guess when the data
 * needed to choose safely is missing?
 *
 * Selection and pricing are exercised TOGETHER at the end: choosing a different vehicle must
 * produce that vehicle's authoritative economics, not a relabelled price. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const VS = require(path.join(ROOT, 'functions', 'vehicle-selection-authority'));
const DQ = require(path.join(ROOT, 'functions', 'delivery-quote-authority'));
const { APPROVED } = require(path.join(ROOT, 'scripts', 'write-delivery-pricing-policy'));

const P = Object.assign({}, APPROVED, { effectiveFrom: 'TEST-ONLY' });

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 82) + ']' : '')); ok ? pass++ : fail++; };
const ckt = (l, fn, d) => { try { ck(l, fn() === true, typeof d === 'function' ? d() : d); } catch (e) { ck(l, false, 'THREW: ' + e.message); } };
const refuses = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const pick = (shipment) => VS.selectVehicle(shipment, P).vehicleClass;
const kes = (m) => (m.minorUnits / 100).toFixed(2);

(async () => {
  console.log('\nVEHICLE SELECTION AUTHORITY — certification\n');

  /* ── A. Smallest suitable, driven by capacity ─────────────────────────────────────────── */
  console.log('A - the smallest SUITABLE class wins (not the largest, not the cheapest)');
  ckt('A1 a 2 kg parcel does not get a truck', () => pick({ parcels: [{ weightKg: 2 }] }) === 'ebike',
    () => pick({ parcels: [{ weightKg: 2 }] }));
  ckt('A2 12 kg still fits the small end', () => ['ebike', 'motorcycle'].includes(pick({ totalWeightKg: 12 })),
    () => pick({ totalWeightKg: 12 }));
  ckt('A3 14 kg moves up to motorcycle (ebike capacity is 12 kg)',
    () => pick({ totalWeightKg: 14 }) === 'motorcycle', () => pick({ totalWeightKg: 14 }));
  ckt('A4 30 kg -> tuktuk', () => pick({ totalWeightKg: 30 }) === 'tuktuk', () => pick({ totalWeightKg: 30 }));
  ckt('A5 45 kg -> car', () => pick({ totalWeightKg: 45 }) === 'car', () => pick({ totalWeightKg: 45 }));
  ckt('A6 150 kg -> van', () => pick({ totalWeightKg: 150 }) === 'van', () => pick({ totalWeightKg: 150 }));
  ckt('A7 800 kg -> truck', () => pick({ totalWeightKg: 800 }) === 'truck', () => pick({ totalWeightKg: 800 }));
  ckt('A8 beyond every declared capacity REFUSES rather than overloading a truck',
    () => { const e = refuses(() => pick({ totalWeightKg: 5000 }));
      return !!e && e.reason === 'shipment_exceeds_all_capacities'; });

  /* ── B. DISTANCE MUST NOT INFLUENCE THE VEHICLE ───────────────────────────────────────── */
  console.log('\nB - distance does not choose the vehicle (the stated failure mode)');
  ckt('B1 a 2 kg parcel going 30 km is still a small vehicle, not a van',
    () => pick({ parcels: [{ weightKg: 2 }], routeKm: 30 }) === pick({ parcels: [{ weightKg: 2 }], routeKm: 1 }),
    () => pick({ parcels: [{ weightKg: 2 }], routeKm: 30 }));
  ckt('B2 a heavy shipment going 2 km is still a large vehicle, not a boda',
    () => pick({ totalWeightKg: 400, routeKm: 2 }) === 'truck', () => pick({ totalWeightKg: 400, routeKm: 2 }));
  ckt('B3 the engine ignores route fields entirely (they are pricing inputs, not capacity)',
    () => pick({ totalWeightKg: 100, routeKm: 99, estimatedMinutes: 500 }) === 'van');

  /* ── C. Multiple parcels combine ───────────────────────────────────────────────────────── */
  console.log('\nC - parcels combine by WEIGHT, never by arbitrary count');
  ckt('C1 15 envelopes (0.2 kg each) are NOT a van', () => pick({ parcels: Array(15).fill({ weightKg: 0.2 }) }) === 'ebike',
    () => '3 kg -> ' + pick({ parcels: Array(15).fill({ weightKg: 0.2 }) }));
  ckt('C2 5 parcels of 2 kg = 10 kg -> small vehicle',
    () => pick({ parcels: Array(5).fill({ weightKg: 2 }) }) === 'ebike');
  ckt('C3 15 parcels of 2 kg = 30 kg -> tuktuk (weight decided, not the count)',
    () => pick({ parcels: Array(15).fill({ weightKg: 2 }) }) === 'tuktuk');
  ckt('C4 quantity multiplies a parcel line',
    () => VS.selectVehicle({ parcels: [{ weightKg: 2, quantity: 10 }] }, P).shipment.totalWeightKg === 20);
  ckt('C5 the aggregate weight is reported for audit',
    () => VS.selectVehicle({ parcels: Array(15).fill({ weightKg: 2 }) }, P).shipment.totalWeightKg === 30);

  /* ── D. Insufficient data refuses ──────────────────────────────────────────────────────── */
  console.log('\nD - missing data REFUSES; it never guesses small or large');
  [['no weight anywhere', { packageCount: 3 }],
   ['a parcel with no weight', { parcels: [{ weightKg: 1 }, { lengthCm: 10 }] }],
   ['partial dimensions', { parcels: [{ weightKg: 3, lengthCm: 120 }] }],
   ['empty shipment', {}]].forEach(([label, s], i) => {
    const e = refuses(() => pick(s));
    ck('D' + (i + 1) + ' ' + label + ' REFUSES',
      !!e && e.reason === 'vehicle_selection_insufficient_data', e ? e.reason : 'SELECTED ANYWAY');
  });
  ckt('D5 dimensions with NO declared volume capacity REFUSE (bulk cannot be judged on weight)',
    () => { const e = refuses(() => pick({ parcels: [{ weightKg: 3, lengthCm: 120, widthCm: 80, heightCm: 70 }] }));
      return !!e && e.reason === 'vehicle_selection_insufficient_data'; },
    'a bulky-but-light load must not silently ride a boda');
  ckt('D6 hazardous goods REFUSE (no class declares the capability)',
    () => { const e = refuses(() => pick({ totalWeightKg: 5, hazardous: true }));
      return !!e && e.reason === 'hazardous_goods_unsupported'; });

  /* ── E. A caller cannot manufacture a vehicle ──────────────────────────────────────────── */
  console.log('\nE - a requested vehicle is VALIDATED, not honoured');
  ckt('E1 requesting a truck for a 2 kg parcel is REFUSED (buying truck economics)',
    () => { const e = refuses(() => VS.assertVehicleSuitable('truck', { parcels: [{ weightKg: 2 }] }, P));
      return !!e && e.reason === 'requested_vehicle_oversized'; },
    () => (refuses(() => VS.assertVehicleSuitable('truck', { parcels: [{ weightKg: 2 }] }, P)) || {}).message);
  ckt('E2 requesting a motorcycle for 150 kg is REFUSED (rider cannot carry it)',
    () => { const e = refuses(() => VS.assertVehicleSuitable('motorcycle', { totalWeightKg: 150 }, P));
      return !!e && e.reason === 'requested_vehicle_too_small'; });
  ckt('E3 CONTROL: requesting the class that actually fits is ACCEPTED',
    () => VS.assertVehicleSuitable('ebike', { parcels: [{ weightKg: 2 }] }, P).vehicleClass === 'ebike');
  ckt('E4 an unknown vehicle token is REFUSED',
    () => { const e = refuses(() => VS.assertVehicleSuitable('spaceship', { totalWeightKg: 2 }, P));
      return !!e && e.reason === 'vehicle_class_unknown'; });
  ckt('E5 an UNPRICED class (pickup) is REFUSED',
    () => { const e = refuses(() => VS.assertVehicleSuitable('pickup', { totalWeightKg: 2 }, P));
      return !!e && e.reason === 'vehicle_class_unpriced'; });

  /* ── F. Explainability ─────────────────────────────────────────────────────────────────── */
  console.log('\nF - every decision is explainable and auditable');
  const d = VS.selectVehicle({ parcels: Array(15).fill({ weightKg: 2 }) }, P);
  ckt('F1 the decision names the class', () => typeof d.vehicleClass === 'string' && !!d.vehicleClass);
  ckt('F2 it gives a human reason', () => /capacity/i.test(d.vehicleSelectionReason), () => d.vehicleSelectionReason);
  ckt('F3 it states the capacityBasis', () => d.capacityBasis === 'weight', () => d.capacityBasis);
  ckt('F4 it records what was considered, in order', () => Array.isArray(d.consideredInOrder) && d.consideredInOrder.length > 1,
    () => d.consideredInOrder.join(' < '));
  ckt('F5 it records WHY smaller classes were rejected', () => d.rejectedBefore.length > 0,
    () => d.rejectedBefore.join(' | '));
  ckt('F6 the same shipment always yields the same decision (deterministic)',
    () => { const a = []; for (let i = 0; i < 50; i++) a.push(pick({ totalWeightKg: 27 }));
      return new Set(a).size === 1; });
  ckt('F7 a class with no approved economics is skipped WITH a reason, not silently',
    () => d.rejectedBefore.some((r) => /bicycle.*no approved economics/.test(r)),
    () => d.rejectedBefore[0]);

  /* ── G. Selection feeds PRICING — different vehicle, different economics ───────────────── */
  console.log('\nG - selection drives the authoritative economics (it does not price)');
  const priceFor = (shipment, km, min) => {
    const sel = VS.selectVehicle(shipment, P);
    const q = DQ.quote({ vehicleType: sel.vehicleClass, distanceKm: km, estimatedMinutes: min, demandIndex: 1,
      packageCount: sel.shipment.packageCount, shopCount: sel.shipment.pickupCount }, P);
    return { cls: sel.vehicleClass, q };
  };
  const light = priceFor({ parcels: [{ weightKg: 2 }] }, 5, 20);
  const heavy = priceFor({ totalWeightKg: 400 }, 5, 20);
  console.log('    same 5 km trip:  ' + light.cls.padEnd(11) + 'KES ' + kes(light.q.customerCharge)
    + '   vs  ' + heavy.cls.padEnd(7) + 'KES ' + kes(heavy.q.customerCharge));
  ckt('G1 a heavier shipment selects a larger class AND costs more',
    () => heavy.cls !== light.cls && heavy.q.customerCharge.minorUnits > light.q.customerCharge.minorUnits);
  ckt('G2 the price comes from THAT class\'s approved economics',
    () => heavy.q.vehicleType === heavy.cls && light.q.vehicleType === light.cls);
  ckt('G3 selection never produces a class the pricing authority must refuse',
    () => [{ totalWeightKg: 1 }, { totalWeightKg: 12 }, { totalWeightKg: 30 }, { totalWeightKg: 150 }, { totalWeightKg: 900 }]
      .every((s) => { try { const sel = VS.selectVehicle(s, P);
        DQ.quote({ vehicleType: sel.vehicleClass, distanceKm: 5, estimatedMinutes: 20, demandIndex: 1 }, P);
        return true; } catch (e) { return false; } }));
  ckt('G4 a multi-stop shipment carries its stop count into pricing',
    () => { const sel = VS.selectVehicle({ totalWeightKg: 10, pickupCount: 3 }, P);
      const q = DQ.quote({ vehicleType: sel.vehicleClass, distanceKm: 5, estimatedMinutes: 20, demandIndex: 1,
        shopCount: sel.shipment.pickupCount }, P);
      return q.pricingInputs.handling.extraStops === 2 * P.handling.perExtraStopMinutes; },
    'extra pickups become paid minutes, not a bigger vehicle');

  /* ── H. The commercial benchmark still emerges ─────────────────────────────────────────── */
  console.log('\nH - the approved motorcycle benchmark is unaffected by this layer');
  const benchSel = VS.assertVehicleSuitable('motorcycle', { totalWeightKg: 14 }, P);
  const benchQ = DQ.quote({ vehicleType: benchSel.vehicleClass, distanceKm: 1.9, estimatedMinutes: 10, demandIndex: 1 }, P);
  ckt('H1 a 14 kg shipment selects motorcycle', () => benchSel.vehicleClass === 'motorcycle');
  ckt('H2 ...and 1.9 km / 10 min still prices at the approved benchmark',
    () => { const v = benchQ.customerCharge.minorUnits / 100; return v >= 170 && v <= 190; },
    () => 'KES ' + kes(benchQ.customerCharge));

  console.log('\n' + '-'.repeat(74));
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack || e); process.exit(1); });
