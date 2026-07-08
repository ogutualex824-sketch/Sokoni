/**
 * sokoni-observability.js
 * SOKONI Platform — Client-Side Observability SDK v1.0
 *
 * Capabilities:
 *   - Error tracking (deduplication, severity, breadcrumb trail)
 *   - Core Web Vitals: LCP, FID, CLS, FCP via PerformanceObserver
 *   - Navigation timing + slow resource detection (>500ms) + long task detection (>50ms)
 *   - Custom timers startTimer / stopTimer
 *   - User journey tracking: trackEvent, identify, enterFunnel, exitFunnel, page views
 *   - Structured logging: log.debug / log.info / log.warn / log.error (rate-limited 100/min remote)
 *   - Batch queue flush every 10s or on 20 events
 *   - Offline queue via localStorage, flushed on reconnect
 *   - Primary transport: Cloud Function obsIngestTelemetry
 *   - Fallback transport: Firestore collection _sokoniTelemetry
 *   - getHealthSnapshot() for live metric summary
 *   - Never throws — all paths wrapped in try/catch
 *
 * Usage:
 *   SokoniObservability.init({ projectId, appVersion, environment });
 *   SokoniObservability.trackEvent('add_to_cart', { itemId });
 *   SokoniObservability.identify(userId, { role: 'buyer' });
 *   SokoniObservability.log.info('checkout started', { orderId });
 *   SokoniObservability.startTimer('checkout');
 *   SokoniObservability.stopTimer('checkout', { step: 'payment' });
 *   SokoniObservability.enterFunnel('purchase', { step: 1 });
 *   SokoniObservability.getHealthSnapshot();
 *
 * (c) 2026 SOKONI. All rights reserved.
 */

(function (window) {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────────────

  const SDK_VERSION         = '1.0.0';
  const BATCH_MAX           = 20;
  const BATCH_INTERVAL_MS   = 10_000;
  const LOG_RATE_LIMIT      = 100;          // max remote log sends per minute
  const LOG_RATE_WINDOW_MS  = 60_000;
  const SLOW_RESOURCE_MS    = 500;
  const LONG_TASK_MS        = 50;
  const DEDUP_WINDOW_MS     = 5_000;        // suppress identical errors within this window
  const OFFLINE_QUEUE_KEY   = 'sokoni_obs_offline_q';
  const MAX_BREADCRUMBS     = 50;
  const MAX_OFFLINE_EVENTS  = 200;
  const CF_ENDPOINT_TMPL    = 'https://us-central1-{projectId}.cloudfunctions.net/obsIngestTelemetry';
  const FS_ENDPOINT_TMPL    = 'https://firestore.googleapis.com/v1/projects/{projectId}/databases/(default)/documents/_sokoniTelemetry';

  // ─── Internal State ──────────────────────────────────────────────────────────

  let _cfg = {
    projectId:   '',
    appVersion:  '0.0.0',
    environment: 'production',
    debug:       false,
  };

  let _userId       = null;
  let _userTraits   = {};
  let _sessionId    = _genId();
  let _pageLoadId   = _genId();

  // Queue & flush
  let _queue        = [];
  let _flushTimer   = null;

  // Error deduplication: fingerprint → last seen timestamp
  let _errorSeen    = new Map();

  // Breadcrumbs
  let _breadcrumbs  = [];

  // Vitals
  let _vitals = {
    LCP: null,
    FID: null,
    CLS: 0,
    FCP: null,
  };

  // Navigation timing
  let _navTiming    = null;

  // Custom timers
  let _timers       = new Map();

  // Active funnels: name → { step, startedAt, meta }
  let _funnels      = new Map();

  // Log rate limiting
  let _logCount     = 0;
  let _logWindowStart = Date.now();

  // Health counters
  let _health = {
    errorsTracked:     0,
    eventsQueued:      0,
    eventsFlushed:     0,
    flushFailures:     0,
    slowResources:     0,
    longTasks:         0,
    offlineQueueDepth: 0,
  };

  let _initialized  = false;

  // ─── Utilities ───────────────────────────────────────────────────────────────

  function _genId() {
    try {
      return (
        Math.random().toString(36).slice(2, 10) +
        Math.random().toString(36).slice(2, 10)
      );
    } catch (_) {
      return String(Date.now());
    }
  }

  function _now() {
    try { return Date.now(); } catch (_) { return 0; }
  }

  function _ts() {
    try { return new Date().toISOString(); } catch (_) { return ''; }
  }

  function _debugLog(...args) {
    try {
      if (_cfg.debug) console.debug('[SokoniObs]', ...args);
    } catch (_) { /* silent */ }
  }

  function _cloneSmall(obj, maxSize) {
    const seen = new WeakSet();
    try {
      return JSON.stringify(obj, (key, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        if (typeof val === 'string' && val.length > 200) return val.slice(0, 200) + '…';
        return val;
      })?.slice(0, maxSize || 4096);
    } catch (_) {
      return undefined;
    }
  }

  function _fingerprint(message, source, lineno) {
    return `${String(message).slice(0, 120)}|${source}|${lineno}`;
  }

  function _cfEndpoint() {
    return CF_ENDPOINT_TMPL.replace('{projectId}', _cfg.projectId);
  }

  function _fsEndpoint() {
    return FS_ENDPOINT_TMPL.replace('{projectId}', _cfg.projectId);
  }

  // ─── Breadcrumbs ─────────────────────────────────────────────────────────────

  function _addBreadcrumb(category, message, data) {
    try {
      const crumb = {
        t:        _ts(),
        category: String(category).slice(0, 30),
        message:  String(message).slice(0, 200),
        data:     data ? _cloneSmall(data) : undefined,
      };
      _breadcrumbs.push(crumb);
      if (_breadcrumbs.length > MAX_BREADCRUMBS) {
        _breadcrumbs.shift();
      }
    } catch (_) { /* silent */ }
  }

  function _getBreadcrumbs() {
    try { return [..._breadcrumbs]; } catch (_) { return []; }
  }

  // ─── Offline Queue ────────────────────────────────────────────────────────────

  function _saveOfflineQueue(events) {
    try {
      const existing = _loadOfflineQueue();
      const merged   = [...existing, ...events].slice(-MAX_OFFLINE_EVENTS);
      localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(merged));
      _health.offlineQueueDepth = merged.length;
    } catch (_) { /* no localStorage — silent */ }
  }

  function _loadOfflineQueue() {
    try {
      const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function _clearOfflineQueue() {
    try {
      localStorage.removeItem(OFFLINE_QUEUE_KEY);
      _health.offlineQueueDepth = 0;
    } catch (_) { /* silent */ }
  }

  // ─── Transport ────────────────────────────────────────────────────────────────

  /**
   * Try Cloud Function first; fall back to Firestore REST.
   */
  async function _send(payload) {
    // Primary: Cloud Function
    try {
      const resp = await fetch(_cfEndpoint(), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
        keepalive: true,
      });
      if (resp.ok) {
        _health.eventsFlushed += payload.events ? payload.events.length : 1;
        _debugLog('flushed', payload.events?.length ?? 1, 'events via CF');
        return true;
      }
    } catch (_) { /* fall through to Firestore */ }

    // Fallback: Firestore REST
    try {
      const doc = {
        fields: {
          batchId:   { stringValue: _genId() },
          sessionId: { stringValue: _sessionId },
          ts:        { stringValue: _ts() },
          payload:   { stringValue: JSON.stringify(payload) },
          sdk:       { stringValue: SDK_VERSION },
        },
      };
      const resp = await fetch(_fsEndpoint(), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(doc),
        keepalive: true,
      });
      if (resp.ok) {
        _health.eventsFlushed += payload.events ? payload.events.length : 1;
        _debugLog('flushed via Firestore fallback');
        return true;
      }
    } catch (_) { /* silent */ }

    return false;
  }

  // ─── Batch Queue & Flush ──────────────────────────────────────────────────────

  function _enqueue(event) {
    try {
      _queue.push(event);
      _health.eventsQueued++;
      if (_queue.length >= BATCH_MAX) {
        _flush();
      }
    } catch (_) { /* silent */ }
  }

  async function _flush() {
    try {
      if (_queue.length === 0) return;

      const batch   = _queue.splice(0, _queue.length);
      const offline = _loadOfflineQueue();

      if (!navigator.onLine) {
        _saveOfflineQueue(batch);
        _debugLog('offline — queued', batch.length, 'events to localStorage');
        return;
      }

      // Prepend any previously stored offline events
      const allEvents = [...offline, ...batch];

      const payload = {
        sessionId:   _sessionId,
        userId:      _userId,
        appVersion:  _cfg.appVersion,
        environment: _cfg.environment,
        sdk:         SDK_VERSION,
        ts:          _ts(),
        events:      allEvents,
      };

      const ok = await _send(payload);
      if (ok) {
        if (offline.length) _clearOfflineQueue();
      } else {
        _health.flushFailures++;
        _saveOfflineQueue(batch);
        _debugLog('flush failed — saved', batch.length, 'events offline');
      }
    } catch (_) {
      _health.flushFailures++;
    }
  }

  function _startFlushTimer() {
    try {
      if (_flushTimer) clearInterval(_flushTimer);
      _flushTimer = setInterval(_flush, BATCH_INTERVAL_MS);
    } catch (_) { /* silent */ }
  }

  // ─── Error Tracking ───────────────────────────────────────────────────────────

  const SEVERITY = Object.freeze({
    DEBUG:    'debug',
    INFO:     'info',
    WARNING:  'warning',
    ERROR:    'error',
    CRITICAL: 'critical',
  });

  function _trackError(message, opts) {
    try {
      opts = opts || {};
      const fp   = _fingerprint(message, opts.source || '', opts.lineno || 0);
      const last = _errorSeen.get(fp);
      if (last && (_now() - last) < DEDUP_WINDOW_MS) {
        _debugLog('suppressed duplicate error:', message);
        return;
      }
      _errorSeen.set(fp, _now());
      _health.errorsTracked++;

      _addBreadcrumb('error', message, { source: opts.source, lineno: opts.lineno });

      _enqueue({
        type:        'error',
        severity:    opts.severity || SEVERITY.ERROR,
        message:     String(message).slice(0, 500),
        stack:       opts.stack ? String(opts.stack).slice(0, 2000) : undefined,
        source:      opts.source,
        lineno:      opts.lineno,
        colno:       opts.colno,
        componentId: opts.componentId,
        breadcrumbs: _getBreadcrumbs(),
        url:         window.location.href,
        userAgent:   navigator.userAgent,
        userId:      _userId,
        sessionId:   _sessionId,
        pageLoadId:  _pageLoadId,
        ts:          _ts(),
      });
    } catch (_) { /* silent */ }
  }

  function _installGlobalErrorHandlers() {
    try {
      window.addEventListener('error', function (e) {
        try {
          _trackError(e.message || 'Script error', {
            source:   e.filename,
            lineno:   e.lineno,
            colno:    e.colno,
            stack:    e.error && e.error.stack,
            severity: SEVERITY.ERROR,
          });
        } catch (_) { /* silent */ }
      });

      window.addEventListener('unhandledrejection', function (e) {
        try {
          const msg   = e.reason instanceof Error
            ? e.reason.message
            : String(e.reason).slice(0, 300);
          const stack = e.reason instanceof Error ? e.reason.stack : undefined;
          _trackError('Unhandled Promise rejection: ' + msg, {
            stack,
            severity: SEVERITY.ERROR,
          });
        } catch (_) { /* silent */ }
      });
    } catch (_) { /* silent */ }
  }

  // ─── Core Web Vitals ─────────────────────────────────────────────────────────

  function _observeWebVitals() {
    try {
      if (typeof PerformanceObserver === 'undefined') return;

      // LCP
      try {
        const lcpObs = new PerformanceObserver(function (list) {
          try {
            const entries = list.getEntries();
            const last    = entries[entries.length - 1];
            if (last) {
              _vitals.LCP = last.startTime;
              _enqueue({
                type:       'vital',
                name:       'LCP',
                value:      last.startTime,
                ts:         _ts(),
                sessionId:  _sessionId,
                pageLoadId: _pageLoadId,
                url:        window.location.href,
              });
            }
          } catch (_) { /* silent */ }
        });
        lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (_) { /* LCP not supported */ }

      // FID
      try {
        const fidObs = new PerformanceObserver(function (list) {
          try {
            list.getEntries().forEach(function (entry) {
              _vitals.FID = entry.processingStart - entry.startTime;
              _enqueue({
                type:       'vital',
                name:       'FID',
                value:      _vitals.FID,
                ts:         _ts(),
                sessionId:  _sessionId,
                pageLoadId: _pageLoadId,
                url:        window.location.href,
              });
            });
          } catch (_) { /* silent */ }
        });
        fidObs.observe({ type: 'first-input', buffered: true });
      } catch (_) { /* FID not supported */ }

      // CLS — accumulate only; report final value once at page end (below)
      try {
        const clsObs = new PerformanceObserver(function (list) {
          try {
            list.getEntries().forEach(function (entry) {
              if (!entry.hadRecentInput) {
                _vitals.CLS += entry.value;
              }
            });
          } catch (_) { /* silent */ }
        });
        clsObs.observe({ type: 'layout-shift', buffered: true });
      } catch (_) { /* CLS not supported */ }

      // Report CLS final value once at page end
      (function () {
        var _clsReported = false;
        function _reportCls() {
          if (_clsReported) return;
          _clsReported = true;
          try {
            _enqueue({
              type:       'vital',
              name:       'CLS',
              value:      _vitals.CLS,
              page:       location.pathname,
              ts:         _ts(),
              sessionId:  _sessionId,
              pageLoadId: _pageLoadId,
              url:        window.location.href,
            });
          } catch (_) { /* silent */ }
        }
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') _reportCls();
        });
        window.addEventListener('pagehide', _reportCls, { once: true });
      }());

      // FCP
      try {
        const fcpObs = new PerformanceObserver(function (list) {
          try {
            list.getEntries().forEach(function (entry) {
              if (entry.name === 'first-contentful-paint') {
                _vitals.FCP = entry.startTime;
                _enqueue({
                  type:       'vital',
                  name:       'FCP',
                  value:      _vitals.FCP,
                  ts:         _ts(),
                  sessionId:  _sessionId,
                  pageLoadId: _pageLoadId,
                  url:        window.location.href,
                });
              }
            });
          } catch (_) { /* silent */ }
        });
        fcpObs.observe({ type: 'paint', buffered: true });
      } catch (_) { /* FCP not supported */ }

    } catch (_) { /* PerformanceObserver unavailable */ }
  }

  // ─── Navigation Timing ───────────────────────────────────────────────────────

  function _captureNavTiming() {
    try {
      const fn = function () {
        try {
          const nav = performance.getEntriesByType('navigation')[0];
          if (!nav) return;
          _navTiming = {
            dns:         nav.domainLookupEnd  - nav.domainLookupStart,
            tcp:         nav.connectEnd       - nav.connectStart,
            ttfb:        nav.responseStart    - nav.requestStart,
            download:    nav.responseEnd      - nav.responseStart,
            domParse:    nav.domInteractive   - nav.responseEnd,
            domReady:    nav.domContentLoadedEventEnd - nav.startTime,
            pageLoad:    nav.loadEventEnd     - nav.startTime,
            redirects:   nav.redirectCount,
            protocol:    nav.nextHopProtocol,
          };
          _enqueue({
            type:       'nav_timing',
            ...(_navTiming),
            url:        window.location.href,
            ts:         _ts(),
            sessionId:  _sessionId,
            pageLoadId: _pageLoadId,
          });
        } catch (_) { /* silent */ }
      };

      if (document.readyState === 'complete') {
        fn();
      } else {
        window.addEventListener('load', fn, { once: true });
      }
    } catch (_) { /* silent */ }
  }

  // ─── Slow Resource Detection ──────────────────────────────────────────────────

  function _observeSlowResources() {
    try {
      if (typeof PerformanceObserver === 'undefined') return;

      const obs = new PerformanceObserver(function (list) {
        try {
          list.getEntries().forEach(function (entry) {
            const duration = entry.responseEnd - entry.startTime;
            if (duration > SLOW_RESOURCE_MS) {
              _health.slowResources++;
              _addBreadcrumb('perf', 'slow resource', {
                url: entry.name,
                ms:  Math.round(duration),
              });
              _enqueue({
                type:         'slow_resource',
                url:          entry.name,
                initiator:    entry.initiatorType,
                durationMs:   Math.round(duration),
                transferSize: entry.transferSize,
                ts:           _ts(),
                sessionId:    _sessionId,
                pageLoadId:   _pageLoadId,
              });
            }
          });
        } catch (_) { /* silent */ }
      });
      obs.observe({ type: 'resource', buffered: false });
    } catch (_) { /* silent */ }
  }

  // ─── Long Task Detection ──────────────────────────────────────────────────────

  function _observeLongTasks() {
    try {
      if (typeof PerformanceObserver === 'undefined') return;

      const obs = new PerformanceObserver(function (list) {
        try {
          list.getEntries().forEach(function (entry) {
            if (entry.duration > LONG_TASK_MS) {
              _health.longTasks++;
              _addBreadcrumb('perf', 'long task', { ms: Math.round(entry.duration) });
              _enqueue({
                type:       'long_task',
                durationMs: Math.round(entry.duration),
                startTime:  Math.round(entry.startTime),
                ts:         _ts(),
                sessionId:  _sessionId,
                pageLoadId: _pageLoadId,
              });
            }
          });
        } catch (_) { /* silent */ }
      });
      obs.observe({ type: 'longtask', buffered: false });
    } catch (_) { /* longtask PerformanceObserver not supported */ }
  }

  // ─── Custom Timers ────────────────────────────────────────────────────────────

  function startTimer(name) {
    try {
      if (!name) return;
      _timers.set(String(name), _now());
      _addBreadcrumb('timer', 'started: ' + name);
    } catch (_) { /* silent */ }
  }

  function stopTimer(name, meta) {
    try {
      if (!name) return null;
      const key   = String(name);
      const start = _timers.get(key);
      if (start === undefined) return null;
      _timers.delete(key);
      const durationMs = _now() - start;
      _addBreadcrumb('timer', 'stopped: ' + name, { durationMs });
      _enqueue({
        type:       'timer',
        name:       key,
        durationMs,
        meta:       meta ? _cloneSmall(meta) : undefined,
        ts:         _ts(),
        sessionId:  _sessionId,
        userId:     _userId,
        pageLoadId: _pageLoadId,
        url:        window.location.href,
      });
      return durationMs;
    } catch (_) {
      return null;
    }
  }

  // ─── User Identity ────────────────────────────────────────────────────────────

  function identify(userId, traits) {
    try {
      _userId     = userId ? String(userId) : null;
      _userTraits = traits ? _cloneSmall(traits) : {};
      _addBreadcrumb('identity', 'identified', { userId: _userId });
      _enqueue({
        type:      'identify',
        userId:    _userId,
        traits:    _userTraits,
        ts:        _ts(),
        sessionId: _sessionId,
      });
    } catch (_) { /* silent */ }
  }

  // ─── Event Tracking ───────────────────────────────────────────────────────────

  function trackEvent(name, props) {
    try {
      if (!name) return;
      _addBreadcrumb('event', name, props);
      _enqueue({
        type:       'event',
        name:       String(name).slice(0, 100),
        props:      props ? _cloneSmall(props) : undefined,
        ts:         _ts(),
        sessionId:  _sessionId,
        userId:     _userId,
        pageLoadId: _pageLoadId,
        url:        window.location.href,
      });
    } catch (_) { /* silent */ }
  }

  // ─── Page View Tracking ───────────────────────────────────────────────────────

  function trackPageView(overridePath) {
    try {
      _pageLoadId = _genId();
      const path  = overridePath || window.location.pathname + window.location.search;
      _addBreadcrumb('navigation', 'page view', { path });
      _enqueue({
        type:       'page_view',
        path,
        referrer:   document.referrer || undefined,
        title:      document.title    || undefined,
        ts:         _ts(),
        sessionId:  _sessionId,
        userId:     _userId,
        pageLoadId: _pageLoadId,
      });
    } catch (_) { /* silent */ }
  }

  // ─── Funnel Tracking ─────────────────────────────────────────────────────────

  function enterFunnel(funnelName, meta) {
    try {
      if (!funnelName) return;
      const name = String(funnelName);
      _funnels.set(name, {
        step:      (meta && meta.step) || 1,
        startedAt: _now(),
        meta:      meta ? _cloneSmall(meta) : {},
      });
      _addBreadcrumb('funnel', 'entered: ' + name, meta);
      _enqueue({
        type:      'funnel_enter',
        funnel:    name,
        step:      (meta && meta.step) || 1,
        meta:      meta ? _cloneSmall(meta) : undefined,
        ts:        _ts(),
        sessionId: _sessionId,
        userId:    _userId,
        url:       window.location.href,
      });
    } catch (_) { /* silent */ }
  }

  function exitFunnel(funnelName, outcome, meta) {
    try {
      if (!funnelName) return;
      const name    = String(funnelName);
      const state   = _funnels.get(name);
      const elapsed = state ? _now() - state.startedAt : null;
      _funnels.delete(name);
      _addBreadcrumb('funnel', 'exited: ' + name, { outcome });
      _enqueue({
        type:      'funnel_exit',
        funnel:    name,
        outcome:   outcome || 'unknown',
        elapsedMs: elapsed,
        lastStep:  state ? state.step : undefined,
        meta:      meta ? _cloneSmall(meta) : undefined,
        ts:        _ts(),
        sessionId: _sessionId,
        userId:    _userId,
        url:       window.location.href,
      });
    } catch (_) { /* silent */ }
  }

  function advanceFunnel(funnelName, step, meta) {
    try {
      if (!funnelName) return;
      const name  = String(funnelName);
      const state = _funnels.get(name);
      if (state) state.step = step;
      _addBreadcrumb('funnel', 'step: ' + name + ' -> ' + step);
      _enqueue({
        type:      'funnel_step',
        funnel:    name,
        step,
        meta:      meta ? _cloneSmall(meta) : undefined,
        ts:        _ts(),
        sessionId: _sessionId,
        userId:    _userId,
        url:       window.location.href,
      });
    } catch (_) { /* silent */ }
  }

  // ─── Structured Logging ───────────────────────────────────────────────────────

  function _isRateLimited() {
    try {
      const now = _now();
      if (now - _logWindowStart > LOG_RATE_WINDOW_MS) {
        _logWindowStart = now;
        _logCount       = 0;
      }
      if (_logCount >= LOG_RATE_LIMIT) return true;
      _logCount++;
      return false;
    } catch (_) {
      return false;
    }
  }

  function _logAt(level, message, context) {
    try {
      const entry = {
        type:      'log',
        level,
        message:   String(message).slice(0, 1000),
        context:   context ? _cloneSmall(context) : undefined,
        ts:        _ts(),
        sessionId: _sessionId,
        userId:    _userId,
        url:       window.location.href,
      };

      // Always write to breadcrumbs
      _addBreadcrumb('log:' + level, message, context);

      // Console mirror in debug mode
      if (_cfg.debug) {
        const fn = level === 'error' || level === 'critical' ? console.error
          : level === 'warn'  ? console.warn
          : level === 'debug' ? console.debug
          : console.info;
        fn('[SokoniObs][' + level + ']', message, context || '');
      }

      // Remote — respect rate limit for non-error/critical levels
      if (level === 'error' || level === 'critical' || !_isRateLimited()) {
        _enqueue(entry);
      }
    } catch (_) { /* silent */ }
  }

  const log = Object.freeze({
    debug:    function (msg, ctx) { _logAt('debug',    msg, ctx); },
    info:     function (msg, ctx) { _logAt('info',     msg, ctx); },
    warn:     function (msg, ctx) { _logAt('warn',     msg, ctx); },
    error:    function (msg, ctx) { _logAt('error',    msg, ctx); },
    critical: function (msg, ctx) { _logAt('critical', msg, ctx); },
  });

  // ─── Health Snapshot ──────────────────────────────────────────────────────────

  function getHealthSnapshot() {
    try {
      const offlineDepth = _loadOfflineQueue().length;
      return {
        sdk:              SDK_VERSION,
        sessionId:        _sessionId,
        userId:           _userId,
        environment:      _cfg.environment,
        appVersion:       _cfg.appVersion,
        uptime:           Math.round((_now() - _startedAt) / 1000) + 's',
        vitals:           { ...(_vitals) },
        navTiming:        _navTiming ? { ...(_navTiming) } : null,
        queueDepth:       _queue.length,
        offlineDepth,
        errorsTracked:    _health.errorsTracked,
        eventsQueued:     _health.eventsQueued,
        eventsFlushed:    _health.eventsFlushed,
        flushFailures:    _health.flushFailures,
        slowResources:    _health.slowResources,
        longTasks:        _health.longTasks,
        activeFunnels:    Array.from(_funnels.keys()),
        activeTimers:     Array.from(_timers.keys()),
        breadcrumbCount:  _breadcrumbs.length,
        logRateLimitHits: Math.max(0, _logCount - LOG_RATE_LIMIT),
        online:           navigator.onLine,
        ts:               _ts(),
      };
    } catch (_) {
      return { error: 'snapshot_failed', ts: _ts() };
    }
  }

  // ─── SPA / History Navigation Tracking ───────────────────────────────────────

  function _patchHistory() {
    try {
      const _push    = history.pushState;
      const _replace = history.replaceState;

      history.pushState = function () {
        try { _push.apply(history, arguments); } catch (_) { /* silent */ }
        try { trackPageView(); } catch (_) { /* silent */ }
      };

      history.replaceState = function () {
        try { _replace.apply(history, arguments); } catch (_) { /* silent */ }
        try { trackPageView(); } catch (_) { /* silent */ }
      };

      window.addEventListener('popstate', function () {
        try { trackPageView(); } catch (_) { /* silent */ }
      });
    } catch (_) { /* silent */ }
  }

  // ─── Connectivity Listeners ───────────────────────────────────────────────────

  function _installConnectivityListeners() {
    try {
      window.addEventListener('online', function () {
        try {
          _addBreadcrumb('network', 'online');
          log.info('network reconnected — flushing offline queue');
          _flush();
        } catch (_) { /* silent */ }
      });

      window.addEventListener('offline', function () {
        try {
          _addBreadcrumb('network', 'offline');
          log.warn('network offline — events will be queued locally');
        } catch (_) { /* silent */ }
      });
    } catch (_) { /* silent */ }
  }

  // ─── Visibility / Unload Flush ────────────────────────────────────────────────

  function _installUnloadFlush() {
    try {
      // Flush on tab hidden (mobile-safe)
      document.addEventListener('visibilitychange', function () {
        try {
          if (document.visibilityState === 'hidden') {
            _flush();
          }
        } catch (_) { /* silent */ }
      });

      // Flush on beforeunload
      window.addEventListener('beforeunload', function () {
        try { _flush(); } catch (_) { /* silent */ }
      });

      // pagehide for iOS Safari
      window.addEventListener('pagehide', function () {
        try { _flush(); } catch (_) { /* silent */ }
      });
    } catch (_) { /* silent */ }
  }

  // ─── Click Breadcrumb Instrumentation ────────────────────────────────────────

  function _installClickTracking() {
    try {
      document.addEventListener('click', function (e) {
        try {
          const el   = e.target;
          const tag  = el.tagName || '';
          const id   = el.id   ? '#' + el.id : '';
          const cls  = el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
            : '';
          const text = (el.textContent || '').trim().slice(0, 40);
          _addBreadcrumb('ui', 'click ' + tag.toLowerCase() + id + cls, { text });
        } catch (_) { /* silent */ }
      }, { passive: true, capture: true });
    } catch (_) { /* silent */ }
  }

  // ─── Startup Timestamp ───────────────────────────────────────────────────────

  let _startedAt = _now();

  // ─── init ─────────────────────────────────────────────────────────────────────

  function init(config) {
    try {
      if (_initialized) {
        console.warn('[SokoniObs] already initialized — ignoring duplicate init()');
        return;
      }

      if (!config || !config.projectId) {
        console.error('[SokoniObs] init() requires { projectId }');
        return;
      }

      _cfg = {
        projectId:   String(config.projectId),
        appVersion:  String(config.appVersion  || '0.0.0'),
        environment: String(config.environment || 'production'),
        debug:       Boolean(config.debug),
      };

      _startedAt   = _now();
      _initialized = true;

      _installGlobalErrorHandlers();
      _observeWebVitals();
      _captureNavTiming();
      _observeSlowResources();
      _observeLongTasks();
      _installConnectivityListeners();
      _installUnloadFlush();
      _installClickTracking();
      _patchHistory();
      _startFlushTimer();

      // Initial page view
      trackPageView();

      // Flush any stale offline queue immediately if we are online
      if (navigator.onLine) {
        const stale = _loadOfflineQueue();
        if (stale.length) {
          _debugLog('replaying', stale.length, 'stale offline events');
          _flush();
        }
      }

      log.info('SokoniObservability initialized', {
        projectId:   _cfg.projectId,
        appVersion:  _cfg.appVersion,
        environment: _cfg.environment,
        sessionId:   _sessionId,
      });

    } catch (e) {
      try { console.error('[SokoniObs] init failed:', e); } catch (_) { /* silent */ }
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  const SokoniObservability = Object.freeze({
    /** Initialize the SDK. Must be called before any other method. */
    init,

    /** Set the authenticated user identity. */
    identify,

    /** Track a custom named event with optional properties. */
    trackEvent,

    /** Track a page view (called automatically on history changes). */
    trackPageView,

    /** Start a named timer. */
    startTimer,

    /** Stop a named timer and emit a timer event. Returns duration in ms. */
    stopTimer,

    /** Enter a named conversion funnel. */
    enterFunnel,

    /** Advance to the next step within an active funnel. */
    advanceFunnel,

    /** Exit a named funnel with an outcome label ('completed' | 'abandoned' | ...). */
    exitFunnel,

    /** Structured logger: log.debug / log.info / log.warn / log.error / log.critical */
    log,

    /** Track an error manually (in addition to auto-captured global errors). */
    trackError: function (message, opts) {
      try { _trackError(message, opts); } catch (_) { /* silent */ }
    },

    /** Add a manual breadcrumb to the trail. */
    addBreadcrumb: function (category, message, data) {
      try { _addBreadcrumb(category, message, data); } catch (_) { /* silent */ }
    },

    /** Force-flush the event queue immediately. */
    flush: function () {
      try { _flush(); } catch (_) { /* silent */ }
    },

    /** Return a live snapshot of SDK health and key metrics. */
    getHealthSnapshot,

    /** Read-only severity constants. */
    SEVERITY,

    /** SDK version string. */
    version: SDK_VERSION,
  });

  // ─── Expose ───────────────────────────────────────────────────────────────────

  window.SokoniObservability = SokoniObservability;

}(window));
