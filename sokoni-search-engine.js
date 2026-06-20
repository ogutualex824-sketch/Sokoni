/**
 * SOKONI Enterprise Search Engine
 * Version: 3.0.0
 *
 * Full-stack client search with:
 *   - Algolia federated multi-index search (13 indexes)
 *   - Instant search (debounced, request cancellation via AbortController)
 *   - Autocomplete with trending suggestions
 *   - Voice search (Web Speech API)
 *   - Geo search (Geolocation API)
 *   - Personalization (user history, recently viewed)
 *   - Three-layer cache: L1 (Map) → L2 (sessionStorage) → L3 (IndexedDB)
 *   - Offline fallback via IndexedDB stale-while-revalidate
 *   - Analytics event reporting (click, conversion, filter_use)
 *   - Secured API key management (auto-refresh before expiry)
 *   - Firestore fallback when Algolia is unavailable
 *   - Full progressive enhancement — works with no JS beyond basic scripts
 *
 * Usage:
 *   const engine = new SokoniSearchEngine();
 *   await engine.init();
 *   const results = await engine.search('phone', { indexes: ['sokoni_products'], filters: { category: 'Electronics' } });
 */

/* ═══════════════════════════════════════════════════════════════════════
   CONFIGURATION
════════════════════════════════════════════════════════════════════════ */

const SEARCH_CONFIG = {
  /* Injected at runtime from SOKONI_CONFIG or getAlgoliaSearchKey CF */
  algoliaAppId:   '',
  algoliaKey:     '',
  keyExpiry:      0,
  keyRefreshAt:   0, // refresh 5 min before expiry

  /* Primary indexes and their display names */
  indexes: {
    sokoni_products:   { label: 'Products',     hub: 'shopping'  },
    sokoni_shops:      { label: 'Shops',        hub: 'shops'     },
    sokoni_services:   { label: 'Services',     hub: 'services'  },
    sokoni_events:     { label: 'Events',       hub: 'events'    },
    sokoni_properties: { label: 'Properties',   hub: 'property'  },
    sokoni_vehicles:   { label: 'Vehicles',     hub: 'vehicles'  },
    sokoni_jobs:       { label: 'Jobs',         hub: 'jobs'      },
    sokoni_brands:     { label: 'Brands',       hub: 'brands'    },
    sokoni_categories: { label: 'Categories',   hub: 'all'       },
  },

  /* Default search parameters */
  defaultParams: {
    hitsPerPage:               24,
    analytics:                 true,
    clickAnalytics:            true,
    enablePersonalization:     true,
    typoTolerance:             true,
    getRankingInfo:            false,
    highlightPreTag:           '<mark>',
    highlightPostTag:          '</mark>',
    snippetEllipsisText:       '…',
    /*
     * responseFields narrows the Algolia response to only the fields we need.
     * Adding 'userData' is required for redirect rules and banner rules to work:
     * rules with consequence.userData deliver a JSON blob here (e.g. { redirect: '/page.html' }).
     * Adding 'renderingContent' enables future InstantSearch.js widget migration.
     */
    responseFields:            ['hits', 'nbHits', 'nbPages', 'page', 'facets', 'facets_stats', 'queryID', 'userData', 'renderingContent', 'abTestID', 'abTestVariantID'],
  },

  /* Fields returned per search hit — excludes heavy fields never shown in result cards */
  defaultAttributesToRetrieve: [
    'objectID', 'name', 'title', 'description', 'price', 'originalPrice', 'discountPercent',
    'thumbnail', 'images', 'category', 'subcategory', 'brand', 'hub', 'status', 'rating',
    'reviewCount', 'orderCount', 'viewCount', 'isFeatured', 'isBestseller', 'isNew', 'isOnSale',
    'inStock', 'deliveryOptions', 'condition', 'seller', 'provider', 'organizer', 'agent',
    'location', 'startDate', 'endDate', 'isFree', 'isOnline', 'salary', 'jobType', 'remote',
    'skills', 'deadline', 'listingType', 'furnished', 'bedrooms', 'bathrooms', 'sizeSqm',
    'make', 'model', 'year', 'mileage', 'fuelType', 'transmission', 'bodyType', 'color',
    'features', 'amenities', 'barcode', 'sku', 'code', 'validTo', 'discountValue',
    'createdAt', 'updatedAt', '_geoloc', 'hierarchicalCategories', 'tags', 'verified',
  ],

  /* Cache TTLs */
  l1TtlMs:    30_000,     // 30 seconds — hot results in memory
  l2TtlMs:    300_000,    // 5 minutes — session storage
  l3TtlMs:    3_600_000,  // 1 hour — IndexedDB persistent
  idbName:    'sokoni_search_cache',
  idbVersion: 3,
  idbStore:   'results',

  /* Autocomplete */
  autocompleteDebounceMsDefault: 120,
  autocompleteMaxSuggestions:    8,
  autocompleteMinChars:          1,
  autocompleteIndexes:           ['sokoni_products', 'sokoni_services', 'sokoni_jobs'],

  /* Instant search */
  instantSearchDebounceMs: 200,

  /* Voice */
  voiceLanguage: 'en-KE',

  /* Geo */
  geoRadius: 50_000, // 50 km default

  /* Analytics CF endpoint */
  analyticsEndpoint: null, // set after init
};

/* ═══════════════════════════════════════════════════════════════════════
   L1 CACHE — in-memory Map with TTL
════════════════════════════════════════════════════════════════════════ */

class L1Cache {
  constructor(ttlMs) {
    this._store = new Map();
    this._ttl   = ttlMs;
  }
  get(key) {
    const e = this._store.get(key);
    if (!e) return null;
    if (Date.now() > e.exp) { this._store.delete(key); return null; }
    return e.val;
  }
  set(key, val) {
    if (this._store.size > 2000) this._evict();
    this._store.set(key, { val, exp: Date.now() + this._ttl });
  }
  _evict() {
    const now = Date.now();
    for (const [k, e] of this._store) {
      if (now > e.exp) this._store.delete(k);
    }
    /* If still large, remove oldest 20% */
    if (this._store.size > 1600) {
      const keys = [...this._store.keys()].slice(0, 400);
      keys.forEach(k => this._store.delete(k));
    }
  }
  invalidate(prefix) {
    for (const k of this._store.keys()) {
      if (k.startsWith(prefix)) this._store.delete(k);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   L2 CACHE — sessionStorage
════════════════════════════════════════════════════════════════════════ */

class L2Cache {
  constructor(ttlMs, prefix = 'ss_') {
    this._ttl    = ttlMs;
    this._prefix = prefix;
  }
  get(key) {
    try {
      const raw = sessionStorage.getItem(this._prefix + key);
      if (!raw) return null;
      const e = JSON.parse(raw);
      if (Date.now() > e.exp) { sessionStorage.removeItem(this._prefix + key); return null; }
      return e.val;
    } catch (_) { return null; }
  }
  set(key, val) {
    try {
      sessionStorage.setItem(this._prefix + key, JSON.stringify({ val, exp: Date.now() + this._ttl }));
    } catch (_) { /* Quota exceeded — skip */ }
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   L3 CACHE — IndexedDB (persistent, stale-while-revalidate)
════════════════════════════════════════════════════════════════════════ */

class L3Cache {
  constructor(dbName, version, storeName, ttlMs) {
    this._dbName  = dbName;
    this._version = version;
    this._store   = storeName;
    this._ttl     = ttlMs;
    this._db      = null;
    this._opening = null;
  }

  async _open() {
    if (this._db) return this._db;
    if (this._opening) return this._opening;
    this._opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(this._dbName, this._version);
      req.onupgradeneeded = (e) => {
        const db    = e.target.result;
        const store = db.objectStoreNames.contains(this._store)
          ? db.transaction.objectStore(this._store)
          : db.createObjectStore(this._store, { keyPath: 'key' });
        if (!store.indexNames.contains('exp')) store.createIndex('exp', 'exp', { unique: false });
      };
      req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
      req.onerror   = (e) => reject(e.target.error);
    });
    return this._opening;
  }

  async get(key) {
    try {
      const db = await this._open();
      return new Promise((resolve) => {
        const tx  = db.transaction(this._store, 'readonly');
        const req = tx.objectStore(this._store).get(key);
        req.onsuccess = () => {
          const e = req.result;
          if (!e) return resolve(null);
          if (Date.now() > e.exp) return resolve({ stale: true, val: e.val });
          resolve({ stale: false, val: e.val });
        };
        req.onerror = () => resolve(null);
      });
    } catch (_) { return null; }
  }

  async set(key, val) {
    try {
      const db = await this._open();
      return new Promise((resolve) => {
        const tx  = db.transaction(this._store, 'readwrite');
        const req = tx.objectStore(this._store).put({ key, val, exp: Date.now() + this._ttl, ts: Date.now() });
        req.onsuccess = () => resolve();
        req.onerror   = () => resolve();
      });
    } catch (_) {}
  }

  async cleanup() {
    try {
      const db = await this._open();
      const tx    = db.transaction(this._store, 'readwrite');
      const store = tx.objectStore(this._store);
      const idx   = store.index('exp');
      const range = IDBKeyRange.upperBound(Date.now());
      idx.openCursor(range).onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    } catch (_) {}
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   RECENTLY VIEWED — localStorage ring buffer (last 50 items)
════════════════════════════════════════════════════════════════════════ */

class RecentlyViewed {
  constructor() { this._key = 'sokoni_rv'; }
  add(item) {
    try {
      const list = this.get();
      const next = [item, ...list.filter(i => i.id !== item.id)].slice(0, 50);
      localStorage.setItem(this._key, JSON.stringify(next));
    } catch (_) {}
  }
  get(limit = 20) {
    try { return JSON.parse(localStorage.getItem(this._key) || '[]').slice(0, limit); }
    catch (_) { return []; }
  }
  clear() { try { localStorage.removeItem(this._key); } catch (_) {} }
}

/* ═══════════════════════════════════════════════════════════════════════
   SEARCH HISTORY — localStorage ring buffer (last 20 queries)
════════════════════════════════════════════════════════════════════════ */

class SearchHistory {
  constructor() { this._key = 'sokoni_sh'; }
  add(query) {
    if (!query || query.length < 2) return;
    try {
      const list = this.get();
      const next = [query, ...list.filter(q => q !== query)].slice(0, 20);
      localStorage.setItem(this._key, JSON.stringify(next));
    } catch (_) {}
  }
  get(limit = 5) {
    try { return JSON.parse(localStorage.getItem(this._key) || '[]').slice(0, limit); }
    catch (_) { return []; }
  }
  remove(query) {
    try {
      const list = this.get(20).filter(q => q !== query);
      localStorage.setItem(this._key, JSON.stringify(list));
    } catch (_) {}
  }
  clear() { try { localStorage.removeItem(this._key); } catch (_) {} }
}

/* ═══════════════════════════════════════════════════════════════════════
   ALGOLIA HTTP CLIENT (browser-safe)
════════════════════════════════════════════════════════════════════════ */

class AlgoliaBrowserClient {
  constructor(appId, searchKey) {
    this.appId      = appId;
    this.searchKey  = searchKey;
    this._dsn       = `https://${appId}-dsn.algolia.net`;
    this._fallback1 = `https://${appId}-1.algolianet.com`;
    this._fallback2 = `https://${appId}-2.algolianet.com`;
  }

  updateKey(newKey) { this.searchKey = newKey; }

  _headers() {
    return {
      'X-Algolia-Application-Id': this.appId,
      'X-Algolia-API-Key':        this.searchKey,
      'Content-Type':             'application/json',
    };
  }

  /**
   * Multi-index federated search.
   * @param {Array<{ indexName, params }>} queries
   * @param {AbortSignal} signal
   */
  async multiSearch(queries, signal) {
    const hosts = [this._dsn, this._fallback1, this._fallback2];
    const body  = JSON.stringify({ requests: queries });

    for (const host of hosts) {
      try {
        const res = await fetch(`${host}/1/indexes/*/queries`, {
          method:  'POST',
          headers: this._headers(),
          body,
          signal,
        });
        if (!res.ok) {
          if (res.status >= 400 && res.status < 500) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Algolia ${res.status}`);
          }
          continue; /* 5xx — try next host */
        }
        return res.json();
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        if (hosts.indexOf(host) === hosts.length - 1) throw err;
        /* Try next host */
      }
    }
  }

  /**
   * Single-index search.
   */
  async search(indexName, params, signal) {
    const { results } = await this.multiSearch([{ indexName, params }], signal);
    return results[0];
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   VOICE SEARCH
════════════════════════════════════════════════════════════════════════ */

class VoiceSearch {
  constructor(onResult, onError, onStateChange) {
    this._onResult      = onResult;
    this._onError       = onError;
    this._onStateChange = onStateChange;
    this._recognition   = null;
    this._active        = false;
  }

  isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start() {
    if (!this.isSupported() || this._active) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r  = new SR();
    r.lang           = SEARCH_CONFIG.voiceLanguage;
    r.continuous     = false;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart  = () => { this._active = true;  this._onStateChange('listening'); };
    r.onend    = () => { this._active = false; this._onStateChange('idle'); };
    r.onerror  = (e) => { this._active = false; this._onError(e.error); this._onStateChange('idle'); };

    r.onresult = (event) => {
      let interim = '', final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += t;
        else interim += t;
      }
      if (final) this._onResult(final.trim(), true);
      else if (interim) this._onResult(interim.trim(), false);
    };

    this._recognition = r;
    r.start();
  }

  stop() {
    if (this._recognition && this._active) this._recognition.stop();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   ALGOLIA INSIGHTS BROWSER CLIENT
   Batches up to 20 events, flushes after 100ms idle or on page unload.
   Sends directly to insights.algolia.io — no npm dependency.
════════════════════════════════════════════════════════════════════════ */

class AlgoliaInsightsBrowser {
  constructor(appId, apiKey) {
    this._appId   = appId;
    this._apiKey  = apiKey;
    this._host    = 'insights.algolia.io';
    this._queue   = [];
    this._timer   = null;

    /* Flush on page hide (covers tab close, navigation, background) */
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this._flush();
      });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this._flush(), { once: false });
    }
  }

  _flush() {
    if (!this._queue.length || !this._appId || !this._apiKey) return;
    const events = this._queue.splice(0);
    clearTimeout(this._timer);
    /* Use `keepalive: true` so the request survives page unload */
    fetch(`https://${this._host}/1/events`, {
      method:    'POST',
      headers: {
        'X-Algolia-Application-Id': this._appId,
        'X-Algolia-API-Key':        this._apiKey,
        'Content-Type':             'application/json',
      },
      body:      JSON.stringify({ events }),
      keepalive: true,
    }).catch(() => {}); // intentionally silent — analytics must never break UI
  }

  /** Queue an event for batched sending */
  sendEvent(ev) {
    if (!this._appId) return;
    this._queue.push({ timestamp: Date.now(), ...ev });
    clearTimeout(this._timer);
    if (this._queue.length >= 20) this._flush();
    else this._timer = setTimeout(() => this._flush(), 100);
  }

  /* ── Typed helpers matching Algolia Insights spec ─────────────────── */

  viewedObjectIDs(index, eventName, objectIDs, userToken) {
    this.sendEvent({ eventType: 'view', eventName, index, userToken, objectIDs });
  }

  viewedFilters(index, eventName, filters, userToken) {
    this.sendEvent({ eventType: 'view', eventName, index, userToken, filters });
  }

  clickedObjectIDsAfterSearch(index, eventName, objectIDs, positions, queryID, userToken) {
    this.sendEvent({ eventType: 'click', eventName, index, userToken, queryID, objectIDs, positions });
  }

  clickedObjectIDs(index, eventName, objectIDs, userToken) {
    this.sendEvent({ eventType: 'click', eventName, index, userToken, objectIDs });
  }

  clickedFilters(index, eventName, filters, userToken) {
    this.sendEvent({ eventType: 'click', eventName, index, userToken, filters });
  }

  convertedObjectIDsAfterSearch(index, eventName, objectIDs, queryID, userToken) {
    this.sendEvent({ eventType: 'conversion', eventName, index, userToken, queryID, objectIDs });
  }

  addedToCartObjectIDs(index, eventName, objectIDs, userToken, objectData, currency = 'KES', value) {
    const ev = { eventType: 'conversion', eventSubtype: 'addToCart', eventName, index, userToken, objectIDs, currency };
    if (objectData) ev.objectData = objectData;
    if (value !== undefined) ev.value = value;
    this.sendEvent(ev);
  }

  addedToCartObjectIDsAfterSearch(index, eventName, objectIDs, queryID, userToken, objectData, currency = 'KES', value) {
    const ev = { eventType: 'conversion', eventSubtype: 'addToCart', eventName, index, userToken, queryID, objectIDs, currency };
    if (objectData) ev.objectData = objectData;
    if (value !== undefined) ev.value = value;
    this.sendEvent(ev);
  }

  purchasedObjectIDs(index, eventName, objectIDs, userToken, objectData, value, currency = 'KES') {
    const ev = { eventType: 'conversion', eventSubtype: 'purchase', eventName, index, userToken, objectIDs, currency };
    if (objectData) ev.objectData = objectData;
    if (value !== undefined) ev.value = value;
    this.sendEvent(ev);
  }

  purchasedObjectIDsAfterSearch(index, eventName, objectIDs, queryID, userToken, objectData, value, currency = 'KES') {
    const ev = { eventType: 'conversion', eventSubtype: 'purchase', eventName, index, userToken, queryID, objectIDs, currency };
    if (objectData) ev.objectData = objectData;
    if (value !== undefined) ev.value = value;
    this.sendEvent(ev);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   GEO SEARCH
════════════════════════════════════════════════════════════════════════ */

class GeoSearch {
  constructor() {
    this._coords    = null;
    this._watching  = false;
    this._watcherId = null;
  }

  async requestLocation() {
    if (!navigator.geolocation) return null;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        pos => {
          this._coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          resolve(this._coords);
        },
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 }
      );
    });
  }

  getAroundLatLng() {
    if (!this._coords) return null;
    return `${this._coords.lat},${this._coords.lng}`;
  }

  get coords() { return this._coords; }
}

/* ═══════════════════════════════════════════════════════════════════════
   MAIN SEARCH ENGINE
════════════════════════════════════════════════════════════════════════ */

class SokoniSearchEngine {
  constructor() {
    this._l1          = new L1Cache(SEARCH_CONFIG.l1TtlMs);
    this._l2          = new L2Cache(SEARCH_CONFIG.l2TtlMs, 'sok_s2_');
    this._l3          = new L3Cache(
      SEARCH_CONFIG.idbName,
      SEARCH_CONFIG.idbVersion,
      SEARCH_CONFIG.idbStore,
      SEARCH_CONFIG.l3TtlMs
    );
    this._history     = new SearchHistory();
    this._rv          = new RecentlyViewed();
    this._geo         = new GeoSearch();
    this._voice       = null;
    this._algolia     = null;
    this._insights    = null;   // AlgoliaInsightsBrowser — initialized post-key-fetch
    this._controllers = new Map(); // key → AbortController
    this._initialized = false;
    this._initPromise = null;
    this._keyRefreshTimer = null;
    this._listeners   = {}; // event → [fn]
    /* A/B test variant assigned per session */
    this._abVariant   = null;
  }

  /* ── Initialization ────────────────────────────────────────────────── */

  async init() {
    if (this._initialized) return this;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    try {
      await this._initAlgoliaKey();
      /* Kick off L3 cleanup in background */
      this._l3.cleanup().catch(() => {});
      this._initialized = true;
    } catch (err) {
      console.warn('[SearchEngine] Init warning:', err.message);
      this._initialized = true; // still init — will use fallback
    }
    return this;
  }

  async _initAlgoliaKey() {
    const cfg = window.SOKONI_CONFIG || {};

    /* If config has keys already, use them */
    if (cfg.algoliaAppId && cfg.algoliaSearchKey) {
      this._algolia = new AlgoliaBrowserClient(cfg.algoliaAppId, cfg.algoliaSearchKey);
      SEARCH_CONFIG.algoliaAppId = cfg.algoliaAppId;
      return;
    }

    /* Otherwise get scoped key from Cloud Function */
    await this._refreshSecuredKey();
  }

  async _refreshSecuredKey() {
    try {
      if (typeof firebase === 'undefined') return;
      const fn    = firebase.functions().httpsCallable('getAlgoliaSearchKey');
      const res   = await fn({});
      const data  = res.data;

      if (data.degraded || !data.key) return; // fallback mode

      SEARCH_CONFIG.algoliaAppId  = data.appId;
      SEARCH_CONFIG.algoliaKey    = data.key;
      SEARCH_CONFIG.keyExpiry     = data.validUntil * 1000;
      SEARCH_CONFIG.keyRefreshAt  = SEARCH_CONFIG.keyExpiry - 5 * 60 * 1000;

      if (this._algolia) {
        this._algolia.updateKey(data.key);
      } else {
        this._algolia = new AlgoliaBrowserClient(data.appId, data.key);
      }

      /* Initialize Insights browser client using the search key */
      if (!this._insights) {
        this._insights = new AlgoliaInsightsBrowser(data.appId, data.key);
      }

      /* A/B test variant: assign session-sticky variant if not yet assigned */
      if (!this._abVariant) {
        this._abVariant = Math.random() < 0.5 ? 'A' : 'B';
        try { localStorage.setItem('sokoni_ab', this._abVariant); } catch (_) {}
      }

      /* Schedule key refresh */
      const msUntilRefresh = Math.max(SEARCH_CONFIG.keyRefreshAt - Date.now(), 30_000);
      clearTimeout(this._keyRefreshTimer);
      this._keyRefreshTimer = setTimeout(() => this._refreshSecuredKey(), msUntilRefresh);
    } catch (err) {
      console.warn('[SearchEngine] Key refresh failed:', err.message);
    }
  }

  /* ── Core Search ───────────────────────────────────────────────────── */

  /**
   * Federated search across multiple indexes.
   * @param {string} query
   * @param {object} opts
   *   indexes:     string[]       — subset of indexes to query (default: all)
   *   filters:     object         — { category: 'X', price_min: 100 }
   *   facets:      string[]       — facets to retrieve
   *   page:        number         — 0-based page
   *   hitsPerPage: number
   *   aroundLatLng: string        — "lat,lng" for geo search
   *   aroundRadius: number        — meters
   *   sortIndex:   string         — replica index name for sorted results
   *   userToken:   string         — for personalization
   *   bypassCache: bool
   * @returns {Promise<{ results: { [indexName]: AlgoliaResult }, queryID: string, cached: bool }>}
   */
  async search(query, opts = {}) {
    await this.init();

    const q = (query || '').trim();
    const {
      indexes       = Object.keys(SEARCH_CONFIG.indexes),
      filters       = {},
      facets        = [],
      page          = 0,
      hitsPerPage   = SEARCH_CONFIG.defaultParams.hitsPerPage,
      aroundLatLng  = null,
      aroundRadius  = SEARCH_CONFIG.geoRadius,
      sortIndex     = null,
      userToken     = null,
      bypassCache   = false,
    } = opts;

    const cacheKey = `s:${JSON.stringify({ q, indexes, filters, page, hitsPerPage, aroundLatLng, sortIndex })}`;

    /* L1 cache */
    if (!bypassCache) {
      const l1 = this._l1.get(cacheKey);
      if (l1) return { ...l1, cached: 'L1' };
    }

    /* L2 cache */
    if (!bypassCache) {
      const l2 = this._l2.get(cacheKey);
      if (l2) {
        this._l1.set(cacheKey, l2);
        return { ...l2, cached: 'L2' };
      }
    }

    /* L3 cache (stale-while-revalidate) */
    if (!bypassCache) {
      const l3 = await this._l3.get(cacheKey);
      if (l3) {
        if (!l3.stale) {
          this._l1.set(cacheKey, l3.val);
          return { ...l3.val, cached: 'L3' };
        }
        /* Stale — return immediately and revalidate in background */
        this._fetchAndCache(q, opts, cacheKey).catch(() => {});
        return { ...l3.val, cached: 'L3-stale' };
      }
    }

    return this._fetchAndCache(q, opts, cacheKey);
  }

  async _fetchAndCache(query, opts, cacheKey) {
    const result = await this._fetch(query, opts);
    this._l1.set(cacheKey, result);
    this._l2.set(cacheKey, result);
    this._l3.set(cacheKey, result).catch(() => {});
    return { ...result, cached: false };
  }

  async _fetch(query, opts) {
    const {
      indexes, filters, facets, page, hitsPerPage,
      aroundLatLng, aroundRadius, sortIndex, userToken,
      optionalFilters,       // personalization boosts
      neuralSearch,          // enable Algolia NeuralSearch (AI query understanding)
      hybridSearch,          // enable hybrid: keyword + neural blended
      enableReRanking,       // Dynamic Re-Ranking (defaults true)
      personalizationImpact, // 0-100, default 75
      optionalWords,         // words that are optional in the query
      ruleContexts: callerRuleContexts, // caller may override context
    } = opts;

    const resolvedUserToken  = userToken || this.getUserToken();
    const filterStr          = this._buildFilterString(filters);
    /* Detect page context for context-aware Algolia Rules */
    const pageContexts       = callerRuleContexts || this._detectPageContext();

    /* Build per-index query objects */
    const queries = indexes.map(indexName => {
      const targetIndex = sortIndex && indexName === indexes[0] ? sortIndex : indexName;
      const params = {
        ...SEARCH_CONFIG.defaultParams,
        query,
        page,
        hitsPerPage:            Math.max(Math.floor(hitsPerPage / indexes.length), 1),
        filters:                filterStr || undefined,
        facets:                 facets.length ? facets : undefined,
        /* Reduce payload — only retrieve fields the UI needs */
        attributesToRetrieve:   SEARCH_CONFIG.defaultAttributesToRetrieve,
        /* Geo */
        ...(aroundLatLng ? { aroundLatLng, aroundRadius } : {}),
        /* Personalization — userToken must always be set for Algolia to build a profile */
        userToken:              resolvedUserToken,
        enablePersonalization:  true,
        personalizationImpact:  personalizationImpact ?? 75,
        /* Click analytics — enables queryID for Insights attribution */
        analytics:              true,
        clickAnalytics:         true,
        /* Dynamic Re-Ranking — Algolia AI re-sorts based on conversion signals */
        enableReRanking:        enableReRanking !== false,
        /* Analytics tags for A/B test segmentation */
        analyticsTags:          this._abVariant ? [`ab_${this._abVariant}`] : undefined,
        /* Rule contexts — triggers context-aware merchandising rules */
        ...(pageContexts.length ? { ruleContexts: pageContexts } : {}),
        /* Optional boost filters (personalization signals from user profile) */
        ...(optionalFilters ? { optionalFilters } : {}),
        /* Optional words — specified words are not required for a match */
        ...(optionalWords ? { optionalWords } : {}),
        /* Neural / Hybrid Search parameters */
        ...(neuralSearch ? { mode: 'neuralSearch' }                     : {}),
        ...(hybridSearch  ? { mode: 'hybridSearch', hybridSearch: true } : {}),
      };
      return { indexName: targetIndex, params };
    });

    /* Cancel any in-flight request for the same search key */
    const ck = 'search';
    if (this._controllers.has(ck)) this._controllers.get(ck).abort();
    const ac = new AbortController();
    this._controllers.set(ck, ac);

    try {
      if (this._algolia && SEARCH_CONFIG.algoliaAppId) {
        const raw = await this._algolia.multiSearch(queries, ac.signal);
        const out = {};
        let   globalRedirect = null;
        let   globalUserData = null;

        raw.results.forEach((res, i) => {
          out[indexes[i]] = res;

          /* Capture A/B test data from first result that has it */
          if (res.abTestID && !this._lastAbTestID) {
            this._lastAbTestID        = res.abTestID;
            this._lastAbTestVariantID = res.abTestVariantID;
          }

          /* Collect userData from rules (redirect, banners, badges) */
          if (res.userData && !globalUserData) {
            globalUserData = res.userData;
            if (res.userData.redirect && !globalRedirect) {
              globalRedirect = res.userData.redirect;
            }
          }
        });

        this._controllers.delete(ck);
        if (query) this._history.add(query);

        /* Fire redirect event if a Rule set consequence.userData.redirect */
        if (globalRedirect) {
          this._emit('redirect', { url: globalRedirect, query });
        }

        /* Record the search event */
        const totalHits = raw.results.reduce((s, r) => s + (r.nbHits || 0), 0);
        if (query && totalHits === 0) {
          this._recordAnalyticsEvent({ type: 'no_results', query, indexName: indexes[0], resultCount: 0 });
        }

        return {
          results:            out,
          totalHits,
          userToken:          resolvedUserToken,
          userData:           globalUserData || null,
          abTestID:           this._lastAbTestID || null,
          abTestVariantID:    this._lastAbTestVariantID || null,
          ruleContexts:       pageContexts,
        };
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('[SearchEngine] Algolia failed, using Firestore fallback:', err.message);
    }

    /* Firestore fallback */
    return this._firestoreFallback(query, opts);
  }

  /**
   * Detect the current page context for Algolia Rules.
   * Returns up to 3 context strings that Rules can use in their conditions.
   * These match context strings defined in the CONTEXT_RULES in algolia-admin.js.
   */
  _detectPageContext() {
    if (typeof window === 'undefined') return [];
    const path     = window.location.pathname.toLowerCase();
    const search   = window.location.search.toLowerCase();
    const contexts = [];

    /* Page-level context */
    if (path === '/' || path === '/index.html') contexts.push('homepage');

    /* Hub context from URL path or query param */
    const hubMatch = path.match(/\/(food|marketplace|services|events|property|vehicles|jobs|health|education|entertainment)/) ||
                     search.match(/hub=(food|marketplace|services|events|property|vehicles|jobs|health|education|entertainment)/);
    if (hubMatch) contexts.push(`hub_${hubMatch[1]}`);

    /* User state context
       Support both Firebase v9 modular SDK and v8 compat layer.
       Falls back to checking the SOKONI session flag set by auth.js. */
    try {
      let isSignedIn = false;
      /* v9 modular: firebase/auth exports getAuth().currentUser */
      if (typeof window.__sokoniCurrentUid !== 'undefined') {
        isSignedIn = !!window.__sokoniCurrentUid;
      } else if (window._firebaseAuth?.currentUser) {
        /* v8 compat layer sets firebase.auth().currentUser */
        isSignedIn = true;
      } else if (window.firebase?.auth?.()?.currentUser) {
        /* Legacy compat: firebase.auth() function form */
        isSignedIn = true;
      }
      if (!isSignedIn) contexts.push('user_guest');
    } catch (_) {
      contexts.push('user_guest');
    }

    return contexts;
  }

  /** Internal: fire analytics event to Cloud Function (non-blocking) */
  _recordAnalyticsEvent(payload) {
    if (typeof firebase === 'undefined') return;
    try {
      firebase.functions().httpsCallable('recordSearchEvent')(payload).catch(() => {});
    } catch (_) {}
  }

  /* ── Instant Search ────────────────────────────────────────────────── */

  /**
   * Debounced instant search — call on every keystroke.
   * @param {string} query
   * @param {object} opts
   * @param {function} callback  - called with results
   * @param {number}   delay     - debounce ms (default 200)
   */
  instantSearch(query, opts, callback, delay = SEARCH_CONFIG.instantSearchDebounceMs) {
    clearTimeout(this._instantTimer);
    if (!query || query.length < 1) {
      callback({ results: {}, totalHits: 0, empty: true });
      return;
    }
    this._instantTimer = setTimeout(async () => {
      try {
        const res = await this.search(query, { ...opts, hitsPerPage: 5 });
        callback(res);
      } catch (err) {
        if (err.name !== 'AbortError') callback({ error: err.message, results: {}, totalHits: 0 });
      }
    }, delay);
  }

  /* ── Autocomplete ──────────────────────────────────────────────────── */

  /**
   * Autocomplete suggestions: search history + trending + Algolia prefix search.
   * @param {string} query
   * @returns {Promise<{ suggestions: Array<{ type, label, icon, data }> }>}
   */
  async autocomplete(query, opts = {}) {
    await this.init();
    const q = (query || '').trim();

    const suggestions = [];

    /* 1. Search history */
    if (q.length === 0) {
      const history = this._history.get(5);
      history.forEach(h => suggestions.push({ type: 'history', label: h, icon: 'clock' }));
    }

    /* 2. Recently viewed */
    if (q.length === 0) {
      const rv = this._rv.get(3);
      rv.forEach(item => suggestions.push({ type: 'recent', label: item.name, icon: 'eye', data: item }));
    }

    /* 3. Trending (no query) */
    if (q.length === 0 || q.length < 2) {
      const trending = await this._getTrendingQueries();
      trending.slice(0, 4).forEach(t => suggestions.push({ type: 'trending', label: t.query, icon: 'fire', data: t }));
    }

    if (q.length >= SEARCH_CONFIG.autocompleteMinChars) {
      /* 4. History prefix match */
      const histMatch = this._history.get(20).filter(h => h.toLowerCase().startsWith(q.toLowerCase()));
      histMatch.slice(0, 3).forEach(h => {
        if (!suggestions.find(s => s.label === h)) {
          suggestions.unshift({ type: 'history', label: h, icon: 'clock' });
        }
      });

      /* 5. Query Suggestions index — trained by Algolia on real search analytics */
      if (q.length >= 2) {
        try {
          const qsKey = `qs:${q}:${opts.hub || ''}`;
          let qsHits  = this._l1.get(qsKey) || this._l2.get(qsKey);

          if (!qsHits && this._algolia) {
            const qsIndexName = opts.qsIndex || 'sokoni_products_suggestions';
            const qsRes = await this._algolia.search(qsIndexName, {
              query:                 q,
              hitsPerPage:           5,
              analytics:             false,
              attributesToRetrieve:  ['query', 'nb_words', 'popularity'],
              highlightPreTag:       '<mark>',
              highlightPostTag:      '</mark>',
            });
            qsHits = qsRes.hits || [];
            this._l1.set(qsKey, qsHits);
            this._l2.set(qsKey, qsHits);
          }

          if (qsHits) {
            qsHits.slice(0, 4).forEach(hit => {
              if (!suggestions.find(s => s.label === hit.query)) {
                suggestions.push({
                  type:     'query-suggestion',
                  label:    hit._highlightResult?.query?.value || hit.query,
                  rawLabel: hit.query,
                  icon:     'search',
                  data:     hit,
                });
              }
            });
          }
        } catch (_) {}
      }

      /* 6. Algolia multi-index prefix autocomplete for actual result hits */
      try {
        const acKey = `ac:${q}`;
        let acRes = this._l1.get(acKey);
        if (!acRes) {
          const l2 = this._l2.get(acKey);
          if (l2) { acRes = l2; this._l1.set(acKey, l2); }
        }

        if (!acRes && this._algolia) {
          if (this._controllers.has('ac')) this._controllers.get('ac').abort();
          const ac = new AbortController();
          this._controllers.set('ac', ac);

          const indexes = opts.indexes || SEARCH_CONFIG.autocompleteIndexes;
          const queries = indexes.map(indexName => ({
            indexName,
            params: {
              query:                 q,
              hitsPerPage:           3,
              attributesToRetrieve:  ['name', 'title', 'category', 'thumbnail', 'price'],
              highlightPreTag:       '<mark>',
              highlightPostTag:      '</mark>',
              analytics:             false,
              clickAnalytics:        false,
              enablePersonalization: true,
              userToken:             this.getUserToken(),
            },
          }));

          const raw = await this._algolia.multiSearch(queries, ac.signal);
          acRes = raw.results.map((r, i) => ({ index: indexes[i], hits: r.hits || [] }));
          this._l1.set(acKey, acRes);
          this._l2.set(acKey, acRes);
        }

        if (acRes) {
          for (const { index, hits } of acRes) {
            hits.slice(0, 2).forEach(hit => {
              suggestions.push({
                type:      'result',
                label:     hit._highlightResult?.name?.value || hit._highlightResult?.title?.value || hit.name || hit.title || '',
                icon:      'search',
                thumbnail: hit.thumbnail || null,
                price:     hit.price || null,
                index,
                objectID:  hit.objectID,
                data:      hit,
              });
            });
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') console.warn('[SearchEngine] Autocomplete error:', err.message);
      }

      /* 7. Category suggestions */
      if (q.length >= 3) {
        const cats = await this._searchCategories(q);
        cats.slice(0, 2).forEach(c => suggestions.push({ type: 'category', label: c.name, icon: 'grid', data: c }));
      }
    }

    return {
      suggestions: suggestions.slice(0, SEARCH_CONFIG.autocompleteMaxSuggestions),
      query: q,
    };
  }

  /* ── Voice Search ──────────────────────────────────────────────────── */

  initVoice(onResult, onError, onStateChange) {
    this._voice = new VoiceSearch(onResult, onError, onStateChange || (() => {}));
    return this._voice.isSupported();
  }

  startVoice() { this._voice?.start(); }
  stopVoice()  { this._voice?.stop(); }

  /* ── Geo Search ────────────────────────────────────────────────────── */

  async enableGeo() {
    const coords = await this._geo.requestLocation();
    return coords;
  }

  get geoCoords() { return this._geo.coords; }

  geoSearch(query, opts = {}) {
    const latLng = this._geo.getAroundLatLng();
    if (!latLng) return this.search(query, opts);
    return this.search(query, { ...opts, aroundLatLng: latLng, aroundRadius: opts.radius || SEARCH_CONFIG.geoRadius });
  }

  /* ══════════════════════════════════════════════════════════════════════
     ANALYTICS — Full Algolia Insights event suite
     Each method fires:
       1. Direct browser-side Insights via AlgoliaInsightsBrowser (sub-100ms)
       2. Async CF call for Firestore logging + server-side Insights (durable)
  ══════════════════════════════════════════════════════════════════════ */

  /** Product clicked from search results — the most common Insights event */
  trackClick({ indexName, objectID, queryID, position, userToken }) {
    const ut = userToken || this.getUserToken();
    /* Browser Insights — fast path */
    if (this._insights) {
      if (queryID) {
        this._insights.clickedObjectIDsAfterSearch(indexName, 'Product Clicked', [objectID], [position || 1], queryID, ut);
      } else {
        this._insights.clickedObjectIDs(indexName, 'Product Clicked', [objectID], ut);
      }
    }
    /* Server path — durable */
    this._recordAnalyticsEvent({ type: 'click', indexName, objectIDs: [objectID], queryID, positions: [position || 1], userToken: ut });
  }

  /** Item viewed (called when item card enters viewport or detail page opens) */
  trackView(item, { queryID } = {}) {
    /* Add to recently viewed ring buffer */
    this._rv.add({
      id:        item.id || item.objectID,
      name:      item.name || item.title,
      thumbnail: item.thumbnail,
      price:     item.price,
      url:       item.url,
      index:     item.index || 'sokoni_products',
      ts:        Date.now(),
    });

    /* Insights view event */
    const indexName = item.index || 'sokoni_products';
    const ut        = this.getUserToken();
    if (this._insights) {
      this._insights.viewedObjectIDs(indexName, 'Objects Viewed', [item.id || item.objectID], ut);
    }
    this._recordAnalyticsEvent({ type: 'view', indexName, objectIDs: [item.id || item.objectID], queryID: queryID || null, userToken: ut });
  }

  /** Product added to cart — strong conversion signal */
  trackAddToCart({ indexName = 'sokoni_products', objectID, queryID, price, quantity = 1, userToken }) {
    const ut         = userToken || this.getUserToken();
    const objectData = price ? [{ price, quantity, discount: 0 }] : undefined;
    const value      = price ? price * quantity : undefined;

    if (this._insights) {
      if (queryID) {
        this._insights.addedToCartObjectIDsAfterSearch(indexName, 'Product Added To Cart After Search', [objectID], queryID, ut, objectData, 'KES', value);
      } else {
        this._insights.addedToCartObjectIDs(indexName, 'Product Added To Cart', [objectID], ut, objectData, 'KES', value);
      }
    }
    this._recordAnalyticsEvent({ type: 'add_to_cart', indexName, objectIDs: [objectID], queryID: queryID || null, userToken: ut, currency: 'KES', value, objectData });
  }

  /** Purchase completed — highest-weight conversion signal */
  trackPurchase({ indexName = 'sokoni_products', objectIDs, queryID, totalValue, items, userToken }) {
    const ut         = userToken || this.getUserToken();
    const objectData = items?.map(item => ({ price: item.price, quantity: item.quantity || 1, discount: item.discount || 0 }));

    if (this._insights) {
      if (queryID) {
        this._insights.purchasedObjectIDsAfterSearch(indexName, 'Product Purchased After Search', objectIDs, queryID, ut, objectData, totalValue, 'KES');
      } else {
        this._insights.purchasedObjectIDs(indexName, 'Product Purchased', objectIDs, ut, objectData, totalValue, 'KES');
      }
    }
    this._recordAnalyticsEvent({ type: 'purchase', indexName, objectIDs, queryID: queryID || null, userToken: ut, currency: 'KES', value: totalValue, objectData });
  }

  /** Legacy: purchase alias kept for backward-compatibility */
  trackConversion({ indexName, objectIDs, queryID, userToken }) {
    return this.trackPurchase({ indexName, objectIDs, queryID, userToken });
  }

  /** Filter clicked by user */
  trackFilterClick({ indexName = 'sokoni_products', filters, userToken }) {
    const ut      = this.getUserToken() || userToken;
    const filters_ = Array.isArray(filters) ? filters : Object.entries(filters || {}).map(([k, v]) => `${k}:${v}`);
    if (this._insights) {
      this._insights.clickedFilters(indexName, 'Filter Clicked', filters_, ut);
    }
    this._recordAnalyticsEvent({ type: 'clicked_filters', indexName, filters, userToken: ut });
  }

  /** Filter viewed (search page loaded with active filter) */
  trackFilterView({ indexName = 'sokoni_products', filters, userToken }) {
    const ut      = this.getUserToken() || userToken;
    const filters_ = Array.isArray(filters) ? filters : Object.entries(filters || {}).map(([k, v]) => `${k}:${v}`);
    if (this._insights) {
      this._insights.viewedFilters(indexName, 'Filters Viewed', filters_, ut);
    }
  }

  /** Legacy filter-use alias */
  trackFilterUse({ filters, query, indexName }) {
    return this.trackFilterClick({ indexName: indexName || 'sokoni_products', filters });
  }

  getRecentlyViewed(limit) { return this._rv.get(limit); }

  /* ── Personalization ───────────────────────────────────────────────── */

  getUserToken() {
    try {
      let t = localStorage.getItem('sokoni_ut');
      if (!t) {
        t = 'u_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('sokoni_ut', t);
      }
      return t;
    } catch (_) { return 'anonymous'; }
  }

  /** Fetch this user's Algolia personalization profile (requires sign-in) */
  async getPersonalizationProfile() {
    if (typeof firebase === 'undefined') return null;
    try {
      const fn  = firebase.functions().httpsCallable('getAlgoliaUserProfile');
      const res = await fn({});
      return res.data?.profile || null;
    } catch (_) { return null; }
  }

  /* ══════════════════════════════════════════════════════════════════════
     RECOMMEND API — FBT, Related, Trending, LookingSimilar
  ══════════════════════════════════════════════════════════════════════ */

  async getFBT(objectID, indexName = 'sokoni_products', limit = 6) {
    const cacheKey = `fbt:${indexName}:${objectID}:${limit}`;
    const l1 = this._l1.get(cacheKey);
    if (l1) return l1;
    try {
      if (typeof firebase !== 'undefined') {
        const fn  = firebase.functions().httpsCallable('getAlgoliaFBT');
        const res = await fn({ objectID, indexName, maxRecommendations: limit });
        const hits = res.data?.results?.[0]?.hits || [];
        this._l1.set(cacheKey, hits);
        return hits;
      }
    } catch (_) {}
    return [];
  }

  async getRelatedItems(objectID, indexName = 'sokoni_products', limit = 8) {
    const cacheKey = `rel:${indexName}:${objectID}:${limit}`;
    const l1 = this._l1.get(cacheKey);
    if (l1) return l1;
    try {
      if (typeof firebase !== 'undefined') {
        const fn  = firebase.functions().httpsCallable('getAlgoliaRelated');
        const res = await fn({ objectID, indexName, maxRecommendations: limit });
        const hits = res.data?.results?.[0]?.hits || [];
        this._l1.set(cacheKey, hits);
        return hits;
      }
    } catch (_) {}
    return [];
  }

  async getTrendingItems(indexName = 'sokoni_products', limit = 12, facetName, facetValue) {
    const cacheKey = `trnd:${indexName}:${limit}:${facetName || ''}:${facetValue || ''}`;
    const l1 = this._l1.get(cacheKey) || this._l2.get(cacheKey);
    if (l1) return l1;
    try {
      if (typeof firebase !== 'undefined') {
        const fn  = firebase.functions().httpsCallable('getAlgoliaTrendingItems');
        const res = await fn({ indexName, maxRecommendations: limit, facetName, facetValue });
        const hits = res.data?.results?.[0]?.hits || [];
        this._l1.set(cacheKey, hits);
        this._l2.set(cacheKey, hits);
        return hits;
      }
    } catch (_) {}
    return [];
  }

  async getLookingSimilar(objectID, indexName = 'sokoni_products', limit = 6) {
    const cacheKey = `sim:${indexName}:${objectID}:${limit}`;
    const l1 = this._l1.get(cacheKey);
    if (l1) return l1;
    try {
      if (typeof firebase !== 'undefined') {
        const fn  = firebase.functions().httpsCallable('getAlgoliaLookingSimilar');
        const res = await fn({ objectID, indexName, maxRecommendations: limit });
        const hits = res.data?.results?.[0]?.hits || [];
        this._l1.set(cacheKey, hits);
        return hits;
      }
    } catch (_) {}
    return [];
  }

  async getTrendingFacets(indexName = 'sokoni_products', facetName = 'category', limit = 10) {
    const cacheKey = `trndf:${indexName}:${facetName}:${limit}`;
    const l1 = this._l1.get(cacheKey) || this._l2.get(cacheKey);
    if (l1) return l1;
    try {
      if (typeof firebase !== 'undefined') {
        const fn  = firebase.functions().httpsCallable('getAlgoliaTrendingFacets');
        const res = await fn({ indexName, facetName, maxRecommendations: limit });
        const hits = res.data?.results?.[0]?.hits || [];
        this._l1.set(cacheKey, hits);
        this._l2.set(cacheKey, hits);
        return hits;
      }
    } catch (_) {}
    return [];
  }

  /* ══════════════════════════════════════════════════════════════════════
     BARCODE / QR / IMAGE SEARCH
  ══════════════════════════════════════════════════════════════════════ */

  /**
   * Barcode search — maps barcode/EAN/UPC to product via Algolia filter.
   * Attach to camera barcode scanner output or typed barcode input.
   * @param {string} barcode  — EAN-13, UPC-A, QR, or SKU string
   */
  async barcodeSearch(barcode, opts = {}) {
    await this.init();
    if (!barcode) return { results: {}, totalHits: 0 };
    const code = String(barcode).trim();
    this._emit('barcode-scan', { barcode: code });

    /* Try exact barcode match first, then SKU match */
    const result = await this.search('', {
      ...opts,
      indexes: opts.indexes || ['sokoni_products'],
      filters: { ...opts.filters, barcode: code },
    });

    if (!result.totalHits) {
      /* Fallback: try as SKU */
      return this.search('', {
        ...opts,
        indexes: opts.indexes || ['sokoni_products'],
        filters: { ...opts.filters, sku: code },
      });
    }

    return result;
  }

  /**
   * QR code search — intelligently parses QR data and routes to the correct experience.
   * Supports: JSON payloads, SOKONI deep-links, plain text queries.
   */
  async qrSearch(qrData, opts = {}) {
    await this.init();
    if (!qrData) return { results: {}, totalHits: 0 };
    const raw = String(qrData).trim();
    this._emit('qr-scan', { qrData: raw });

    /* 1. Try JSON payload */
    try {
      const parsed = JSON.parse(raw);
      if (parsed.type === 'product' && parsed.id)       return this.search('', { ...opts, indexes: ['sokoni_products'], filters: { objectID: parsed.id } });
      if (parsed.type === 'barcode' && parsed.value)     return this.barcodeSearch(parsed.value, opts);
      if (parsed.type === 'category' && parsed.category) return this.search('', { ...opts, filters: { category: parsed.category } });
      if (parsed.query || parsed.q)                      return this.search(parsed.query || parsed.q, opts);
    } catch (_) {}

    /* 2. Try URL (SOKONI deep-link) */
    try {
      const url   = new URL(raw);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'product' && parts[1])   return this.search('', { ...opts, indexes: ['sokoni_products'], filters: { objectID: parts[1] } });
      if (parts[0] === 'search')                 return this.search(url.searchParams.get('q') || '', opts);
      if (parts[0] === 'shop' && parts[1])       return this.search('', { ...opts, indexes: ['sokoni_shops'], filters: { objectID: parts[1] } });
      if (parts[0] === 'event' && parts[1])      return this.search('', { ...opts, indexes: ['sokoni_events'], filters: { objectID: parts[1] } });
      if (parts[0] === 'category' && parts[1])   return this.search('', { ...opts, filters: { category: decodeURIComponent(parts[1]) } });
    } catch (_) {}

    /* 3. Treat as plain-text search query */
    return this.search(raw, opts);
  }

  /**
   * Image search preparation — accepts URL or File.
   * Routes to NeuralSearch with image-derived context.
   * Prepared for Algolia visual search API when generally available.
   */
  async imageSearch(image, opts = {}) {
    await this.init();
    this._emit('image-search', { image });

    let queryHint = opts.query || '';

    if (typeof image === 'string') {
      /* Extract category context from URL path segments */
      try {
        const url  = new URL(image);
        const segs = url.pathname.split('/').filter(Boolean);
        queryHint  = segs.slice(-2).join(' ').replace(/[^a-z0-9 ]+/gi, ' ').trim() || queryHint;
      } catch (_) {}
    }

    /* Route to NeuralSearch for semantic relevance */
    return this.search(queryHint, {
      ...opts,
      neuralSearch: true,
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     DYNAMIC WIDGETS & HIERARCHICAL CATEGORIES
  ══════════════════════════════════════════════════════════════════════ */

  /**
   * Retrieve facet distributions for a query — powers Dynamic Widgets
   * (facets adapt to show only what's relevant for the current query).
   */
  async getDynamicFacets(query, indexName = 'sokoni_products', facetAttributes = ['category', 'brand', 'location.city', 'condition']) {
    const res = await this.search(query, {
      indexes:     [indexName],
      facets:      facetAttributes,
      hitsPerPage: 0,
    });
    return res.results?.[indexName]?.facets || {};
  }

  /**
   * Hierarchical category navigation for the hierarchicalMenu widget.
   * Returns structured levels derived from hierarchicalCategories.lvl* facets.
   */
  async getHierarchicalCategories(query = '', indexName = 'sokoni_products') {
    const cacheKey = `hier:${indexName}:${query}`;
    const l1 = this._l1.get(cacheKey);
    if (l1) return l1;

    const res = await this.search(query, {
      indexes:     [indexName],
      facets:      ['hierarchicalCategories.lvl0', 'hierarchicalCategories.lvl1', 'hierarchicalCategories.lvl2'],
      hitsPerPage: 0,
    });

    const facets = res.results?.[indexName]?.facets || {};
    const result = {
      lvl0: Object.entries(facets['hierarchicalCategories.lvl0'] || {})
              .map(([k, v]) => ({ name: k, count: v }))
              .sort((a, b) => b.count - a.count),
      lvl1: facets['hierarchicalCategories.lvl1'] || {},
      lvl2: facets['hierarchicalCategories.lvl2'] || {},
    };

    this._l1.set(cacheKey, result);
    return result;
  }

  /**
   * A/B test variant accessor — use to send analytics with variant tags.
   */
  get abVariant() {
    if (!this._abVariant) {
      try { this._abVariant = localStorage.getItem('sokoni_ab') || null; } catch (_) {}
    }
    return this._abVariant;
  }

  /* ── Facet Search ──────────────────────────────────────────────────── */

  /**
   * Search within a specific facet value.
   * @param {string} indexName
   * @param {string} facetName
   * @param {string} facetQuery
   */
  async searchFacetValues(indexName, facetName, facetQuery = '') {
    if (!this._algolia) return { facetHits: [] };
    const cacheKey = `fv:${indexName}:${facetName}:${facetQuery}`;
    const l1 = this._l1.get(cacheKey);
    if (l1) return l1;

    try {
      const res = await this._algolia._doRequest(
        `${SEARCH_CONFIG.algoliaAppId}-dsn.algolia.net`,
        'POST',
        `/1/indexes/${indexName}/facets/${facetName}/query`,
        JSON.stringify({ facetQuery, maxFacetHits: 20 })
      );
      this._l1.set(cacheKey, res);
      return res;
    } catch (_) { return { facetHits: [] }; }
  }

  /* ── Firestore Fallback ────────────────────────────────────────────── */

  async _firestoreFallback(query, opts) {
    if (typeof firebase === 'undefined') return { results: {}, totalHits: 0, fallback: true };

    const db     = firebase.firestore();
    const q      = (query || '').toLowerCase().trim();
    const results = {};
    let totalHits  = 0;

    const collections = {
      'sokoni_products':   'products',
      'sokoni_services':   'services',
      'sokoni_events':     'events',
      'sokoni_properties': 'properties',
      'sokoni_vehicles':   'cars',
      'sokoni_jobs':       'digitalJobs',
    };

    const targetIndexes = opts.indexes || Object.keys(collections);

    await Promise.allSettled(
      targetIndexes.map(async (indexName) => {
        const col = collections[indexName];
        if (!col) return;
        try {
          let ref = db.collection(col).where('status', '==', 'active').limit(opts.hitsPerPage || 12);
          if (q) ref = ref.orderBy('name').startAt(q).endAt(q + '');
          const snap = await ref.get();
          const hits = snap.docs.map(d => ({ objectID: d.id, ...d.data() }));
          results[indexName] = { hits, nbHits: hits.length, nbPages: 1, page: 0 };
          totalHits += hits.length;
        } catch (_) {}
      })
    );

    return { results, totalHits, fallback: true };
  }

  /* ── Helpers ───────────────────────────────────────────────────────── */

  _buildFilterString(filters) {
    if (!filters || !Object.keys(filters).length) return '';
    return Object.entries(filters)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => {
        if (Array.isArray(v)) return `(${v.map(i => `${k}:"${String(i).replace(/"/g, '\\"')}"`).join(' OR ')})`;
        if (typeof v === 'boolean') return `${k}:${v}`;
        if (typeof v === 'number') return `${k}=${v}`;
        if (k.endsWith('_min')) return `${k.slice(0, -4)}>=${v}`;
        if (k.endsWith('_max')) return `${k.slice(0, -4)}<=${v}`;
        return `${k}:"${String(v).replace(/"/g, '\\"')}"`;
      })
      .join(' AND ');
  }

  async _getTrendingQueries() {
    const cacheKey = 'trending_queries';
    const l1 = this._l1.get(cacheKey);
    if (l1) return l1;
    try {
      if (typeof firebase !== 'undefined') {
        const fn = firebase.functions().httpsCallable('getTrendingSearches');
        const res = await fn({ limit: 8 });
        const list = res.data.trending || [];
        this._l1.set(cacheKey, list);
        return list;
      }
    } catch (_) {}
    return [];
  }

  async _searchCategories(query) {
    if (!this._algolia) return [];
    const cacheKey = `cat:${query}`;
    const l1 = this._l1.get(cacheKey);
    if (l1) return l1;
    try {
      const res = await this._algolia.search('sokoni_categories', {
        query,
        hitsPerPage: 3,
        attributesToRetrieve: ['name', 'slug', 'icon', 'hub'],
      });
      const hits = res.hits || [];
      this._l1.set(cacheKey, hits);
      return hits;
    } catch (_) { return []; }
  }

  /* ── Cache invalidation ────────────────────────────────────────────── */

  invalidateCache(prefix = '') {
    this._l1.invalidate(prefix || 's:');
  }

  /* ── Event bus ─────────────────────────────────────────────────────── */

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return () => { this._listeners[event] = this._listeners[event].filter(f => f !== fn); };
  }

  _emit(event, data) {
    (this._listeners[event] || []).forEach(fn => fn(data));
  }

  /* ── Public getters ────────────────────────────────────────────────── */

  get history()      { return this._history; }
  get recentlyViewed() { return this._rv; }
  get isAlgoliaReady() { return !!(this._algolia && SEARCH_CONFIG.algoliaAppId); }
  get indexNames()   { return Object.keys(SEARCH_CONFIG.indexes); }
}

/* ═══════════════════════════════════════════════════════════════════════
   EXPORT — singleton + class
════════════════════════════════════════════════════════════════════════ */

const sokoniSearch = new SokoniSearchEngine();

/* Auto-init when DOM ready */
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => sokoniSearch.init().catch(() => {}));
  } else {
    sokoniSearch.init().catch(() => {});
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SokoniSearchEngine, sokoniSearch };
} else if (typeof window !== 'undefined') {
  window.SokoniSearchEngine = SokoniSearchEngine;
  window.sokoniSearch       = sokoniSearch;
}
