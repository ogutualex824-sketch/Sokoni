/* ================================================================
   SOKONI AI POLICY ENGINE  v1.0.0

   Project-wide data classification and transparency layer.
   Every value displayed to a user must pass through this engine
   so the user always knows whether they are seeing:

     VERIFIED   — measured directly from a trusted source
                  (GPS fix, sensor read, payment confirmation)
     CALCULATED — computed deterministically from verified inputs
                  (ETA from OSRM route, sales total, health score)
     PREDICTED  — AI/ML inference from historical + live data
                  (demand forecast, fraud risk, recommendations)

   Core rules enforced by this module:
   1. Never fabricate fuel/sensor data — assertFuel() enforces this.
   2. Every AI prediction must carry a confidence level.
   3. Real-time data always takes priority over historical data.
   4. Confidence degrades transparently as data quality drops.

   Usage (ES module):
     import policy from './sokoni-ai-policy.js';
     const eta = policy.calculated(12.4, { formula: 'OSRM + traffic factor' });
     el.innerHTML = `${policy.unwrap(eta)} min ${policy.badge(eta)}`;

   Also available as: window.SokoniAIPolicy
================================================================ */

/* ── Data type constants ───────────────────────────────────────── */
export const DATA_TYPE = Object.freeze({
  VERIFIED:   'verified',
  CALCULATED: 'calculated',
  PREDICTED:  'predicted',
});

/* ── Confidence levels (predictions only) ──────────────────────── */
export const CONFIDENCE = Object.freeze({
  HIGH:   'high',    /* ≥70 confidence score  */
  MEDIUM: 'medium',  /* 40–69 confidence score */
  LOW:    'low',     /* < 40 confidence score  */
});

/* ── PolicyValue shape ─────────────────────────────────────────── */
/**
 * @typedef {Object} PolicyValue
 * @property {'verified'|'calculated'|'predicted'} type
 * @property {*}      value       — the actual data value
 * @property {string} [source]    — verified: sensor/system name
 * @property {string} [formula]   — calculated: description of computation
 * @property {string[]} [inputs]  — calculated: Firestore collections / sensors used
 * @property {string} [confidence]— predicted: 'high'|'medium'|'low'
 * @property {string} [model]     — predicted: model or algorithm name
 * @property {string} [reason]    — predicted: one-line human explanation
 * @property {number} [dataPoints]— predicted: number of data points used
 * @property {number} timestamp   — ms epoch when value was produced
 */

/* ── Factories ─────────────────────────────────────────────────── */

/**
 * Wrap a value that was measured directly from a trusted source.
 * Throws if value is null/undefined — you cannot verify missing data.
 */
export function verified(value, { source = '', timestamp, sensorId = '' } = {}) {
  if (value === null || value === undefined) {
    throw new PolicyError('verified() requires a non-null value. '
      + 'Use assertFuel() or hide the field if the sensor is absent.');
  }
  return Object.freeze({
    type: DATA_TYPE.VERIFIED,
    value,
    source,
    sensorId,
    timestamp: timestamp ?? Date.now(),
  });
}

/**
 * Wrap a value computed deterministically from verified inputs.
 */
export function calculated(value, { inputs = [], formula = '', timestamp } = {}) {
  return Object.freeze({
    type: DATA_TYPE.CALCULATED,
    value,
    inputs,
    formula,
    timestamp: timestamp ?? Date.now(),
  });
}

/**
 * Wrap a value inferred by an AI/ML model or statistical forecast.
 * confidence is required — NEVER omit it.
 */
export function predicted(value, {
  confidence,
  reason   = '',
  model    = 'sokoni-ml',
  dataPoints = 0,
  timestamp,
} = {}) {
  if (!confidence || !Object.values(CONFIDENCE).includes(confidence)) {
    throw new PolicyError(
      `predicted() requires a valid confidence level ('high'|'medium'|'low'). ` +
      `Use scoreConfidence() to derive one from data quality.`
    );
  }
  return Object.freeze({
    type: DATA_TYPE.PREDICTED,
    value,
    confidence,
    reason,
    model,
    dataPoints,
    timestamp: timestamp ?? Date.now(),
  });
}

/* ── Fuel / sensor guard ───────────────────────────────────────── */

/**
 * The most important policy function.
 *
 * NEVER pass a default or fabricated fuel value.
 * If the vehicle has no verified fuel telemetry, return null.
 * The caller must hide the field or show "No sensor data".
 *
 * @param {number|null|undefined} rawFuelPct — raw value from asset document
 * @param {boolean} hasVerifiedTelemetry     — true only if vehicle has a fuel sensor
 * @returns {PolicyValue|null}
 */
export function assertFuel(rawFuelPct, hasVerifiedTelemetry = false) {
  if (!hasVerifiedTelemetry) return null;
  if (typeof rawFuelPct !== 'number' || rawFuelPct < 0 || rawFuelPct > 100) return null;
  return verified(Math.round(rawFuelPct), { source: 'vehicle_fuel_sensor' });
}

/**
 * Same guard for any sensor reading (battery, temperature, weight, etc.)
 */
export function assertSensor(rawValue, hasVerifiedSensor = false, { source = 'sensor', unit = '' } = {}) {
  if (!hasVerifiedSensor) return null;
  if (rawValue === null || rawValue === undefined || typeof rawValue !== 'number') return null;
  return verified(rawValue, { source, unit });
}

/* ── Confidence scoring ────────────────────────────────────────── */

/**
 * Derive a confidence level from data quality signals.
 * Use this to populate the confidence field in predicted().
 *
 * @param {object} opts
 * @param {number} opts.dataPoints   — number of historical records used
 * @param {number} [opts.ageMs]      — age of the most recent data point (ms)
 * @param {boolean} [opts.hasRealTime] — true if live data was incorporated
 * @param {number} [opts.modelAccuracy] — 0–1 model validation accuracy
 * @returns {'high'|'medium'|'low'}
 */
export function scoreConfidence({
  dataPoints   = 0,
  ageMs        = Infinity,
  hasRealTime  = false,
  modelAccuracy = 0,
} = {}) {
  let score = 0;

  /* Data volume (max 40 pts) */
  if (dataPoints >= 10_000) score += 40;
  else if (dataPoints >= 1_000) score += 30;
  else if (dataPoints >= 100)   score += 20;
  else if (dataPoints >= 10)    score += 10;
  else                          score += 0;

  /* Data freshness (max 30 pts) */
  if (hasRealTime)               score += 30;
  else if (ageMs < 60_000)       score += 25;
  else if (ageMs < 600_000)      score += 15;
  else if (ageMs < 3_600_000)    score += 7;

  /* Model accuracy (max 30 pts) */
  if (modelAccuracy >= 0.90)     score += 30;
  else if (modelAccuracy >= 0.75) score += 20;
  else if (modelAccuracy >= 0.50) score += 10;

  if (score >= 70) return CONFIDENCE.HIGH;
  if (score >= 40) return CONFIDENCE.MEDIUM;
  return CONFIDENCE.LOW;
}

/* ── Unwrap ────────────────────────────────────────────────────── */

/**
 * Safely extract the raw value from a PolicyValue,
 * or pass through a plain value unchanged.
 */
export function unwrap(pv) {
  if (pv && typeof pv === 'object' && 'type' in pv && 'value' in pv) return pv.value;
  return pv;
}

export const isVerified   = pv => pv?.type === DATA_TYPE.VERIFIED;
export const isCalculated = pv => pv?.type === DATA_TYPE.CALCULATED;
export const isPredicted  = pv => pv?.type === DATA_TYPE.PREDICTED;

/* ── Badge rendering ───────────────────────────────────────────── */

_injectCSS();

/**
 * Render a compact inline badge for a PolicyValue.
 * Safe to embed directly in innerHTML (no user data in output).
 */
export function badge(pv) {
  if (!pv || typeof pv !== 'object' || !pv.type) return '';

  if (pv.type === DATA_TYPE.VERIFIED) {
    const tip = pv.source ? `Measured by ${pv.source}` : 'Measured directly from a trusted source';
    return `<span class="sk-ai-badge sk-ai-verified" title="${_esc(tip)}">✓ Verified</span>`;
  }

  if (pv.type === DATA_TYPE.CALCULATED) {
    const tip = pv.formula
      ? `Calculated: ${pv.formula}`
      : 'Computed from verified data inputs';
    return `<span class="sk-ai-badge sk-ai-calculated" title="${_esc(tip)}">∑ Calculated</span>`;
  }

  if (pv.type === DATA_TYPE.PREDICTED) {
    const conf = pv.confidence ?? CONFIDENCE.LOW;
    const label = { high: 'High', medium: 'Medium', low: 'Low' }[conf] ?? 'Unknown';
    const tip = pv.reason
      ? `AI Prediction · ${label} Confidence — ${pv.reason}`
      : `AI Prediction · ${label} Confidence`;
    return `<span class="sk-ai-badge sk-ai-predicted sk-ai-conf-${conf}" title="${_esc(tip)}">◎ AI · ${label}</span>`;
  }

  return '';
}

/**
 * Render a full info row suitable for detail panels.
 * Includes the value, badge, and a one-line explanation.
 */
export function infoRow(label, pv, unit = '') {
  const val    = unwrap(pv);
  const bdg    = badge(pv);
  const reason = pv?.reason || pv?.formula || pv?.source || '';
  return `
<div class="sk-ai-row">
  <span class="sk-ai-row-label">${_esc(String(label))}</span>
  <span class="sk-ai-row-val">${_esc(String(val ?? '—'))}${unit ? ' ' + _esc(unit) : ''} ${bdg}</span>
  ${reason ? `<span class="sk-ai-row-reason">${_esc(reason)}</span>` : ''}
</div>`.trim();
}

/**
 * Render a confidence indicator bar (for prediction panels).
 * Returns an SVG progress bar with colour coding.
 */
export function confidenceBar(confidence) {
  const pct  = { high: 85, medium: 55, low: 25 }[confidence] ?? 0;
  const col  = { high: '#71ff00', medium: '#ffc107', low: '#ff6b6b' }[confidence] ?? '#666';
  return `<div class="sk-ai-conf-bar" title="${confidence} confidence">
  <div class="sk-ai-conf-fill" style="width:${pct}%;background:${col};"></div>
</div>`;
}

/* ── Disclosure tooltip ────────────────────────────────────────── */

/**
 * Return a human-readable disclosure string describing the data source.
 * Use in aria-label and title attributes for accessibility.
 */
export function disclosure(pv) {
  if (!pv || typeof pv !== 'object') return 'Source unknown';
  if (pv.type === DATA_TYPE.VERIFIED) {
    return `Verified data from ${pv.source || 'trusted sensor'}. `
      + (pv.timestamp ? `Measured ${_relativeTime(pv.timestamp)}.` : '');
  }
  if (pv.type === DATA_TYPE.CALCULATED) {
    return `Calculated value${pv.formula ? ': ' + pv.formula : ''}. `
      + `Based on verified inputs${pv.inputs?.length ? ': ' + pv.inputs.join(', ') : ''}.`;
  }
  if (pv.type === DATA_TYPE.PREDICTED) {
    return `AI prediction (${pv.model || 'ML model'}). `
      + `Confidence: ${pv.confidence || 'unknown'}. `
      + (pv.reason ? pv.reason + ' ' : '')
      + (pv.dataPoints ? `Based on ${pv.dataPoints.toLocaleString()} data points.` : '');
  }
  return 'Data source unknown';
}

/* ── No-sensor placeholder ─────────────────────────────────────── */

/**
 * Call this when a sensor value is absent.
 * Returns a safe placeholder string for the UI.
 * Never use a default number — display this instead.
 */
export function noSensorPlaceholder(fieldName = 'value') {
  return `<span class="sk-ai-no-sensor" title="No verified ${fieldName} sensor data available">— <span class="sk-ai-no-sensor-lbl">No sensor</span></span>`;
}

/* ── Structured logging ────────────────────────────────────────── */

/**
 * Log a PolicyValue to the console (dev only).
 * Production builds can strip this by setting window.__SK_AI_LOG = false.
 */
export function logDecision(label, pv, context = {}) {
  if (window.__SK_AI_LOG === false) return;
  const icon = { verified: '✓', calculated: '∑', predicted: '◎' }[pv?.type] ?? '?';
  console.info(
    `%c[SokoniAI] ${icon} ${label}`,
    'color:#71ff00;font-weight:bold',
    { ...pv, context }
  );
}

/* ── CSS injection ─────────────────────────────────────────────── */

function _injectCSS() {
  if (document.getElementById('sk-ai-policy-css')) return;
  const s = document.createElement('style');
  s.id = 'sk-ai-policy-css';
  s.textContent = `
/* ── Sokoni AI Policy — Badge System ───────────────── */
.sk-ai-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 9px;
  font-weight: 800;
  padding: 2px 7px;
  border-radius: 6px;
  letter-spacing: .04em;
  text-transform: uppercase;
  vertical-align: middle;
  margin-left: 5px;
  white-space: nowrap;
  font-family: 'Segoe UI', system-ui, sans-serif;
  cursor: help;
  user-select: none;
  flex-shrink: 0;
}

/* Verified — green */
.sk-ai-verified {
  background: rgba(113,255,0,0.10);
  border: 1px solid rgba(113,255,0,0.28);
  color: #71ff00;
}

/* Calculated — blue */
.sk-ai-calculated {
  background: rgba(0,170,255,0.09);
  border: 1px solid rgba(0,170,255,0.24);
  color: #00aaff;
}

/* Predicted — confidence-tinted */
.sk-ai-predicted { border-width: 1px; border-style: solid; }
.sk-ai-conf-high   { background:rgba(113,255,0,0.07); border-color:rgba(113,255,0,0.22); color:#71ff00; }
.sk-ai-conf-medium { background:rgba(255,193,7,0.09); border-color:rgba(255,193,7,0.26); color:#ffc107; }
.sk-ai-conf-low    { background:rgba(255,107,107,0.09); border-color:rgba(255,107,107,0.26); color:#ff6b6b; }

/* Info row layout */
.sk-ai-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 5px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  font-size: 12px;
}
.sk-ai-row:last-child { border-bottom: none; }
.sk-ai-row-label {
  color: rgba(255,255,255,0.45);
  font-weight: 600;
  min-width: 100px;
  flex-shrink: 0;
}
.sk-ai-row-val {
  color: white;
  font-weight: 700;
  flex: 1;
}
.sk-ai-row-reason {
  flex: 0 0 100%;
  font-size: 10px;
  color: rgba(255,255,255,0.28);
  font-style: italic;
  padding-left: 108px;
}

/* Confidence bar */
.sk-ai-conf-bar {
  height: 3px;
  background: rgba(255,255,255,0.08);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 3px;
}
.sk-ai-conf-fill {
  height: 100%;
  border-radius: 2px;
  transition: width .4s ease;
}

/* No-sensor placeholder */
.sk-ai-no-sensor {
  color: rgba(255,255,255,0.28);
  font-size: 12px;
}
.sk-ai-no-sensor-lbl {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .05em;
  color: rgba(255,107,107,0.7);
  margin-left: 3px;
  border: 1px solid rgba(255,107,107,0.3);
  border-radius: 4px;
  padding: 1px 5px;
  vertical-align: middle;
}

/* Policy disclosure panel (used in admin / detail views) */
.sk-ai-disclosure {
  padding: 10px 14px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 10px;
  font-size: 11px;
  color: rgba(255,255,255,0.4);
  line-height: 1.5;
  margin-top: 8px;
}
.sk-ai-disclosure strong { color: rgba(255,255,255,0.7); }

/* Tooltip enhancement — show disclosure on hover */
[title].sk-ai-badge:hover::after {
  content: attr(title);
  position: absolute;
  z-index: 9000;
  background: rgba(10,10,10,0.97);
  border: 1px solid rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.85);
  font-size: 11px;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  padding: 8px 12px;
  border-radius: 10px;
  max-width: 280px;
  white-space: normal;
  box-shadow: 0 8px 32px rgba(0,0,0,0.7);
  margin-top: 4px;
  pointer-events: none;
}
[title].sk-ai-badge { position: relative; }
`;
  document.head.appendChild(s);
}

/* ── Private helpers ───────────────────────────────────────────── */

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _relativeTime(ms) {
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 10)  return 'just now';
  if (secs < 60)  return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

class PolicyError extends Error {
  constructor(msg) {
    super(`[SokoniAIPolicy] ${msg}`);
    this.name = 'PolicyError';
  }
}

/* ── Default export (object API for non-module consumers) ───────── */
const policy = {
  DATA_TYPE, CONFIDENCE,
  verified, calculated, predicted,
  assertFuel, assertSensor,
  scoreConfidence, unwrap,
  isVerified, isCalculated, isPredicted,
  badge, infoRow, confidenceBar, disclosure,
  noSensorPlaceholder, logDecision,
};

export default policy;

/* UMD shim — available as window.SokoniAIPolicy on non-module pages */
if (typeof window !== 'undefined') {
  window.SokoniAIPolicy = policy;
}
