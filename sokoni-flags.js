/**
 * SOKONI Feature Flags — Client-Side SDK
 *
 * Backed by Firebase Remote Config for instant enable/disable without redeploy.
 * Falls back to safe defaults if Remote Config is unavailable.
 *
 * Usage:
 *   await SokoniFlags.init();
 *   if (SokoniFlags.get('new_checkout_flow')) { ... }
 *   SokoniFlags.onChange('search_v2', enabled => { ... });
 */
(function (global) {
  'use strict';

  /* ── Safe defaults — features are OFF by default unless explicitly enabled ── */
  const DEFAULTS = {
    /* Core commerce */
    new_checkout_flow:        false,
    express_checkout:         false,
    cart_persistence_v2:      false,

    /* Search */
    search_v2_typesense:      true,
    search_algolia_fallback:  true,
    search_voice:             false,
    search_image:             false,

    /* Payments */
    mpesa_express_v3:         true,
    card_payments:            true,
    wallet_topup:             true,
    buy_now_pay_later:        false,

    /* AI */
    ai_assistant:             true,
    ai_moderation:            true,
    ai_recommendations:       true,
    ai_price_intelligence:    false,

    /* UX */
    dark_mode:                true,
    skeleton_loading:         true,
    infinite_scroll:          true,
    push_notifications:       true,

    /* Seller */
    seller_analytics_v2:      false,
    bulk_product_upload:      false,
    seller_live_stream:       false,

    /* POS */
    smartpos_offline_mode:    true,
    smartpos_multi_currency:  false,

    /* Delivery */
    real_time_tracking:       true,
    driver_surge_pricing:     false,

    /* Maintenance */
    maintenance_mode:         false,
    read_only_mode:           false,

    /* Canary — auto-set by canary controller, never set manually */
    canary_new_functions:     false,
  };

  const CACHE_KEY = 'sokoni_flags_v1';
  const CACHE_TTL = 5 * 60_000; /* 5 minutes */

  let _flags     = { ...DEFAULTS };
  let _listeners = {};
  let _ready     = false;
  let _readyPromise;

  function _loadCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const { flags, ts } = JSON.parse(raw);
      if (Date.now() - ts < CACHE_TTL) return flags;
    } catch { /* ignore */ }
    return null;
  }

  function _saveCache(flags) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ flags, ts: Date.now() })); } catch { }
  }

  function _applyFlags(remote) {
    const prev = { ..._flags };
    _flags = { ...DEFAULTS, ...remote };
    /* Notify listeners of changed flags */
    Object.keys(_listeners).forEach(key => {
      if (prev[key] !== _flags[key]) {
        (_listeners[key] || []).forEach(cb => { try { cb(_flags[key]); } catch { } });
      }
    });
    _saveCache(_flags);
  }

  async function _fetchRemoteConfig() {
    if (!window.firebase || !window.firebaseApp) return null;
    try {
      const { getRemoteConfig, fetchAndActivate, getAll } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-remote-config.js'
      );
      const rc = getRemoteConfig(window.firebaseApp);
      rc.settings.minimumFetchIntervalMillis = CACHE_TTL;
      rc.defaultConfig = DEFAULTS;

      await fetchAndActivate(rc);
      const all = getAll(rc);
      const remote = {};
      Object.entries(all).forEach(([k, v]) => {
        try { remote[k] = JSON.parse(v.asString()); }
        catch { remote[k] = v.asBoolean(); }
      });
      return remote;
    } catch {
      return null;
    }
  }

  const SokoniFlags = {
    async init() {
      if (_readyPromise) return _readyPromise;

      _readyPromise = (async () => {
        /* Try cache first for instant render */
        const cached = _loadCache();
        if (cached) _applyFlags(cached);

        /* Fetch fresh from Remote Config */
        const remote = await _fetchRemoteConfig();
        if (remote) _applyFlags(remote);

        _ready = true;
      })();

      return _readyPromise;
    },

    get(key) {
      if (!_ready) {
        const cached = _loadCache();
        if (cached && key in cached) return cached[key];
      }
      return key in _flags ? _flags[key] : (key in DEFAULTS ? DEFAULTS[key] : false);
    },

    getAll() { return { ..._flags }; },

    /* Register a callback for when a flag changes at runtime */
    onChange(key, cb) {
      if (!_listeners[key]) _listeners[key] = [];
      _listeners[key].push(cb);
      return () => { _listeners[key] = _listeners[key].filter(f => f !== cb); };
    },

    /* Force refresh (call after admin changes a flag) */
    async refresh() {
      sessionStorage.removeItem(CACHE_KEY);
      const remote = await _fetchRemoteConfig();
      if (remote) _applyFlags(remote);
    },

    isReady() { return _ready; },

    /* Maintenance mode short-circuit */
    isMaintenanceMode() { return this.get('maintenance_mode') === true; },
    isReadOnly()        { return this.get('read_only_mode')   === true; },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SokoniFlags;
  } else {
    global.SokoniFlags = SokoniFlags;
  }
})(typeof window !== 'undefined' ? window : global);
