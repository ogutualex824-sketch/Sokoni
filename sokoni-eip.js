/* ================================================================
   SOKONI ENTERPRISE INTELLIGENCE PLATFORM
   Bootstrap  v1.0.0

   Single import point that wires all EIP engines together and
   registers built-in decision strategies for core platform modules.

   Import this file ONCE at the top of your app or module:

     import eip from './sokoni-eip.js';
     await eip.ready;

     const result = await eip.engine.decide('nearest_driver', ctx);
     const ok     = await eip.flags.isEnabled('ai_recommendations', uid);
     const report = await eip.quality.validate(gpsData, 'gps');
     eip.log.log({ decisionType: 'custom', source: 'calculated', ... });

   Exposes: window.SokoniEIP + ES default export
================================================================ */

import engine,  { PRIORITY, SOURCE, realtimeStrategy, calculatedStrategy,
                  optimizedStrategy, predictedStrategy, Decisions }
  from './sokoni-decision-engine.js';

import dqe      from './sokoni-data-quality.js';
import flags    from './sokoni-feature-flags.js';
import log      from './sokoni-intelligence-log.js';
import policy   from './sokoni-ai-policy.js';

/* ── Wire dependencies into the Decision Engine singleton ──────── */
engine.dataQuality  = dqe;
engine.featureFlags = flags;
engine.logger       = log;

/* ── Register built-in data quality alert to Intelligence Log ──── */
dqe.onFailure(({ data, report, profile }) => {
  log.security({
    module:    'data_quality',
    eventType: 'quality_failure',
    severity:  report.score < 30 ? 'high' : 'medium',
    detail:    `Profile '${profile}' failed: ${report.reason} (score ${report.score}/100)`,
  });
});

/* ================================================================
   BUILT-IN DECISION STRATEGIES
   These cover the most common decisions across all platform modules.
   Each module can register additional strategies via:
     eip.engine.register('my_decision', [...strategies])
================================================================ */

/* ── 1. Commission calculation (deterministic) ──────────────── */
engine.register('commission', [
  calculatedStrategy(
    async (ctx) => {
      const { order, rates } = ctx;
      if (!order?.total || !rates) return { found: false };

      /* Sokoni takes platform commission; vendor gets remainder */
      const pct        = rates[order.category]?.sokoni ?? rates.default ?? 0.08;
      const commission = Math.round(order.total * pct * 100) / 100;
      const vendorNet  = Math.round((order.total - commission) * 100) / 100;

      return {
        found:   true,
        value:   { commission, vendorNet, pct, total: order.total },
        formula: `total × ${(pct * 100).toFixed(1)}% = commission`,
        inputs:  ['order.total', 'order.category', 'commission_rate'],
        reason:  `Platform commission: KES ${commission.toFixed(2)} (${(pct * 100).toFixed(1)}%)`,
      };
    },
    { label: 'commission_calculator', formula: 'order.total × commission_rate' }
  ),
]);

/* ── 2. Smart inventory reorder point ─────────────────────────── */
engine.register('inventory_reorder', [
  calculatedStrategy(
    async (ctx) => {
      const { stock, rules } = ctx;
      if (stock?.qty === undefined || !rules) return { found: false };

      const dailySales  = rules.avgDailySales ?? 1;
      const leadDays    = rules.leadTimeDays  ?? 3;
      const safetyStock = rules.safetyDays    ?? 2;
      const reorderPt   = Math.ceil((leadDays + safetyStock) * dailySales);
      const shouldReorder = stock.qty <= reorderPt;
      const suggestQty    = shouldReorder
        ? Math.ceil(dailySales * (rules.reorderQtyDays ?? 14))
        : 0;

      return {
        found:   true,
        value:   { shouldReorder, reorderPoint: reorderPt, suggestQty, currentQty: stock.qty },
        formula: '(leadTimeDays + safetyDays) × avgDailySales',
        inputs:  ['stock.qty', 'avgDailySales', 'leadTimeDays', 'safetyDays'],
        reason:  shouldReorder
          ? `Stock ${stock.qty} ≤ reorder point ${reorderPt} — order ${suggestQty} units`
          : `Stock ${stock.qty} > reorder point ${reorderPt} — no action needed`,
      };
    },
    { label: 'reorder_calculator' }
  ),
]);

/* ── 3. Delivery ETA (always CALCULATED — never AI) ──────────── */
engine.register('eta', [
  /* P1: Real OSRM route data if available in context */
  realtimeStrategy(
    async (ctx) => {
      const { osrmEta } = ctx;
      if (!osrmEta?.durationMin) return { found: false };
      return {
        found:  true,
        value:  { durationMin: osrmEta.durationMin, distanceKm: osrmEta.distanceKm, source: 'osrm' },
        reason: `OSRM road route: ${osrmEta.durationMin} min, ${osrmEta.distanceKm} km`,
      };
    },
    'osrm_realtime'
  ),
  /* P2: Haversine fallback */
  calculatedStrategy(
    async (ctx) => {
      const { from, to, vehicleType } = ctx;
      if (!from?.lat || !to?.lat) return { found: false };

      const distKm = _haversineKm(from.lat, from.lng, to.lat, to.lng);
      const speeds = { motorbike: 35, car: 28, foot: 5, default: 30 };
      const speedKmh = speeds[vehicleType] ?? speeds.default;
      const durationMin = Math.round((distKm / speedKmh) * 60 * 1.25);   /* 25% traffic buffer */

      return {
        found:   true,
        value:   { durationMin, distanceKm: Math.round(distKm * 10) / 10, source: 'haversine' },
        formula: 'haversine(from, to) ÷ avgSpeed × 1.25 traffic buffer — straight-line estimate',
        inputs:  ['from.lat', 'from.lng', 'to.lat', 'to.lng', 'vehicleType'],
        reason:  `Haversine estimate: ~${durationMin} min (${distKm.toFixed(1)} km)`,
      };
    },
    { label: 'haversine_eta', formula: 'distance ÷ speed × traffic_factor' }
  ),
]);

/* ── 4. Surge pricing (calculated, not AI) ────────────────────── */
engine.register('surge_multiplier', [
  calculatedStrategy(
    async (ctx) => {
      const { activeRides, availableDrivers, baseFare } = ctx;
      if (activeRides === undefined || availableDrivers === undefined) return { found: false };

      const ratio      = availableDrivers > 0 ? activeRides / availableDrivers : 10;
      const multiplier = ratio > 4 ? 2.5 : ratio > 2.5 ? 2.0 : ratio > 1.5 ? 1.5 : ratio > 1.0 ? 1.2 : 1.0;
      const surgedFare = Math.round(baseFare * multiplier);

      return {
        found:   true,
        value:   { multiplier, surgedFare, ratio: Math.round(ratio * 10) / 10 },
        formula: 'demand_ratio (activeRides ÷ availableDrivers) → multiplier lookup table',
        inputs:  ['activeRides', 'availableDrivers', 'baseFare'],
        reason:  `Demand ratio ${ratio.toFixed(1)}:1 → ${multiplier}× surge (KES ${surgedFare})`,
      };
    },
    { label: 'surge_calculator' }
  ),
]);

/* ── 5. Nearest driver (P1: verified GPS, P2: last-known, P3: optimization) ── */
engine.register('nearest_driver', [
  realtimeStrategy(
    async (ctx) => {
      const { onlineDrivers, pickup } = ctx;
      if (!Array.isArray(onlineDrivers) || !onlineDrivers.length) return { found: false };
      const ranked = onlineDrivers
        .filter(d => d.lat && d.lng && d.available !== false)
        .map(d => ({ ...d, distKm: _haversineKm(pickup.lat, pickup.lng, d.lat, d.lng) }))
        .sort((a, b) => a.distKm - b.distKm);
      if (!ranked.length) return { found: false };
      return { found: true, value: ranked[0], reason: `Nearest driver: ${ranked[0].distKm.toFixed(1)} km away` };
    },
    'live_gps_drivers'
  ),
  optimizedStrategy(
    async (ctx) => {
      const { lastKnownDrivers, pickup } = ctx;
      if (!Array.isArray(lastKnownDrivers) || !lastKnownDrivers.length) return { found: false };
      const ranked = lastKnownDrivers
        .map(d => ({ ...d, distKm: _haversineKm(pickup.lat, pickup.lng, d.lat, d.lng), isStale: true }))
        .sort((a, b) => a.distKm - b.distKm);
      if (!ranked.length) return { found: false };
      return {
        found:  true,
        value:  ranked[0],
        reason: `Nearest driver (last known position, may be stale): ${ranked[0].distKm.toFixed(1)} km`,
        algorithm: 'nearest-neighbor on last-known GPS positions',
      };
    },
    { label: 'nearest_neighbor', algorithm: 'nearest-neighbor on last-known GPS' }
  ),
]);

/* ── 6. Fraud check (rule engine first, then AI) ─────────────── */
engine.register('fraud_check', [
  /* P1: Deterministic rule engine */
  calculatedStrategy(
    async (ctx) => {
      const { transaction: tx } = ctx;
      if (!tx) return { found: false };

      const flags = [];
      let riskScore = 0;

      if (tx.amount > 50_000)                   { flags.push('high_value');           riskScore += 30; }
      if (tx.attempts && tx.attempts > 3)        { flags.push('multiple_attempts');    riskScore += 25; }
      if (tx.phone && !/^2547\d{8}$/.test(tx.phone)) { flags.push('invalid_phone'); riskScore += 20; }
      if (tx.deviceChanges && tx.deviceChanges > 2)   { flags.push('device_switching'); riskScore += 20; }
      if (tx.velocityCount && tx.velocityCount > 5)   { flags.push('high_velocity');    riskScore += 35; }
      if (tx.newAccount && tx.amount > 10_000)         { flags.push('new_account_high_value'); riskScore += 15; }

      const level = riskScore >= 70 ? 'block' : riskScore >= 40 ? 'review' : 'allow';

      return {
        found:   true,
        value:   { level, riskScore, flags },
        formula: 'weighted rule score: high_value(30) + attempts(25) + velocity(35) + device(20) + …',
        inputs:  ['amount', 'attempts', 'phone', 'deviceChanges', 'velocityCount', 'newAccount'],
        reason:  `Fraud score ${riskScore}/100 → ${level} (rules: ${flags.join(', ') || 'none triggered'})`,
      };
    },
    { label: 'fraud_rule_engine' }
  ),
  /* P4: ML model (future — via Cloud Function) */
  predictedStrategy(
    async (ctx) => {
      /* Only called if rule engine returned 'review' — adds ML confidence */
      const { fraudMLScore } = ctx;
      if (fraudMLScore === undefined) return { found: false };
      return {
        found:      true,
        value:      { mlRiskScore: fraudMLScore, level: fraudMLScore > 0.7 ? 'block' : 'review' },
        confidence: fraudMLScore > 0.7 ? 'high' : 'medium',
        dataPoints: ctx.txHistory ?? 100,
        model:      'sokoni-fraud-classifier-v2',
        reason:     `ML fraud model: ${(fraudMLScore * 100).toFixed(0)}% risk`,
      };
    },
    { label: 'fraud_ml_model', model: 'sokoni-fraud-classifier-v2', requiresApproval: true }
  ),
]);

/* ── 7. Demand forecasting (AI, but requires quality data) ─────── */
engine.register('demand_forecast', [
  predictedStrategy(
    async (ctx) => {
      const { historicalSales, horizon, sku } = ctx;
      if (!Array.isArray(historicalSales) || historicalSales.length < 7) return { found: false };

      /* Simple moving average as baseline (CALCULATED part) */
      const recent  = historicalSales.slice(-14);
      const avgQty  = recent.reduce((s, d) => s + (d.qty ?? 0), 0) / recent.length;
      const growth  = recent.length >= 14
        ? (recent.slice(-7).reduce((s, d) => s + d.qty, 0) / recent.slice(0, 7).reduce((s, d) => s + d.qty, 0)) - 1
        : 0;
      const forecast = Math.round(avgQty * (1 + growth) * horizon);

      return {
        found:      true,
        value:      { forecast, avgDailySales: Math.round(avgQty), growthRate: growth, horizon },
        confidence: historicalSales.length >= 30 ? 'high' : historicalSales.length >= 14 ? 'medium' : 'low',
        dataPoints: historicalSales.length,
        model:      'exponential-smoothing-v1',
        reason:     `${horizon}-day forecast: ~${forecast} units (avg ${avgQty.toFixed(1)}/day, ${(growth*100).toFixed(1)}% growth)`,
      };
    },
    { label: 'demand_forecaster', model: 'exponential-smoothing-v1' }
  ),
]);

/* ── EIP initialisation ──────────────────────────────────────── */
const _ready = flags.init();

/* ── Haversine helper ────────────────────────────────────────── */
function _haversineKm(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dl  = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(dL/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* ── EIP singleton ───────────────────────────────────────────── */
const eip = Object.freeze({
  engine,
  quality: dqe,
  flags,
  log,
  policy,
  Decisions,
  PRIORITY,
  SOURCE,
  /** Resolves when feature flags have been loaded from Firestore */
  ready: _ready,
  /** One-stop decide() shortcut */
  decide: engine.decide.bind(engine),
});

export default eip;
export { engine, dqe as quality, flags, log, policy, Decisions, PRIORITY, SOURCE };

if (typeof window !== 'undefined') {
  window.SokoniEIP = eip;
}
