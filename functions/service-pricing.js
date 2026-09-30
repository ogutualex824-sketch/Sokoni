'use strict';
/* ============================================================================
   SOKONI — Canonical Service Pricing Engine   functions/service-pricing.js

   THE ONE authority for a service's final price. PURE (no I/O) so it is trivially
   testable and can run identically on the server (authoritative) and, if ever needed,
   for a client-side ESTIMATE — but the SERVER value is the only one that counts.

   Universal: DJs, photographers, caterers, tutors, lawyers, cleaners, movers, … only the
   packages/add-ons differ; the model is identical. All money is CENTS.

   computePrice(pricing, selection, ctx) → authoritative breakdown.
     pricing   — the provider's rate card (providerServices/{id}.pricing)
     selection — the customer's choices { packageId?, addOns:[{id,qty}], durationMins? }
     ctx       — booking context { date:'YYYY-MM-DD', startTime:'HH:MM', durationMins, distanceKm }

   Schema (providerServices/{id}.pricing):
     { currency, basePrice(cents), durationMins,
       weekendRate/holidayRate/peakRate/offPeakDiscount: { type:'pct'|'flat', value, hours?:[start,end] },
       holidays:['YYYY-MM-DD'], extraHourRate(cents),
       travel:{ fee(cents), freeRadiusKm, perKm(cents) },
       deposit:{ mode:'fixed'|'pct'|'full', value, balanceDue:'before'|'completion' },
       packages:[{ id,name,price(cents),durationMins,deposit?,includes:[],extras:[addOnId] }],
       addOns:[{ id,name,price(cents),qtyMax?,available }] }
   ========================================================================== */

function _int(x) { return Math.max(0, Math.round(Number(x) || 0)); }
function _t(hhmm) { if (!hhmm) return 0; const p = String(hhmm).split(':'); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }

/* rate = { type:'pct'|'flat', value }. pct is applied to `baseCents`; flat is a cents amount. */
function _applyRate(baseCents, rate) {
  if (!rate || !rate.value) return 0;
  if (rate.type === 'pct') return Math.round(baseCents * (Number(rate.value) || 0) / 100);
  return _int(rate.value);
}

function _context(pricing, selection, ctx) {
  ctx = ctx || {}; selection = selection || {}; pricing = pricing || {};
  const date = ctx.date || selection.date || null;
  const startTime = ctx.startTime || selection.startTime || null;
  const dow = date ? new Date(date + 'T00:00:00+03:00').getDay() : -1;
  const isWeekend = dow === 0 || dow === 6;
  const holidays = pricing.holidays || ctx.holidays || [];
  const isHoliday = date ? holidays.indexOf(date) > -1 : false;
  const mins = startTime ? _t(startTime) : null;
  let isPeak = false, isOffPeak = false;
  if (pricing.peakRate && pricing.peakRate.hours && mins != null) { isPeak = mins >= _t(pricing.peakRate.hours[0]) && mins < _t(pricing.peakRate.hours[1]); }
  if (pricing.offPeakDiscount && pricing.offPeakDiscount.hours && mins != null) { isOffPeak = mins >= _t(pricing.offPeakDiscount.hours[0]) && mins < _t(pricing.offPeakDiscount.hours[1]); }
  return { isWeekend: isWeekend, isHoliday: isHoliday, isPeak: isPeak, isOffPeak: isOffPeak };
}

function computePrice(pricing, selection, ctx) {
  pricing = pricing || {}; selection = selection || {}; ctx = ctx || {};
  const currency = pricing.currency || 'KES';
  const breakdown = [];

  /* 1 — base: a selected package, else the standard price */
  let baseCents, baseDuration, pkg = null;
  if (selection.packageId && Array.isArray(pricing.packages)) {
    pkg = pricing.packages.filter(function (p) { return p && p.id === selection.packageId; })[0] || null;
  }
  if (pkg) { baseCents = _int(pkg.price); baseDuration = _int(pkg.durationMins) || _int(pricing.durationMins); breakdown.push({ type: 'package', label: pkg.name || 'Package', amount: baseCents }); }
  else { baseCents = _int(pricing.basePrice); baseDuration = _int(pricing.durationMins); breakdown.push({ type: 'base', label: 'Base price', amount: baseCents }); }

  /* 2 — time-based surcharges (on the base). Holiday takes precedence over weekend. */
  const c = _context(pricing, selection, ctx);
  let surcharge = 0;
  if (c.isHoliday && pricing.holidayRate) { const a = _applyRate(baseCents, pricing.holidayRate); surcharge += a; if (a) breakdown.push({ type: 'holiday', label: 'Public holiday', amount: a }); }
  else if (c.isWeekend && pricing.weekendRate) { const a = _applyRate(baseCents, pricing.weekendRate); surcharge += a; if (a) breakdown.push({ type: 'weekend', label: 'Weekend', amount: a }); }
  if (c.isPeak && pricing.peakRate) { const a = _applyRate(baseCents, pricing.peakRate); surcharge += a; if (a) breakdown.push({ type: 'peak', label: 'Peak hour', amount: a }); }
  if (c.isOffPeak && pricing.offPeakDiscount) { const a = -_applyRate(baseCents, pricing.offPeakDiscount); surcharge += a; if (a) breakdown.push({ type: 'offpeak', label: 'Off-peak discount', amount: a }); }

  /* 3 — extra hours beyond the base duration */
  let extra = 0;
  const reqDuration = _int(selection.durationMins) || baseDuration;
  if (pricing.extraHourRate && reqDuration > baseDuration && baseDuration > 0) {
    const extraHours = Math.ceil((reqDuration - baseDuration) / 60);
    extra = extraHours * _int(pricing.extraHourRate);
    if (extra) breakdown.push({ type: 'extra_hours', label: extraHours + 'h extra', amount: extra });
  }

  /* 4 — travel beyond the free radius */
  let travel = 0;
  const tv = pricing.travel;
  if (tv && Number(ctx.distanceKm) > 0) {
    const dist = Number(ctx.distanceKm), free = Number(tv.freeRadiusKm) || 0;
    if (dist > free) { travel = _int(tv.fee) + Math.round((dist - free) * _int(tv.perKm)); if (travel) breakdown.push({ type: 'travel', label: 'Travel (' + dist + 'km)', amount: travel }); }
  }

  /* 5 — optional add-ons (qty-aware, availability-gated, capped at qtyMax) */
  let addOnsTotal = 0;
  const catalog = Array.isArray(pricing.addOns) ? pricing.addOns : [];
  const selAddOns = Array.isArray(selection.addOns) ? selection.addOns : [];
  const appliedAddOns = [];
  selAddOns.forEach(function (sa) {
    const wantId = (sa && sa.id) || sa;
    const item = catalog.filter(function (x) { return x && x.id === wantId; })[0];
    if (!item || item.available === false) return;
    const qty = Math.max(1, Math.min(_int(sa && sa.qty) || 1, _int(item.qtyMax) || 99));
    const amt = _int(item.price) * qty;
    addOnsTotal += amt;
    appliedAddOns.push({ id: item.id, name: item.name || 'Add-on', qty: qty, amount: amt });
    breakdown.push({ type: 'addon', label: (item.name || 'Add-on') + (qty > 1 ? ' ×' + qty : ''), amount: amt });
  });

  const subtotal = Math.max(0, baseCents + surcharge + extra + travel + addOnsTotal);

  /* 6 — deposit split (NOT added to the total — it is how much is due upfront).
     A package's own deposit takes precedence over the service-level deposit. */
  const dep = (pkg && pkg.deposit) || pricing.deposit || null;
  let depositCents = 0, depositMode = 'none';
  if (dep && subtotal > 0) {
    if (dep.mode === 'full') { depositCents = subtotal; depositMode = 'full'; }
    else if (dep.mode === 'pct') { depositCents = Math.round(subtotal * (Number(dep.value) || 0) / 100); depositMode = 'pct'; }
    else if (dep.mode === 'fixed') { depositCents = _int(dep.value); depositMode = 'fixed'; }
  }
  depositCents = Math.max(0, Math.min(subtotal, depositCents));

  return {
    currency: currency,
    baseCents: baseCents, baseDuration: baseDuration, durationMins: reqDuration,
    surchargeCents: surcharge, extraHoursCents: extra, travelCents: travel, addOnsCents: addOnsTotal,
    subtotalCents: subtotal, totalCents: subtotal,
    depositCents: depositCents, depositMode: depositMode, balanceDue: (dep && dep.balanceDue) || 'completion',
    packageId: pkg ? pkg.id : null, addOns: appliedAddOns,
    breakdown: breakdown, context: c,
  };
}

module.exports = { computePrice };
