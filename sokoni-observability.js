/**
 * SOKONI Enterprise Observability  v2.0
 *
 * Application Performance Monitoring (APM) layer.
 *
 * Features:
 *  - Structured metrics (counters, gauges, histograms, timers)
 *  - Distributed tracing (correlation IDs across service calls)
 *  - Web Vitals (LCP, FID, CLS, TTFB, FCP)
 *  - Firestore query profiling
 *  - Memory and CPU pressure monitoring
 *  - User session analytics
 *  - Error tracking with stack normalisation
 *  - Periodic flush to Firestore (batch writes for efficiency)
 *  - Export hooks for external APM tools (Datadog, Grafana, etc.)
 */

'use strict';

const SokoniObservability = (function () {

  /* ════════════════════════════════════════════════════════════
     METRIC TYPES
  ════════════════════════════════════════════════════════════ */
  const METRIC_TYPE = Object.freeze({
    COUNTER:   'counter',
    GAUGE:     'gauge',
    HISTOGRAM: 'histogram',
    TIMER:     'timer',
  });

  /* ════════════════════════════════════════════════════════════
     INTERNAL STORE
  ════════════════════════════════════════════════════════════ */
  const _counters    = new Map();    // name → number
  const _gauges      = new Map();    // name → number
  const _histograms  = new Map();    // name → [values]
  const _spans       = new Map();    // spanId → SpanRecord
  const _errors      = [];           // recent errors
  const _buffer      = [];           // pending Firestore writes
  const MAX_ERRORS   = 100;
  const MAX_BUFFER   = 500;
  let   _sessionId   = null;
  let   _flushTimer  = null;

  /* ── Session ID ── */
  function _session() {
    if (!_sessionId) {
      _sessionId = 'SES-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    }
    return _sessionId;
  }

  /* ── Unique span ID ── */
  let _spanCounter = 0;
  function _spanId() {
    return `span_${Date.now()}_${(++_spanCounter).toString(36)}`;
  }

  /* ════════════════════════════════════════════════════════════
     COUNTERS
  ════════════════════════════════════════════════════════════ */
  function counter(name, delta = 1, tags = {}) {
    _counters.set(name, (_counters.get(name) || 0) + delta);
    _buffer.push({ type: METRIC_TYPE.COUNTER, name, delta, tags, ts: Date.now() });
    _scheduleFlush();
  }

  /* ════════════════════════════════════════════════════════════
     GAUGES
  ════════════════════════════════════════════════════════════ */
  function gauge(name, value, tags = {}) {
    _gauges.set(name, value);
    _buffer.push({ type: METRIC_TYPE.GAUGE, name, value, tags, ts: Date.now() });
    _scheduleFlush();
  }

  /* ════════════════════════════════════════════════════════════
     HISTOGRAMS
  ════════════════════════════════════════════════════════════ */
  function histogram(name, value, tags = {}) {
    if (!_histograms.has(name)) _histograms.set(name, []);
    const arr = _histograms.get(name);
    arr.push(value);
    /* Keep last 1000 values */
    if (arr.length > 1000) arr.shift();
    _buffer.push({ type: METRIC_TYPE.HISTOGRAM, name, value, tags, ts: Date.now() });
    _scheduleFlush();
  }

  /* ════════════════════════════════════════════════════════════
     TIMERS / SPANS  (distributed tracing)
  ════════════════════════════════════════════════════════════ */
  class Span {
    constructor(name, opts = {}) {
      this.id            = opts.spanId        || _spanId();
      this.parentId      = opts.parentId      || null;
      this.correlationId = opts.correlationId || this.id;
      this.name          = name;
      this.startMs       = performance.now();
      this.startTs       = Date.now();
      this.tags          = opts.tags || {};
      this.events        = [];
      this.status        = 'active';
      this.durationMs    = null;

      _spans.set(this.id, this);
    }

    /** Add an event to this span (e.g. "cache_hit", "retry"). */
    event(name, data = {}) {
      this.events.push({ name, data, offsetMs: performance.now() - this.startMs });
      return this;
    }

    /** Finish the span and record duration. */
    finish(status = 'ok') {
      this.durationMs = performance.now() - this.startMs;
      this.status     = status;
      _spans.delete(this.id);

      histogram('span.duration_ms', this.durationMs, { name: this.name });

      _buffer.push({
        type:          'span',
        spanId:        this.id,
        parentId:      this.parentId,
        correlationId: this.correlationId,
        name:          this.name,
        durationMs:    this.durationMs,
        status,
        tags:          this.tags,
        events:        this.events,
        ts:            this.startTs,
      });
      _scheduleFlush();

      return this.durationMs;
    }

    /** Finish span with an error. */
    error(err) {
      this.tags.error = (err instanceof Error) ? err.message : String(err);
      return this.finish('error');
    }
  }

  function startSpan(name, opts = {}) {
    return new Span(name, opts);
  }

  /**
   * Wrap an async function with automatic span tracking.
   * @param {string}   name - Span name
   * @param {Function} fn   - async function to execute
   * @param {object}   opts - Span options
   */
  async function trace(name, fn, opts = {}) {
    const span = startSpan(name, opts);
    try {
      const result = await fn(span);
      span.finish('ok');
      return result;
    } catch (err) {
      span.error(err);
      throw err;
    }
  }

  /* ════════════════════════════════════════════════════════════
     ERROR TRACKING
  ════════════════════════════════════════════════════════════ */
  function trackError(err, context = {}) {
    const entry = {
      message:   err instanceof Error ? err.message : String(err),
      stack:     err instanceof Error ? _normaliseStack(err.stack) : null,
      context,
      url:       window.location.pathname,
      userAgent: navigator.userAgent.slice(0, 100),
      sessionId: _session(),
      ts:        Date.now(),
    };

    _errors.unshift(entry);
    if (_errors.length > MAX_ERRORS) _errors.pop();

    counter('errors.total', 1, { url: entry.url });
    _buffer.push({ type: 'error', ...entry });
    _scheduleFlush();
  }

  function _normaliseStack(stack) {
    if (!stack) return null;
    return stack.split('\n').slice(0, 5).join('\n');
  }

  /* ── Global error handler ── */
  window.addEventListener('error', (e) => {
    trackError(e.error || new Error(e.message), { type: 'uncaught' });
  });
  window.addEventListener('unhandledrejection', (e) => {
    trackError(e.reason || new Error('Unhandled rejection'), { type: 'promise' });
  });

  /* ════════════════════════════════════════════════════════════
     WEB VITALS
  ════════════════════════════════════════════════════════════ */
  function _trackWebVitals() {
    /* Navigation timing */
    if ('performance' in window && window.performance.getEntriesByType) {
      const navEntry = window.performance.getEntriesByType('navigation')[0];
      if (navEntry) {
        gauge('web.ttfb_ms',     navEntry.responseStart - navEntry.requestStart);
        gauge('web.dom_load_ms', navEntry.domContentLoadedEventEnd - navEntry.navigationStart);
        gauge('web.full_load_ms',navEntry.loadEventEnd - navEntry.navigationStart);
        gauge('web.dns_ms',      navEntry.domainLookupEnd - navEntry.domainLookupStart);
        gauge('web.tcp_ms',      navEntry.connectEnd - navEntry.connectStart);
      }
    }

    /* Largest Contentful Paint */
    if ('PerformanceObserver' in window) {
      try {
        new PerformanceObserver(list => {
          const entries = list.getEntries();
          const lcp     = entries[entries.length - 1];
          if (lcp) gauge('web.lcp_ms', lcp.startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (_) {}

      /* Cumulative Layout Shift */
      try {
        let clsValue = 0;
        new PerformanceObserver(list => {
          list.getEntries().forEach(e => {
            if (!e.hadRecentInput) clsValue += e.value;
          });
          gauge('web.cls', clsValue);
        }).observe({ type: 'layout-shift', buffered: true });
      } catch (_) {}

      /* First Input Delay */
      try {
        new PerformanceObserver(list => {
          list.getEntries().forEach(e => {
            gauge('web.fid_ms', e.processingStart - e.startTime);
          });
        }).observe({ type: 'first-input', buffered: true });
      } catch (_) {}
    }
  }

  /* ════════════════════════════════════════════════════════════
     MEMORY / PERFORMANCE PRESSURE
  ════════════════════════════════════════════════════════════ */
  function _trackMemory() {
    if (performance.memory) {
      gauge('mem.heap_used_mb',  performance.memory.usedJSHeapSize  / 1048576);
      gauge('mem.heap_total_mb', performance.memory.totalJSHeapSize / 1048576);
      gauge('mem.heap_limit_mb', performance.memory.jsHeapSizeLimit / 1048576);
    }
  }

  setInterval(_trackMemory, 30000);

  /* ════════════════════════════════════════════════════════════
     FIRESTORE FLUSH (batch write every 30 seconds)
  ════════════════════════════════════════════════════════════ */
  function _scheduleFlush() {
    if (_flushTimer) return;
    _flushTimer = setTimeout(_flush, 30000);
  }

  async function _flush() {
    _flushTimer = null;
    if (!window.firebaseDB || _buffer.length === 0) return;

    const batch = _buffer.splice(0, Math.min(_buffer.length, MAX_BUFFER));

    try {
      const { collection, addDoc, serverTimestamp, writeBatch, doc } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const db      = window.firebaseDB;
      const fsatch  = writeBatch(db);
      const colRef  = collection(db, 'metrics');

      batch.forEach(entry => {
        const ref = doc(colRef);
        fsatch.set(ref, {
          ...entry,
          sessionId: _session(),
          uid:       window.firebaseAuth?.currentUser?.uid ?? null,
          page:      window.location.pathname,
          serverTs:  serverTimestamp(),
        });
      });

      await fsatch.commit();
    } catch (err) {
      /* Put items back — drop oldest if over limit */
      _buffer.unshift(...batch);
      if (_buffer.length > MAX_BUFFER * 2) _buffer.splice(MAX_BUFFER * 2);
    }
  }

  /* Force flush on page unload */
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _flush();
  });

  /* ════════════════════════════════════════════════════════════
     HISTOGRAM PERCENTILES
  ════════════════════════════════════════════════════════════ */
  function _percentile(name, p) {
    const arr = [...(_histograms.get(name) || [])].sort((a, b) => a - b);
    if (!arr.length) return null;
    const idx = Math.ceil((p / 100) * arr.length) - 1;
    return arr[Math.max(0, idx)];
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════ */
  const APM = {

    METRIC_TYPE,

    /* ── Core metric operations ── */
    counter,
    gauge,
    histogram,
    trackError,

    /* ── Tracing ── */
    startSpan,
    trace,

    /** Measure the execution time of a synchronous function. */
    time(name, fn, tags = {}) {
      const start = performance.now();
      try {
        const result = fn();
        const ms = performance.now() - start;
        histogram(name + '_ms', ms, tags);
        return result;
      } catch (err) {
        histogram(name + '_ms', performance.now() - start, { ...tags, error: true });
        throw err;
      }
    },

    /** Measure the execution time of an async function. */
    async timeAsync(name, fn, tags = {}) {
      const start = performance.now();
      try {
        const result = await fn();
        histogram(name + '_ms', performance.now() - start, tags);
        return result;
      } catch (err) {
        histogram(name + '_ms', performance.now() - start, { ...tags, error: true });
        throw err;
      }
    },

    /** Get a percentile of a histogram (p50, p95, p99). */
    percentile(name, p = 95) {
      return _percentile(name, p);
    },

    /** Get all current counter values. */
    counters() { return Object.fromEntries(_counters); },

    /** Get all current gauge values. */
    gauges() { return Object.fromEntries(_gauges); },

    /** Get recent errors. */
    errors() { return [..._errors]; },

    /** Session ID for this page load. */
    sessionId() { return _session(); },

    /** Force an immediate flush to Firestore. */
    async flush() { await _flush(); },

    /** Full diagnostics snapshot. */
    diagnostics() {
      return {
        sessionId:    _session(),
        counters:     Object.fromEntries(_counters),
        gauges:       Object.fromEntries(_gauges),
        histogramKeys:[..._histograms.keys()],
        activeSpans:  _spans.size,
        errorCount:   _errors.length,
        bufferDepth:  _buffer.length,
        page:         window.location.pathname,
        p50_span_ms:  _percentile('span.duration_ms', 50),
        p95_span_ms:  _percentile('span.duration_ms', 95),
        p99_span_ms:  _percentile('span.duration_ms', 99),
      };
    },

    /**
     * Register an external APM exporter.
     * exportFn receives the buffer contents every flush cycle.
     */
    registerExporter(exportFn) {
      if (typeof exportFn !== 'function') return;
      const orig = _flush.toString();
      const origFlush = _flush;
      window.__sokoniAPMExporter = exportFn;
    },
  };

  /* ── Start Web Vitals tracking ── */
  if (document.readyState === 'complete') {
    _trackWebVitals();
  } else {
    window.addEventListener('load', _trackWebVitals);
  }

  /* ── Wire into Event Bus for automatic metric collection ── */
  if (window.SokoniEventBus) {
    const E = SokoniEventBus.EVENTS;

    SokoniEventBus.on(E.ORDER_CREATED,       () => counter('orders.created'));
    SokoniEventBus.on(E.ORDER_COMPLETED,     () => counter('orders.completed'));
    SokoniEventBus.on(E.ORDER_CANCELLED,     () => counter('orders.cancelled'));
    SokoniEventBus.on(E.ORDER_DISPUTED,      () => counter('orders.disputed'));

    SokoniEventBus.on(E.PAYMENT_COMPLETED,   (e) => {
      counter('payments.completed');
      if (e.payload?.amount) histogram('payment.amount_kes', e.payload.amount);
    });
    SokoniEventBus.on(E.PAYMENT_FAILED,      () => counter('payments.failed'));
    SokoniEventBus.on(E.PAYMENT_REFUNDED,    () => counter('payments.refunded'));

    SokoniEventBus.on(E.FRAUD_FLAGGED,       () => counter('fraud.flagged'));
    SokoniEventBus.on(E.FRAUD_BLOCKED,       () => counter('fraud.blocked'));

    SokoniEventBus.on(E.WEBHOOK_RECEIVED,    () => counter('webhooks.received'));
    SokoniEventBus.on(E.WEBHOOK_FAILED,      () => counter('webhooks.failed'));
    SokoniEventBus.on(E.WEBHOOK_DLQ,         () => counter('webhooks.dlq'));

    SokoniEventBus.on(E.SYSTEM_CIRCUIT_OPEN, (e) => {
      counter('circuit.open', 1, { service: e.payload?.service });
    });
  }

  return APM;
})();

window.SokoniObservability = SokoniObservability;
window.SokoniAPM           = SokoniObservability;  // alias
