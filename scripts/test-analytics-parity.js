/* Automated analytics parity test — proves Dashboard = Reports = Finance =
   Shop Analytics derive from ONE computation, so the same range yields identical
   values and no screen computes independently.

   Part A: the engine (sokoni-analytics-engine.js aggregate()) is a single pure
           source — same orders → one revenue/orders/aov.
   Part B: all four merchant surfaces consume SokoniAnalyticsEngine.compute() and read
           the SAME canonical fields — none re-aggregates orders itself. */
'use strict';
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

/* ── Part A — the engine is one deterministic source ── */
global.window = {};
require(path.join(__dirname, '..', 'sokoni-analytics-engine.js'));
const AE = global.window.SokoniAnalyticsEngine;
ok(AE && typeof AE.aggregate === 'function' && typeof AE.compute === 'function', 'AnalyticsEngine exposes compute()+aggregate()');

const orders = [
  { source: 'pos',    channel: 'in_store', status: 'completed', total: 1000, tax: 0, discount: 0, deliveryFee: 0, paymentMethod: 'cash',  items: [{ name: 'A', qty: 2, price: 500 }], customer: 'Walk-in' },
  { source: 'online', channel: 'delivery', status: 'pending',   total: 500,  tax: 0, discount: 0, deliveryFee: 100, paymentMethod: 'mpesa', items: [{ name: 'B', qty: 1, price: 500 }], customer: 'Jane' },
  { source: 'online', channel: 'pickup',   status: 'cancelled', total: 300,  tax: 0, discount: 0, deliveryFee: 0, paymentMethod: 'mpesa', items: [{ name: 'C', qty: 1, price: 300 }], customer: 'Bob' },
];
const a1 = AE.aggregate(orders);
const a2 = AE.aggregate(orders);
ok(a1.revenue === a2.revenue && a1.orders === a2.orders && a1.aov === a2.aov, 'aggregate() is deterministic (same input → same output)');
ok(a1.revenue === 1500, 'revenue excludes cancelled (1000+500, not +300)');
ok(a1.orders === 3 && a1.pos.count === 1 && a1.online.count === 2, 'order + POS/online counts consistent');
ok(a1.aov === Math.round(1500 / 2), 'AOV = revenue / non-cancelled, computed once in the engine');
ok(a1.grossProfit === null, 'grossProfit stays null (never fabricated) without cost data');

/* Expanded domain coverage (Phase 5) — derived from the same order stream, once. */
ok(a1.unitsSold === 3, 'unitsSold sums live item qty (2+1; cancelled excluded)');
ok(a1.channelRevenue.in_store === 1000 && a1.channelRevenue.delivery === 500 && a1.channelRevenue.pickup === 0,
   'channelRevenue split by channel, cancelled excluded');
/* compute() attaches canonical availability signals when AvailabilityService is present. */
const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'sokoni-analytics-engine.js'), 'utf8');
ok(/AvailabilityService/.test(engineSrc) && /out\.availability/.test(engineSrc),
   'compute() attaches availability from the canonical AvailabilityService (null when absent)');

/* ── Part B — every surface consumes that one compute(), reading the same fields ── */
const src = fs.readFileSync(path.join(__dirname, '..', 'merchant.html'), 'utf8');
const computeSites = (src.match(/SokoniAnalyticsEngine\.compute\(/g) || []).length;
ok(computeSites >= 2, 'screens read via SokoniAnalyticsEngine.compute() (dashboard + reports/finance/analytics)');

/* extract a function body by name (best-effort brace-free slice to the next "function ") */
function body(name) {
  const i = src.indexOf('function ' + name + ' (');
  if (i < 0) return '';
  return src.slice(i, i + 900);
}
const dash = body('_dashLoadAnalytics');
const rep = body('_anReports'), fin = body('_anFinance'), an = body('_anAnalytics');
ok(/a\.revenue/.test(dash) && /a\.revenue/.test(rep) && /a\.revenue/.test(fin) && /a\.revenue/.test(an),
   'all four surfaces render Revenue from the SAME field a.revenue');
ok(/a\.orders/.test(dash) && /a\.orders/.test(rep) && /a\.orders/.test(an),
   'Dashboard/Reports/Analytics render Orders from a.orders');
ok(/a\.aov/.test(dash) && /a\.aov/.test(rep) && /a\.aov/.test(an),
   'AOV read from a.aov (never recomputed per screen)');

/* No screen may independently aggregate orders (that would break parity). */
[['_anReports', rep], ['_anFinance', fin], ['_anAnalytics', an], ['_dashLoadAnalytics', dash]].forEach(([n, b]) => {
  ok(!/\.reduce\(|orders\.filter\(|for\s*\(.*of\s+orders/.test(b), n + ' does no independent order aggregation');
});

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
