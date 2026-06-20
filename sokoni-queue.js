/**
 * SOKONI Queue Engine v1.0
 * Phase 3: Persistent write queue backed by IndexedDB.
 * Handles offline writes (product uploads, bookings, reviews) with
 * priority lanes and automatic exponential-backoff retry on reconnect.
 */
const SokoniQueue = (function () {
  "use strict";

  const DB_NAME  = "sokoni_queue_v1";
  const STORE    = "pending";
  const VERSION  = 1;

  const PRIORITY = Object.freeze({ CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 });

  let _db    = null;
  let _busy  = false;
  let _timer = null;

  /* ── IndexedDB ──────────────────────────────────────────── */
  function _open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = e => {
        const db    = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          s.createIndex("priority", "priority");
          s.createIndex("status",   "status");
          s.createIndex("next",     "nextAt");
        }
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  function _tx(mode, fn) {
    return _open().then(db => {
      return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        try { result = fn(store); }
        catch (err) { reject(err); return; }
        if (result instanceof IDBRequest) {
          result.onsuccess = e => resolve(e.target.result);
          result.onerror   = e => reject(e.target.error);
        } else {
          tx.oncomplete = () => resolve(result);
          tx.onerror    = e  => reject(e.target.error);
        }
      });
    });
  }

  /* ── Handlers registry ──────────────────────────────────── */
  const _handlers = {};

  function register(operation, handlerFn) {
    _handlers[operation] = handlerFn;
  }

  /* ── Public: enqueue ─────────────────────────────────────── */
  async function enqueue(operation, data, opts = {}) {
    const item = {
      operation,
      data,
      priority:   typeof opts.priority === "number" ? opts.priority : PRIORITY.MEDIUM,
      status:     "pending",
      retries:    0,
      maxRetries: opts.maxRetries || 4,
      createdAt:  Date.now(),
      nextAt:     Date.now(),
      idemKey:    opts.idemKey || null,
    };

    /* Idempotency: skip if same idemKey already queued */
    if (opts.idemKey) {
      const existing = await _findByIdem(opts.idemKey);
      if (existing) return existing;
    }

    const id = await _tx("readwrite", s => s.add(item));
    _schedule(100);
    return id;
  }

  async function _findByIdem(key) {
    return _open().then(db => new Promise((resolve, reject) => {
      const store = db.transaction(STORE, "readonly").objectStore(STORE);
      const all   = [];
      store.openCursor().onsuccess = e => {
        const c = e.target.result;
        if (c) {
          if (c.value.idemKey === key && c.value.status !== "failed") all.push(c.value.id);
          c.continue();
        } else {
          resolve(all[0] || null);
        }
      };
    }));
  }

  /* ── Drain loop ─────────────────────────────────────────── */
  async function _drain() {
    if (_busy || !navigator.onLine) return;
    _busy = true;
    try {
      const items = await _getPending(12);
      for (const item of items) {
        await _setStatus(item.id, "processing");
        const handler = _handlers[item.operation];
        if (!handler) { await _delete(item.id); continue; }

        try {
          await handler(item.data, { id: item.id, retries: item.retries, idemKey: item.idemKey });
          await _delete(item.id);
        } catch (err) {
          const retries = item.retries + 1;
          if (retries > item.maxRetries) {
            await _update(item.id, { status: "failed", retries, error: String(err.message).slice(0, 300) });
          } else {
            const delay = Math.min(800 * Math.pow(2, retries) + Math.random() * 300, 120000);
            await _update(item.id, { status: "pending", retries, nextAt: Date.now() + delay });
          }
        }
      }
    } finally {
      _busy = false;
    }
  }

  async function _getPending(limit) {
    return _open().then(db => new Promise((resolve, reject) => {
      const now  = Date.now();
      const rows = [];
      db.transaction(STORE, "readonly")
        .objectStore(STORE)
        .index("priority")
        .openCursor()
        .onsuccess = e => {
          const c = e.target.result;
          if (c && rows.length < limit) {
            const v = c.value;
            if ((v.status === "pending") && v.nextAt <= now) rows.push(v);
            c.continue();
          } else {
            resolve(rows.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt));
          }
        };
    }));
  }

  function _update(id, fields) {
    return _open().then(db => new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const get   = store.get(id);
      get.onsuccess = e => {
        const item = e.target.result;
        if (!item) { resolve(); return; }
        Object.assign(item, fields);
        const put = store.put(item);
        put.onsuccess = () => resolve();
        put.onerror   = e => reject(e.target.error);
      };
      get.onerror = e => reject(e.target.error);
    }));
  }

  function _setStatus(id, status) { return _update(id, { status }); }

  function _delete(id) {
    return _open().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    }));
  }

  function _schedule(delay = 250) {
    clearTimeout(_timer);
    _timer = setTimeout(_drain, delay);
  }

  /* ── Stats / maintenance ────────────────────────────────── */
  async function getStats() {
    return _open().then(db => new Promise((resolve, reject) => {
      const counts = { pending: 0, processing: 0, failed: 0, total: 0 };
      db.transaction(STORE, "readonly")
        .objectStore(STORE)
        .openCursor()
        .onsuccess = e => {
          const c = e.target.result;
          if (c) {
            counts[c.value.status] = (counts[c.value.status] || 0) + 1;
            counts.total++;
            c.continue();
          } else {
            resolve(counts);
          }
        };
    }));
  }

  async function clearFailed() {
    return _open().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readwrite")
        .objectStore(STORE)
        .index("status")
        .openCursor(IDBKeyRange.only("failed"));
      req.onsuccess = e => {
        const c = e.target.result;
        if (c) { c.delete(); c.continue(); }
        else resolve();
      };
      req.onerror = e => reject(e.target.error);
    }));
  }

  async function retryFailed() {
    return _open().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readwrite")
        .objectStore(STORE)
        .index("status")
        .openCursor(IDBKeyRange.only("failed"));
      let count = 0;
      req.onsuccess = e => {
        const c = e.target.result;
        if (c) {
          const item    = c.value;
          item.status   = "pending";
          item.retries  = 0;
          item.nextAt   = Date.now();
          c.update(item);
          count++;
          c.continue();
        } else {
          resolve(count);
          _schedule(200);
        }
      };
      req.onerror = e => reject(e.target.error);
    }));
  }

  /* ── Network listeners ──────────────────────────────────── */
  window.addEventListener("online",  () => _schedule(600));
  document.addEventListener("DOMContentLoaded", () => _schedule(3000));

  return { PRIORITY, enqueue, register, drain: _drain, getStats, clearFailed, retryFailed };
})();

if (typeof module !== "undefined") module.exports = SokoniQueue;
