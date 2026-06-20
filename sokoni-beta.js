/* ================================================================
   SOKONI BETA  v1.0
   Core tracking, bug reporting, feedback & error logging.
   Firestore collections: beta_events, beta_bugs, beta_feedback,
                          beta_errors, beta_testers
================================================================ */
(function (global) {
  'use strict';

  const VER       = '1.0';
  const LS_MODE   = '_sokoniBetaMode';
  const LS_TESTER = '_sokoniBetaTester';
  const LS_QUEUE  = '_sokoniBetaQueue';

  /* ── helpers ── */
  function _uid() {
    try {
      const u = JSON.parse(localStorage.getItem('sokoniUser') || '{}');
      return u.uid || u.id || 'anon';
    } catch { return 'anon'; }
  }

  function _tester() {
    try { return JSON.parse(localStorage.getItem(LS_TESTER) || '{}'); } catch { return {}; }
  }

  function _meta(extra) {
    return Object.assign({
      page     : location.pathname + location.search,
      referrer : document.referrer ? new URL(document.referrer).pathname : '',
      uid      : _uid(),
      testerId : _tester().id   || null,
      role     : _tester().role || null,
      ts       : Date.now(),
      ua       : navigator.userAgent.slice(0, 100),
      v        : VER,
    }, extra || {});
  }

  /* ── Firestore save with localStorage fallback ── */
  function _save(collection, data) {
    const entry = Object.assign({ _col: collection }, data);
    if (window.SokoniDB && SokoniDB.saveApplication) {
      try { SokoniDB.saveApplication(Object.assign({}, entry, { category: collection })); return; } catch {}
    }
    try {
      const q = JSON.parse(localStorage.getItem(LS_QUEUE) || '[]');
      q.push(entry);
      localStorage.setItem(LS_QUEUE, JSON.stringify(q.slice(-500)));
    } catch {}
  }

  /* ── Flush queued events once Firestore ready ── */
  function _flush() {
    if (!window.SokoniDB || !SokoniDB.saveApplication) return;
    try {
      const q = JSON.parse(localStorage.getItem(LS_QUEUE) || '[]');
      if (!q.length) return;
      q.forEach(e => { try { SokoniDB.saveApplication(Object.assign({}, e, { category: e._col || 'beta_events' })); } catch {} });
      localStorage.removeItem(LS_QUEUE);
    } catch {}
  }

  /* ── Auto-capture JS errors ── */
  function _initErrorCapture() {
    window.addEventListener('error', function (e) {
      SokoniBeta.logError({ msg: e.message, file: e.filename, line: e.lineno, col: e.colno, stack: (e.error && e.error.stack || '').slice(0, 400) });
    });
    window.addEventListener('unhandledrejection', function (e) {
      SokoniBeta.logError({ msg: 'UnhandledPromise: ' + String(e.reason), stack: (e.reason && e.reason.stack || '').slice(0, 400) });
    });
  }

  /* ── Auto page-visit tracking ── */
  function _trackPageVisit() {
    if (!localStorage.getItem(LS_MODE)) return;
    SokoniBeta.track('page_visit', { title: document.title.slice(0, 60) });
  }

  /* ── Public API ── */
  var SokoniBeta = {

    isActive: function () { return !!localStorage.getItem(LS_MODE); },

    /* Track any user journey event */
    track: function (event, data) {
      _save('beta_events', _meta(Object.assign({ event: event }, data || {})));
    },

    /* File a bug report */
    reportBug: function (data) {
      var id = 'BUG' + Date.now().toString(36).toUpperCase();
      _save('beta_bugs', _meta(Object.assign({ id: id, status: 'open' }, data || {})));
      return id;
    },

    /* Submit satisfaction / idea feedback */
    submitFeedback: function (data) {
      _save('beta_feedback', _meta(data || {}));
    },

    /* Log a JS or network error */
    logError: function (data) {
      _save('beta_errors', _meta(data || {}));
    },

    /* Register a new beta tester */
    registerTester: function (profile) {
      var tester = Object.assign({
        id          : 'TST' + Date.now().toString(36).toUpperCase(),
        registeredAt: Date.now(),
        registeredPage: location.pathname,
      }, profile || {});
      localStorage.setItem(LS_TESTER, JSON.stringify(tester));
      localStorage.setItem(LS_MODE, '1');
      _save('beta_testers', tester);
      return tester;
    },

    getTester     : function () { return _tester(); },
    activate      : function () { localStorage.setItem(LS_MODE, '1'); },
    deactivate    : function () { localStorage.removeItem(LS_MODE); localStorage.removeItem(LS_TESTER); },
    flushQueue    : _flush,
  };

  _initErrorCapture();
  window.addEventListener('load', function () {
    setTimeout(_flush, 3000);
    _trackPageVisit();
  });

  global.SokoniBeta = SokoniBeta;

})(window);
