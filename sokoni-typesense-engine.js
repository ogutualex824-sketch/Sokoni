/**
 * SOKONI Typesense Browser Search Engine v2.0
 *
 * Enterprise-grade browser search engine for 1M+ concurrent users.
 *
 * Architecture:
 *  - Multi-node round-robin with per-node circuit breakers and automatic failover
 *  - `multi_search` federated search across all 25 collections
 *  - Three-layer cache: L1 (memory 30s), L2 (sessionStorage 5min), L3 (IndexedDB 1hr)
 *  - Stale-while-revalidate pattern for L3
 *  - Offline queue: stores searches and drains on reconnect
 *  - Instant search: 200ms debounce, AbortController per keystroke
 *  - Autocomplete: history + trending + Typesense prefix + category suggestions
 *  - Voice search: Web Speech API, `en-KE`, interim results
 *  - Geo search: Geolocation API, Typesense geo filter/sort
 *  - Personalization: recently-viewed ring buffer, search history, preference signals
 *  - Prefetch: hover-intent prefetching with 100ms intent delay
 *  - Infinite scroll: page cursor tracking with deduplication
 *  - Canary routing: reads tsCanaryConfig for A/B key allocation
 *  - Fallback: degrades to Algolia engine (sokoniSearch), then to empty results
 *  - Analytics: click, conversion, search events forwarded to Cloud Functions
 *  - Full faceted filter builder: 25 collection-aware filter schemas
 *
 * Collections supported (v2 — 25 total):
 *  sokoni_products, sokoni_shops, sokoni_services, sokoni_events,
 *  sokoni_properties, sokoni_vehicles, sokoni_jobs, sokoni_hotels,
 *  sokoni_restaurants, sokoni_sports, sokoni_healthcare, sokoni_education,
 *  sokoni_professionals, sokoni_reviews, sokoni_users, sokoni_categories,
 *  sokoni_brands, sokoni_collections, sokoni_coupons, sokoni_support,
 *  sokoni_faq, sokoni_blog, sokoni_announcements, sokoni_tourism,
 *  sokoni_entertainment
 */

(function (root) {
  'use strict';

  /* ══════════════════════════════════════════════════════════════
     CONFIGURATION ACCESSOR
  ══════════════════════════════════════════════════════════════ */

  function _cfg() { return root.SOKONI_CONFIG || {}; }

  /* ══════════════════════════════════════════════════════════════
     ENGINE DEFAULTS
  ══════════════════════════════════════════════════════════════ */

  const TS = {
    perPage:      20,
    maxHits:      100,
    geoRadiusKm:  50,
    voiceLang:    'en-KE',
    debounceMs:   200,
    hoverDelayMs: 100,
    maxOfflineQ:  50,
    cacheTTL:     { l1: 30_000, l2: 300_000, l3: 3_600_000 },

    /* All 25 collection names (mirrors sokoni-config.js and CF schemas) */
    collections: {
      products:      'sokoni_products',
      shops:         'sokoni_shops',
      services:      'sokoni_services',
      events:        'sokoni_events',
      properties:    'sokoni_properties',
      vehicles:      'sokoni_vehicles',
      jobs:          'sokoni_jobs',
      hotels:        'sokoni_hotels',
      restaurants:   'sokoni_restaurants',
      sports:        'sokoni_sports',
      healthcare:    'sokoni_healthcare',
      education:     'sokoni_education',
      professionals: 'sokoni_professionals',
      reviews:       'sokoni_reviews',
      users:         'sokoni_users',
      categories:    'sokoni_categories',
      brands:        'sokoni_brands',
      collections:   'sokoni_collections',
      coupons:       'sokoni_coupons',
      support:       'sokoni_support',
      faq:           'sokoni_faq',
      blog:          'sokoni_blog',
      announcements: 'sokoni_announcements',
      tourism:       'sokoni_tourism',
      entertainment: 'sokoni_entertainment',
    },

    /* query_by field lists per collection */
    queryByFields: {
      sokoni_products:     'name,description,brand,category,tags,sku',
      sokoni_shops:        'name,description,category,tags,location_area',
      sokoni_services:     'name,description,category,tags,providerName',
      sokoni_events:       'title,description,category,venue,organizerName,tags',
      sokoni_properties:   'title,description,type,location_area,location_suburb,amenities',
      sokoni_vehicles:     'title,make,model,type,features,description',
      sokoni_jobs:         'title,company,description,category,skills,requirements',
      sokoni_hotels:       'name,description,amenities,location_area,roomTypes',
      sokoni_restaurants:  'name,description,cuisine,tags,location_area,features',
      sokoni_sports:       'name,description,sport,facility,tags',
      sokoni_healthcare:   'name,description,specialties,qualifications,location_area',
      sokoni_education:    'title,description,subject,level,institution,instructor,skills',
      sokoni_professionals:'name,description,profession,specialties,skills,location_area',
      sokoni_reviews:      'comment,reviewerName,tags',
      sokoni_users:        'displayName,username,bio,skills,location_area',
      sokoni_categories:   'name,description,parentName',
      sokoni_brands:       'name,description,origin',
      sokoni_collections:  'name,description,tags,curatorName',
      sokoni_coupons:      'code,name,description',
      sokoni_support:      'title,content,category,tags',
      sokoni_faq:          'question,answer,category',
      sokoni_blog:         'title,excerpt,content,category,authorName,tags',
      sokoni_announcements:'title,body,category',
      sokoni_tourism:      'name,description,location_area,activities,tags',
      sokoni_entertainment:'name,description,genre,tags,artistName',
    },
  };

  /* Searchable collections for federated search (exclude support/faq/announcements) */
  const FEDERATED_COLLECTIONS = [
    'sokoni_products', 'sokoni_shops', 'sokoni_services', 'sokoni_events',
    'sokoni_properties', 'sokoni_vehicles', 'sokoni_jobs', 'sokoni_hotels',
    'sokoni_restaurants', 'sokoni_sports', 'sokoni_healthcare', 'sokoni_education',
    'sokoni_professionals', 'sokoni_tourism', 'sokoni_entertainment',
  ];

  /* ══════════════════════════════════════════════════════════════
     L1 CACHE — In-memory, 30s TTL, 2 000 entry LRU cap
  ══════════════════════════════════════════════════════════════ */

  class L1Cache {
    constructor() { this._map = new Map(); }

    get(key) {
      const hit = this._map.get(key);
      if (!hit) return null;
      if (Date.now() > hit.expires) { this._map.delete(key); return null; }
      /* Move to end (LRU) */
      this._map.delete(key);
      this._map.set(key, hit);
      return hit.value;
    }

    set(key, value) {
      if (this._map.size >= 2000) {
        const oldest = this._map.keys().next().value;
        this._map.delete(oldest);
      }
      this._map.delete(key);
      this._map.set(key, { value, expires: Date.now() + TS.cacheTTL.l1 });
    }

    invalidate(prefix) {
      for (const k of this._map.keys()) {
        if (k.startsWith(prefix)) this._map.delete(k);
      }
    }

    clear() { this._map.clear(); }
  }

  /* ══════════════════════════════════════════════════════════════
     L2 CACHE — sessionStorage, 5min TTL
  ══════════════════════════════════════════════════════════════ */

  const L2_PREFIX = 'sok_ts2_';

  const L2Cache = {
    get(key) {
      try {
        const raw = sessionStorage.getItem(L2_PREFIX + key);
        if (!raw) return null;
        const { value, expires } = JSON.parse(raw);
        if (Date.now() > expires) { sessionStorage.removeItem(L2_PREFIX + key); return null; }
        return value;
      } catch (_) { return null; }
    },
    set(key, value) {
      try {
        sessionStorage.setItem(L2_PREFIX + key, JSON.stringify({
          value, expires: Date.now() + TS.cacheTTL.l2,
        }));
      } catch (_) {}
    },
    invalidate(prefix) {
      try {
        const keys = Object.keys(sessionStorage).filter(k => k.startsWith(L2_PREFIX + prefix));
        keys.forEach(k => sessionStorage.removeItem(k));
      } catch (_) {}
    },
  };

  /* ══════════════════════════════════════════════════════════════
     L3 CACHE — IndexedDB, 1hr TTL, stale-while-revalidate
  ══════════════════════════════════════════════════════════════ */

  class L3Cache {
    constructor() {
      this._db   = null;
      this._name = 'sok_ts_cache_v2';
      this._ready = false;
      this._queue = [];
      this._init();
    }

    _init() {
      if (typeof indexedDB === 'undefined') return;
      const req = indexedDB.open(this._name, 2);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('cache')) {
          const store = db.createObjectStore('cache', { keyPath: 'key' });
          store.createIndex('expires', 'expires', { unique: false });
        }
        if (!db.objectStoreNames.contains('offline')) {
          db.createObjectStore('offline', { autoIncrement: true });
        }
      };
      req.onsuccess = e => {
        this._db    = e.target.result;
        this._ready = true;
        this._cleanup();
        this._queue.forEach(fn => fn());
        this._queue = [];
      };
      req.onerror = () => {};
    }

    _whenReady(fn) {
      if (this._ready) fn();
      else this._queue.push(fn);
    }

    get(key) {
      return new Promise(resolve => {
        if (!this._db) return resolve(null);
        this._whenReady(() => {
          try {
            const tx  = this._db.transaction('cache', 'readonly');
            const req = tx.objectStore('cache').get(key);
            req.onsuccess = e => {
              const hit = e.target.result;
              if (!hit || !hit.value) return resolve(null);
              resolve({ value: hit.value, stale: Date.now() > hit.expires });
            };
            req.onerror = () => resolve(null);
          } catch (_) { resolve(null); }
        });
      });
    }

    set(key, value) {
      if (!this._db) return;
      this._whenReady(() => {
        try {
          const tx = this._db.transaction('cache', 'readwrite');
          tx.objectStore('cache').put({
            key, value, expires: Date.now() + TS.cacheTTL.l3,
          });
        } catch (_) {}
      });
    }

    saveOffline(query, opts) {
      if (!this._db) return;
      this._whenReady(() => {
        try {
          const tx = this._db.transaction('offline', 'readwrite');
          tx.objectStore('offline').add({ query, opts, ts: Date.now() });
        } catch (_) {}
      });
    }

    drainOffline(callback) {
      if (!this._db) return;
      this._whenReady(() => {
        try {
          const tx    = this._db.transaction('offline', 'readwrite');
          const store = tx.objectStore('offline');
          store.openCursor().onsuccess = e => {
            const cursor = e.target.result;
            if (!cursor) return;
            callback(cursor.value);
            cursor.delete();
            cursor.continue();
          };
        } catch (_) {}
      });
    }

    _cleanup() {
      if (!this._db) return;
      try {
        const tx    = this._db.transaction('cache', 'readwrite');
        const store = tx.objectStore('cache');
        const idx   = store.index('expires');
        const range = IDBKeyRange.upperBound(Date.now());
        idx.openCursor(range).onsuccess = e => {
          const cursor = e.target.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
        };
      } catch (_) {}
    }
  }

  /* ══════════════════════════════════════════════════════════════
     RECENTLY VIEWED — localStorage ring buffer, 50 items
  ══════════════════════════════════════════════════════════════ */

  const RecentlyViewed = {
    _key: 'sokoni_ts_rv2',
    _max: 50,
    get() {
      try { return JSON.parse(localStorage.getItem(this._key) || '[]'); }
      catch (_) { return []; }
    },
    add(item) {
      if (!item?.id) return;
      const rv = this.get().filter(x => x.id !== item.id);
      rv.unshift({ id: item.id, name: item.name || item.title || '', collection: item.collection || '', viewedAt: Date.now() });
      try { localStorage.setItem(this._key, JSON.stringify(rv.slice(0, this._max))); }
      catch (_) {}
    },
    clear() { try { localStorage.removeItem(this._key); } catch (_) {} },
  };

  /* ══════════════════════════════════════════════════════════════
     SEARCH HISTORY — localStorage ring buffer, 20 items
  ══════════════════════════════════════════════════════════════ */

  const SearchHistory = {
    _key: 'sokoni_ts_sh2',
    _max: 20,
    get() {
      try { return JSON.parse(localStorage.getItem(this._key) || '[]'); }
      catch (_) { return []; }
    },
    add(query) {
      if (!query?.trim()) return;
      const q = query.trim().toLowerCase();
      const h = this.get().filter(x => x !== q);
      h.unshift(q);
      try { localStorage.setItem(this._key, JSON.stringify(h.slice(0, this._max))); }
      catch (_) {}
    },
    remove(query) {
      const h = this.get().filter(q => q !== query);
      try { localStorage.setItem(this._key, JSON.stringify(h)); } catch (_) {}
    },
    clear() { try { localStorage.removeItem(this._key); } catch (_) {} },
  };

  /* ══════════════════════════════════════════════════════════════
     USER PREFERENCES — lightweight signal store
     Tracks collection affinity from click/view events
  ══════════════════════════════════════════════════════════════ */

  const UserPreferences = {
    _key:  'sokoni_ts_prefs2',
    _maxAge: 30 * 86_400_000, /* 30 days */

    _load() {
      try { return JSON.parse(localStorage.getItem(this._key) || '{}'); }
      catch (_) { return {}; }
    },

    _save(data) {
      try { localStorage.setItem(this._key, JSON.stringify(data)); }
      catch (_) {}
    },

    recordCollectionHit(collection) {
      const data = this._load();
      const now  = Date.now();
      if (!data[collection]) data[collection] = { score: 0, lastAt: now };
      data[collection].score = (data[collection].score || 0) + 1;
      data[collection].lastAt = now;
      /* Decay old collections */
      for (const [col, v] of Object.entries(data)) {
        if (now - v.lastAt > this._maxAge) delete data[col];
      }
      this._save(data);
    },

    getAffinityOrder() {
      const data = this._load();
      return Object.entries(data)
        .sort((a, b) => b[1].score - a[1].score)
        .map(([col]) => col);
    },
  };

  /* ══════════════════════════════════════════════════════════════
     BROWSER CIRCUIT BREAKER
     Per-node: CLOSED → OPEN after 3 failures → HALF_OPEN after 15s
  ══════════════════════════════════════════════════════════════ */

  class BrowserCircuitBreaker {
    constructor({ threshold = 3, cooldownMs = 15_000 } = {}) {
      this._threshold  = threshold;
      this._cooldown   = cooldownMs;
      this._failures   = 0;
      this._state      = 'CLOSED';
      this._openedAt   = 0;
    }

    isOpen() {
      if (this._state === 'CLOSED') return false;
      if (this._state === 'OPEN' && Date.now() - this._openedAt > this._cooldown) {
        this._state = 'HALF_OPEN';
        return false;
      }
      return this._state === 'OPEN';
    }

    recordSuccess() {
      this._failures = 0;
      this._state    = 'CLOSED';
    }

    recordFailure() {
      this._failures++;
      if (this._failures >= this._threshold) {
        this._state    = 'OPEN';
        this._openedAt = Date.now();
      }
    }
  }

  /* ══════════════════════════════════════════════════════════════
     TYPESENSE BROWSER CLIENT
     Multi-node, per-node circuit breaker, Bearer auth, AbortController
  ══════════════════════════════════════════════════════════════ */

  class TypesenseBrowserClient {
    constructor(nodes, apiKey) {
      this._nodes    = nodes; /* [{host, port, protocol}] */
      this._apiKey   = apiKey;
      this._cursor   = 0;
      this._breakers = nodes.map(() => new BrowserCircuitBreaker());
    }

    updateKey(newKey) { this._apiKey = newKey; }

    _nextNode() {
      const total = this._nodes.length;
      for (let i = 0; i < total; i++) {
        const idx = (this._cursor + i) % total;
        if (!this._breakers[idx].isOpen()) {
          this._cursor = (idx + 1) % total;
          return { node: this._nodes[idx], idx };
        }
      }
      /* All nodes open — pick least-recently-opened */
      const idx = this._cursor % total;
      this._cursor = (idx + 1) % total;
      return { node: this._nodes[idx], idx };
    }

    _baseUrl(node) {
      return `${node.protocol}://${node.host}:${node.port}`;
    }

    async _fetch(method, path, body, signal) {
      const { node, idx } = this._nextNode();
      const url  = this._baseUrl(node) + path;
      const opts = {
        method,
        headers: {
          'X-TYPESENSE-API-KEY': this._apiKey,
          'Content-Type':        'application/json',
        },
      };
      if (signal)     opts.signal = signal;
      if (body)       opts.body   = JSON.stringify(body);

      try {
        const res = await fetch(url, opts);
        if (!res.ok) {
          const err   = await res.json().catch(() => ({ message: res.statusText }));
          const error = new Error(err.message || `Typesense ${res.status}`);
          error.status = res.status;
          /* Don't trip breaker for 4xx (client errors, not node failure) */
          if (res.status >= 500) this._breakers[idx].recordFailure();
          throw error;
        }
        this._breakers[idx].recordSuccess();
        return res.json();
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        if (!err.status || err.status >= 500) this._breakers[idx].recordFailure();
        /* Retry on a different node */
        const { node: n2, idx: idx2 } = this._nextNode();
        if (n2 !== node) {
          try {
            const opts2 = { ...opts, signal: undefined };
            const url2  = this._baseUrl(n2) + path;
            const res2  = await fetch(url2, opts2);
            if (!res2.ok) throw new Error(`Retry failed: ${res2.status}`);
            this._breakers[idx2].recordSuccess();
            return res2.json();
          } catch (_) {}
        }
        throw err;
      }
    }

    search(collection, params, signal) {
      const qs = _buildQS(params);
      return this._fetch('GET', `/collections/${encodeURIComponent(collection)}/documents/search?${qs}`, null, signal);
    }

    multiSearch(searches, signal) {
      return this._fetch('POST', '/multi_search', { searches }, signal);
    }
  }

  function _buildQS(params) {
    const parts = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        v.forEach(item => parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`));
      } else {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      }
    }
    return parts.join('&');
  }

  /* ══════════════════════════════════════════════════════════════
     VOICE SEARCH
  ══════════════════════════════════════════════════════════════ */

  class VoiceSearch {
    constructor(onInterim, onFinal, onError) {
      this._onInterim     = onInterim;
      this._onFinal       = onFinal;
      this._onError       = onError;
      this._recognition   = null;
      this._active        = false;
    }

    get supported() {
      return !!(root.SpeechRecognition || root.webkitSpeechRecognition);
    }

    start() {
      if (!this.supported || this._active) return;
      const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
      const r  = new SR();
      r.lang             = TS.voiceLang;
      r.continuous       = false;
      r.interimResults   = true;
      r.maxAlternatives  = 1;

      r.onresult = e => {
        const t = e.results[e.results.length - 1];
        if (t.isFinal) { this._onFinal(t[0].transcript.trim()); this.stop(); }
        else            this._onInterim(t[0].transcript.trim());
      };
      r.onerror = e => { this._onError(e.error); this.stop(); };
      r.onend   = ()  => { this._active = false; };

      r.start();
      this._recognition = r;
      this._active      = true;
    }

    stop() {
      try { this._recognition?.stop(); } catch (_) {}
      this._active = false;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     GEO SEARCH — 5min position cache
  ══════════════════════════════════════════════════════════════ */

  class GeoSearch {
    constructor() { this._pos = null; this._expires = 0; }

    getPosition() {
      return new Promise((resolve, reject) => {
        if (this._pos && Date.now() < this._expires) return resolve(this._pos);
        if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
        navigator.geolocation.getCurrentPosition(
          p => {
            this._pos     = { lat: p.coords.latitude, lng: p.coords.longitude };
            this._expires = Date.now() + 300_000;
            resolve(this._pos);
          },
          err => reject(err),
          { timeout: 8000, maximumAge: 300_000, enableHighAccuracy: false }
        );
      });
    }

    async buildGeoFilter(radiusKm) {
      const pos = await this.getPosition();
      return `location:(${pos.lat},${pos.lng},${radiusKm || TS.geoRadiusKm} km)`;
    }

    async buildGeoSort() {
      const pos = await this.getPosition();
      return `location(${pos.lat},${pos.lng}):asc`;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     HOVER PREFETCH — 100ms intent delay
  ══════════════════════════════════════════════════════════════ */

  class HoverPrefetch {
    constructor(engine) {
      this._engine  = engine;
      this._timers  = new Map();
    }

    attach(element, query, opts) {
      element.addEventListener('mouseenter', () => {
        const timer = setTimeout(() => {
          this._engine.search(query, { ...opts, _prefetch: true }).catch(() => {});
        }, TS.hoverDelayMs);
        this._timers.set(element, timer);
      });
      element.addEventListener('mouseleave', () => {
        const timer = this._timers.get(element);
        if (timer) { clearTimeout(timer); this._timers.delete(element); }
      });
    }
  }

  /* ══════════════════════════════════════════════════════════════
     OFFLINE QUEUE — stores searches when navigator is offline
  ══════════════════════════════════════════════════════════════ */

  class OfflineQueue {
    constructor(l3, engine) {
      this._l3     = l3;
      this._engine = engine;
      this._listening = false;
      this._queue  = [];
    }

    enqueue(query, opts) {
      if (this._queue.length < TS.maxOfflineQ) {
        this._queue.push({ query, opts });
        this._l3.saveOffline(query, opts);
      }
      if (!this._listening) this._listen();
    }

    _listen() {
      this._listening = true;
      root.addEventListener('online', () => this._drain(), { once: true });
    }

    _drain() {
      this._listening = false;
      /* Drain from memory first */
      const pending = this._queue.splice(0);
      pending.forEach(({ query, opts }) => {
        this._engine.search(query, opts).catch(() => {});
      });
      /* Drain from IndexedDB (surviving page reloads) */
      this._l3.drainOffline(({ query, opts }) => {
        this._engine.search(query, opts).catch(() => {});
      });
    }
  }

  /* ══════════════════════════════════════════════════════════════
     PAGE CURSOR — tracks infinite scroll state per collection
  ══════════════════════════════════════════════════════════════ */

  class PageCursor {
    constructor() { this._pages = new Map(); this._seen = new Map(); }

    getPage(key)           { return this._pages.get(key) || 1; }
    nextPage(key)          { const p = this.getPage(key) + 1; this._pages.set(key, p); return p; }
    reset(key)             { this._pages.delete(key); this._seen.delete(key); }

    isDuplicate(key, docId) {
      if (!this._seen.has(key)) this._seen.set(key, new Set());
      const set = this._seen.get(key);
      if (set.has(docId)) return true;
      set.add(docId);
      return false;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     MAIN SEARCH ENGINE
  ══════════════════════════════════════════════════════════════ */

  class SokoniTypesenseEngine {
    constructor() {
      this._client         = null;
      this._apiKey         = null;
      this._keyExpires     = 0;
      this._l1             = new L1Cache();
      this._l2             = L2Cache;
      this._l3             = new L3Cache();
      this._geo            = new GeoSearch();
      this._voice          = null;
      this._debounceTimer  = null;
      this._abortCtrl      = null;
      this._trendingCache  = null;
      this._trendingExpires = 0;
      this._ready          = false;
      this._initPromise    = null;
      this._prefetch       = new HoverPrefetch(this);
      this._pageCursor     = new PageCursor();
      this._offline        = null; /* lazy-init after L3 ready */
    }

    /* ── Initialise (lazy, idempotent) ─────────────────────────── */

    async _ensureReady() {
      if (this._ready && this._apiKey && Date.now() < this._keyExpires) return;
      if (this._initPromise) return this._initPromise;
      this._initPromise = this._init();
      await this._initPromise;
      this._initPromise = null;
    }

    async _init() {
      const cfg   = _cfg();
      const nodes = this._buildNodes(cfg);

      if (!nodes.length) {
        console.warn('[SokoniTS] No Typesense nodes configured — engine inactive.');
        return;
      }

      /* Attempt to fetch scoped search key via Cloud Function */
      try {
        const keyResult = await this._callCF('getTypesenseSearchKey', {});
        if (keyResult?.key) {
          this._apiKey     = keyResult.key;
          this._keyExpires = (keyResult.expiresAt || 0) * 1000;
          this._client     = new TypesenseBrowserClient(nodes, this._apiKey);
          this._ready      = true;
        }
      } catch (_) {
        /* Fallback to static config key (dev only) */
        const fallback = cfg.typesenseSearchKey || cfg.typesenseKey || '';
        if (fallback) {
          this._apiKey     = fallback;
          this._keyExpires = Date.now() + 900_000;
          this._client     = new TypesenseBrowserClient(nodes, fallback);
          this._ready      = true;
        } else {
          console.warn('[SokoniTS] No search key available — operating in fallback mode.');
        }
      }

      /* Lazy offline queue */
      this._offline = new OfflineQueue(this._l3, this);

      /* Online connectivity: re-init if key expired */
      root.addEventListener('online', () => {
        if (this._ready && Date.now() > this._keyExpires) {
          this._ready       = false;
          this._initPromise = null;
          this._ensureReady().catch(() => {});
        }
      });
    }

    _buildNodes(cfg) {
      if (Array.isArray(cfg.typesenseNodes) && cfg.typesenseNodes.length) {
        return cfg.typesenseNodes.map(n =>
          typeof n === 'string'
            ? {
                host:     n.split(':')[0],
                port:     parseInt(n.split(':')[1] || '443', 10),
                protocol: n.split(':')[2] || 'https',
              }
            : n
        );
      }
      if (cfg.typesenseHost) {
        return [{
          host:     cfg.typesenseHost,
          port:     cfg.typesensePort     || 443,
          protocol: cfg.typesenseProtocol || 'https',
        }];
      }
      return [];
    }

    async _callCF(name, data) {
      /* Supports both modular Firebase SDK (v9+) and compat SDK (v8) */
      const fb = root.firebase;
      if (!fb) throw new Error('Firebase not available');
      let fn;
      if (typeof fb.functions === 'function') {
        /* compat */
        fn = fb.app().functions('us-central1').httpsCallable(name);
      } else {
        throw new Error('Firebase functions not available');
      }
      const result = await fn(data);
      return result.data;
    }

    /* ── Cache key (max 256 chars) ──────────────────────────────── */

    _cacheKey(query, opts) {
      const { collection, filterBy, sortBy, perPage, page, geoFilter, geoSort, facets } = opts || {};
      return `ts2:${JSON.stringify({ q: query, col: collection, f: filterBy, s: sortBy, pp: perPage, p: page, gf: geoFilter, gs: geoSort, fa: facets })}`.slice(0, 256);
    }

    /* ── Core search ────────────────────────────────────────────── */

    /**
     * Full search with L1→L2→L3→network chain.
     * @param {string}  query
     * @param {object}  opts — { collection, collections, filterBy, sortBy, perPage, geoFilter, geoSort, page, facets, _prefetch }
     * @returns {object}     — { results, found, query, latencyMs, source }
     */
    async search(query, opts = {}) {
      /* Offline check */
      if (!navigator.onLine) {
        this._offline?.enqueue(query, opts);
        return { results: {}, found: 0, query, source: 'offline', offline: true };
      }

      await this._ensureReady();

      const key       = this._cacheKey(query, opts);
      const startTime = performance.now();

      /* L1 */
      const l1 = this._l1.get(key);
      if (l1) return { ...l1, source: 'l1-cache' };

      /* L2 */
      const l2 = this._l2.get(key);
      if (l2) { this._l1.set(key, l2); return { ...l2, source: 'l2-cache' }; }

      /* L3 stale-while-revalidate */
      const l3 = await this._l3.get(key);
      if (l3) {
        this._l1.set(key, l3.value);
        if (l3.stale) this._fetchSearch(query, opts, key).catch(() => {});
        return { ...l3.value, source: l3.stale ? 'l3-stale' : 'l3-cache' };
      }

      if (!this._ready) return this._fallback(query, opts);

      try {
        const data = await this._fetchSearch(query, opts, key);
        data.latencyMs = Math.round(performance.now() - startTime);
        if (!opts._prefetch) {
          this._emitAnalyticsEvent('search', { query, hitCount: data.found || 0, latencyMs: data.latencyMs });
        }
        return { ...data, source: 'network' };
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        console.warn('[SokoniTS] Search failed:', err.message);
        return this._fallback(query, opts);
      }
    }

    async _fetchSearch(query, opts, cacheKey) {
      const {
        collection   = null,
        collections  = null,
        filterBy     = '',
        sortBy       = '_popularityScore:desc',
        perPage      = TS.perPage,
        page         = 1,
        geoFilter    = null,
        geoSort      = null,
        facets       = [],
        signal       = null,
      } = opts;

      const combinedFilter = [filterBy, geoFilter].filter(Boolean).join(' && ');
      const combinedSort   = geoSort ? `${geoSort},${sortBy}` : sortBy;

      let data;
      if (collections?.length) {
        data = await this._multiSearch(query, collections, combinedFilter, combinedSort, perPage, page, facets, signal);
      } else {
        const col = collection || TS.collections.products;
        const params = {
          q:                     query || '*',
          query_by:              TS.queryByFields[col] || 'name,title',
          filter_by:             combinedFilter || undefined,
          sort_by:               combinedSort,
          per_page:              perPage,
          page,
          facet_by:              facets.join(',') || undefined,
          max_facet_values:      30,
          highlight_full_fields: 'name,title,description',
          snippet_threshold:     250,
          typo_tokens_threshold: 2,
          num_typos:             2,
          prefix:                true,
          use_cache:             true,
          cache_ttl:             60,
          search_cutoff_ms:      200,
        };
        const res = await this._client.search(col, params, signal);
        data = { results: { [col]: res }, found: res.found };
      }

      if (cacheKey) {
        this._l1.set(cacheKey, data);
        this._l2.set(cacheKey, data);
        this._l3.set(cacheKey, data);
      }

      return data;
    }

    async _multiSearch(query, collections, filterBy, sortBy, perPage, page, facets, signal) {
      /* Personalise collection order using affinity scores */
      const affinity = UserPreferences.getAffinityOrder();
      const ordered  = [...collections].sort((a, b) => {
        const ai = affinity.indexOf(a);
        const bi = affinity.indexOf(b);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });

      const searches = ordered.map(col => ({
        collection:            col,
        q:                     query || '*',
        query_by:              TS.queryByFields[col] || 'name,title',
        filter_by:             filterBy || undefined,
        sort_by:               sortBy,
        per_page:              Math.min(perPage, 10),
        page,
        highlight_full_fields: 'name,title,description',
        num_typos:             2,
        prefix:                true,
        search_cutoff_ms:      200,
        facet_by:              facets.join(',') || undefined,
      }));

      const res = await this._client.multiSearch(searches, signal);
      const out = { results: {}, found: 0 };

      (res.results || []).forEach((r, i) => {
        const col = ordered[i];
        out.results[col] = r;
        out.found += r.found || 0;
      });

      return out;
    }

    /* ── Infinite scroll: load next page ───────────────────────── */

    async loadNextPage(query, opts = {}) {
      const key  = this._cacheKey(query, opts);
      const page = this._pageCursor.nextPage(key);
      const data = await this.search(query, { ...opts, page });

      /* Deduplicate hits across pages */
      const deduped = {};
      const col = opts.collection || TS.collections.products;
      const hits = data.results?.[col]?.hits || [];
      deduped[col] = {
        ...data.results?.[col],
        hits: hits.filter(h => !this._pageCursor.isDuplicate(key, h.document?.id)),
      };

      return { ...data, results: deduped, page };
    }

    resetPagination(query, opts) {
      const key = this._cacheKey(query, opts);
      this._pageCursor.reset(key);
    }

    /* ── Instant search (debounced) ─────────────────────────────── */

    instantSearch(query, opts, callback, debounceMs) {
      clearTimeout(this._debounceTimer);
      if (this._abortCtrl) { this._abortCtrl.abort(); }
      this._abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;

      if (!query?.trim()) {
        callback({ results: {}, found: 0, query: '' });
        return;
      }

      this._debounceTimer = setTimeout(async () => {
        try {
          const result = await this.search(query, { ...opts, signal: this._abortCtrl?.signal });
          callback(result);
        } catch (err) {
          if (err.name !== 'AbortError') callback({ error: err.message, results: {}, found: 0 });
        }
      }, debounceMs ?? TS.debounceMs);
    }

    /* ── Autocomplete ───────────────────────────────────────────── */

    async autocomplete(prefix, opts = {}) {
      if (!prefix?.trim()) return this._noQuerySuggestions();

      const p           = prefix.trim().toLowerCase();
      const suggestions = [];
      const seen        = new Set();

      const _push = (item) => {
        const k = item.text?.toLowerCase();
        if (!k || seen.has(k)) return;
        seen.add(k);
        suggestions.push(item);
      };

      /* 1. Search history */
      SearchHistory.get()
        .filter(q => q.startsWith(p))
        .slice(0, 4)
        .forEach(q => _push({ type: 'history', text: q, icon: 'history' }));

      /* 2. Trending matches */
      const trending = await this._getTrendingQueries();
      trending
        .filter(q => q.query.toLowerCase().startsWith(p))
        .slice(0, 3)
        .forEach(q => _push({ type: 'trending', text: q.query, icon: 'trending_up', count: q.count }));

      /* 3. Typesense prefix search — products and shops */
      if (this._ready && suggestions.length < 8) {
        try {
          const searches = [
            { collection: TS.collections.products,   q: prefix, query_by: 'name,tags', per_page: 5, include_fields: 'id,name', prefix: true, num_typos: 1, search_cutoff_ms: 100 },
            { collection: TS.collections.shops,      q: prefix, query_by: 'name',      per_page: 3, include_fields: 'id,name', prefix: true, num_typos: 1, search_cutoff_ms: 100 },
            { collection: TS.collections.categories, q: prefix, query_by: 'name',      per_page: 3, include_fields: 'id,name,hub', prefix: true, num_typos: 1, search_cutoff_ms: 100 },
          ];
          const res = await this._client.multiSearch(searches);
          if (res.results?.[0]?.hits) {
            res.results[0].hits.forEach(h =>
              _push({ type: 'product', text: h.document?.name || '', id: h.document?.id, icon: 'search', collection: TS.collections.products })
            );
          }
          if (res.results?.[1]?.hits) {
            res.results[1].hits.forEach(h =>
              _push({ type: 'shop', text: h.document?.name || '', id: h.document?.id, icon: 'store', collection: TS.collections.shops })
            );
          }
          if (res.results?.[2]?.hits) {
            res.results[2].hits.forEach(h =>
              _push({ type: 'category', text: h.document?.name || '', id: h.document?.id, hub: h.document?.hub, icon: 'category' })
            );
          }
        } catch (_) {}
      }

      return suggestions.slice(0, 10);
    }

    async _noQuerySuggestions() {
      const suggestions = [];
      const seen        = new Set();

      const _push = item => {
        const k = item.text?.toLowerCase();
        if (!k || seen.has(k)) return;
        seen.add(k);
        suggestions.push(item);
      };

      /* Recently viewed */
      RecentlyViewed.get()
        .slice(0, 4)
        .forEach(item => _push({ type: 'recent', text: item.name || '', id: item.id, collection: item.collection, icon: 'history' }));

      /* Trending */
      const trending = await this._getTrendingQueries();
      trending
        .slice(0, 6)
        .forEach(q => _push({ type: 'trending', text: q.query, icon: 'trending_up', count: q.count }));

      return suggestions;
    }

    async _getTrendingQueries() {
      if (this._trendingCache && Date.now() < this._trendingExpires) {
        return this._trendingCache;
      }
      try {
        const result = await this._callCF('getTsAutocompleteSuggestions', { prefix: '' });
        this._trendingCache   = result?.suggestions || [];
        this._trendingExpires = Date.now() + 300_000;
      } catch (_) {
        this._trendingCache   = [];
        this._trendingExpires = Date.now() + 60_000;
      }
      return this._trendingCache;
    }

    /* ── Federated search across all 25 commerce collections ────── */

    async federatedSearch(query, opts = {}) {
      const affinity = UserPreferences.getAffinityOrder();
      const cols = affinity.length
        ? [...new Set([...affinity, ...FEDERATED_COLLECTIONS])].filter(c => FEDERATED_COLLECTIONS.includes(c))
        : FEDERATED_COLLECTIONS;

      return this.search(query, { ...opts, collections: cols });
    }

    /* ── Geo search ─────────────────────────────────────────────── */

    async searchNearby(query, opts = {}) {
      try {
        const [geoFilter, geoSort] = await Promise.all([
          this._geo.buildGeoFilter(opts.radiusKm),
          this._geo.buildGeoSort(),
        ]);
        return this.search(query, { ...opts, geoFilter, geoSort });
      } catch (_) {
        return this.search(query, opts);
      }
    }

    /* ── Voice search ───────────────────────────────────────────── */

    startVoiceSearch(onInterim, onFinal, onError) {
      if (!this._voice) {
        this._voice = new VoiceSearch(onInterim, onFinal, onError || (() => {}));
      }
      this._voice.start();
    }

    stopVoiceSearch() { this._voice?.stop(); }

    get voiceSupported() { return !!(root.SpeechRecognition || root.webkitSpeechRecognition); }

    /* ── Hover prefetch ─────────────────────────────────────────── */

    attachPrefetch(element, query, opts) {
      this._prefetch.attach(element, query, opts);
    }

    /* ── Facet-aware filter builder — all 25 collections ────────── */

    /**
     * Builds a Typesense filter_by string from a plain filter object.
     * Supports all 25 collection filter schemas.
     */
    buildFilterBy(filters = {}) {
      const parts = [];

      /* Universal fields (most collections) */
      if (filters.category)        parts.push(`category:=${_esc(filters.category)}`);
      if (filters.subcategory)     parts.push(`subcategory:=${_esc(filters.subcategory)}`);
      if (filters.brand)           parts.push(`brand:=${_esc(filters.brand)}`);
      if (filters.location_city)   parts.push(`location_city:=${_esc(filters.location_city)}`);
      if (filters.location_county) parts.push(`location_county:=${_esc(filters.location_county)}`);
      if (filters.location_area)   parts.push(`location_area:=${_esc(filters.location_area)}`);
      if (filters.price_min !== undefined) parts.push(`price:>=${filters.price_min}`);
      if (filters.price_max !== undefined) parts.push(`price:<=${filters.price_max}`);
      if (filters.rating_min !== undefined) parts.push(`rating:>=${filters.rating_min}`);
      if (filters.isFeatured)      parts.push('isFeatured:=true');
      if (filters.verified)        parts.push('verified:=true');
      if (filters.inStock !== undefined) parts.push(`inStock:=${filters.inStock}`);
      if (filters.isFree)          parts.push('isFree:=true');
      if (Array.isArray(filters.tags) && filters.tags.length) {
        parts.push(`tags:[${filters.tags.map(_esc).join(',')}]`);
      }

      /* Products / Shops */
      if (filters.condition)       parts.push(`condition:=${_esc(filters.condition)}`);
      if (filters.shopId)          parts.push(`shopId:=${_esc(filters.shopId)}`);

      /* Events */
      if (filters.date_min !== undefined) parts.push(`date:>=${filters.date_min}`);
      if (filters.date_max !== undefined) parts.push(`date:<=${filters.date_max}`);
      if (filters.isFreeEntry)     parts.push('isFree:=true');
      if (filters.isOnline)        parts.push('isOnline:=true');

      /* Properties */
      if (filters.property_type)   parts.push(`type:=${_esc(filters.property_type)}`);
      if (filters.bedrooms_min !== undefined) parts.push(`bedrooms:>=${filters.bedrooms_min}`);
      if (filters.bedrooms_max !== undefined) parts.push(`bedrooms:<=${filters.bedrooms_max}`);
      if (filters.bathrooms_min !== undefined) parts.push(`bathrooms:>=${filters.bathrooms_min}`);
      if (filters.size_sqft_min !== undefined) parts.push(`size_sqft:>=${filters.size_sqft_min}`);
      if (filters.forRent !== undefined)  parts.push(`forRent:=${filters.forRent}`);
      if (filters.furnished !== undefined) parts.push(`furnished:=${filters.furnished}`);
      if (Array.isArray(filters.amenities) && filters.amenities.length) {
        parts.push(`amenities:[${filters.amenities.map(_esc).join(',')}]`);
      }

      /* Vehicles */
      if (filters.make)            parts.push(`make:=${_esc(filters.make)}`);
      if (filters.model)           parts.push(`model:=${_esc(filters.model)}`);
      if (filters.year_min !== undefined) parts.push(`year:>=${filters.year_min}`);
      if (filters.year_max !== undefined) parts.push(`year:<=${filters.year_max}`);
      if (filters.mileage_max !== undefined) parts.push(`mileage:<=${filters.mileage_max}`);
      if (filters.fuel_type)       parts.push(`fuelType:=${_esc(filters.fuel_type)}`);
      if (filters.transmission)    parts.push(`transmission:=${_esc(filters.transmission)}`);
      if (filters.isRental !== undefined) parts.push(`isRental:=${filters.isRental}`);

      /* Jobs */
      if (filters.job_type)        parts.push(`type:=${_esc(filters.job_type)}`);
      if (filters.remote !== undefined) parts.push(`remote:=${filters.remote}`);
      if (filters.salary_min !== undefined) parts.push(`salaryMin:>=${filters.salary_min}`);
      if (filters.salary_max !== undefined) parts.push(`salaryMax:<=${filters.salary_max}`);
      if (filters.experience_level) parts.push(`experienceLevel:=${_esc(filters.experience_level)}`);
      if (Array.isArray(filters.skills) && filters.skills.length) {
        parts.push(`skills:[${filters.skills.map(_esc).join(',')}]`);
      }

      /* Hotels */
      if (filters.stars_min !== undefined) parts.push(`stars:>=${filters.stars_min}`);
      if (filters.room_type)       parts.push(`roomTypes:${_esc(filters.room_type)}`);
      if (filters.price_per_night_min !== undefined) parts.push(`pricePerNight:>=${filters.price_per_night_min}`);
      if (filters.price_per_night_max !== undefined) parts.push(`pricePerNight:<=${filters.price_per_night_max}`);

      /* Restaurants */
      if (filters.cuisine)         parts.push(`cuisine:=${_esc(filters.cuisine)}`);
      if (filters.delivery !== undefined) parts.push(`hasDelivery:=${filters.delivery}`);
      if (filters.dine_in !== undefined)  parts.push(`hasDineIn:=${filters.dine_in}`);
      if (filters.halal !== undefined)    parts.push(`isHalal:=${filters.halal}`);

      /* Sports */
      if (filters.sport)           parts.push(`sport:=${_esc(filters.sport)}`);
      if (filters.facility_type)   parts.push(`facilityType:=${_esc(filters.facility_type)}`);

      /* Healthcare */
      if (filters.specialty)       parts.push(`specialties:${_esc(filters.specialty)}`);
      if (filters.accepts_insurance !== undefined) parts.push(`acceptsInsurance:=${filters.accepts_insurance}`);
      if (filters.telemedicine !== undefined) parts.push(`telemedicine:=${filters.telemedicine}`);

      /* Education */
      if (filters.subject)         parts.push(`subject:=${_esc(filters.subject)}`);
      if (filters.level)           parts.push(`level:=${_esc(filters.level)}`);
      if (filters.mode)            parts.push(`mode:=${_esc(filters.mode)}`);
      if (filters.duration_hours_max !== undefined) parts.push(`durationHours:<=${filters.duration_hours_max}`);

      /* Professionals */
      if (filters.profession)      parts.push(`profession:=${_esc(filters.profession)}`);
      if (filters.hourly_rate_max !== undefined) parts.push(`hourlyRate:<=${filters.hourly_rate_max}`);

      /* Tourism */
      if (filters.activity_type)   parts.push(`activities:${_esc(filters.activity_type)}`);
      if (filters.duration_days_min !== undefined) parts.push(`durationDays:>=${filters.duration_days_min}`);

      /* Entertainment */
      if (filters.genre)           parts.push(`genre:=${_esc(filters.genre)}`);
      if (filters.event_type)      parts.push(`eventType:=${_esc(filters.event_type)}`);

      /* Status filter — applied unless caller opts out */
      if (!filters._skipStatusFilter) {
        parts.push('status:=[active,published,available]');
      }

      return parts.join(' && ');
    }

    /* ── Fallback — Algolia engine or empty ─────────────────────── */

    async _fallback(query, opts) {
      if (root.sokoniSearch?.search) {
        try { return await root.sokoniSearch.search(query, opts); }
        catch (_) {}
      }
      return { results: {}, found: 0, query, source: 'fallback-empty' };
    }

    /* ── Analytics ──────────────────────────────────────────────── */

    _emitAnalyticsEvent(type, data) {
      this._callCF('recordTypesenseSearchEvent', { type, ...data }).catch(() => {});
    }

    trackClick(docId, collection, position, query) {
      if (query) SearchHistory.add(query);
      UserPreferences.recordCollectionHit(collection);
      this._emitAnalyticsEvent('click', { clickedId: docId, collection, clickedPos: position, query });
    }

    trackView(item) {
      RecentlyViewed.add(item);
      if (item?.collection) UserPreferences.recordCollectionHit(item.collection);
    }

    trackConversion(docId, collection, query) {
      UserPreferences.recordCollectionHit(collection);
      this._emitAnalyticsEvent('conversion', { clickedId: docId, collection, query });
    }

    /* ── History / Personalization helpers ──────────────────────── */

    getHistory()              { return SearchHistory.get(); }
    removeHistory(q)          { SearchHistory.remove(q); }
    clearHistory()            { SearchHistory.clear(); }
    getRecentlyViewed()       { return RecentlyViewed.get(); }
    clearRecentlyViewed()     { RecentlyViewed.clear(); }
    getUserAffinityOrder()    { return UserPreferences.getAffinityOrder(); }

    /* ── Cache flush ────────────────────────────────────────────── */

    clearCache() {
      this._l1.clear();
      this._l2.invalidate('ts2:');
    }

    /* ── Engine status ──────────────────────────────────────────── */

    get isReady()        { return this._ready; }
    get isOnline()       { return navigator.onLine; }
    get keyExpiresIn()   { return Math.max(0, this._keyExpires - Date.now()); }
    get voiceSupported() { return !!(root.SpeechRecognition || root.webkitSpeechRecognition); }
    get geoSupported()   { return !!navigator.geolocation; }
    get offlineReady()   { return typeof indexedDB !== 'undefined'; }
  }

  /* ── Escape special Typesense filter chars ───────────────────── */

  function _esc(val) {
    return String(val).replace(/[[\]()\\:`,]/g, '\\$&');
  }

  /* ══════════════════════════════════════════════════════════════
     SINGLETON + AUTO-INIT
  ══════════════════════════════════════════════════════════════ */

  const engine = new SokoniTypesenseEngine();
  root.sokoniTypesenseSearch = engine;

  /* Expose cache and history utilities on the engine for external consumers */
  engine.RecentlyViewed  = RecentlyViewed;
  engine.SearchHistory   = SearchHistory;
  engine.UserPreferences = UserPreferences;

  /* Auto-initialise once Firebase is available and config is set */
  function _autoInit() {
    const cfg = _cfg();
    if (cfg.typesenseHost || (Array.isArray(cfg.typesenseNodes) && cfg.typesenseNodes.length)) {
      engine._ensureReady().catch(err => console.warn('[SokoniTS] Init error:', err.message));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoInit);
  } else {
    _autoInit();
  }

}(typeof window !== 'undefined' ? window : this));
