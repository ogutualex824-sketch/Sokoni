/**
 * SOKONI Production Logger  v1.0
 *
 * Development  — automatic on localhost; full detail in console.
 * Production   — silent by default; zero PII in browser console.
 * Manual debug — localStorage.setItem('sokoni_debug','true') then reload.
 *
 * Replace all console.warn / console.log calls in DB/payment code
 * with SokoniLogger.warn / SokoniLogger.log so production users
 * never see Firestore error messages or internal state.
 */
(function (window) {
  'use strict';

  const _isDev  = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const _isDebug = _isDev || (function () {
    try { return localStorage.getItem('sokoni_debug') === 'true'; } catch (_) { return false; }
  })();

  /* Masks that strip values matching these patterns before they reach console */
  const _SENSITIVE = [
    /\b(password|passwd|secret|token|apikey|api_key|authorization|bearer)\s*[:=]\s*\S+/gi,
    /\b07\d{8}\b/g,          /* Kenyan phone numbers */
    /\b01\d{8}\b/g,
    /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, /* emails */
  ];

  function _sanitize(msg) {
    if (typeof msg !== 'string') return msg;
    let out = msg;
    _SENSITIVE.forEach(re => { out = out.replace(re, '[redacted]'); });
    return out;
  }

  const SokoniLogger = {
    _isDebug,

    log(...args) {
      if (_isDebug) console.log('[SOKONI]', ...args);
    },

    info(...args) {
      if (_isDebug) console.info('[SOKONI]', ...args);
    },

    warn(msg, ctx) {
      if (_isDebug) {
        console.warn('[SOKONI WARN]', msg, ctx != null ? ctx : '');
      }
      /* In production: silent. Warnings are transient state, not actionable by users. */
    },

    error(msg, ctx) {
      /* Errors always surface — but PII is stripped in production */
      if (_isDebug) {
        console.error('[SOKONI ERROR]', msg, ctx != null ? ctx : '');
      } else {
        const safe = _sanitize(typeof msg === 'string' ? msg : (msg && msg.message) || 'Unexpected error');
        console.error('[SOKONI]', safe);
      }
    },

    track(event, data) {
      if (_isDebug) console.log('[SOKONI EVENT]', event, data);
    },

    /* Enable/disable debug at runtime without reload (development only) */
    enableDebug() {
      try { localStorage.setItem('sokoni_debug', 'true'); } catch (_) {}
      console.info('[SOKONI] Debug logging enabled. Reload to apply.');
    },
    disableDebug() {
      try { localStorage.removeItem('sokoni_debug'); } catch (_) {}
      console.info('[SOKONI] Debug logging disabled. Reload to apply.');
    },
  };

  window.SokoniLogger = SokoniLogger;
})(window);
