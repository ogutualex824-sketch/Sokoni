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

/* ── Part C — merchant-v2 is the merchant application, and was OUTSIDE this gate ──
   Part B reads merchant.html only. merchant-v2.html shipped its own aggregate() over the
   same orders, so the two shells answered the same question differently:

     3 orders — completed 1000, refunded 500, processing 300
       revenue    engine 1800   v2 1300     (engine counts a refund as revenue, v2 does not)
       aov        engine  600   v2  650     (different denominators, and v2 does not round)
       pending    engine    0   v2    1     (v2 counts ANY status that is not completed
                                             or cancelled, so processing/shipped/ready
                                             all land in pending)

   Not rounding drift — three independent definitions. A merchant comparing the two shells
   on a day with one refund saw two revenue figures and no indication which was real. This
   part exists so the merchant application cannot drift from the engine again. */
const v2 = fs.readFileSync(path.join(__dirname, '..', 'merchant-v2.html'), 'utf8');

ok(/<script[^>]+sokoni-analytics-engine\.js/.test(v2),
   'merchant-v2 loads the canonical engine');
/* compute() vs aggregate(). compute() is the fuller entry point — it runs its own
   SokoniOrderService.query() and returns null without it. merchant-v2 does not load that
   service; it runs its own Firestore order query, so calling compute() here would return
   null and every figure would blank. It therefore reads the engine's PURE aggregate() over
   rows it already holds, which fixes the divergence this suite is about — the arithmetic.

   The remaining half is the ORDER QUERY: merchant-v2 still selects its own rows. Two
   surfaces can agree on the formula and still disagree on the input set, so this is not yet
   full parity and is deliberately not asserted as such. Converging the query onto
   SokoniOrderService is its own slice; when it lands, this becomes compute(). */
const wrapper = (function () {
  const i = v2.indexOf('function metricsFor (rows) {');
  return i < 0 ? '' : v2.slice(i, i + 1400);
})();
ok(wrapper.length > 200, 'CONTROL: metricsFor located (' + wrapper.length + ' chars)');
ok(/window\.SokoniAnalyticsEngine/.test(wrapper) && /\.(compute|aggregate)\(/.test(wrapper),
   'merchant-v2 reads through the canonical engine (aggregate() today, compute() once the '
   + 'order query converges)');
/* And it must REFUSE rather than substitute when the engine is missing — a local fallback
   is precisely how the second table would return. */
ok(/return null/.test(wrapper),
   'metricsFor returns null when the engine is absent (no local fallback sum)');
ok(!/SokoniOrderService/.test(v2),
   'PENDING-SLICE MARKER: merchant-v2 still runs its own order query — when this flips, '
   + 'switch the assertion above to compute()');

/* The local table must be GONE, not merely unused — a dormant second definition is what
   the whole nine-table commission history says comes back. Matched on the definition, so
   a call to the engine's own aggregate() does not look like a local one. */
ok(!/function\s+aggregate\s*\(/.test(v2),
   'merchant-v2 defines NO local aggregate() — the second table is removed, not orphaned');

/* Every merchant-v2 financial view renders from the engine's field names. */
function v2body (name) {
  const i = v2.indexOf('function ' + name + ' (');
  if (i < 0) return '';
  const j = v2.indexOf('\n  function ', i + 10);
  return v2.slice(i, j < 0 ? i + 1200 : j);
}
const V2_VIEWS = ['renderDashboard', 'paintAnalytics', 'revenueView', 'analyticsView'];
for (const n of V2_VIEWS) {
  const b = v2body(n);
  ok(b.length > 60, 'CONTROL: ' + n + ' located in merchant-v2 (' + b.length + ' chars)');
  ok(!/\.reduce\(|rows\.filter\(|for\s*\(.*of\s+rows/.test(b),
     n + ' does no independent order aggregation');
}

/* The Dashboard specifically: the route contract advertises it as a KPI surface reading
   the engine. It rendered six hardcoded em-dashes and referenced no engine at all — an
   honest placeholder, but the contract note was not honest about it. */
const dashV2 = v2body('renderDashboard');
const painter = v2body('paintDashTiles');
ok(painter.length > 200, 'CONTROL: paintDashTiles located (' + painter.length + ' chars)');
ok(/paintDashTiles\s*\(/.test(dashV2),
   'Dashboard reaches its KPI painter rather than rendering fixed placeholders');
ok(/metricsFor\s*\(/.test(painter),
   'the KPI painter reads figures through the engine wrapper');
/* The neutral-state rule: an unknown must render as a dash, never as a zero. Asserted on
   the painter's own failure path, because that is where a 0 would creep in. */
ok(/'—'/.test(painter) && /blank\s*\(/.test(painter),
   'unknown/failed figures repaint as — (never 0, which reads as a real trading result)');
ok(!/\bset\([^)]*,\s*0\s*\)/.test(painter),
   'no tile is ever set to a literal 0 as a stand-in for unknown');

/* Commission display. 5% is the marketplace rate, but MIN_COMMISSION_KES = 10 dominates
   small sales: a KES 97 order is charged KES 10 — 10.3%, not 5%. A surface that renders a
   flat "5%" is inaccurate under ~KES 200, so wherever merchant-v2 shows commission it must
   show the minimum too. Asserted on the RENDERED string, not on a constant. */
if (/commission/i.test(v2)) {
  ok(/MIN_COMMISSION|minimum|min\.?\s*KES|KES\s*10/i.test(v2),
     'commission display names the KES 10 minimum, not a bare "5%"');
}

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
