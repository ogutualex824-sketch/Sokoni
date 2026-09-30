/**
 * SOKONI Typesense Enterprise Client v2.0
 *
 * Production-grade HTTP client supporting:
 *  - 25 typed collection schemas (all hubs)
 *  - Multi-node round-robin with per-node circuit-breaker (CLOSED → OPEN → HALF_OPEN)
 *  - Persistent keep-alive connection pool (one Agent per node)
 *  - Exponential back-off with ±25% jitter on retry
 *  - 10 000-doc JSONL batch import (Typesense hard limit)
 *  - _popularityScore, _salesScore, _clickScore, _conversionScore on every schema
 *  - Collection aliases for zero-downtime re-index (blue-green)
 *  - Kenyan marketplace synonyms (13 synonym sets)
 *  - Override / curation API
 *  - Preset API
 *
 * Zero npm dependencies — native Node.js `https`/`http` + `crypto`.
 */

'use strict';

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

/* ═══════════════════════════════════════════════════════════════════
   CONNECTION POOL — one keep-alive Agent per physical node
════════════════════════════════════════════════════════════════════ */

const _agents = new Map();

function _getAgent(node) {
  const key = `${node.host}:${node.port}`;
  if (_agents.has(key)) return _agents.get(key);
  const AgentClass = node.proto === 'https' ? https.Agent : http.Agent;
  const agent = new AgentClass({
    keepAlive:       true,
    keepAliveMsecs:  60_000,
    maxSockets:      50,
    maxFreeSockets:  10,
    timeout:         15_000,
    scheduling:      'lifo',
  });
  _agents.set(key, agent);
  return agent;
}

/* ═══════════════════════════════════════════════════════════════════
   CIRCUIT BREAKER — per node
   CLOSED (normal) → failure threshold → OPEN (reject instantly)
   → HALF_OPEN after cooldown → one probe → close or reopen
════════════════════════════════════════════════════════════════════ */

class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 30_000 } = {}) {
    this._threshold = threshold;
    this._cooldown  = cooldownMs;
    this._failures  = 0;
    this._state     = 'CLOSED';
    this._openedAt  = 0;
  }

  isOpen() {
    if (this._state === 'OPEN') {
      if (Date.now() - this._openedAt >= this._cooldown) {
        this._state = 'HALF_OPEN';
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess() { this._failures = 0; this._state = 'CLOSED'; }

  recordFailure() {
    this._failures++;
    if (this._failures >= this._threshold) {
      this._state    = 'OPEN';
      this._openedAt = Date.now();
    }
  }

  get state() { return this._state; }
}

/* ═══════════════════════════════════════════════════════════════════
   TYPESENSE HTTP CLIENT
════════════════════════════════════════════════════════════════════ */

class TypesenseClient {
  /**
   * @param {string[]} nodes    Array of "host:port:protocol" strings
   * @param {string}   adminKey Typesense admin API key (server-side only)
   * @param {object}   opts     Optional overrides
   */
  constructor(nodes, adminKey, opts = {}) {
    if (!nodes?.length || !adminKey) throw new Error('[Typesense] nodes + adminKey required');
    this._nodes      = nodes.map(n => {
      const [host, port = '443', proto = 'https'] = n.split(':');
      return { host, port: parseInt(port, 10), proto };
    });
    this._adminKey   = adminKey;
    this._cursor     = 0;
    this._breakers   = this._nodes.map(() => new CircuitBreaker({
      threshold:   opts.cbThreshold   || 5,
      cooldownMs:  opts.cbCooldownMs  || 30_000,
    }));
    this._timeoutMs  = opts.timeoutMs  || 15_000;
    this._maxRetries = opts.maxRetries || 4;
  }

  /* ── Node selection ─────────────────────────────────────────────── */

  _nextNode() {
    const total = this._nodes.length;
    for (let i = 0; i < total; i++) {
      const idx = (this._cursor + i) % total;
      if (!this._breakers[idx].isOpen()) {
        this._cursor = (idx + 1) % total;
        return { node: this._nodes[idx], idx };
      }
    }
    /* All circuit-breakers open → force reset node 0 */
    this._breakers.forEach(b => b.recordSuccess());
    return { node: this._nodes[0], idx: 0 };
  }

  /* ── Core HTTP ──────────────────────────────────────────────────── */

  async _request(method, path, body = null, {
    maxRetries  = this._maxRetries,
    backoffBase = 200,
    rawBody     = false,
    contentType = 'application/json',
    queryParams = {},
    apiKey      = null,
  } = {}) {
    const qs      = Object.keys(queryParams).length
      ? '?' + new URLSearchParams(queryParams).toString()
      : '';
    const payload = body
      ? (rawBody ? body : JSON.stringify(body))
      : null;

    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        const base   = backoffBase * Math.pow(2, attempt - 1);
        const jitter = base * 0.25 * (Math.random() * 2 - 1);
        await _sleep(Math.round(base + jitter));
      }
      const { node, idx } = this._nextNode();
      try {
        const result = await this._doRequest(node, method, path + qs, payload, contentType, apiKey);
        this._breakers[idx].recordSuccess();
        return result;
      } catch (err) {
        lastError = err;
        /* 4xx errors (except 429 rate-limit) are client errors → do not retry */
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
        this._breakers[idx].recordFailure();
      }
    }
    throw lastError;
  }

  _doRequest(node, method, path, payload, contentType, apiKey) {
    return new Promise((resolve, reject) => {
      const lib  = node.proto === 'https' ? https : http;
      const opts = {
        hostname: node.host,
        port:     node.port,
        path,
        method,
        agent:    _getAgent(node),
        headers: {
          'X-TYPESENSE-API-KEY': apiKey || this._adminKey,
          'Content-Type':        contentType,
          'User-Agent':          'SOKONI-CF/2.0 (enterprise)',
          Connection:            'keep-alive',
          ...(payload != null ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      };

      const req = lib.request(opts, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            let parsed;
            try { parsed = JSON.parse(raw); } catch (_) { parsed = { message: raw }; }
            const err    = new Error(parsed.message || `Typesense HTTP ${res.statusCode}`);
            err.status   = res.statusCode;
            err.body     = parsed;
            return reject(err);
          }
          /* JSONL bulk-import responses are newline-delimited JSON */
          if (contentType === 'text/plain' && raw.includes('\n')) {
            const lines = raw.trim().split('\n')
              .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
              .filter(Boolean);
            return resolve(lines);
          }
          try { resolve(JSON.parse(raw)); }
          catch (_) { resolve({ raw }); }
        });
      });

      req.setTimeout(this._timeoutMs, () => {
        req.destroy();
        const err  = new Error('Typesense request timeout');
        err.status = 0;
        reject(err);
      });
      req.on('error', reject);
      if (payload != null) req.write(payload);
      req.end();
    });
  }

  /* ── Collection Management ──────────────────────────────────────── */

  createCollection(schema)         { return this._request('POST',   '/collections', schema); }
  getCollection(name)              { return this._request('GET',    `/collections/${_enc(name)}`); }
  listCollections()                { return this._request('GET',    '/collections'); }
  deleteCollection(name)           { return this._request('DELETE', `/collections/${_enc(name)}`); }
  updateCollectionFields(name, fields) {
    return this._request('PATCH', `/collections/${_enc(name)}`, { fields });
  }
  async collectionExists(name) {
    try { await this.getCollection(name); return true; }
    catch (err) { if (err.status === 404) return false; throw err; }
  }

  /* ── Aliases ────────────────────────────────────────────────────── */

  createAlias(name, collectionName) {
    return this._request('PUT', `/aliases/${_enc(name)}`, { collection_name: collectionName });
  }
  getAlias(name)    { return this._request('GET',    `/aliases/${_enc(name)}`); }
  listAliases()     { return this._request('GET',    '/aliases'); }
  deleteAlias(name) { return this._request('DELETE', `/aliases/${_enc(name)}`); }

  /* ── Documents ──────────────────────────────────────────────────── */

  upsertDocument(collection, doc) {
    return this._request('POST', `/collections/${_enc(collection)}/documents`, doc, {
      queryParams: { action: 'upsert' },
    });
  }
  patchDocument(collection, id, partial) {
    return this._request('PATCH', `/collections/${_enc(collection)}/documents/${_enc(id)}`, partial);
  }
  deleteDocument(collection, id) {
    return this._request('DELETE', `/collections/${_enc(collection)}/documents/${_enc(id)}`);
  }
  deleteByFilter(collection, filterBy) {
    return this._request('DELETE', `/collections/${_enc(collection)}/documents`, null, {
      queryParams: { filter_by: filterBy },
    });
  }

  /**
   * Batch import via JSONL — auto-chunks at 10 000 docs (Typesense hard limit).
   * Returns flat array of per-document {success, error} objects.
   */
  async importDocuments(collection, documents, action = 'upsert') {
    if (!documents.length) return [];
    const allResults = [];
    for (const chunk of _chunk(documents, 10_000)) {
      const jsonl = chunk.map(d => JSON.stringify(d)).join('\n');
      const res   = await this._request(
        'POST',
        `/collections/${_enc(collection)}/documents/import`,
        jsonl,
        { queryParams: { action }, rawBody: true, contentType: 'text/plain' }
      );
      allResults.push(...(Array.isArray(res) ? res : [res]));
    }
    return allResults;
  }

  exportDocuments(collection, opts = {}) {
    return this._request('GET', `/collections/${_enc(collection)}/documents/export`, null, {
      queryParams: { ...opts }, rawBody: true,
    });
  }

  /* ── Search ─────────────────────────────────────────────────────── */

  search(collection, params) {
    return this._request('GET', `/collections/${_enc(collection)}/documents/search`, null, {
      queryParams: _cleanParams(params),
    });
  }

  multiSearch(searches, commonParams = {}) {
    const path = Object.keys(commonParams).length
      ? `/multi_search?${new URLSearchParams(_cleanParams(commonParams)).toString()}`
      : '/multi_search';
    return this._request('POST', path, { searches });
  }

  /* ── Synonyms ───────────────────────────────────────────────────── */

  upsertSynonym(collection, synonymId, synonym) {
    return this._request('PUT', `/collections/${_enc(collection)}/synonyms/${_enc(synonymId)}`, synonym);
  }
  listSynonyms(collection) {
    return this._request('GET', `/collections/${_enc(collection)}/synonyms`);
  }
  deleteSynonym(collection, synonymId) {
    return this._request('DELETE', `/collections/${_enc(collection)}/synonyms/${_enc(synonymId)}`);
  }

  /* ── Overrides / Curation ───────────────────────────────────────── */

  upsertOverride(collection, overrideId, rule) {
    return this._request('PUT', `/collections/${_enc(collection)}/overrides/${_enc(overrideId)}`, rule);
  }
  listOverrides(collection) {
    return this._request('GET', `/collections/${_enc(collection)}/overrides`);
  }
  deleteOverride(collection, overrideId) {
    return this._request('DELETE', `/collections/${_enc(collection)}/overrides/${_enc(overrideId)}`);
  }

  /* ── Presets ────────────────────────────────────────────────────── */

  upsertPreset(name, preset) {
    return this._request('PUT', `/presets/${_enc(name)}`, preset);
  }
  listPresets() { return this._request('GET', '/presets'); }

  /* ── Scoped API Key (no HTTP call — pure HMAC) ───────────────────── */

  generateScopedKey(searchOnlyKey, params) {
    const paramsJson = JSON.stringify(params);
    const hmac       = crypto.createHmac('sha256', searchOnlyKey).update(paramsJson).digest('hex');
    return Buffer.from(hmac + paramsJson).toString('base64');
  }

  /* ── Health / Metrics ───────────────────────────────────────────── */

  health(timeoutMs = 5_000) {
    return this._request('GET', '/health', null, { queryParams: { timeout_ms: timeoutMs } });
  }
  metrics() { return this._request('GET', '/metrics.json'); }
  stats()   { return this._request('GET', '/stats.json'); }
  debug()   { return this._request('GET', '/debug'); }

  async nodeStatuses() {
    const results = await Promise.allSettled(
      this._nodes.map((node, i) =>
        this._doRequest(node, 'GET', '/health', null, 'application/json', null)
          .then(r => ({
            node:    `${node.host}:${node.port}`,
            status:  'healthy',
            circuit: this._breakers[i].state,
            ...r,
          }))
          .catch(e => ({
            node:    `${node.host}:${node.port}`,
            status:  'unhealthy',
            circuit: this._breakers[i].state,
            error:   e.message,
          }))
      )
    );
    return results.map(r => r.status === 'fulfilled' ? r.value : r.reason);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   SHARED RANKING FIELDS — appended to every schema
   All fields optional so existing docs without scores still index.
════════════════════════════════════════════════════════════════════ */

const _RANKING_FIELDS = [
  { name: '_popularityScore',  type: 'float', optional: true, sort: true },
  { name: '_salesScore',       type: 'float', optional: true, sort: true },
  { name: '_clickScore',       type: 'float', optional: true, sort: true },
  { name: '_conversionScore',  type: 'float', optional: true, sort: true },
];

const _GEO_FIELDS = [
  { name: 'location',          type: 'geopoint', optional: true },
  { name: 'location_area',     type: 'string',   facet: true, optional: true },
  { name: 'location_suburb',   type: 'string',   facet: true, optional: true },
  { name: 'location_city',     type: 'string',   facet: true, optional: true },
  { name: 'location_county',   type: 'string',   facet: true, optional: true },
  { name: 'location_country',  type: 'string',   facet: true, optional: true },
];

const _META_FIELDS = [
  { name: 'status',        type: 'string',  facet: true },
  { name: 'isFeatured',    type: 'bool',    facet: true, optional: true },
  { name: 'featuredLevel', type: 'int32',   optional: true, sort: true },
  { name: 'verified',      type: 'bool',    facet: true, optional: true },
  { name: 'tags',          type: 'string[]',facet: true, optional: true },
  { name: 'createdAt',     type: 'int64',   sort: true },
  { name: 'updatedAt',     type: 'int64',   optional: true, sort: true },
];

function _schema(name, fields, defaultSort = null, extra = {}) {
  const schema = {
    name,
    enable_nested_fields: true,
    token_separators:     ['-', '_', '.', '/'],
    symbols_to_index:     ['%', '+', '@'],
    fields: [
      { name: 'id', type: 'string' },
      ...fields,
      ..._GEO_FIELDS,
      ..._META_FIELDS,
      ..._RANKING_FIELDS,
    ],
    ...extra,
  };
  /* Typesense forbids optional fields as default_sorting_field — omit unless caller is certain the field is always present */
  if (defaultSort) schema.default_sorting_field = defaultSort;
  return schema;
}

/* ═══════════════════════════════════════════════════════════════════
   25 COLLECTION SCHEMAS
════════════════════════════════════════════════════════════════════ */

const COLLECTION_SCHEMAS = {

  /* 1 ── Products */
  sokoni_products: _schema('sokoni_products', [
    { name: 'name',             type: 'string' },
    { name: 'description',      type: 'string',  optional: true },
    { name: 'category',         type: 'string',  facet: true },
    { name: 'subcategory',      type: 'string',  facet: true,    optional: true },
    { name: 'brand',            type: 'string',  facet: true,    optional: true },
    { name: 'sku',              type: 'string',  optional: true },
    { name: 'barcode',          type: 'string',  optional: true },
    { name: 'price',            type: 'float',   sort: true },
    { name: 'originalPrice',    type: 'float',   optional: true },
    { name: 'discountPercent',  type: 'float',   optional: true, sort: true },
    { name: 'currency',         type: 'string',  optional: true, index: false },
    { name: 'inStock',          type: 'bool',    facet: true },
    { name: 'stockQty',         type: 'int32',   optional: true, sort: true },
    { name: 'condition',        type: 'string',  facet: true,    optional: true },
    { name: 'hub',              type: 'string',  facet: true,    optional: true },
    { name: 'sellerId',         type: 'string',  facet: true,    optional: true },
    { name: 'sellerName',       type: 'string',  optional: true },
    { name: 'sellerVerified',   type: 'bool',    facet: true,    optional: true },
    { name: 'sellerRating',     type: 'float',   optional: true },
    { name: 'rating',           type: 'float',   optional: true, sort: true },
    { name: 'reviewCount',      type: 'int32',   optional: true, sort: true },
    { name: 'orderCount',       type: 'int32',   optional: true, sort: true },
    { name: 'viewCount',        type: 'int32',   optional: true, sort: true },
    { name: 'wishlistCount',    type: 'int32',   optional: true },
    { name: 'thumbnail',        type: 'string',  optional: true, index: false },
    { name: 'deliveryOptions',  type: 'string[]',facet: true,    optional: true },
    { name: 'isNew',            type: 'bool',    facet: true,    optional: true },
    { name: 'isOnSale',         type: 'bool',    facet: true,    optional: true },
    { name: 'isBestseller',     type: 'bool',    facet: true,    optional: true },
    { name: 'keywords',         type: 'string[]',optional: true, index: false },
  ]),

  /* 2 ── Shops */
  sokoni_shops: _schema('sokoni_shops', [
    { name: 'name',            type: 'string' },
    { name: 'description',     type: 'string',  optional: true },
    { name: 'category',        type: 'string',  facet: true,    optional: true },
    { name: 'logo',            type: 'string',  optional: true, index: false },
    { name: 'phone',           type: 'string',  optional: true, index: false },
    { name: 'rating',          type: 'float',   optional: true, sort: true },
    { name: 'reviewCount',     type: 'int32',   optional: true, sort: true },
    { name: 'orderCount',      type: 'int32',   optional: true, sort: true },
    { name: 'followerCount',   type: 'int32',   optional: true, sort: true },
    { name: 'productCount',    type: 'int32',   optional: true, sort: true },
    { name: 'deliveryOptions', type: 'string[]',facet: true,    optional: true },
    { name: 'joinedAt',        type: 'int64',   sort: true },
  ]),

  /* 3 ── Services / Providers */
  sokoni_services: _schema('sokoni_services', [
    { name: 'name',             type: 'string' },
    { name: 'description',      type: 'string',  optional: true },
    { name: 'category',         type: 'string',  facet: true,    optional: true },
    { name: 'subcategory',      type: 'string',  facet: true,    optional: true },
    { name: 'price',            type: 'float',   optional: true, sort: true },
    { name: 'priceMax',         type: 'float',   optional: true },
    { name: 'priceType',        type: 'string',  facet: true,    optional: true },
    { name: 'thumbnail',        type: 'string',  optional: true, index: false },
    { name: 'providerId',       type: 'string',  facet: true,    optional: true },
    { name: 'providerName',     type: 'string',  optional: true },
    { name: 'providerVerified', type: 'bool',    facet: true,    optional: true },
    { name: 'rating',           type: 'float',   optional: true, sort: true },
    { name: 'reviewCount',      type: 'int32',   optional: true, sort: true },
    { name: 'orderCount',       type: 'int32',   optional: true, sort: true },
    { name: 'remote',           type: 'bool',    facet: true,    optional: true },
    { name: 'hub',              type: 'string',  facet: true,    optional: true },
  ]),

  /* 4 ── Jobs / Gigs */
  sokoni_jobs: _schema('sokoni_jobs', [
    { name: 'title',             type: 'string' },
    { name: 'company',           type: 'string',  optional: true },
    { name: 'description',       type: 'string',  optional: true },
    { name: 'category',          type: 'string',  facet: true,    optional: true },
    { name: 'jobType',           type: 'string',  facet: true,    optional: true },
    { name: 'remote',            type: 'bool',    facet: true,    optional: true },
    { name: 'salaryMin',         type: 'float',   optional: true, sort: true },
    { name: 'salaryMax',         type: 'float',   optional: true },
    { name: 'skills',            type: 'string[]',facet: true,    optional: true },
    { name: 'experience',        type: 'string',  facet: true,    optional: true },
    { name: 'education',         type: 'string',  facet: true,    optional: true },
    { name: 'deadline',          type: 'int64',   optional: true, sort: true },
    { name: 'applicationCount',  type: 'int32',   optional: true, sort: true },
  ], 'createdAt'),

  /* 5 ── Vehicles */
  sokoni_vehicles: _schema('sokoni_vehicles', [
    { name: 'title',        type: 'string' },
    { name: 'make',         type: 'string',  facet: true },
    { name: 'model',        type: 'string',  facet: true,    optional: true },
    { name: 'year',         type: 'int32',   facet: true,    optional: true, sort: true },
    { name: 'type',         type: 'string',  facet: true,    optional: true },
    { name: 'bodyType',     type: 'string',  facet: true,    optional: true },
    { name: 'listingType',  type: 'string',  facet: true,    optional: true },
    { name: 'price',        type: 'float',   sort: true },
    { name: 'mileage',      type: 'int32',   optional: true, sort: true },
    { name: 'condition',    type: 'string',  facet: true,    optional: true },
    { name: 'fuelType',     type: 'string',  facet: true,    optional: true },
    { name: 'transmission', type: 'string',  facet: true,    optional: true },
    { name: 'color',        type: 'string',  facet: true,    optional: true },
    { name: 'features',     type: 'string[]',facet: true,    optional: true },
    { name: 'thumbnail',    type: 'string',  optional: true, index: false },
    { name: 'sellerDealer', type: 'bool',    facet: true,    optional: true },
  ]),

  /* 6 ── Properties */
  sokoni_properties: _schema('sokoni_properties', [
    { name: 'title',         type: 'string' },
    { name: 'description',   type: 'string',  optional: true },
    { name: 'type',          type: 'string',  facet: true,    optional: true },
    { name: 'listingType',   type: 'string',  facet: true,    optional: true },
    { name: 'price',         type: 'float',   sort: true },
    { name: 'bedrooms',      type: 'int32',   facet: true,    optional: true, sort: true },
    { name: 'bathrooms',     type: 'int32',   optional: true },
    { name: 'sizeSqm',       type: 'float',   optional: true, sort: true },
    { name: 'furnished',     type: 'bool',    facet: true,    optional: true },
    { name: 'amenities',     type: 'string[]',facet: true,    optional: true },
    { name: 'thumbnail',     type: 'string',  optional: true, index: false },
    { name: 'agentName',     type: 'string',  optional: true },
    { name: 'agentVerified', type: 'bool',    facet: true,    optional: true },
  ]),

  /* 7 ── Events */
  sokoni_events: _schema('sokoni_events', [
    { name: 'title',          type: 'string' },
    { name: 'description',    type: 'string',  optional: true },
    { name: 'category',       type: 'string',  facet: true,    optional: true },
    { name: 'price',          type: 'float',   optional: true, sort: true },
    { name: 'isFree',         type: 'bool',    facet: true,    optional: true },
    { name: 'startDate',      type: 'int64',   sort: true },
    { name: 'endDate',        type: 'int64',   optional: true },
    { name: 'venue',          type: 'string',  optional: true },
    { name: 'organizerName',  type: 'string',  optional: true },
    { name: 'attendeeCount',  type: 'int32',   optional: true, sort: true },
    { name: 'isOnline',       type: 'bool',    facet: true,    optional: true },
    { name: 'thumbnail',      type: 'string',  optional: true, index: false },
  ]),

  /* 8 ── Hotels / BnB */
  sokoni_hotels: _schema('sokoni_hotels', [
    { name: 'name',            type: 'string' },
    { name: 'description',     type: 'string',  optional: true },
    { name: 'type',            type: 'string',  facet: true,    optional: true },
    { name: 'starRating',      type: 'int32',   facet: true,    optional: true, sort: true },
    { name: 'pricePerNight',   type: 'float',   sort: true },
    { name: 'amenities',       type: 'string[]',facet: true,    optional: true },
    { name: 'roomTypes',       type: 'string[]',facet: true,    optional: true },
    { name: 'rating',          type: 'float',   optional: true, sort: true },
    { name: 'reviewCount',     type: 'int32',   optional: true, sort: true },
    { name: 'thumbnail',       type: 'string',  optional: true, index: false },
    { name: 'checkInTime',     type: 'string',  optional: true, index: false },
    { name: 'checkOutTime',    type: 'string',  optional: true, index: false },
    { name: 'hostName',        type: 'string',  optional: true },
    { name: 'instantBook',     type: 'bool',    facet: true,    optional: true },
    { name: 'petFriendly',     type: 'bool',    facet: true,    optional: true },
    { name: 'maxGuests',       type: 'int32',   optional: true },
  ]),

  /* 9 ── Restaurants / Food */
  sokoni_restaurants: _schema('sokoni_restaurants', [
    { name: 'name',          type: 'string' },
    { name: 'description',   type: 'string',  optional: true },
    { name: 'cuisine',       type: 'string[]',facet: true,    optional: true },
    { name: 'priceRange',    type: 'string',  facet: true,    optional: true },
    { name: 'minOrder',      type: 'float',   optional: true },
    { name: 'deliveryTime',  type: 'int32',   optional: true, sort: true },
    { name: 'rating',        type: 'float',   optional: true, sort: true },
    { name: 'reviewCount',   type: 'int32',   optional: true, sort: true },
    { name: 'orderCount',    type: 'int32',   optional: true, sort: true },
    { name: 'isOpen',        type: 'bool',    facet: true,    optional: true },
    { name: 'hasDelivery',   type: 'bool',    facet: true,    optional: true },
    { name: 'hasDineIn',     type: 'bool',    facet: true,    optional: true },
    { name: 'hasPickup',     type: 'bool',    facet: true,    optional: true },
    { name: 'dietary',       type: 'string[]',facet: true,    optional: true },
    { name: 'thumbnail',     type: 'string',  optional: true, index: false },
    { name: 'phone',         type: 'string',  optional: true, index: false },
  ]),

  /* 10 ── Sports / Fitness */
  sokoni_sports: _schema('sokoni_sports', [
    { name: 'name',          type: 'string' },
    { name: 'description',   type: 'string',  optional: true },
    { name: 'type',          type: 'string',  facet: true,    optional: true },
    { name: 'sport',         type: 'string[]',facet: true,    optional: true },
    { name: 'price',         type: 'float',   optional: true, sort: true },
    { name: 'priceType',     type: 'string',  facet: true,    optional: true },
    { name: 'rating',        type: 'float',   optional: true, sort: true },
    { name: 'reviewCount',   type: 'int32',   optional: true, sort: true },
    { name: 'facilities',    type: 'string[]',facet: true,    optional: true },
    { name: 'ageGroup',      type: 'string',  facet: true,    optional: true },
    { name: 'gender',        type: 'string',  facet: true,    optional: true },
    { name: 'coachName',     type: 'string',  optional: true },
    { name: 'thumbnail',     type: 'string',  optional: true, index: false },
  ]),

  /* 11 ── Healthcare */
  sokoni_healthcare: _schema('sokoni_healthcare', [
    { name: 'name',              type: 'string' },
    { name: 'description',       type: 'string',  optional: true },
    { name: 'type',              type: 'string',  facet: true,    optional: true },
    { name: 'specialty',         type: 'string[]',facet: true,    optional: true },
    { name: 'price',             type: 'float',   optional: true, sort: true },
    { name: 'consultationType',  type: 'string',  facet: true,    optional: true },
    { name: 'rating',            type: 'float',   optional: true, sort: true },
    { name: 'reviewCount',       type: 'int32',   optional: true, sort: true },
    { name: 'experience',        type: 'int32',   optional: true, sort: true },
    { name: 'languages',         type: 'string[]',facet: true,    optional: true },
    { name: 'insurance',         type: 'string[]',facet: true,    optional: true },
    { name: 'isOnline',          type: 'bool',    facet: true,    optional: true },
    { name: 'acceptsWalkIn',     type: 'bool',    facet: true,    optional: true },
    { name: 'thumbnail',         type: 'string',  optional: true, index: false },
    { name: 'phone',             type: 'string',  optional: true, index: false },
  ]),

  /* 12 ── Education */
  sokoni_education: _schema('sokoni_education', [
    { name: 'title',         type: 'string' },
    { name: 'description',   type: 'string',  optional: true },
    { name: 'provider',      type: 'string',  optional: true },
    { name: 'type',          type: 'string',  facet: true,    optional: true },
    { name: 'subject',       type: 'string',  facet: true,    optional: true },
    { name: 'level',         type: 'string',  facet: true,    optional: true },
    { name: 'price',         type: 'float',   optional: true, sort: true },
    { name: 'isFree',        type: 'bool',    facet: true,    optional: true },
    { name: 'duration',      type: 'string',  optional: true },
    { name: 'language',      type: 'string',  facet: true,    optional: true },
    { name: 'format',        type: 'string',  facet: true,    optional: true },
    { name: 'rating',        type: 'float',   optional: true, sort: true },
    { name: 'reviewCount',   type: 'int32',   optional: true, sort: true },
    { name: 'enrollCount',   type: 'int32',   optional: true, sort: true },
    { name: 'thumbnail',     type: 'string',  optional: true, index: false },
    { name: 'certificate',   type: 'bool',    facet: true,    optional: true },
    { name: 'isOnline',      type: 'bool',    facet: true,    optional: true },
  ]),

  /* 13 ── Professionals (Lawyers, Consultants) */
  sokoni_professionals: _schema('sokoni_professionals', [
    { name: 'name',           type: 'string' },
    { name: 'title',          type: 'string',  optional: true },
    { name: 'description',    type: 'string',  optional: true },
    { name: 'profession',     type: 'string',  facet: true,    optional: true },
    { name: 'specialty',      type: 'string[]',facet: true,    optional: true },
    { name: 'price',          type: 'float',   optional: true, sort: true },
    { name: 'priceType',      type: 'string',  facet: true,    optional: true },
    { name: 'experience',     type: 'int32',   optional: true, sort: true },
    { name: 'rating',         type: 'float',   optional: true, sort: true },
    { name: 'reviewCount',    type: 'int32',   optional: true, sort: true },
    { name: 'languages',      type: 'string[]',facet: true,    optional: true },
    { name: 'qualifications', type: 'string[]',facet: true,    optional: true },
    { name: 'isOnline',       type: 'bool',    facet: true,    optional: true },
    { name: 'thumbnail',      type: 'string',  optional: true, index: false },
  ]),

  /* 14 ── Reviews */
  sokoni_reviews: _schema('sokoni_reviews', [
    { name: 'content',        type: 'string' },
    { name: 'rating',         type: 'int32',   facet: true, sort: true },
    { name: 'targetId',       type: 'string',  facet: true },
    { name: 'targetType',     type: 'string',  facet: true },
    { name: 'targetName',     type: 'string',  optional: true },
    { name: 'reviewerName',   type: 'string',  optional: true },
    { name: 'reviewerAvatar', type: 'string',  optional: true, index: false },
    { name: 'hub',            type: 'string',  facet: true,    optional: true },
    { name: 'helpful',        type: 'int32',   optional: true, sort: true },
    { name: 'images',         type: 'string[]',optional: true, index: false },
  ], 'createdAt'),

  /* 15 ── Users (public profiles) */
  sokoni_users: _schema('sokoni_users', [
    { name: 'displayName',    type: 'string' },
    { name: 'username',       type: 'string',  optional: true },
    { name: 'bio',            type: 'string',  optional: true },
    { name: 'avatar',         type: 'string',  optional: true, index: false },
    { name: 'role',           type: 'string',  facet: true,    optional: true },
    { name: 'sellerVerified', type: 'bool',    facet: true,    optional: true },
    { name: 'rating',         type: 'float',   optional: true, sort: true },
    { name: 'followerCount',  type: 'int32',   optional: true, sort: true },
    { name: 'skills',         type: 'string[]',facet: true,    optional: true },
    { name: 'joinedAt',       type: 'int64',   sort: true },
  ]),

  /* 16 ── Categories */
  sokoni_categories: _schema('sokoni_categories', [
    { name: 'name',         type: 'string' },
    { name: 'description',  type: 'string',  optional: true },
    { name: 'parentId',     type: 'string',  facet: true,    optional: true },
    { name: 'level',        type: 'int32',   facet: true,    optional: true },
    { name: 'hub',          type: 'string',  facet: true,    optional: true },
    { name: 'icon',         type: 'string',  optional: true, index: false },
    { name: 'productCount', type: 'int32',   optional: true, sort: true },
    { name: 'order',        type: 'int32',   optional: true, sort: true },
    { name: 'active',       type: 'bool',    facet: true },
  ]),

  /* 17 ── Brands */
  sokoni_brands: _schema('sokoni_brands', [
    { name: 'name',         type: 'string' },
    { name: 'description',  type: 'string',  optional: true },
    { name: 'logo',         type: 'string',  optional: true, index: false },
    { name: 'category',     type: 'string',  facet: true,    optional: true },
    { name: 'country',      type: 'string',  facet: true,    optional: true },
    { name: 'productCount', type: 'int32',   optional: true, sort: true },
    { name: 'official',     type: 'bool',    facet: true,    optional: true },
    { name: 'popular',      type: 'bool',    facet: true,    optional: true },
  ]),

  /* 18 ── Curated Collections */
  sokoni_collections: _schema('sokoni_collections', [
    { name: 'name',         type: 'string' },
    { name: 'description',  type: 'string',  optional: true },
    { name: 'image',        type: 'string',  optional: true, index: false },
    { name: 'productCount', type: 'int32',   optional: true, sort: true },
    { name: 'curatorName',  type: 'string',  optional: true },
    { name: 'hub',          type: 'string',  facet: true,    optional: true },
    { name: 'followCount',  type: 'int32',   optional: true, sort: true },
    { name: 'official',     type: 'bool',    facet: true,    optional: true },
  ]),

  /* 19 ── Coupons */
  sokoni_coupons: _schema('sokoni_coupons', [
    { name: 'code',          type: 'string' },
    { name: 'name',          type: 'string',  optional: true },
    { name: 'description',   type: 'string',  optional: true },
    { name: 'discountType',  type: 'string',  facet: true,    optional: true },
    { name: 'discountValue', type: 'float',   optional: true, sort: true },
    { name: 'minOrderValue', type: 'float',   optional: true },
    { name: 'freeShipping',  type: 'bool',    facet: true,    optional: true },
    { name: 'validTo',       type: 'int64',   optional: true, sort: true },
    { name: 'applicableTo',  type: 'string',  facet: true,    optional: true },
    { name: 'active',        type: 'bool',    facet: true },
  ]),

  /* 20 ── Support Articles */
  sokoni_support: _schema('sokoni_support', [
    { name: 'title',        type: 'string' },
    { name: 'content',      type: 'string' },
    { name: 'category',     type: 'string',  facet: true,    optional: true },
    { name: 'subcategory',  type: 'string',  facet: true,    optional: true },
    { name: 'audience',     type: 'string',  facet: true,    optional: true },
    { name: 'helpfulCount', type: 'int32',   optional: true, sort: true },
    { name: 'viewCount',    type: 'int32',   optional: true, sort: true },
    { name: 'difficulty',   type: 'string',  facet: true,    optional: true },
    { name: 'thumbnail',    type: 'string',  optional: true, index: false },
    { name: 'author',       type: 'string',  optional: true },
    { name: 'slug',         type: 'string',  optional: true },
    { name: 'published',    type: 'bool',    facet: true },
  ]),

  /* 21 ── FAQ */
  sokoni_faq: _schema('sokoni_faq', [
    { name: 'question',     type: 'string' },
    { name: 'answer',       type: 'string' },
    { name: 'category',     type: 'string',  facet: true,    optional: true },
    { name: 'audience',     type: 'string',  facet: true,    optional: true },
    { name: 'helpfulCount', type: 'int32',   optional: true, sort: true },
    { name: 'order',        type: 'int32',   optional: true, sort: true },
    { name: 'published',    type: 'bool',    facet: true },
  ]),

  /* 22 ── Blog Posts */
  sokoni_blog: _schema('sokoni_blog', [
    { name: 'title',        type: 'string' },
    { name: 'excerpt',      type: 'string',  optional: true },
    { name: 'content',      type: 'string',  optional: true },
    { name: 'category',     type: 'string',  facet: true,    optional: true },
    { name: 'author',       type: 'string',  optional: true },
    { name: 'slug',         type: 'string',  optional: true },
    { name: 'thumbnail',    type: 'string',  optional: true, index: false },
    { name: 'readTimeMin',  type: 'int32',   optional: true },
    { name: 'viewCount',    type: 'int32',   optional: true, sort: true },
    { name: 'likeCount',    type: 'int32',   optional: true, sort: true },
    { name: 'shareCount',   type: 'int32',   optional: true },
    { name: 'published',    type: 'bool',    facet: true },
    { name: 'publishedAt',  type: 'int64',   optional: true, sort: true },
  ]),

  /* 23 ── Announcements */
  sokoni_announcements: _schema('sokoni_announcements', [
    { name: 'title',         type: 'string' },
    { name: 'body',          type: 'string',  optional: true },
    { name: 'type',          type: 'string',  facet: true,    optional: true },
    { name: 'audience',      type: 'string[]',facet: true,    optional: true },
    { name: 'priority',      type: 'string',  facet: true,    optional: true },
    { name: 'thumbnail',     type: 'string',  optional: true, index: false },
    { name: 'cta',           type: 'string',  optional: true, index: false },
    { name: 'ctaUrl',        type: 'string',  optional: true, index: false },
    { name: 'publishedAt',   type: 'int64',   optional: true, sort: true },
    { name: 'expiresAt',     type: 'int64',   optional: true, sort: true },
    { name: 'published',     type: 'bool',    facet: true },
  ]),

  /* 24 ── Tourism / Experiences */
  sokoni_tourism: _schema('sokoni_tourism', [
    { name: 'name',          type: 'string' },
    { name: 'description',   type: 'string',  optional: true },
    { name: 'type',          type: 'string',  facet: true,    optional: true },
    { name: 'price',         type: 'float',   optional: true, sort: true },
    { name: 'duration',      type: 'string',  optional: true },
    { name: 'groupSize',     type: 'int32',   optional: true },
    { name: 'rating',        type: 'float',   optional: true, sort: true },
    { name: 'reviewCount',   type: 'int32',   optional: true, sort: true },
    { name: 'languages',     type: 'string[]',facet: true,    optional: true },
    { name: 'includes',      type: 'string[]',facet: true,    optional: true },
    { name: 'thumbnail',     type: 'string',  optional: true, index: false },
    { name: 'guideName',     type: 'string',  optional: true },
    { name: 'startDate',     type: 'int64',   optional: true, sort: true },
    { name: 'endDate',       type: 'int64',   optional: true },
  ]),

  /* 25 ── Entertainment */
  sokoni_entertainment: _schema('sokoni_entertainment', [
    { name: 'title',         type: 'string' },
    { name: 'description',   type: 'string',  optional: true },
    { name: 'type',          type: 'string',  facet: true,    optional: true },
    { name: 'genre',         type: 'string[]',facet: true,    optional: true },
    { name: 'price',         type: 'float',   optional: true, sort: true },
    { name: 'isFree',        type: 'bool',    facet: true,    optional: true },
    { name: 'ageRating',     type: 'string',  facet: true,    optional: true },
    { name: 'rating',        type: 'float',   optional: true, sort: true },
    { name: 'reviewCount',   type: 'int32',   optional: true, sort: true },
    { name: 'viewCount',     type: 'int32',   optional: true, sort: true },
    { name: 'thumbnail',     type: 'string',  optional: true, index: false },
    { name: 'venue',         type: 'string',  optional: true },
    { name: 'startDate',     type: 'int64',   optional: true, sort: true },
    { name: 'duration',      type: 'int32',   optional: true },
  ]),

};

/* ═══════════════════════════════════════════════════════════════════
   DOCUMENT TRANSFORMERS
   Firestore document → Typesense document.
   Return null to signal "skip indexing / delete from index".
   Every transformer adds all four ranking score fields.
════════════════════════════════════════════════════════════════════ */

function _scores(data, { orderW = 3, viewW = 1, reviewW = 2, clickW = 1, convW = 5 } = {}) {
  const orders  = _int32(data.orderCount   || data.bookingCount || data.purchaseCount);
  const views   = _int32(data.viewCount    || data.impressions);
  const reviews = _int32(data.reviewCount);
  const clicks  = _int32(data.clickCount);
  const convs   = _int32(data.conversionCount || data.purchaseCount || data.orderCount);
  const featured = _int32(data.featuredLevel) * 10;
  return {
    _popularityScore: Math.log1p(orders * orderW + views * viewW + reviews * reviewW) + featured,
    _salesScore:      Math.log1p(orders * orderW + convs * convW),
    _clickScore:      Math.log1p(clicks * clickW + views * viewW * 0.1),
    _conversionScore: orders > 0 && views > 0
      ? Math.log1p((orders / Math.max(views, 1)) * 1000)
      : 0,
  };
}

const TRANSFORMERS = {

  products: (id, data) => _strip({
    id,
    name:            _str(data.name || data.title),
    description:     _trunc(_str(data.description), 800),
    category:        _str(data.category, 'Uncategorised'),
    subcategory:     _str(data.subcategory)   || undefined,
    brand:           _str(data.brand)         || undefined,
    sku:             _str(data.sku)           || undefined,
    barcode:         _str(data.barcode || data.ean || data.upc) || undefined,
    price:           _float(data.price),
    originalPrice:   _float(data.originalPrice || data.price) || undefined,
    discountPercent: _float(data.discountPercent || data.discount) || undefined,
    currency:        'KES',
    inStock:         data.inStock !== false,
    stockQty:        _int32(data.stockQty || data.stock) || undefined,
    condition:       _str(data.condition)    || undefined,
    hub:             _str(data.hub, 'shopping'),
    sellerId:        _str(data.sellerId)     || undefined,
    sellerName:      _str(data.sellerName)   || undefined,
    sellerVerified:  data.sellerVerified === true || undefined,
    sellerRating:    _float(data.sellerRating) || undefined,
    rating:          _float(data.rating)       || undefined,
    reviewCount:     _int32(data.reviewCount)  || undefined,
    orderCount:      _int32(data.orderCount)   || undefined,
    viewCount:       _int32(data.viewCount)    || undefined,
    wishlistCount:   _int32(data.wishlistCount)|| undefined,
    thumbnail:       _str(data.thumbnail || data.image) || undefined,
    deliveryOptions: _strArr(data.deliveryOptions),
    isNew:           data.isNew === true       || undefined,
    isOnSale:        (data.isOnSale === true || _float(data.discountPercent) > 0) || undefined,
    isBestseller:    data.isBestseller === true|| undefined,
    keywords:        _strArr(data.keywords).slice(0, 20),
    isFeatured:      data.isFeatured === true  || undefined,
    featuredLevel:   _int32(data.featuredLevel)|| undefined,
    verified:        Boolean(data.verified || data.sellerVerified) || undefined,
    tags:            _strArr(data.tags).slice(0, 30),
    status:          _str(data.status, 'active'),
    createdAt:       _unix(data.createdAt),
    updatedAt:       _unix(data.updatedAt)  || undefined,
    ..._geo(data),
    ..._scores(data),
  }),

  sellers: (id, data) => _strip({
    id,
    name:            _str(data.shopName || data.name || data.displayName),
    description:     _trunc(_str(data.description || data.bio), 600),
    category:        _str(data.category || data.businessType) || undefined,
    logo:            _str(data.logo || data.shopLogo || data.photoURL) || undefined,
    phone:           _str(data.phone) || undefined,
    rating:          _float(data.rating)        || undefined,
    reviewCount:     _int32(data.reviewCount)   || undefined,
    orderCount:      _int32(data.orderCount)    || undefined,
    followerCount:   _int32(data.followerCount) || undefined,
    productCount:    _int32(data.productCount)  || undefined,
    deliveryOptions: _strArr(data.deliveryOptions),
    isFeatured:      data.isFeatured === true   || undefined,
    featuredLevel:   _int32(data.featuredLevel) || undefined,
    /* Admin-granted `verified` only — see the note in algolia-indexer.js.
       `isVerified` is client-writable and must not become a trust signal. */
    verified:        data.verified === true,
    tags:            _strArr(data.tags).slice(0, 20),
    status:          _str(data.status, 'active'),
    joinedAt:        _unix(data.createdAt || data.joinedAt),
    createdAt:       _unix(data.createdAt || data.joinedAt),
    ..._geo(data),
    ..._scores(data),
  }),

  services: (id, data) => _strip({
    id,
    name:            _str(data.name || data.title || data.serviceName),
    description:     _trunc(_str(data.description || data.details), 600),
    category:        _str(data.category || data.serviceType) || undefined,
    subcategory:     _str(data.subcategory) || undefined,
    price:           _float(data.price || data.rate) || undefined,
    priceMax:        _float(data.priceMax  || data.rateMax)  || undefined,
    priceType:       _str(data.priceType, 'fixed'),
    thumbnail:       _str(data.thumbnail)  || undefined,
    tags:            _strArr(data.tags).slice(0, 25),
    providerId:      _str(data.providerId || data.sellerId || data.uid) || undefined,
    providerName:    _str(data.providerName || data.sellerName)         || undefined,
    providerVerified:Boolean(data.verified || data.providerVerified)    || undefined,
    rating:          _float(data.rating)       || undefined,
    reviewCount:     _int32(data.reviewCount)  || undefined,
    orderCount:      _int32(data.orderCount || data.bookingCount) || undefined,
    remote:          Boolean(data.remote || data.isRemote || data.isOnline) || undefined,
    hub:             _str(data.hub, 'services'),
    isFeatured:      data.isFeatured === true  || undefined,
    featuredLevel:   _int32(data.featuredLevel)|| undefined,
    verified:        Boolean(data.verified)    || undefined,
    status:          _str(data.status, 'active'),
    createdAt:       _unix(data.createdAt),
    ..._geo(data),
    ..._scores(data, { orderW: 3, viewW: 1, reviewW: 2 }),
  }),

  events: (id, data) => _strip({
    id,
    title:          _str(data.title || data.name),
    description:    _trunc(_str(data.description), 600),
    category:       _str(data.category || data.eventType) || undefined,
    thumbnail:      _str(data.thumbnail || data.image || data.banner) || undefined,
    price:          _float(data.price || data.ticketPrice)  || undefined,
    isFree:         Boolean(data.isFree || data.price === 0) || undefined,
    startDate:      _unix(data.startDate || data.date),
    endDate:        _unix(data.endDate) || undefined,
    venue:          _str(data.venue || data.location?.venue) || undefined,
    organizerName:  _str(data.organizerName || data.organizer || data.posterName) || undefined,
    tags:           _strArr(data.tags).slice(0, 20),
    attendeeCount:  _int32(data.attendeeCount || data.rsvpCount) || undefined,
    isOnline:       Boolean(data.isOnline || data.virtual) || undefined,
    isFeatured:     data.isFeatured === true || undefined,
    featuredLevel:  _int32(data.featuredLevel) || undefined,
    verified:       Boolean(data.verified)   || undefined,
    status:         _str(data.status, 'active'),
    createdAt:      _unix(data.createdAt),
    ..._geo(data),
    ..._scores(data, { orderW: 2, viewW: 1, reviewW: 1 }),
  }),

  properties: (id, data) => _strip({
    id,
    title:          _str(data.title || data.name),
    description:    _trunc(_str(data.description), 600),
    type:           _str(data.type || data.propertyType) || undefined,
    listingType:    _str(data.listingType, data.forRent ? 'rent' : 'sale'),
    price:          _float(data.price),
    bedrooms:       _int32(data.bedrooms) || undefined,
    bathrooms:      _int32(data.bathrooms)|| undefined,
    sizeSqm:        _float(data.size || data.sizeSqm || data.squareMeters) || undefined,
    furnished:      Boolean(data.furnished) || undefined,
    amenities:      _strArr(data.amenities).slice(0, 40),
    thumbnail:      _str(data.thumbnail) || undefined,
    agentName:      _str(data.agentName || data.agent || data.sellerName) || undefined,
    agentVerified:  Boolean(data.agentVerified || data.verified) || undefined,
    isFeatured:     data.isFeatured === true   || undefined,
    featuredLevel:  _int32(data.featuredLevel) || undefined,
    verified:       Boolean(data.verified)     || undefined,
    tags:           _strArr(data.tags).slice(0, 20),
    status:         _str(data.status, 'active'),
    createdAt:      _unix(data.createdAt),
    ..._geo(data),
    ..._scores(data, { orderW: 0, viewW: 2, reviewW: 1 }),
  }),

  cars: (id, data) => {
    const make  = _str(data.make || data.brand);
    const model = _str(data.model);
    const year  = _int32(data.year);
    return _strip({
      id,
      title:         _str(data.title, [year || '', make, model].filter(Boolean).join(' ').trim() || 'Vehicle'),
      make:          make || 'Other',
      model:         model || undefined,
      year:          year  || undefined,
      type:          _str(data.type || data.vehicleType, 'car'),
      bodyType:      _str(data.bodyType)  || undefined,
      listingType:   _str(data.listingType, data.forRent ? 'rent' : 'sale'),
      price:         _float(data.price),
      mileage:       _int32(data.mileage || data.odometer) || undefined,
      condition:     _str(data.condition, 'used'),
      fuelType:      _str(data.fuelType  || data.fuel)    || undefined,
      transmission:  _str(data.transmission || data.gearbox) || undefined,
      color:         _str(data.color || data.bodyColor)   || undefined,
      features:      _strArr(data.features || data.extras).slice(0, 30),
      thumbnail:     _str(data.thumbnail) || undefined,
      sellerDealer:  data.isDealer === true  || undefined,
      isFeatured:    data.isFeatured === true|| undefined,
      featuredLevel: _int32(data.featuredLevel) || undefined,
      verified:      Boolean(data.verified)  || undefined,
      tags:          _strArr(data.tags).slice(0, 20),
      status:        _str(data.status, 'active'),
      createdAt:     _unix(data.createdAt),
      ..._geo(data),
      ..._scores(data, { orderW: 0, viewW: 2, reviewW: 0 }),
    });
  },

  digitalJobs: (id, data) => _strip({
    id,
    title:            _str(data.title || data.jobTitle || data.position),
    company:          _str(data.company || data.companyName || data.posterName) || undefined,
    description:      _trunc(_str(data.description || data.details), 600),
    category:         _str(data.category || data.jobCategory || data.industry)  || undefined,
    jobType:          _str(data.jobType || data.type || data.employmentType, 'fulltime'),
    remote:           Boolean(data.remote || data.isRemote || data.workFromHome) || undefined,
    salaryMin:        _float(data.salaryMin || data.salary?.min) || undefined,
    salaryMax:        _float(data.salaryMax || data.salary?.max) || undefined,
    skills:           _strArr(data.skills || data.requirements).slice(0, 25),
    experience:       _str(data.experience || data.experienceLevel) || undefined,
    education:        _str(data.education  || data.educationLevel)  || undefined,
    deadline:         _unix(data.deadline  || data.applicationDeadline) || undefined,
    applicationCount: _int32(data.applicationCount || data.applications) || undefined,
    isFeatured:       data.isFeatured === true   || undefined,
    featuredLevel:    _int32(data.featuredLevel) || undefined,
    verified:         Boolean(data.verified)     || undefined,
    tags:             _strArr(data.tags).slice(0, 20),
    status:           _str(data.status, 'active'),
    createdAt:        _unix(data.createdAt),
    ..._geo(data),
    ..._scores(data, { orderW: 3, viewW: 1, reviewW: 0 }),
  }),

  bnbListings: (id, data) => _strip({
    id,
    name:          _str(data.name || data.title || data.propertyName),
    description:   _trunc(_str(data.description || data.details), 600),
    type:          _str(data.type || data.propertyType, 'bnb'),
    starRating:    _int32(data.starRating || data.stars)       || undefined,
    pricePerNight: _float(data.pricePerNight || data.price),
    amenities:     _strArr(data.amenities).slice(0, 30),
    roomTypes:     _strArr(data.roomTypes).slice(0, 10),
    rating:        _float(data.rating)       || undefined,
    reviewCount:   _int32(data.reviewCount)  || undefined,
    thumbnail:     _str(data.thumbnail || data.image || (data.photos && data.photos[0])) || undefined,
    checkInTime:   _str(data.checkInTime)    || undefined,
    checkOutTime:  _str(data.checkOutTime)   || undefined,
    hostName:      _str(data.hostName || data.ownerName || data.sellerName) || undefined,
    instantBook:   data.instantBook === true  || undefined,
    petFriendly:   data.petFriendly === true  || undefined,
    maxGuests:     _int32(data.maxGuests || data.capacity)    || undefined,
    isFeatured:    data.isFeatured === true   || undefined,
    featuredLevel: _int32(data.featuredLevel) || undefined,
    verified:      Boolean(data.verified)     || undefined,
    tags:          _strArr(data.tags).slice(0, 20),
    status:        _str(data.status, 'active'),
    createdAt:     _unix(data.createdAt),
    ..._geo(data),
    ..._scores(data),
  }),

  education: (id, data) => _strip({
    id,
    title:         _str(data.title || data.name || data.courseName),
    description:   _trunc(_str(data.description || data.about), 600),
    provider:      _str(data.provider || data.institution || data.school) || undefined,
    type:          _str(data.type || data.courseType, 'course'),
    subject:       _str(data.subject || data.category) || undefined,
    level:         _str(data.level  || data.difficulty)|| undefined,
    price:         _float(data.price)  || undefined,
    isFree:        Boolean(data.isFree || data.price === 0 || !data.price) || undefined,
    duration:      _str(data.duration) || undefined,
    language:      _str(data.language, 'English'),
    format:        _str(data.format   || data.mode, 'online'),
    rating:        _float(data.rating)       || undefined,
    reviewCount:   _int32(data.reviewCount)  || undefined,
    enrollCount:   _int32(data.enrollCount || data.students) || undefined,
    thumbnail:     _str(data.thumbnail || data.image) || undefined,
    certificate:   Boolean(data.certificate || data.hasCertificate) || undefined,
    isOnline:      Boolean(data.isOnline || data.online || data.format === 'online') || undefined,
    isFeatured:    data.isFeatured === true   || undefined,
    featuredLevel: _int32(data.featuredLevel) || undefined,
    verified:      Boolean(data.verified)     || undefined,
    tags:          _strArr(data.tags).slice(0, 20),
    status:        _str(data.status, 'active'),
    createdAt:     _unix(data.createdAt),
    ..._geo(data),
    ..._scores(data, { orderW: 3, viewW: 1, reviewW: 2 }),
  }),

  reviews: (id, data) => _strip({
    id,
    content:        _trunc(_str(data.content || data.review || data.comment), 500),
    rating:         _int32(data.rating, 5),
    targetId:       _str(data.targetId || data.productId || data.sellerId || data.revieweeUid),
    targetType:     _str(data.targetType || data.type, 'product'),
    targetName:     _str(data.targetName || data.productName || data.sellerName) || undefined,
    reviewerName:   _str(data.reviewerName || data.buyerName || data.displayName) || undefined,
    reviewerAvatar: _str(data.reviewerAvatar || data.photoURL)                    || undefined,
    hub:            _str(data.hub)            || undefined,
    helpful:        _int32(data.helpful || data.helpfulCount) || undefined,
    verified:       Boolean(data.verified || data.verifiedPurchase),
    images:         _strArr(data.images || data.photos).slice(0, 5),
    isFeatured:     data.isFeatured === true   || undefined,
    featuredLevel:  _int32(data.featuredLevel) || undefined,
    tags:           _strArr(data.tags).slice(0, 10),
    status:         _str(data.status, 'active'),
    createdAt:      _unix(data.createdAt),
    ..._scores(data, { orderW: 0, viewW: 0, reviewW: 1 }),
  }),

  users: (id, data) => {
    if (data.private || ['banned', 'deleted', 'suspended'].includes(data.status)) return null;
    return _strip({
      id,
      displayName:    _str(data.displayName || data.name),
      username:       _str(data.username)   || undefined,
      bio:            _trunc(_str(data.bio), 250) || undefined,
      avatar:         _str(data.photoURL || data.avatar) || undefined,
      role:           _str(data.role, 'buyer'),
      sellerVerified: data.sellerVerified === true || undefined,
      rating:         _float(data.rating)        || undefined,
      followerCount:  _int32(data.followerCount) || undefined,
      skills:         _strArr(data.skills).slice(0, 15),
      joinedAt:       _unix(data.createdAt),
      isFeatured:     data.isFeatured === true   || undefined,
      featuredLevel:  _int32(data.featuredLevel) || undefined,
      verified:       Boolean(data.verified || data.emailVerified),
      tags:           _strArr(data.tags).slice(0, 15),
      status:         _str(data.status, 'active'),
      createdAt:      _unix(data.createdAt),
      ..._geo(data),
      ..._scores(data, { orderW: 0, viewW: 0, reviewW: 0 }),
    });
  },

  categories: (id, data) => _strip({
    id,
    name:         _str(data.name),
    description:  _str(data.description) || undefined,
    parentId:     _str(data.parentId)    || undefined,
    level:        _int32(data.level, data.parentId ? 1 : 0),
    hub:          _str(data.hub)         || undefined,
    icon:         _str(data.icon)        || undefined,
    productCount: _int32(data.productCount) || undefined,
    order:        _int32(data.order),
    active:       data.active !== false,
    isFeatured:   data.featured === true || undefined,
    featuredLevel:_int32(data.featuredLevel) || undefined,
    verified:     false,
    tags:         _strArr(data.tags).slice(0, 10),
    status:       data.active !== false ? 'active' : 'inactive',
    createdAt:    _unix(data.createdAt),
    ..._scores(data, { orderW: 0, viewW: 1, reviewW: 0 }),
  }),

  brands: (id, data) => _strip({
    id,
    name:         _str(data.name),
    description:  _trunc(_str(data.description), 400) || undefined,
    logo:         _str(data.logo || data.image) || undefined,
    category:     _str(data.category)  || undefined,
    country:      _str(data.country || data.origin) || undefined,
    productCount: _int32(data.productCount) || undefined,
    official:     Boolean(data.official || data.verified) || undefined,
    popular:      Boolean(data.popular) || undefined,
    isFeatured:   Boolean(data.featured || data.isFeatured) || undefined,
    featuredLevel:_int32(data.featuredLevel) || undefined,
    verified:     Boolean(data.verified || data.official),
    tags:         _strArr(data.tags).slice(0, 15),
    status:       _str(data.status, 'active'),
    createdAt:    _unix(data.createdAt),
    ..._scores(data, { orderW: 0, viewW: 1, reviewW: 0 }),
  }),

  collections: (id, data) => _strip({
    id,
    name:         _str(data.name || data.title),
    description:  _trunc(_str(data.description), 400) || undefined,
    image:        _str(data.image || data.coverImage || data.thumbnail) || undefined,
    productCount: _int32(data.productCount) || undefined,
    curatorName:  _str(data.curatorName || data.displayName) || undefined,
    hub:          _str(data.hub)    || undefined,
    followCount:  _int32(data.followCount) || undefined,
    official:     Boolean(data.official)   || undefined,
    isFeatured:   Boolean(data.featured || data.isFeatured) || undefined,
    featuredLevel:_int32(data.featuredLevel) || undefined,
    verified:     Boolean(data.official || data.verified),
    tags:         _strArr(data.tags).slice(0, 20),
    status:       _str(data.status, 'active'),
    createdAt:    _unix(data.createdAt),
    ..._scores(data, { orderW: 0, viewW: 1, reviewW: 0 }),
  }),

  coupons: (id, data) => _strip({
    id,
    code:          _str(data.code).toUpperCase(),
    name:          _str(data.name)         || undefined,
    description:   _str(data.description)  || undefined,
    discountType:  _str(data.discountType, 'percent'),
    discountValue: _float(data.discountValue) || undefined,
    minOrderValue: _float(data.minOrderValue) || undefined,
    freeShipping:  data.freeShipping === true  || undefined,
    validTo:       _unix(data.validTo)         || undefined,
    applicableTo:  _str(data.applicableTo, 'all'),
    active:        data.active !== false,
    isFeatured:    Boolean(data.featured)  || undefined,
    featuredLevel: _int32(data.featuredLevel) || undefined,
    verified:      false,
    tags:          _strArr(data.tags).slice(0, 10),
    status:        data.active !== false ? 'active' : 'inactive',
    createdAt:     _unix(data.createdAt),
    ..._scores(data),
  }),

  lawyers: (id, data) => _strip({
    id,
    name:           _str(data.name || data.displayName),
    title:          _str(data.title || data.lawTitle)      || undefined,
    description:    _trunc(_str(data.description || data.bio || data.about), 600),
    profession:     'lawyer',
    specialty:      _strArr(
      data.specialty || data.practiceAreas ||
      (data.practiceArea ? [data.practiceArea] : [])
    ).slice(0, 10),
    price:          _float(data.price || data.rate || data.hourlyRate) || undefined,
    priceType:      _str(data.priceType, 'hourly'),
    experience:     _int32(data.experience || data.yearsOfPractice) || undefined,
    rating:         _float(data.rating)       || undefined,
    reviewCount:    _int32(data.reviewCount)  || undefined,
    languages:      _strArr(data.languages).slice(0, 5),
    qualifications: _strArr(data.qualifications || (data.bar ? ['Bar certified'] : [])).slice(0, 10),
    isOnline:       Boolean(data.isOnline || data.online || data.virtual) || undefined,
    thumbnail:      _str(data.photoURL || data.thumbnail || data.photo) || undefined,
    isFeatured:     data.isFeatured === true   || undefined,
    featuredLevel:  _int32(data.featuredLevel) || undefined,
    verified:       Boolean(data.verified)     || undefined,
    tags:           _strArr(data.tags).slice(0, 15),
    status:         _str(data.status, 'active'),
    createdAt:      _unix(data.createdAt),
    ..._geo(data),
    ..._scores(data),
  }),

  fitness_clubs:   null, /* resolved to services below */
  fitness_classes: null, /* resolved to services below */
};

/* Resolved aliases */
TRANSFORMERS.providers      = TRANSFORMERS.services;
TRANSFORMERS.foods          = TRANSFORMERS.products;
TRANSFORMERS.fitness_clubs  = TRANSFORMERS.services;
TRANSFORMERS.fitness_classes= TRANSFORMERS.services;

/* ═══════════════════════════════════════════════════════════════════
   COLLECTION MAP — Firestore collection name → Typesense target
════════════════════════════════════════════════════════════════════ */

const COLLECTION_MAP = {
  products:         { collection: 'sokoni_products',      transformer: TRANSFORMERS.products      },
  sellers:          { collection: 'sokoni_shops',         transformer: TRANSFORMERS.sellers       },
  providers:        { collection: 'sokoni_services',      transformer: TRANSFORMERS.services      },
  services:         { collection: 'sokoni_services',      transformer: TRANSFORMERS.services      },
  events:           { collection: 'sokoni_events',        transformer: TRANSFORMERS.events        },
  propertyListings: { collection: 'sokoni_properties',    transformer: TRANSFORMERS.properties    },
  properties:       { collection: 'sokoni_properties',    transformer: TRANSFORMERS.properties    },
  cars:             { collection: 'sokoni_vehicles',      transformer: TRANSFORMERS.cars          },
  digitalJobs:      { collection: 'sokoni_jobs',          transformer: TRANSFORMERS.digitalJobs   },
  digitalGigs:      { collection: 'sokoni_jobs',          transformer: TRANSFORMERS.digitalJobs   },
  jobs:             { collection: 'sokoni_jobs',          transformer: TRANSFORMERS.digitalJobs   },
  bnbListings:      { collection: 'sokoni_hotels',        transformer: TRANSFORMERS.bnbListings   },
  hotels:           { collection: 'sokoni_hotels',        transformer: TRANSFORMERS.bnbListings   },
  fitness_clubs:    { collection: 'sokoni_sports',        transformer: TRANSFORMERS.services      },
  fitness_classes:  { collection: 'sokoni_sports',        transformer: TRANSFORMERS.services      },
  education:        { collection: 'sokoni_education',     transformer: TRANSFORMERS.education     },
  lawyers:          { collection: 'sokoni_professionals', transformer: TRANSFORMERS.lawyers       },
  reviews:          { collection: 'sokoni_reviews',       transformer: TRANSFORMERS.reviews       },
  digitalReviews:   { collection: 'sokoni_reviews',       transformer: TRANSFORMERS.reviews       },
  legalReviews:     { collection: 'sokoni_reviews',       transformer: TRANSFORMERS.reviews       },
  users:            { collection: 'sokoni_users',         transformer: TRANSFORMERS.users         },
  categories:       { collection: 'sokoni_categories',    transformer: TRANSFORMERS.categories    },
  brands:           { collection: 'sokoni_brands',        transformer: TRANSFORMERS.brands        },
  collections:      { collection: 'sokoni_collections',   transformer: TRANSFORMERS.collections   },
  coupons:          { collection: 'sokoni_coupons',       transformer: TRANSFORMERS.coupons       },
  foods:            { collection: 'sokoni_products',      transformer: TRANSFORMERS.products      },
};

/* ═══════════════════════════════════════════════════════════════════
   KENYAN MARKETPLACE SYNONYMS — applied to all searchable collections
════════════════════════════════════════════════════════════════════ */

const TS_SYNONYMS = [
  { id: 'syn_phone',    type: 'equivalent', synonyms: ['phone','mobile','simu','smartphone','handset','gadget'] },
  { id: 'syn_laptop',   type: 'equivalent', synonyms: ['laptop','computer','kompyuta','notebook','pc','desktop'] },
  { id: 'syn_shoes',    type: 'equivalent', synonyms: ['shoes','viatu','sneakers','boots','sandals','slippers','footwear'] },
  { id: 'syn_clothes',  type: 'equivalent', synonyms: ['clothes','nguo','clothing','fashion','outfit','wear','attire'] },
  { id: 'syn_food',     type: 'equivalent', synonyms: ['food','chakula','groceries','meals','restaurant','eat','dining'] },
  { id: 'syn_job',      type: 'equivalent', synonyms: ['job','kazi','work','employment','career','vacancy','internship'] },
  { id: 'syn_house',    type: 'equivalent', synonyms: ['house','nyumba','home','apartment','flat','bedsitter','studio','rental'] },
  { id: 'syn_car',      type: 'equivalent', synonyms: ['car','gari','vehicle','auto','automobile','ride'] },
  { id: 'syn_doctor',   type: 'equivalent', synonyms: ['doctor','daktari','physician','medic','medical','specialist'] },
  { id: 'syn_land',     type: 'equivalent', synonyms: ['land','ardhi','plot','acre','farm','shamba'] },
  { id: 'syn_delivery', type: 'equivalent', synonyms: ['delivery','shipping','courier','send','deliver','dispatch'] },
  { id: 'syn_nairobi',  type: 'equivalent', synonyms: ['nairobi','nbi','nairobi city','cbd'] },
  { id: 'syn_boda',     type: 'equivalent', synonyms: ['boda','bodaboda','motorcycle','bike','motorbike','piki'] },
];

/* ═══════════════════════════════════════════════════════════════════
   SHARED UTILITY FUNCTIONS (exported for use by queue, sync, admin)
════════════════════════════════════════════════════════════════════ */

function _chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _str(val, fallback = '') {
  if (val === null || val === undefined) return fallback;
  const s = String(val).trim();
  return s || fallback;
}

function _float(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : parseFloat(n.toFixed(4));
}

function _int32(val, fallback = 0) {
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

function _strArr(val) {
  if (Array.isArray(val)) return val.filter(v => v != null && String(v).trim()).map(String);
  if (val && typeof val === 'string') return [val];
  return [];
}

function _unix(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val > 1e12 ? Math.floor(val / 1000) : val;
  if (val?.toMillis)      return Math.floor(val.toMillis() / 1000);
  if (val?.seconds !== undefined) return val.seconds;
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
}

function _geoPoint(loc) {
  if (!loc) return undefined;
  const lat = parseFloat(loc.lat ?? loc.latitude  ?? loc._lat);
  const lng = parseFloat(loc.lng ?? loc.lon ?? loc.longitude ?? loc._long);
  if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return undefined;
  return [lat, lng]; /* Typesense geopoint = [lat, lng] number array */
}

function _geo(data) {
  const gp = _geoPoint(data.location || data.geoPoint || data.coordinates);
  return {
    location:         gp,
    location_area:    _str(data.area    || data.estate          || data.location?.area)   || undefined,
    location_suburb:  _str(data.suburb  || data.location?.suburb)                         || undefined,
    location_city:    _str(data.city    || data.location?.city)                           || undefined,
    location_county:  _str(data.county  || data.location?.county)                         || undefined,
    location_country: _str(data.country || data.location?.country, 'Kenya'),
  };
}

function _trunc(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

function _strip(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)
  );
}

function _enc(s) { return encodeURIComponent(s); }

function _cleanParams(obj) {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, typeof v === 'boolean' ? String(v) : v])
  );
}

module.exports = {
  TypesenseClient,
  COLLECTION_SCHEMAS,
  COLLECTION_MAP,
  TRANSFORMERS,
  TS_SYNONYMS,
  /* Utilities used by sibling CF modules */
  _chunk, _sleep, _str, _float, _int32, _strArr, _unix, _geoPoint, _geo, _strip, _trunc, _enc,
};
