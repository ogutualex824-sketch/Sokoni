/**
 * SOKONI Cache Engine v1.0
 * Phase 6: Multi-layer read cache.
 *   L1 — In-memory Map        (instant,   ≤500 entries,  cleared on refresh)
 *   L2 — SessionStorage       (5 min TTL, same-tab,       cleared on tab close)
 *   L3 — IndexedDB            (custom TTL, cross-tab,     persistent)
 *
 * Usage:
 *   await SokoniCache.set("products:list", data, { ttlSeconds: 300 });
 *   const data = await SokoniCache.get("products:list");
 *   await SokoniCache.getOrFetch("user:123", () => fetchUser("123"), { ttlSeconds: 600 });
 *   SokoniCache.invalidate("products:");  // bust all product keys
 */
const SokoniCache = (function () {
  "use strict";

  /* ── L1: Memory ─────────────────────────────────────────── */
  const _l1    = new Map();
  const L1_MAX = 500;

  function _l1Set(key, value, ttlMs) {
    if (_l1.size >= L1_MAX) {
      _l1.delete(_l1.keys().next().value); // evict oldest (insertion order)
    }
    _l1.set(key, { v: value, e: Date.now() + ttlMs });
  }

  function _l1Get(key) {
    const entry = _l1.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.e) { _l1.delete(key); return undefined; }
    return entry.v;
  }

  function _l1Del(key)    { _l1.delete(key); }
  function _l1Keys()      { return [..._l1.keys()]; }

  /* ── L2: SessionStorage ─────────────────────────────────── */
  const L2_PFX = "sk_c_";

  function _l2Set(key, value, ttlMs) {
    try {
      sessionStorage.setItem(L2_PFX + key, JSON.stringify({ v: value, e: Date.now() + ttlMs }));
    } catch {} // quota exceeded — silently skip
  }

  function _l2Get(key) {
    try {
      const raw = sessionStorage.getItem(L2_PFX + key);
      if (!raw) return undefined;
      const { v, e } = JSON.parse(raw);
      if (Date.now() > e) { sessionStorage.removeItem(L2_PFX + key); return undefined; }
      return v;
    } catch { return undefined; }
  }

  function _l2Del(key) {
    try { sessionStorage.removeItem(L2_PFX + key); } catch {}
  }

  function _l2Keys() {
    const out = [];
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(L2_PFX)) out.push(k.slice(L2_PFX.length));
      }
    } catch {}
    return out;
  }

  /* ── L3: IndexedDB ──────────────────────────────────────── */
  const L3_DB    = "sokoni_cache_v1";
  const L3_STORE = "entries";
  let _l3db      = null;

  function _openL3() {
    if (_l3db) return Promise.resolve(_l3db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(L3_DB, 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(L3_STORE)) {
          const s = db.createObjectStore(L3_STORE, { keyPath: "key" });
          s.createIndex("expires", "expires");
        }
      };
      req.onsuccess = e => { _l3db = e.target.result; resolve(_l3db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function _l3Set(key, value, ttlMs) {
    const db = await _openL3().catch(() => null);
    if (!db) return;
    return new Promise(resolve => {
      const tx = db.transaction(L3_STORE, "readwrite");
      tx.objectStore(L3_STORE).put({ key, value, expires: Date.now() + ttlMs });
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    });
  }

  async function _l3Get(key) {
    const db = await _openL3().catch(() => null);
    if (!db) return undefined;
    return new Promise(resolve => {
      const req = db.transaction(L3_STORE, "readonly").objectStore(L3_STORE).get(key);
      req.onsuccess = e => {
        const entry = e.target.result;
        if (!entry || Date.now() > entry.expires) { resolve(undefined); return; }
        resolve(entry.value);
      };
      req.onerror = () => resolve(undefined);
    });
  }

  async function _l3Del(key) {
    const db = await _openL3().catch(() => null);
    if (!db) return;
    return new Promise(resolve => {
      const tx = db.transaction(L3_STORE, "readwrite");
      tx.objectStore(L3_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    });
  }

  async function _l3KeysWithPrefix(prefix) {
    const db = await _openL3().catch(() => null);
    if (!db) return [];
    return new Promise(resolve => {
      const keys = [];
      db.transaction(L3_STORE, "readonly")
        .objectStore(L3_STORE)
        .openCursor()
        .onsuccess = e => {
          const c = e.target.result;
          if (c) { if (c.value.key.startsWith(prefix)) keys.push(c.value.key); c.continue(); }
          else resolve(keys);
        };
    });
  }

  /* ── Public API ─────────────────────────────────────────── */
  async function set(key, value, opts = {}) {
    const ttlMs = (opts.ttlSeconds || 300) * 1000;
    const tier  = opts.tier || "all";

    if (tier === "l1"  || tier === "all") _l1Set(key, value, ttlMs);
    if (tier === "l2"  || tier === "all") _l2Set(key, value, ttlMs);
    if (tier === "l3"  || tier === "all") await _l3Set(key, value, ttlMs);
  }

  async function get(key, opts = {}) {
    const tier = opts.tier || "all";

    if (tier === "l1" || tier === "all") {
      const v = _l1Get(key);
      if (v !== undefined) return v;
    }
    if (tier === "l2" || tier === "all") {
      const v = _l2Get(key);
      if (v !== undefined) {
        _l1Set(key, v, 5 * 60 * 1000); // promote to L1
        return v;
      }
    }
    if (tier === "l3" || tier === "all") {
      const v = await _l3Get(key);
      if (v !== undefined) {
        _l1Set(key, v, 5 * 60 * 1000); // promote
        _l2Set(key, v, 5 * 60 * 1000);
        return v;
      }
    }
    return undefined;
  }

  async function del(key) {
    _l1Del(key);
    _l2Del(key);
    await _l3Del(key);
  }

  /**
   * getOrFetch — cache-aside pattern.
   * Returns cached value if present; otherwise calls fetchFn(), caches and returns result.
   */
  async function getOrFetch(key, fetchFn, opts = {}) {
    const hit = await get(key, opts);
    if (hit !== undefined) return hit;

    const fresh = await fetchFn();
    if (fresh !== null && fresh !== undefined) {
      await set(key, fresh, opts);
    }
    return fresh;
  }

  /**
   * invalidate — bust all cache layers for keys starting with `prefix`.
   */
  async function invalidate(prefix) {
    // L1
    for (const k of _l1Keys()) {
      if (k.startsWith(prefix)) _l1Del(k);
    }
    // L2
    for (const k of _l2Keys()) {
      if (k.startsWith(prefix)) _l2Del(k);
    }
    // L3 (async, best-effort)
    _l3KeysWithPrefix(prefix).then(keys => keys.forEach(_l3Del)).catch(() => {});
  }

  /* ── Periodic L3 expiry sweep ───────────────────────────── */
  async function cleanup() {
    const db = await _openL3().catch(() => null);
    if (!db) return;
    return new Promise(resolve => {
      const now = Date.now();
      const tx  = db.transaction(L3_STORE, "readwrite");
      tx.objectStore(L3_STORE)
        .index("expires")
        .openCursor(IDBKeyRange.upperBound(now))
        .onsuccess = e => {
          const c = e.target.result;
          if (c) { c.delete(); c.continue(); }
        };
      tx.oncomplete = resolve;
    });
  }

  setInterval(cleanup, 60 * 60 * 1000); // sweep once per hour

  return { set, get, del, getOrFetch, invalidate, cleanup };
})();

if (typeof module !== "undefined") module.exports = SokoniCache;
