'use strict';
/* Unit test for the canonical pricing engine (pure — no emulator). */
const { computePrice } = require('./service-pricing');

const results = [];
const check = (n, c, d) => results.push({ n, ok: !!c, d: d || '' });
function nextDow(target) { let d = new Date(Date.now() + 7 * 86400000); for (let i = 0; i < 8 && d.getUTCDay() !== target; i++) d = new Date(d.getTime() + 86400000); return d.toISOString().slice(0, 10); }
const SAT = nextDow(6), MON = nextDow(1);

const PRICING = {
  currency: 'KES', basePrice: 1000000, durationMins: 240,
  weekendRate: { type: 'pct', value: 50 },
  holidayRate: { type: 'flat', value: 200000 },
  peakRate: { type: 'pct', value: 20, hours: ['18:00', '23:00'] },
  offPeakDiscount: { type: 'pct', value: 10, hours: ['06:00', '12:00'] },
  holidays: [MON],
  extraHourRate: 150000,
  travel: { fee: 50000, freeRadiusKm: 10, perKm: 5000 },
  deposit: { mode: 'pct', value: 30, balanceDue: 'completion' },
  packages: [{ id: 'wed', name: 'Wedding', price: 2500000, durationMins: 360, deposit: { mode: 'fixed', value: 500000 } }],
  addOns: [{ id: 'lights', name: 'Lighting', price: 100000, qtyMax: 3 }, { id: 'smoke', name: 'Smoke', price: 50000, available: false }],
};

// 1 — base only, weekday non-holiday midday-ish 14:00 (no peak/offpeak)
let r = computePrice(PRICING, {}, { date: nextDow(3), startTime: '14:00' });   // Wednesday 14:00
check('base only → total = basePrice', r.totalCents === 1000000, r.totalCents);
check('deposit 30% of base', r.depositCents === 300000, r.depositCents);

// 2 — weekend surcharge (Sat, 14:00)
r = computePrice(PRICING, {}, { date: SAT, startTime: '14:00' });
check('weekend +50% surcharge', r.surchargeCents === 500000 && r.totalCents === 1500000, r.totalCents);

// 3 — holiday overrides weekend (MON is a holiday, flat +200000)
r = computePrice(PRICING, {}, { date: MON, startTime: '14:00' });
check('holiday flat surcharge (overrides weekend path)', r.surchargeCents === 200000 && r.totalCents === 1200000, r.totalCents);

// 4 — peak hour (Wed 20:00 → +20%)
r = computePrice(PRICING, {}, { date: nextDow(3), startTime: '20:00' });
check('peak +20%', r.surchargeCents === 200000 && r.totalCents === 1200000, r.totalCents);

// 5 — off-peak discount (Wed 08:00 → -10%)
r = computePrice(PRICING, {}, { date: nextDow(3), startTime: '08:00' });
check('off-peak -10%', r.surchargeCents === -100000 && r.totalCents === 900000, r.totalCents);

// 6 — extra hours (req 360 vs base 240 → 2h × 150000)
r = computePrice(PRICING, { durationMins: 360 }, { date: nextDow(3), startTime: '14:00' });
check('extra 2h', r.extraHoursCents === 300000 && r.totalCents === 1300000, r.totalCents);

// 7 — travel within radius = 0; beyond = fee + perKm*(dist-free)
r = computePrice(PRICING, {}, { date: nextDow(3), startTime: '14:00', distanceKm: 5 });
check('travel within free radius = 0', r.travelCents === 0);
r = computePrice(PRICING, {}, { date: nextDow(3), startTime: '14:00', distanceKm: 15 });
check('travel beyond radius = fee + perKm×5', r.travelCents === 75000, r.travelCents);

// 8 — add-ons: lights ×2 = 200000; smoke unavailable → skipped
r = computePrice(PRICING, { addOns: [{ id: 'lights', qty: 2 }, { id: 'smoke', qty: 1 }] }, { date: nextDow(3), startTime: '14:00' });
check('add-ons qty-aware + availability-gated', r.addOnsCents === 200000 && r.addOns.length === 1 && r.totalCents === 1200000, JSON.stringify(r.addOns));

// 9 — add-on qtyMax cap (request 9 lights, cap 3 → 300000)
r = computePrice(PRICING, { addOns: [{ id: 'lights', qty: 9 }] }, { date: nextDow(3), startTime: '14:00' });
check('add-on capped at qtyMax', r.addOnsCents === 300000, r.addOnsCents);

// 10 — package selection (base = package price + duration, package deposit fixed)
r = computePrice(PRICING, { packageId: 'wed' }, { date: nextDow(3), startTime: '14:00' });
check('package base price', r.baseCents === 2500000 && r.totalCents === 2500000, r.totalCents);
check('package deposit wins (fixed 500000)', r.depositCents === 500000 && r.depositMode === 'fixed', r.depositMode + '/' + r.depositCents);

// 11 — deposit full / fixed cap
r = computePrice(Object.assign({}, PRICING, { deposit: { mode: 'full' } }), {}, { date: nextDow(3), startTime: '14:00' });
check('deposit full = subtotal', r.depositCents === r.subtotalCents);
r = computePrice(Object.assign({}, PRICING, { deposit: { mode: 'fixed', value: 99999999 } }), {}, { date: nextDow(3), startTime: '14:00' });
check('deposit fixed capped at subtotal', r.depositCents === r.subtotalCents);

// 12 — combined (weekend + peak + extra + travel + addons) computes deterministically, total = sum
r = computePrice(PRICING, { durationMins: 300, addOns: [{ id: 'lights', qty: 1 }] }, { date: SAT, startTime: '20:00', distanceKm: 12 });
const expect = 1000000 /*base*/ + 500000 /*weekend*/ + 200000 /*peak*/ + 150000 /*1h extra*/ + (50000 + 2 * 5000) /*travel 12km*/ + 100000 /*lights*/;
check('combined total is deterministic sum', r.totalCents === expect, r.totalCents + ' vs ' + expect);

const pass = results.filter(x => x.ok).length, fail = results.length - pass;
console.log('\n──── SERVICE PRICING ENGINE (unit) ────');
results.forEach(x => console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.n}${x.d ? '   [' + x.d + ']' : ''}`));
console.log(`  ${pass}/${results.length} passed${fail ? '  — ' + fail + ' FAILED' : ''}\n`);
process.exit(fail ? 1 : 0);
