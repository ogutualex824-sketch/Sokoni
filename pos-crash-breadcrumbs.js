/* SOKONI POS crash breadcrumbs.
 *
 * Add ONE tag as the FIRST script in the <head> of the page that crashes:
 *   <script src="pos-crash-breadcrumbs.js"></script>
 *
 * WHY THIS AND NOT CONSOLE LOGGING
 * When WebKit kills a tab, the console goes with it. Anything logged in the
 * moments before the crash is lost, which is why a crash that reproduces every
 * time can still leave no evidence. localStorage writes are synchronous and
 * survive the process dying, so a breadcrumb written before each stage is still
 * there on the next load. The last breadcrumb IS the crash boundary.
 *
 * WHAT IT MEASURES, WITHOUT ASSUMING A CAUSE
 * pos.html loads 62 local scripts totalling ~1.64 MB, 42 of them parser-blocking.
 * That is a measurement, not a diagnosis — it says nothing about whether the tab
 * dies during parse, during module evaluation, during Firebase, during IndexedDB,
 * or during first paint. This records which of those it actually reached.
 *
 * AFTER A CRASH
 * Reopen the page and run:  sokoniCrashReport()
 */
(function () {
  'use strict';

  var KEY   = 'sokoni_crash_breadcrumbs';
  var PREV  = 'sokoni_crash_previous';
  var t0    = Date.now();

  /* Read whatever the previous run left behind BEFORE overwriting it, so a
     crash is never erased by the reload that follows it. */
  var previous = null;
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) {
      previous = JSON.parse(raw);
      /* Only preserve runs that never reached 'ready' — a clean run is not
         evidence and would push a real crash out of the record. */
      if (previous && previous.lastStage !== 'ready') {
        localStorage.setItem(PREV, raw);
      }
    }
  } catch (_) {}

  var run = {
    startedAt: new Date().toISOString(),
    ua:        (navigator.userAgent || '').slice(0, 200),
    standalone: !!(window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)),
    lastStage: 'boot',
    stages:    [],
    scripts:   [],
    errors:    [],
    memory:    [],
  };

  function persist() {
    /* Synchronous by design. An async write would not survive the kill. */
    try { localStorage.setItem(KEY, JSON.stringify(run)); } catch (_) {}
  }

  function sample() {
    /* performance.memory is Chromium-only; absent on Safari. Recorded when
       present rather than depended on, so the instrument works on both. */
    var m = null;
    try {
      if (window.performance && performance.memory) {
        m = Math.round(performance.memory.usedJSHeapSize / 1048576);
      }
    } catch (_) {}
    return m;
  }

  function stage(name, extra) {
    run.lastStage = name;
    var entry = { stage: name, atMs: Date.now() - t0 };
    var mem = sample();
    if (mem !== null) { entry.heapMB = mem; run.memory.push({ stage: name, heapMB: mem }); }
    if (extra) entry.detail = extra;
    run.stages.push(entry);
    persist();
  }
  window.sokoniStage = stage;

  stage('breadcrumbs-installed');

  /* ── Which script was executing when it died ─────────────────────────────
     Every script element gets load/error listeners, so the last one to LOAD is
     recorded. If the tab dies mid-evaluation, the last recorded script is the
     one before the offender — the boundary is between the last logged script
     and the next one in document order, which is enough to name it. */
  function watchScripts() {
    var els = document.getElementsByTagName('script');
    for (var i = 0; i < els.length; i++) {
      (function (el, idx) {
        if (!el.src || el.__sokoniWatched) return;
        el.__sokoniWatched = true;
        var name = el.src.split('/').pop().split('?')[0];
        el.addEventListener('load', function () {
          run.scripts.push({ i: idx, name: name, atMs: Date.now() - t0, ok: true });
          run.lastStage = 'script:' + name;
          persist();
        });
        el.addEventListener('error', function () {
          run.scripts.push({ i: idx, name: name, atMs: Date.now() - t0, ok: false });
          run.errors.push({ type: 'script-load-failed', name: name, atMs: Date.now() - t0 });
          persist();
        });
      })(els[i], i);
    }
  }
  watchScripts();
  /* Scripts added after this file runs still get watched. */
  try {
    new MutationObserver(watchScripts).observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  /* ── Uncaught failures ─────────────────────────────────────────────────── */
  window.addEventListener('error', function (e) {
    run.errors.push({
      type: 'error', atMs: Date.now() - t0,
      message: String(e.message || '').slice(0, 300),
      source: String(e.filename || '').split('/').pop(),
      line: e.lineno, col: e.colno,
    });
    persist();
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    run.errors.push({
      type: 'unhandled-rejection', atMs: Date.now() - t0,
      message: String((e.reason && e.reason.message) || e.reason || '').slice(0, 300),
    });
    persist();
  });

  /* ── Lifecycle milestones ──────────────────────────────────────────────── */
  document.addEventListener('readystatechange', function () { stage('readyState:' + document.readyState); });
  document.addEventListener('DOMContentLoaded', function () { stage('DOMContentLoaded'); });
  window.addEventListener('load', function () {
    stage('window.load');
    /* First paint, if the browser reports it. Distinguishes "died before the
       merchant saw anything" from "died after the shell rendered". */
    try {
      var fp = performance.getEntriesByType('paint');
      for (var i = 0; i < fp.length; i++) stage('paint:' + fp[i].name, Math.round(fp[i].startTime) + 'ms');
    } catch (_) {}
    /* Anything still running after load is a candidate for deferral. */
    setTimeout(function () { stage('ready'); }, 3000);
  });

  /* iOS kills backgrounded tabs under memory pressure; recording the transition
     separates "crashed while in use" from "evicted while backgrounded". */
  document.addEventListener('visibilitychange', function () {
    stage('visibility:' + document.visibilityState);
  });
  window.addEventListener('pagehide', function (e) { stage('pagehide' + (e.persisted ? ':cached' : '')); });

  /* ── Report ────────────────────────────────────────────────────────────── */
  window.sokoniCrashReport = function () {
    var prev = null;
    try { prev = JSON.parse(localStorage.getItem(PREV) || 'null'); } catch (_) {}

    console.log('%c SOKONI CRASH REPORT ', 'background:#ff3c3c;color:#fff;font-weight:bold');
    if (!prev) {
      console.log('  No incomplete previous run recorded.');
      console.log('  Reproduce the crash, reopen this page, then run sokoniCrashReport() again.');
    } else {
      console.log('  PREVIOUS RUN DIED AT: ' + prev.lastStage);
      console.log('  reached ' + prev.stages.length + ' stages, ' +
                  prev.scripts.filter(function (s) { return s.ok; }).length + ' scripts loaded');
      console.log('  standalone (PWA): ' + prev.standalone);
      if (prev.stages.length) {
        var last = prev.stages[prev.stages.length - 1];
        console.log('  last stage at ' + last.atMs + 'ms' + (last.heapMB ? ', heap ' + last.heapMB + 'MB' : ''));
      }
      if (prev.scripts.length) {
        console.log('  last script loaded: ' + prev.scripts[prev.scripts.length - 1].name);
        console.log('  --> the crash is at or just after this script');
      }
      if (prev.errors.length) { console.log('  errors:'); console.table(prev.errors); }
      console.log('\n  Full artifact — copy(JSON.stringify(sokoniCrashReport.previous, null, 2))');
    }
    window.sokoniCrashReport.previous = prev;
    window.sokoniCrashReport.current  = run;
    return { previous: prev, current: run };
  };

  console.log('%c breadcrumbs armed — after a crash run sokoniCrashReport() ',
              'background:#71ff00;color:#000;font-weight:bold');
})();
