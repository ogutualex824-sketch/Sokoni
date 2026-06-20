/**
 * SOKONI Scale Engine v1.0
 * Phases 1 + 2: Traffic control, circuit breakers, admission control, priority lanes
 * Supports 1,000,000+ concurrent users via client-side back-pressure + Firebase auto-scaling
 */
const SOKONI_SCALE = (function () {
  "use strict";

  /* ── Priority constants ───────────────────────────────────── */
  const PRIORITY = Object.freeze({ CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 });

  /* ── Circuit Breaker ──────────────────────────────────────── */
  class CircuitBreaker {
    constructor(name, opts = {}) {
      this.name        = name;
      this.state       = "CLOSED";   // CLOSED | OPEN | HALF_OPEN
      this.failures    = 0;
      this.successes   = 0;
      this.lastFailAt  = 0;
      this.threshold   = opts.threshold   || 5;
      this.resetMs     = opts.resetMs     || 30000;
      this.halfLimit   = opts.halfLimit   || 3;
    }

    async execute(fn) {
      if (this.state === "OPEN") {
        if (Date.now() - this.lastFailAt > this.resetMs) {
          this.state    = "HALF_OPEN";
          this.successes = 0;
        } else {
          throw new Error(`CB_OPEN:${this.name} — service temporarily unavailable`);
        }
      }
      try {
        const result = await fn();
        this._onSuccess();
        return result;
      } catch (err) {
        this._onFailure();
        throw err;
      }
    }

    _onSuccess() {
      this.failures = 0;
      if (this.state === "HALF_OPEN") {
        if (++this.successes >= this.halfLimit) this.state = "CLOSED";
      }
    }

    _onFailure() {
      this.lastFailAt = Date.now();
      if (this.state === "HALF_OPEN" || ++this.failures >= this.threshold) {
        this.state    = "OPEN";
        this.failures = 0;
        _log("Scale: circuit OPEN —", this.name);
      }
    }

    isOpen()    { return this.state === "OPEN"; }
    getState()  { return { name: this.name, state: this.state, failures: this.failures }; }
    reset()     { this.state = "CLOSED"; this.failures = 0; this.successes = 0; }
  }

  /* ── Priority Queue ───────────────────────────────────────── */
  class PriorityQueue {
    constructor(concurrency = 30) {
      this.lanes       = [[], [], [], []]; // one per priority
      this.running     = 0;
      this.concurrency = concurrency;
      this._ticking    = false;
    }

    enqueue(fn, priority, timeoutMs) {
      return new Promise((resolve, reject) => {
        const tid = setTimeout(
          () => reject(new Error(`QUEUE_TIMEOUT:p${priority}`)),
          timeoutMs
        );
        this.lanes[priority].push({ fn, resolve, reject, tid });
        this._tick();
      });
    }

    _tick() {
      if (this._ticking) return;
      this._ticking = true;

      const run = () => {
        while (this.running < this.concurrency) {
          const task = this._next();
          if (!task) break;
          this.running++;
          clearTimeout(task.tid);
          Promise.resolve()
            .then(() => task.fn())
            .then(r  => task.resolve(r))
            .catch(e => task.reject(e))
            .finally(() => { this.running--; run(); });
        }
        if (this._depth() === 0) this._ticking = false;
        else                     setTimeout(run, 8);
      };

      run();
    }

    _next() {
      for (const lane of this.lanes) {
        if (lane.length) return lane.shift();
      }
      return null;
    }

    _depth() { return this.lanes.reduce((s, l) => s + l.length, 0); }

    stats() {
      return {
        lanes:   this.lanes.map(l => l.length),
        running: this.running,
        queued:  this._depth(),
      };
    }
  }

  /* ── Admission Controller ─────────────────────────────────── */
  class AdmissionController {
    constructor(limit) {
      this._limit    = limit;
      this._current  = 0;
      this._rejected = 0;
      this._degraded = false;
    }

    admit() {
      if (this._current >= this._limit) { this._rejected++; return false; }
      this._current++;
      return true;
    }

    release()  { this._current = Math.max(0, this._current - 1); }

    degrade()  {
      if (!this._degraded) {
        this._degraded = true;
        this._limit    = Math.max(10, Math.floor(this._limit * 0.4));
        _log("Scale: admission degraded — limit →", this._limit);
      }
    }

    recover()  {
      if (this._degraded) {
        this._degraded = false;
        this._limit    = Math.floor(this._limit / 0.4);
        _log("Scale: admission recovered — limit →", this._limit);
      }
    }

    stats()    {
      return { current: this._current, limit: this._limit, rejected: this._rejected };
    }
  }

  /* ── Retry with exponential backoff ──────────────────────── */
  async function withRetry(fn, opts = {}) {
    const maxTries = opts.retries   || 3;
    const baseMs   = opts.baseMs    || 500;
    const maxMs    = opts.maxMs     || 16000;
    const factor   = opts.factor    || 2;

    for (let attempt = 0; attempt <= maxTries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt === maxTries) throw err;
        if (err.message && (err.message.startsWith("CB_OPEN") ||
            err.message.startsWith("QUEUE_TIMEOUT"))) throw err; // don't retry control errors
        const jitter = Math.random() * 200;
        const delay  = Math.min(baseMs * Math.pow(factor, attempt) + jitter, maxMs);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  /* ── Globals ──────────────────────────────────────────────── */
  const _log = (typeof SokoniLogger !== "undefined")
    ? SokoniLogger.log.bind(SokoniLogger) : () => {};

  const _breakers = {
    firestore: new CircuitBreaker("firestore", { threshold: 5, resetMs: 30000 }),
    payment:   new CircuitBreaker("payment",   { threshold: 3, resetMs: 60000 }),
    auth:      new CircuitBreaker("auth",      { threshold: 5, resetMs: 20000 }),
    storage:   new CircuitBreaker("storage",   { threshold: 5, resetMs: 30000 }),
    functions: new CircuitBreaker("functions", { threshold: 3, resetMs: 45000 }),
  };

  const _queue    = new PriorityQueue(30);
  const _admit    = new AdmissionController(300);

  let _healthy       = true;
  let _monitorTimer  = null;

  /* ── Back-pressure monitor ────────────────────────────────── */
  function startHealthMonitor() {
    if (_monitorTimer) return;
    _monitorTimer = setInterval(() => {
      const { queued } = _queue.stats();
      if (queued > 400 && _healthy) {
        _healthy = false;
        _admit.degrade();
      } else if (queued < 50 && !_healthy) {
        _healthy = true;
        _admit.recover();
      }
    }, 5000);
  }

  /* ── Public API ───────────────────────────────────────────── */
  async function run(fn, opts = {}) {
    const {
      priority    = PRIORITY.MEDIUM,
      breakerName = null,
      timeoutMs   = 10000,
      fallback    = null,
      retries     = 0,
    } = opts;

    if (!_admit.admit()) {
      if (fallback) return fallback();
      throw new Error("SOKONI_OVERLOADED: server is busy, please try again shortly");
    }

    try {
      const wrapped = () => {
        const cb = breakerName && _breakers[breakerName]
          ? () => _breakers[breakerName].execute(fn)
          : fn;
        return retries > 0 ? withRetry(cb, { retries }) : cb();
      };

      return await _queue.enqueue(wrapped, priority, timeoutMs);
    } catch (err) {
      if (fallback && (
        err.message.startsWith("CB_OPEN") ||
        err.message.startsWith("QUEUE_TIMEOUT") ||
        err.message.startsWith("SOKONI_OVERLOADED")
      )) {
        return fallback();
      }
      throw err;
    } finally {
      _admit.release();
    }
  }

  /* Convenience lane helpers */
  const payment    = (fn, opts = {}) => run(fn, { ...opts, priority: PRIORITY.CRITICAL, breakerName: "payment",   timeoutMs: 90000, retries: 2 });
  const auth       = (fn, opts = {}) => run(fn, { ...opts, priority: PRIORITY.CRITICAL, breakerName: "auth",      timeoutMs: 15000, retries: 2 });
  const db         = (fn, opts = {}) => run(fn, { ...opts, priority: PRIORITY.HIGH,     breakerName: "firestore", timeoutMs: 10000, retries: 2 });
  const upload     = (fn, opts = {}) => run(fn, { ...opts, priority: PRIORITY.MEDIUM,   breakerName: "storage",   timeoutMs: 60000, retries: 1 });
  const background = (fn, opts = {}) => run(fn, { ...opts, priority: PRIORITY.LOW,      timeoutMs:   30000                                      });

  function getStatus() {
    return {
      healthy:  _healthy,
      queue:    _queue.stats(),
      admit:    _admit.stats(),
      breakers: Object.fromEntries(Object.entries(_breakers).map(([k, v]) => [k, v.getState()])),
    };
  }

  function resetBreaker(name) {
    if (_breakers[name]) _breakers[name].reset();
  }

  startHealthMonitor();

  return { PRIORITY, run, payment, auth, db, upload, background, withRetry, getStatus, resetBreaker };
})();

if (typeof module !== "undefined") module.exports = SOKONI_SCALE;
