/**
 * SOKONI Monitor v1.0
 * Phase 11: Client-side performance monitoring.
 * Tracks Web Vitals (LCP, FID, CLS, TTFB), JS errors, payment funnels,
 * Firestore read/write counts, queue depths, and SmartPOS health.
 * Batches telemetry and flushes every 30 s via the recordMetric CF.
 */
const SokoniMonitor = (function () {
  "use strict";

  const CF_ENDPOINT  = "https://us-central1-sokoni-aeb26.cloudfunctions.net/recordMetric";
  const FLUSH_MS     = 30000;
  const MAX_BUFFER   = 120;
  const MAX_STR      = 250;

  /* ── Session ─────────────────────────────────────────────── */
  let _sid = sessionStorage.getItem("_sk_mon_sid");
  if (!_sid) {
    _sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    sessionStorage.setItem("_sk_mon_sid", _sid);
  }

  /* ── Buffer ──────────────────────────────────────────────── */
  let _buf = [];

  function _push(event, data) {
    if (_buf.length >= MAX_BUFFER) _buf.shift(); // ring buffer
    _buf.push({
      event,
      page: location.pathname,
      sid:  _sid,
      ts:   Date.now(),
      ...data,
    });
  }

  /* ── Public tracking methods ────────────────────────────── */
  function track(event, data = {}) { _push(event, data); }

  function error(msg, ctx = {}) {
    _push("js_error", { msg: String(msg).slice(0, MAX_STR), ...ctx });
  }

  function timing(name, ms) {
    _push("timing", { name, ms: Math.round(ms) });
  }

  /** paymentFunnel — call at each step: "initiated", "confirmed", "failed", "cancelled" */
  function paymentFunnel(step, ref, extra = {}) {
    _push("payment", { step, ref: ref ? String(ref).slice(0, 60) : null, ...extra });
  }

  function firestoreRead(collection, cached = false) {
    _push("fs_read", { col: collection, cached });
  }

  function firestoreWrite(collection, result = "ok") {
    _push("fs_write", { col: collection, result });
  }

  function posHealth(status) {
    _push("pos_health", {
      online:  status.online,
      pending: status.pending,
      failed:  status.failed,
    });
  }

  function queueDepth(queued, running) {
    _push("queue_depth", { queued, running });
  }

  function scaleStatus(statusObj) {
    _push("scale_status", {
      healthy: statusObj.healthy,
      queued:  statusObj.queue ? statusObj.queue.queued : 0,
    });
  }

  /* ── Web Vitals ─────────────────────────────────────────── */
  function _observeVitals() {
    if (!window.PerformanceObserver) return;

    /* LCP */
    try {
      new PerformanceObserver(list => {
        const entries = list.getEntries();
        const last    = entries[entries.length - 1];
        if (last) timing("LCP", last.startTime);
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}

    /* FID */
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          timing("FID", e.processingStart - e.startTime);
        }
      }).observe({ type: "first-input", buffered: true });
    } catch {}

    /* CLS */
    try {
      let cls = 0;
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          if (!e.hadRecentInput) cls += e.value;
        }
        _push("web_vital", { name: "CLS", value: Math.round(cls * 10000) / 10000 });
      }).observe({ type: "layout-shift", buffered: true });
    } catch {}

    /* Navigation timings (TTFB, DOM, full load) */
    window.addEventListener("load", () => {
      try {
        const nav = performance.getEntriesByType("navigation")[0];
        if (nav) {
          timing("TTFB",    nav.responseStart);
          timing("DOMReady", nav.domContentLoadedEventEnd);
          timing("FullLoad", nav.loadEventEnd);
        }
      } catch {}
    }, { once: true });
  }

  /* ── Flush ───────────────────────────────────────────────── */
  async function flush() {
    if (!_buf.length) return;
    const batch = _buf.splice(0, _buf.length);

    if (!navigator.onLine) {
      /* Keep most recent 20 events for next flush */
      _buf.unshift(...batch.slice(-20));
      return;
    }

    try {
      await fetch(CF_ENDPOINT, {
        method:    "POST",
        headers:   { "Content-Type": "application/json" },
        body:      JSON.stringify({ batch }),
        keepalive: true,           // survives page unload
      });
    } catch {
      /* Drop on error — monitor failures must never affect the main app */
    }
  }

  /* ── Auto-instrumentation ───────────────────────────────── */
  window.addEventListener("error", e => {
    error(e.message, { file: e.filename, line: e.lineno, col: e.colno });
  });

  window.addEventListener("unhandledrejection", e => {
    error("UnhandledRejection: " + String(e.reason || "").slice(0, MAX_STR));
  });

  /* Flush on page hide / close */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      timing("page_time", Date.now() - _pageStart);
      flush();
    }
  });

  const _pageStart = Date.now();
  setInterval(flush, FLUSH_MS);
  _observeVitals();

  /* ── Periodic scale + queue snapshot (every 60 s) ───────── */
  setInterval(() => {
    if (typeof SOKONI_SCALE !== "undefined") {
      try { scaleStatus(SOKONI_SCALE.getStatus()); } catch {}
    }
    if (typeof SokoniQueue !== "undefined") {
      SokoniQueue.getStats().then(s => queueDepth(s.pending, 0)).catch(() => {});
    }
    if (typeof SokoniPOSResilience !== "undefined") {
      SokoniPOSResilience.getStats().then(s => posHealth({ online: navigator.onLine, pending: s.pending, failed: s.failed })).catch(() => {});
    }
  }, 60000);

  return { track, error, timing, paymentFunnel, firestoreRead, firestoreWrite, posHealth, queueDepth, scaleStatus, flush };
})();

if (typeof module !== "undefined") module.exports = SokoniMonitor;
