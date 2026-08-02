/**
 * SOKONI Algolia Indexer
 * Enterprise-grade Algolia HTTP client + document transformers for all 13 indexes.
 *
 * Design:
 *  - Native HTTPS (no npm algolia client) — zero dependency surface, predictable latency
 *  - DNS-aware multi-host failover (DSN → write node 1 → write node 2)
 *  - Automatic retry with exponential backoff per Algolia SLA guidance
 *  - Batch writes capped at 1 000 objects (Algolia hard limit)
 *  - Partial update support (saves write units on large documents)
 *  - All transformers produce deterministic, complete Algolia records
 */

'use strict';

const https  = require('https');
const crypto = require('crypto');

/* ═══════════════════════════════════════════════════════════════════════════
   ALGOLIA HTTP CLIENT
════════════════════════════════════════════════════════════════════════════ */

class AlgoliaClient {
  /**
   * @param {string} appId      - Algolia Application ID
   * @param {string} adminKey   - Admin API key (server-side only)
   */
  constructor(appId, adminKey) {
    if (!appId || !adminKey) throw new Error('[Algolia] appId and adminKey are required');
    this.appId    = appId;
    this.adminKey = adminKey;

    /* Ordered host list: DSN first (analytics-aware), then write shards */
    this._hosts = [
      `${appId}-dsn.algolia.net`,
      `${appId}-1.algolianet.com`,
      `${appId}-2.algolianet.com`,
      `${appId}-3.algolianet.com`,
    ];
  }

  /* ── Core HTTP ──────────────────────────────────────────────────────── */

  async _request(method, path, body = null, {
    maxRetries     = 3,
    backoffBase    = 300,
    writeOperation = false,
  } = {}) {
    const hosts     = writeOperation ? this._hosts.slice(1) : this._hosts;
    const payload   = body ? JSON.stringify(body) : null;
    let   lastError;

    for (const host of hosts) {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (attempt > 0) await _sleep(backoffBase * Math.pow(2, attempt - 1));

        try {
          return await this._doRequest(host, method, path, payload);
        } catch (err) {
          lastError = err;
          /* 4xx = client error, do not retry (except 429 rate-limit) */
          if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
            throw err;
          }
          /* Network / 5xx — try next attempt, then next host */
        }
      }
    }
    throw lastError;
  }

  _doRequest(host, method, path, payload) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: host,
        port:     443,
        path,
        method,
        headers: {
          'X-Algolia-Application-Id': this.appId,
          'X-Algolia-API-Key':        this.adminKey,
          'Content-Type':             'application/json',
          'User-Agent':               'SOKONI-CF/2.0',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      };

      const req = https.request(opts, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { parsed = { raw }; }
          if (res.statusCode >= 400) {
            const err = new Error(parsed.message || `Algolia HTTP ${res.statusCode}`);
            err.status  = res.statusCode;
            err.details = parsed;
            return reject(err);
          }
          resolve(parsed);
        });
      });

      req.setTimeout(10_000, () => {
        req.destroy();
        reject(new Error('Algolia request timeout'));
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /* ── Index Operations ───────────────────────────────────────────────── */

  /**
   * Save (create/replace) objects. Splits into 1 000-object chunks automatically.
   * @returns {Promise<object[]>} Array of task objects
   */
  async saveObjects(indexName, objects) {
    if (!Array.isArray(objects) || objects.length === 0) return [];
    const results = [];
    for (const chunk of _chunk(objects, 1000)) {
      const res = await this._request('POST', `/1/indexes/${indexName}/batch`, {
        requests: chunk.map(obj => ({ action: 'updateObject', body: obj })),
      }, { writeOperation: true });
      results.push(res);
    }
    return results;
  }

  /**
   * Partial update — only changes specified fields. Dramatically reduces write units
   * for large objects (products with many images, descriptions, etc.)
   */
  async partialUpdateObjects(indexName, objects, createIfNotExists = true) {
    if (!Array.isArray(objects) || objects.length === 0) return [];
    const action  = createIfNotExists ? 'partialUpdateObject' : 'partialUpdateObjectNoCreate';
    const results = [];
    for (const chunk of _chunk(objects, 1000)) {
      const res = await this._request('POST', `/1/indexes/${indexName}/batch`, {
        requests: chunk.map(obj => ({ action, body: obj })),
      }, { writeOperation: true });
      results.push(res);
    }
    return results;
  }

  /** Delete a single object */
  async deleteObject(indexName, objectID) {
    return this._request('DELETE', `/1/indexes/${indexName}/${enc(objectID)}`, null, { writeOperation: true });
  }

  /** Delete multiple objects in batch */
  async deleteObjects(indexName, objectIDs) {
    if (!Array.isArray(objectIDs) || objectIDs.length === 0) return [];
    const results = [];
    for (const chunk of _chunk(objectIDs, 1000)) {
      const res = await this._request('POST', `/1/indexes/${indexName}/batch`, {
        requests: chunk.map(id => ({ action: 'deleteObject', body: { objectID: id } })),
      }, { writeOperation: true });
      results.push(res);
    }
    return results;
  }

  /* ── Index Management ───────────────────────────────────────────────── */

  async setIndexSettings(indexName, settings) {
    return this._request('PUT', `/1/indexes/${indexName}/settings`, settings, { writeOperation: true });
  }

  async getIndexSettings(indexName) {
    return this._request('GET', `/1/indexes/${indexName}/settings`);
  }

  async getIndexStats(indexName) {
    return this._request('GET', `/1/indexes/${indexName}`);
  }

  async listIndexes() {
    return this._request('GET', '/1/indexes');
  }

  async clearIndex(indexName) {
    return this._request('POST', `/1/indexes/${indexName}/clear`, null, { writeOperation: true });
  }

  async copyIndex(srcIndex, dstIndex) {
    return this._request('POST', `/1/indexes/${srcIndex}/operation`, {
      operation:   'copy',
      destination: dstIndex,
    }, { writeOperation: true });
  }

  async moveIndex(srcIndex, dstIndex) {
    return this._request('POST', `/1/indexes/${srcIndex}/operation`, {
      operation:   'move',
      destination: dstIndex,
    }, { writeOperation: true });
  }

  async waitForTask(indexName, taskID, { maxAttempts = 40 } = {}) {
    let status  = 'notPublished';
    let attempt = 0;
    while (status !== 'published') {
      if (attempt >= maxAttempts) {
        throw new Error(`[Algolia] waitForTask timeout after ${maxAttempts} polls for task ${taskID} on ${indexName}`);
      }
      await _sleep(Math.min(100 * Math.pow(2, attempt++), 5000));
      const res = await this._request('GET', `/1/indexes/${indexName}/task/${taskID}`);
      status = res.status;
    }
  }

  /* ── Synonyms & Rules ───────────────────────────────────────────────── */

  async saveSynonyms(indexName, synonyms, replaceAll = false) {
    if (!synonyms.length) return;
    const res = await this._request(
      'POST',
      `/1/indexes/${indexName}/synonyms/batch?replaceExistingSynonyms=${replaceAll}`,
      synonyms,
      { writeOperation: true }
    );
    return res;
  }

  async saveRules(indexName, rules, replaceAll = false) {
    if (!rules.length) return;
    return this._request(
      'POST',
      `/1/indexes/${indexName}/rules/batch?clearExistingRules=${replaceAll}`,
      rules,
      { writeOperation: true }
    );
  }

  /* ── Secured API Keys ───────────────────────────────────────────────── */

  /**
   * Generate a search-only scoped API key (client-side HMAC — no HTTP call).
   * @param {string} searchOnlyKey  - Your Algolia Search-Only API key
   * @param {object} restrictions   - { filters, validUntil, userToken, referers, ... }
   */
  generateSecuredApiKey(searchOnlyKey, restrictions = {}) {
    const paramStr = Object.entries(restrictions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${enc(k)}=${enc(Array.isArray(v) ? v.join(',') : String(v))}`)
      .join('&');
    const hmac = crypto.createHmac('sha256', searchOnlyKey).update(paramStr).digest('hex');
    return Buffer.from(hmac + paramStr).toString('base64');
  }

  /* ── Alternate host helpers ─────────────────────────────────────────── */

  _insightsHost()                   { return 'insights.algolia.io'; }
  _analyticsHost()                  { return 'analytics.algolia.com'; }
  _personalizationHost(region = 'us') { return `personalization.${region}.algolia.com`; }
  _querySuggestionsHost(region = 'us') { return `query-suggestions.${region}.algolia.com`; }

  /**
   * Fire a request to an arbitrary Algolia host (Insights / Analytics / Personalization / QS).
   * Retries on 5xx / network errors with exponential backoff.
   * Does NOT retry on 4xx (client errors) except 429 (rate-limit).
   */
  async _requestHost(host, method, path, body = null, { maxRetries = 3, backoffBase = 200 } = {}) {
    const payload = body ? JSON.stringify(body) : null;
    let   lastErr;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) await _sleep(backoffBase * Math.pow(2, attempt - 1));
      try {
        return await this._doRequest(host, method, path, payload);
      } catch (err) {
        lastErr = err;
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
      }
    }
    throw lastErr;
  }

  /* ══════════════════════════════════════════════════════════════════════
     INSIGHTS API — Full event taxonomy per Algolia Insights spec v2
  ══════════════════════════════════════════════════════════════════════ */

  /**
   * Send one or more Insights events in a single HTTP call.
   * All other Insights helpers delegate here.
   * @param {object[]} events  – Insights event objects (max 1000 per call)
   */
  async sendEvents(events) {
    if (!Array.isArray(events) || !events.length) return { status: 200, message: 'no-op' };
    const ts = Date.now();
    const normalized = events.map(e => ({
      ...e,
      timestamp:  e.timestamp  || ts,
      userToken:  e.userToken  || 'anonymous',
    }));
    /* Insights API uses a different host */
    return this._requestHost(this._insightsHost(), 'POST', '/1/events', { events: normalized });
  }

  /* ── View events ─────────────────────────────────────────────────────── */

  async sendViewedObjectIDs(indexName, { userToken, objectIDs, eventName = 'Objects Viewed', queryID } = {}) {
    const ev = { eventType: 'view', eventName, index: indexName, userToken: userToken || 'anonymous', objectIDs, timestamp: Date.now() };
    if (queryID) ev.queryID = queryID;
    return this.sendEvents([ev]);
  }

  async sendViewedFilters(indexName, { userToken, filters, eventName = 'Filters Viewed' } = {}) {
    return this.sendEvents([{
      eventType: 'view', eventName, index: indexName,
      userToken: userToken || 'anonymous', filters, timestamp: Date.now(),
    }]);
  }

  /* ── Click events ────────────────────────────────────────────────────── */

  /** Generic click on an object (no prior search) */
  async sendClickedObjectIDs(indexName, { userToken, objectIDs, eventName = 'Object Clicked' } = {}) {
    return this.sendEvents([{
      eventType: 'click', eventName, index: indexName,
      userToken: userToken || 'anonymous', objectIDs, timestamp: Date.now(),
    }]);
  }

  /** Click on a search result (carries queryID + position) */
  async sendClickedObjectIDsAfterSearch(indexName, { userToken, queryID, objectIDs, positions, eventName = 'Product Clicked' } = {}) {
    return this.sendEvents([{
      eventType: 'click', eventName, index: indexName,
      userToken: userToken || 'anonymous', queryID, objectIDs, positions, timestamp: Date.now(),
    }]);
  }

  async sendClickedFilters(indexName, { userToken, filters, eventName = 'Filter Clicked' } = {}) {
    return this.sendEvents([{
      eventType: 'click', eventName, index: indexName,
      userToken: userToken || 'anonymous', filters, timestamp: Date.now(),
    }]);
  }

  /* ── Conversion events ───────────────────────────────────────────────── */

  /** Add to cart (no prior search) */
  async sendAddedToCartObjectIDs(indexName, { userToken, objectIDs, currency = 'KES', objectData, value, eventName = 'Product Added To Cart' } = {}) {
    const ev = {
      eventType: 'conversion', eventSubtype: 'addToCart', eventName, index: indexName,
      userToken: userToken || 'anonymous', objectIDs, currency, timestamp: Date.now(),
    };
    if (objectData) ev.objectData = objectData;
    if (value !== undefined) ev.value = value;
    return this.sendEvents([ev]);
  }

  /** Add to cart from a search result (carries queryID) */
  async sendAddedToCartObjectIDsAfterSearch(indexName, { userToken, queryID, objectIDs, currency = 'KES', objectData, value, eventName = 'Product Added To Cart After Search' } = {}) {
    const ev = {
      eventType: 'conversion', eventSubtype: 'addToCart', eventName, index: indexName,
      userToken: userToken || 'anonymous', queryID, objectIDs, currency, timestamp: Date.now(),
    };
    if (objectData) ev.objectData = objectData;
    if (value !== undefined) ev.value = value;
    return this.sendEvents([ev]);
  }

  /** Purchase (no prior search) */
  async sendPurchasedObjectIDs(indexName, { userToken, objectIDs, currency = 'KES', objectData, value, eventName = 'Product Purchased' } = {}) {
    const ev = {
      eventType: 'conversion', eventSubtype: 'purchase', eventName, index: indexName,
      userToken: userToken || 'anonymous', objectIDs, currency, timestamp: Date.now(),
    };
    if (objectData) ev.objectData = objectData;
    if (value !== undefined) ev.value = value;
    return this.sendEvents([ev]);
  }

  /** Purchase from a search result (carries queryID) */
  async sendPurchasedObjectIDsAfterSearch(indexName, { userToken, queryID, objectIDs, currency = 'KES', objectData, value, eventName = 'Product Purchased After Search' } = {}) {
    const ev = {
      eventType: 'conversion', eventSubtype: 'purchase', eventName, index: indexName,
      userToken: userToken || 'anonymous', queryID, objectIDs, currency, timestamp: Date.now(),
    };
    if (objectData) ev.objectData = objectData;
    if (value !== undefined) ev.value = value;
    return this.sendEvents([ev]);
  }

  /* Legacy aliases — backward-compatible wrappers kept for existing callers */
  async sendClickEvent(indexName, params) {
    return params.queryID
      ? this.sendClickedObjectIDsAfterSearch(indexName, params)
      : this.sendClickedObjectIDs(indexName, params);
  }
  async sendConversionEvent(indexName, params) {
    return this.sendPurchasedObjectIDsAfterSearch(indexName, params);
  }

  /* ══════════════════════════════════════════════════════════════════════
     RECOMMEND API  — FBT, Related, Trending, Looking Similar
  ══════════════════════════════════════════════════════════════════════ */

  /**
   * Algolia Recommend: request multiple recommendation models in one round-trip.
   * @param {Array<{
   *   model: 'bought-together'|'related-products'|'trending-items'|'trending-facets'|'looking-similar',
   *   indexName: string,
   *   objectID?: string,
   *   facetName?: string,
   *   threshold?: number,
   *   maxRecommendations?: number,
   *   queryParameters?: object,
   *   fallbackParameters?: object,
   * }>} requests
   */
  async getRecommendations(requests) {
    return this._request('POST', '/1/indexes/*/recommendations', { requests });
  }

  /* ══════════════════════════════════════════════════════════════════════
     PERSONALIZATION API
  ══════════════════════════════════════════════════════════════════════ */

  async getPersonalizationStrategy(region = 'us') {
    return this._requestHost(this._personalizationHost(region), 'GET', '/1/strategies');
  }

  async setPersonalizationStrategy(strategy, region = 'us') {
    return this._requestHost(this._personalizationHost(region), 'POST', '/1/strategies', strategy);
  }

  /** Fetch the computed Personalization profile for a user token */
  async getUserProfile(userToken, region = 'us') {
    return this._requestHost(
      this._personalizationHost(region), 'GET',
      `/1/profiles/personalization/${enc(userToken)}`
    );
  }

  /** Delete all stored events for a user token (GDPR) */
  async deleteUserProfile(userToken, region = 'us') {
    return this._requestHost(
      this._personalizationHost(region), 'DELETE',
      `/1/profiles/${enc(userToken)}`
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
     A/B TESTING API
  ══════════════════════════════════════════════════════════════════════ */

  /**
   * Create an A/B test comparing two index variants.
   * @param {{ name, variants: [{index, trafficPercentage, description?}], endAt }} abtest
   */
  async createABTest(abtest) {
    return this._requestHost(this._analyticsHost(), 'POST', '/2/abtests', abtest);
  }

  async getABTest(id) {
    return this._requestHost(this._analyticsHost(), 'GET', `/2/abtests/${id}`);
  }

  async stopABTest(id) {
    return this._requestHost(this._analyticsHost(), 'POST', `/2/abtests/${id}/stop`, {});
  }

  async deleteABTest(id) {
    return this._requestHost(this._analyticsHost(), 'DELETE', `/2/abtests/${id}`);
  }

  async listABTests({ limit = 20, offset = 0 } = {}) {
    return this._requestHost(this._analyticsHost(), 'GET', `/2/abtests?limit=${limit}&offset=${offset}`);
  }

  /* ══════════════════════════════════════════════════════════════════════
     QUERY SUGGESTIONS API
  ══════════════════════════════════════════════════════════════════════ */

  async createQuerySuggestionsConfig(config, region = 'us') {
    return this._requestHost(this._querySuggestionsHost(region), 'POST', '/1/configs', config);
  }

  async updateQuerySuggestionsConfig(indexName, config, region = 'us') {
    return this._requestHost(this._querySuggestionsHost(region), 'PUT', `/1/configs/${enc(indexName)}`, config);
  }

  async getQuerySuggestionsConfig(indexName, region = 'us') {
    return this._requestHost(this._querySuggestionsHost(region), 'GET', `/1/configs/${enc(indexName)}`);
  }

  async deleteQuerySuggestionsConfig(indexName, region = 'us') {
    return this._requestHost(this._querySuggestionsHost(region), 'DELETE', `/1/configs/${enc(indexName)}`);
  }

  async listQuerySuggestionsConfigs(region = 'us') {
    return this._requestHost(this._querySuggestionsHost(region), 'GET', '/1/configs');
  }

  /* ══════════════════════════════════════════════════════════════════════
     DYNAMIC RE-RANKING (index-level settings)
  ══════════════════════════════════════════════════════════════════════ */

  async getDynamicRerankingConfig(indexName) {
    return this.getIndexSettings(indexName).then(s => ({
      enableReRanking:      s.enableReRanking,
      relevancyStrictness:  s.relevancyStrictness,
      reRankingApplyFilter: s.reRankingApplyFilter,
    }));
  }

  /** Enable / update Dynamic Re-Ranking on an index */
  async setDynamicRerankingConfig(indexName, { enableReRanking = true, relevancyStrictness = 0, reRankingApplyFilter } = {}) {
    const settings = { enableReRanking, relevancyStrictness };
    if (reRankingApplyFilter !== undefined) settings.reRankingApplyFilter = reRankingApplyFilter;
    return this.setIndexSettings(indexName, settings);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   DOCUMENT TRANSFORMERS
   Each transformer produces a clean, complete Algolia object from a raw
   Firestore document. All fields are explicitly typed. Null-safe.
════════════════════════════════════════════════════════════════════════════ */

const TRANSFORMERS = {

  /* ── Products ───────────────────────────────────────────────────────── */
  products: (id, data) => {
    const images = _normalizeImages(data.images || data.photos || []);
    return {
      objectID:        id,
      name:            _str(data.name || data.title),
      nameLower:       _str(data.name || data.title).toLowerCase(),
      description:     _truncate(_str(data.description), 600),
      category:        _str(data.category),
      subcategory:     _str(data.subcategory),
      categoryPath:    _arr(data.categoryPath, [_str(data.category)].filter(Boolean)),
      brand:           _str(data.brand),
      brandId:         _str(data.brandId),
      sku:             _str(data.sku),
      barcode:         _str(data.barcode),
      price:           _num(data.price),
      originalPrice:   _num(data.originalPrice || data.price),
      discountPercent: _num(data.discountPercent || data.discount),
      currency:        'KES',
      condition:       _str(data.condition, 'new'),
      inStock:         data.inStock !== false,
      quantity:        _num(data.quantity),
      /* Monotonic per-product change marker (bumped on every stock deduction).
         Carried through so search records can later be ignored if older than the
         latest version, and to correlate index state with order/payment logs. */
      inventoryVersion: _num(data.inventoryVersion),
      minOrder:        _num(data.minOrder, 1),
      images,
      thumbnail:       images[0]?.url || _str(data.thumbnail || data.imageUrl || data.image || data.photo || data.coverImage),
      tags:            _arr(data.tags).slice(0, 30),
      keywords:        _arr(data.keywords).slice(0, 20),
      /* Seller-declared variants, flat top-level arrays so one field serves as
         both a searchable attribute and a facet. Always present as an array —
         Algolia cannot facet a field that is absent on some records, which is
         what a product saved before variants existed would otherwise produce. */
      ..._variantAttributes(data),
      seller: {
        id:       _str(data.sellerId || data.seller?.id),
        name:     _str(data.sellerName || data.seller?.name, 'SOKONI Marketplace'),
        slug:     _str(data.sellerSlug || data.seller?.slug),
        rating:   _num(data.sellerRating || data.seller?.rating),
        verified: Boolean(data.sellerVerified || data.seller?.verified),
        logo:     _str(data.sellerLogo || data.seller?.logo),
      },
      rating:          _num(data.rating),
      reviewCount:     _num(data.reviewCount),
      viewCount:       _num(data.viewCount),
      orderCount:      _num(data.orderCount),
      clickCount:      _num(data.clickCount),
      wishlistCount:   _num(data.wishlistCount),
      isFeatured:      Boolean(data.isFeatured),
      featuredLevel:   _num(data.featuredLevel),
      isNew:           Boolean(data.isNew),
      isOnSale:        Boolean(data.isOnSale || (data.discountPercent > 0)),
      isBestseller:    Boolean(data.isBestseller),
      hub:             _str(data.hub, 'shopping'),
      deliveryOptions: _arr(data.deliveryOptions),
      deliveryTime:    _str(data.deliveryTime),
      _geoloc:         _geoPoint(data.location || data.geoPoint),
      location: {
        area:    _str(data.area   || data.location?.area),
        city:    _str(data.city   || data.location?.city),
        county:  _str(data.county || data.location?.county),
        country: _str(data.country, 'Kenya'),
      },
      status:    _str(data.status, 'active'),
      createdAt: _unix(data.createdAt),
      updatedAt: _unix(data.updatedAt),
      /* Hierarchical categories for Algolia hierarchicalMenu widget */
      hierarchicalCategories: _buildHierarchicalCategories(
        _str(data.category),
        _str(data.subcategory),
        _arr(data.categoryPath)
      ),
      /* Four-signal composite scores for AI Ranking + Dynamic Re-Ranking */
      _popularityScore:   Math.log1p(_num(data.orderCount) * 3 + _num(data.viewCount) + _num(data.reviewCount) * 2),
      _salesScore:        Math.log1p(_num(data.orderCount) * 3 + _num(data.clickCount) * 0.5),
      _clickScore:        Math.log1p(_num(data.clickCount) + _num(data.viewCount) * 0.1),
      _conversionScore:   _num(data.viewCount) > 0
                            ? Math.log1p((_num(data.orderCount) / _num(data.viewCount)) * 1000)
                            : 0,
    };
  },

  /* ── Shops / Sellers ────────────────────────────────────────────────── */
  sellers: (id, data) => ({
    objectID:       id,
    name:           _str(data.shopName || data.name || data.displayName),
    nameLower:      _str(data.shopName || data.name || data.displayName).toLowerCase(),
    description:    _truncate(_str(data.description || data.bio), 500),
    category:       _str(data.category || data.businessType),
    subcategory:    _str(data.subcategory),
    logo:           _str(data.logo || data.shopLogo || data.photoURL),
    coverImage:     _str(data.coverImage || data.banner),
    /* PII OMITTED: phone, whatsapp, email — never pushed to Algolia */
    website:        _str(data.website),
    rating:         _num(data.rating),
    reviewCount:    _num(data.reviewCount),
    orderCount:     _num(data.orderCount),
    followerCount:  _num(data.followerCount),
    productCount:   _num(data.productCount),
    verified:       Boolean(data.verified || data.isVerified),
    badge:          _str(data.badge),
    featuredLevel:  _num(data.featuredLevel),
    tags:           _arr(data.tags).slice(0, 20),
    deliveryOptions: _arr(data.deliveryOptions),
    operatingHours: data.operatingHours || null,
    _geoloc: _geoPoint(data.location || data.geoPoint),
    location: {
      area:    _str(data.area   || data.location?.area),
      city:    _str(data.city   || data.location?.city),
      county:  _str(data.county || data.location?.county),
      country: _str(data.country, 'Kenya'),
    },
    joinedAt:  _unix(data.createdAt || data.joinedAt),
    updatedAt: _unix(data.updatedAt),
    hub:       'sellers',
    status:    _str(data.status, 'active'),
    _popularityScore: Math.log1p(_num(data.orderCount) * 2 + _num(data.followerCount) + _num(data.reviewCount)),
  }),

  /* ── Services / Providers ───────────────────────────────────────────── */
  services: (id, data) => {
    const images = _normalizeImages(data.images || data.photos || []);
    return {
      objectID:      id,
      name:          _str(data.name || data.title || data.serviceName),
      nameLower:     _str(data.name || data.title || data.serviceName).toLowerCase(),
      description:   _truncate(_str(data.description || data.details), 600),
      category:      _str(data.category || data.serviceType),
      subcategory:   _str(data.subcategory),
      price:         _num(data.price || data.rate),
      priceMax:      _num(data.priceMax || data.rateMax),
      priceType:     _str(data.priceType, 'fixed'), // fixed | hourly | daily | negotiable
      currency:      'KES',
      duration:      _str(data.duration),
      images,
      thumbnail:     images[0]?.url || _str(data.thumbnail),
      tags:          _arr(data.tags).slice(0, 25),
      provider: {
        id:       _str(data.providerId || data.sellerId || data.uid),
        name:     _str(data.providerName || data.sellerName || data.name),
        rating:   _num(data.providerRating || data.rating),
        verified: Boolean(data.verified || data.providerVerified),
        avatar:   _str(data.providerAvatar || data.photoURL),
      },
      rating:        _num(data.rating),
      reviewCount:   _num(data.reviewCount),
      viewCount:     _num(data.viewCount),
      orderCount:    _num(data.orderCount || data.bookingCount),
      availability:  _arr(data.availability),
      remote:        Boolean(data.remote || data.isRemote || data.isOnline),
      isFeatured:    Boolean(data.isFeatured),
      featuredLevel: _num(data.featuredLevel),
      _geoloc:       _geoPoint(data.location || data.geoPoint),
      location: {
        area:   _str(data.area   || data.location?.area),
        city:   _str(data.city   || data.location?.city),
        county: _str(data.county || data.location?.county),
      },
      hub:       _str(data.hub, 'services'),
      status:    _str(data.status, 'active'),
      createdAt: _unix(data.createdAt),
      updatedAt: _unix(data.updatedAt),
      _popularityScore: Math.log1p(_num(data.orderCount || data.bookingCount) * 3 + _num(data.viewCount) + _num(data.reviewCount) * 2),
    };
  },

  /* ── Events ─────────────────────────────────────────────────────────── */
  events: (id, data) => {
    const images = _normalizeImages(data.images || data.banners || data.photos || []);
    return {
      objectID:     id,
      title:        _str(data.title || data.name),
      titleLower:   _str(data.title || data.name).toLowerCase(),
      description:  _truncate(_str(data.description), 600),
      category:     _str(data.category || data.eventType),
      subcategory:  _str(data.subcategory || data.genre),
      images,
      thumbnail:    images[0]?.url || _str(data.thumbnail || data.image || data.banner),
      price:        _num(data.price || data.ticketPrice),
      priceMax:     _num(data.priceMax || data.ticketPriceMax),
      isFree:       Boolean(data.isFree || (data.price === 0) || (data.price === '0')),
      currency:     'KES',
      startDate:    _unix(data.startDate || data.date),
      endDate:      _unix(data.endDate),
      startDateISO: _iso(data.startDate || data.date),
      endDateISO:   _iso(data.endDate),
      venue:        _str(data.venue || data.location?.venue),
      organizer: {
        id:     _str(data.organizerId || data.uid),
        name:   _str(data.organizerName || data.organizer || data.posterName),
        avatar: _str(data.organizerAvatar),
      },
      tags:          _arr(data.tags).slice(0, 20),
      attendeeCount: _num(data.attendeeCount || data.rsvpCount),
      capacity:      _num(data.capacity),
      isFeatured:    Boolean(data.isFeatured),
      featuredLevel: _num(data.featuredLevel),
      isOnline:      Boolean(data.isOnline || data.virtual),
      _geoloc:       _geoPoint(data.location || data.geoPoint),
      location: {
        venue:  _str(data.venue  || data.location?.venue),
        area:   _str(data.area   || data.location?.area),
        city:   _str(data.city   || data.location?.city),
        county: _str(data.county || data.location?.county),
      },
      hub:      'events',
      status:   _str(data.status, 'active'),
      createdAt: _unix(data.createdAt),
      _popularityScore: Math.log1p(_num(data.attendeeCount || data.rsvpCount) * 2 + _num(data.viewCount)),
    };
  },

  /* ── Properties ─────────────────────────────────────────────────────── */
  properties: (id, data) => {
    const images = _normalizeImages(data.images || data.photos || []);
    return {
      objectID:     id,
      title:        _str(data.title || data.name),
      titleLower:   _str(data.title || data.name).toLowerCase(),
      description:  _truncate(_str(data.description), 600),
      type:         _str(data.type || data.propertyType),
      listingType:  _str(data.listingType, data.forRent ? 'rent' : 'sale'),
      price:        _num(data.price),
      rentPeriod:   _str(data.rentPeriod, 'monthly'),
      currency:     'KES',
      bedrooms:     _num(data.bedrooms),
      bathrooms:    _num(data.bathrooms),
      toilets:      _num(data.toilets),
      sizeSqm:      _num(data.size || data.sizeSqm || data.squareMeters),
      floors:       _num(data.floors),
      yearBuilt:    _num(data.yearBuilt),
      furnished:    Boolean(data.furnished),
      amenities:    _arr(data.amenities).slice(0, 40),
      features:     _arr(data.features).slice(0, 30),
      tags:         _arr(data.tags).slice(0, 20),
      images,
      thumbnail:    images[0]?.url || _str(data.thumbnail),
      agent: {
        id:       _str(data.agentId || data.uid),
        name:     _str(data.agentName || data.agent || data.sellerName),
        /* PII OMITTED: phone — never pushed to Algolia */
        verified: Boolean(data.agentVerified || data.verified),
        avatar:   _str(data.agentAvatar || data.photoURL),
      },
      isFeatured:   Boolean(data.isFeatured),
      featuredLevel: _num(data.featuredLevel),
      viewCount:    _num(data.viewCount),
      inquiryCount: _num(data.inquiryCount),
      _geoloc: _geoPoint(data.location || data.geoPoint),
      location: {
        area:    _str(data.area    || data.estate   || data.location?.area),
        suburb:  _str(data.suburb  || data.location?.suburb),
        city:    _str(data.city    || data.location?.city,    'Nairobi'),
        county:  _str(data.county  || data.location?.county,  'Nairobi'),
        country: _str(data.country || data.location?.country, 'Kenya'),
      },
      hub:      'property',
      status:   _str(data.status, 'active'),
      createdAt: _unix(data.createdAt),
      updatedAt: _unix(data.updatedAt),
      _popularityScore: Math.log1p(_num(data.viewCount) + _num(data.inquiryCount) * 3),
    };
  },

  /* ── Vehicles ────────────────────────────────────────────────────────── */
  cars: (id, data) => {
    const images = _normalizeImages(data.images || data.photos || []);
    const make   = _str(data.make || data.brand);
    const model  = _str(data.model);
    const year   = _num(data.year);
    return {
      objectID:     id,
      title:        _str(data.title, [year || '', make, model].filter(Boolean).join(' ').trim()),
      titleLower:   _str(data.title, [year || '', make, model].filter(Boolean).join(' ')).toLowerCase(),
      make,
      model,
      year,
      trim:         _str(data.trim || data.variant || data.edition),
      type:         _str(data.type || data.vehicleType, 'car'),
      bodyType:     _str(data.bodyType),
      listingType:  _str(data.listingType, data.forRent ? 'rent' : 'sale'),
      price:        _num(data.price),
      currency:     'KES',
      mileage:      _num(data.mileage || data.odometer),
      mileageUnit:  _str(data.mileageUnit, 'km'),
      condition:    _str(data.condition, 'used'),
      fuelType:     _str(data.fuelType || data.fuel),
      transmission: _str(data.transmission || data.gearbox),
      driveType:    _str(data.driveType || data.drive),
      color:        _str(data.color || data.bodyColor || data.exteriorColor),
      interiorColor: _str(data.interiorColor),
      engineSize:   _str(data.engineSize || data.engine || data.cc),
      engineCC:     _num(data.engineCC || data.cc),
      seats:        _num(data.seats),
      doors:        _num(data.doors),
      features:     _arr(data.features || data.extras).slice(0, 30),
      safetyFeatures: _arr(data.safetyFeatures).slice(0, 20),
      images,
      thumbnail:    images[0]?.url || _str(data.thumbnail),
      seller: {
        id:       _str(data.sellerId || data.uid),
        name:     _str(data.sellerName || data.name),
        /* PII OMITTED: phone — never pushed to Algolia */
        verified: Boolean(data.verified || data.sellerVerified),
        dealer:   Boolean(data.isDealer),
      },
      isFeatured:   Boolean(data.isFeatured),
      featuredLevel: _num(data.featuredLevel),
      viewCount:    _num(data.viewCount),
      tags:         _arr(data.tags).slice(0, 20),
      _geoloc: _geoPoint(data.location || data.geoPoint),
      location: {
        area:   _str(data.area   || data.location?.area),
        city:   _str(data.city   || data.location?.city, 'Nairobi'),
        county: _str(data.county || data.location?.county),
      },
      hub:      'vehicles',
      status:   _str(data.status, 'active'),
      createdAt: _unix(data.createdAt),
      updatedAt: _unix(data.updatedAt),
      _popularityScore: Math.log1p(_num(data.viewCount) + _num(data.inquiryCount) * 2),
    };
  },

  /* ── Jobs ────────────────────────────────────────────────────────────── */
  digitalJobs: (id, data) => ({
    objectID:    id,
    title:       _str(data.title || data.jobTitle || data.position),
    titleLower:  _str(data.title || data.jobTitle || data.position).toLowerCase(),
    company:     _str(data.company || data.companyName || data.posterName),
    description: _truncate(_str(data.description || data.details || data.jobDescription), 600),
    category:    _str(data.category || data.jobCategory || data.industry),
    subcategory: _str(data.subcategory || data.department),
    jobType:     _str(data.jobType || data.type || data.employmentType, 'fulltime'),
    remote:      Boolean(data.remote || data.isRemote || data.workFromHome || data.jobType === 'remote'),
    salary: {
      min:      _num(data.salaryMin || data.salary?.min),
      max:      _num(data.salaryMax || data.salary?.max),
      currency: 'KES',
      period:   _str(data.salaryPeriod, 'monthly'),
      display:  _str(data.salaryDisplay, data.salary ? '' : 'negotiable'),
    },
    skills:       _arr(data.skills || data.requirements || data.qualifications).slice(0, 25),
    experience:   _str(data.experience || data.experienceLevel),
    experienceMin: _num(data.experienceMin || data.yearsExperience),
    education:    _str(data.education || data.educationLevel),
    gender:       _str(data.gender, 'any'),
    deadline:     _unix(data.deadline || data.applicationDeadline || data.closingDate),
    deadlineISO:  _iso(data.deadline || data.applicationDeadline),
    poster: {
      id:     _str(data.posterId || data.uid),
      name:   _str(data.posterName || data.company || data.companyName),
      logo:   _str(data.companyLogo || data.posterLogo),
      verified: Boolean(data.verified),
    },
    applicationCount: _num(data.applicationCount || data.applications),
    viewCount:    _num(data.viewCount),
    isFeatured:   Boolean(data.isFeatured),
    featuredLevel: _num(data.featuredLevel),
    tags:         _arr(data.tags).slice(0, 20),
    _geoloc:      _geoPoint(data.location || data.geoPoint),
    location: {
      area:   _str(data.area   || data.location?.area),
      city:   _str(data.city   || data.location?.city),
      county: _str(data.county || data.location?.county),
    },
    hub:       'jobs',
    status:    _str(data.status, 'active'),
    createdAt: _unix(data.createdAt),
    updatedAt: _unix(data.updatedAt),
    _popularityScore: Math.log1p(_num(data.applicationCount) * 3 + _num(data.viewCount)),
  }),

  /* ── Users (public profiles) ────────────────────────────────────────── */
  users: (id, data) => {
    /* Never index private accounts or banned users */
    if (data.private || data.status === 'banned' || data.status === 'deleted') return null;
    return {
      objectID:    id,
      displayName: _str(data.displayName || data.name),
      username:    _str(data.username),
      bio:         _truncate(_str(data.bio), 250),
      avatar:      _str(data.photoURL || data.avatar),
      role:        _str(data.role, 'buyer'),
      verified:    Boolean(data.verified || data.emailVerified),
      sellerVerified: Boolean(data.sellerVerified),
      rating:      _num(data.rating),
      reviewCount: _num(data.reviewCount),
      followerCount: _num(data.followerCount),
      productCount:  _num(data.productCount),
      badgeCount:    _num(data.badgeCount),
      skills:      _arr(data.skills).slice(0, 15),
      tags:        _arr(data.tags).slice(0, 10),
      location: {
        city:   _str(data.city   || data.location?.city),
        county: _str(data.county || data.location?.county),
      },
      joinedAt:  _unix(data.createdAt),
      updatedAt: _unix(data.updatedAt),
      status:    _str(data.status, 'active'),
      _popularityScore: Math.log1p(_num(data.followerCount) + _num(data.reviewCount) * 2),
    };
  },

  /* ── Categories ─────────────────────────────────────────────────────── */
  categories: (id, data) => ({
    objectID:     id,
    name:         _str(data.name),
    nameLower:    _str(data.name).toLowerCase(),
    slug:         _str(data.slug, _slugify(_str(data.name))),
    description:  _str(data.description),
    parentId:     data.parentId || null,
    parentName:   _str(data.parentName),
    level:        _num(data.level, data.parentId ? 1 : 0),
    icon:         _str(data.icon),
    image:        _str(data.image || data.coverImage),
    color:        _str(data.color),
    productCount: _num(data.productCount),
    serviceCount: _num(data.serviceCount),
    hub:          _str(data.hub),
    order:        _num(data.order),
    featured:     Boolean(data.featured),
    active:       data.active !== false,
    createdAt:    _unix(data.createdAt),
  }),

  /* ── Brands ──────────────────────────────────────────────────────────── */
  brands: (id, data) => ({
    objectID:     id,
    name:         _str(data.name),
    nameLower:    _str(data.name).toLowerCase(),
    slug:         _str(data.slug, _slugify(_str(data.name))),
    description:  _truncate(_str(data.description), 400),
    logo:         _str(data.logo || data.image),
    banner:       _str(data.banner || data.coverImage),
    category:     _str(data.category),
    country:      _str(data.country || data.origin),
    productCount: _num(data.productCount),
    verified:     Boolean(data.verified || data.official),
    featured:     Boolean(data.featured),
    popular:      Boolean(data.popular),
    tags:         _arr(data.tags).slice(0, 15),
    createdAt:    _unix(data.createdAt),
    updatedAt:    _unix(data.updatedAt),
    _popularityScore: Math.log1p(_num(data.productCount)),
  }),

  /* ── Collections ─────────────────────────────────────────────────────── */
  collections: (id, data) => ({
    objectID:      id,
    name:          _str(data.name || data.title),
    nameLower:     _str(data.name || data.title).toLowerCase(),
    description:   _truncate(_str(data.description), 400),
    image:         _str(data.image || data.coverImage || data.thumbnail),
    productCount:  _num(data.productCount),
    totalValue:    _num(data.totalValue),
    curator: {
      id:     _str(data.curatorId || data.uid),
      name:   _str(data.curatorName || data.displayName),
      avatar: _str(data.curatorAvatar || data.photoURL),
    },
    tags:          _arr(data.tags).slice(0, 20),
    featured:      Boolean(data.featured),
    official:      Boolean(data.official),
    followCount:   _num(data.followCount),
    viewCount:     _num(data.viewCount),
    hub:           _str(data.hub),
    status:        _str(data.status, 'active'),
    createdAt:     _unix(data.createdAt),
    updatedAt:     _unix(data.updatedAt),
    _popularityScore: Math.log1p(_num(data.followCount) * 2 + _num(data.viewCount)),
  }),

  /* ── Coupons ─────────────────────────────────────────────────────────── */
  coupons: (id, data) => ({
    objectID:       id,
    code:           _str(data.code).toUpperCase(),
    name:           _str(data.name),
    description:    _str(data.description),
    discountType:   _str(data.discountType, 'percent'), // percent | fixed | free_shipping
    discountValue:  _num(data.discountValue),
    minOrderValue:  _num(data.minOrderValue),
    maxDiscount:    _num(data.maxDiscount),
    freeShipping:   Boolean(data.freeShipping),
    validFrom:      _unix(data.validFrom),
    validTo:        _unix(data.validTo),
    validToISO:     _iso(data.validTo),
    usageLimit:     _num(data.usageLimit),
    usageCount:     _num(data.usageCount),
    perUserLimit:   _num(data.perUserLimit, 1),
    applicableTo:   _str(data.applicableTo, 'all'), // all | category | seller | product
    sellerId:       data.sellerId    || null,
    categoryId:     data.categoryId  || null,
    productIds:     _arr(data.productIds).slice(0, 50),
    active:         data.active !== false,
    featured:       Boolean(data.featured),
    createdAt:      _unix(data.createdAt),
    updatedAt:      _unix(data.updatedAt),
  }),
};

/* ═══════════════════════════════════════════════════════════════════════════
   COLLECTION → INDEX MAPPING
════════════════════════════════════════════════════════════════════════════ */

/* ─── Global search transformer factory ────────────────────────────────────
   Builds a flattened sokoni_global record from any primary transformed record.
   objectID is prefixed: "${collection}_${docId}" to prevent cross-type collisions.
   ─────────────────────────────────────────────────────────────────────────── */

const _TYPE_LABELS = {
  products: 'Product', stores: 'Store', services: 'Service', jobs: 'Job',
  vehicles: 'Vehicle', real_estate: 'Property', events: 'Event',
  brands: 'Brand', categories: 'Category', vendors: 'Vendor',
  sellers: 'Store', cars: 'Vehicle', properties: 'Property',
  providers: 'Service', digitalJobs: 'Job', foods: 'Product',
};

const _URL_PATTERNS = {
  products: '/products/', stores: '/stores/', services: '/services/',
  jobs: '/jobs/', vehicles: '/vehicles/', real_estate: '/properties/',
  events: '/events/', brands: '/brands/', categories: '/categories/',
  vendors: '/stores/', sellers: '/stores/', cars: '/vehicles/',
  properties: '/properties/', providers: '/services/', digitalJobs: '/jobs/',
  foods: '/products/',
};

function _globalTransformer(collection) {
  return (id, data) => {
    if (!data) return null;
    const primary = TRANSFORMERS[collection]
      ? TRANSFORMERS[collection](id.replace(`${collection}_`, ''), data)
      : null;
    if (!primary) return null;

    const title       = _str(primary.name || primary.title || primary.displayName);
    const description = _truncate(_str(primary.description || primary.bio), 300);
    const image       = _str(primary.thumbnail || primary.logo || primary.image ||
                             (primary.images && primary.images[0] && primary.images[0].url));
    const city        = _str(primary.location?.city || primary.city);
    const county      = _str(primary.location?.county || primary.county);
    const price       = primary.price ?? null;
    const verified    = Boolean(primary.verified || primary.seller?.verified ||
                                primary.sellerVerified || primary.verifiedSeller);
    const freshness   = _freshnessScore(data.createdAt, data.updatedAt);
    const quality     = _aiQualityScore({ ...data, images: primary.images });

    return {
      objectID:        id,    // already ${collection}_${docId}
      type:            collection,
      typeLabel:       _TYPE_LABELS[collection] || collection,
      title,
      description,
      image,
      url:             (_URL_PATTERNS[collection] || '/') + id.replace(`${collection}_`, ''),
      category:        _str(primary.category),
      city,
      county,
      country:         _str(primary.location?.country || primary.country, 'Kenya'),
      price,
      priceFormatted:  price ? `KES ${Number(price).toLocaleString('en-KE')}` : null,
      rating:          _num(primary.rating) || null,
      verified,
      _geoloc:         primary._geoloc || undefined,
      _popularityScore: _num(primary._popularityScore),
      _freshnessScore:  freshness,
      _qualityScore:    quality,
      createdAt:        _num(primary.createdAt),
      updatedAt:        _num(primary.updatedAt),
    };
  };
}

/* ─── Freshness score (0-100) based on document age ────────────────────────
   Prefers updatedAt over createdAt. Returns 50 for unknown age.
   ─────────────────────────────────────────────────────────────────────────── */
function _freshnessScore(createdAt, updatedAt) {
  const ts = updatedAt || createdAt;
  if (!ts) return 50;
  const unixSec = (typeof ts === 'number') ? ts
    : (ts.toMillis ? Math.floor(ts.toMillis() / 1000) : 0);
  if (!unixSec) return 50;
  const ageDays = (Date.now() / 1000 - unixSec) / 86400;
  if (ageDays <=   7) return 100;
  if (ageDays <=  30) return 85;
  if (ageDays <=  90) return 65;
  if (ageDays <= 180) return 40;
  if (ageDays <= 365) return 20;
  return 5;
}

/* ─── AI quality score (0-100, deterministic) ───────────────────────────────
   Scores content completeness. No external API calls.
   ─────────────────────────────────────────────────────────────────────────── */
function _aiQualityScore(data) {
  if (!data) return 0;
  let score = 0;
  const name = _str(data.name || data.title || data.displayName || data.shopName);
  if (name.length > 5)   score += 15;
  const desc = _str(data.description || data.bio);
  if (desc.length > 50)  score += 20;
  if (desc.length > 200) score += 10;
  const imgs = data.images || data.photos || [];
  if ((Array.isArray(imgs) && imgs.length > 0) || data.thumbnail || data.image || data.logo) score += 15;
  if (data.category)     score += 10;
  if (_num(data.price) > 0) score += 10;
  if (data.city || data.location?.city) score += 10;
  if (_num(data.rating) > 0) score += 5;
  const tags = _arr(data.tags);
  if (tags.length >= 2)  score += 5;
  const allPresent = name.length > 5 && desc.length > 50 && imgs.length > 0 &&
                     data.category && _num(data.price) > 0 &&
                     (data.city || data.location?.city) && _num(data.rating) > 0 &&
                     tags.length >= 2;
  return Math.min(100, allPresent ? Math.max(80, score) : score);
}

/* ─── Vendor transformer (same schema as sellers / stores) ─────────────────
   Vendors are B2B suppliers; the stores_index covers all B2C + B2B shops.
   ─────────────────────────────────────────────────────────────────────────── */
const _vendorAsStore = (id, data) => TRANSFORMERS.sellers(id, {
  ...data,
  shopName:     data.shopName || data.companyName || data.name,
  businessType: data.businessType || data.vendorType || data.category,
});

/* ═══════════════════════════════════════════════════════════════════════════
   COLLECTION → INDEX MAPPING (Production)
   Maps every Firestore collection to its Algolia index.

   PRODUCTION INDEXES (must already exist in Algolia dashboard):
     sokoni_products  sokoni_shops  sokoni_services  sokoni_jobs
     sokoni_vehicles  sokoni_properties  sokoni_events  sokoni_brands  sokoni_categories  sokoni_global

   globalSearch: true  → document is ALSO written to sokoni_global index
   indexInGlobal: false → do NOT write a second sokoni_global copy (used by
                          the gs__ entries themselves to break infinite loop)
════════════════════════════════════════════════════════════════════════════ */

const COLLECTION_INDEX_MAP = {
  /* ── Products ──
     WRITES MUST LAND WHERE THE SEARCH ACTUALLY READS.

     This mapped products to `products_index`, but nothing that serves a user
     query reads that index. The live search UI (search.html loads
     sokoni-search-engine.js, which declares its indexes at :38) queries
     `sokoni_products`, as do functions/search-service.js, the SEARCH_SYNC
     registry at functions/search-sync.js:76, and the repair/backfill tooling
     that resolves index names through that registry.

     So every product written since this mapping was introduced was indexed into
     an index no query touches. The record existed; nothing could retrieve it.

     `sokoni_products` is canonical on the weight of consumers — it is also the
     index whose ranking, synonyms and settings are configured, in
     functions/algolia-admin.js. `products_index` survives only in
     algolia-settings.js and the standalone setup/backfill scripts, which are
     the ones now out of step.

     EXISTING DOCUMENTS ARE NOT MOVED BY THIS CHANGE. Products already written
     to products_index stay there and stay unreachable until a backfill runs
     (algoliaBackfill, functions/index.js:7146). */
  products:    { index: 'sokoni_products',  transformer: TRANSFORMERS.products,    globalSearch: true  },
  foods:       { index: 'sokoni_products',  transformer: TRANSFORMERS.products,    globalSearch: true  },

  /* ── Stores / Sellers ── */
  sellers:     { index: 'sokoni_shops',     transformer: TRANSFORMERS.sellers,     globalSearch: true  },
  stores:      { index: 'sokoni_shops',     transformer: TRANSFORMERS.sellers,     globalSearch: true  },
  vendors:     { index: 'sokoni_shops',     transformer: _vendorAsStore,           globalSearch: true  },

  /* ── Services ── */
  services:    { index: 'sokoni_services',  transformer: TRANSFORMERS.services,    globalSearch: true  },
  providers:   { index: 'sokoni_services',  transformer: TRANSFORMERS.services,    globalSearch: true  },
  /* providerServices — the BOOKABLE services created via providerAddService (name,
     category, price, providerId, description). Was unmapped, so enqueue() returned early
     at algolia-queue.js and no service reached search. Same index + transformer as
     services/providerProfiles; the services transformer already reads these fields. */
  providerServices: { index: 'sokoni_services',  transformer: TRANSFORMERS.services,    globalSearch: true  },
  /* providerProfiles is the CANONICAL provider record, written by
     providerPublish (provider-onboarding.js:226) with name, category,
     subcategory, coverage and status:'active'. It was never registered here,
     so enqueue() returned early at algolia-queue.js:84 and no onboarded
     provider ever reached sokoni_services -- invited providers completed
     onboarding and remained unfindable.

     Mapped to the SAME index and transformer as `providers`, not a new one.
     TRANSFORMERS.services already reads every field providerPublish writes
     and resolves providerId || sellerId || uid, so no mapper change is needed.
     `providers` is retained: it is a separate admin surface (index.js:484). */
  providerProfiles: { index: 'sokoni_services',  transformer: TRANSFORMERS.services,    globalSearch: true  },

  /* ── Jobs ── */
  jobs:        { index: 'sokoni_jobs',      transformer: TRANSFORMERS.digitalJobs, globalSearch: true  },
  digitalJobs: { index: 'sokoni_jobs',      transformer: TRANSFORMERS.digitalJobs, globalSearch: true  },

  /* ── Vehicles ── */
  cars:        { index: 'sokoni_vehicles',  transformer: TRANSFORMERS.cars,        globalSearch: true  },
  vehicles:    { index: 'sokoni_vehicles',  transformer: TRANSFORMERS.cars,        globalSearch: true  },

  /* ── Real Estate ── */
  properties:  { index: 'sokoni_properties', transformer: TRANSFORMERS.properties, globalSearch: true  },
  real_estate: { index: 'sokoni_properties', transformer: TRANSFORMERS.properties, globalSearch: true  },

  /* ── Events ── */
  events:      { index: 'sokoni_events',    transformer: TRANSFORMERS.events,      globalSearch: true  },

  /* ── Collections the PLATFORM actually writes to ─────────────────────────
     Everything above maps a name the search architecture was designed around.
     Several of those names are not what the app writes: the events hub writes
     `entEvents`, the property hub writes `propertyListings`, shops are created
     as `businesses`. None of those were registered, so enqueue() returned early
     (algolia-queue.js:84) and their documents could never reach any index — the
     same defect already recorded above for providerProfiles.

     This is why search looked "product-only": it was not a ranking or query
     problem, it was that only `products` had both a live collection AND a
     registered mapping. Verified 2026-07-24 — `businesses`, `mechanics` and
     `healthProviders` hold documents today and none were reachable.

     Existing transformers are reused deliberately; a shop is a shop whether the
     document lives in `sellers` or `businesses`. */
  businesses:       { index: 'sokoni_shops',      transformer: TRANSFORMERS.sellers,    globalSearch: true },
  restaurants:      { index: 'sokoni_shops',      transformer: TRANSFORMERS.sellers,    globalSearch: true },
  mechanics:        { index: 'sokoni_services',   transformer: TRANSFORMERS.services,   globalSearch: true },
  healthProviders:  { index: 'sokoni_services',   transformer: TRANSFORMERS.services,   globalSearch: true },
  lawyers:          { index: 'sokoni_services',   transformer: TRANSFORMERS.services,   globalSearch: true },
  entEvents:        { index: 'sokoni_events',     transformer: TRANSFORMERS.events,     globalSearch: true },
  entVenues:        { index: 'sokoni_events',     transformer: TRANSFORMERS.events,     globalSearch: true },
  propertyListings: { index: 'sokoni_properties', transformer: TRANSFORMERS.properties, globalSearch: true },
  bnbListings:      { index: 'sokoni_properties', transformer: TRANSFORMERS.properties, globalSearch: true },

  /* ── Supplementary (dedicated sub-indexes; also in sokoni_global) ── */
  brands:      { index: 'sokoni_brands',     transformer: TRANSFORMERS.brands,      globalSearch: true  },
  categories:  { index: 'sokoni_categories', transformer: TRANSFORMERS.categories,  globalSearch: false },
  collections: { index: 'sokoni_collections',transformer: TRANSFORMERS.collections, globalSearch: false },
  coupons:     { index: 'sokoni_coupons',    transformer: TRANSFORMERS.coupons,     globalSearch: false },

  /* ── Users (admin index — never in sokoni_global) ── */
  users:       { index: 'sokoni_users',      transformer: TRANSFORMERS.users,       globalSearch: false },

  /* ── Global search shadow entries (one per globalSearch:true collection) ──
     These are written by algolia-queue.js fanout.
     objectID = "${collection}_${docId}"  (prefixed to avoid cross-type collisions)
     indexInGlobal:false prevents a second-level fanout loop.
  ── */
  'gs__products':    { index: 'sokoni_global', transformer: _globalTransformer('products'),    globalSearch: false },
  'gs__foods':       { index: 'sokoni_global', transformer: _globalTransformer('foods'),       globalSearch: false },
  'gs__sellers':     { index: 'sokoni_global', transformer: _globalTransformer('sellers'),     globalSearch: false },
  'gs__stores':      { index: 'sokoni_global', transformer: _globalTransformer('stores'),      globalSearch: false },
  'gs__vendors':     { index: 'sokoni_global', transformer: _globalTransformer('vendors'),     globalSearch: false },
  'gs__services':    { index: 'sokoni_global', transformer: _globalTransformer('services'),    globalSearch: false },
  'gs__providers':   { index: 'sokoni_global', transformer: _globalTransformer('providers'),   globalSearch: false },
  'gs__jobs':        { index: 'sokoni_global', transformer: _globalTransformer('jobs'),        globalSearch: false },
  'gs__digitalJobs': { index: 'sokoni_global', transformer: _globalTransformer('digitalJobs'), globalSearch: false },
  'gs__cars':        { index: 'sokoni_global', transformer: _globalTransformer('cars'),        globalSearch: false },
  'gs__vehicles':    { index: 'sokoni_global', transformer: _globalTransformer('vehicles'),    globalSearch: false },
  'gs__properties':  { index: 'sokoni_global', transformer: _globalTransformer('properties'),  globalSearch: false },
  'gs__real_estate': { index: 'sokoni_global', transformer: _globalTransformer('real_estate'), globalSearch: false },
  'gs__events':      { index: 'sokoni_global', transformer: _globalTransformer('events'),      globalSearch: false },
  'gs__brands':      { index: 'sokoni_global', transformer: _globalTransformer('brands'),      globalSearch: false },
};

/* ═══════════════════════════════════════════════════════════════════════════
   FIELD DIFF — detect which fields actually changed (partial update support)
════════════════════════════════════════════════════════════════════════════ */

/**
 * Returns only the fields that differ between before and after snapshots.
 * The transformed Algolia object is built from `after`; we then strip fields
 * where the value is identical to what was last indexed.
 *
 * @param {object} beforeData  - Firestore before snapshot data
 * @param {object} afterData   - Firestore after snapshot data
 * @param {string} collection  - Firestore collection name
 * @param {string} id          - Document ID
 * @returns {{ objectID: string, [field]: any } | null}
 *   Null = no meaningful changes; otherwise a partial Algolia object.
 */
function buildPartialUpdate(beforeData, afterData, collection, id) {
  const mapping = COLLECTION_INDEX_MAP[collection];
  if (!mapping) return null;

  const beforeRecord = mapping.transformer(id, beforeData);
  const afterRecord  = mapping.transformer(id, afterData);
  if (!afterRecord) return null;

  const partial = { objectID: id };
  let   changed = false;

  for (const key of Object.keys(afterRecord)) {
    if (key === 'objectID') continue;
    const a = JSON.stringify(beforeRecord?.[key]);
    const b = JSON.stringify(afterRecord[key]);
    if (a !== b) {
      partial[key] = afterRecord[key];
      changed = true;
    }
  }

  return changed ? partial : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   UTILITY FUNCTIONS
════════════════════════════════════════════════════════════════════════════ */

function _chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _str(val, fallback = '') {
  if (val === null || val === undefined) return fallback;
  return String(val).trim();
}

function _num(val, fallback = 0) {
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

function _arr(val, fallback = []) {
  if (Array.isArray(val)) return val;
  if (val === null || val === undefined) return fallback;
  return fallback;
}

/* Variant attributes come from search-terms.js so the live trigger and the
   backfill script normalise them identically. */
const { variantAttributes: _variantAttributes } = require('./search-terms');

function _unix(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (val && typeof val.toMillis === 'function') return Math.floor(val.toMillis() / 1000);
  if (val && typeof val.seconds === 'number')   return val.seconds;
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
}

function _iso(val) {
  if (!val) return null;
  try {
    const d = val && typeof val.toDate === 'function' ? val.toDate() : new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch (_) { return null; }
}

function _geoPoint(loc) {
  if (!loc) return undefined;
  const lat = Number(loc.lat ?? loc.latitude  ?? loc._lat);
  const lng = Number(loc.lng ?? loc.lon ?? loc.longitude ?? loc._long);
  if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return undefined;
  return { lat, lng };
}

function _truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

function _slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Build Algolia hierarchicalMenu-compatible category object.
 * @example { 'lvl0': 'Electronics', 'lvl1': 'Electronics > Phones', 'lvl2': 'Electronics > Phones > Android' }
 */
function _buildHierarchicalCategories(category, subcategory, categoryPath) {
  const result = {};
  if (category) {
    result['lvl0'] = category;
    if (subcategory) {
      result['lvl1'] = `${category} > ${subcategory}`;
      if (categoryPath && categoryPath.length > 2) {
        result['lvl2'] = `${category} > ${subcategory} > ${categoryPath[2]}`;
      }
    } else if (categoryPath && categoryPath.length > 1) {
      result['lvl1'] = `${categoryPath[0]} > ${categoryPath[1]}`;
      if (categoryPath.length > 2) {
        result['lvl2'] = categoryPath.slice(0, 3).join(' > ');
      }
    }
  }
  return result;
}

function _normalizeImages(images) {
  return images
    .slice(0, 10)
    .map(img => {
      if (typeof img === 'string') return { url: img, alt: '' };
      return { url: _str(img.url || img.src || img), alt: _str(img.alt) };
    })
    .filter(img => img.url);
}

function enc(str) {
  return encodeURIComponent(str);
}

module.exports = {
  AlgoliaClient,
  TRANSFORMERS,
  COLLECTION_INDEX_MAP,
  buildPartialUpdate,
  /* Scoring helpers */
  _freshnessScore,
  _aiQualityScore,
  _globalTransformer,
  /* Utility functions */
  _chunk,
  _sleep,
  _str,
  _num,
  _arr,
  _unix,
  _geoPoint,
  _truncate,
  _slugify,
  _buildHierarchicalCategories,
};
