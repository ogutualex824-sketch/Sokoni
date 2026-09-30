/* Delivery engine — one price, one reason.
 *
 * The assertions that matter are the refusals: an unknown distance must not
 * become a guessed fee, an unserved zone must not read as free delivery, and a
 * financial field must never be editable. Each of those was a real shape in the
 * code this engine replaces. */
'use strict';

const E = require('../../sokoni-delivery-engine.js');

const cfg = (o = {}) => Object.assign({ enabled: true }, o);

describe('canDeliver answers before pricing', () => {
  test('an unconfigured merchant does not silently offer free delivery', () => {
    const r = E.calculateDelivery({}, { subtotal: 500 });
    expect(r.deliverable).toBe(false);
    expect(r.free).toBe(false);
    expect(r.reason).toBe('delivery_not_offered');
  });

  test('pickup only is not deliverable', () => {
    expect(E.canDeliver(cfg({ mode: 'pickup_only' }), {}).ok).toBe(false);
  });

  test('beyond the radius is refused, not priced', () => {
    const c = cfg({ mode: 'distance', maxDistanceKm: 10, perKm: 15 });
    const r = E.calculateDelivery(c, { distanceKm: 25 });
    expect(r.deliverable).toBe(false);
    expect(r.reason).toBe('outside_delivery_radius');
    expect(r.fee).toBe(0);
  });

  test('an unserved zone is refused, not treated as free', () => {
    /* The distinction that matters: "we don't go there" must never render as
       "FREE delivery". */
    const c = cfg({ mode: 'zones', serviceZones: [{ name: 'Karen', fee: 200 }] });
    const r = E.calculateDelivery(c, { zone: 'Kisumu' });
    expect(r.deliverable).toBe(false);
    expect(r.free).toBe(false);
    expect(E.deliverySummary(c, { zone: 'Kisumu' }).label).toBe('Delivery unavailable');
  });
});

describe('pricing', () => {
  test('free mode', () => {
    const r = E.calculateDelivery(cfg({ mode: 'free' }), { subtotal: 100 });
    expect(r).toMatchObject({ fee: 0, free: true, deliverable: true, reason: 'free_delivery' });
  });

  test('flat rate', () => {
    expect(E.calculateDelivery(cfg({ mode: 'flat', defaultFee: 150 }), {}).fee).toBe(150);
  });

  test('distance based', () => {
    const c = cfg({ mode: 'distance', baseFee: 80, perKm: 15 });
    expect(E.calculateDelivery(c, { distanceKm: 4 }).fee).toBe(140);   /* 80 + 4*15 */
  });

  test('an unknown distance refuses rather than guessing a fee', () => {
    /* checkout.html hardcoded 80 + km*15 and food-menu defaulted to 50. A fee
       invented from a missing input is a charge the customer cannot explain. */
    const r = E.calculateDelivery(cfg({ mode: 'distance', perKm: 15 }), {});
    expect(r.deliverable).toBe(false);
    expect(r.reason).toBe('distance_unknown');
    expect(r.fee).toBe(0);
  });

  test('zone rate, case and whitespace insensitive', () => {
    const c = cfg({ mode: 'zones', serviceZones: [{ name: 'Langata', fee: 120, etaMinutes: 45 }] });
    const r = E.calculateDelivery(c, { zone: '  langata ' });
    expect(r.fee).toBe(120);
    expect(r.etaMinutes).toBe(45);
  });

  test('a zero-fee zone reports as free', () => {
    const c = cfg({ mode: 'zones', serviceZones: [{ name: 'CBD', fee: 0 }] });
    expect(E.calculateDelivery(c, { zone: 'CBD' }).free).toBe(true);
  });

  test('freeAbove overrides every priced mode', () => {
    const c = cfg({ mode: 'distance', baseFee: 80, perKm: 15, freeAbove: 2000 });
    const r = E.calculateDelivery(c, { distanceKm: 40, subtotal: 2500 });
    expect(r.fee).toBe(0);
    expect(r.free).toBe(true);
    expect(r.reason).toBe('free_above_threshold');
  });

  test('below the threshold still pays', () => {
    const c = cfg({ mode: 'flat', defaultFee: 150, freeAbove: 2000 });
    expect(E.calculateDelivery(c, { subtotal: 1999 }).fee).toBe(150);
  });

  test('fees are never negative', () => {
    const c = cfg({ mode: 'distance', baseFee: -500, perKm: 0 });
    expect(E.calculateDelivery(c, { distanceKm: 1 }).fee).toBe(0);
  });
});

describe('operating hours', () => {
  const at = (h, m = 0) => new Date(2026, 7, 2, h, m);

  test('inside the window', () => {
    const c = cfg({ mode: 'flat', defaultFee: 100, operatingHours: { open: '08:00', close: '18:00' } });
    expect(E.calculateDelivery(c, { at: at(12) }).deliverable).toBe(true);
  });

  test('outside the window is refused', () => {
    const c = cfg({ mode: 'flat', defaultFee: 100, operatingHours: { open: '08:00', close: '18:00' } });
    expect(E.calculateDelivery(c, { at: at(22) }).reason).toBe('outside_operating_hours');
  });

  test('a window crossing midnight works', () => {
    const c = cfg({ mode: 'flat', defaultFee: 100, operatingHours: { open: '20:00', close: '04:00' } });
    expect(E.calculateDelivery(c, { at: at(23) }).deliverable).toBe(true);
    expect(E.calculateDelivery(c, { at: at(2) }).deliverable).toBe(true);
    expect(E.calculateDelivery(c, { at: at(12) }).deliverable).toBe(false);
  });
});

describe('isEditable — ADR-010', () => {
  const c = cfg({ mode: 'flat', defaultFee: 100 });

  test('fulfilment fields are editable before dispatch', () => {
    expect(E.isEditable(c, { status: 'preparing' }, 'houseNumber').ok).toBe(true);
    expect(E.isEditable(c, { status: 'ready' }, 'landmark').ok).toBe(true);
  });

  test('dispatch locks fulfilment', () => {
    for (const s of ['dispatched', 'out_for_delivery', 'delivered']) {
      const r = E.isEditable(c, { status: s }, 'houseNumber');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('dispatched');
    }
  });

  test('financial fields are NEVER editable, at any status', () => {
    /* There is no branch that returns true for these, so the function cannot be
       misused as a general "can I edit this order?" check. */
    for (const f of ['total', 'tax', 'discount', 'receiptNumber', 'paymentReference', 'deposit']) {
      expect(E.isEditable(c, { status: 'preparing' }, f).ok).toBe(false);
      expect(E.isEditable(c, { status: 'preparing' }, f).reason).toBe('not_a_fulfilment_field');
    }
  });

  test('a merchant may switch editing off entirely', () => {
    const strict = cfg({ mode: 'flat', allowEditingUntilDispatch: false });
    expect(E.isEditable(strict, { status: 'preparing' }, 'houseNumber').ok).toBe(false);
  });
});

describe('summary is the single description', () => {
  test('free reads as FREE', () => {
    expect(E.deliverySummary(cfg({ mode: 'free' }), {}).label).toBe('FREE delivery');
  });
  test('priced reads with the amount', () => {
    expect(E.deliverySummary(cfg({ mode: 'flat', defaultFee: 250 }), {}).label).toBe('Delivery KES 250');
  });
  test('pickup only says so', () => {
    expect(E.deliverySummary(cfg({ mode: 'pickup_only' }), {}).label).toBe('Pickup only');
  });
});

describe('purity', () => {
  test('an unknown mode falls back to pickup rather than throwing', () => {
    expect(E.calculateDelivery(cfg({ mode: 'teleport' }), {}).deliverable).toBe(false);
  });
  test('the config is not mutated', () => {
    const c = cfg({ mode: 'flat', defaultFee: 100 });
    const before = JSON.stringify(c);
    E.calculateDelivery(c, { subtotal: 10 });
    expect(JSON.stringify(c)).toBe(before);
  });
  test('all six modes are declared', () => {
    expect(E.MODES).toEqual(['free', 'flat', 'distance', 'zones', 'own_fleet', 'pickup_only']);
  });
});
