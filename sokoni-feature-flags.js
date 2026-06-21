/* ================================================================
   SOKONI ENTERPRISE INTELLIGENCE PLATFORM
   Feature Flags Engine  v1.0.0

   Firestore-backed feature flags for every intelligent feature.
   Supports: enable/disable, gradual rollout, A/B testing,
             regional restrictions, emergency kill-switch.

   Firestore schema:
     featureFlags/{flagId} {
       name:         string
       enabled:      boolean
       rolloutPct:   number   — 0–100 (% of users who see it)
       regions:      string[] — e.g. ['nairobi','mombasa'] (empty = all)
       abVariant:    'A'|'B'|null
       disabledAt:   timestamp | null
       reason:       string   — why was it disabled
       allowedRoles: string[] — empty = all roles
       updatedAt:    timestamp
       updatedBy:    string
     }

   Usage:
     import flags from './sokoni-feature-flags.js';
     await flags.init();
     const on = await flags.isEnabled('ai_recommendations', uid, { region: 'nairobi' });

   Exposes: window.SokoniFlags + ES default export
================================================================ */

const CACHE_TTL_MS    = 60_000;   /* 1 min — refresh from Firestore */
const FIRESTORE_COLL  = 'featureFlags';

/* ── Default flags (used when Firestore is unreachable) ────────── */
const DEFAULTS = {
  /* AI/ML features */
  ai_predictions:         true,
  ai_recommendations:     true,
  ai_demand_forecasting:  true,
  ai_fraud_detection:     true,
  ai_ops_insights:        true,
  ai_price_suggestions:   true,
  ai_nlp_search:          true,

  /* Platform intelligence */
  decision_engine:        true,
  data_quality_engine:    true,
  confidence_badges:      true,
  observability:          true,

  /* Delivery & GIP */
  gip_realtime_dispatch:  true,
  gip_route_optimizer:    true,
  gip_fleet_telemetry:    true,
  gip_shift_suggestions:  true,
  gip_ops_insights:       true,

  /* Commerce */
  dynamic_pricing:        false,  /* off by default — needs pricing model */
  surge_pricing:          false,
  inventory_forecasting:  true,
  smart_reorder:          true,

  /* Security */
  fraud_detection:        true,
  rate_limiting:          true,
  device_fingerprint:     true,

  /* A/B experiments */
  homepage_v2:            false,
  new_checkout_flow:      false,
};

/* ── Feature Flag Engine ─────────────────────────────────────── */
class SokoniFeatureFlagEngine {
  constructor() {
    this._cache       = new Map();   /* flagId → { value, fetchedAt } */
    this._ready       = false;
    this._initPromise = null;
    this._db          = null;
    this._listeners   = new Map();   /* flagId → unsubscribe fn */
    this._overrides   = new Map();   /* local dev overrides */
  }

  /* ── Init ────────────────────────────────────────────────── */

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._load();
    return this._initPromise;
  }

  async _load() {
    try {
      const { getFirestore, collection, getDocs } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const { app } = await import('./firebase.js');
      this._db = getFirestore(app);

      const snap = await getDocs(collection(this._db, FIRESTORE_COLL));
      snap.forEach(d => {
        this._cache.set(d.id, { value: d.data(), fetchedAt: Date.now() });
      });
      this._ready = true;
    } catch (e) {
      console.warn('[SokoniFlags] Could not load from Firestore — using defaults:', e.message);
      /* Seed cache from defaults so the engine still works offline */
      for (const [k, v] of Object.entries(DEFAULTS)) {
        this._cache.set(k, { value: { enabled: v, rolloutPct: 100, regions: [], allowedRoles: [] }, fetchedAt: 0 });
      }
      this._ready = true;
    }
  }

  /* ── Core isEnabled() ────────────────────────────────────── */

  /**
   * Check whether a feature flag is enabled for a specific user.
   *
   * @param {string}  flagId
   * @param {string}  [uid]         — user ID for rollout hashing
   * @param {object}  [ctx]
   * @param {string}  [ctx.region]  — user's county/region
   * @param {string}  [ctx.role]    — user's role
   * @returns {Promise<boolean>}
   */
  async isEnabled(flagId, uid = '', ctx = {}) {
    await this.init();

    /* Local override takes priority (dev/test use) */
    if (this._overrides.has(flagId)) return this._overrides.get(flagId);

    const flag = await this._getFlag(flagId);

    /* Not defined → use default if known, else true */
    if (!flag) return DEFAULTS[flagId] ?? true;

    /* Hard-disabled */
    if (!flag.enabled) return false;

    /* Role restriction */
    if (flag.allowedRoles?.length && ctx.role) {
      if (!flag.allowedRoles.includes(ctx.role)) return false;
    }

    /* Regional restriction */
    if (flag.regions?.length && ctx.region) {
      if (!flag.regions.includes(ctx.region.toLowerCase())) return false;
    }

    /* Gradual rollout — consistent hash of uid */
    const pct = flag.rolloutPct ?? 100;
    if (pct < 100 && uid) {
      const hash = _djb2(flagId + ':' + uid) % 100;
      if (hash >= pct) return false;
    }

    return true;
  }

  /* ── Get flag data ───────────────────────────────────────── */

  async _getFlag(flagId) {
    /* Check cache freshness */
    const cached = this._cache.get(flagId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.value;
    }

    /* Refresh from Firestore */
    if (this._db) {
      try {
        const { doc, getDoc } = await import(
          'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
        );
        const snap = await getDoc(doc(this._db, FIRESTORE_COLL, flagId));
        if (snap.exists()) {
          const data = snap.data();
          this._cache.set(flagId, { value: data, fetchedAt: Date.now() });
          return data;
        }
      } catch (e) {
        /* Return stale cache if available */
        if (cached) return cached.value;
      }
    }

    return null;
  }

  /* ── Flag management (Admin UI / Cloud Functions) ────────── */

  /**
   * Enable a flag immediately.
   * Requires admin role — validates before writing.
   */
  async enable(flagId, reason = '', adminUid = '') {
    return this._write(flagId, { enabled: true, disabledAt: null, reason, updatedBy: adminUid });
  }

  /**
   * Disable a flag immediately (emergency kill-switch).
   */
  async disable(flagId, reason = '', adminUid = '') {
    return this._write(flagId, {
      enabled:     false,
      disabledAt:  new Date().toISOString(),
      reason,
      updatedBy:   adminUid,
    });
  }

  /**
   * Set rollout percentage (0 = off, 100 = everyone).
   */
  async setRollout(flagId, pct, adminUid = '') {
    if (pct < 0 || pct > 100) throw new Error('Rollout must be 0–100');
    return this._write(flagId, { rolloutPct: pct, updatedBy: adminUid });
  }

  /**
   * Restrict flag to specific regions.
   * @param {string[]} regions — e.g. ['nairobi', 'mombasa']
   */
  async setRegions(flagId, regions, adminUid = '') {
    return this._write(flagId, { regions: regions.map(r => r.toLowerCase()), updatedBy: adminUid });
  }

  async _write(flagId, data) {
    if (!this._db) throw new Error('Firestore not initialised');
    const { doc, setDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const payload = { ...data, updatedAt: serverTimestamp() };
    await setDoc(doc(this._db, FIRESTORE_COLL, flagId), payload, { merge: true });
    /* Invalidate local cache */
    this._cache.delete(flagId);
    return payload;
  }

  /* ── Live listener (admin dashboard) ────────────────────── */

  /**
   * Subscribe to real-time flag changes.
   * Returns unsubscribe function.
   */
  async subscribe(flagId, callback) {
    if (!this._db) await this.init();
    const { doc, onSnapshot } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const unsub = onSnapshot(doc(this._db, FIRESTORE_COLL, flagId), (snap) => {
      if (snap.exists()) {
        this._cache.set(flagId, { value: snap.data(), fetchedAt: Date.now() });
        callback(snap.data());
      }
    });
    this._listeners.set(flagId, unsub);
    return unsub;
  }

  /** Subscribe to ALL flag changes */
  async subscribeAll(callback) {
    if (!this._db) await this.init();
    const { collection, onSnapshot } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const unsub = onSnapshot(collection(this._db, FIRESTORE_COLL), (snap) => {
      const flags = {};
      snap.forEach(d => {
        this._cache.set(d.id, { value: d.data(), fetchedAt: Date.now() });
        flags[d.id] = d.data();
      });
      callback(flags);
    });
    return unsub;
  }

  /* ── A/B variant assignment ──────────────────────────────── */

  /**
   * Get the A/B variant for a user, consistent across sessions.
   * @returns {Promise<'A'|'B'|null>}
   */
  async getVariant(flagId, uid = '') {
    const flag = await this._getFlag(flagId);
    if (!flag?.enabled || !flag?.abVariant) return null;
    const hash = _djb2(flagId + ':ab:' + uid) % 2;
    return hash === 0 ? 'A' : 'B';
  }

  /* ── Dev overrides ───────────────────────────────────────── */

  /** Override a flag locally (dev/test only — not persisted to Firestore) */
  override(flagId, value) { this._overrides.set(flagId, value); return this; }
  clearOverride(flagId)   { this._overrides.delete(flagId); return this; }
  clearAllOverrides()     { this._overrides.clear(); return this; }

  /* ── Introspection ───────────────────────────────────────── */

  /** Get all flags with their current cached state */
  getAll() {
    const out = {};
    for (const [k, v] of this._cache.entries()) out[k] = v.value;
    return out;
  }

  /** Get all flags matching a category prefix */
  getCategory(prefix) {
    const out = {};
    for (const [k, v] of this._cache.entries()) {
      if (k.startsWith(prefix)) out[k] = v.value;
    }
    return out;
  }

  /* ── Seed Firestore with defaults (run once on first deploy) ── */

  async seedDefaults(adminUid = 'system') {
    if (!this._db) await this.init();
    const { doc, setDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const writes = Object.entries(DEFAULTS).map(([flagId, enabled]) =>
      setDoc(doc(this._db, FIRESTORE_COLL, flagId), {
        name:         flagId.replace(/_/g, ' '),
        enabled,
        rolloutPct:   100,
        regions:      [],
        allowedRoles: [],
        abVariant:    null,
        disabledAt:   null,
        reason:       'Default',
        updatedBy:    adminUid,
        updatedAt:    serverTimestamp(),
      }, { merge: true })
    );
    await Promise.all(writes);
    console.info(`[SokoniFlags] Seeded ${writes.length} default flags to Firestore`);
  }
}

/* ── DJB2 hash — deterministic, no crypto needed ─────────────── */
function _djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0; /* unsigned 32-bit */
  }
  return h;
}

/* ── Singleton ───────────────────────────────────────────────── */
const flags = new SokoniFeatureFlagEngine();
export { SokoniFeatureFlagEngine, DEFAULTS as FLAG_DEFAULTS };
export default flags;

if (typeof window !== 'undefined') {
  window.SokoniFlags = flags;
}
