/**
 * SOKONI Search Service — Master Server-Side Search API
 *
 * This is the authoritative server-side search callable layer. The frontend
 * can call Algolia or Typesense directly using secured keys from
 * searchGetSecuredKeys, but this CF layer is required for:
 *   - Admin-only collections (orders, users)
 *   - AI-enhanced / personalized results
 *   - Server-enforced content filtering
 *   - Collections where the client must not see raw index credentials
 *
 * All HTTP calls to Algolia and Typesense use native Node.js https/http —
 * zero npm dependencies from this file.
 *
 * Exports:
 *   searchQuery        — main search: pagination, filters, geo, sort, fallback
 *   searchAutocomplete — fast prefix suggestions across one or all indexes
 *   searchNearby       — geo-aware search with Kenya bounding-box validation
 *   searchSimilar      — related items via Algolia Recommend or category fallback
 *   searchPersonalized — personalization-aware search (Algolia userToken)
 *   searchIntent       — deterministic intent classifier + Swahili expansion
 *
 * Security:
 *   - adminOnly collections always require admin custom claim
 *   - Query strings are sanitized (length cap, control-char strip)
 *   - Filters are whitelist-validated before forwarding to search engines
 *   - No secret values appear in logs or responses
 *   - Analytics sampling at 20% to control Firestore write volume
 *
 * @module search-service
 */

'use strict';

const https = require('https');
const http  = require('http');

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');
/* firebase-admin has no .logger export — logger.* threw
   'Cannot read properties of undefined' on every call. */
const logger = require('firebase-functions/logger');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* ── Secrets ──────────────────────────────────────────────────────────────── */

const ALGOLIA_ADMIN_KEY    = defineSecret('ALGOLIA_ADMIN_KEY');
const ALGOLIA_SEARCH_KEY   = defineSecret('ALGOLIA_SEARCH_KEY');
const TYPESENSE_ADMIN_KEY  = defineSecret('TYPESENSE_ADMIN_KEY');
const TYPESENSE_SEARCH_KEY = defineSecret('TYPESENSE_SEARCH_KEY');

/* ── Shared CF options ───────────────────────────────────────────────────── */

const CF_OPTS = { region: 'us-central1', memory: '512MiB', timeoutSeconds: 30 };

/* ── Auth guards ─────────────────────────────────────────────────────────── */

/**
 * @param {object} req
 * @returns {string} uid
 * @throws {HttpsError}
 */
function _assertAuth(req) {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required');
  return req.auth.uid;
}

/**
 * @param {object} req
 * @returns {string} uid
 * @throws {HttpsError}
 */
function _assertAdmin(req) {
  if (!req.auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin required');
  return req.auth.uid;
}

/* ══════════════════════════════════════════════════════════════════════════════
   SWAHILI / KENYAN QUERY EXPANSION MAP
══════════════════════════════════════════════════════════════════════════════ */

/** @type {Object.<string, string>} */
const SWAHILI_EXPANSIONS = {
  'nguo':     'clothes clothing fashion',
  'chakula':  'food restaurant',
  'nyumba':   'house property rental',
  'gari':     'car vehicle',
  'kazi':     'job work employment',
  'mzigo':    'delivery logistics',
  'dawa':     'medicine pharmacy health',
  'shule':    'school education',
  'pesa':     'money finance payments',
  'simu':     'phone mobile electronics',
  'viatu':    'shoes footwear',
  'samani':   'furniture',
  'fanicha':  'furniture',
  'mboga':    'vegetables groceries',
  'duka':     'shop store',
  'bei':      'price cost',
  'haraka':   'fast express delivery',
  'bure':     'free no charge',
  'nafuu':    'cheap affordable',
  'mpya':     'new arrivals',
  'tofauti':  'variety options',
  'salama':   'safe security',
  'afya':     'health medical',
  'michezo':  'sports fitness gym',
  'elimu':    'education learning',
  'mwanasheria': 'lawyer legal',
  'wakili':   'lawyer advocate',
  'usafiri':  'transport logistics',
  'ardhi':    'land property plot',
  'shamba':   'farm land agriculture',
};

/* ══════════════════════════════════════════════════════════════════════════════
   INTENT CLASSIFIER
══════════════════════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} IntentResult
 * @property {string}  intent           — classified intent label
 * @property {string}  [index]          — suggested Algolia/Typesense index name
 * @property {object}  [suggestedFilters]
 * @property {number}  confidence       — 0–1
 */

/**
 * Deterministic intent classifier — no external API call.
 * Covers the Kenyan market's primary search intents.
 *
 * @param {string} query - raw user input
 * @returns {IntentResult}
 */
function _detectIntent(query) {
  const q = query.toLowerCase().trim();

  /* Food / restaurant */
  if (/burger|pizza|food|eat|restaurant|lunch|dinner|breakfast|chakula|ugali|nyama|pilau|biryani|matumbo|groceries|mboga|mama mboga|delivery food/i.test(q))
    return { intent: 'food', index: 'sokoni_products', confidence: 0.92 };

  /* Property */
  if (/house|apartment|rent|rental|flat|bedsitter|studio|mansion|villa|bedroom|nyumba|kupanga|kukodisha|airbnb|bnb|hostel|lodge|property|estate/i.test(q))
    return { intent: 'property', index: 'sokoni_properties', confidence: 0.92 };

  /* Job */
  if (/\bjob\b|hiring|vacancy|career|salary|employment|kazi|ajira|nafasi|internship|attachment|work from home|remote work|freelance/i.test(q))
    return { intent: 'jobs', index: 'sokoni_jobs', confidence: 0.92 };

  /* Vehicle */
  if (/\bcar\b|truck|van|suv|sedan|pickup|gari|motokaa|vehicle|automobile|boda|bodaboda|motorcycle|pikipiki|matatu|bus|lorry|forklift/i.test(q))
    return { intent: 'vehicles', index: 'sokoni_vehicles', confidence: 0.92 };

  /* Event */
  if (/event|concert|show|festival|carnival|tukio|ticket|nairobi.*happening|mombasa.*party|nyumba party|bash|gig|comedy|stand.?up|conference|expo/i.test(q))
    return { intent: 'events', index: 'sokoni_events', confidence: 0.88 };

  /* Health */
  if (/doctor|daktari|clinic|hospital|hospitali|pharmacy|duka la dawa|afya|medical|dentist|optician|therapy|physiotherapy|lab test|prescription/i.test(q))
    return { intent: 'health', index: 'sokoni_services', confidence: 0.88 };

  /* Legal */
  if (/lawyer|advocate|wakili|mwanasheria|legal|court|petition|contract|conveyancing|bail|family law|property law/i.test(q))
    return { intent: 'legal', index: 'sokoni_services', confidence: 0.88 };

  /* Education */
  if (/school|shule|college|university|chuo|tutoring|online course|e.?learning|certificate|diploma|degree|class|lesson|elimu/i.test(q))
    return { intent: 'education', index: 'sokoni_services', confidence: 0.85 };

  /* Shops / services */
  if (/shop|store|salon|barber|kinyozi|cleaning|usafi|laundry|dobi|plumber|electrician|fundi|repair|maintenance|service/i.test(q))
    return { intent: 'services', index: 'sokoni_services', confidence: 0.82 };

  /* Price intent — must come before general */
  const priceMatch = q.match(/under\s+(\d+)|below\s+(\d+)|less than\s+(\d+)|ksh\s*(\d+)|kes\s*(\d+)|(\d+)\s*ksh|within\s+(\d+)/i);
  if (priceMatch) {
    const price = parseInt(priceMatch[1] || priceMatch[2] || priceMatch[3] ||
                           priceMatch[4] || priceMatch[5] || priceMatch[6] || priceMatch[7], 10);
    if (!isNaN(price)) {
      return { intent: 'price_filter', index: 'sokoni_products', suggestedFilters: { priceMax: price }, confidence: 0.85 };
    }
  }

  /* Geo / location intent */
  const cityMatch = q.match(/\bin\s+(nairobi|mombasa|kisumu|nakuru|eldoret|thika|ruiru|machakos|westlands|karen|kilimani|lavington|eastleigh|cbd|ngong|rongai|syokimau|kitengela)\b/i);
  if (cityMatch) {
    const city = cityMatch[1].charAt(0).toUpperCase() + cityMatch[1].slice(1).toLowerCase();
    return { intent: 'geo', index: 'sokoni_products', suggestedFilters: { city }, confidence: 0.88 };
  }
  if (/near me|nearby|close to me|karibu|jirani|around me/i.test(q))
    return { intent: 'geo_nearby', index: 'sokoni_products', confidence: 0.82 };

  /* Electronics / tech */
  if (/phone|laptop|computer|kompyuta|simu|tablet|tv|television|camera|speaker|earphone|charger|gadget|electronics|tech/i.test(q))
    return { intent: 'electronics', index: 'sokoni_products', confidence: 0.85 };

  /* Fashion */
  if (/dress|shirt|trouser|skirt|suit|jacket|shoes|viatu|nguo|fashion|clothing|clothes|handbag|purse|belt|watch|accessories/i.test(q))
    return { intent: 'fashion', index: 'sokoni_products', confidence: 0.83 };

  /* General product */
  return { intent: 'general', index: 'sokoni_products', confidence: 0.5 };
}

/* ══════════════════════════════════════════════════════════════════════════════
   QUERY SANITIZATION + FILTER BUILDING
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Sanitizes a user-supplied search query.
 * - Strips control characters
 * - Caps at 256 chars
 * - Trims whitespace
 * @param {string} raw
 * @returns {string}
 */
function _sanitizeQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\x00-\x1F\x7F]/g, '')   /* strip control chars — XSS guard */
    .slice(0, 256)
    .trim();
}

/**
 * Converts the structured filters object into an Algolia filter string.
 * Only whitelisted fields are included — prevents filter injection.
 *
 * @param {object} filters
 * @returns {string}
 */
function _buildAlgoliaFilters(filters) {
  if (!filters || typeof filters !== 'object') return '';
  const parts = [];
  if (filters.category && typeof filters.category === 'string') parts.push(`category:"${filters.category.replace(/"/g, '')}"`);
  if (filters.city     && typeof filters.city     === 'string') parts.push(`location.city:"${filters.city.replace(/"/g, '')}"`);
  if (filters.brand    && typeof filters.brand    === 'string') parts.push(`brand:"${filters.brand.replace(/"/g, '')}"`);
  if (filters.status   && typeof filters.status   === 'string') parts.push(`status:"${filters.status.replace(/"/g, '')}"`);
  if (typeof filters.priceMin === 'number' && isFinite(filters.priceMin)) parts.push(`price >= ${filters.priceMin}`);
  if (typeof filters.priceMax === 'number' && isFinite(filters.priceMax)) parts.push(`price <= ${filters.priceMax}`);
  if (typeof filters.rating   === 'number' && isFinite(filters.rating))   parts.push(`rating >= ${filters.rating}`);
  /* Always exclude logically deleted records */
  parts.push('NOT status:"deleted" AND NOT status:"draft" AND NOT status:"banned"');
  return parts.join(' AND ');
}

/**
 * Converts the structured filters object into a Typesense filter_by string.
 * @param {object} filters
 * @returns {string}
 */
function _buildTypesenseFilters(filters) {
  if (!filters || typeof filters !== 'object') return 'status:=active';
  const parts = ['status:=active'];
  if (filters.category && typeof filters.category === 'string') parts.push(`category:=${filters.category.replace(/[`'"]/g, '')}`);
  if (filters.city     && typeof filters.city     === 'string') parts.push(`location_city:=${filters.city.replace(/[`'"]/g, '')}`);
  if (filters.brand    && typeof filters.brand    === 'string') parts.push(`brand:=${filters.brand.replace(/[`'"]/g, '')}`);
  if (typeof filters.priceMin === 'number' && isFinite(filters.priceMin)) parts.push(`price:>=${filters.priceMin}`);
  if (typeof filters.priceMax === 'number' && isFinite(filters.priceMax)) parts.push(`price:<=${filters.priceMax}`);
  if (typeof filters.rating   === 'number' && isFinite(filters.rating))   parts.push(`rating:>=${filters.rating}`);
  return parts.join(' && ');
}

/**
 * Maps a `sort` string to an Algolia virtual replica index name.
 * Falls back to the base index (relevance) when sort is unknown.
 *
 * @param {string} baseIndex - base Algolia index name (e.g. 'sokoni_products')
 * @param {string} sort      - 'relevance'|'price_asc'|'price_desc'|'newest'|'rating'|'popular'
 * @returns {string}
 */
function _algoliaIndexForSort(baseIndex, sort) {
  const SORT_REPLICA_MAP = {
    price_asc:  '_price_asc',
    price_desc: '_price_desc',
    newest:     '_newest',
    rating:     '_rating',
    popular:    '_popular',
  };
  if (sort && sort !== 'relevance' && SORT_REPLICA_MAP[sort]) {
    return `${baseIndex}${SORT_REPLICA_MAP[sort]}`;
  }
  return baseIndex;
}

/**
 * Maps a `sort` string to a Typesense sort_by clause.
 * @param {string} sort
 * @returns {string}
 */
function _typesenseSortBy(sort) {
  const SORT_MAP = {
    price_asc:  'price:asc,_popularityScore:desc',
    price_desc: 'price:desc,_popularityScore:desc',
    newest:     'createdAt:desc',
    rating:     'rating:desc,reviewCount:desc',
    popular:    '_popularityScore:desc,orderCount:desc',
  };
  return SORT_MAP[sort] || '_popularityScore:desc';
}

/* ══════════════════════════════════════════════════════════════════════════════
   HTTP HELPER
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Native HTTPS/HTTP request helper — no npm dependencies.
 * @param {string} url
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {object} headers
 * @param {object|null} body
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{status: number, body: object}>}
 */
function _httpsRequest(url, method, headers, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const lib     = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':   'SOKONI-SearchService/1.0',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };
    const req = lib.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed_body;
        try { parsed_body = JSON.parse(raw); } catch (_) { parsed_body = { raw }; }
        resolve({ status: res.statusCode, body: parsed_body });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Search engine request timeout'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ══════════════════════════════════════════════════════════════════════════════
   SEARCH ENGINE DRIVERS  (raw REST — no npm client)
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Executes an Algolia index search via the REST API.
 *
 * @param {string} indexName          - Algolia index (may be a replica name)
 * @param {object} algoliaSearchKey   - raw secret value (string)
 * @param {object} params             - Algolia query params
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<object>}         - Raw Algolia response body
 */
async function _algoliaSearch(indexName, algoliaSearchKey, params, timeoutMs = 5000) {
  const appId = process.env.ALGOLIA_APP_ID;
  if (!appId) throw new Error('ALGOLIA_APP_ID not configured');
  const url = `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`;
  const res = await _httpsRequest(url, 'POST', {
    'X-Algolia-Application-Id': appId,
    'X-Algolia-API-Key':        algoliaSearchKey,
  }, params, timeoutMs);
  if (res.status >= 400) {
    const msg = res.body?.message || `Algolia HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

/**
 * Executes a Typesense collection search via the REST API.
 *
 * @param {string} collection         - Typesense collection name
 * @param {string} typesenseSearchKey - raw secret value (string)
 * @param {object} params             - Typesense search params (key-value pairs)
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<object>}
 */
async function _typesenseSearch(collection, typesenseSearchKey, params, timeoutMs = 5000) {
  const host = process.env.TYPESENSE_HOST || 'localhost';
  const port = process.env.TYPESENSE_PORT || '443';
  const proto = (port === '443' || port === '8443') ? 'https' : 'http';
  const qs   = '?' + new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null))
  ).toString();
  const url  = `${proto}://${host}:${port}/collections/${encodeURIComponent(collection)}/documents/search${qs}`;
  const res  = await _httpsRequest(url, 'GET', {
    'X-TYPESENSE-API-KEY': typesenseSearchKey,
  }, null, timeoutMs);
  if (res.status >= 400) {
    const msg = res.body?.message || `Typesense HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

/**
 * Normalises an Algolia response into the unified result shape.
 * @param {object} raw - raw Algolia response
 * @param {string} engine - 'algolia'
 * @param {number} startMs - request start timestamp (for latency calculation)
 * @returns {object} unified result
 */
function _normalizeAlgolia(raw, engine, startMs) {
  const hits = (raw.hits || []).map(h => {
    const { _highlightResult, _snippetResult, ...rest } = h;
    return {
      ...rest,
      id:        rest.objectID || rest.id,
      highlight: _highlightResult || null,
      snippet:   _snippetResult   || null,
    };
  });
  return {
    hits,
    total:      raw.nbHits    || 0,
    page:       raw.page      || 0,
    totalPages: raw.nbPages   || 0,
    facets:     raw.facets    || {},
    queryID:    raw.queryID   || null,
    engine,
    latencyMs:  Date.now() - startMs,
  };
}

/**
 * Normalises a Typesense response into the unified result shape.
 * @param {object} raw - raw Typesense response
 * @param {string} engine - 'typesense'
 * @param {number} startMs
 * @param {number} page - requested page (0-based, converted from 1-based TS)
 * @returns {object} unified result
 */
function _normalizeTypesense(raw, engine, startMs, page) {
  const hits = (raw.hits || []).map(h => ({
    ...(h.document || {}),
    id:        h.document?.id,
    highlight: h.highlights || null,
    snippet:   null,
  }));
  const total     = raw.found || 0;
  const perPage   = raw.request_params?.per_page || 20;
  const totalPages = Math.ceil(total / perPage);
  return {
    hits,
    total,
    page,
    totalPages,
    facets:    _normalizeTypesenseFacets(raw.facet_counts),
    queryID:   null,
    engine,
    latencyMs: Date.now() - startMs,
  };
}

/**
 * Converts Typesense facet_counts array to a {field: {value: count}} map
 * matching the Algolia facets response shape.
 * @param {Array} facetCounts
 * @returns {object}
 */
function _normalizeTypesenseFacets(facetCounts) {
  if (!Array.isArray(facetCounts)) return {};
  return facetCounts.reduce((acc, fc) => {
    acc[fc.field_name] = (fc.counts || []).reduce((m, c) => {
      m[c.value] = c.count;
      return m;
    }, {});
    return acc;
  }, {});
}

/* ══════════════════════════════════════════════════════════════════════════════
   ANALYTICS SAMPLING
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Records a search query to searchAnalytics (sampled at 20%).
 * Non-blocking — errors are swallowed to never affect search latency.
 *
 * @param {string} uid
 * @param {string} query
 * @param {string} index
 * @param {string} engine
 * @param {number} total
 * @param {number} latencyMs
 */
function _recordAnalytics(uid, query, index, engine, total, latencyMs) {
  if (Math.random() > 0.20) return; /* 20% sampling */
  db.collection('searchAnalytics').add({
    uid,
    query:     query.slice(0, 128),
    index,
    engine,
    total,
    latencyMs,
    hasResults: total > 0,
    recordedAt: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => { /* non-fatal */ });
}

/* ══════════════════════════════════════════════════════════════════════════════
   PRIMARY ENGINE SELECTION
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Reads searchConfig/settings from Firestore and returns the preferred engine.
 * Falls back to 'algolia' if config is absent or engine is 'auto'.
 * @returns {Promise<'algolia'|'typesense'>}
 */
async function _getPrimaryEngine() {
  try {
    const snap = await db.doc('searchConfig/settings').get();
    if (snap.exists) {
      const cfg = snap.data();
      if (cfg.primaryEngine === 'typesense' && cfg.typesenseEnabled !== false) return 'typesense';
      if (cfg.primaryEngine === 'algolia'   && cfg.algoliaEnabled   !== false) return 'algolia';
    }
  } catch (_) { /* non-fatal */ }
  return 'algolia'; /* safe default */
}

/* ══════════════════════════════════════════════════════════════════════════════
   COLLECTION REGISTRY HELPERS
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Resolves the Algolia index name and Typesense collection name for a given
 * Firestore collection key from COLLECTION_REGISTRY.
 *
 * @param {string} collectionKey - e.g. 'products', 'events', 'orders'
 * @returns {{ algoliaIndex: string|null, typesenseCollection: string|null, adminOnly: boolean, engine: string }}
 */
function _resolveCollection(collectionKey) {
  try {
    const { COLLECTION_REGISTRY } = require('./search-sync');
    const entry = COLLECTION_REGISTRY[collectionKey];
    if (!entry) return { algoliaIndex: null, typesenseCollection: null, adminOnly: false, engine: 'none' };
    return {
      algoliaIndex:        entry.algoliaIndex        || null,
      typesenseCollection: entry.typesenseCollection || null,
      adminOnly:           entry.adminOnly           || false,
      engine:              entry.engine              || 'both',
    };
  } catch (_) {
    return { algoliaIndex: null, typesenseCollection: null, adminOnly: false, engine: 'none' };
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   1. searchQuery — main search callable
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Main unified search function. Supports pagination, structured filters,
 * sorting via virtual replicas, geo filtering, engine selection, and
 * automatic fallback between Algolia and Typesense.
 *
 * Request shape:
 * ```
 * {
 *   query:       string,          // search term
 *   index:       string,          // collection key from COLLECTION_REGISTRY
 *   page:        number,          // 0-based page (default 0)
 *   hitsPerPage: number,          // 1–100 (default 20)
 *   filters: {
 *     category:  string,
 *     priceMin:  number,
 *     priceMax:  number,
 *     city:      string,
 *     rating:    number,
 *     brand:     string,
 *     status:    string,
 *   },
 *   sort:            string,      // 'relevance'|'price_asc'|'price_desc'|'newest'|'rating'|'popular'
 *   geo:             { lat, lng, radiusKm },
 *   engine:          'algolia'|'typesense'|'auto',
 *   adminOnly:       boolean,     // override: treat as admin-only
 *   includeHighlights: boolean,
 *   includeFacets:     boolean,
 * }
 * ```
 *
 * @type {import('firebase-functions/v2/https').CallableFunction}
 */
exports.searchQuery = onCall(
  {
    ...CF_OPTS,
    secrets: [ALGOLIA_SEARCH_KEY, TYPESENSE_SEARCH_KEY],
  },
  async (req) => {
    const uid      = _assertAuth(req);
    const isAdmin  = Boolean(req.auth?.token?.admin);
    const startMs  = Date.now();

    /* ── Parameter validation ────────────────────────────────────────── */
    const {
      query        = '',
      index        = 'products',
      page         = 0,
      filters      = {},
      sort         = 'relevance',
      geo,
      engine:      enginePref = 'auto',
      includeHighlights = true,
      includeFacets     = true,
    } = req.data || {};

    let hitsPerPage = Math.min(Math.max(parseInt(req.data?.hitsPerPage || 20, 10), 1), 100);
    const sanitizedQuery = _sanitizeQuery(query);
    const pageNum        = Math.max(0, parseInt(page, 10) || 0);

    /* ── Collection access control ───────────────────────────────────── */
    const entry = _resolveCollection(index);

    if (entry.engine === 'none') {
      throw new HttpsError('invalid-argument', `Collection '${index}' is not searchable.`);
    }

    if (entry.adminOnly && !isAdmin) {
      throw new HttpsError('permission-denied', `Collection '${index}' requires admin access.`);
    }

    /* ── Engine selection ────────────────────────────────────────────── */
    let primaryEngine;
    if (enginePref === 'algolia')   primaryEngine = 'algolia';
    else if (enginePref === 'typesense') primaryEngine = 'typesense';
    else                            primaryEngine = await _getPrimaryEngine();

    /* Honour engine affinity from registry */
    if (entry.engine === 'algolia'   && primaryEngine === 'typesense') primaryEngine = 'algolia';
    if (entry.engine === 'typesense' && primaryEngine === 'algolia')   primaryEngine = 'typesense';
    if (!entry.algoliaIndex)                                            primaryEngine = 'typesense';
    if (!entry.typesenseCollection)                                     primaryEngine = 'algolia';

    const fallbackEngine = primaryEngine === 'algolia' ? 'typesense' : 'algolia';

    const algoliaKey   = ALGOLIA_SEARCH_KEY.value();
    const typesenseKey = TYPESENSE_SEARCH_KEY.value();

    const algoliaConfigured   = Boolean(algoliaKey   && algoliaKey   !== 'not_configured' && entry.algoliaIndex);
    const typesenseConfigured = Boolean(typesenseKey && typesenseKey !== 'not_configured' && entry.typesenseCollection);

    /* ── Geo validation ──────────────────────────────────────────────── */
    if (geo) {
      const { lat, lng } = geo;
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        throw new HttpsError('invalid-argument', 'geo.lat and geo.lng must be numbers.');
      }
      /* Kenya bounding box: lat -5 to 5, lng 34 to 42 */
      if (lat < -5 || lat > 5 || lng < 34 || lng > 42) {
        throw new HttpsError('invalid-argument', 'Coordinates are outside the supported region (Kenya).');
      }
    }

    /* ── Execute search ──────────────────────────────────────────────── */
    let result;
    let usedEngine = primaryEngine;

    const tryAlgolia = async () => {
      if (!algoliaConfigured) throw new Error('Algolia not configured for this collection');
      const targetIndex = _algoliaIndexForSort(entry.algoliaIndex, sort);
      const params = {
        query:       sanitizedQuery,
        page:        pageNum,
        hitsPerPage,
        filters:     _buildAlgoliaFilters(filters),
        facets:      includeFacets ? ['*'] : [],
        attributesToHighlight: includeHighlights ? ['name', 'description', 'title'] : [],
        highlightPreTag:   '<mark>',
        highlightPostTag:  '</mark>',
        userToken:         uid,
        enablePersonalization: true,
        analytics:         true,
        clickAnalytics:    true,
        ...(geo ? {
          aroundLatLng: `${geo.lat},${geo.lng}`,
          aroundRadius: Math.round((geo.radiusKm || 10) * 1000), /* convert km → metres */
        } : {}),
      };
      const raw = await _algoliaSearch(targetIndex, algoliaKey, params, 5000);
      return _normalizeAlgolia(raw, 'algolia', startMs);
    };

    const tryTypesense = async () => {
      if (!typesenseConfigured) throw new Error('Typesense not configured for this collection');
      const tsPage   = pageNum + 1; /* Typesense is 1-based */
      const params   = {
        q:              sanitizedQuery || '*',
        query_by:       'name,description,title,category,brand',
        per_page:       hitsPerPage,
        page:           tsPage,
        filter_by:      _buildTypesenseFilters(filters),
        sort_by:        _typesenseSortBy(sort),
        facet_by:       includeFacets ? 'category,brand,location_city,status' : undefined,
        highlight_fields: includeHighlights ? 'name,description,title' : 'none',
        highlight_start_tag: '<mark>',
        highlight_end_tag:   '</mark>',
        use_cache:      true,
        cache_ttl:      60,
        ...(geo ? {
          filter_by: `${_buildTypesenseFilters(filters)} && _geoloc:(${geo.lat}, ${geo.lng}, ${(geo.radiusKm || 10).toFixed(1)} km)`,
        } : {}),
      };
      const raw = await _typesenseSearch(entry.typesenseCollection, typesenseKey, params, 5000);
      return _normalizeTypesense(raw, 'typesense', startMs, pageNum);
    };

    if (primaryEngine === 'algolia') {
      try {
        result     = await tryAlgolia();
        usedEngine = 'algolia';
      } catch (primaryErr) {
        logger.warn('[SearchQuery] Algolia failed, trying Typesense fallback', { error: primaryErr.message, index });
        try {
          result     = await tryTypesense();
          usedEngine = 'typesense';
        } catch (fallbackErr) {
          logger.error('[SearchQuery] Both engines failed', { algoliaErr: primaryErr.message, typesenseErr: fallbackErr.message, index });
          throw new HttpsError('unavailable', 'Search is temporarily unavailable. Please try again.');
        }
      }
    } else {
      try {
        result     = await tryTypesense();
        usedEngine = 'typesense';
      } catch (primaryErr) {
        logger.warn('[SearchQuery] Typesense failed, trying Algolia fallback', { error: primaryErr.message, index });
        try {
          result     = await tryAlgolia();
          usedEngine = 'algolia';
        } catch (fallbackErr) {
          logger.error('[SearchQuery] Both engines failed', { typesenseErr: primaryErr.message, algoliaErr: fallbackErr.message, index });
          throw new HttpsError('unavailable', 'Search is temporarily unavailable. Please try again.');
        }
      }
    }

    /* ── Analytics sampling ────────────────────────────────────────────── */
    _recordAnalytics(uid, sanitizedQuery, index, usedEngine, result.total, result.latencyMs);

    return result;
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
   2. searchAutocomplete — fast prefix suggestions
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Returns fast autocomplete suggestions for a partial query.
 * Debouncing is handled client-side; this CF does not rate-limit per keystroke.
 *
 * When index === '__all__', performs a multi-index search across the four core
 * commerce indexes (products, shops, services, events) using Algolia's multi-query
 * API, or sequential Typesense searches with a combined result.
 *
 * @type {import('firebase-functions/v2/https').CallableFunction}
 */
exports.searchAutocomplete = onCall(
  {
    ...CF_OPTS,
    timeoutSeconds: 10,
    secrets:        [ALGOLIA_SEARCH_KEY, TYPESENSE_SEARCH_KEY],
  },
  async (req) => {
    const uid     = _assertAuth(req);
    const startMs = Date.now();

    const {
      query   = '',
      index   = 'sokoni_products',
      limit   = 8,
      context = {},
    } = req.data || {};

    const sanitizedQuery = _sanitizeQuery(query);
    if (!sanitizedQuery || sanitizedQuery.length < 1) {
      return { suggestions: [], latencyMs: Date.now() - startMs };
    }

    const hitsPerPage = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 20);
    const algoliaKey  = ALGOLIA_SEARCH_KEY.value();
    const tsKey       = TYPESENSE_SEARCH_KEY.value();
    const algoliaOk   = Boolean(algoliaKey && algoliaKey !== 'not_configured');
    const tsOk        = Boolean(tsKey && tsKey !== 'not_configured');

    /* Expand Swahili terms */
    let expandedQuery = sanitizedQuery;
    for (const [sw, en] of Object.entries(SWAHILI_EXPANSIONS)) {
      if (sanitizedQuery.toLowerCase().includes(sw)) {
        expandedQuery = `${sanitizedQuery} ${en}`;
        break;
      }
    }

    /* ── Multi-index mode ─────────────────────────────────────────────── */
    if (index === '__all__') {
      const CORE_INDEXES = [
        { algolia: 'sokoni_products', ts: 'sokoni_products', label: 'Products',  category: 'product'  },
        { algolia: 'sokoni_shops',    ts: 'sokoni_shops',    label: 'Shops',     category: 'shop'     },
        { algolia: 'sokoni_services', ts: 'sokoni_services', label: 'Services',  category: 'service'  },
        { algolia: 'sokoni_events',   ts: 'sokoni_events',   label: 'Events',    category: 'event'    },
      ];

      if (algoliaOk) {
        /* Algolia multi-query API */
        const appId  = process.env.ALGOLIA_APP_ID;
        const url    = `https://${appId}-dsn.algolia.net/1/indexes/*/queries`;
        const body   = {
          requests: CORE_INDEXES.map(ci => ({
            indexName:           ci.algolia,
            query:               expandedQuery,
            hitsPerPage:         Math.ceil(hitsPerPage / CORE_INDEXES.length),
            attributesToRetrieve: ['name', 'title', 'category', 'price', 'thumbnail', 'type'],
            highlightPreTag:     '<mark>',
            highlightPostTag:    '</mark>',
          })),
        };
        try {
          const res = await _httpsRequest(url, 'POST', {
            'X-Algolia-Application-Id': appId,
            'X-Algolia-API-Key':        algoliaKey,
          }, body, 4000);
          if (res.status < 400 && Array.isArray(res.body?.results)) {
            const suggestions = [];
            res.body.results.forEach((result, i) => {
              (result.hits || []).forEach(hit => {
                suggestions.push({
                  id:       hit.objectID || hit.id,
                  label:    hit.name || hit.title || '',
                  category: CORE_INDEXES[i].category,
                  price:    hit.price || null,
                  image:    hit.thumbnail || null,
                  type:     CORE_INDEXES[i].label,
                });
              });
            });
            return { suggestions: suggestions.slice(0, hitsPerPage), latencyMs: Date.now() - startMs };
          }
        } catch (err) {
          logger.warn('[SearchAutocomplete] Algolia multi-query failed', { error: err.message });
          /* fall through to Typesense */
        }
      }

      if (tsOk) {
        /* Sequential Typesense searches (Typesense Cloud has multi_search) */
        const suggestions = [];
        for (const ci of CORE_INDEXES) {
          try {
            const params = {
              q:               expandedQuery,
              query_by:        'name,title,category',
              per_page:        Math.ceil(hitsPerPage / CORE_INDEXES.length),
              page:            1,
              prefix:          true,
              filter_by:       'status:=active',
              use_cache:       true,
            };
            const raw = await _typesenseSearch(ci.ts, tsKey, params, 3000);
            (raw.hits || []).forEach(hit => {
              suggestions.push({
                id:       hit.document?.id,
                label:    hit.document?.name || hit.document?.title || '',
                category: ci.category,
                price:    hit.document?.price || null,
                image:    hit.document?.thumbnail || null,
                type:     ci.label,
              });
            });
          } catch (_) { /* skip failed index */ }
        }
        return { suggestions: suggestions.slice(0, hitsPerPage), latencyMs: Date.now() - startMs };
      }

      return { suggestions: [], latencyMs: Date.now() - startMs };
    }

    /* ── Single-index mode ────────────────────────────────────────────── */
    const entry = _resolveCollection(index);

    if (algoliaOk && entry.algoliaIndex) {
      try {
        const params = {
          query:               expandedQuery,
          hitsPerPage,
          page:                0,
          attributesToRetrieve: ['name', 'title', 'category', 'price', 'thumbnail'],
          highlightPreTag:     '<mark>',
          highlightPostTag:    '</mark>',
          userToken:           uid,
        };
        const raw = await _algoliaSearch(entry.algoliaIndex, algoliaKey, params, 4000);
        const suggestions = (raw.hits || []).map(hit => ({
          id:       hit.objectID || hit.id,
          label:    hit.name || hit.title || '',
          category: hit.category || null,
          price:    hit.price || null,
          image:    hit.thumbnail || null,
          type:     'result',
        }));
        return { suggestions, latencyMs: Date.now() - startMs };
      } catch (err) {
        logger.warn('[SearchAutocomplete] Algolia single-index failed', { index, error: err.message });
      }
    }

    if (tsOk && entry.typesenseCollection) {
      try {
        const params = {
          q:          expandedQuery,
          query_by:   'name,title,category',
          per_page:   hitsPerPage,
          page:       1,
          prefix:     true,
          filter_by:  'status:=active',
          use_cache:  true,
        };
        const raw = await _typesenseSearch(entry.typesenseCollection, tsKey, params, 4000);
        const suggestions = (raw.hits || []).map(hit => ({
          id:       hit.document?.id,
          label:    hit.document?.name || hit.document?.title || '',
          category: hit.document?.category || null,
          price:    hit.document?.price || null,
          image:    hit.document?.thumbnail || null,
          type:     'result',
        }));
        return { suggestions, latencyMs: Date.now() - startMs };
      } catch (err) {
        logger.warn('[SearchAutocomplete] Typesense single-index failed', { index, error: err.message });
      }
    }

    return { suggestions: [], latencyMs: Date.now() - startMs };
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
   3. searchNearby — geo-aware search
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Geo-aware search with Kenya bounding-box validation.
 * Results are sorted by distance from the provided coordinates.
 *
 * Coordinates are validated to fall within Kenya's bounding box:
 *   Latitude:  -5 to +5   (south of equator to north of Lake Turkana)
 *   Longitude: 34 to 42   (western border to coast)
 *
 * @type {import('firebase-functions/v2/https').CallableFunction}
 */
exports.searchNearby = onCall(
  {
    ...CF_OPTS,
    secrets: [ALGOLIA_SEARCH_KEY, TYPESENSE_SEARCH_KEY],
  },
  async (req) => {
    const uid      = _assertAuth(req);
    const startMs  = Date.now();

    const {
      query      = '',
      lat,
      lng,
      radiusKm   = 10,
      index      = 'products',
      hitsPerPage: rawHPP = 20,
      category,
    } = req.data || {};

    /* ── Coordinate validation ─────────────────────────────────────────── */
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      throw new HttpsError('invalid-argument', 'lat and lng are required numbers.');
    }
    if (lat < -5 || lat > 5 || lng < 34 || lng > 42) {
      throw new HttpsError('invalid-argument', 'Coordinates are outside the supported region. Only Kenya is supported (lat: -5 to 5, lng: 34 to 42).');
    }
    const radius     = Math.min(Math.max(Number(radiusKm) || 10, 0.5), 200);
    const hitsPerPage = Math.min(Math.max(parseInt(rawHPP, 10) || 20, 1), 100);
    const sanitizedQuery = _sanitizeQuery(query);

    const entry        = _resolveCollection(index);
    const algoliaKey   = ALGOLIA_SEARCH_KEY.value();
    const typesenseKey = TYPESENSE_SEARCH_KEY.value();
    const algoliaOk    = Boolean(algoliaKey   && algoliaKey   !== 'not_configured' && entry.algoliaIndex);
    const tsOk         = Boolean(typesenseKey && typesenseKey !== 'not_configured' && entry.typesenseCollection);

    const categoryFilter = category ? `category:"${String(category).replace(/"/g, '')}"` : '';

    /* ── Algolia geo search ─────────────────────────────────────────────── */
    if (algoliaOk) {
      try {
        const params = {
          query:         sanitizedQuery || '',
          hitsPerPage,
          page:          0,
          aroundLatLng:  `${lat},${lng}`,
          aroundRadius:  Math.round(radius * 1000), /* km → metres */
          filters:       [categoryFilter, 'NOT status:"deleted" AND NOT status:"draft"'].filter(Boolean).join(' AND '),
          getRankingInfo: true,
          userToken:     uid,
        };
        const raw  = await _algoliaSearch(entry.algoliaIndex, algoliaKey, params, 6000);
        const result = _normalizeAlgolia(raw, 'algolia', startMs);
        /* Attach distance metadata */
        result.hits = result.hits.map(h => ({
          ...h,
          distanceMetres: h._rankingInfo?.geoDistance || null,
        }));
        result.searchCenter = { lat, lng };
        result.radiusKm     = radius;
        _recordAnalytics(uid, sanitizedQuery, index, 'algolia', result.total, result.latencyMs);
        return result;
      } catch (err) {
        logger.warn('[SearchNearby] Algolia geo failed', { error: err.message });
      }
    }

    /* ── Typesense geo search fallback ─────────────────────────────────── */
    if (tsOk) {
      try {
        const tsFilterParts = ['status:=active'];
        if (category) tsFilterParts.push(`category:=${String(category).replace(/[`'"]/g, '')}`);
        tsFilterParts.push(`_geoloc:(${lat}, ${lng}, ${radius.toFixed(1)} km)`);

        const params = {
          q:          sanitizedQuery || '*',
          query_by:   'name,title,description,category',
          per_page:   hitsPerPage,
          page:       1,
          filter_by:  tsFilterParts.join(' && '),
          sort_by:    `_geoloc(${lat}, ${lng}):asc`,
          use_cache:  true,
        };
        const raw    = await _typesenseSearch(entry.typesenseCollection, typesenseKey, params, 6000);
        const result = _normalizeTypesense(raw, 'typesense', startMs, 0);
        result.searchCenter = { lat, lng };
        result.radiusKm     = radius;
        _recordAnalytics(uid, sanitizedQuery, index, 'typesense', result.total, result.latencyMs);
        return result;
      } catch (err) {
        logger.warn('[SearchNearby] Typesense geo failed', { error: err.message });
      }
    }

    throw new HttpsError('unavailable', 'Geo search is temporarily unavailable. Please try again.');
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
   4. searchSimilar — related items via Algolia Recommend or category fallback
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Returns similar / related items for a given item ID using the Algolia
 * Recommend API. Falls back to a Firestore category-based query when
 * Algolia Recommend is unavailable or the model has insufficient data.
 *
 * Supported models:
 *   'related-products'    — Algolia Related Products model
 *   'bought-together'     — Algolia Frequently Bought Together model
 *   'trending'            — Algolia Trending Items (no objectID required)
 *
 * @type {import('firebase-functions/v2/https').CallableFunction}
 */
exports.searchSimilar = onCall(
  {
    ...CF_OPTS,
    secrets: [ALGOLIA_ADMIN_KEY, ALGOLIA_SEARCH_KEY],
  },
  async (req) => {
    const uid     = _assertAuth(req);
    const startMs = Date.now();

    const {
      itemId,
      index  = 'products',
      limit  = 8,
      model  = 'related-products',
    } = req.data || {};

    if (!itemId) throw new HttpsError('invalid-argument', 'itemId is required.');

    const VALID_MODELS = new Set(['related-products', 'bought-together', 'trending']);
    if (!VALID_MODELS.has(model)) throw new HttpsError('invalid-argument', `model must be one of: ${[...VALID_MODELS].join(', ')}`);

    const hitsPerPage = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 50);
    const entry       = _resolveCollection(index);
    const algoliaKey  = ALGOLIA_ADMIN_KEY.value(); /* Recommend API requires admin key */

    /* ── Algolia Recommend REST call ──────────────────────────────────── */
    if (algoliaKey && algoliaKey !== 'not_configured' && entry.algoliaIndex) {
      try {
        const appId = process.env.ALGOLIA_APP_ID;
        const url   = `https://${appId}.algolia.net/1/indexes/*/recommendations`;
        const body  = {
          requests: [
            {
              indexName:          entry.algoliaIndex,
              objectID:           itemId,
              model,
              maxRecommendations: hitsPerPage,
              threshold:          0,
              queryParameters: {
                attributesToRetrieve: ['name', 'title', 'price', 'thumbnail', 'category', 'rating'],
              },
            },
          ],
        };
        const res   = await _httpsRequest(url, 'POST', {
          'X-Algolia-Application-Id': appId,
          'X-Algolia-API-Key':        algoliaKey,
        }, body, 6000);

        if (res.status < 400 && Array.isArray(res.body?.results)) {
          const hits = (res.body.results[0]?.hits || []).map(h => ({
            id:        h.objectID || h.id,
            name:      h.name || h.title || '',
            price:     h.price || null,
            image:     h.thumbnail || null,
            category:  h.category || null,
            rating:    h.rating || null,
          }));
          return {
            recommendations: hits,
            model,
            source:    'algolia_recommend',
            latencyMs: Date.now() - startMs,
          };
        }
        logger.warn('[SearchSimilar] Algolia Recommend returned non-200', { status: res.status, model });
      } catch (err) {
        logger.warn('[SearchSimilar] Algolia Recommend failed, using category fallback', { error: err.message });
      }
    }

    /* ── Firestore category fallback ──────────────────────────────────── */
    try {
      const fsCollection = entry.firestoreCollection || index;
      const sourceDoc    = await db.collection(fsCollection).doc(itemId).get();
      if (!sourceDoc.exists) {
        return { recommendations: [], model, source: 'category_fallback', latencyMs: Date.now() - startMs };
      }
      const sourceData = sourceDoc.data();
      const category   = sourceData.category || sourceData.type || null;

      if (!category) {
        return { recommendations: [], model, source: 'category_fallback', latencyMs: Date.now() - startMs };
      }

      const snap = await db.collection(fsCollection)
        .where('category', '==', category)
        .where('status', '==', 'active')
        .orderBy('_popularityScore', 'desc')
        .limit(hitsPerPage + 1)
        .get();

      const recommendations = snap.docs
        .filter(doc => doc.id !== itemId)
        .slice(0, hitsPerPage)
        .map(doc => {
          const d = doc.data();
          return {
            id:       doc.id,
            name:     d.name || d.title || '',
            price:    d.price || null,
            image:    d.thumbnail || null,
            category: d.category || null,
            rating:   d.rating || null,
          };
        });

      return {
        recommendations,
        model,
        source:    'category_fallback',
        latencyMs: Date.now() - startMs,
      };
    } catch (err) {
      logger.error('[SearchSimilar] Category fallback failed', { error: err.message });
      throw new HttpsError('internal', 'Unable to retrieve recommendations at this time.');
    }
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
   5. searchPersonalized — personalization-aware search
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Returns personalized search results based on the user's purchase and
 * browsing history using Algolia's server-side personalization (userToken).
 *
 * Falls back to Typesense with popularity-based ranking when Algolia is
 * unavailable or misconfigured.
 *
 * @type {import('firebase-functions/v2/https').CallableFunction}
 */
exports.searchPersonalized = onCall(
  {
    ...CF_OPTS,
    secrets: [ALGOLIA_SEARCH_KEY, TYPESENSE_SEARCH_KEY],
  },
  async (req) => {
    const uid     = _assertAuth(req);
    const startMs = Date.now();

    const {
      query    = '',
      index    = 'products',
      hitsPerPage: rawHPP = 20,
    } = req.data || {};

    const sanitizedQuery = _sanitizeQuery(query);
    const hitsPerPage    = Math.min(Math.max(parseInt(rawHPP, 10) || 20, 1), 100);
    const entry          = _resolveCollection(index);
    const algoliaKey     = ALGOLIA_SEARCH_KEY.value();
    const tsKey          = TYPESENSE_SEARCH_KEY.value();

    /* ── User preference context (non-blocking — enriches Algolia signal) */
    let userPreferences = {};
    try {
      const userSnap = await db.collection('users').doc(uid).get();
      if (userSnap.exists) {
        const u = userSnap.data();
        userPreferences = {
          favouriteCategories: u.favouriteCategories || [],
          location:            u.location?.city || null,
        };
      }
    } catch (_) { /* non-fatal — proceed without preferences */ }

    /* ── Algolia personalized search ──────────────────────────────────── */
    if (algoliaKey && algoliaKey !== 'not_configured' && entry.algoliaIndex) {
      try {
        const filterParts = ['NOT status:"deleted" AND NOT status:"draft"'];
        if (userPreferences.location) {
          /* Soft-boost user's city — optional filter rather than hard filter */
        }

        const params = {
          query:                sanitizedQuery || '',
          hitsPerPage,
          page:                 0,
          filters:              filterParts.join(' AND '),
          userToken:            uid,
          enablePersonalization: true,
          personalizationImpact: 75,
          analytics:            true,
          facets:               ['category', 'brand', 'location.city'],
          /* Optionally boost preferred categories via optionalFilters */
          ...(userPreferences.favouriteCategories?.length > 0 ? {
            optionalFilters: userPreferences.favouriteCategories.slice(0, 5)
              .map(c => `category:"${String(c).replace(/"/g, '')}"<score=3>`),
          } : {}),
        };
        const raw    = await _algoliaSearch(entry.algoliaIndex, algoliaKey, params, 5000);
        const result = _normalizeAlgolia(raw, 'algolia', startMs);
        result.personalized = true;
        _recordAnalytics(uid, sanitizedQuery, index, 'algolia', result.total, result.latencyMs);
        return result;
      } catch (err) {
        logger.warn('[SearchPersonalized] Algolia failed, falling back to Typesense', { error: err.message });
      }
    }

    /* ── Typesense popularity fallback ────────────────────────────────── */
    if (tsKey && tsKey !== 'not_configured' && entry.typesenseCollection) {
      try {
        const params = {
          q:         sanitizedQuery || '*',
          query_by:  'name,description,category',
          per_page:  hitsPerPage,
          page:      1,
          filter_by: 'status:=active',
          sort_by:   '_popularityScore:desc,_salesScore:desc',
          use_cache: true,
        };
        const raw    = await _typesenseSearch(entry.typesenseCollection, tsKey, params, 5000);
        const result = _normalizeTypesense(raw, 'typesense', startMs, 0);
        result.personalized = false;
        _recordAnalytics(uid, sanitizedQuery, index, 'typesense', result.total, result.latencyMs);
        return result;
      } catch (err) {
        logger.error('[SearchPersonalized] Typesense fallback failed', { error: err.message });
      }
    }

    throw new HttpsError('unavailable', 'Personalized search is temporarily unavailable.');
  }
);

/* ══════════════════════════════════════════════════════════════════════════════
   6. searchIntent — deterministic intent classification + Swahili expansion
══════════════════════════════════════════════════════════════════════════════ */

/**
 * Classifies a natural-language search query into an intent category and
 * returns a structured intent object with suggested index, filters, and
 * an expanded/normalized query for the Kenyan market.
 *
 * Classification is fully deterministic (regex pattern matching) — no
 * external AI API call is made. This ensures sub-10ms response times and
 * zero dependency on third-party AI availability.
 *
 * The returned enhanced_query expands Swahili terms to their English
 * equivalents so that Algolia/Typesense can match bilingual content.
 *
 * @type {import('firebase-functions/v2/https').CallableFunction}
 */
exports.searchIntent = onCall(
  { ...CF_OPTS, timeoutSeconds: 5 },
  async (req) => {
    _assertAuth(req);

    const {
      query   = '',
      context = {},
    } = req.data || {};

    const sanitizedQuery = _sanitizeQuery(query);
    if (!sanitizedQuery) {
      return {
        query:            '',
        intent:           'empty',
        suggestedIndex:   'sokoni_products',
        suggestedFilters: {},
        confidence:       0,
        enhanced_query:   '',
        expansions:       [],
      };
    }

    /* ── Intent classification ────────────────────────────────────────── */
    const intentResult = _detectIntent(sanitizedQuery);

    /* ── Swahili expansion ────────────────────────────────────────────── */
    const queryLower    = sanitizedQuery.toLowerCase();
    const expansions    = [];
    let   enhancedQuery = sanitizedQuery;

    for (const [sw, en] of Object.entries(SWAHILI_EXPANSIONS)) {
      if (queryLower.includes(sw)) {
        /* Append English expansions without replacing the Swahili term
           so bilingual indexes can match either language */
        enhancedQuery = `${sanitizedQuery} ${en}`;
        expansions.push({ from: sw, to: en });
        break; /* Apply only the first matched expansion to avoid bloat */
      }
    }

    /* ── Context-aware adjustments ────────────────────────────────────── */
    const { page, recentSearches = [], userLocation } = context;
    let   suggestedFilters = intentResult.suggestedFilters || {};

    /* Inject user location into geo intents when the caller provides it */
    if ((intentResult.intent === 'geo' || intentResult.intent === 'geo_nearby') && userLocation) {
      if (userLocation.city && !suggestedFilters.city) {
        suggestedFilters = { ...suggestedFilters, city: userLocation.city };
      }
    }

    /* Recent search context — boost the re-query if identical to a recent one */
    const isRepeatSearch = recentSearches.some(rs =>
      typeof rs === 'string' && rs.toLowerCase().trim() === queryLower
    );

    return {
      query:            sanitizedQuery,
      intent:           intentResult.intent,
      suggestedIndex:   intentResult.index || 'sokoni_products',
      suggestedFilters,
      confidence:       intentResult.confidence,
      enhanced_query:   enhancedQuery,
      expansions,
      isRepeatSearch,
      contextPage:      page || null,
    };
  }
);
