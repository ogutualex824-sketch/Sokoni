'use strict';
/* DELIVERY QUOTE AUTHORITY — adversarial certification.
 *
 *   node scripts/test-delivery-quote-authority.js
 *
 * The subject is a FINANCIAL authority, so "it returns a number" certifies nothing. Every group
 * below attacks the property that matters: can anything other than this module decide what SOKONI
 * pays a rider? Positive controls run alongside every refusal test — a module that refuses
 * everything would otherwise pass a hostile-only suite while paying nobody. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DQ = require(path.join(ROOT, 'functions', 'delivery-quote-authority'));
const money = require(path.join(ROOT, 'functions', 'money-authority'));

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).slice(0, 88) + ']' : ''));
  ok ? pass++ : fail++;
};
const ckt = (label, fn, detail) => {
  try { ck(label, fn() === true, typeof detail === 'function' ? detail() : detail); }
  catch (e) { ck(label, false, 'THREW: ' + e.message); }
};
const refuses = (fn) => { try { fn(); return null; } catch (e) { return e; } };

/* The TRIP — what the caller may describe. Note there are no cost figures here: economics live in
   approved policy, so a caller can say where a parcel is going but not what carrying it is worth. */
const BASE = {
  vehicleType: 'motorcycle',
  distanceKm: 6,
  estimatedMinutes: 18,
  demandIndex: 1.0,
  packageCount: 1,
  shopCount: 1,
};
const mk = (o) => Object.assign({}, BASE, o || {});

/* ══ FIXTURE POLICY — NOT SOKONI POLICY, AND CANNOT BECOME IT ══════════════════════════════
   Every number below exists only so the arithmetic can be exercised. They are NOT approved
   commercial values. Production policy is read from `platformConfig/deliveryPricing` by
   `loadPolicy`, which cannot see this file — so these cannot leak into production even by
   accident. `status` is deliberately spelled 'approved' because the fixture must exercise the
   happy path; `policyVersion` and `approvedBy` both shout FIXTURE so any figure traced back to
   this policy is self-identifying. */
const klass = (label, cost, kmPerUnit, maint, minute) => ({
  energyUnitLabel: label, energyCostKESPerUnit: cost,
  efficiencyKmPerUnit: kmPerUnit, maintenanceKESPerKm: maint, riderTimeKESPerMinute: minute,
});
const FIXTURE_POLICY = Object.freeze({
  policyVersion: 'FIXTURE-P0',
  status: 'approved',
  effectiveFrom: '2026-09-13',
  approvedBy: 'FIXTURE-ONLY — not approved for production',
  shareCurve: { distanceWeight: 0.6, demandWeight: 0.4, saturationKm: 20, demandSaturationIndex: 3 },
  economics: {
    demandIndex: { source: 'FIXTURE — not a real market feed' },
    vehicleClasses: {
      motorcycle: klass('litre', 195, 40, 2.5, 6),
      bicycle:    klass('litre', 0, 1000, 0.5, 6),
      ebike:      klass('kWh', 25, 50, 0.8, 6),
      tuktuk:     klass('litre', 195, 25, 3.5, 6),
      car:        klass('litre', 195, 12, 6, 8),
      van:        klass('litre', 190, 8, 9, 10),
      truck:      klass('litre', 190, 4, 15, 12),
    },
  },
});
const withCurve = (o) => Object.assign({}, FIXTURE_POLICY,
  { shareCurve: Object.assign({}, FIXTURE_POLICY.shareCurve, o) });
const Q = (input, policy) => DQ.quote(input, policy === undefined ? FIXTURE_POLICY : policy);
const minor = (m) => m.minorUnits;

(async () => {
  console.log('\nDELIVERY QUOTE AUTHORITY — adversarial certification\n');

  /* ── 0. POSITIVE CONTROL ──────────────────────────────────────────────────────────────── */
  console.log('0 - positive control (a gate that refuses everybody is not a fix)');
  const q = Q(BASE);
  ckt('0a a complete, legitimate request PRODUCES a quote', () => !!q && !!q.quoteId, () => q.quoteId);
  ckt('0b it pays the rider a positive amount', () => minor(q.riderEarning) > 0,
    () => 'rider KES ' + money.toMajorString(q.riderEarning) + ' of ' + money.toMajorString(q.customerCharge));
  ckt('0c every figure is INTEGER minor units (no float money)',
    () => [q.customerCharge, q.riderEarning, q.sokoniCommission, q.operatingCost]
      .every((m) => Number.isInteger(m.minorUnits) && m.currency === 'KES'));

  /* ── A. Browser tampering ─────────────────────────────────────────────────────────────── */
  console.log('\nA - the browser cannot state a price');
  DQ.CLIENT_FORBIDDEN_FIELDS.forEach((f, i) => {
    const e = refuses(() => DQ.assertNoClientPricing({ vehicleType: 'motorcycle', [f]: 999 }));
    if (i < 4) ck('A' + (i + 1) + ' a payload carrying `' + f + '` is REFUSED',
      !!e && e.reason === 'client_supplied_pricing', e && e.message);
  });
  ckt('A5 ALL ' + DQ.CLIENT_FORBIDDEN_FIELDS.length + ' money fields are refused, not just some',
    () => DQ.CLIENT_FORBIDDEN_FIELDS.every((f) =>
      refuses(() => DQ.assertNoClientPricing({ [f]: 1 })) !== null),
    DQ.CLIENT_FORBIDDEN_FIELDS.join(','));
  ckt('A6 CONTROL: a payload with no pricing fields passes',
    () => refuses(() => DQ.assertNoClientPricing({ vehicleType: 'motorcycle', distanceKm: 5 })) === null);
  /* The decisive one: a client-supplied fee must not influence the computed result. */
  const qClean = Q(BASE);
  const qDirty = Q(mk({ deliveryFee: 99999, driverNet: 88888, riderEarning: 77777 }));
  ckt('A7 client-supplied fee/driverNet/riderEarning have ZERO effect on the computed figures',
    () => minor(qDirty.riderEarning) === minor(qClean.riderEarning)
       && minor(qDirty.customerCharge) === minor(qClean.customerCharge),
    () => 'clean ' + minor(qClean.riderEarning) + ' vs dirty ' + minor(qDirty.riderEarning));

  /* ── B. Quote tampering at settlement ─────────────────────────────────────────────────── */
  console.log('\nB - a tampered pinned quote cannot be settled');
  const pinned = { quoteId: q.quoteId, pricingVersion: q.pricingVersion,
    customerCharge: q.customerCharge, riderEarning: q.riderEarning, sokoniCommission: q.sokoniCommission };
  ckt('B0 CONTROL: an untampered pinned quote settles, returning the pinned earning',
    () => minor(DQ.assertSettleable(pinned, pinned.riderEarning)) === minor(q.riderEarning));

  const tamper = (patch) => refuses(() => DQ.assertSettleable(Object.assign({}, pinned, patch)));
  ckt('B1 inflated riderEarning is REFUSED (conservation breaks)',
    () => { const e = tamper({ riderEarning: money.fromMinor(minor(q.riderEarning) * 3) }); return !!e; },
    () => (tamper({ riderEarning: money.fromMinor(minor(q.riderEarning) * 3) }) || {}).reason);
  ckt('B2 altered customerCharge is REFUSED',
    () => !!tamper({ customerCharge: money.fromMinor(minor(q.customerCharge) + 5000) }));
  ckt('B3 altered sokoniCommission is REFUSED',
    () => !!tamper({ sokoniCommission: money.fromMinor(minor(q.sokoniCommission) + 1) }));
  ckt('B4 a foreign pricingVersion is REFUSED',
    () => { const e = tamper({ pricingVersion: 'dq-0.0.0-evil' }); return !!e && e.reason === 'pricing_version_mismatch'; });
  ckt('B5 a missing quoteId is REFUSED',
    () => { const e = tamper({ quoteId: null }); return !!e && e.reason === 'pinned_quote_incomplete'; });
  ckt('B6 a caller claiming MORE than the pinned earning is REFUSED',
    () => { const e = refuses(() => DQ.assertSettleable(pinned, money.fromMinor(minor(q.riderEarning) + 1)));
      return !!e && e.reason === 'claimed_earning_mismatch'; });
  /* A split that still adds up but pays SOKONI outside the mandate must also refuse. */
  ckt('B7 an internally-consistent split OUTSIDE the 16-25% band is REFUSED',
    () => { const c = 100000, r = 95000, s = 5000;  /* 5% — consistent, but not permitted */
      const e = refuses(() => DQ.assertSettleable({ quoteId: 'x', pricingVersion: DQ.PRICING_VERSION,
        customerCharge: money.fromMinor(c), riderEarning: money.fromMinor(r), sokoniCommission: money.fromMinor(s) }));
      return !!e && e.reason === 'pinned_share_out_of_band'; });

  /* ── C. Legacy multipliers are inert ──────────────────────────────────────────────────── */
  console.log('\nC - the legacy splits cannot reappear');
  /* NOTE: a 16-25% commission band means the rider receives 75-84%, so the legacy 0.82 sits
     INSIDE the band. Asserting "the number differs" is therefore weak — at share 18% it differs by
     a single minor unit, i.e. by rounding luck. C1 is kept only as an observation; C1b is the
     assertion that actually protects the rider, because it tests DIRECTION of derivation rather
     than a coincidence of value. */
  const legacy = [0.82, 0.88, 0.80];
  ck('C1 (weak, observational) legacy multipliers do not reproduce the earning exactly',
    legacy.every((m) => Math.round(minor(q.customerCharge) * m) !== minor(q.riderEarning)),
    'charge*' + legacy.join('/') + ' = ' + legacy.map((m) => Math.round(minor(q.customerCharge) * m)).join('/')
      + ' vs authoritative ' + minor(q.riderEarning) + ' — NOTE 0.82 is inside the band');

  /* THE LOAD-BEARING ONE. If rider pay were a slice of the customer charge, then moving a factor
     that changes the charge would change the rider's pay. It must not: demandIndex moves only
     SOKONI's share. Rider earning depends on operating cost and time, and on nothing else. */
  const cheapDemand = Q(mk({ demandIndex: 1.0 }));
  const scarceDemand = Q(mk({ demandIndex: 3.5 }));
  ckt('C1b rider earning is INVARIANT when only the share moves — pay is not a slice of the charge',
    () => minor(cheapDemand.riderEarning) === minor(scarceDemand.riderEarning)
       && minor(cheapDemand.customerCharge) !== minor(scarceDemand.customerCharge),
    () => 'rider ' + minor(cheapDemand.riderEarning) + '=' + minor(scarceDemand.riderEarning)
      + '  charge ' + minor(cheapDemand.customerCharge) + '->' + minor(scarceDemand.customerCharge));
  /* Economics live in policy now, so moving them means moving APPROVED values — which is the
     only legitimate way a rider's pay changes. */
  const richerTime = JSON.parse(JSON.stringify(FIXTURE_POLICY));
  richerTime.economics.vehicleClasses.motorcycle.riderTimeKESPerMinute = 12;
  const dearerFuel = JSON.parse(JSON.stringify(FIXTURE_POLICY));
  dearerFuel.economics.vehicleClasses.motorcycle.energyCostKESPerUnit = 390;
  ckt('C1c rider earning DOES move when the APPROVED economics move',
    () => minor(Q(BASE, richerTime).riderEarning) > minor(q.riderEarning)
       && minor(Q(BASE, dearerFuel).riderEarning) > minor(q.riderEarning),
    () => 'base ' + minor(q.riderEarning) + ' -> time ' + minor(Q(BASE, richerTime).riderEarning)
      + ', fuel ' + minor(Q(BASE, dearerFuel).riderEarning));
  ckt('C2 injecting legacy fields into the request changes nothing',
    () => minor(Q(mk({ riderSharePct: 88, DRIVER_SHARE: 0.88, shareTarget: 0.82 })).riderEarning)
       === minor(qClean.riderEarning));
  ckt('C3 the realised share is NOT one of the legacy splits (80/88 are outside the band)',
    () => q.sokoniSharePct >= DQ.SHARE_MIN_PCT && q.sokoniSharePct <= DQ.SHARE_MAX_PCT,
    () => 'share ' + q.sokoniSharePct + '%');

  /* ── D. Missing economics refuse, never fall back ─────────────────────────────────────── */
  console.log('\nD - absent economics REFUSE (no fallback pricing)');
  /* Cost economics now live in POLICY, so removing them from the policy is the real test. */
  Object.keys({ energyUnitLabel: 1, energyCostKESPerUnit: 1, efficiencyKmPerUnit: 1,
    maintenanceKESPerKm: 1, riderTimeKESPerMinute: 1 }).forEach((f, i) => {
    const pol = JSON.parse(JSON.stringify(FIXTURE_POLICY));
    delete pol.economics.vehicleClasses.motorcycle[f];
    const e = refuses(() => Q(BASE, pol));
    /* PER-LAYER ASSERTION. The completeness check and the downstream type/money checks BOTH refuse
       a missing field, so accepting either reason made the completeness layer invisible — deleting
       it changed nothing the suite could see. Requiring its specific reason keeps that layer
       independently covered, per the standing defence-in-depth rule. */
    ck('D' + (i + 1) + ' policy missing class economics `' + f + '` REFUSES at the COMPLETENESS layer',
      !!e && e.reason === 'pricing_policy_incomplete',
      e ? e.reason : 'QUOTED ANYWAY — fallback pricing');
  });
  [['demandIndex', 'live demand/supply'], ['distanceKm', 'route'], ['estimatedMinutes', 'duration']]
    .forEach(([f, label], i) => {
      const input = mk(); delete input[f];
      const e = refuses(() => Q(input));
      ck('D' + (6 + i) + ' removing ' + label + ' (' + f + ') REFUSES',
        !!e && e.reason === 'missing_economics', e ? e.reason : 'QUOTED ANYWAY — fallback pricing');
    });
  ckt('D9 undefined is not treated as zero (the `undefined !== false` class)',
    () => !!refuses(() => Q(mk({ estimatedMinutes: undefined }))));
  ckt('D9b NaN / non-numeric inputs REFUSE',
    () => !!refuses(() => Q(mk({ distanceKm: NaN }))) && !!refuses(() => Q(mk({ demandIndex: '2' }))));
  ckt('D9c a vehicle class with NO declared economics REFUSES (not priced from another class)',
    () => { const pol = JSON.parse(JSON.stringify(FIXTURE_POLICY));
      delete pol.economics.vehicleClasses.van;
      const e = refuses(() => Q(mk({ vehicleType: 'van' }), pol));
      return !!e && e.reason === 'vehicle_class_uneconomised'; },
    () => (refuses(() => { const p = JSON.parse(JSON.stringify(FIXTURE_POLICY));
      delete p.economics.vehicleClasses.van; return Q(mk({ vehicleType: 'van' }), p); }) || {}).reason);
  ckt('D9d sub-cent money in policy REFUSES (a rider cost basis is not silently rounded)',
    () => { const pol = JSON.parse(JSON.stringify(FIXTURE_POLICY));
      pol.economics.vehicleClasses.motorcycle.maintenanceKESPerKm = 2.505;
      const e = refuses(() => Q(BASE, pol)); return !!e && e.reason === 'pricing_policy_invalid'; });
  ckt('D10 a zero-distance trip REFUSES rather than pricing at zero',
    () => !!refuses(() => Q(mk({ distanceKm: 0 }))));

  /* ── E. Replay ────────────────────────────────────────────────────────────────────────── */
  console.log('\nE - a quote cannot create two obligations');
  const ids = new Set(Array.from({ length: 200 }, () => Q(BASE).quoteId));
  ckt('E1 every quote carries a distinct quoteId (200 draws, no collision)', () => ids.size === 200,
    () => ids.size + '/200 distinct');
  /* A settlement ledger keyed by quoteId is the enforcement; prove the key is usable for it. */
  const ledger = new Map();
  const settleOnce = (pin) => {
    DQ.assertSettleable(pin, pin.riderEarning);
    if (ledger.has(pin.quoteId)) throw new Error('DUPLICATE_SETTLEMENT');
    ledger.set(pin.quoteId, minor(pin.riderEarning));
    return true;
  };
  ckt('E2 settling the same quoteId twice is rejected by a quote-keyed ledger',
    () => { settleOnce(pinned); const e = refuses(() => settleOnce(pinned));
      return !!e && /DUPLICATE_SETTLEMENT/.test(e.message) && ledger.size === 1; });
  ckt('E3 CONTROL: a different quote still settles', () => {
    const q2 = Q(BASE);
    return settleOnce({ quoteId: q2.quoteId, pricingVersion: q2.pricingVersion,
      customerCharge: q2.customerCharge, riderEarning: q2.riderEarning, sokoniCommission: q2.sokoniCommission })
      && ledger.size === 2;
  });

  /* ── F. Conservation ──────────────────────────────────────────────────────────────────── */
  console.log('\nF - customerCharge == riderEarning + sokoniCommission, exactly');
  const cases = [
    mk(), mk({ distanceKm: 1.3, estimatedMinutes: 7 }), mk({ distanceKm: 27, estimatedMinutes: 64 }),
    mk({ vehicleType: 'car', distanceKm: 14.7, estimatedMinutes: 33, energyUnitsPerKm: 0.09 }),
    mk({ vehicleType: 'van', distanceKm: 41.2, estimatedMinutes: 95, energyUnitsPerKm: 0.14, demandIndex: 2.4 }),
    mk({ vehicleType: 'bicycle', distanceKm: 2.1, estimatedMinutes: 14, energyUnitCostMinor: 0, energyUnitsPerKm: 0.001 }),
    mk({ vehicleType: 'ebike', distanceKm: 5.5, estimatedMinutes: 17, energyUnitCostMinor: 2500, energyUnitsPerKm: 0.02 }),
    mk({ vehicleType: 'tuktuk', distanceKm: 9.9, estimatedMinutes: 29, demandIndex: 3.1 }),
    mk({ packageCount: 6, shopCount: 4, fragile: true, distanceKm: 12, estimatedMinutes: 40 }),
  ];
  const quotes = cases.map((c) => Q(c));
  ckt('F1 conservation holds on EVERY case (' + quotes.length + ')',
    () => quotes.every((x) => minor(x.customerCharge) === minor(x.riderEarning) + minor(x.sokoniCommission)));
  ckt('F2 no figure is negative', () => quotes.every((x) =>
    minor(x.customerCharge) >= 0 && minor(x.riderEarning) > 0 && minor(x.sokoniCommission) >= 0));
  ckt('F3 rider earning always covers operating cost',
    () => quotes.every((x) => minor(x.riderEarning) >= minor(x.operatingCost)));

  /* ── G. Dynamic band ──────────────────────────────────────────────────────────────────── */
  console.log('\nG - the SOKONI share is dynamic and inside 16-25%');
  const shares = quotes.map((x) => x.sokoniSharePct);
  ckt('G1 every realised share is within [16, 25]',
    () => quotes.every((x) => {
      const s = minor(x.sokoniCommission) * 100, c = minor(x.customerCharge);
      return s >= DQ.SHARE_MIN_PCT * c && s <= DQ.SHARE_MAX_PCT * c;
    }), () => 'declared: ' + shares.join(','));
  ckt('G2 the share is NOT a fixed universal percentage', () => new Set(shares).size > 1,
    () => new Set(shares).size + ' distinct values: ' + [...new Set(shares)].sort((a, b) => a - b).join(','));
  ckt('G3 a longer route carries a higher share than a short one',
    () => Q(mk({ distanceKm: 25, estimatedMinutes: 60 })).sokoniSharePct
        > Q(mk({ distanceKm: 1.5, estimatedMinutes: 8 })).sokoniSharePct);
  ckt('G4 scarce supply raises the share',
    () => Q(mk({ demandIndex: 3.5 })).sokoniSharePct > Q(mk({ demandIndex: 1.0 })).sokoniSharePct);
  ckt('G5 the band floor is respected at the cheapest possible trip',
    () => { const x = Q(mk({ distanceKm: 0.4, estimatedMinutes: 3, demandIndex: 1 }));
      return x.sokoniSharePct >= DQ.SHARE_MIN_PCT; });

  /* ── H. Multi-shop ────────────────────────────────────────────────────────────────────── */
  console.log('\nH - multi-shop is priced ONCE, in the quote');
  const one = Q(mk({ shopCount: 1, packageCount: 1 }));
  const many = Q(mk({ shopCount: 4, packageCount: 6 }));
  ckt('H1 extra stops and parcels raise the rider earning', () => minor(many.riderEarning) > minor(one.riderEarning),
    () => minor(one.riderEarning) + ' -> ' + minor(many.riderEarning));
  ckt('H2 the multi-shop load is expressed as TIME, recorded in the quote',
    () => many.pricingInputs.handling.extraStops === 15 && many.pricingInputs.handling.extraPackages === 10,
    () => JSON.stringify(many.pricingInputs.handling));
  ckt('H3 stop/parcel counts are pinned on the quote for downstream audit',
    () => many.shopCount === 4 && many.packageCount === 6);
  ckt('H4 conservation still holds for a multi-shop quote',
    () => minor(many.customerCharge) === minor(many.riderEarning) + minor(many.sokoniCommission));
  ckt('H5 a zero/negative shopCount REFUSES', () => !!refuses(() => Q(mk({ shopCount: 0 }))));

  /* ── I. Vehicle vocabulary ────────────────────────────────────────────────────────────── */
  console.log('\nI - vehicle classes resolve against the canonical V-2 vocabulary');
  ckt('I1 `tuktuk` and `ebike` are canonical classes with explicit economics',
    () => Q(mk({ vehicleType: 'tuktuk' })).vehicleType === 'tuktuk'
       && Q(mk({ vehicleType: 'ebike' })).vehicleType === 'ebike');
  ckt('I2 the legacy alias `moto` canonicalises to motorcycle (no invented alias)',
    () => Q(mk({ vehicleType: 'moto' })).vehicleType === 'motorcycle');
  ckt('I3 an UNKNOWN vehicle REFUSES — it does not fall back to a motorcycle',
    () => { const e = refuses(() => Q(mk({ vehicleType: 'spaceship' })));
      return !!e && e.reason === 'vehicle_class_unknown'; });
  ['pickup', 'suv', 'lorry', 'trailer', 'tractor'].forEach((v, i) => {
    const e = refuses(() => Q(mk({ vehicleType: v })));
    ck('I' + (4 + i) + ' unpriced class `' + v + '` REFUSES',
      !!e && e.reason === 'vehicle_class_unpriced', e ? e.reason : 'PRICED ANYWAY');
  });
  ckt('I9 an absent vehicleType REFUSES', () => !!refuses(() => Q(mk({ vehicleType: undefined }))));

  /* ── J. The settlement WIRING, not just the module ────────────────────────────────────── */
  console.log('\nJ - dispatch settlement consumes the pinned quote');
  const fs = require('fs');
  /* Comment-stripped: the replacement comment QUOTES the old line verbatim
     (`increment(delivery.driverNet || 0)`), so a naive grep finds its own documentation and
     reports that the defect survived. */
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const dispatchSrc = strip(fs.readFileSync(path.join(ROOT, 'functions', 'dispatch.js'), 'utf8'));

  ckt('J1 dispatch.js no longer credits earnings from `delivery.driverNet`',
    () => !/increment\(\s*delivery\.driverNet/.test(dispatchSrc));
  ckt('J2 dispatch.js requires the quote authority', () => /require\(['"]\.\/delivery-quote-authority['"]\)/.test(dispatchSrc));
  ckt('J3 settlement calls assertSettleable', () => /assertSettleable\(/.test(dispatchSrc));
  ckt('J4 CONTROL: the detector CAN see the old pattern when it is present',
    () => /increment\(\s*delivery\.driverNet/.test('x = increment( delivery.driverNet || 0 )'),
    'without this, J1 could pass because the regex is broken');

  /* Behavioural: a legacy delivery (no pinned quote) must yield NO credit, not a zero-credit. */
  const legacyDelivery = { driverNet: 180, deliveryFee: 220 };   /* the live record shape */
  const legacyErr = refuses(() => DQ.assertSettleable(legacyDelivery.deliveryQuote));
  ckt('J5 a LEGACY delivery (browser-priced, no pinned quote) is REFUSED at settlement',
    () => !!legacyErr && legacyErr.reason === 'no_pinned_quote',
    () => legacyErr && legacyErr.reason);
  ckt('J6 the refusal does NOT fall back to the browser figure of 180',
    () => { try { DQ.assertSettleable(legacyDelivery.deliveryQuote); return false; }
      catch (e) { return !/180/.test(String(e.message)); } });

  /* ── K. Commercial policy is required, never invented ─────────────────────────────────── */
  console.log('\nK - production pricing is BLOCKED until SOKONI policy exists');
  ckt('K1 a quote with NO policy REFUSES (an engineer cannot default the curve)',
    () => { const e = refuses(() => Q(BASE, null)); return !!e && e.reason === 'pricing_policy_required'; },
    () => (refuses(() => Q(BASE, null)) || {}).message);
  Object.keys(DQ.POLICY_CONTRACT).forEach((k, i) => {
    const partial = Object.assign({}, FIXTURE_POLICY); delete partial[k];
    const e = refuses(() => Q(BASE, partial));
    ck('K' + (2 + i) + ' policy missing `' + k + '` REFUSES',
      !!e && (e.reason === 'pricing_policy_incomplete' || e.reason === 'pricing_policy_unapproved'),
      e ? e.reason : 'QUOTED ANYWAY');
  });
  ckt('K8 weights that do not sum to 1 REFUSE (they would silently rescale the whole band)',
    () => { const e = refuses(() => Q(BASE, withCurve({ distanceWeight: 0.9, demandWeight: 0.9 })));
      return !!e && e.reason === 'pricing_policy_invalid'; });
  ckt('K9 an unapproved policy (blank approvedBy) REFUSES',
    () => { const e = refuses(() => Q(BASE, Object.assign({}, FIXTURE_POLICY, { approvedBy: '   ' })));
      return !!e && (e.reason === 'pricing_policy_unapproved' || e.reason === 'pricing_policy_incomplete'); });
  /* A DRAFT policy is complete in every field — that is exactly why it is dangerous. Testing only
     for MISSING fields would let a finished-but-unapproved policy price real deliveries. */
  ['draft', 'pending', 'retired', '', 'APPROVED'].forEach((st, i) => {
    const e = refuses(() => Q(BASE, Object.assign({}, FIXTURE_POLICY, { status: st })));
    ck('K12' + String.fromCharCode(97 + i) + ' a COMPLETE policy with status="' + st + '" REFUSES',
      !!e && (e.reason === 'pricing_policy_unapproved' || e.reason === 'pricing_policy_incomplete'),
      e ? e.reason : 'PRICED ANYWAY — an unapproved policy set a rider\'s pay');
  });
  ckt('K10 the policy that priced a quote is PINNED onto it',
    () => !!q.pricingInputs.policy && q.pricingInputs.policy.distanceWeight === FIXTURE_POLICY.shareCurve.distanceWeight
       && /FIXTURE-ONLY/.test(q.pricingInputs.policy.approvedBy),
    () => JSON.stringify(q.pricingInputs.policy.approvedBy));
  ckt('K11 a DIFFERENT approved curve produces a different share (policy actually drives pricing)',
    () => Q(mk({ distanceKm: 10 }), withCurve({ saturationKm: 5 })).sokoniSharePct
        !== Q(mk({ distanceKm: 10 }), withCurve({ saturationKm: 40 })).sokoniSharePct);

  /* ── L. Renegotiation guard (BUILT — EARNING_RENEGOTIATED did not exist) ──────────────── */
  console.log('\nL - a quote cannot settle under a changed commercial policy');
  const full = { quoteId: q.quoteId, pricingVersion: q.pricingVersion, sokoniSharePct: q.sokoniSharePct,
    customerCharge: q.customerCharge, riderEarning: q.riderEarning, sokoniCommission: q.sokoniCommission,
    pricingInputs: q.pricingInputs };
  ckt('L0 CONTROL: settles when the policy is UNCHANGED',
    () => minor(DQ.assertSettleable(full, null, { currentPolicy: FIXTURE_POLICY })) === minor(q.riderEarning));
  ['distanceWeight', 'demandWeight', 'saturationKm', 'demandSaturationIndex'].forEach((k, i) => {
    const changed = withCurve({ [k]: FIXTURE_POLICY.shareCurve[k] * 0.5 + 0.1 });
    const e = refuses(() => DQ.assertSettleable(full, null, { currentPolicy: changed }));
    ck('L' + (1 + i) + ' policy drift in `' + k + '` REFUSES settlement',
      !!e && e.reason === 'earning_renegotiated', e ? e.reason : 'SETTLED ANYWAY');
  });
  /* The declared way policy moves: a version bump. Caught even when the curve numbers are
     identical, because "same numbers, new version" still means a new commercial decision. */
  ckt('L4b a policyVersion bump alone REFUSES, even with identical curve values',
    () => { const bumped = Object.assign({}, FIXTURE_POLICY, { policyVersion: 'FIXTURE-P1' });
      const e = refuses(() => DQ.assertSettleable(full, null, { currentPolicy: bumped }));
      return !!e && e.reason === 'earning_renegotiated'; },
    () => (refuses(() => DQ.assertSettleable(full, null,
      { currentPolicy: Object.assign({}, FIXTURE_POLICY, { policyVersion: 'FIXTURE-P1' }) })) || {}).message);
  ckt('L4c the pinned policyVersion is recorded on the quote',
    () => q.pricingInputs.policy.policyVersion === 'FIXTURE-P0',
    () => q.pricingInputs.policy.policyVersion);
  ckt('L5 a quote with NO pinned policy cannot settle once a policy is in force',
    () => { const e = refuses(() => DQ.assertSettleable(pinned, null, { currentPolicy: FIXTURE_POLICY }));
      return !!e && e.reason === 'earning_renegotiated'; });
  ckt('L6 a tampered declared share (amounts untouched) is REFUSED',
    () => { const e = refuses(() => DQ.assertSettleable(Object.assign({}, full, { sokoniSharePct: 25 }),
      null, { currentPolicy: FIXTURE_POLICY }));
      return !!e && e.reason === 'declared_share_mismatch'; },
    () => (refuses(() => DQ.assertSettleable(Object.assign({}, full, { sokoniSharePct: 25 }), null,
      { currentPolicy: FIXTURE_POLICY })) || {}).message);
  ckt('L7 the guard does NOT silently recalculate — it throws',
    () => { try { DQ.assertSettleable(full, null, { currentPolicy: withCurve({ demandWeight: 0.1, distanceWeight: 0.9 }) }); return false; }
      catch (e) { return e.reason === 'earning_renegotiated'; } });

  /* ── M. Producer pinning + the residual's removal ─────────────────────────────────────── */
  console.log('\nM - the producer pins the quote and the residual is gone');
  const idxSrc = strip(fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8'));

  ckt('M1 the packageRequests producer no longer derives driverNet from the residual',
    () => !/driverNet:\s*Math\.round\(_delivery/.test(idxSrc));
  ckt('M2 CONTROL: the detector CAN see that pattern when present',
    () => /driverNet:\s*Math\.round\(_delivery/.test('driverNet:  Math.round(_delivery * 0.8),'),
    'without this, M1 could pass on a broken regex');
  ckt('M3 the producer spreads the server-pinned pricing', () => /\.\.\._deliveryPricing/.test(idxSrc));
  ckt('M4 the producer loads approved policy before pricing', () => /_dqa\.loadPolicy\(/.test(idxSrc));
  ckt('M5 index.js requires the quote authority', () => /require\(["']\.\/delivery-quote-authority["']\)/.test(idxSrc));
  /* The receipt legitimately records what the customer actually paid; that is a RECORD of a
     transaction, not a pricing authority, and removing it would make the receipt wrong. */
  ckt('M6 the RECEIPT still records the amount actually paid (not a pricing path)',
    () => /deliveryFee:\s+_delivery,/.test(idxSrc));
  ckt('M7 settlement revalidates against the policy in force (renegotiation guard wired)',
    () => { const d = strip(fs.readFileSync(path.join(ROOT, 'functions', 'dispatch.js'), 'utf8'));
      return /loadPolicy\(/.test(d) && /currentPolicy/.test(d); });

  console.log('\nN - live quote issuance is BLOCKED until SOKONI approves policy');
  const noDb = await DQ.loadPolicy(null);
  ckt('N1 loadPolicy(null) yields NO policy — callers must refuse', () => noDb === null, String(noDb));
  const fakeDbMissing = { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) };
  const missing = await DQ.loadPolicy(fakeDbMissing);
  ckt('N3 absent config -> null (production pricing blocked)', () => missing === null, String(missing));
  const fakeDbBad = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ distanceWeight: 0.9, demandWeight: 0.9 }) }) }) }) };
  const bad = await DQ.loadPolicy(fakeDbBad);
  ckt('N4 a MALFORMED config refuses exactly like an absent one', () => bad === null, String(bad));
  const fakeDbGood = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => Object.assign({}, FIXTURE_POLICY) }) }) }) };
  const good = await DQ.loadPolicy(fakeDbGood);
  ckt('N5 CONTROL: a complete approved config DOES load', () => !!good && good.shareCurve.distanceWeight === 0.6);

  /* ── O. Top-of-band rounding ──────────────────────────────────────────────────────────────
     REGRESSION. This suite stood at 104/0 while a real defect sat in the band check: a route
     deriving exactly SHARE_MAX realises a fraction ABOVE it, because customerCharge is a CEILING
     (which is what keeps the rider whole). Nothing here exercised the top of the band, so every
     long route, van and truck would have refused in production. Found by validating a proposed
     policy, not by inspection — hence these tests. */
  console.log('\nO - the top of the band prices (ceiling rounding must not refuse a valid quote)');
  const maxCurve = withCurve({ distanceWeight: 1, demandWeight: 0, saturationKm: 10, demandSaturationIndex: 2 });
  const topRoutes = [['motorcycle', 25, 55], ['van', 20, 45], ['truck', 30, 70], ['car', 40, 80]];
  let topOk = true, sawMax = false;
  topRoutes.forEach(([v, km, min]) => {
    try {
      const x = Q(mk({ vehicleType: v, distanceKm: km, estimatedMinutes: min }), maxCurve);
      if (x.sokoniSharePct === DQ.SHARE_MAX_PCT) sawMax = true;
    } catch (err) { topOk = false; }
  });
  ckt('O1 routes at the TOP of the band quote successfully', () => topOk);
  ckt('O2 at least one of them derives exactly SHARE_MAX (the case that used to refuse)',
    () => sawMax, 'SHARE_MAX = ' + DQ.SHARE_MAX_PCT + '%');
  ckt('O3 the realised share never exceeds the band by more than one minor unit',
    () => topRoutes.every(([v, km, min]) => {
      const x = Q(mk({ vehicleType: v, distanceKm: km, estimatedMinutes: min }), maxCurve);
      const realised = (minor(x.sokoniCommission) * 100) / minor(x.customerCharge);
      return realised <= DQ.SHARE_MAX_PCT + (100 / minor(x.customerCharge));
    }));
  /* The tolerance must be a rounding allowance, NOT a loosened band. */
  ckt('O4 a genuinely out-of-band pinned share is STILL refused at settlement',
    () => { const c = 100000, s = 30000, r = 70000;   /* 30% — well past the mandate */
      const e = refuses(() => DQ.assertSettleable({ quoteId: 'x', pricingVersion: DQ.PRICING_VERSION,
        customerCharge: money.fromMinor(c), riderEarning: money.fromMinor(r), sokoniCommission: money.fromMinor(s) }));
      return !!e && e.reason === 'pinned_share_out_of_band'; });
  ckt('O5 issuance and settlement share the SAME bound (settlement cannot be stricter)',
    () => { const x = Q(mk({ vehicleType: 'truck', distanceKm: 30, estimatedMinutes: 70 }), maxCurve);
      return minor(DQ.assertSettleable({ quoteId: x.quoteId, pricingVersion: x.pricingVersion,
        customerCharge: x.customerCharge, riderEarning: x.riderEarning,
        sokoniCommission: x.sokoniCommission })) === minor(x.riderEarning); },
    'a quote the authority issues must be settleable');
  ckt('O6 the LOWER bound gets no tolerance (a ceiling can only push the share up)',
    () => { const c = 100000, s = 15000, r = 85000;   /* 15% — below the mandate */
      const e = refuses(() => DQ.assertSettleable({ quoteId: 'x', pricingVersion: DQ.PRICING_VERSION,
        customerCharge: money.fromMinor(c), riderEarning: money.fromMinor(r), sokoniCommission: money.fromMinor(s) }));
      return !!e && e.reason === 'pinned_share_out_of_band'; });

  console.log('\n' + '-'.repeat(74));
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('SUITE CRASHED:', e && e.stack || e); process.exit(1); });
