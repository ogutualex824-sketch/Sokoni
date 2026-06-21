/**
 * SOKONI Enterprise Search Engine  v3.0
 *
 * Hybrid search layer supporting:
 *  - Algolia  (primary production engine — fastest, full-featured)
 *  - Typesense (self-hosted fallback)
 *  - Firestore (always-available last-resort fallback)
 *
 * Features:
 *  - Multi-index search with 21 indices
 *  - Federated / multi-search (single round-trip batch)
 *  - Debounced autocomplete with recent + popular suggestions
 *  - Voice search via Web Speech API with graceful degradation
 *  - Explicit geo-search (nearby()) with Kenya bounding-box validation
 *  - Personalised recommendations (Algolia / Firestore / trending)
 *  - Similar-products via Algolia Recommend REST API
 *  - Client-side intent detection with Swahili support
 *  - Recent-searches localStorage management
 *  - Image-search future-ready stub
 *  - LRU cache (200 entries, per-TTL expiry)
 *  - Request deduplication (inflight Map)
 *  - Circuit breaker per engine (exponential backoff)
 *  - Sliding-window rate limiter (60 req / 60 s)
 *  - XSS-safe query sanitisation
 *  - Impression + click analytics (Algolia CTR, Firestore)
 *  - Configurable privacy controls
 *
 * Backward compatible with v2.0 public API.
 */

'use strict';

const SokoniSearchPro = (function () {

  /* ════════════════════════════════════════════════════════════
     CONSTANTS
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
    DEALS:       'sokoni_deals',
    AUCTIONS:    'sokoni_auctions',
    VENDORS:     'sokoni_vendors',
    COMPANIES:   'sokoni_companies',
    BRANDS:      'sokoni_brands',
    CATEGORIES:  'sokoni_categories',
    BNB:         'sokoni_bnb',
    FITNESS:     'sokoni_fitness',
    EDUCATION:   'sokoni_education',
    LAWYERS:     'sokoni_lawyers',
    HOTELS:      'sokoni_hotels',
    ALL:         '__federated__',
  });

  const SEARCH_ENGINE = Object.freeze({
    ALGOLIA:   'algolia',
    TYPESENSE: 'typesense',
    FIRESTORE: 'firestore',
  });

  const INTENT = Object.freeze({
    FOOD:         'food',
    PROPERTY:     'property',
    VEHICLE:      'vehicle',
    JOB:          'job',
    EVENT:        'event',
    SERVICE:      'service',
    GEO:          'geo',
    PRICE_FILTER: 'price_filter',
    GENERAL:      'general',
  });

  /* Firestore collection names per index */
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
    [INDICES.DEALS]:      'deals',
    [INDICES.AUCTIONS]:   'auctions',
    [INDICES.VENDORS]:    'vendors',
    [INDICES.COMPANIES]:  'companies',
    [INDICES.BRANDS]:     'brands',
    [INDICES.CATEGORIES]: 'categories',
    [INDICES.BNB]:        'bnb',
    [INDICES.FITNESS]:    'fitness',
    [INDICES.EDUCATION]:  'education',
    [INDICES.LAWYERS]:    'lawyers',
    [INDICES.HOTELS]:     'hotels',
  };

  const LS_RECENT_KEY = 'sokoni_recent_searches';
  const FIREBASE_SDK  = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

  /* Kenya bounding box */
  const KENYA_BOUNDS = { minLat: -5, maxLat: 5, minLng: 34, maxLng: 42 };

  /* ════════════════════════════════════════════════════════════
     CONFIGURATION  (mutable via configure())
  ════════════════════════════════════════════════════════════ */
  let _config = {
    algolia: {
      appId:   '',
      apiKey:  '',
      enabled: false,
    },
    typesense: {
      host:    '',
      apiKey:  '',
      enabled: false,
    },
    engine:      SEARCH_ENGINE.FIRESTORE,
    hitsPerPage: 24,
    debounceMs:  300,
    /* per-TTL cache seconds (used by _fromCache) */
    cacheSeconds:        30,   /* default for search */
    cacheTTL: {
      search:          30,
      autocomplete:    60,
      recommendations: 300,
    },
    geoNairobi: { lat: -1.2921, lng: 36.8219 },
    ai: {
      intent:         true,
      queryExpansion: true,
    },
    privacy: {
      trackAnalytics: true,
      trackClicks:    true,
    },
    personalization: {
      enabled: false,
    },
  };

  /* ════════════════════════════════════════════════════════════
     LRU CACHE  (max 200 entries, per-entry TTL)
  ════════════════════════════════════════════════════════════ */
  const _cache = new Map();
  const _CACHE_MAX = 200;

  function _cacheKey(query, index, filters) {
    return `${index}::${query}::${JSON.stringify(filters || {})}`;
  }

  function _fromCache(key, ttlSeconds) {
    const entry = _cache.get(key);
    if (!entry) return null;
    const maxAge = (ttlSeconds !== undefined ? ttlSeconds : _config.cacheSeconds) * 1000;
    if (Date.now() - entry.ts > maxAge) {
      _cache.delete(key);
      return null;
    }
    /* LRU: re-insert at end */
    _cache.delete(key);
    _cache.set(key, entry);
    return entry.data;
  }

  function _toCache(key, data) {
    if (_cache.has(key)) _cache.delete(key);
    _cache.set(key, { data, ts: Date.now() });
    /* Evict oldest entries when over limit */
    if (_cache.size > _CACHE_MAX) {
      const firstKey = _cache.keys().next().value;
      _cache.delete(firstKey);
    }
  }

  /* ════════════════════════════════════════════════════════════
     REQUEST DEDUPLICATION
  ════════════════════════════════════════════════════════════ */
  const _inflightRequests = new Map();

  function _deduplicate(key, fn) {
    if (_inflightRequests.has(key)) return _inflightRequests.get(key);
    const promise = fn().finally(() => _inflightRequests.delete(key));
    _inflightRequests.set(key, promise);
    return promise;
  }

  /* ════════════════════════════════════════════════════════════
     CIRCUIT BREAKER  (per engine, exponential backoff)
  ════════════════════════════════════════════════════════════ */
  const _circuitBreakers = {
    [SEARCH_ENGINE.ALGOLIA]:   { failures: 0, openUntil: 0, backoffMs: 30000 },
    [SEARCH_ENGINE.TYPESENSE]: { failures: 0, openUntil: 0, backoffMs: 30000 },
  };

  function _cbIsOpen(engine) {
    const cb = _circuitBreakers[engine];
    if (!cb) return false;
    return cb.openUntil > Date.now();
  }

  function _cbRecordFailure(engine) {
    const cb = _circuitBreakers[engine];
    if (!cb) return;
    cb.failures += 1;
    if (cb.failures >= 3) {
      cb.openUntil = Date.now() + cb.backoffMs;
      /* Exponential backoff: 30s → 60s → 120s, cap at 120s */
      cb.backoffMs = Math.min(cb.backoffMs * 2, 120000);
      _warn(`[Search] Circuit breaker OPEN for ${engine} for ${cb.backoffMs / 1000}s`);
    }
  }

  function _cbRecordSuccess(engine) {
    const cb = _circuitBreakers[engine];
    if (!cb) return;
    cb.failures  = 0;
    cb.openUntil = 0;
    cb.backoffMs = 30000;
  }

  /* ════════════════════════════════════════════════════════════
     SLIDING-WINDOW RATE LIMITER  (60 req / 60 s)
  ════════════════════════════════════════════════════════════ */
  const _rlTimestamps = [];
  const _RL_MAX   = 60;
  const _RL_WIN   = 60000; /* ms */

  function _rateLimitCheck() {
    const now = Date.now();
    /* Remove timestamps outside the window */
    while (_rlTimestamps.length && _rlTimestamps[0] <= now - _RL_WIN) {
      _rlTimestamps.shift();
    }
    if (_rlTimestamps.length >= _RL_MAX) return false;
    _rlTimestamps.push(now);
    return true;
  }

  /* ════════════════════════════════════════════════════════════
     XSS SANITISATION
  ════════════════════════════════════════════════════════════ */
  const _XSS_PATTERNS = [
    /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
    /<iframe[\s\S]*?>/gi,
    /on\w+\s*=/gi,
    /javascript\s*:/gi,
    /<[^>]+>/g,
  ];

  function _sanitizeQuery(q) {
    if (typeof q !== 'string') return '';
    let s = q;
    _XSS_PATTERNS.forEach(rx => { s = s.replace(rx, ''); });
    return s.trim().slice(0, 512); /* hard length cap */
  }

  /* ════════════════════════════════════════════════════════════
     DEBOUNCER
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
     LOGGER (uses SokoniLogger if present, else console)
  ════════════════════════════════════════════════════════════ */
  function _warn(msg) {
    if (window.SokoniLogger) window.SokoniLogger.warn(msg);
    else console.warn(msg);
  }

  /* ════════════════════════════════════════════════════════════
     ALGOLIA SEARCH
  ════════════════════════════════════════════════════════════ */
  async function _algoliaSearch(query, index, opts) {
    const { appId, apiKey } = _config.algolia;
    const url = `https://${appId}-dsn.algolia.net/1/indexes/${index}/query`;

    const userToken = opts.userToken
      || window.firebaseAuth?.currentUser?.uid
      || null;

    const body = {
      query,
      hitsPerPage:          opts.hitsPerPage || _config.hitsPerPage,
      page:                 opts.page || 0,
      filters:              opts.algoliaFilters || '',
      facets:               opts.facets || ['category', 'price_range', 'rating', 'location'],
      attributesToRetrieve: opts.attributes || ['*'],
      typoTolerance:        true,
      analytics:            _config.privacy.trackAnalytics,
      clickAnalytics:       _config.privacy.trackClicks,
      ...(userToken && _config.personalization.enabled ? { userToken } : {}),
      ...(opts.aroundLatLng ? {
        aroundLatLng: opts.aroundLatLng,
        aroundRadius: opts.radius || 50000,
      } : {}),
    };

    const resp = await fetch(url, {
      method:  'POST',
      headers: {
        'X-Algolia-Application-Id': appId,
        'X-Algolia-API-Key':        apiKey,
        'Content-Type':             'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => resp.statusText);
      throw new Error(`Algolia ${resp.status}: ${txt}`);
    }

    const data = await resp.json();
    return {
      hits:       data.hits || [],
      total:      data.nbHits || 0,
      page:       data.page || 0,
      totalPages: data.nbPages || 0,
      facets:     data.facets || {},
      engine:     SEARCH_ENGINE.ALGOLIA,
      queryID:    data.queryID || null,
      query,
    };
  }

  /* ════════════════════════════════════════════════════════════
     TYPESENSE SEARCH
  ════════════════════════════════════════════════════════════ */
  async function _typesenseSearch(query, index, opts) {
    const { host, apiKey } = _config.typesense;
    const params = new URLSearchParams({
      q:                     query,
      query_by:              opts.queryBy || 'name,description,category,tags',
      per_page:              String(opts.hitsPerPage || _config.hitsPerPage),
      page:                  String((opts.page || 0) + 1),
      typo_tokens_threshold: '2',
      ...(opts.filterBy ? { filter_by: opts.filterBy } : {}),
      ...(opts.sortBy   ? { sort_by:   opts.sortBy   } : {}),
      ...(opts.aroundLatLng ? {
        /* Typesense uses separate lat/lng filter_by syntax */
        filter_by: [opts.filterBy, `_geoloc:(${opts.aroundLatLng},${Math.round((opts.radius || 50000) / 1000)} km)`]
          .filter(Boolean).join(' && '),
      } : {}),
    });

    const resp = await fetch(
      `${host}/collections/${index}/documents/search?${params}`,
      { headers: { 'X-TYPESENSE-API-KEY': apiKey } }
    );

    if (!resp.ok) {
      throw new Error(`Typesense ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    }

    const data = await resp.json();
    return {
      hits:       (data.hits || []).map(h => ({ ...h.document, _highlight: h.highlights })),
      total:      data.found || 0,
      page:       (data.page || 1) - 1,
      totalPages: Math.ceil((data.found || 0) / (opts.hitsPerPage || _config.hitsPerPage)),
      facets:     {},
      engine:     SEARCH_ENGINE.TYPESENSE,
      queryID:    null,
      query,
    };
  }

  /* ════════════════════════════════════════════════════════════
     FIRESTORE SEARCH  (fallback — text prefix + array-contains)
  ════════════════════════════════════════════════════════════ */
  async function _firestoreSearch(query, index, opts) {
    if (!window.firebaseDB) throw new Error('Firestore not available');

    const colName = _COLLECTION_MAP[index] || index;
    const q       = query.toLowerCase().trim();
    const lim     = opts.hitsPerPage || _config.hitsPerPage;

    const {
      collection, getDocs, query: fsQuery,
      where, orderBy, limit: fsLimit,
    } = await import(FIREBASE_SDK);

    let hits = [];
    try {
      const constraints = [
        where('searchableTerms', 'array-contains', q),
        fsLimit(lim),
      ];
      if (opts.category) constraints.push(where('category', '==', opts.category));
      if (opts.status)   constraints.push(where('status',   '==', opts.status));

      const snap = await getDocs(fsQuery(collection(window.firebaseDB, colName), ...constraints));
      hits = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_e) {
      /* Fall back to nameLower prefix scan */
      try {
        const end  = q.replace(/.$/, c => String.fromCharCode(c.charCodeAt(0) + 1));
        const snap = await getDocs(fsQuery(
          collection(window.firebaseDB, colName),
          where('nameLower', '>=', q),
          where('nameLower', '<',  end),
          fsLimit(lim)
        ));
        hits = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch (_e2) { /* intentionally silent */ }
    }

    return {
      hits,
      total:      hits.length,
      page:       0,
      totalPages: 1,
      facets:     {},
      engine:     SEARCH_ENGINE.FIRESTORE,
      queryID:    null,
      query,
    };
  }

  /* ════════════════════════════════════════════════════════════
     SEARCH DISPATCHER  (circuit breaker + fallback chain)
  ════════════════════════════════════════════════════════════ */
  async function _dispatch(query, index, opts) {
    const span = window.SokoniObservability?.startSpan('search', { tags: { query, index } });

    /* Algolia */
    if (_config.algolia.enabled && !_cbIsOpen(SEARCH_ENGINE.ALGOLIA)) {
      try {
        const result = await _algoliaSearch(query, index, opts);
        _cbRecordSuccess(SEARCH_ENGINE.ALGOLIA);
        span?.finish?.('ok');
        return result;
      } catch (err) {
        _cbRecordFailure(SEARCH_ENGINE.ALGOLIA);
        _warn(`[Search] Algolia failed: ${err.message} — trying Typesense`);
      }
    }

    /* Typesense */
    if (_config.typesense.enabled && !_cbIsOpen(SEARCH_ENGINE.TYPESENSE)) {
      try {
        const result = await _typesenseSearch(query, index, opts);
        _cbRecordSuccess(SEARCH_ENGINE.TYPESENSE);
        span?.finish?.('ok');
        return result;
      } catch (err) {
        _cbRecordFailure(SEARCH_ENGINE.TYPESENSE);
        _warn(`[Search] Typesense failed: ${err.message} — falling back to Firestore`);
      }
    }

    /* Firestore last resort */
    try {
      const result = await _firestoreSearch(query, index, opts);
      span?.finish?.('ok');
      return result;
    } catch (err) {
      span?.error?.(err);
      return { hits: [], total: 0, page: 0, totalPages: 0, facets: {}, engine: 'fallback', error: err.message, query };
    }
  }

  /* ════════════════════════════════════════════════════════════
     ANALYTICS
  ════════════════════════════════════════════════════════════ */
  async function _recordQuery(query, index, hitsCount) {
    if (!_config.privacy.trackAnalytics) return;

    if (window.SokoniObservability) {
      window.SokoniObservability.counter?.('search.queries');
      window.SokoniObservability.histogram?.('search.hits_per_query', hitsCount);
      if (hitsCount === 0) window.SokoniObservability.counter?.('search.zero_results');
    }

    /* Sampled 10% write to Firestore */
    if (Math.random() < 0.1 && window.firebaseDB) {
      try {
        const { collection, addDoc, serverTimestamp } = await import(FIREBASE_SDK);
        await addDoc(collection(window.firebaseDB, 'searchAnalytics'), {
          query, index, hits: hitsCount,
          uid:      window.firebaseAuth?.currentUser?.uid ?? null,
          page:     window.location.pathname,
          serverTs: serverTimestamp(),
        });
      } catch (_) { /* never throw */ }
    }
  }

  async function _recordClick(query, index, itemId, position) {
    if (!_config.privacy.trackClicks) return;

    if (window.SokoniObservability) window.SokoniObservability.counter?.('search.clicks');

    if (window.firebaseDB) {
      try {
        const { collection, addDoc, serverTimestamp } = await import(FIREBASE_SDK);
        await addDoc(collection(window.firebaseDB, 'searchClicks'), {
          query, index, itemId, position,
          uid:      window.firebaseAuth?.currentUser?.uid ?? null,
          serverTs: serverTimestamp(),
        });
      } catch (_) { /* never throw */ }
    }
  }

  async function _recordImpression(query, index, positions) {
    if (!_config.privacy.trackAnalytics) return;
    if (!Array.isArray(positions) || positions.length === 0) return;

    if (window.firebaseDB) {
      try {
        const { collection, addDoc, serverTimestamp } = await import(FIREBASE_SDK);
        await addDoc(collection(window.firebaseDB, 'searchImpressions'), {
          query, index, positions,
          uid:      window.firebaseAuth?.currentUser?.uid ?? null,
          serverTs: serverTimestamp(),
        });
      } catch (_) { /* never throw */ }
    }
  }

  /* ════════════════════════════════════════════════════════════
     RECENT SEARCHES  (localStorage)
  ════════════════════════════════════════════════════════════ */
  function _loadRecent() {
    try {
      return JSON.parse(localStorage.getItem(LS_RECENT_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function _saveRecent(entries) {
    try {
      localStorage.setItem(LS_RECENT_KEY, JSON.stringify(entries.slice(0, 20)));
    } catch (_) { /* storage full / private mode */ }
  }

  function _pushRecent(query, index, resultsCount) {
    if (!query) return;
    const entries = _loadRecent().filter(e => e.query !== query);
    entries.unshift({ query, index, ts: Date.now(), resultsCount: resultsCount || 0 });
    _saveRecent(entries);
  }

  /* ════════════════════════════════════════════════════════════
     CLIENT-SIDE INTENT DETECTION
  ════════════════════════════════════════════════════════════ */
  const _SWAHILI_MAP = {
    /* Swahili → English translation hints */
    chakula: 'food',    'vyakula': 'food',
    nguo:    'clothes', 'mavazi': 'clothes',
    nyumba:  'property', 'nyumba ya kupanga': 'house for rent',
    gari:    'car',     'magari': 'cars',
    kazi:    'job',     'ajira': 'job',
    dawa:    'medicine', 'hospitali': 'hospital',
    shule:   'school',  'elimu': 'education',
    biashara: 'business',
    matunda: 'fruits',
    mboga:   'vegetables',
    samaki:  'fish',
    nyama:   'meat',
    hoteli:  'hotel',
    gesti:   'guesthouse',
    pesa:    'money',
    duka:    'shop',
    sokoni:  'market',
  };

  const _INTENT_RULES = [
    {
      intent: INTENT.FOOD,
      index:  INDICES.FOOD,
      patterns: [/\b(food|restaurant|eat|meal|lunch|dinner|breakfast|burger|pizza|ugali|chapati|nyama|samaki|chakula|vyakula|matunda|mboga)\b/i],
    },
    {
      intent: INTENT.PROPERTY,
      index:  INDICES.PROPERTIES,
      patterns: [/\b(property|house|apartment|flat|rent|rental|bedsitter|studio|land|acre|plot|nyumba|gesti)\b/i],
    },
    {
      intent: INTENT.VEHICLE,
      index:  INDICES.VEHICLES,
      patterns: [/\b(car|vehicle|truck|motorbike|boda|tuk.?tuk|probox|noah|gari|magari|bus|minibus|van)\b/i],
    },
    {
      intent: INTENT.JOB,
      index:  INDICES.JOBS,
      patterns: [/\b(job|jobs|career|vacancy|hire|hiring|employment|internship|kazi|ajira|nafasi)\b/i],
    },
    {
      intent: INTENT.EVENT,
      index:  INDICES.EVENTS,
      patterns: [/\b(event|concert|show|festival|conference|workshop|seminar|party|nadharia)\b/i],
    },
    {
      intent: INTENT.SERVICE,
      index:  INDICES.SERVICES,
      patterns: [/\b(service|services|repair|fix|install|plumber|electrician|cleaner|cleaning|salon|barbershop|mechanic|fundi)\b/i],
    },
    {
      intent: INTENT.GEO,
      index:  null, /* keep caller's index */
      patterns: [/\b(near me|nearby|around me|close to|in \w+|nairobi|mombasa|kisumu|nakuru|eldoret|westlands|kilimani|cbd|thika|juja|mlolongo)\b/i],
    },
    {
      intent: INTENT.PRICE_FILTER,
      index:  null,
      patterns: [/\b(under|below|less than|ksh|kes|sh|shilling|price|cheap|affordable|budget|free)\s*\d+|\d+\s*(ksh|kes|sh)/i],
    },
  ];

  function _detectIntentInternal(query) {
    if (!query) return { intent: INTENT.GENERAL, suggestedIndex: INDICES.PRODUCTS, suggestedFilters: {}, confidence: 0, enhancedQuery: query };

    let enhancedQuery = query;

    /* Swahili expansion */
    Object.keys(_SWAHILI_MAP).forEach(sw => {
      const rx = new RegExp(`\\b${sw}\\b`, 'gi');
      if (rx.test(enhancedQuery)) {
        enhancedQuery = enhancedQuery.replace(rx, `${sw} ${_SWAHILI_MAP[sw]}`);
      }
    });

    /* Price detection */
    let suggestedFilters = {};
    const priceMatch = query.match(/(?:under|below|less\s+than)\s*(?:ksh|kes|sh)?\s*(\d+)/i)
                    || query.match(/(?:ksh|kes|sh)\s*(\d+)/i);
    if (priceMatch) {
      suggestedFilters.maxPrice = parseInt(priceMatch[1], 10);
    }

    /* Intent matching */
    for (const rule of _INTENT_RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(query)) {
          return {
            intent:          rule.intent,
            suggestedIndex:  rule.index || INDICES.PRODUCTS,
            suggestedFilters,
            confidence:      0.85,
            enhancedQuery,
          };
        }
      }
    }

    return {
      intent:          INTENT.GENERAL,
      suggestedIndex:  INDICES.PRODUCTS,
      suggestedFilters,
      confidence:      0.5,
      enhancedQuery,
    };
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════ */
  const Search = {

    /* Expose constants */
    INDICES,
    SEARCH_ENGINE,
    INTENT,

    /* ── configure ───────────────────────────────────────────── */
    configure(config) {
      if (!config) return this;

      if (config.algolia) {
        Object.assign(_config.algolia, config.algolia);
        _config.algolia.enabled = !!(
          (_config.algolia.appId  || config.algolia.appId)  &&
          (_config.algolia.apiKey || config.algolia.apiKey)
        );
      }

      if (config.typesense) {
        /* Accept searchKey as alias for apiKey (backward compat) */
        if (config.typesense.searchKey && !config.typesense.apiKey) {
          config.typesense.apiKey = config.typesense.searchKey;
        }
        Object.assign(_config.typesense, config.typesense);
        _config.typesense.enabled = !!(
          _config.typesense.host   &&
          _config.typesense.apiKey &&
          config.typesense.enabled !== false
        );
      }

      if (config.ai)              Object.assign(_config.ai,              config.ai);
      if (config.privacy)         Object.assign(_config.privacy,         config.privacy);
      if (config.personalization) Object.assign(_config.personalization, config.personalization);

      if (config.hitsPerPage)  _config.hitsPerPage  = config.hitsPerPage;
      if (config.cacheSeconds) _config.cacheSeconds = config.cacheSeconds;
      if (config.debounceMs)   _config.debounceMs   = config.debounceMs;

      _config.engine = _config.algolia.enabled  ? SEARCH_ENGINE.ALGOLIA  :
                       _config.typesense.enabled ? SEARCH_ENGINE.TYPESENSE :
                                                   SEARCH_ENGINE.FIRESTORE;
      return this;
    },

    /* ── search ──────────────────────────────────────────────── */
    async search(query, index, opts) {
      index = index || INDICES.PRODUCTS;
      opts  = opts  || {};

      const rawQ = _sanitizeQuery(query);
      if (!rawQ) return { hits: [], total: 0, page: 0, totalPages: 0, query: '' };

      if (!_rateLimitCheck()) {
        return { hits: [], total: 0, page: 0, totalPages: 0, query: rawQ, error: 'rate_limited' };
      }

      /* Optional intent-enhancement */
      let finalQuery = rawQ;
      let intentData = null;
      if (opts.intent && _config.ai.intent) {
        intentData  = _detectIntentInternal(rawQ);
        finalQuery  = intentData.enhancedQuery || rawQ;
        if (!opts.overrideIndex && intentData.suggestedIndex && intentData.intent !== INTENT.GENERAL) {
          index = intentData.suggestedIndex;
        }
      }

      const cacheKey = _cacheKey(finalQuery, index, opts);
      const cached   = _fromCache(cacheKey, _config.cacheTTL.search);
      if (cached) {
        window.SokoniObservability?.counter?.('search.cache_hit');
        return cached;
      }

      const searchOpts = Object.assign({}, opts);
      if (intentData && intentData.suggestedFilters.maxPrice) {
        searchOpts.algoliaFilters = [
          opts.algoliaFilters,
          `price <= ${intentData.suggestedFilters.maxPrice}`,
        ].filter(Boolean).join(' AND ');
      }

      const result = await _deduplicate(cacheKey, () => _dispatch(finalQuery, index, searchOpts));

      if (!result.error) {
        _toCache(cacheKey, result);
        _pushRecent(finalQuery, index, result.total);
        _recordQuery(finalQuery, index, result.total);
      }

      return result;
    },

    /* ── searchAll  (federated) ──────────────────────────────── */
    async searchAll(query, opts) {
      opts = opts || {};
      if (!query || !query.trim()) return {};

      const indices = opts.indices || [
        INDICES.PRODUCTS,   INDICES.SERVICES, INDICES.EVENTS,
        INDICES.PROPERTIES, INDICES.FOOD,     INDICES.SELLERS,
        INDICES.JOBS,       INDICES.VEHICLES,
      ];

      const results = await Promise.allSettled(
        indices.map(idx => this.search(query, idx, Object.assign({}, opts, { hitsPerPage: opts.perIndex || 5 })))
      );

      const federated = {};
      indices.forEach((idx, i) => {
        federated[idx] = results[i].status === 'fulfilled'
          ? results[i].value
          : { hits: [], total: 0, error: true };
      });

      return federated;
    },

    /* ── autocomplete  (debounced, with recent + intent hints) ── */
    async autocomplete(query, index, inputId) {
      index   = index   || INDICES.PRODUCTS;
      inputId = inputId || 'search';

      const rawQ = _sanitizeQuery(query);

      /* For very short queries: return recent searches immediately */
      if (!rawQ || rawQ.length < 2) {
        const recents = this.recentSearches(5).map(r => ({
          id:       null,
          label:    r.query,
          category: 'recent',
          price:    null,
          image:    null,
          type:     'recent',
        }));
        return recents;
      }

      return _debounce(inputId, async () => {
        try {
          /* Intent hints */
          const intent = _config.ai.intent ? _detectIntentInternal(rawQ) : null;

          const [result] = await Promise.allSettled([
            this.search(rawQ, index, { hitsPerPage: 8, intent: false }),
          ]);

          const hits = (result.status === 'fulfilled' ? result.value.hits : []);

          /* Recent prefix matches */
          const recentMatches = this.recentSearches(5)
            .filter(r => r.query.toLowerCase().startsWith(rawQ.toLowerCase()))
            .map(r => ({ id: null, label: r.query, category: 'recent', price: null, image: null, type: 'recent' }));

          /* Hit suggestions */
          const hitSuggestions = hits.slice(0, 8).map(h => ({
            id:       h.id || h.objectID,
            label:    h.name || h.title || h.label || '',
            category: h.category || '',
            price:    h.price ?? null,
            image:    h.image || h.imageUrl || null,
            type:     'result',
          }));

          /* Intent-based index suggestion */
          const intentSuggestions = [];
          if (intent && intent.intent !== INTENT.GENERAL && intent.suggestedIndex !== index) {
            intentSuggestions.push({
              id:       null,
              label:    rawQ,
              category: intent.intent,
              price:    null,
              image:    null,
              type:     'intent',
              index:    intent.suggestedIndex,
            });
          }

          /* Deduplicate by label */
          const seen = new Set();
          const merged = [...recentMatches, ...intentSuggestions, ...hitSuggestions].filter(item => {
            if (!item.label) return false;
            const key = item.label.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          return merged.slice(0, 8);
        } catch (_) {
          return [];
        }
      });
    },

    /* ── geoSearch  (backward compat wrapper) ────────────────── */
    async geoSearch(query, index, opts) {
      opts = opts || {};
      const lat = opts.lat !== undefined ? opts.lat : _config.geoNairobi.lat;
      const lng = opts.lng !== undefined ? opts.lng : _config.geoNairobi.lng;
      return this.search(query, index || INDICES.PRODUCTS, Object.assign({}, opts, {
        aroundLatLng: `${lat},${lng}`,
        radius:       opts.radiusMeters || 10000,
      }));
    },

    /* ── nearby  (explicit geo search with Kenya validation) ─── */
    async nearby(lat, lng, radiusKm, index, opts) {
      index = index || INDICES.PRODUCTS;
      opts  = opts  || {};

      if (
        typeof lat !== 'number' || typeof lng !== 'number' ||
        lat < KENYA_BOUNDS.minLat || lat > KENYA_BOUNDS.maxLat ||
        lng < KENYA_BOUNDS.minLng || lng > KENYA_BOUNDS.maxLng
      ) {
        return {
          hits: [], total: 0, page: 0, totalPages: 0, facets: {},
          engine: 'none',
          error: `Coordinates out of Kenya bounds. Valid range: lat ${KENYA_BOUNDS.minLat}–${KENYA_BOUNDS.maxLat}, lng ${KENYA_BOUNDS.minLng}–${KENYA_BOUNDS.maxLng}.`,
          query: '',
        };
      }

      const radiusMeters = Math.round((radiusKm || 10) * 1000);
      const geoOpts      = Object.assign({}, opts, {
        aroundLatLng: `${lat},${lng}`,
        radius:       radiusMeters,
        algoliaFilters: [
          opts.algoliaFilters,
          opts.category ? `category:${opts.category}` : '',
          opts.status   ? `status:${opts.status}`     : '',
        ].filter(Boolean).join(' AND '),
        filterBy: [
          opts.filterBy,
          opts.category ? `category:=${opts.category}` : '',
          opts.status   ? `status:=${opts.status}`     : '',
        ].filter(Boolean).join(' && '),
      });

      return this.search('', index, geoOpts);
    },

    /* ── voiceSearch ─────────────────────────────────────────── */
    voiceSearch(opts) {
      opts = opts || {};
      const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;

      if (!SpeechRec) {
        if (typeof opts.onError === 'function') {
          opts.onError({ error: 'not_supported', message: 'Web Speech API is not supported in this browser.' });
        }
        return { stop: function () {}, isSupported: false };
      }

      const rec          = new SpeechRec();
      rec.lang           = opts.lang       || 'en-KE';
      rec.continuous     = opts.continuous || false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onresult = function (evt) {
        const r = evt.results[evt.results.length - 1];
        if (typeof opts.onResult === 'function') {
          opts.onResult({
            transcript: r[0].transcript,
            confidence: r[0].confidence,
            isFinal:    r.isFinal,
          });
        }
      };

      rec.onend = function () {
        if (typeof opts.onEnd === 'function') opts.onEnd();
      };

      rec.onerror = function (evt) {
        if (typeof opts.onError === 'function') opts.onError({ error: evt.error, message: evt.message });
      };

      try {
        rec.start();
      } catch (err) {
        if (typeof opts.onError === 'function') opts.onError({ error: 'start_failed', message: err.message });
        return { stop: function () {}, isSupported: true };
      }

      return {
        stop:        function () { try { rec.stop(); } catch (_) {} },
        isSupported: true,
      };
    },

    /* ── suggestions ─────────────────────────────────────────── */
    async suggestions(query, opts) {
      opts  = opts  || {};
      const limit          = opts.limit          !== undefined ? opts.limit          : 8;
      const includeRecent  = opts.includeRecent  !== false;
      const includePopular = opts.includePopular !== false;

      const results = [];

      /* 1. Recent user searches */
      if (includeRecent) {
        const recents = this.recentSearches(5);
        const q       = (query || '').toLowerCase();
        recents
          .filter(r => !q || r.query.toLowerCase().includes(q))
          .forEach(r => results.push({ text: r.query, type: 'recent', count: r.resultsCount, icon: '🕐' }));
      }

      /* 2. Popular searches from Firestore searchTrending */
      if (includePopular && window.firebaseDB) {
        try {
          const trendItems = await this.trending(5);
          trendItems.forEach(t => {
            if (!results.find(r => r.text === t.term)) {
              results.push({ text: t.term, type: 'popular', count: t.count, icon: '🔥' });
            }
          });
        } catch (_) {}
      }

      /* 3. Prefix match from Algolia query suggestions */
      if (_config.algolia.enabled && query && query.length >= 2) {
        try {
          const cacheKey = _cacheKey(query, '__suggestions__', {});
          let suggestHits = _fromCache(cacheKey, _config.cacheTTL.autocomplete);
          if (!suggestHits) {
            const { appId, apiKey } = _config.algolia;
            /* Try a dedicated query-suggestions index first; fall back to product index */
            const suggestIndex = 'sokoni_query_suggestions';
            const resp = await fetch(
              `https://${appId}-dsn.algolia.net/1/indexes/${suggestIndex}/query`,
              {
                method:  'POST',
                headers: {
                  'X-Algolia-Application-Id': appId,
                  'X-Algolia-API-Key':        apiKey,
                  'Content-Type':             'application/json',
                },
                body: JSON.stringify({ query: _sanitizeQuery(query), hitsPerPage: 5 }),
              }
            );
            if (resp.ok) {
              const data = await resp.json();
              suggestHits = (data.hits || []).map(h => h.query || h.name || '');
              _toCache(cacheKey, suggestHits);
            } else {
              suggestHits = [];
            }
          }
          suggestHits.forEach(s => {
            if (s && !results.find(r => r.text === s)) {
              results.push({ text: s, type: 'suggestion', icon: '🔍' });
            }
          });
        } catch (_) {}
      }

      return results.slice(0, limit);
    },

    /* ── recommendations ─────────────────────────────────────── */
    async recommendations(opts) {
      opts = opts || {};
      const limit    = opts.limit || 8;
      const index    = opts.index || INDICES.PRODUCTS;
      const context  = opts.context || {};
      const cacheKey = `__recs__::${index}::${JSON.stringify(context)}`;

      const cached = _fromCache(cacheKey, _config.cacheTTL.recommendations);
      if (cached) return cached;

      /* Strategy 1: Algolia personalization */
      if (_config.algolia.enabled && _config.personalization.enabled) {
        try {
          const uid = window.firebaseAuth?.currentUser?.uid;
          if (uid) {
            const result = await _algoliaSearch(
              context.recentViews ? context.recentViews[0] || '' : '',
              index,
              {
                hitsPerPage: limit,
                userToken:   uid,
                algoliaFilters: context.category ? `category:${context.category}` : '',
              }
            );
            if (result.hits && result.hits.length > 0) {
              const rec = { items: result.hits, strategy: 'personalized' };
              _toCache(cacheKey, rec);
              return rec;
            }
          }
        } catch (_) {}
      }

      /* Strategy 2: Firestore searchPersonalization doc */
      const uid = window.firebaseAuth?.currentUser?.uid;
      if (uid && window.firebaseDB) {
        try {
          const { doc, getDoc } = await import(FIREBASE_SDK);
          const snap = await getDoc(doc(window.firebaseDB, 'searchPersonalization', uid));
          if (snap.exists()) {
            const data = snap.data();
            const items = (data.recommendations || []).slice(0, limit);
            if (items.length > 0) {
              const rec = { items, strategy: 'personalized' };
              _toCache(cacheKey, rec);
              return rec;
            }
          }
        } catch (_) {}
      }

      /* Strategy 3: Trending fallback */
      try {
        const trendItems = await this.trending(limit);
        const rec = { items: trendItems.map(t => ({ name: t.term, term: t.term, count: t.count })), strategy: 'trending' };
        _toCache(cacheKey, rec);
        return rec;
      } catch (_) {}

      return { items: [], strategy: 'trending' };
    },

    /* ── similarProducts ─────────────────────────────────────── */
    async similarProducts(itemId, index, opts) {
      index = index || INDICES.PRODUCTS;
      opts  = opts  || {};
      const limit = opts.limit || 8;
      const model = opts.model || 'related-products';

      /* Strategy 1: Algolia Recommend API */
      if (_config.algolia.enabled) {
        try {
          const { appId, apiKey } = _config.algolia;
          const resp = await fetch(
            `https://${appId}.algolia.net/1/indexes/*/recommendations`,
            {
              method:  'POST',
              headers: {
                'X-Algolia-Application-Id': appId,
                'X-Algolia-API-Key':        apiKey,
                'Content-Type':             'application/json',
              },
              body: JSON.stringify({
                requests: [{
                  indexName:          index,
                  objectID:           itemId,
                  model,
                  maxRecommendations: limit,
                }],
              }),
            }
          );
          if (resp.ok) {
            const data = await resp.json();
            const items = (data.results && data.results[0] && data.results[0].hits) || [];
            if (items.length > 0) return { items, source: 'recommend' };
          }
        } catch (_) {}
      }

      /* Strategy 2: Fetch item category from Firestore, then search same category */
      if (window.firebaseDB) {
        try {
          const { doc, getDoc } = await import(FIREBASE_SDK);
          const colName = _COLLECTION_MAP[index] || index;
          const snap    = await getDoc(doc(window.firebaseDB, colName, itemId));

          if (snap.exists()) {
            const category = snap.data().category || '';
            if (category) {
              const result = await this.search('', index, {
                hitsPerPage:    limit,
                algoliaFilters: `category:${category} AND NOT objectID:${itemId}`,
                filterBy:       `category:=${category}`,
              });
              if (result.hits && result.hits.length > 0) {
                return { items: result.hits.filter(h => (h.id || h.objectID) !== itemId).slice(0, limit), source: 'category' };
              }
            }
          }
        } catch (_) {}
      }

      /* Strategy 3: Trending fallback */
      try {
        const trendItems = await this.trending(limit);
        return { items: trendItems.map(t => ({ name: t.term, count: t.count })), source: 'trending' };
      } catch (_) {
        return { items: [], source: 'trending' };
      }
    },

    /* ── imageSearch  (future-ready stub) ───────────────────── */
    imageSearch(_imageData) {
      throw new Error(
        'Image search requires vector infrastructure. ' +
        'Upgrade path: (1) Extract embeddings via Cloud Function, ' +
        '(2) Store in Typesense vector field, ' +
        '(3) Search using typesense vector_query. ' +
        'Contact engineering@sokoni.co.ke to enable.'
      );
    },

    /* ── detectIntent ─────────────────────────────────────────── */
    detectIntent(query) {
      return _detectIntentInternal(_sanitizeQuery(query));
    },

    /* ── recentSearches ──────────────────────────────────────── */
    recentSearches(limit) {
      const n = typeof limit === 'number' ? limit : 5;
      return _loadRecent().slice(0, n);
    },

    /* ── clearHistory ────────────────────────────────────────── */
    clearHistory() {
      try { localStorage.removeItem(LS_RECENT_KEY); } catch (_) {}
      return true;
    },

    /* ── multiSearch  (Algolia multi-query, one round-trip) ──── */
    async multiSearch(requests, opts) {
      requests = requests || [];
      opts     = opts     || {};

      if (!requests.length) return [];

      /* Algolia multi-query API */
      if (_config.algolia.enabled && !_cbIsOpen(SEARCH_ENGINE.ALGOLIA)) {
        try {
          const { appId, apiKey } = _config.algolia;
          const body = {
            requests: requests.map(r => ({
              indexName:   r.index || INDICES.PRODUCTS,
              query:       _sanitizeQuery(r.query || ''),
              hitsPerPage: r.hitsPerPage || 10,
              filters:     r.filters     || r.algoliaFilters || '',
            })),
            strategy: opts.strategy || 'none',
          };

          const resp = await fetch(
            `https://${appId}-dsn.algolia.net/1/indexes/*/queries`,
            {
              method:  'POST',
              headers: {
                'X-Algolia-Application-Id': appId,
                'X-Algolia-API-Key':        apiKey,
                'Content-Type':             'application/json',
              },
              body: JSON.stringify(body),
            }
          );

          if (resp.ok) {
            _cbRecordSuccess(SEARCH_ENGINE.ALGOLIA);
            const data = await resp.json();
            return (data.results || []).map((r, i) => ({
              hits:       r.hits       || [],
              total:      r.nbHits     || 0,
              page:       r.page       || 0,
              totalPages: r.nbPages    || 0,
              facets:     r.facets     || {},
              engine:     SEARCH_ENGINE.ALGOLIA,
              query:      requests[i].query || '',
            }));
          } else {
            _cbRecordFailure(SEARCH_ENGINE.ALGOLIA);
          }
        } catch (err) {
          _cbRecordFailure(SEARCH_ENGINE.ALGOLIA);
          _warn(`[Search] multiSearch Algolia failed: ${err.message}`);
        }
      }

      /* Fallback: individual parallel searches */
      const settled = await Promise.allSettled(
        requests.map(r => this.search(r.query || '', r.index || INDICES.PRODUCTS, r))
      );

      return settled.map((s, i) =>
        s.status === 'fulfilled'
          ? s.value
          : { hits: [], total: 0, page: 0, totalPages: 0, engine: 'fallback', error: s.reason?.message, query: requests[i].query || '' }
      );
    },

    /* ── recordClick  (public, backward compat) ──────────────── */
    recordClick(query, index, itemId, position) {
      _recordClick(query, index, itemId, position);
    },

    /* ── trending ────────────────────────────────────────────── */
    async trending(limit) {
      limit = limit || 10;
      if (!window.firebaseDB) return [];
      try {
        const { collection, query: fsQuery, orderBy, getDocs, limit: fsLimit } = await import(FIREBASE_SDK);
        const snap = await getDocs(
          fsQuery(collection(window.firebaseDB, 'searchTrending'), orderBy('count', 'desc'), fsLimit(limit))
        );
        return snap.docs.map(d => ({ term: d.id, count: d.data().count || 0 }));
      } catch (_) {
        return [];
      }
    },

    /* ── invalidateCache ─────────────────────────────────────── */
    invalidateCache() {
      _cache.clear();
      _inflightRequests.clear();
    },

    /* ── diagnostics ─────────────────────────────────────────── */
    diagnostics() {
      const now = Date.now();
      const cbStatus = {};
      Object.keys(_circuitBreakers).forEach(eng => {
        const cb = _circuitBreakers[eng];
        cbStatus[eng] = {
          failures:  cb.failures,
          isOpen:    cb.openUntil > now,
          opensIn:   cb.openUntil > now ? Math.ceil((cb.openUntil - now) / 1000) + 's' : null,
          backoffMs: cb.backoffMs,
        };
      });

      /* Rate limiter: count requests in current window */
      const rlCount = _rlTimestamps.filter(ts => ts > now - _RL_WIN).length;

      return {
        engine:         _config.engine,
        algolia:        { enabled: _config.algolia.enabled,   appId: _config.algolia.appId },
        typesense:      { enabled: _config.typesense.enabled, host:  _config.typesense.host },
        cacheSize:      _cache.size,
        cacheMax:       _CACHE_MAX,
        inflightCount:  _inflightRequests.size,
        circuitBreakers: cbStatus,
        rateLimiter:    { requestsInWindow: rlCount, maxPerWindow: _RL_MAX, windowSeconds: _RL_WIN / 1000 },
        recentSearches: _loadRecent().length,
        indices:        Object.values(INDICES),
        ai:             _config.ai,
        privacy:        _config.privacy,
        personalization: _config.personalization,
        version:        '3.0',
      };
    },
  };

  return Search;

})();

window.SokoniSearchPro = SokoniSearchPro;

/* ══════════════════════════════════════════════════════════════
   AUTO-CONFIGURE from window.SOKONI_CONFIG
   Runs at DOMContentLoaded (or immediately if already parsed).
══════════════════════════════════════════════════════════════ */
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
        host:    (c.typesenseProtocol || 'https') + '://' + c.typesenseHost + ':' + (c.typesensePort || 443),
        /* Accept both key names for backward compat */
        apiKey:  c.typesenseSearchKey || c.typesenseKey || '',
        enabled: true,
      } : {},
      ai: {
        intent:         c.searchIntentEnabled  !== false,
        queryExpansion: c.searchQueryExpansion !== false,
      },
      privacy: {
        trackAnalytics: c.searchAnalytics !== false,
        trackClicks:    c.searchClicks    !== false,
      },
      personalization: {
        enabled: !!(c.searchPersonalization),
      },
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
}());
