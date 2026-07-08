/* ================================================================
   SOKONI Resilience SDK  v1.0.0  |  2026-07-08
   sokoni-resilience.js

   Client-side resilience patterns for the SOKONI super-platform.
   Exposes a single global: window.SokoniResilience

   Modules
   ───────
     Circuit Breaker     — CLOSED → OPEN → HALF_OPEN; sessionStorage
     Retry               — exponential backoff + jitter; SokoniObservability
     Timeout             — promise race wrapper
     Graceful Degrade    — withFallback(primary, fallback, { timeout })
     Offline Queue       — IndexedDB; priority flush; auto-online
     Rate Limiter        — token bucket; per-key; sessionStorage

   Usage examples
   ──────────────
     const cb = SokoniResilience.circuitBreaker('intasend', {
       failureThreshold: 5, successThreshold: 2,
       timeout: 30000, window: 60000
     });
     const data = await cb.execute(() => callPaymentAPI(args));

     await SokoniResilience.retry(fn, { maxAttempts: 3, baseDelay: 500 });

     await SokoniResilience.withFallback(
       () => callSearchCF({ q }),
       () => localFuzzySearch(allProducts, q),
       { timeout: 3000 }
     );

     await SokoniResilience.timeout(promise, 5000, 'Search timed out');

     SokoniResilience.registerHandler('submitOrder', async args => { ... });
     await SokoniResilience.enqueue({
       id: 'order-123', fn: 'submitOrder', args: { orderId },
       priority: 'HIGH', maxAge: 300000
     });

     const limiter = SokoniResilience.rateLimiter({ rpm: 30 });
     if (!limiter.allow('search')) { showToast('Slow down'); return; }
================================================================ */

(function (global) {
  'use strict';

  /* ── Version ─────────────────────────────────────────────────── */
  const VERSION = '1.0.0';

  /* ── Storage keys ────────────────────────────────────────────── */
  const SS_CB_PREFIX = '_sokoniCB:';       // sessionStorage circuit breakers
  const SS_RL_PREFIX = '_sokoniRL:';       // sessionStorage rate limiters
  const IDB_DB_NAME  = '_sokoniOfflineQueue';
  const IDB_STORE    = 'tasks';
  const MAX_QUEUE    = 100;

  /* ── Priority sort order (lower = higher priority) ───────────── */
  const PRIORITY_RANK = Object.freeze({ HIGH: 0, NORMAL: 1, LOW: 2 });

  /* ── SokoniObservability bridge ──────────────────────────────── */
  function _obs() { return global.SokoniObservability || null; }

  // [RES-1] Use trackEvent (the actual SDK API); o.counter/o.histogram do not exist.
  function _count(name, val, tags) {
    try {
      const o = _obs();
      if (o && typeof o.trackEvent === 'function') {
        o.trackEvent(name, Object.assign({ value: val != null ? val : 1 }, tags || {}));
      }
    } catch (_) {}
  }
  function _hist(name, val, tags) {
    try {
      const o = _obs();
      if (o && typeof o.trackEvent === 'function') {
        o.trackEvent(name, Object.assign({ value: val }, tags || {}));
      }
    } catch (_) {}
  }

  // [RES-3] trackError expects a string message, not a raw Error object.
  // Fall back to log.error if trackError is somehow absent.
  function _trackErr(err) {
    try {
      const o = _obs();
      if (o && typeof o.trackError === 'function') {
        o.trackError(err && err.message ? err.message : String(err), { stack: err && err.stack });
      } else if (o && o.log && typeof o.log.error === 'function') {
        o.log.error(err && err.message ? err.message : String(err));
      }
    } catch (_) {}
  }

  /* ── Structured logger ───────────────────────────────────────── */
  const _log = {
    info:  (...a) => console.info( '[SokoniResilience]', ...a),
    warn:  (...a) => console.warn( '[SokoniResilience]', ...a),
    error: (...a) => console.error('[SokoniResilience]', ...a),
  };

  /* ── Utilities ───────────────────────────────────────────────── */
  function _now()  { return Date.now(); }
  function _sleep(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms))); }
  function _uid()  { return 'q' + _now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function _ssGet(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (_) { return null; } }
  function _ssSet(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* quota */ } }

  /* ================================================================
     CUSTOM ERRORS
  ================================================================ */
  class CircuitOpenError extends Error {
    constructor(name, state) {
      super(`Circuit '${name}' is ${state} — request rejected without calling the function.`);
      this.name         = 'CircuitOpenError';
      this.circuitName  = name;
      this.circuitState = state;
    }
  }

  class TimeoutError extends Error {
    constructor(msg) {
      super(msg || 'Operation timed out.');
      this.name = 'TimeoutError';
    }
  }

  class RateLimitError extends Error {
    constructor(key) {
      super(`Rate limit exceeded for key '${key}'.`);
      this.name = 'RateLimitError';
      this.key  = key;
    }
  }

  /* ================================================================
     CIRCUIT BREAKER
     ────────────────
     State machine: CLOSED → OPEN → HALF_OPEN → CLOSED
     Persisted to sessionStorage so it survives page reloads in the
     same browser tab.  Multiple calls with the same name share one
     instance (registry pattern).
  ================================================================ */
  const _breakers = new Map();

  class CircuitBreaker {
    /**
     * @param {string} name                    — unique service name (e.g. 'intasend')
     * @param {object} opts
     * @param {number} opts.failureThreshold   — open after N failures in window  (def 5)
     * @param {number} opts.successThreshold   — close after N successes in half-open (def 2)
     * @param {number} opts.timeout            — ms before OPEN → HALF_OPEN  (def 30 000)
     * @param {number} opts.window             — rolling failure-count window ms  (def 60 000)
     */
    constructor(name, opts = {}) {
      this.name             = name;
      this.failureThreshold = opts.failureThreshold || 5;
      this.successThreshold = opts.successThreshold || 2;
      this.timeout          = opts.timeout          || 30_000;
      this.window           = opts.window           || 60_000;
      this._ssKey           = SS_CB_PREFIX + name;
      this._restore();
    }

    /* ── Session-storage persistence ──────────────────────────── */
    _restore() {
      const s = _ssGet(this._ssKey);
      if (s) {
        this._state      = s.state      || 'CLOSED';
        this._failures   = s.failures   || [];      // timestamps of failures
        this._successes  = s.successes  || 0;
        this._rejections = s.rejections || 0;
        this._lastFail   = s.lastFail   || null;
        this._openedAt   = s.openedAt   || null;
      } else {
        this._initFresh();
      }
    }

    _initFresh() {
      this._state      = 'CLOSED';
      this._failures   = [];
      this._successes  = 0;
      this._rejections = 0;
      this._lastFail   = null;
      this._openedAt   = null;
    }

    _persist() {
      _ssSet(this._ssKey, {
        state: this._state, failures: this._failures,
        successes: this._successes, rejections: this._rejections,
        lastFail: this._lastFail,   openedAt: this._openedAt,
      });
    }

    /* Prune stale failures outside the rolling window. */
    _prune() {
      const cut = _now() - this.window;
      this._failures = this._failures.filter(t => t > cut);
    }

    /* Check whether enough time has passed to probe again. */
    _maybeHalfOpen() {
      if (this._state === 'OPEN' && this._openedAt !== null &&
          _now() - this._openedAt >= this.timeout) {
        this._state     = 'HALF_OPEN';
        this._successes = 0;
        this._persist();
        _log.info(`CB '${this.name}' OPEN → HALF_OPEN`);
        _count('resilience.cb.transition', 1, { name: this.name, to: 'HALF_OPEN' });
      }
    }

    /* ── Public: current state string ─────────────────────────── */
    get state() {
      this._maybeHalfOpen();
      return this._state;
    }

    /* ── Public: stats snapshot ───────────────────────────────── */
    stats() {
      this._prune();
      return {
        state:       this._state,
        failures:    this._failures.length,
        successes:   this._successes,
        rejections:  this._rejections,
        lastFailure: this._lastFail,
      };
    }

    /* ── Execute fn through the circuit ───────────────────────── */
    async execute(fn) {
      this._maybeHalfOpen();

      if (this._state === 'OPEN') {
        this._rejections++;
        this._persist();
        _count('resilience.cb.rejection', 1, { name: this.name });
        throw new CircuitOpenError(this.name, 'OPEN');
      }

      const t0 = _now();
      try {
        const result = await fn();
        this._recordSuccess(_now() - t0);
        return result;
      } catch (err) {
        this._recordFailure(err, _now() - t0);
        throw err;
      }
    }

    _recordSuccess(latencyMs) {
      _hist('resilience.cb.latency_ms', latencyMs, { name: this.name, result: 'success' });

      if (this._state === 'HALF_OPEN') {
        this._successes++;
        if (this._successes >= this.successThreshold) {
          this._state    = 'CLOSED';
          this._failures = [];
          this._openedAt = null;
          _log.info(`CB '${this.name}' HALF_OPEN → CLOSED`);
          _count('resilience.cb.transition', 1, { name: this.name, to: 'CLOSED' });
        }
      }
      this._persist();
    }

    _recordFailure(err, latencyMs) {
      const ts = _now();
      this._failures.push(ts);
      this._lastFail = ts;
      this._prune();

      _hist('resilience.cb.latency_ms', latencyMs, { name: this.name, result: 'failure' });
      _trackErr(err);

      /* Trip on threshold breach OR on any failure while probing (HALF_OPEN). */
      if (this._state === 'HALF_OPEN' || this._failures.length >= this.failureThreshold) {
        this._state     = 'OPEN';
        this._openedAt  = ts;
        this._successes = 0;
        _log.warn(`CB '${this.name}' → OPEN`, { failures: this._failures.length, error: err.message });
        _count('resilience.cb.transition', 1, { name: this.name, to: 'OPEN' });
      }
      this._persist();
    }

    /* ── Manual reset (ops/debug) ─────────────────────────────── */
    reset() {
      this._initFresh();
      this._persist();
      _log.info(`CB '${this.name}' manually reset → CLOSED`);
    }
  }

  /**
   * Get or create a named circuit breaker.
   * Calling twice with the same name returns the same instance.
   *
   * @param   {string}        name
   * @param   {object}        [opts]
   * @returns {CircuitBreaker}
   */
  function circuitBreaker(name, opts) {
    if (!_breakers.has(name)) _breakers.set(name, new CircuitBreaker(name, opts || {}));
    return _breakers.get(name);
  }

  /* ================================================================
     RETRY WITH EXPONENTIAL BACKOFF
     ────────────────────────────────
     Attempt 1: immediate.
     Attempt 2: baseDelay × factor^0 ± jitter.
     Attempt N: min(baseDelay × factor^(N-2), maxDelay) ± jitter.
     Jitter: ±40% of computed delay (full jitter strategy).
  ================================================================ */

  /**
   * Retry an async function with configurable exponential backoff.
   *
   * @param   {Function} fn
   * @param   {object}   opts
   * @param   {number}   opts.maxAttempts  (default 3)
   * @param   {number}   opts.baseDelay    ms (default 500)
   * @param   {number}   opts.maxDelay     ms cap (default 10 000)
   * @param   {number}   opts.factor       (default 2)
   * @param   {boolean}  opts.jitter       ±40% variance (default true)
   * @param   {Function} opts.retryOn      (err) → bool — false = abort early
   * @returns {Promise<any>}
   */
  async function retry(fn, opts = {}) {
    const {
      maxAttempts = 3,
      baseDelay   = 500,
      maxDelay    = 10_000,
      factor      = 2,
      jitter      = true,
      retryOn     = null,
    } = opts;

    let lastErr;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await fn();
        if (attempt > 1) _count('resilience.retry.success', 1, { attempt });
        return result;
      } catch (err) {
        lastErr = err;
        if (attempt === maxAttempts) break;

        /* Caller may abort retrying on certain errors (e.g. 'permission-denied'). */
        if (typeof retryOn === 'function' && !retryOn(err)) {
          _log.info(`Retry aborted by retryOn filter at attempt ${attempt}.`, { error: err.message });
          break;
        }

        /* Compute backoff: base × factor^(attempt−1) capped, then jitter. */
        let delay = Math.min(baseDelay * Math.pow(factor, attempt - 1), maxDelay);
        // [RES-4] True ±30 % jitter: range is [70 %…130 %] of base delay.
        if (jitter) delay = delay * (0.7 + Math.random() * 0.6);
        delay = Math.round(delay);

        _log.info(`Retry ${attempt}/${maxAttempts} — waiting ${delay} ms.`, { error: err.message });
        _count('resilience.retry.attempt', 1, { attempt, maxAttempts });
        _hist('resilience.retry.delay_ms', delay, { attempt });

        await _sleep(delay);
      }
    }

    _count('resilience.retry.exhausted', 1, { maxAttempts });
    throw lastErr;
  }

  /* ================================================================
     TIMEOUT WRAPPER
  ================================================================ */

  /**
   * Race a promise against a wall-clock timeout.
   *
   * @param   {Promise|any}  promise
   * @param   {number}       ms       timeout in milliseconds
   * @param   {string}       [msg]    optional error message
   * @returns {Promise<any>}
   * @throws  {TimeoutError} if the timeout fires first
   */
  function timeout(promise, ms, msg) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        _count('resilience.timeout.fired', 1, { ms });
        reject(new TimeoutError(msg || `Operation timed out after ${ms} ms.`));
      }, ms);

      Promise.resolve(promise).then(
        v  => { clearTimeout(timer); resolve(v); },
        e  => { clearTimeout(timer); reject(e); }
      );
    });
  }

  /* ================================================================
     GRACEFUL DEGRADATION
     ─────────────────────
     Try the primary path inside a time budget; on timeout or error
     silently switch to the fallback path.
  ================================================================ */

  /**
   * @param   {Function|Promise} primary   preferred path
   * @param   {Function|Promise} fallback  degraded path
   * @param   {object}           [opts]
   * @param   {number}           [opts.timeout=5000] ms
   * @returns {Promise<any>}
   */
  async function withFallback(primary, fallback, opts = {}) {
    const ms = opts.timeout || 5_000;

    try {
      return await timeout(
        typeof primary === 'function' ? primary() : primary,
        ms
      );
    } catch (primaryErr) {
      const isTimeout = primaryErr instanceof TimeoutError;
      _log.warn('Primary path failed — using fallback.',
        { reason: primaryErr.message, isTimeout });
      _count('resilience.degradation', 1, { reason: isTimeout ? 'timeout' : 'error' });

      try {
        return await (typeof fallback === 'function' ? fallback() : fallback);
      } catch (fallbackErr) {
        _log.error('Fallback path also failed.', { error: fallbackErr.message });
        _count('resilience.degradation.fallback_failed', 1, {});
        _trackErr(fallbackErr);
        throw fallbackErr;
      }
    }
  }

  /* ================================================================
     RATE LIMITER  (token bucket, per-key, sessionStorage)
     ──────────────
     Tokens refill continuously at `rpm` tokens per minute.
     Each `allow(key)` call consumes one token if available.
     State is persisted to sessionStorage so limits survive navigations
     within the same tab.
  ================================================================ */

  /**
   * Create a rate limiter.
   *
   * @param   {object} opts
   * @param   {number} opts.rpm  requests per minute (default 60)
   * @returns {{ allow(key: string): boolean }}
   */
  function rateLimiter(opts = {}) {
    const rpm    = Math.max(1, opts.rpm || 60);
    // [RES-2] Incorporate a caller-supplied name so limiters with the same rpm
    // do not share bucket state in sessionStorage.
    const name   = opts.name || 'default';
    const ssKey  = SS_RL_PREFIX + name + '_' + rpm;
    let buckets  = {};

    /* Restore from sessionStorage. */
    try { buckets = JSON.parse(sessionStorage.getItem(ssKey)) || {}; } catch (_) {}

    function _save() {
      try { sessionStorage.setItem(ssKey, JSON.stringify(buckets)); } catch (_) {}
    }

    return {
      /**
       * Check and consume one token for the given key.
       * Returns true if allowed; false if rate-limited.
       *
       * @param   {string} key  e.g. 'search' | 'checkout'
       * @returns {boolean}
       */
      allow(key) {
        const now     = _now();
        const winMs   = 60_000;

        if (!buckets[key]) buckets[key] = { tokens: rpm, lastRefill: now };

        const b = buckets[key];

        /* Continuous refill: proportional to elapsed time. */
        const elapsed = now - b.lastRefill;
        b.tokens      = Math.min(rpm, b.tokens + (elapsed / winMs) * rpm);
        b.lastRefill  = now;

        if (b.tokens >= 1) {
          b.tokens -= 1;
          _save();
          return true;
        }

        _save();
        _count('resilience.ratelimit.rejected', 1, { key, rpm });
        return false;
      },
    };
  }

  /* ================================================================
     OFFLINE QUEUE  (IndexedDB)
     ───────────────────────────
     Tasks are persisted in IndexedDB under '_sokoniOfflineQueue'.
     On `navigator.onLine` → true the queue auto-flushes.
     HIGH priority tasks are flushed first.
     Max 100 tasks; if full, the oldest LOW priority task is evicted.
     Handlers are registered in-memory with `registerHandler()`.
  ================================================================ */
  const _handlers = new Map();
  let   _idb      = null;     // cached IDBDatabase
  let   _flushing = false;    // flush guard

  /* Open (or reuse) the IndexedDB database. */
  function _openIDB() {
    if (_idb) return Promise.resolve(_idb);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_DB_NAME, 1);

      req.onupgradeneeded = evt => {
        const db = evt.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          const store = db.createObjectStore(IDB_STORE, { keyPath: 'id' });
          store.createIndex('priority',   'priority',   { unique: false });
          store.createIndex('enqueuedAt', 'enqueuedAt', { unique: false });
        }
      };

      req.onsuccess = evt => { _idb = evt.target.result; resolve(_idb); };
      req.onerror   = evt => reject(evt.target.error);
    });
  }

  /**
   * Add a task to the offline queue.
   * All IDB operations run inside a single readwrite transaction.
   *
   * @param   {object}          task
   * @param   {string}          [task.id]         — auto-generated if omitted
   * @param   {string}          task.fn            — handler key
   * @param   {object}          [task.args]
   * @param   {'HIGH'|'NORMAL'|'LOW'} [task.priority='NORMAL']
   * @param   {number}          [task.maxAge=300000] discard threshold ms
   * @returns {Promise<string|null>}  task ID, or null if queue full
   */
  async function enqueue(task) {
    const db = await _openIDB();

    return new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);

      tx.onerror = () => reject(tx.error);

      const countReq = store.count();
      countReq.onerror = () => reject(countReq.error);

      countReq.onsuccess = () => {
        const count    = countReq.result;
        const priority = ((task.priority || 'NORMAL') + '').toUpperCase();

        function _put() {
          const record = {
            id:         task.id || _uid(),
            fn:         task.fn,
            args:       task.args   || {},
            priority,
            maxAge:     task.maxAge || 300_000,
            enqueuedAt: _now(),
          };

          const putReq = store.put(record);
          putReq.onerror = () => reject(putReq.error);
          // [RES-5] Resolve on tx.oncomplete (durable write) not putReq.onsuccess.
          tx.oncomplete = () => {
            _log.info(`Offline task enqueued [${priority}]: '${record.fn}'`, { id: record.id });
            _count('resilience.queue.enqueued', 1, { priority });
            resolve(record.id);
          };
        }

        if (count < MAX_QUEUE) {
          _put();
          return;
        }

        /* Queue full — evict oldest LOW-priority item, if any. */
        const allReq = store.getAll();
        allReq.onerror = () => reject(allReq.error);
        allReq.onsuccess = () => {
          const lows = allReq.result
            .filter(t => t.priority === 'LOW')
            .sort((a, b) => a.enqueuedAt - b.enqueuedAt);

          if (lows.length === 0) {
            _log.warn('Offline queue full — no LOW items to evict, task dropped.', { fn: task.fn });
            _count('resilience.queue.full_drop', 1, { fn: task.fn, priority });
            resolve(null);
            return;
          }

          const delReq = store.delete(lows[0].id);
          delReq.onerror   = () => reject(delReq.error);
          delReq.onsuccess = () => _put();
        };
      };
    });
  }

  /**
   * Register an async handler for a given fn key.
   * Handlers must be registered before the first flush attempt.
   *
   * @param {string}   name  — must match `task.fn` passed to `enqueue()`
   * @param {Function} fn    — async (args: object) => any
   */
  function registerHandler(name, fn) {
    _handlers.set(name, fn);
    _log.info(`Offline handler registered: '${name}'`);
  }

  /* IDB read helpers (separate transactions from mutation). */
  function _idbReadAll(db) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly')
                    .objectStore(IDB_STORE)
                    .getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  function _idbDelete(db, id) {
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).delete(id);
      // [RES-5] Resolve on tx.oncomplete for write durability, not req.onsuccess.
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
      req.onerror   = () => reject(req.error);
    });
  }

  function _idbDeleteBatch(db, ids) {
    if (!ids.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      ids.forEach(id => store.delete(id));
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  /**
   * Flush all pending offline tasks.
   * HIGH priority tasks execute first.
   * Expired tasks (age > maxAge) are discarded.
   * Called automatically on 'online'; can also be called manually.
   *
   * @returns {Promise<{completed: number, failed: number, skipped: number}>}
   */
  async function flushQueue() {
    if (_flushing)             return { completed: 0, failed: 0, skipped: 0 };
    if (!navigator.onLine)     return { completed: 0, failed: 0, skipped: 0 };
    _flushing = true;

    let completed = 0, failed = 0, skipped = 0;

    try {
      const db   = await _openIDB();
      const all  = await _idbReadAll(db);
      const now  = _now();

      /* Separate expired from runnable. */
      const expired = all.filter(t => now - t.enqueuedAt > t.maxAge);
      const valid   = all.filter(t => now - t.enqueuedAt <= t.maxAge);

      /* Purge expired in one batch. */
      if (expired.length) {
        await _idbDeleteBatch(db, expired.map(t => t.id));
        skipped += expired.length;
        _log.info(`Purged ${expired.length} expired offline tasks.`);
        _count('resilience.queue.expired_purged', expired.length, {});
      }

      /* Sort: HIGH first, then NORMAL, then LOW; ties broken by enqueuedAt (FIFO). */
      valid.sort((a, b) => {
        const pd = (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
        return pd !== 0 ? pd : a.enqueuedAt - b.enqueuedAt;
      });

      for (const task of valid) {
        const handler = _handlers.get(task.fn);

        if (!handler) {
          _log.warn(`No handler for '${task.fn}' — task skipped (not removed).`, { id: task.id });
          skipped++;
          continue;
        }

        try {
          await handler(task.args);
          await _idbDelete(db, task.id);
          completed++;
          _log.info(`Offline task '${task.fn}' completed.`, { id: task.id });
        } catch (err) {
          failed++;
          _log.error(`Offline task '${task.fn}' failed — retained for next flush.`,
            { id: task.id, error: err.message });
          _trackErr(err);
        }
      }

      _count('resilience.queue.flush_completed', completed, {});
      _count('resilience.queue.flush_failed',    failed,    {});
      _hist('resilience.queue.flush_size', valid.length, {});

      const summary = { completed, failed, skipped };
      _log.info('Queue flush complete.', summary);
      return summary;

    } catch (err) {
      _log.error('Queue flush error.', { error: err.message });
      _trackErr(err);
      return { completed, failed, skipped };
    } finally {
      _flushing = false;
    }
  }

  /* Auto-flush when the browser regains connectivity. */
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('online', () => {
      _log.info('Network restored — auto-flushing offline queue.');
      flushQueue();
    });
  }

  /* ================================================================
     PUBLIC API
  ================================================================ */
  const SokoniResilience = Object.freeze({
    version: VERSION,

    /* ── Custom error classes (for instanceof checks) ─────── */
    CircuitOpenError,
    TimeoutError,
    RateLimitError,

    /* ── Circuit Breaker ──────────────────────────────────── */
    /**
     * Get or create a named circuit breaker.
     * @param {string} name
     * @param {object} [opts]
     * @returns {CircuitBreaker}
     */
    circuitBreaker,

    /* ── Retry ────────────────────────────────────────────── */
    /**
     * Retry an async fn with exponential backoff + jitter.
     * @param {Function} fn
     * @param {object} [opts]
     * @returns {Promise<any>}
     */
    retry,

    /* ── Timeout ──────────────────────────────────────────── */
    /**
     * Race a promise against a timeout.
     * @param {Promise|any} promise
     * @param {number} ms
     * @param {string} [msg]
     * @returns {Promise<any>}
     */
    timeout,

    /* ── Graceful Degradation ─────────────────────────────── */
    /**
     * Try primary; fall back to secondary on timeout or error.
     * @param {Function|Promise} primary
     * @param {Function|Promise} fallback
     * @param {object} [opts]
     * @returns {Promise<any>}
     */
    withFallback,

    /* ── Rate Limiter ─────────────────────────────────────── */
    /**
     * Create a token-bucket rate limiter.
     * @param {object} opts  e.g. { rpm: 30 }
     * @returns {{ allow(key): boolean }}
     */
    rateLimiter,

    /* ── Offline Queue ────────────────────────────────────── */
    /**
     * Enqueue a task for offline execution.
     * @param {object} task
     * @returns {Promise<string|null>}
     */
    enqueue,

    /**
     * Register a handler for a fn key.
     * @param {string}   name
     * @param {Function} fn
     */
    registerHandler,

    /**
     * Manually trigger a queue flush.
     * @returns {Promise<{completed, failed, skipped}>}
     */
    flushQueue,

    /* ── Internal utilities (exposed for testing) ─────────── */
    sleep: _sleep,
  });

  global.SokoniResilience = SokoniResilience;

}(typeof window !== 'undefined' ? window
  : typeof globalThis !== 'undefined' ? globalThis
  : this));
