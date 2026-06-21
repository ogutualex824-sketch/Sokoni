/* ================================================================
   SOKONI ENTERPRISE INTELLIGENCE PLATFORM
   Data Quality Engine  v1.0.0

   Validates every data input before it can influence a decision.
   Enforces the EIP rule: bad data → no AI, no decisions, raise alert.

   Profiles:
     gps          — GPS fix quality (hdop, age, speed plausibility)
     payment      — Payment amount, currency, idempotency
     inventory    — Quantity bounds, negative prevention
     session      — Auth validity, role checks
     telemetry    — Sensor readings (fuel, battery, temperature)
     order        — Order integrity (items, amounts, buyer/seller)
     custom       — Caller-defined rules

   Usage:
     import dqe from './sokoni-data-quality.js';

     const report = await dqe.validate({ lat: -1.28, lng: 36.82, hdop: 1.2, ageMs: 800 }, 'gps');
     if (!report.valid) { console.warn(report.reason); return; }

   Exposes: window.SokoniDataQuality + ES default export
================================================================ */

/* ── Quality score thresholds ────────────────────────────────── */
const THRESHOLDS = Object.freeze({
  gps: {
    maxHdop:        4.0,     /* above this = poor fix */
    maxAgeMs:       30_000,  /* 30s — stale GPS */
    warnAgeMs:      10_000,  /* 10s — start warning */
    maxSpeedKmh:    250,     /* plausibility ceiling for road vehicles */
    minLat:         -90,
    maxLat:          90,
    minLng:        -180,
    maxLng:         180,
  },
  payment: {
    minKES:         1,
    maxKES:         150_000,
    allowedCurrencies: ['KES'],
    idempotencyMaxAgeMs: 600_000,  /* 10min — replay attack window */
  },
  inventory: {
    minQty:         0,
    maxQty:         1_000_000,
    maxUnitPrice:   10_000_000,    /* KES 10M ceiling */
  },
  telemetry: {
    fuel:    { min: 0,    max: 100 },
    battery: { min: 0,    max: 100 },
    temp:    { min: -40,  max: 120 },    /* °C */
    weight:  { min: 0,    max: 50_000 }, /* kg */
  },
});

/* ── Validation result ───────────────────────────────────────── */
/**
 * @typedef {Object} QualityReport
 * @property {boolean}  valid
 * @property {string}   grade   — 'A'|'B'|'C'|'D'|'F'
 * @property {number}   score   — 0–100
 * @property {string}   reason  — first failure reason (if !valid)
 * @property {string[]} issues  — all detected issues
 * @property {string[]} warnings
 * @property {string}   profile — which profile was used
 * @property {number}   checkedAt
 */

/* ── Data Quality Engine ─────────────────────────────────────── */
class SokoniDataQualityEngine {
  constructor() {
    /* Custom profile registry */
    this._profiles = new Map();
    /* Alert callback */
    this._alertFn  = null;
  }

  /* ── Register custom profile ─────────────────────────────── */

  /**
   * Register a custom validation profile.
   * @param {string}   name
   * @param {Function} fn  — async (data) → { valid, issues, score }
   */
  registerProfile(name, fn) {
    this._profiles.set(name, fn);
    return this;
  }

  /**
   * Set a callback for quality failures (e.g., send alert to Firestore).
   */
  onFailure(fn) { this._alertFn = fn; return this; }

  /* ── Core validate() ─────────────────────────────────────── */

  /**
   * Validate data against a named profile.
   * @param {object}          data
   * @param {string}          profile  — 'gps'|'payment'|'inventory'|'session'|'telemetry'|'order'|custom
   * @param {object}          [opts]
   * @returns {Promise<QualityReport>}
   */
  async validate(data, profile = 'generic', opts = {}) {
    const issues   = [];
    const warnings = [];
    let   score    = 100;

    try {
      /* Built-in profiles */
      switch (profile) {
        case 'gps':       this._validateGPS(data, issues, warnings, score); score = this._gpsScore(data, issues); break;
        case 'payment':   score = this._validatePayment(data, issues, warnings);    break;
        case 'inventory': score = this._validateInventory(data, issues, warnings);  break;
        case 'session':   score = this._validateSession(data, issues, warnings);    break;
        case 'telemetry': score = this._validateTelemetry(data, issues, warnings);  break;
        case 'order':     score = this._validateOrder(data, issues, warnings);      break;
        default: {
          const custom = this._profiles.get(profile);
          if (custom) {
            const r = await custom(data, opts);
            issues.push(...(r.issues ?? []));
            warnings.push(...(r.warnings ?? []));
            score = r.score ?? (r.valid ? 100 : 0);
          }
          break;
        }
      }
    } catch (e) {
      issues.push('Validation error: ' + e.message);
      score = 0;
    }

    const valid = issues.length === 0 && score >= 50;
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
    const report = {
      valid,
      grade,
      score: Math.round(score),
      reason:    issues[0] ?? (valid ? 'All checks passed' : 'Validation failed'),
      issues,
      warnings,
      profile,
      checkedAt: Date.now(),
    };

    if (!valid && this._alertFn) {
      try { this._alertFn({ data: _stripPII(data), report, profile }); } catch (_) {}
    }

    return report;
  }

  /**
   * Validate multiple data objects at once.
   * Returns false if ANY fails.
   */
  async validateAll(entries) {
    const results = await Promise.all(
      entries.map(({ data, profile, opts }) => this.validate(data, profile, opts))
    );
    return {
      valid:   results.every(r => r.valid),
      reports: results,
      failed:  results.filter(r => !r.valid),
    };
  }

  /* ── GPS validation ──────────────────────────────────────── */

  _validateGPS(data, issues, warnings) {
    const t = THRESHOLDS.gps;

    if (typeof data.lat !== 'number' || data.lat < t.minLat || data.lat > t.maxLat) {
      issues.push(`Invalid latitude: ${data.lat}`);
    }
    if (typeof data.lng !== 'number' && typeof data.lon !== 'number') {
      issues.push('Missing longitude');
    } else {
      const lng = data.lng ?? data.lon;
      if (lng < t.minLng || lng > t.maxLng) issues.push(`Invalid longitude: ${lng}`);
    }
    if (data.hdop !== undefined && data.hdop > t.maxHdop) {
      issues.push(`Poor GPS fix quality (HDOP ${data.hdop} > ${t.maxHdop})`);
    }
    const age = data.ageMs ?? (data.timestamp ? Date.now() - data.timestamp : 0);
    if (age > t.maxAgeMs) {
      issues.push(`Stale GPS fix — ${Math.round(age / 1000)}s old (max ${t.maxAgeMs / 1000}s)`);
    } else if (age > t.warnAgeMs) {
      warnings.push(`GPS fix is ${Math.round(age / 1000)}s old`);
    }
    if (data.speed !== undefined) {
      if (data.speed < 0) issues.push('Negative speed reading');
      if (data.speed > t.maxSpeedKmh) issues.push(`Speed ${data.speed} km/h exceeds plausibility ceiling`);
    }
    if (data.lat === 0 && (data.lng === 0 || data.lon === 0)) {
      issues.push('GPS at (0,0) — likely null island / uninitialized fix');
    }
  }

  _gpsScore(data, issues) {
    let score = 100;
    if (issues.length > 0) return 0;
    /* HDOP scoring */
    if (data.hdop !== undefined) {
      if (data.hdop > 2.5)      score -= 20;
      else if (data.hdop > 1.5) score -= 8;
    }
    /* Age scoring */
    const age = data.ageMs ?? (data.timestamp ? Date.now() - data.timestamp : 0);
    if (age > 20_000)       score -= 25;
    else if (age > 10_000)  score -= 10;
    /* Accuracy */
    if (data.accuracy !== undefined) {
      if (data.accuracy > 50)  score -= 20;
      else if (data.accuracy > 20) score -= 8;
    }
    return Math.max(0, score);
  }

  /* ── Payment validation ──────────────────────────────────── */

  _validatePayment(data, issues, warnings) {
    const t = THRESHOLDS.payment;

    const amount = Number(data.amount);
    if (!amount || amount < t.minKES) {
      issues.push(`Payment amount too low: KES ${amount} (min KES ${t.minKES})`);
    }
    if (amount > t.maxKES) {
      issues.push(`Payment amount exceeds ceiling: KES ${amount} (max KES ${t.maxKES})`);
    }
    const currency = (data.currency ?? 'KES').toUpperCase();
    if (!t.allowedCurrencies.includes(currency)) {
      issues.push(`Unsupported currency: ${currency}. Expected: ${t.allowedCurrencies.join(', ')}`);
    }
    if (!data.ref && !data.orderId && !data.checkoutId) {
      issues.push('Payment missing reference ID (ref, orderId, or checkoutId required)');
    }
    if (!data.phone && !data.uid) {
      issues.push('Payment missing payer identity (phone or uid required)');
    }
    /* Replay detection */
    if (data.createdAt) {
      const age = Date.now() - new Date(data.createdAt).getTime();
      if (age > t.idempotencyMaxAgeMs) {
        issues.push(`Possible replay attack — payment reference is ${Math.round(age / 60000)}min old`);
      }
    }
    if (!data.sellerUid && !data.businessId) {
      warnings.push('Payment has no merchant identifier');
    }

    return issues.length === 0 ? 95 : 0;
  }

  /* ── Inventory validation ────────────────────────────────── */

  _validateInventory(data, issues, warnings) {
    const t = THRESHOLDS.inventory;

    if (typeof data.qty !== 'number') {
      issues.push('Inventory quantity is not a number');
    } else {
      if (data.qty < t.minQty) issues.push(`Negative inventory quantity: ${data.qty}`);
      if (data.qty > t.maxQty) issues.push(`Implausibly large quantity: ${data.qty}`);
    }
    if (data.price !== undefined) {
      if (typeof data.price !== 'number' || data.price < 0) {
        issues.push(`Invalid price: ${data.price}`);
      }
      if (data.price > t.maxUnitPrice) {
        warnings.push(`Unit price KES ${data.price} exceeds KES ${t.maxUnitPrice.toLocaleString()} — verify`);
      }
    }
    if (!data.sku && !data.productId) {
      issues.push('Inventory record missing SKU or productId');
    }
    if (data.reservedQty !== undefined && data.reservedQty > data.qty) {
      issues.push(`Reserved quantity (${data.reservedQty}) exceeds available stock (${data.qty})`);
    }

    return issues.length === 0 ? 90 : 0;
  }

  /* ── Session validation ──────────────────────────────────── */

  _validateSession(data, issues, warnings) {
    if (!data.uid) {
      issues.push('Session has no user ID — unauthenticated');
    }
    if (!data.role) {
      warnings.push('Session has no role — defaulting to guest');
    }
    if (data.expiresAt && Date.now() > new Date(data.expiresAt).getTime()) {
      issues.push('Session has expired');
    }
    if (data.emailVerified === false) {
      warnings.push('User email is not verified');
    }
    return issues.length === 0 ? 95 : 0;
  }

  /* ── Telemetry validation ────────────────────────────────── */

  _validateTelemetry(data, issues, warnings) {
    const t = THRESHOLDS.telemetry;

    if (data.fuel !== undefined) {
      if (typeof data.fuel !== 'number') {
        issues.push('Fuel level is not a number');
      } else if (data.fuel < t.fuel.min || data.fuel > t.fuel.max) {
        issues.push(`Fuel level out of range: ${data.fuel}% (valid: 0–100%)`);
      }
    }
    if (data.battery !== undefined) {
      if (typeof data.battery !== 'number') {
        issues.push('Battery level is not a number');
      } else if (data.battery < t.battery.min || data.battery > t.battery.max) {
        issues.push(`Battery level out of range: ${data.battery}%`);
      }
    }
    if (data.temperature !== undefined) {
      if (data.temperature < t.temp.min || data.temperature > t.temp.max) {
        issues.push(`Temperature ${data.temperature}°C is outside plausible range (${t.temp.min}–${t.temp.max}°C)`);
      }
    }
    if (data.timestamp) {
      const age = Date.now() - new Date(data.timestamp).getTime();
      if (age > 300_000) issues.push(`Telemetry is ${Math.round(age / 60000)}min stale — not usable`);
      else if (age > 60_000) warnings.push(`Telemetry is ${Math.round(age / 60000)}min old`);
    }

    return issues.length === 0 ? 90 : 0;
  }

  /* ── Order validation ────────────────────────────────────── */

  _validateOrder(data, issues, warnings) {
    if (!data.orderId && !data.id) issues.push('Order missing ID');
    if (!data.buyerUid && !data.customerId) issues.push('Order missing buyer identity');
    if (!data.sellerUid && !data.businessId) issues.push('Order missing seller identity');
    if (!Array.isArray(data.items) || data.items.length === 0) {
      issues.push('Order has no line items');
    } else {
      data.items.forEach((item, i) => {
        if (!item.sku && !item.productId) issues.push(`Item ${i}: missing SKU`);
        if (typeof item.qty !== 'number' || item.qty < 1) issues.push(`Item ${i}: invalid quantity`);
        if (typeof item.price !== 'number' || item.price < 0) issues.push(`Item ${i}: invalid price`);
      });
    }
    if (data.total !== undefined) {
      const computed = (data.items ?? []).reduce((s, i) => s + (i.qty * i.price), 0);
      if (Math.abs(computed - data.total) > 1) {
        issues.push(`Order total mismatch — computed KES ${computed.toFixed(2)}, claimed KES ${data.total}`);
      }
    }
    if (!data.status) warnings.push('Order has no status field');
    return issues.length === 0 ? 92 : 0;
  }

  /* ── Convenience helpers ──────────────────────────────────── */

  /** Quick GPS check — returns true if the fix is trustworthy */
  isGoodFix(lat, lng, { hdop, ageMs, accuracy } = {}) {
    if (typeof lat !== 'number' || typeof lng !== 'number') return false;
    if (lat === 0 && lng === 0) return false;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
    if (hdop !== undefined && hdop > THRESHOLDS.gps.maxHdop) return false;
    if (ageMs !== undefined && ageMs > THRESHOLDS.gps.maxAgeMs) return false;
    if (accuracy !== undefined && accuracy > 50) return false;
    return true;
  }

  /** Quick payment amount check */
  isValidAmount(amount, currency = 'KES') {
    const n = Number(amount);
    const t = THRESHOLDS.payment;
    return Number.isFinite(n) && n >= t.minKES && n <= t.maxKES
           && t.allowedCurrencies.includes((currency ?? 'KES').toUpperCase());
  }

  /** Quick inventory sanity check */
  isValidStock(qty, price = 0) {
    const t = THRESHOLDS.inventory;
    return typeof qty === 'number' && qty >= t.minQty && qty <= t.maxQty
           && (price === null || (typeof price === 'number' && price >= 0));
  }
}

/* ── PII stripping for alert payloads ─────────────────────────── */
const PII_FIELDS = new Set(['phone', 'email', 'name', 'idNumber', 'passportNo', 'pin', 'password', 'secret', 'token']);

function _stripPII(data) {
  if (!data || typeof data !== 'object') return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = PII_FIELDS.has(k) ? '[REDACTED]' : v;
  }
  return out;
}

/* ── Singleton ───────────────────────────────────────────────── */
const dqe = new SokoniDataQualityEngine();
export { SokoniDataQualityEngine, THRESHOLDS };
export default dqe;

if (typeof window !== 'undefined') {
  window.SokoniDataQuality = dqe;
}
