/* ================================================================
   SOKONI ENTERPRISE INTELLIGENCE PLATFORM
   Decision Engine  v1.0.0

   The single arbiter for every intelligent decision on the platform.
   Enforces the EIP priority order on every call:

     P1  VERIFIED    — Real-time facts (GPS, payments, inventory, scans)
     P2  CALCULATED  — Deterministic business logic and math
     P3  OPTIMIZED   — Mathematical optimization (VRP, nearest-neighbor)
     P4  PREDICTED   — AI / ML / statistical inference (last resort)
     P5  APPROVAL    — Human gate for high-stakes decisions

   Usage:
     import engine from './sokoni-decision-engine.js';

     engine.register('nearest_driver', [
       { priority: 1, source: 'verified',    fn: myRealtimeFn },
       { priority: 2, source: 'calculated',  fn: myFallbackFn },
     ]);

     const result = await engine.decide('nearest_driver', ctx);
     // result → DecisionResult { value, source, confidence, latencyMs, … }

   Exposes: window.SokoniDecisionEngine + ES default export
================================================================ */

import policy, { CONFIDENCE } from './sokoni-ai-policy.js';

/* ── Priority constants ──────────────────────────────────────── */
export const PRIORITY = Object.freeze({
  VERIFIED:   1,
  CALCULATED: 2,
  OPTIMIZED:  3,
  PREDICTED:  4,
  APPROVAL:   5,
});

export const SOURCE = Object.freeze({
  VERIFIED:        'verified',
  CALCULATED:      'calculated',
  OPTIMIZED:       'optimized',
  PREDICTED:       'predicted',
  APPROVAL:        'awaiting_approval',
  DISABLED:        'disabled',
  QUALITY_FAILURE: 'data_quality_failure',
  NO_STRATEGY:     'no_strategy',
  ERROR:           'error',
});

/* ── DecisionResult ──────────────────────────────────────────── */
/**
 * @typedef {Object} DecisionResult
 * @property {string}  decisionId     — unique ID for audit correlation
 * @property {string}  source         — SOURCE constant
 * @property {*}       value          — the decision output (null if failed)
 * @property {string}  confidence     — 'verified'|'high'|'medium'|'low'|'unknown'
 * @property {string}  reason         — human-readable explanation
 * @property {number}  latencyMs      — total time taken
 * @property {boolean} requiresApproval — true if P5 gate triggered
 * @property {object}  [policyValue]  — AI Policy wrapper (use with badge())
 * @property {object}  metadata       — arbitrary strategy metadata
 */

/* ── Strategy shape ──────────────────────────────────────────── */
/**
 * @typedef {Object} Strategy
 * @property {number}   priority  — PRIORITY constant
 * @property {string}   source    — SOURCE constant
 * @property {Function} fn        — async (ctx: DecisionContext) → StrategyResult
 * @property {string}   [label]   — human label for logs
 * @property {boolean}  [requiresApproval] — if true, result requires human sign-off
 */

/**
 * @typedef {Object} StrategyResult
 * @property {boolean} found      — true if this strategy produced a result
 * @property {*}       [value]    — the result value
 * @property {string}  [confidence] — override CONFIDENCE constant
 * @property {string}  [reason]   — explanation of this result
 * @property {object}  [metadata] — arbitrary data attached to result
 */

/* ── Circuit Breaker ─────────────────────────────────────────── */
class CircuitBreaker {
  constructor({ threshold = 5, windowMs = 60_000, cooldownMs = 30_000 } = {}) {
    this._fails    = 0;
    this._openAt   = null;
    this._threshold  = threshold;
    this._windowMs   = windowMs;
    this._cooldownMs = cooldownMs;
    this._failTimes  = [];
  }

  isOpen() {
    if (this._openAt && Date.now() - this._openAt < this._cooldownMs) return true;
    /* Auto-close after cooldown */
    if (this._openAt) { this._reset(); }
    return false;
  }

  recordSuccess() { this._reset(); }

  recordFailure() {
    const now = Date.now();
    this._failTimes = this._failTimes.filter(t => now - t < this._windowMs);
    this._failTimes.push(now);
    if (this._failTimes.length >= this._threshold) {
      this._openAt = now;
      console.warn('[SokoniEIP] Circuit breaker opened — too many strategy failures.');
    }
  }

  _reset() {
    this._fails     = 0;
    this._openAt    = null;
    this._failTimes = [];
  }
}

/* ── LRU Decision Cache ──────────────────────────────────────── */
class DecisionCache {
  constructor({ maxEntries = 500, ttlMs = 5_000 } = {}) {
    this._map    = new Map();
    this._max    = maxEntries;
    this._ttl    = ttlMs;
  }

  key(decisionType, ctx) {
    try { return decisionType + ':' + JSON.stringify(ctx._cacheKey ?? ctx); }
    catch (_) { return null; }
  }

  get(k) {
    if (!k) return null;
    const entry = this._map.get(k);
    if (!entry) return null;
    if (Date.now() - entry.ts > this._ttl) { this._map.delete(k); return null; }
    return entry.value;
  }

  set(k, v) {
    if (!k) return;
    if (this._map.size >= this._max) {
      /* Evict oldest */
      const first = this._map.keys().next().value;
      this._map.delete(first);
    }
    this._map.set(k, { value: v, ts: Date.now() });
  }

  invalidate(decisionType) {
    for (const k of this._map.keys()) {
      if (k.startsWith(decisionType + ':')) this._map.delete(k);
    }
  }

  clear() { this._map.clear(); }
}

/* ── Decision Engine ─────────────────────────────────────────── */
class SokoniDecisionEngine {
  constructor(opts = {}) {
    /* Map<decisionType, Strategy[]> */
    this._registry = new Map();

    /* Optional injected dependencies */
    this.featureFlags   = opts.featureFlags   ?? null;
    this.dataQuality    = opts.dataQuality    ?? null;
    this.logger         = opts.logger         ?? null;

    /* Operational state */
    this._cache          = new DecisionCache(opts.cache   ?? {});
    this._breaker        = new CircuitBreaker(opts.breaker ?? {});
    this._approvalQueue  = [];    /* decisions awaiting human approval */
    this._listeners      = new Map();
  }

  /* ── Registration ────────────────────────────────────────── */

  /**
   * Register strategies for a decision type.
   * Can be called multiple times — strategies are merged and re-sorted.
   *
   * @param {string}     decisionType — e.g. 'nearest_driver', 'eta', 'recommendation'
   * @param {Strategy[]} strategies
   */
  register(decisionType, strategies) {
    const existing = this._registry.get(decisionType) ?? [];
    const merged   = [...existing, ...strategies]
      .sort((a, b) => a.priority - b.priority);
    this._registry.set(decisionType, merged);
    return this;
  }

  /**
   * Remove all strategies for a decision type.
   */
  unregister(decisionType) {
    this._registry.delete(decisionType);
    this._cache.invalidate(decisionType);
    return this;
  }

  /* ── Core decide() ───────────────────────────────────────── */

  /**
   * Execute the decision pipeline for a given type.
   *
   * @param {string} decisionType
   * @param {object} ctx — decision context (inputs, constraints, flags)
   * @returns {Promise<DecisionResult>}
   */
  async decide(decisionType, ctx = {}) {
    const startMs = performance.now();
    const id      = _genId();

    /* Step 0: Circuit breaker */
    if (this._breaker.isOpen()) {
      return _failResult(id, SOURCE.ERROR, 'Circuit breaker open — too many recent failures.', startMs);
    }

    /* Step 1: Feature flag gate */
    if (this.featureFlags && ctx.featureFlag) {
      const enabled = await this.featureFlags.isEnabled(ctx.featureFlag, ctx.uid).catch(() => true);
      if (!enabled) {
        return _result(id, SOURCE.DISABLED, null, 'unknown',
          `Feature flag '${ctx.featureFlag}' is disabled.`, {}, startMs);
      }
    }

    /* Step 2: Cache check */
    if (!ctx.noCache) {
      const cached = this._cache.get(this._cache.key(decisionType, ctx));
      if (cached) {
        this._emit('cache_hit', { decisionType, id });
        return { ...cached, decisionId: id, fromCache: true };
      }
    }

    /* Step 3: Data quality gate */
    if (this.dataQuality && ctx.inputs) {
      const q = await this.dataQuality.validate(ctx.inputs, ctx.qualityProfile).catch(() => null);
      if (q && !q.valid) {
        this._logDecision(id, decisionType, ctx, SOURCE.QUALITY_FAILURE, null, startMs, q.reason);
        return _result(id, SOURCE.QUALITY_FAILURE, null, 'unknown',
          'Data quality validation failed: ' + q.reason, q, startMs);
      }
    }

    /* Step 4: Execute strategies in priority order */
    const strategies = this._registry.get(decisionType) ?? [];
    if (!strategies.length) {
      return _result(id, SOURCE.NO_STRATEGY, null, 'unknown',
        `No strategies registered for '${decisionType}'.`, {}, startMs);
    }

    /* Determine which priorities are allowed by caller */
    const maxPriority = ctx.maxPriority ?? PRIORITY.PREDICTED;

    for (const strategy of strategies) {
      if (strategy.priority > maxPriority) continue;

      /* Skip AI strategies if feature flag disabled */
      if (strategy.priority >= PRIORITY.PREDICTED && this.featureFlags) {
        const aiEnabled = await this.featureFlags.isEnabled('ai_predictions', ctx.uid).catch(() => true);
        if (!aiEnabled) continue;
      }

      let stratResult;
      try {
        stratResult = await Promise.race([
          strategy.fn(ctx),
          _timeout(ctx.timeoutMs ?? 8_000),
        ]);
      } catch (err) {
        this._breaker.recordFailure();
        console.warn(`[SokoniEIP] Strategy '${strategy.label ?? strategy.source}' failed:`, err.message);
        continue;
      }

      if (!stratResult?.found) continue;

      this._breaker.recordSuccess();

      /* Build confidence */
      const conf = stratResult.confidence
        ?? _sourceConfidence(strategy.source);

      /* Wrap in AI policy */
      const pv = _wrapPolicy(strategy.source, stratResult.value, {
        confidence: conf,
        reason:     stratResult.reason,
        formula:    stratResult.formula,
        inputs:     stratResult.inputs,
        model:      stratResult.model,
        dataPoints: stratResult.dataPoints,
      });

      const final = _result(id, strategy.source, stratResult.value, conf,
        stratResult.reason ?? `Resolved via ${strategy.label ?? strategy.source}`,
        stratResult.metadata ?? {}, startMs, pv);

      /* P5: Approval gate */
      if (strategy.requiresApproval || ctx.requiresApproval) {
        final.requiresApproval = true;
        this._approvalQueue.push({ id, decisionType, ctx, result: final });
        this._emit('approval_required', { id, decisionType });
      }

      /* Cache if cacheable */
      if (!ctx.noCache && strategy.priority >= PRIORITY.CALCULATED) {
        this._cache.set(this._cache.key(decisionType, ctx), final);
      }

      this._logDecision(id, decisionType, ctx, strategy.source, stratResult.value, startMs, final.reason);
      this._emit('decided', { decisionType, id, source: strategy.source });
      return final;
    }

    /* All strategies exhausted */
    const miss = _result(id, SOURCE.NO_STRATEGY, null, 'unknown',
      `All strategies exhausted for '${decisionType}'.`, {}, startMs);
    this._logDecision(id, decisionType, ctx, SOURCE.NO_STRATEGY, null, startMs, miss.reason);
    return miss;
  }

  /* ── Approval queue ──────────────────────────────────────── */

  getPendingApprovals() { return [...this._approvalQueue]; }

  approve(decisionId) {
    const idx = this._approvalQueue.findIndex(d => d.id === decisionId);
    if (idx === -1) return false;
    const entry = this._approvalQueue.splice(idx, 1)[0];
    entry.result.requiresApproval = false;
    entry.result.approvedAt       = new Date().toISOString();
    this._emit('approved', { decisionId });
    return entry.result;
  }

  reject(decisionId, reason = '') {
    const idx = this._approvalQueue.findIndex(d => d.id === decisionId);
    if (idx === -1) return false;
    this._approvalQueue.splice(idx, 1);
    this._emit('rejected', { decisionId, reason });
    return true;
  }

  /* ── Event system ────────────────────────────────────────── */

  on(event, fn) {
    const fns = this._listeners.get(event) ?? [];
    fns.push(fn);
    this._listeners.set(event, fns);
    return this;
  }

  off(event, fn) {
    const fns = (this._listeners.get(event) ?? []).filter(f => f !== fn);
    this._listeners.set(event, fns);
    return this;
  }

  _emit(event, data) {
    (this._listeners.get(event) ?? []).forEach(fn => { try { fn(data); } catch (_) {} });
  }

  /* ── Observability ───────────────────────────────────────── */

  _logDecision(id, decisionType, ctx, source, value, startMs, reason) {
    if (!this.logger) return;
    try {
      this.logger.log({
        decisionId:   id,
        decisionType,
        source,
        module:       ctx.module ?? 'unknown',
        uid:          ctx.uid ?? null,
        latencyMs:    Math.round(performance.now() - startMs),
        confidence:   _sourceConfidence(source),
        hasValue:     value !== null && value !== undefined,
        reason,
        ts:           Date.now(),
      });
    } catch (_) {}
  }

  /* ── Cache control ───────────────────────────────────────── */

  invalidateCache(decisionType) { this._cache.invalidate(decisionType); }
  clearCache()                  { this._cache.clear(); }
}

/* ── Built-in reusable strategies ───────────────────────────── */

/**
 * Build a VERIFIED real-time strategy.
 * fn must return { found, value, reason? } from a live source.
 */
export function realtimeStrategy(fn, label = 'realtime') {
  return {
    priority: PRIORITY.VERIFIED,
    source:   SOURCE.VERIFIED,
    label,
    fn: async (ctx) => {
      const r = await fn(ctx);
      if (!r?.found) return { found: false };
      return { found: true, value: r.value, reason: r.reason ?? 'Live real-time data', inputs: r.inputs };
    },
  };
}

/**
 * Build a CALCULATED business-rule strategy.
 */
export function calculatedStrategy(fn, { label = 'calculated', formula = '', inputs = [] } = {}) {
  return {
    priority: PRIORITY.CALCULATED,
    source:   SOURCE.CALCULATED,
    label,
    fn: async (ctx) => {
      const r = await fn(ctx);
      if (!r?.found) return { found: false };
      return { found: true, value: r.value, formula: formula || r.formula, inputs, reason: r.reason };
    },
  };
}

/**
 * Build an OPTIMIZED math/algorithm strategy.
 */
export function optimizedStrategy(fn, { label = 'optimized', algorithm = '' } = {}) {
  return {
    priority: PRIORITY.OPTIMIZED,
    source:   SOURCE.OPTIMIZED,
    label,
    fn: async (ctx) => {
      const r = await fn(ctx);
      if (!r?.found) return { found: false };
      return { found: true, value: r.value, formula: algorithm, reason: r.reason };
    },
  };
}

/**
 * Build a PREDICTED AI/ML strategy.
 * Must include model, dataPoints, and confidence will be scored automatically.
 */
export function predictedStrategy(fn, {
  label      = 'ai_prediction',
  model      = 'sokoni-ml',
  requiresApproval = false,
} = {}) {
  return {
    priority: PRIORITY.PREDICTED,
    source:   SOURCE.PREDICTED,
    label,
    requiresApproval,
    fn: async (ctx) => {
      const r = await fn(ctx);
      if (!r?.found) return { found: false };
      const conf = r.confidence ?? policy.scoreConfidence({
        dataPoints:  r.dataPoints  ?? 0,
        ageMs:       r.ageMs       ?? Infinity,
        hasRealTime: r.hasRealTime ?? false,
        modelAccuracy: r.modelAccuracy ?? 0,
      });
      return {
        found:      true,
        value:      r.value,
        confidence: conf,
        reason:     r.reason,
        model:      r.model ?? model,
        dataPoints: r.dataPoints ?? 0,
      };
    },
  };
}

/* ── Pre-built common decision types ─────────────────────────── */

/**
 * SokoniDecisionEngine.Decisions — ready-made contexts for common decisions.
 * Each returns a DecisionContext ready to pass to engine.decide().
 */
export const Decisions = {
  nearestDriver: (pickup, options = {}) => ({
    _cacheKey: { type: 'nearest_driver', lat: Math.round(pickup.lat * 100) / 100, lng: Math.round(pickup.lng * 100) / 100 },
    module:    'delivery',
    pickup,
    maxPriority: PRIORITY.OPTIMIZED,   /* never use AI for driver assignment */
    timeoutMs:   5_000,
    noCache:     true,                  /* always fresh */
    ...options,
  }),

  eta: (from, to, vehicleType, options = {}) => ({
    _cacheKey: { type: 'eta', lat1: Math.round(from.lat * 100) / 100, lng1: Math.round(from.lng * 100) / 100 },
    module:    'routing',
    from, to, vehicleType,
    maxPriority: PRIORITY.CALCULATED,  /* ETA is always calculated — never AI */
    timeoutMs:   6_000,
    ...options,
  }),

  recommendation: (uid, context, options = {}) => ({
    _cacheKey: { type: 'rec', uid, ctx: context.slice?.(-32) ?? context },
    module:    'recommendations',
    uid, context,
    maxPriority: PRIORITY.PREDICTED,
    featureFlag: 'ai_recommendations',
    timeoutMs:   10_000,
    ...options,
  }),

  fraudCheck: (transaction, options = {}) => ({
    module:    'fraud',
    transaction,
    maxPriority: PRIORITY.PREDICTED,
    featureFlag: 'fraud_detection',
    requiresApproval: true,           /* fraud decisions require human sign-off */
    noCache:     true,
    timeoutMs:   3_000,
    ...options,
  }),

  demandForecast: (sku, region, horizon, options = {}) => ({
    _cacheKey: { type: 'demand', sku, region, horizon },
    module:    'forecasting',
    sku, region, horizon,
    maxPriority: PRIORITY.PREDICTED,
    featureFlag: 'demand_forecasting',
    timeoutMs:   15_000,
    ...options,
  }),

  commission: (order, rates, options = {}) => ({
    module:    'finance',
    order, rates,
    maxPriority: PRIORITY.CALCULATED, /* commission is always deterministic */
    noCache:     false,
    timeoutMs:   1_000,
    ...options,
  }),

  inventoryReorder: (sku, stock, rules, options = {}) => ({
    module:    'inventory',
    sku, stock, rules,
    maxPriority: PRIORITY.CALCULATED,
    noCache:     false,
    ...options,
  }),
};

/* ── Private helpers ─────────────────────────────────────────── */

function _genId() {
  return 'DE-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function _sourceConfidence(source) {
  switch (source) {
    case SOURCE.VERIFIED:    return 'verified';
    case SOURCE.CALCULATED:  return 'verified';   /* deterministic = as reliable as verified */
    case SOURCE.OPTIMIZED:   return 'high';
    case SOURCE.PREDICTED:   return CONFIDENCE.MEDIUM;
    default:                 return 'unknown';
  }
}

function _wrapPolicy(source, value, meta) {
  try {
    if (source === SOURCE.VERIFIED)   return policy.verified(value,   { source: meta.source ?? 'realtime' });
    if (source === SOURCE.CALCULATED) return policy.calculated(value, { formula: meta.formula, inputs: meta.inputs ?? [] });
    if (source === SOURCE.OPTIMIZED)  return policy.calculated(value, { formula: meta.formula ?? 'optimization algorithm' });
    if (source === SOURCE.PREDICTED)  return policy.predicted(value,  {
      confidence: meta.confidence ?? CONFIDENCE.MEDIUM,
      reason:     meta.reason,
      model:      meta.model ?? 'sokoni-ml',
      dataPoints: meta.dataPoints ?? 0,
    });
  } catch (_) {}
  return null;
}

function _result(id, source, value, confidence, reason, metadata, startMs, pv = null) {
  return Object.freeze({
    decisionId:        id,
    source,
    value,
    confidence,
    reason,
    metadata:          metadata ?? {},
    latencyMs:         Math.round(performance.now() - startMs),
    requiresApproval:  false,
    policyValue:       pv,
    badge:             pv ? policy.badge(pv) : '',
    timestamp:         Date.now(),
  });
}

function _failResult(id, source, reason, startMs) {
  return _result(id, source, null, 'unknown', reason, {}, startMs);
}

function _timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Decision timeout after ${ms}ms`)), ms)
  );
}

/* ── Singleton ───────────────────────────────────────────────── */
const engine = new SokoniDecisionEngine();

export { SokoniDecisionEngine };
export default engine;

/* UMD shim */
if (typeof window !== 'undefined') {
  window.SokoniDecisionEngine = engine;
  window.SokoniDecisionPRIORITY = PRIORITY;
  window.SokoniDecisionSOURCE   = SOURCE;
}
