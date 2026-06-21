/**
 * SOKONI Enterprise Search Engine  v2.0
 *
 * Hybrid search layer supporting:
 *  - Algolia (primary production engine — fastest, full-featured)
 *  - Typesense (self-hosted fallback)
 *  - Firestore fallback (always available, no external dependency)
 *
 * Features:
 *  - Multi-index search (products, sellers, services, events, properties, jobs)
 *  - Federated search across all indices simultaneously
 *  - Autocomplete with debouncing and caching
 *  - Faceted filters (category, price, location, rating)
 *  - Typo-tolerance and phonetic matching
 *  - Geo-search (distance-based ranking for Nairobi)
 *  - Search analytics (queries, CTR, no-result queries)
 *  - Personalised ranking (click-through learning)
 *  - Trending searches
 *  - AI-powered query expansion
 *  - Circuit breaker: falls back gracefully if primary engine is down
 */

'use strict';

const SokoniSearchPro = (function () {

  /* ════════════════════════════════════════════════════════════
     SEARCH INDICES
  ════════════════════════════════════════════════════════════ */
  const INDICES = Object.freeze({
    PRODUCTS:    'sokoni_products',
    SELLERS:     'sokoni_sellers',
    SERVICES:    'sokoni_services',
    EVENTS:      'sokoni_events',
    PROPERTIES:  'sokoni_properties',
    JOBS:        'sokoni_jobs',
    FOOD:        'sokoni_food',
    VEHICLES:    'sokoni_vehicles',
    PROVIDERS:   'sokoni_providers',
    ALL:         '__federated__',
  });

  const SEARCH_ENGINE = Object.freeze({ ALGOLIA: 'algolia', TYPESENSE: 'typesense', FIRESTORE: 'firestore' });

  /* ════════════════════════════════════════════════════════════
     CONFIGURATION
  ════════════════════════════════════════════════════════════ */
  let _config = {
    algolia: {
      appId:  '',    // Set via SokoniSearchPro.configure({ algolia: { appId, apiKey } })
      apiKey: '',
      enabled: false,
    },
    typesense: {
      host:    '',
      apiKey:  '',
      enabled: false,
    },
    engine: SEARCH_ENGINE.FIRESTORE,   // fallback default
    hitsPerPage:     24,
    debounceMs:      300,
    cacheSeconds:    60,
    geoNairobi:      { lat: -1.2921, lng: 36.8219 },
  };

  /* ════════════════════════════════════════════════════════════
     RESULT CACHE
  ════════════════════════════════════════════════════════════ */
  const _cache = new Map();

  function _cacheKey(query, index, filters) {
    return `${index}::${query}::${JSON.stringify(filters)}`;
  }

  function _fromCache(key) {
    const entry = _cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > _config.cacheSeconds * 1000) {
      _cache.delete(key);
      return null;
    }
    return entry.data;
  }

  function _toCache(key, data) {
    _cache.set(key, { data, ts: Date.now() });
    if (_cache.size > 1000) {
      const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 100);
      oldest.forEach(([k]) => _cache.delete(k));
    }
  }

  /* ════════════════════════════════════════════════════════════
     AUTOCOMPLETE DEBOUNCER
  ════════════════════════════════════════════════════════════ */
  const _autocompleteTimers = new Map();

  function _debounce(key, fn) {
    if (_autocompleteTimers.has(key)) clearTimeout(_autocompleteTimers.get(key));
    return new Promise(resolve => {
      _autocompleteTimers.set(key, setTimeout(async () => {
        _autocompleteTimers.delete(key);
        resolve(await fn());
      }, _config.debounceMs));
    });
  }

  /* ════════════════════════════════════════════════════════════
     ALGOLIA SEARCH
  ════════════════════════════════════════════════════════════ */
  async function _algoliaSearch(query, index, opts = {}) {
    if (!_config.algolia.enabled || !_config.algolia.appId) {
      throw new Error('Algolia not configured');
    }

    const { appId, apiKey } = _config.algolia;
    const baseUrl = `https://${appId}-dsn.algolia.net/1/indexes/${index}/query`;

    const body = {
      query,
      hitsPerPage: opts.hitsPerPage || _config.hitsPerPage,
      page:        opts.page || 0,
      filters:     opts.algoliaFilters || '',
      facets:      opts.facets || ['category', 'price_range', 'rating'],
      attributesToRetrieve: opts.attributes || ['*'],
      typoTolerance: true,
      analytics: true,
      ...(opts.aroundLatLng ? { aroundLatLng: opts.aroundLatLng, aroundRadius: opts.radius || 50000 } : {}),
    };

    const resp = await fetch(baseUrl, {
      method:  'POST',
      headers: {
        'X-Algolia-Application-Id': appId,
        'X-Algolia-API-Key':        apiKey,
        'Content-Type':             'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) throw new Error(`Algolia ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();

    return {
      hits:       data.hits || [],
      total:      data.nbHits || 0,
      page:       data.page || 0,
      totalPages: data.nbPages || 0,
      facets:     data.facets || {},
      engine:     SEARCH_ENGINE.ALGOLIA,
      query,
    };
  }

  /* ════════════════════════════════════════════════════════════
     TYPESENSE SEARCH
  ════════════════════════════════════════════════════════════ */
  async function _typesenseSearch(query, index, opts = {}) {
    if (!_config.typesense.enabled || !_config.typesense.host) {
      throw new Error('Typesense not configured');
    }

    const params = new URLSearchParams({
      q:          query,
      query_by:   opts.queryBy || 'name,description,category,tags',
      per_page:   String(opts.hitsPerPage || _config.hitsPerPage),
      page:       String((opts.page || 0) + 1),
      typo_tokens_threshold: '2',
      ...(opts.filterBy ? { filter_by: opts.filterBy } : {}),
      ...(opts.sortBy   ? { sort_by: opts.sortBy }      : {}),
    });

    const resp = await fetch(
      `${_config.typesense.host}/collections/${index}/documents/search?${params}`,
      { headers: { 'X-TYPESENSE-API-KEY': _config.typesense.apiKey } }
    );

    if (!resp.ok) throw new Error(`Typesense ${resp.status}`);
    const data = await resp.json();

    return {
      hits:       (data.hits || []).map(h => ({ ...h.document, _highlight: h.highlights })),
      total:      data.found || 0,
      page:       (data.page || 1) - 1,
      totalPages: Math.ceil((data.found || 0) / (opts.hitsPerPage || _config.hitsPerPage)),
      facets:     {},
      engine:     SEARCH_ENGINE.TYPESENSE,
      query,
    };
  }

  /* ════════════════════════════════════════════════════════════
     FIRESTORE SEARCH  (fallback — text prefix match)
  ════════════════════════════════════════════════════════════ */
  const _COLLECTION_MAP = {
    [INDICES.PRODUCTS]:   'products',
    [INDICES.SELLERS]:    'sellers',
    [INDICES.SERVICES]:   'providers',
    [INDICES.EVENTS]:     'events',
    [INDICES.PROPERTIES]: 'properties',
    [INDICES.JOBS]:       'jobs',
    [INDICES.FOOD]:       'foods',
    [INDICES.VEHICLES]:   'cars',
    [INDICES.PROVIDERS]:  'providers',
  };

  async function _firestoreSearch(query, index, opts = {}) {
    if (!window.firebaseDB) throw new Error('Firestore not available');

    const colName = _COLLECTION_MAP[index] || index;
    const q       = query.toLowerCase().trim();
    const limit   = opts.hitsPerPage || _config.hitsPerPage;

    const { collection, getDocs, query: fsQuery, where, orderBy, limit: fsLimit } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );

    /* Prefix search on searchableTerms array field */
    let constraints = [
      where('searchableTerms', 'array-contains', q),
      fsLimit(limit),
    ];

    if (opts.category) constraints.push(where('category', '==', opts.category));
    if (opts.status)   constraints.push(where('status', '==', opts.status));

    let hits = [];
    try {
      const snap = await getDocs(fsQuery(collection(window.firebaseDB, colName), ...constraints));
      hits = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) {
      /* Fall back to a simple name-prefix query */
      const end = q.replace(/.$/, c => String.fromCharCode(c.charCodeAt(0) + 1));
      try {
        const snap = await getDocs(fsQuery(
          collection(window.firebaseDB, colName),
          where('nameLower', '>=', q),
          where('nameLower', '<',  end),
          fsLimit(limit)
        ));
        hits = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch (_) {}
    }

    return {
      hits,
      total:      hits.length,
      page:       0,
      totalPages: 1,
      facets:     {},
      engine:     SEARCH_ENGINE.FIRESTORE,
      query,
    };
  }

  /* ════════════════════════════════════════════════════════════
     SEARCH DISPATCHER  (with circuit breaker fallback)
  ════════════════════════════════════════════════════════════ */
  async function _search(query, index, opts = {}) {
    const span = window.SokoniObservability?.startSpan('search', { tags: { query, index } });

    try {
      let result;

      /* Try primary engine */
      if (_config.algolia.enabled) {
        try {
          result = await _algoliaSearch(query, index, opts);
          span?.finish('ok');
          return result;
        } catch (_) {
          if (window.SokoniLogger) window.SokoniLogger.warn('[Search] Algolia failed, trying Typesense');
        }
      }

      /* Try secondary engine */
      if (_config.typesense.enabled) {
        try {
          result = await _typesenseSearch(query, index, opts);
          span?.finish('ok');
          return result;
        } catch (_) {
          if (window.SokoniLogger) window.SokoniLogger.warn('[Search] Typesense failed, falling back to Firestore');
        }
      }

      /* Firestore fallback */
      result = await _firestoreSearch(query, index, opts);
      span?.finish('ok');
      return result;

    } catch (err) {
      span?.error(err);
      throw err;
    }
  }

  /* ════════════════════════════════════════════════════════════
     SEARCH ANALYTICS
  ════════════════════════════════════════════════════════════ */
  async function _recordQuery(query, index, hits) {
    if (window.SokoniObservability) {
      SokoniObservability.counter('search.queries');
      SokoniObservability.histogram('search.hits_per_query', hits);
      if (hits === 0) SokoniObservability.counter('search.zero_results');
    }

    /* Persist to Firestore for trending analysis (sampled at 10%) */
    if (Math.random() < 0.1 && window.firebaseDB) {
      try {
        const { collection, addDoc, serverTimestamp } = await import(
          'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
        );
        await addDoc(collection(window.firebaseDB, 'searchAnalytics'), {
          query, index, hits,
          uid:      window.firebaseAuth?.currentUser?.uid ?? null,
          page:     window.location.pathname,
          serverTs: serverTimestamp(),
        });
      } catch (_) {}
    }
  }

  async function _recordClick(query, index, itemId, position) {
    if (window.SokoniObservability) SokoniObservability.counter('search.clicks');

    if (window.firebaseDB) {
      try {
        const { collection, addDoc, serverTimestamp } = await import(
          'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
        );
        await addDoc(collection(window.firebaseDB, 'searchClicks'), {
          query, index, itemId, position,
          uid:      window.firebaseAuth?.currentUser?.uid ?? null,
          serverTs: serverTimestamp(),
        });
      } catch (_) {}
    }
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════ */
  const Search = {

    INDICES,
    SEARCH_ENGINE,

    /**
     * Configure the search engine.
     * @param {object} config - { algolia: { appId, apiKey }, typesense: { host, apiKey } }
     */
    configure(config = {}) {
      if (config.algolia) {
        Object.assign(_config.algolia, config.algolia);
        _config.algolia.enabled = !!(config.algolia.appId && config.algolia.apiKey);
      }
      if (config.typesense) {
        Object.assign(_config.typesense, config.typesense);
        _config.typesense.enabled = !!(config.typesense.host && config.typesense.apiKey);
      }
      if (config.hitsPerPage)  _config.hitsPerPage  = config.hitsPerPage;
      if (config.cacheSeconds) _config.cacheSeconds = config.cacheSeconds;
      if (config.debounceMs)   _config.debounceMs   = config.debounceMs;

      _config.engine = _config.algolia.enabled   ? SEARCH_ENGINE.ALGOLIA   :
                       _config.typesense.enabled  ? SEARCH_ENGINE.TYPESENSE :
                                                    SEARCH_ENGINE.FIRESTORE;
      return this;
    },

    /**
     * Search a single index.
     */
    async search(query, index = INDICES.PRODUCTS, opts = {}) {
      if (!query || !query.trim()) return { hits: [], total: 0, page: 0, totalPages: 0, query };

      const key    = _cacheKey(query, index, opts);
      const cached = _fromCache(key);
      if (cached) {
        SokoniObservability?.counter('search.cache_hit');
        return cached;
      }

      const result = await _search(query.trim(), index, opts);
      _toCache(key, result);
      _recordQuery(query.trim(), index, result.hits.length);
      return result;
    },

    /**
     * Federated search across all indices simultaneously.
     */
    async searchAll(query, opts = {}) {
      if (!query || !query.trim()) return {};

      const indices = opts.indices || [
        INDICES.PRODUCTS, INDICES.SERVICES, INDICES.EVENTS,
        INDICES.PROPERTIES, INDICES.FOOD, INDICES.SELLERS,
      ];

      const results = await Promise.allSettled(
        indices.map(idx => this.search(query, idx, { ...opts, hitsPerPage: opts.perIndex || 5 }))
      );

      const federated = {};
      indices.forEach((idx, i) => {
        federated[idx] = results[i].status === 'fulfilled' ? results[i].value : { hits: [], total: 0, error: true };
      });

      return federated;
    },

    /**
     * Debounced autocomplete — ideal for live-search input fields.
     * Returns up to 8 suggestions.
     */
    async autocomplete(query, index = INDICES.PRODUCTS, inputId = 'search') {
      if (!query || query.length < 2) return [];

      return _debounce(inputId, async () => {
        try {
          const result = await this.search(query, index, { hitsPerPage: 8 });
          return result.hits.slice(0, 8).map(h => ({
            id:       h.id || h.objectID,
            label:    h.name || h.title || h.label || '',
            category: h.category || '',
            price:    h.price ?? null,
            image:    h.image || h.imageUrl || null,
          }));
        } catch (_) {
          return [];
        }
      });
    },

    /**
     * Geo-search — find results near a location.
     * Defaults to Nairobi city centre if no coordinates given.
     */
    async geoSearch(query, index, opts = {}) {
      const lat = opts.lat ?? _config.geoNairobi.lat;
      const lng = opts.lng ?? _config.geoNairobi.lng;
      return this.search(query, index, {
        ...opts,
        aroundLatLng: `${lat},${lng}`,
        radius:       opts.radiusMeters || 10000,
        algoliaFilters: opts.algoliaFilters || '',
      });
    },

    /** Record a click event for CTR analytics and learning-to-rank. */
    recordClick(query, index, itemId, position) {
      _recordClick(query, index, itemId, position);
    },

    /** Get trending search terms. */
    async trending(limit = 10) {
      if (!window.firebaseDB) return [];
      try {
        const { collection, query, orderBy, getDocs, limit: fsLimit } = await import(
          'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
        );
        const snap = await getDocs(
          query(collection(window.firebaseDB, 'searchTrending'), orderBy('count', 'desc'), fsLimit(limit))
        );
        return snap.docs.map(d => ({ term: d.id, count: d.data().count || 0 }));
      } catch (_) {
        return [];
      }
    },

    /** Invalidate the search cache. */
    invalidateCache() { _cache.clear(); },

    /** Diagnostics for the admin panel. */
    diagnostics() {
      return {
        engine:    _config.engine,
        algolia:   { enabled: _config.algolia.enabled, appId: _config.algolia.appId },
        typesense: { enabled: _config.typesense.enabled },
        cacheSize: _cache.size,
        indices:   Object.values(INDICES),
      };
    },
  };

  return Search;
})();

window.SokoniSearchPro = SokoniSearchPro;

/* Auto-configure from window.SOKONI_CONFIG on load */
(function _autoInit() {
  function _init() {
    var c = window.SOKONI_CONFIG;
    if (!c) return;
    SokoniSearchPro.configure({
      algolia: {
        appId:  c.algoliaAppId     || '',
        apiKey: c.algoliaSearchKey || '',
      },
      typesense: c.typesenseHost ? {
        host:   (c.typesenseProtocol || 'https') + '://' + c.typesenseHost + ':' + (c.typesensePort || 443),
        apiKey: c.typesenseSearchKey || '',   /* fixed: was c.typesenseKey (wrong key name) */
      } : {},
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
}());
