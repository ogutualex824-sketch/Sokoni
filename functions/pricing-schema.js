/* ============================================================================
   SOKONI — Unified Venue Pricing Schema  functions/pricing-schema.js

   ONE canonical pricing model + ONE calculator, shared by the whole booking
   engine (extend, don't rebuild). Converges two divergent pricing shapes:
     • venue-booking.js "_calcPrice"  (the LIVE one) — baseRatePerHour,
       weekendMultiplier, peakHours[{start,end,multiplier}], memberDiscount,
       depositPercent, cancellationPolicy, currency.
     • booking.js "_calculatePrice"   (dormant) — hourly/halfDay/fullDay, flat
       weekend/holiday, peak{rate}, member.discount, flat deposit, add-ons, promo.

   Pattern (mirrors minishop-config-schema): normalize() on WRITE, compute() on
   READ, one canonical definition — no field silently dropped.

   PAYMENT-SAFETY INVARIANT: for every EXISTING venue (all created by the live
   venue-booking.js schema), compute(normalize(legacyPricing), ctx) must equal
   the legacy _calcPrice(legacyPricing, ctx) to the cent. Enforced by
   scripts/test-pricing-schema.js. Two stored-but-unused live fields are handled
   asymmetrically to preserve that invariant:
     • halfDayRate / baseRatePerDay — NULLED on migration. These auto-apply by
       duration, so carrying them would change every ≥4h price immediately.
       Providers opt back in via the new halfDayRate/fullDayRate fields.
     • holidayMultiplier — CARRIED. It only charges when compute() is called with
       isHoliday:true, which no live path does, so it stays inert (no price change)
       yet the provider's intent is preserved for a future holiday-calendar.
   ============================================================================ */
'use strict';

const PRICING_SCHEMA_VERSION = 1;

const HALF_DAY_MINS = 240;
const FULL_DAY_MINS = 480;

function _num(v, def = 0) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function _clamp(v, min, max, def) { const n = Number(v); if (!Number.isFinite(n)) return def; return Math.min(max, Math.max(min, n)); }
function _round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function _mins(t) { const [h, m] = String(t || '00:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); }
function _isWeekend(dateStr) { const d = new Date(dateStr + 'T00:00:00').getDay(); return d === 0 || d === 6; }

/* A modifier is {mode:'multiplier'|'flat', value}. multiplier is ≥1 (1 = no-op),
   flat is an absolute surcharge ≥0. */
function _modifier(input, fallbackMode, fallbackValue) {
  if (input && typeof input === 'object' && ('mode' in input || 'value' in input)) {
    const mode = input.mode === 'flat' ? 'flat' : 'multiplier';
    const value = mode === 'multiplier' ? _clamp(input.value, 1, 100, 1) : Math.max(0, _num(input.value, 0));
    return { mode, value };
  }
  return { mode: fallbackMode, value: fallbackValue };
}

/* ── normalize: accept canonical OR either legacy shape → canonical ──────────── */
function normalize(input) {
  const p = input || {};

  /* Detect legacy-A (live venue-booking.js) by its signature field. */
  const isLegacyA = ('baseRatePerHour' in p) || ('weekendMultiplier' in p) || ('depositPercent' in p);
  /* Detect legacy-B (dormant booking.js) by its signature field. */
  const isLegacyB = !isLegacyA && (('hourly' in p) || ('fullDay' in p) || (p.peak && 'rate' in p.peak));

  if (isLegacyA) {
    return {
      _v: PRICING_SCHEMA_VERSION,
      currency: String(p.currency || 'KES'),
      hourlyRate: Math.max(0, _num(p.baseRatePerHour)),
      /* NOT activated on migration — the live engine ignores these (see header). */
      halfDayRate: null,
      fullDayRate: null,
      halfDayThresholdMins: HALF_DAY_MINS,
      fullDayThresholdMins: FULL_DAY_MINS,
      weekend: { mode: 'multiplier', value: _clamp(p.weekendMultiplier, 1, 10, 1) },
      /* Carried but inert: charged only when compute() gets isHoliday:true, which
         no live path does today — so no price change, provider intent preserved. */
      holiday: { mode: 'multiplier', value: _clamp(p.holidayMultiplier, 1, 10, 1) },
      peakHours: Array.isArray(p.peakHours) ? p.peakHours.slice(0, 8).map(ph => ({
        start: String(ph.start || '17:00'), end: String(ph.end || '21:00'),
        mode: 'multiplier', value: _clamp(ph.multiplier, 1, 5, 1),
      })) : [],
      memberDiscountPct: _clamp(p.memberDiscount, 0, 0.5, 0),
      deposit: { mode: 'percent', value: _clamp(p.depositPercent, 0, 1, 1) },
      cancellationPolicy: _cancellation(p.cancellationPolicy),
    };
  }

  if (isLegacyB) {
    const hourly = Math.max(0, _num(p.hourly));
    return {
      _v: PRICING_SCHEMA_VERSION,
      currency: String(p.currency || 'KES'),
      hourlyRate: hourly,
      halfDayRate: p.halfDay ? Math.max(0, _num(p.halfDay)) : null,
      fullDayRate: p.fullDay ? Math.max(0, _num(p.fullDay)) : null,
      halfDayThresholdMins: HALF_DAY_MINS,
      fullDayThresholdMins: FULL_DAY_MINS,
      weekend: { mode: 'flat', value: Math.max(0, _num(p.weekend)) },
      holiday: { mode: 'flat', value: Math.max(0, _num(p.holiday)) },
      /* legacy-B peak is a single rate delta over [hours]; represent each window
         as a flat per-hour delta is lossy — B has no live venues, so map the
         window list with a multiplier derived from rate/hourly when possible. */
      peakHours: Array.isArray(p.peak?.hours) ? p.peak.hours.slice(0, 8).map(([s, e]) => ({
        start: _pad(s), end: _pad(e), mode: 'multiplier',
        value: hourly > 0 ? _clamp(_num(p.peak.rate) / hourly, 1, 5, 1) : 1,
      })) : [],
      memberDiscountPct: _clamp(p.member?.discount, 0, 0.5, 0),
      deposit: { mode: 'flat', value: Math.max(0, _num(p.deposit)) },
      cancellationPolicy: _cancellation(p.cancellationPolicy),
    };
  }

  /* Already canonical (or empty) — coerce/clamp defensively. */
  return {
    _v: PRICING_SCHEMA_VERSION,
    currency: String(p.currency || 'KES'),
    hourlyRate: Math.max(0, _num(p.hourlyRate)),
    halfDayRate: p.halfDayRate != null ? Math.max(0, _num(p.halfDayRate)) : null,
    fullDayRate: p.fullDayRate != null ? Math.max(0, _num(p.fullDayRate)) : null,
    halfDayThresholdMins: _clamp(p.halfDayThresholdMins, 30, 1440, HALF_DAY_MINS),
    fullDayThresholdMins: _clamp(p.fullDayThresholdMins, 60, 1440, FULL_DAY_MINS),
    weekend: _modifier(p.weekend, 'multiplier', 1),
    holiday: _modifier(p.holiday, 'multiplier', 1),
    peakHours: Array.isArray(p.peakHours) ? p.peakHours.slice(0, 8).map(ph => ({
      start: String(ph.start || '17:00'), end: String(ph.end || '21:00'),
      ...(ph.mode === 'flat'
        ? { mode: 'flat', value: Math.max(0, _num(ph.value)) }
        : { mode: 'multiplier', value: _clamp(ph.value, 1, 5, 1) }),
    })) : [],
    memberDiscountPct: _clamp(p.memberDiscountPct, 0, 0.5, 0),
    deposit: p.deposit && p.deposit.mode === 'flat'
      ? { mode: 'flat', value: Math.max(0, _num(p.deposit.value)) }
      : { mode: 'percent', value: _clamp(p.deposit?.value, 0, 1, 1) },
    cancellationPolicy: _cancellation(p.cancellationPolicy),
  };
}

function _pad(n) { const h = Math.floor(n); return String(h).padStart(2, '0') + ':00'; }
function _cancellation(c) {
  c = c || {};
  return {
    freeCancellationHours:      _clamp(c.freeCancellationHours, 0, 168, 24),
    lateCancellationFeePercent: _clamp(c.lateCancellationFeePercent, 0, 100, 0),
    noShowFeePercent:           _clamp(c.noShowFeePercent, 0, 100, 100),
  };
}

/* ── compute: the ONE calculator ────────────────────────────────────────────
   ctx = { startMins, endMins, dateStr, isMember, isHoliday, addOns:[{price}], promoPct }
   Returns a superset breakdown; the fields the live UI reads are base,
   peakSurcharge, total, deposit, currency. */
function compute(pricing, ctx = {}) {
  const p = pricing && pricing._v === PRICING_SCHEMA_VERSION ? pricing : normalize(pricing);
  const startMins = _num(ctx.startMins), endMins = _num(ctx.endMins);
  const duration = endMins - startMins;
  const currency = p.currency;
  if (duration <= 0) {
    const dep = p.deposit.mode === 'flat' ? p.deposit.value : 0;
    return { base: 0, weekendApplied: false, peakSurcharge: 0, holidaySurcharge: 0, addOns: 0, subtotal: 0, memberDiscount: 0, total: 0, deposit: _round2(dep), currency, duration: 0 };
  }
  const hours = duration / 60;

  /* Base: day-rate tiers only when explicitly set (null on migrated venues). */
  let base;
  if (p.fullDayRate && duration >= p.fullDayThresholdMins) base = p.fullDayRate * Math.ceil(duration / p.fullDayThresholdMins);
  else if (p.halfDayRate && duration >= p.halfDayThresholdMins) base = p.halfDayRate;
  else base = p.hourlyRate * hours;

  /* Weekend + holiday: multiplier folds into base; flat becomes a surcharge. */
  const isWknd = _isWeekend(ctx.dateStr);
  let flatSurcharge = 0, weekendApplied = false;
  if (isWknd && !(p.weekend.mode === 'multiplier' && p.weekend.value === 1) && !(p.weekend.mode === 'flat' && p.weekend.value === 0)) {
    weekendApplied = true;
    if (p.weekend.mode === 'multiplier') base = base * p.weekend.value;
    else flatSurcharge += p.weekend.value;
  }
  let holidaySurcharge = 0;
  if (ctx.isHoliday && !(p.holiday.mode === 'multiplier' && p.holiday.value === 1) && !(p.holiday.mode === 'flat' && p.holiday.value === 0)) {
    if (p.holiday.mode === 'multiplier') { const nb = base * p.holiday.value; holidaySurcharge = nb - base; base = nb; }
    else { holidaySurcharge = p.holiday.value; flatSurcharge += p.holiday.value; }
  }

  /* Peak: per-window overlap. multiplier → hourlyRate×hoursOverlap×(value-1); flat → value once. */
  let peakSurcharge = 0;
  for (const ph of p.peakHours) {
    const overlap = Math.max(0, Math.min(endMins, _mins(ph.end)) - Math.max(startMins, _mins(ph.start)));
    if (overlap <= 0) continue;
    if (ph.mode === 'multiplier') peakSurcharge += p.hourlyRate * (overlap / 60) * (ph.value - 1);
    else peakSurcharge += ph.value;
  }

  const addOns = (ctx.addOns || []).reduce((t, a) => t + (Number(a && a.price) || 0), 0);
  const subtotal = base + flatSurcharge + peakSurcharge;
  const discPct = _clamp(p.memberDiscountPct, 0, 0.5, 0) * (ctx.isMember ? 1 : 0) + _clamp(ctx.promoPct, 0, 1, 0);
  const memberDiscount = subtotal * discPct;
  const total = subtotal - memberDiscount + addOns;
  const deposit = p.deposit.mode === 'percent' ? total * p.deposit.value : p.deposit.value;

  return {
    base: _round2(base), weekendApplied, peakSurcharge: _round2(peakSurcharge),
    holidaySurcharge: _round2(holidaySurcharge), addOns: _round2(addOns),
    subtotal: _round2(subtotal), memberDiscount: _round2(memberDiscount),
    total: _round2(total), deposit: _round2(deposit), currency, duration,
  };
}

module.exports = { PRICING_SCHEMA_VERSION, normalize, compute, HALF_DAY_MINS, FULL_DAY_MINS };
