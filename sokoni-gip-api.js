/* ================================================================
   SOKONI GIP — Unified Module API  v1.0.0

   This is the ONLY file any Sokoni module needs to import.
   It wraps GIPEngine, DispatchEngine, GIPAnalytics, and RouteEngine
   behind a stable, version-locked interface so implementation details
   can change without breaking callers.

   Usage (in any Sokoni page):
   ──────────────────────────────────────────────────────────────
   import GIPApi from './sokoni-gip-api.js';
   const gip = new GIPApi({ module: 'food', region: 'nairobi' });
   await gip.init();

   // Track a courier's position
   await gip.tracking.publish('courier-abc', -1.286389, 36.817223);

   // Get optimized route for 4 delivery stops
   const route = await gip.route.optimize(stops);

   // Listen for nearby driver updates
   gip.tracking.subscribeRegion('nairobi', ['food'], assets => { ... });
   ──────────────────────────────────────────────────────────────

   API surfaces:
     gip.route      — Route API (optimize, directions, matrix, quickETA)
     gip.tracking   — Tracking API (publish, subscribe, subscribeRegion)
     gip.geofence   — Geofence API (create, delete, check, onEvent)
     gip.fleet      — Fleet API (register, health, nearby, summary)
     gip.dispatch   — Dispatch API (create, accept, deliver, cancel, status)
     gip.heatmap    — Heatmap API (record, getLive, getHistorical)
     gip.analytics  — Analytics API (driverScore, vehicleHealth, forecast)
     gip.map        — Map API (showOn, focus, fitAll, setLayer)
     gip.alert      — Alert API (raise, resolve, subscribe)
     gip.on/off/emit — Event bus passthrough

   Exposes: window.SokoniGIPApi  +  ES default export
================================================================ */

import GIPEngine      from './sokoni-gip.js';
import DispatchEngine from './sokoni-gip-dispatch.js';
import GIPAnalytics   from './sokoni-gip-analytics.js';
import RouteEngine    from './sokoni-gip-router.js';
import FleetManager   from './sokoni-gip-fleet.js';

/* Rate limiter — prevents runaway publish loops */
function _rateLimit(fn, intervalMs) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last < intervalMs) return Promise.resolve(null);
    last = now;
    return fn.apply(this, args);
  };
}

/* ══════════════════════════════════════════════════════════════
   GIPApi
══════════════════════════════════════════════════════════════ */

export default class GIPApi {

  /**
   * @param {object} config
   * @param {string} config.module    — calling module ('food'|'rides'|'delivery'|...)
   * @param {string} config.region    — default region ('nairobi'|'mombasa'|...)
   * @param {string} [config.vehicleType] — default vehicle type for routing
   * @param {boolean} [config.cluster]    — enable marker clustering (default true)
   * @param {boolean} [config.offline]    — enable offline queue (default true)
   */
  constructor(config = {}) {
    const {
      module      = 'marketplace',
      region      = 'nairobi',
      vehicleType = 'bike',
      cluster     = true,
      offline     = true,
    } = config;

    this._module      = module;
    this._region      = region;
    this._vehicleType = vehicleType;
    this._cluster     = cluster;
    this._offline     = offline;

    this._gip        = null;
    this._dispatch   = null;
    this._analytics  = null;
    this._router     = new RouteEngine();
    this._fleet      = null;
    this._inited     = false;

    /* Throttle location publishes to max 1/sec per asset */
    this._publish = _rateLimit(this._publishRaw.bind(this), 1_000);

    /* Wire up public API sub-objects */
    this.route     = _buildRouteApi(this);
    this.tracking  = _buildTrackingApi(this);
    this.geofence  = _buildGeofenceApi(this);
    this.fleet     = _buildFleetApi(this);
    this.dispatch  = _buildDispatchApi(this);
    this.heatmap   = _buildHeatmapApi(this);
    this.analytics = _buildAnalyticsApi(this);
    this.map       = _buildMapApi(this);
    this.alert     = _buildAlertApi(this);
  }

  /* ── Lifecycle ─────────────────────────────────────────────── */

  /**
   * Initialise the GIP (must await before using other APIs).
   * @param {object} [mapConfig]
   *   @param {string} [mapConfig.containerId] — DOM element ID for the map. If omitted, no map is rendered.
   *   @param {string} [mapConfig.layer]       — initial tile layer ('dark'|'standard'|...). Default 'dark'.
   */
  async init(mapConfig = {}) {
    if (this._inited) return this;

    this._gip       = new GIPEngine();
    this._dispatch  = new DispatchEngine(this._gip);
    this._analytics = new GIPAnalytics({ region: this._region });
    this._fleet     = new FleetManager();

    if (mapConfig.containerId) {
      await this._gip.init({
        containerId: mapConfig.containerId,
        region:      this._region,
        layer:       mapConfig.layer ?? 'dark',
        modules:     [this._module],
        cluster:     this._cluster,
      });
    } else {
      /* Headless init — real-time subscriptions only, no DOM map */
      await this._gip.initHeadless({ region: this._region, modules: [this._module] });
    }

    this._inited = true;
    return this;
  }

  /** Destroy all listeners, Firestore subscriptions, and the map. */
  destroy() {
    this._gip?.destroy();
    this._dispatch?.destroy?.();
    this._analytics?.destroy?.();
    this._fleet?.destroy?.();
    this._inited = false;
  }

  /* ── Event bus passthrough ─────────────────────────────────── */

  on(event, handler)  { this._assertInited(); this._gip.on(event, handler); return this; }
  off(event, handler) { this._gip?.off(event, handler); return this; }
  emit(event, data)   { this._gip?.emit(event, data); return this; }

  /* ── Internal helpers ──────────────────────────────────────── */

  _assertInited() {
    if (!this._inited) throw new Error('[GIPApi] Call await gip.init() first.');
  }

  async _publishRaw(assetId, lat, lng, meta = {}) {
    this._assertInited();
    return this._gip.publishLocation({
      assetId,
      lat,
      lng,
      module:   this._module,
      region:   this._region,
      metadata: meta,
      ...meta,
    });
  }
}

/* ══════════════════════════════════════════════════════════════
   ROUTE API
   All callers use GIPApi.route.* — never import RouteEngine directly.
══════════════════════════════════════════════════════════════ */

function _buildRouteApi(api) {
  return {
    /**
     * Optimize a multi-stop delivery/ride route.
     * @param {Array<{lat,lng,label?,id?}>} stops
     * @param {object} [opts] — passed to RouteEngine.optimize()
     */
    optimize(stops, opts = {}) {
      return api._router.optimize(stops, {
        vehicleType: opts.vehicleType ?? api._vehicleType,
        module:      api._module,
        ...opts,
      });
    },

    /** A→B turn-by-turn. */
    directions(fromLat, fromLng, toLat, toLng, vehicleType) {
      return api._router.directions(fromLat, fromLng, toLat, toLng,
        vehicleType ?? api._vehicleType);
    },

    /** Distance + duration matrix between origins and destinations. */
    matrix(origins, destinations) {
      return api._router.distanceMatrix(origins, destinations);
    },

    /**
     * Instant ETA estimate (haversine + traffic, no OSRM call).
     * Returns { distanceKm, durationMin, eta, trafficFactor, confidence }.
     */
    quickETA(fromLat, fromLng, toLat, toLng, vehicleType, hour) {
      return api._router.quickETA(fromLat, fromLng, toLat, toLng,
        vehicleType ?? api._vehicleType, hour);
    },

    /**
     * Render an optimized route on a Leaflet map.
     * @param {L.Map}    map
     * @param {object}   routeResult — from optimize()
     * @param {object}   [styles]
     * @returns {Function} cleanup — call to remove layers
     */
    renderOnMap(map, routeResult, styles) {
      return api._router.renderOnMap(map, routeResult, styles);
    },

    /** Current hour's traffic factor (0.55 rush-hour → 1.0 free-flow). */
    trafficFactor(hour) { return RouteEngine.trafficFactor(hour); },
  };
}

/* ══════════════════════════════════════════════════════════════
   TRACKING API
══════════════════════════════════════════════════════════════ */

function _buildTrackingApi(api) {
  return {
    /**
     * Publish this device's live location.
     * Rate-limited to 1 call/second — safe to call on every GPS event.
     */
    publish(assetId, lat, lng, meta = {}) {
      return api._publish(assetId, lat, lng, meta);
    },

    /**
     * Subscribe to a single asset's location updates.
     * @returns {Function} unsubscribe
     */
    subscribe(assetId, callback) {
      api._assertInited();
      return api._gip.subscribeAsset(assetId, callback);
    },

    /**
     * Subscribe to all online assets in a region (optionally filtered by modules).
     * @param {string}   region
     * @param {string[]} modules
     * @param {Function} callback — receives assets[]
     * @returns {Function} unsubscribe
     */
    subscribeRegion(region, modules, callback) {
      api._assertInited();
      return api._gip.subscribeRegion(region, modules, callback);
    },

    /** Get current snapshot of all known assets (local cache). */
    getAssets() {
      api._assertInited();
      return api._gip.getAssets();
    },

    /** Get a single asset by ID from local cache. */
    getAsset(assetId) {
      api._assertInited();
      return api._gip.getAssets().find(a => a.assetId === assetId) ?? null;
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   GEOFENCE API
══════════════════════════════════════════════════════════════ */

function _buildGeofenceApi(api) {
  return {
    /**
     * Create a new geofence zone.
     * @param {object} zone — { name, type:'circle'|'polygon', lat?, lng?, radiusM?, coordinates?, module? }
     * @returns {Promise<string>} zoneId
     */
    create(zone) {
      api._assertInited();
      return api._gip.addGeofence({ module: api._module, ...zone });
    },

    /** Remove a geofence zone. */
    remove(zoneId) {
      api._assertInited();
      return api._gip.removeGeofence(zoneId);
    },

    /**
     * Register a handler for entry/exit events from all active zones.
     * @param {Function} handler — receives { event:'enter'|'exit', assetId, zoneId, zone, lat, lng }
     */
    onEvent(handler) {
      api._assertInited();
      api._gip.on('geofence:event', handler);
      return () => api._gip.off('geofence:event', handler);
    },

    /** Check if a coordinate is inside a named zone right now. */
    contains(zoneId, lat, lng) {
      api._assertInited();
      return api._gip.geofenceContains(zoneId, lat, lng);
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   FLEET API
══════════════════════════════════════════════════════════════ */

function _buildFleetApi(api) {
  return {
    /** Register a new asset (vehicle, driver, device). */
    register(asset) {
      api._assertInited();
      return api._fleet.register({ module: api._module, region: api._region, ...asset });
    },

    /** Update asset metadata (status, capacity, etc). */
    update(assetId, data) {
      api._assertInited();
      return api._fleet.update(assetId, data);
    },

    /**
     * Get composite health score for a vehicle.
     * @returns {Promise<{healthScore, grade, issues[], requiresAttention, requiresImmediate}>}
     */
    health(assetId) {
      api._assertInited();
      return api._fleet.health(assetId);
    },

    /**
     * Get all available assets within radiusKm of a coordinate.
     * @returns {object[]} sorted by distance
     */
    nearby(lat, lng, radiusKm = 5, type = null) {
      api._assertInited();
      const assets = api._gip.getAssets().filter(a =>
        a.status === 'available' &&
        a.isOnline &&
        (!type || a.vehicleType === type) &&
        api._router.quickETA(lat, lng, a.lat, a.lng).distanceKm <= radiusKm
      );
      return assets
        .map(a => ({
          ...a,
          distanceKm: api._router.quickETA(lat, lng, a.lat, a.lng).distanceKm,
        }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
    },

    /**
     * Fleet utilization summary for a region.
     * @returns {Promise<{total, available, busy, offline, utilization, byModule}>}
     */
    summary(region) {
      api._assertInited();
      return api._analytics.getFleetSummary(region ?? api._region);
    },

    /** Daily utilization stats for an asset. */
    dailyStats(assetId, date) {
      api._assertInited();
      return api._fleet.dailyStats(assetId, date);
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   DISPATCH API
══════════════════════════════════════════════════════════════ */

function _buildDispatchApi(api) {
  return {
    /**
     * Create and auto-dispatch a new job.
     * @param {object} job — { pickupLat, pickupLng, dropoffLat, dropoffLng, pickupAddress?, dropoffAddress?, vehicleType?, customerId? }
     * @returns {Promise<string>} jobId
     */
    create(job) {
      api._assertInited();
      return api._dispatch.dispatch({
        module: api._module,
        region: api._region,
        ...job,
      });
    },

    /** Accept a job (called by the assigned asset/driver). */
    accept(jobId, assetId) {
      api._assertInited();
      return api._dispatch.acceptJob(jobId, assetId);
    },

    /** Mark as picked up. */
    pickUp(jobId, assetId) {
      api._assertInited();
      return api._dispatch.markPickedUp(jobId, assetId);
    },

    /** Mark as delivered / completed. */
    deliver(jobId, assetId, proofUrl = null) {
      api._assertInited();
      return api._dispatch.markDelivered(jobId, assetId, proofUrl);
    },

    /** Cancel a job (admin or customer). */
    cancel(jobId, reason = '') {
      api._assertInited();
      return api._dispatch.cancelJob(jobId, reason);
    },

    /** Manually assign a specific asset to a job. */
    manualAssign(jobId, assetId) {
      api._assertInited();
      return api._dispatch.manualAssign(jobId, assetId);
    },

    /**
     * Subscribe to active jobs in a region.
     * @returns {Function} unsubscribe
     */
    subscribeActive(region, callback) {
      api._assertInited();
      return api._dispatch.watchActiveJobs(region ?? api._region, callback);
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   HEATMAP API
══════════════════════════════════════════════════════════════ */

function _buildHeatmapApi(api) {
  return {
    /**
     * Record a demand event at a coordinate (e.g., order placed, search done).
     * Calls are batched in memory and flushed every 60s.
     */
    record(lat, lng, weight = 1) {
      api._assertInited();
      return api._analytics.recordDemandEvent(lat, lng, api._module, weight);
    },

    /**
     * Render a heatmap on the map for a specific module and date.
     * @returns {Promise<void>}
     */
    async showOnMap(date, module) {
      api._assertInited();
      const points = await api._analytics.getHeatPoints(
        api._region, date, module ?? api._module, 24
      );
      api._gip.showHeatmap(module ?? api._module, points);
    },

    hideFromMap() {
      api._assertInited();
      api._gip.hideHeatmap();
    },

    /**
     * Get raw heat points (Leaflet.heat [lat, lng, weight][]).
     */
    getPoints(date, module, hours = 24) {
      api._assertInited();
      return api._analytics.getHeatPoints(api._region, date, module ?? api._module, hours);
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   ANALYTICS API
══════════════════════════════════════════════════════════════ */

function _buildAnalyticsApi(api) {
  return {
    /**
     * Composite driver performance score (0–100) across 4 dimensions.
     * @returns {Promise<{overall, safety, efficiency, reliability, rating, details}>}
     */
    driverScore(assetId, days = 30) {
      api._assertInited();
      return api._analytics.computeDriverScore(assetId, days);
    },

    /**
     * Vehicle health assessment.
     * @returns {Promise<{healthScore, grade, issues[], requiresAttention, requiresImmediate}>}
     */
    vehicleHealth(vehicleDoc) {
      api._assertInited();
      return api._analytics.computeVehicleHealth(vehicleDoc);
    },

    /** Fleet-wide summary by status and module. */
    fleetSummary(region) {
      api._assertInited();
      return api._analytics.getFleetSummary(region ?? api._region);
    },

    /**
     * Deterministic demand forecast based on historical hourly averages.
     * Returns { hour, expectedOrders, confidence }[] for each hour in the next N hours.
     */
    demandForecast(hours = 24) {
      api._assertInited();
      return api._analytics.suggestShifts(api._region, api._module, 14)
        .then(result => result.hourly?.slice(0, hours) ?? []);
    },

    /**
     * AI operational insight (batched, opt-in, calls Cloud Function).
     * Safe to call once per session — caches result for 1 hour.
     */
    aiInsight() {
      api._assertInited();
      return api._analytics.generateOpsInsight();
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   MAP API
══════════════════════════════════════════════════════════════ */

function _buildMapApi(api) {
  return {
    /** Switch tile layer ('dark'|'standard'|'satellite'|'terrain'|'light'). */
    setLayer(layer) {
      api._assertInited();
      api._gip.setLayer(layer);
    },

    /** Pan + zoom to a specific asset. */
    focusAsset(assetId) {
      api._assertInited();
      api._gip.focusAsset(assetId);
    },

    /** Fit viewport to all currently visible assets. */
    fitAll() {
      api._assertInited();
      const assets = api._gip.getAssets();
      if (!assets.length) return;
      const lls = assets.map(a => [a.lat, a.lng]);
      api._gip.getMap()?.fitBounds(L.latLngBounds(lls), { padding: [40, 40], maxZoom: 14 });
    },

    /** Get the raw Leaflet map instance (escape hatch). */
    getLeaflet() {
      api._assertInited();
      return api._gip.getMap();
    },

    /** Set which modules are visible on the map. */
    setModules(modules) {
      api._assertInited();
      api._gip.setModules(modules);
    },

    /** Show/hide heatmap overlay. */
    showHeatmap(module, points) { api._assertInited(); api._gip.showHeatmap(module, points ?? null); },
    hideHeatmap()               { api._assertInited(); api._gip.hideHeatmap(); },
  };
}

/* ══════════════════════════════════════════════════════════════
   ALERT API
══════════════════════════════════════════════════════════════ */

function _buildAlertApi(api) {
  return {
    /**
     * Raise an alert for an asset.
     * @param {string} assetId
     * @param {string} type     — 'speeding'|'sos'|'breakdown'|'geofence_breach'|'offline'
     * @param {string} message
     * @param {string} severity — 'info'|'high'|'critical'
     */
    raise(assetId, type, message, severity = 'high') {
      api._assertInited();
      return api._gip.raiseAlert({ assetId, type, message, severity, module: api._module });
    },

    /** Resolve an alert. */
    resolve(alertId) {
      api._assertInited();
      return api._gip.resolveAlert(alertId);
    },

    /**
     * Subscribe to new alerts for this module.
     * @returns {Function} unsubscribe
     */
    subscribe(callback) {
      api._assertInited();
      api._gip.on('gip:alert', alert => {
        if (!alert.module || alert.module === api._module) callback(alert);
      });
    },
  };
}

if (typeof window !== 'undefined') window.SokoniGIPApi = GIPApi;
