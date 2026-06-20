/**
 * SOKONI Search Engine v1.0
 * Phase 8: Client-side search index with fuzzy matching, debouncing,
 * category/hub filters, cached suggestions, and Firestore hybrid fallback.
 *
 * Usage:
 *   SokoniSearch.indexItems(products, ["name", "category", "description"]);
 *   SokoniSearch.debounce(query, { hub: "shopping" }, results => render(results));
 *   const suggestions = SokoniSearch.getSuggestions("shoes", 6);
 *   SokoniSearch.registerFirestoreSearch(async (q, opts) => firestoreResults);
 */
const SokoniSearch = (function () {
  "use strict";

  const DEBOUNCE_MS  = 280;
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const MAX_RESULTS  = 50;
  const MIN_SCORE    = 20;

  let _timer       = null;
  let _cache       = new Map();
  let _index       = [];
  let _remoteFn    = null;

  /* ── Scoring ─────────────────────────────────────────────── */
  function _score(text, query) {
    const t = text.toLowerCase();
    const q = query.toLowerCase().trim();
    if (!q) return 0;
    if (t === q)           return 100;
    if (t.startsWith(q))   return 90;
    if (t.includes(" " + q)) return 82;  // word boundary
    if (t.includes(q))     return 70;

    /* Character subsequence — rewards same-order chars */
    let qi = 0, bonus = 0;
    for (let i = 0; i < t.length && qi < q.length; i++) {
      if (t[i] === q[qi]) { bonus++; qi++; }
    }
    if (qi < q.length) return 0; // not all query chars present
    return Math.round((bonus / q.length) * 45);
  }

  /* ── Cache helpers ───────────────────────────────────────── */
  function _cKey(q, opts) {
    return `${q}|${(opts.hub || "")}|${(opts.category || "")}`;
  }

  function _fromCache(k) {
    const e = _cache.get(k);
    if (!e) return null;
    if (Date.now() > e.exp) { _cache.delete(k); return null; }
    return e.data;
  }

  function _toCache(k, data) {
    if (_cache.size > 300) _cache.delete(_cache.keys().next().value);
    _cache.set(k, { data, exp: Date.now() + CACHE_TTL_MS });
  }

  /* ── Index management ───────────────────────────────────── */
  /**
   * indexItems — call once after loading a product/service/listing list.
   * @param {Array}  items  — array of objects
   * @param {Array}  fields — string fields to include in the search text
   */
  function indexItems(items, fields = ["name", "category", "description", "tags"]) {
    _index = items.map(item => ({
      ...item,
      _txt: fields.map(f => String(item[f] || "")).join(" ").toLowerCase(),
    }));
    _cache.clear(); // invalidate stale results
  }

  function appendItems(items, fields = ["name", "category", "description", "tags"]) {
    const newEntries = items.map(item => ({
      ...item,
      _txt: fields.map(f => String(item[f] || "")).join(" ").toLowerCase(),
    }));
    const existingIds = new Set(_index.map(i => i.id));
    for (const e of newEntries) {
      if (!existingIds.has(e.id)) _index.push(e);
    }
    _cache.clear();
  }

  /* ── Local search ───────────────────────────────────────── */
  function searchLocal(query, opts = {}) {
    const q = (query || "").trim();
    if (!q || q.length < 1) return [];

    const cKey   = _cKey(q + "_local", opts);
    const cached = _fromCache(cKey);
    if (cached) return cached;

    const { hub, category, limit = MAX_RESULTS, minScore = MIN_SCORE, status } = opts;

    let pool = _index;
    if (hub)      pool = pool.filter(i => (i.hub      || "").toLowerCase() === hub.toLowerCase());
    if (category) pool = pool.filter(i => (i.category || "").toLowerCase() === category.toLowerCase());
    if (status)   pool = pool.filter(i => (i.status   || "") === status);

    const scored = pool
      .map(item => ({ item, score: _score(item._txt, q) }))
      .filter(r => r.score >= minScore)
      .sort((a, b) => {
        /* Tie-break: featured items first, then by score */
        if (b.score !== a.score) return b.score - a.score;
        return (b.item.isFeatured ? 1 : 0) - (a.item.isFeatured ? 1 : 0);
      })
      .slice(0, limit)
      .map(r => r.item);

    _toCache(cKey, scored);
    return scored;
  }

  /* ── Remote search fallback ─────────────────────────────── */
  function registerFirestoreSearch(fn) { _remoteFn = fn; }

  async function search(query, opts = {}) {
    const q = (query || "").trim();
    if (!q || q.length < 2) return { local: [], remote: [], merged: [], source: "none" };

    const cKey   = _cKey(q, opts);
    const cached = _fromCache(cKey);
    if (cached) return { ...cached, source: "cache" };

    const local = searchLocal(q, opts);

    if (!_remoteFn || !navigator.onLine) {
      const result = { local, remote: [], merged: local };
      _toCache(cKey, result);
      return { ...result, source: "local" };
    }

    try {
      const remote = await _remoteFn(q, opts);
      const seen   = new Set(local.map(i => i.id));
      const merged = [...local, ...remote.filter(i => !seen.has(i.id))].slice(0, MAX_RESULTS);
      const result = { local, remote, merged };
      _toCache(cKey, result);
      return { ...result, source: "hybrid" };
    } catch {
      const result = { local, remote: [], merged: local };
      return { ...result, source: "local" };
    }
  }

  /* ── Debounce ───────────────────────────────────────────── */
  function debounce(query, opts, callback) {
    clearTimeout(_timer);
    if (!query || query.trim().length < 2) {
      callback({ local: [], remote: [], merged: [], source: "none" });
      return;
    }
    _timer = setTimeout(async () => {
      try {
        const results = await search(query, opts);
        callback(results);
      } catch {
        callback({ local: [], remote: [], merged: [], source: "error" });
      }
    }, DEBOUNCE_MS);
  }

  /* ── Autocomplete suggestions ───────────────────────────── */
  function getSuggestions(query, limit = 8) {
    const q = (query || "").trim().toLowerCase();
    if (!q) return [];

    const seen  = new Set();
    const out   = [];
    const pool  = searchLocal(q, { limit: limit * 3, minScore: 40 });

    for (const item of pool) {
      const label = item.name || item.title || "";
      if (label && !seen.has(label.toLowerCase())) {
        seen.add(label.toLowerCase());
        out.push(label);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /* ── Multi-field query (AND logic across space-separated terms) ── */
  function searchMultiTerm(query, opts = {}) {
    const terms = (query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];

    const { hub, category, limit = MAX_RESULTS } = opts;
    let pool = _index;
    if (hub)      pool = pool.filter(i => (i.hub      || "").toLowerCase() === hub.toLowerCase());
    if (category) pool = pool.filter(i => (i.category || "").toLowerCase() === category.toLowerCase());

    return pool
      .filter(item => terms.every(t => item._txt.includes(t)))
      .slice(0, limit);
  }

  function clearCache() { _cache.clear(); }
  function getIndexSize() { return _index.length; }

  return {
    indexItems,
    appendItems,
    searchLocal,
    searchMultiTerm,
    search,
    debounce,
    getSuggestions,
    registerFirestoreSearch,
    clearCache,
    getIndexSize,
  };
})();

if (typeof module !== "undefined") module.exports = SokoniSearch;
