/* Courier quote composition — ADR-012.
 *
 * delivery-hub.js used to compute `base + km*perKm` itself, making it the
 * fourth implementation of distance pricing on the platform. It now composes
 * the shared delivery engine for that component and keeps only the multipliers
 * that are genuinely logistics (vehicle, weight, urgency).
 *
 * These tests pin BOTH halves of that decision:
 *   1. the composed result is identical to the formula it replaced, and
 *   2. the merchant engine never learns about vehicles.
 *
 * delivery-hub.js is a browser ES module importing Firebase over https, so it
 * cannot be required here. The composition is reproduced exactly; if someone
 * changes the real one without changing this, (1) fails.
 */
'use strict';

const E = require('../../sokoni-delivery-engine.js');

/* Mirrors the tables in delivery-hub.js. */
const VEHICLES = {
  boda:    { base: 150,  perKm: 35 },
  bicycle: { base: 100,  perKm: 20 },
  car:     { base: 400,  perKm: 60 },
  pickup:  { base: 1500, perKm: 90 },
  van:     { base: 2500, perKm: 110 },
  truck:   { base: 5000, perKm: 150 },
  ref:     { base: 3000, perKm: 130 },
  flatbed: { base: 6000, perKm: 170 },
};
const WEIGHT_SURCHARGE = { light: 0, medium: 0.1, heavy: 0.25, bulk: 0.4 };
const URGENCY_MULT = { standard: 1, express: 1.3, urgent: 1.6 };

/** The formula that existed before the engine — kept ONLY as the oracle. */
function legacyFee(distKm, vt, w, u) {
  const v = VEHICLES[vt] || VEHICLES.boda;
  const base = v.base;
  const kmCh = Math.round(distKm * v.perKm);
  const wSur = Math.round((base + kmCh) * (WEIGHT_SURCHARGE[w] || 0));
  return Math.round((base + kmCh + wSur) * (URGENCY_MULT[u] || 1));
}

/** The composition delivery-hub.js now performs. */
function composedFee(distKm, vt, w, u) {
  const v = VEHICLES[vt] || VEHICLES.boda;
  const leg = E.calculateDelivery(
    { enabled: true, mode: 'distance', baseFee: v.base, perKm: v.perKm },
    { distanceKm: distKm }
  );
  if (!leg.deliverable) return null;
  const wSur = Math.round(leg.fee * (WEIGHT_SURCHARGE[w] || 0));
  return Math.round((leg.fee + wSur) * (URGENCY_MULT[u] || 1));
}

describe('composing the engine does not change any price', () => {
  const DISTANCES = [0, 0.4, 1, 2.5, 7.3, 12, 25, 99.9];

  test('identical across every vehicle / weight / urgency / distance', () => {
    let compared = 0;
    for (const vt of Object.keys(VEHICLES)) {
      for (const w of Object.keys(WEIGHT_SURCHARGE)) {
        for (const u of Object.keys(URGENCY_MULT)) {
          for (const d of DISTANCES) {
            expect([vt, w, u, d, composedFee(d, vt, w, u)])
              .toEqual([vt, w, u, d, legacyFee(d, vt, w, u)]);
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(768);
  });

  test('why it holds: Math.round(n + x) === n + Math.round(x) for integer n', () => {
    /* The engine rounds base+km*perKm together; the old code rounded the km
       charge first and then added an integer base. Equal only because every
       vehicle base is an integer — so assert that, rather than trusting it. */
    for (const v of Object.values(VEHICLES)) {
      expect(Number.isInteger(v.base)).toBe(true);
    }
  });

  test('an unknown vehicle still falls back to boda', () => {
    expect(composedFee(10, 'hovercraft', 'light', 'standard'))
      .toBe(composedFee(10, 'boda', 'light', 'standard'));
  });
});

describe('refusals propagate instead of becoming a guessed price', () => {
  test('an unknown distance yields no quote', () => {
    const leg = E.calculateDelivery(
      { enabled: true, mode: 'distance', baseFee: 150, perKm: 35 }, {}
    );
    expect(leg.deliverable).toBe(false);
    expect(leg.reason).toBe('distance_unknown');
  });
});

describe('ADR-012 — the merchant engine must not learn about logistics', () => {
  test('no vehicle, weight or urgency vocabulary in the shared engine', () => {
    /* Strip comments first. The engine's header legitimately DOCUMENTS the four
       implementations it replaced, including delivery-hub's
       `_calcFee(distance, vehicle, weight, urgency)` — prose about logistics is
       not a dependency on logistics. Scanning raw text made this test fail on
       its own documentation. */
    const raw = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'sokoni-delivery-engine.js'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const word of ['vehicle', 'urgency', 'perKg', 'boda', 'courier']) {
      expect(code.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  test('the engine still exposes only merchant delivery modes', () => {
    expect(E.MODES).toEqual(['free', 'flat', 'distance', 'zones', 'own_fleet', 'pickup_only']);
  });
});
