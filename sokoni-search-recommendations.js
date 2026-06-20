/**
 * SOKONI Search Recommendations Engine v1.0
 *
 * Client-side personalization and recommendation layer built on top of
 * sokoni-typesense-engine.js. Zero external dependencies — all signals
 * are derived from local behavioural events and Typesense multi_search.
 *
 * Recommendation types:
 *  - Recently viewed        : last 50 items across all hubs
 *  - Frequently bought together (FBT) : co-occurrence from order events
 *  - Cross-sell            : same category, different brand/seller
 *  - Upsell                : same product type, higher price tier
 *  - Trending              : top items by _popularityScore in user's affinity categories
 *  - Personalised homepage : blended feed ranked by user affinity scores
 *  - Zero-result suggestions: query reformulation + category nudges
 *  - Similar items          : Typesense search by shared tags/category, exclude self
 *
 * Works standalone when window.sokoniTypesenseSearch is available.
 * Degrades gracefully if Typesense is not configured.
 */

(function (root) {
  'use strict';

  /* ══════════════════════════════════════════════════════════════
     CONSTANTS
  ══════════════════════════════════════════════════════════════ */

  const REC_STORAGE_KEY  = 'sokoni_recs_state';
  const CO_OCCUR_KEY     = 'sokoni_co_occur';   /* co-occurrence matrix */
  const MAX_CO_OCCUR     = 300;                 /* unique pairs stored  */
  const MAX_REC_ITEMS    = 20;
  const STALE_TTL        = 10 * 60 * 1000;     /* 10min before re-fetch */

  /* Minimum price multiplier for an upsell to qualify */
  const UPSELL_MIN_RATIO = 1.25;

  /* ══════════════════════════════════════════════════════════════
     CO-OCCURRENCE MATRIX
     Records item pairs that appear in the same order / session.
     Stored in localStorage — max 300 entries, LRU eviction.
  ══════════════════════════════════════════════════════════════ */

  const CoOccurrence = {
    _load() {
      try { return JSON.parse(localStorage.getItem(CO_OCCUR_KEY) || '{}'); }
      catch (_) { return {}; }
    },
    _save(m) {
      try { localStorage.setItem(CO_OCCUR_KEY, JSON.stringify(m)); }
      catch (_) {}
    },

    /** Record that docId A and docId B were purchased / viewed together */
    record(idA, idB) {
      if (idA === idB) return;
      const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
      const m   = this._load();
      m[key]    = (m[key] || 0) + 1;

      /* Evict oldest if over limit */
      const entries = Object.entries(m);
      if (entries.length > MAX_CO_OCCUR) {
        entries.sort((a, b) => a[1] - b[1]);
        entries.slice(0, entries.length - MAX_CO_OCCUR).forEach(([k]) => delete m[k]);
      }
      this._save(m);
    },

    /** Return ids most co-occurring with targetId, sorted by count */
    getRelated(targetId, limit = 6) {
      const m       = this._load();
      const related = [];
      for (const [key, count] of Object.entries(m)) {
        const [a, b] = key.split('|');
        const other  = a === targetId ? b : b === targetId ? a : null;
        if (other) related.push({ id: other, count });
      }
      return related.sort((a, b) => b.count - a.count).slice(0, limit).map(r => r.id);
    },
  };

  /* ══════════════════════════════════════════════════════════════
     RECOMMENDATION CACHE — sessionStorage, keyed by rec type
  ══════════════════════════════════════════════════════════════ */

  const RecCache = {
    _prefix: 'sok_rec_',
    get(key) {
      try {
        const raw = sessionStorage.getItem(this._prefix + key);
        if (!raw) return null;
        const { data, expires } = JSON.parse(raw);
        if (Date.now() > expires) { sessionStorage.removeItem(this._prefix + key); return null; }
        return data;
      } catch (_) { return null; }
    },
    set(key, data, ttlMs = STALE_TTL) {
      try {
        sessionStorage.setItem(this._prefix + key, JSON.stringify({ data, expires: Date.now() + ttlMs }));
      } catch (_) {}
    },
  };

  /* ══════════════════════════════════════════════════════════════
     UTILITY
  ══════════════════════════════════════════════════════════════ */

  function _ts() {
    return root.sokoniTypesenseSearch || null;
  }

  function _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function _unique(items, keyFn) {
    const seen = new Set();
    return items.filter(item => {
      const k = keyFn(item);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /* Extract a normalised doc from a Typesense hit */
  function _doc(hit) { return hit?.document || hit || {}; }

  /* ══════════════════════════════════════════════════════════════
     RECOMMENDATIONS ENGINE
  ══════════════════════════════════════════════════════════════ */

  const SokoniRecommendations = {

    /* ── Recently viewed ─────────────────────────────────────── */

    /**
     * Returns the last `limit` recently viewed items enriched
     * with fresh data from Typesense (name, image, price).
     */
    async recentlyViewed(limit = 10) {
      const engine = _ts();
      const rv     = engine?.RecentlyViewed?.get?.() || [];
      if (!rv.length) return [];

      const items = rv.slice(0, limit);

      /* Enrich with live Typesense data where possible */
      if (engine?.isReady) {
        const enriched = await this._enrichItems(items);
        return enriched;
      }

      return items;
    },

    /* ── Similar items ───────────────────────────────────────── */

    /**
     * Returns items similar to the given document.
     * Strategy: search same collection by shared tags + category,
     * exclude the document itself, sort by _popularityScore.
     */
    async similarItems(doc, opts = {}) {
      const engine = _ts();
      if (!engine?.isReady || !doc) return [];

      const collection = opts.collection || 'sokoni_products';
      const cacheKey   = `similar_${collection}_${doc.id}`;
      const cached     = RecCache.get(cacheKey);
      if (cached) return cached;

      const tags     = Array.isArray(doc.tags)     ? doc.tags.slice(0, 5)     : [];
      const category = doc.category || doc.subject || doc.type || '';

      /* Build filter: same category, exclude self */
      let filterBy = `status:=[active,published]`;
      if (category) filterBy += ` && category:=${this._esc(category)}`;

      /* Prefer matching tags for relevance */
      const queryText = tags.length ? tags.join(' ') : (doc.name || doc.title || '*');

      try {
        const res = await engine.search(queryText, {
          collection,
          filterBy,
          sortBy:  '_popularityScore:desc',
          perPage: Math.min((opts.limit || 8) + 1, 20),
          _prefetch: true,
        });

        const col = res.results?.[collection];
        const hits = (col?.hits || [])
          .map(_doc)
          .filter(d => d.id && d.id !== doc.id)
          .slice(0, opts.limit || 8);

        RecCache.set(cacheKey, hits);
        return hits;
      } catch (_) { return []; }
    },

    /* ── Frequently bought together (FBT) ────────────────────── */

    /**
     * Returns items frequently paired with the given docId.
     * Uses the local co-occurrence matrix first, then falls back
     * to a tag-similarity search.
     */
    async frequentlyBoughtTogether(docId, doc, opts = {}) {
      const engine = _ts();
      if (!engine) return [];

      const cacheKey = `fbt_${docId}`;
      const cached   = RecCache.get(cacheKey);
      if (cached) return cached;

      /* Try co-occurrence matrix */
      const relatedIds = CoOccurrence.getRelated(docId, opts.limit || 6);

      if (relatedIds.length && engine.isReady) {
        try {
          const filterBy = `id:[${relatedIds.join(',')}] && status:=[active,published]`;
          const res      = await engine.search('*', {
            collection: opts.collection || 'sokoni_products',
            filterBy,
            perPage: opts.limit || 6,
            _prefetch: true,
          });
          const col  = res.results?.[opts.collection || 'sokoni_products'];
          const hits = (col?.hits || []).map(_doc).filter(d => d.id);
          if (hits.length) { RecCache.set(cacheKey, hits); return hits; }
        } catch (_) {}
      }

      /* Fallback: similar items from same category */
      return this.similarItems(doc, opts);
    },

    /* ── Cross-sell ──────────────────────────────────────────── */

    /**
     * Returns complementary items from a different category.
     * For a product, returns items commonly paired in a basket context:
     * e.g. phone → charger, shoes → socks, laptop → bag.
     */
    async crossSell(doc, opts = {}) {
      const engine     = _ts();
      if (!engine?.isReady || !doc) return [];

      const cacheKey = `xsell_${doc.id}`;
      const cached   = RecCache.get(cacheKey);
      if (cached) return cached;

      /* Cross-sell category map */
      const CROSS_MAP = {
        'phones':      ['chargers', 'phone cases', 'earphones', 'screen protectors'],
        'laptops':     ['laptop bags', 'laptop stands', 'mice', 'keyboards'],
        'shoes':       ['socks', 'shoe care', 'insoles'],
        'clothes':     ['belts', 'watches', 'bags'],
        'furniture':   ['home decor', 'lighting', 'rugs'],
        'cameras':     ['memory cards', 'tripods', 'camera bags'],
      };

      const cat      = (doc.category || '').toLowerCase();
      const relCats  = CROSS_MAP[cat] || [];
      const queryStr = relCats.length ? relCats[0] : (doc.tags?.[0] || '');
      if (!queryStr) return [];

      try {
        const res = await engine.search(queryStr, {
          collection: opts.collection || 'sokoni_products',
          filterBy:   `status:=[active,published]`,
          sortBy:     '_popularityScore:desc',
          perPage:    opts.limit || 6,
          _prefetch:  true,
        });
        const col  = res.results?.[opts.collection || 'sokoni_products'];
        const hits = (col?.hits || []).map(_doc).filter(d => d.id && d.id !== doc.id).slice(0, opts.limit || 6);
        RecCache.set(cacheKey, hits);
        return hits;
      } catch (_) { return []; }
    },

    /* ── Upsell ──────────────────────────────────────────────── */

    /**
     * Returns higher-value alternatives in the same category.
     * Qualifies as upsell if price >= current * UPSELL_MIN_RATIO.
     */
    async upsell(doc, opts = {}) {
      const engine = _ts();
      if (!engine?.isReady || !doc) return [];

      const cacheKey = `upsell_${doc.id}`;
      const cached   = RecCache.get(cacheKey);
      if (cached) return cached;

      const currentPrice = doc.price || 0;
      const minPrice     = Math.round(currentPrice * UPSELL_MIN_RATIO);
      const category     = doc.category || '';

      let filterBy = `status:=[active,published] && price:>=${minPrice}`;
      if (category) filterBy += ` && category:=${this._esc(category)}`;

      try {
        const res = await engine.search(doc.name || '*', {
          collection: opts.collection || 'sokoni_products',
          filterBy,
          sortBy:    'price:asc,_popularityScore:desc',
          perPage:   opts.limit || 4,
          _prefetch: true,
        });
        const col  = res.results?.[opts.collection || 'sokoni_products'];
        const hits = (col?.hits || []).map(_doc).filter(d => d.id && d.id !== doc.id).slice(0, opts.limit || 4);
        RecCache.set(cacheKey, hits);
        return hits;
      } catch (_) { return []; }
    },

    /* ── Trending ────────────────────────────────────────────── */

    /**
     * Returns trending items from the user's most-visited collections.
     * Falls back to overall trending products if no affinity data.
     */
    async trending(opts = {}) {
      const engine = _ts();
      if (!engine?.isReady) return [];

      const cacheKey = `trending_${opts.collection || 'all'}`;
      const cached   = RecCache.get(cacheKey);
      if (cached) return cached;

      const affinity   = engine.UserPreferences?.getAffinityOrder?.() || [];
      const collection = opts.collection || affinity[0] || 'sokoni_products';

      try {
        const res = await engine.search('*', {
          collection,
          filterBy:  `status:=[active,published]`,
          sortBy:    '_popularityScore:desc',
          perPage:   opts.limit || 12,
          _prefetch: true,
        });
        const col  = res.results?.[collection];
        const hits = (col?.hits || []).map(_doc).filter(d => d.id).slice(0, opts.limit || 12);
        RecCache.set(cacheKey, hits);
        return hits;
      } catch (_) { return []; }
    },

    /* ── Personalised feed ───────────────────────────────────── */

    /**
     * Returns a blended personalised feed based on:
     *  1. User's top-affinity collections (weighted by click score)
     *  2. Recently viewed categories
     *  3. Trending global fallback
     *
     * @param {object} opts — { limit, collections, filterBy }
     * @returns {Array} deduplicated items ranked by blended score
     */
    async personalisedFeed(opts = {}) {
      const engine = _ts();
      if (!engine?.isReady) return [];

      const cacheKey = `feed_${JSON.stringify(opts).slice(0, 60)}`;
      const cached   = RecCache.get(cacheKey);
      if (cached) return cached;

      const limit    = opts.limit || 20;
      const affinity = engine.UserPreferences?.getAffinityOrder?.() || [];

      /* Select top 4 affinity collections, fall back to defaults */
      const defaults = ['sokoni_products', 'sokoni_services', 'sokoni_events', 'sokoni_shops'];
      const cols     = affinity.length
        ? _unique([...affinity.slice(0, 4), ...defaults], c => c).slice(0, 4)
        : defaults;

      const perCol = Math.ceil(limit / cols.length);

      const searches = cols.map(col => ({
        collection:   col,
        q:            '*',
        query_by:     'name,title',
        filter_by:    opts.filterBy || 'status:=[active,published]',
        sort_by:      '_popularityScore:desc',
        per_page:     perCol,
        search_cutoff_ms: 200,
      }));

      try {
        const res  = await engine._client?.multiSearch?.(searches);
        const out  = [];
        (res?.results || []).forEach((r, i) => {
          (r.hits || []).map(_doc).forEach(d => {
            out.push({ ...d, _recCollection: cols[i], _recScore: (d._popularityScore || 0) * (affinity.indexOf(cols[i]) === -1 ? 1 : 2) });
          });
        });

        /* Blend and deduplicate */
        const blended = _unique(out, d => d.id)
          .sort((a, b) => (b._recScore || 0) - (a._recScore || 0))
          .slice(0, limit);

        RecCache.set(cacheKey, blended);
        return blended;
      } catch (_) { return []; }
    },

    /* ── Zero-result suggestions ────────────────────────────── */

    /**
     * When a search returns 0 results, generate recovery suggestions:
     *  1. Fuzzy reformulations (common Swahili/English typos)
     *  2. Broader category search
     *  3. Trending items from related collections
     */
    async zeroResultSuggestions(query, opts = {}) {
      const engine = _ts();
      if (!engine) return { reformulations: [], trending: [], message: '' };

      const reformulations = [];

      /* Try with higher typo tolerance */
      if (engine.isReady) {
        try {
          const res = await engine._client?.search?.(opts.collection || 'sokoni_products', {
            q:               query,
            query_by:        'name,tags,description',
            per_page:        6,
            num_typos:       3,
            typo_tokens_threshold: 1,
            filter_by:       'status:=[active,published]',
            search_cutoff_ms: 300,
          });
          if (res?.hits?.length) {
            reformulations.push({ label: `Results for "${res.hits[0]?.document?.name}"`, items: res.hits.map(_doc) });
          }
        } catch (_) {}
      }

      /* Category search fallback */
      if (engine.isReady) {
        try {
          const catRes = await engine.search(query, {
            collection: 'sokoni_categories',
            perPage:    4,
            _prefetch:  true,
          });
          const cats = (catRes.results?.['sokoni_categories']?.hits || []).map(_doc);
          if (cats.length) {
            reformulations.push({ label: 'Try browsing categories', categories: cats });
          }
        } catch (_) {}
      }

      /* Trending fallback */
      const trendItems = await this.trending({ limit: 8, ...opts });

      return {
        reformulations,
        trending:  trendItems,
        message:   trendItems.length ? 'You might be interested in' : 'No results found',
      };
    },

    /* ── "You May Also Like" composite widget ────────────────── */

    /**
     * Returns a composite widget payload for product pages.
     * Runs FBT, similar, and cross-sell in parallel.
     */
    async youMayAlsoLike(docId, doc, collection = 'sokoni_products', limit = 6) {
      const cacheKey = `ymyl_${collection}_${docId}`;
      const cached   = RecCache.get(cacheKey);
      if (cached) return cached;

      const [similar, fbt, xsell] = await Promise.allSettled([
        this.similarItems(doc,                         { collection, limit }),
        this.frequentlyBoughtTogether(docId, doc,      { collection, limit }),
        this.crossSell(doc,                            { collection, limit: Math.ceil(limit / 2) }),
      ]);

      const payload = {
        similar: similar.status === 'fulfilled' ? similar.value : [],
        fbt:     fbt.status     === 'fulfilled' ? fbt.value     : [],
        xsell:   xsell.status   === 'fulfilled' ? xsell.value   : [],
      };

      RecCache.set(cacheKey, payload);
      return payload;
    },

    /* ── Event recording ─────────────────────────────────────── */

    /** Call after an order is placed — records all item pairs */
    recordOrderItems(itemIds) {
      if (!Array.isArray(itemIds) || itemIds.length < 2) return;
      for (let i = 0; i < itemIds.length; i++) {
        for (let j = i + 1; j < itemIds.length; j++) {
          CoOccurrence.record(itemIds[i], itemIds[j]);
        }
      }
    },

    /** Call when a user views an item */
    recordView(item) {
      const engine = _ts();
      engine?.trackView?.(item);
    },

    /** Call on add-to-cart */
    recordCartAdd(docId, sessionCartIds = []) {
      sessionCartIds.forEach(existingId => CoOccurrence.record(existingId, docId));
    },

    /* ── Enrich item list with fresh Typesense data ──────────── */

    async _enrichItems(items) {
      const engine = _ts();
      if (!engine?.isReady || !items.length) return items;

      /* Group by collection, fetch in one multi_search call */
      const byCol = {};
      items.forEach(item => {
        const col = item.collection || 'sokoni_products';
        if (!byCol[col]) byCol[col] = [];
        byCol[col].push(item.id);
      });

      const searches = Object.entries(byCol).map(([col, ids]) => ({
        collection:      col,
        q:               '*',
        query_by:        'id',
        filter_by:       `id:[${ids.join(',')}]`,
        per_page:        ids.length,
        include_fields:  'id,name,title,price,image,rating,category,status',
        search_cutoff_ms: 200,
      }));

      try {
        const res    = await engine._client?.multiSearch?.(searches);
        const docMap = {};
        (res?.results || []).forEach(r => {
          (r.hits || []).forEach(h => { if (h.document?.id) docMap[h.document.id] = h.document; });
        });
        return items.map(item => ({ ...item, ...(docMap[item.id] || {}) }));
      } catch (_) {
        return items;
      }
    },

    /* ── Escape filter chars ─────────────────────────────────── */

    _esc(val) {
      return String(val).replace(/[[\]()\\:`,]/g, '\\$&');
    },
  };

  /* ══════════════════════════════════════════════════════════════
     PUBLIC EXPORT
  ══════════════════════════════════════════════════════════════ */

  root.sokoniRecommendations = SokoniRecommendations;

  /* Convenience shorthand */
  root.sokoniRecs = SokoniRecommendations;

}(typeof window !== 'undefined' ? window : this));
