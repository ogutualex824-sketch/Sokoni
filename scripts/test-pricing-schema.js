/* Unified pricing schema — PAYMENT-SAFETY gate + feature coverage.
   The critical assertion: for existing (live) venues, the canonical calculator
   compute(normalize(legacyA)) must equal the current live _calcPrice() TO THE
   CENT — no silent price drift when the booking engine converges onto the
   unified schema. Pure, no Firestore. */
'use strict';
const { normalize, compute } = require('../functions/pricing-schema');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };
const near = (a, b) => Math.abs(a - b) < 0.005;

/* ── ORACLE: an exact re-implementation of venue-booking.js `_calcPrice` (the
      LIVE pricing engine) as it exists today. Parity is measured against this. ── */
const _clamp = (v, min, max, def) => { const n = Number(v); if (!Number.isFinite(n)) return def; return Math.min(max, Math.max(min, n)); };
const _round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const _mins = t => { const [h, m] = String(t || '00:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const _isWeekend = d => { const x = new Date(d + 'T00:00:00').getDay(); return x === 0 || x === 6; };
function liveCalcPrice(venue, dateStr, startTime, durationMins, isMember) {
  const p = venue.pricing || {};
  const hours = durationMins / 60;
  const ratePerHour = p.baseRatePerHour || 0;
  const isWknd = _isWeekend(dateStr);
  const wkndMult = isWknd ? _clamp(p.weekendMultiplier, 1.0, 10.0, 1.0) : 1.0;
  const base = ratePerHour * hours * wkndMult;
  const startM = _mins(startTime), endM = startM + durationMins;
  let peakSurcharge = 0;
  (p.peakHours || []).forEach(ph => {
    const overlap = Math.max(0, Math.min(endM, _mins(ph.end)) - Math.max(startM, _mins(ph.start)));
    if (overlap > 0) peakSurcharge += ratePerHour * (overlap / 60) * (_clamp(ph.multiplier, 1.0, 5.0, 1.0) - 1.0);
  });
  const subtotal = base + peakSurcharge;
  const discount = isMember ? subtotal * _clamp(p.memberDiscount, 0, 0.5, 0) : 0;
  const total = _round2(subtotal - discount);
  const deposit = _round2(total * _clamp(p.depositPercent, 0, 1.0, 1.0));
  return { base: _round2(base), peakSurcharge: _round2(peakSurcharge), total, deposit };
}

/* Convert a legacy-A booking (startTime + durationMins) → canonical ctx. */
function ctxOf(dateStr, startTime, durationMins, isMember) {
  const startMins = _mins(startTime);
  return { startMins, endMins: startMins + durationMins, dateStr, isMember: !!isMember };
}

/* ── 1. PARITY: sample live venues × booking inputs — canonical == oracle ────── */
const liveVenues = [
  { pricing: { baseRatePerHour: 1000, weekendMultiplier: 1.5, peakHours: [{ start: '17:00', end: '21:00', multiplier: 1.3 }], memberDiscount: 0.1, depositPercent: 0.5, currency: 'KES' } },
  { pricing: { baseRatePerHour: 2500, weekendMultiplier: 1.0, peakHours: [], memberDiscount: 0, depositPercent: 1.0 } },
  { pricing: { baseRatePerHour: 800,  weekendMultiplier: 2.0, peakHours: [{ start: '18:00', end: '22:00', multiplier: 1.5 }, { start: '06:00', end: '09:00', multiplier: 1.2 }], memberDiscount: 0.25, depositPercent: 0.3 } },
  /* has stored-but-unused halfDayRate/holidayMultiplier → must NOT change price */
  { pricing: { baseRatePerHour: 1200, weekendMultiplier: 1.4, halfDayRate: 4000, baseRatePerDay: 8000, holidayMultiplier: 2.0, peakHours: [], memberDiscount: 0.05, depositPercent: 0.5 } },
];
const bookings = [
  ['2026-08-03', '10:00', 60,  false], // Mon, 1h, off-peak
  ['2026-08-03', '18:00', 120, false], // Mon, 2h, into peak
  ['2026-08-01', '19:00', 180, true],  // Sat (weekend), 3h, peak, member
  ['2026-08-01', '11:00', 300, false], // Sat, 5h (≥ half-day threshold) — must stay hourly (day-rate NOT activated)
  ['2026-08-02', '08:00', 480, true],  // Sun, 8h (full day), member
];
let parityChecks = 0;
for (const v of liveVenues) {
  const canon = normalize(v.pricing);
  for (const [d, st, dur, mem] of bookings) {
    const want = liveCalcPrice(v, d, st, dur, mem);
    const got = compute(canon, ctxOf(d, st, dur, mem));
    parityChecks++;
    ok(near(got.base, want.base), `base parity @ ${d} ${st} ${dur}m mem=${mem}: got ${got.base} want ${want.base}`);
    ok(near(got.peakSurcharge, want.peakSurcharge), `peak parity @ ${d} ${st} ${dur}m: got ${got.peakSurcharge} want ${want.peakSurcharge}`);
    ok(near(got.total, want.total), `TOTAL parity @ ${d} ${st} ${dur}m mem=${mem}: got ${got.total} want ${want.total}`);
    ok(near(got.deposit, want.deposit), `deposit parity @ ${d} ${st} ${dur}m: got ${got.deposit} want ${want.deposit}`);
  }
}
console.log(`  (ran ${parityChecks} live venue×booking parity checks)`);

/* ── 2. Migration does NOT activate stored-but-unused day/holiday rates ──────── */
const migrated = normalize(liveVenues[3].pricing);
ok(migrated.halfDayRate === null && migrated.fullDayRate === null, 'migration leaves day-rates null (no price change)');
ok(migrated.holiday.mode === 'multiplier' && migrated.holiday.value === 2, 'holiday multiplier carried but neutral on live path (isHoliday=false)');
const noHoliday = compute(migrated, ctxOf('2026-08-03', '10:00', 300, false));         // isHoliday not passed
ok(near(noHoliday.total, liveCalcPrice(liveVenues[3], '2026-08-03', '10:00', 300, false).total), 'no holiday charge when isHoliday absent (parity)');

/* ── 3. New canonical levers work when explicitly set ───────────────────────── */
const dayRateVenue = normalize({ hourlyRate: 1000, halfDayRate: 3500, fullDayRate: 6000, deposit: { mode: 'percent', value: 0.5 } });
ok(compute(dayRateVenue, ctxOf('2026-08-03', '09:00', 240, false)).base === 3500, 'half-day rate applies at 4h when set');
ok(compute(dayRateVenue, ctxOf('2026-08-03', '09:00', 480, false)).base === 6000, 'full-day rate applies at 8h when set');
const holVenue = normalize({ hourlyRate: 1000, holiday: { mode: 'multiplier', value: 2 }, deposit: { mode: 'flat', value: 500 } });
ok(compute(holVenue, { ...ctxOf('2026-08-03', '10:00', 60, false), isHoliday: true }).base === 2000, 'holiday multiplier doubles base when isHoliday');
ok(compute(holVenue, ctxOf('2026-08-03', '10:00', 60, false)).deposit === 500, 'flat deposit honored');

/* ── 4. Legacy-B (dormant) normalizes without throwing ──────────────────────── */
const b = normalize({ hourly: 900, halfDay: 3000, fullDay: 5000, weekend: 500, holiday: 800, peak: { hours: [[17, 21]], rate: 1200 }, member: { discount: 0.1 }, deposit: 1000 });
ok(b.hourlyRate === 900 && b.halfDayRate === 3000 && b.deposit.mode === 'flat' && b.deposit.value === 1000, 'legacy-B maps to canonical (flat deposit, day rates)');
ok(b.weekend.mode === 'flat' && b.weekend.value === 500, 'legacy-B weekend maps to flat surcharge');

/* ── 5. normalize is idempotent ─────────────────────────────────────────────── */
const once = normalize(liveVenues[0].pricing), twice = normalize(once);
ok(JSON.stringify(once) === JSON.stringify(twice), 'normalize is idempotent (canonical in → same out)');

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
