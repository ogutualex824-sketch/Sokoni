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
  var HIST  = 'sokoni_crash_history';   /* up to MAX_HISTORY incomplete runs */
  var MAX_HISTORY = 10;
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
        /* Append rather than replace. A single PREV slot means the reload after
           crash 2 destroys crash 1, and the three-matching-runs threshold could
           never be met — the instrument would quietly defeat its own workflow. */
        var hist = [];
        try { hist = JSON.parse(localStorage.getItem(HIST) || '[]'); } catch (_) {}
        hist.push(previous);
        while (hist.length > MAX_HISTORY) hist.shift();
        try { localStorage.setItem(HIST, JSON.stringify(hist)); } catch (_) {}
      }
    }
  } catch (_) {}

  /* ── Boot phases ─────────────────────────────────────────────────────────
     Dozens of individual script names are not actionable; a phase is. Scripts
     are mapped to the subsystem they belong to, so the last script to load also
     names the phase the tab died in — without needing a single hook inside
     application code. If reports consistently end in one phase, finer
     instrumentation goes there next, and nowhere else. */
  var PHASE_OF = [
    [/^(firebase|firebase-config|sokoni-config)/i,          'FIREBASE'],
    [/^(auth|security|sokoni-appcheck|sokoni-zero-trust)/i, 'AUTH'],
    [/^(pos-db|pos-sync|sokoni-offline|idb)/i,              'INDEXEDDB'],
    [/(print|printer|receipt|bluetooth|p58e)/i,             'PRINTER'],
    [/^(pos-omni|pos-modules|pos-inventory|pos-products)/i, 'SYNC'],
    [/^(shared-header|sokoni-nav|sokoni-footer|splash)/i,   'UI'],
    [/^pos\./i,                                             'UI'],
  ];
  function phaseOf(name) {
    for (var i = 0; i < PHASE_OF.length; i++) if (PHASE_OF[i][0].test(name)) return PHASE_OF[i][1];
    return 'BOOT';
  }

  /* One id per launch, so several crash reports can be told apart and compared
     rather than merged into an average that describes no real run. */
  function newId() {
    try {
      if (window.crypto && crypto.getRandomValues) {
        var a = new Uint8Array(8); crypto.getRandomValues(a);
        return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      }
    } catch (_) {}
    return String(Date.now()) + '-' + Math.floor(Math.random() * 1e6);
  }

  var ua = navigator.userAgent || '';
  var iosMatch = ua.match(/OS (\d+)[_.](\d+)/);

  var run = {
    sessionId:  newId(),
    startedAt:  new Date().toISOString(),
    launchTime: t0,
    ua:         ua.slice(0, 200),
    iosVersion: iosMatch ? iosMatch[1] + '.' + iosMatch[2] : null,
    standalone: !!(window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)),
    /* deviceMemory is Chromium-only; recorded when present so a device with a
       small ceiling is visible, never relied upon. */
    deviceMemory: (navigator.deviceMemory || null),
    buildHash:  null,
    phase:      'BOOT',
    lastStage:  'boot',
    stages:     [],
    scripts:    [],
    network:    { lastRequested: null, lastCompleted: null },
    errors:     [],
    memory:     [],
  };

  /* Build identity, so a report can be tied to the deployed bytes rather than
     to whatever the repository happens to contain when it is read. */
  try {
    var me = document.currentScript && document.currentScript.src;
    if (me) run.buildHash = me.split('?')[1] || null;
  } catch (_) {}

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

  /* Stage duration, not just arrival. The time spent in the last completed
     stage is usually more informative than its name — a stage that normally
     takes 20ms and took 4s before the kill points at the subsystem far more
     precisely than the stage boundary alone. */
  var seqCounter = 0;
  function stage(name, extra) {
    var now = Date.now() - t0;
    var prev = run.stages[run.stages.length - 1];
    if (prev && prev.finished == null) {
      prev.finished = now;
      prev.duration = now - prev.started;
    }
    run.lastStage = name;
    var entry = { seq: ++seqCounter, stage: name, started: now, finished: null, duration: null };
    var mem = sample();
    if (mem !== null) { entry.heapMB = mem; run.memory.push({ stage: name, heapMB: mem }); }
    if (extra) entry.detail = extra;
    run.stages.push(entry);
    persist();
  }
  window.sokoniStage = stage;

  /* ── Network: requested is not the same as evaluated ─────────────────────
     A script can be requested, arrive, and still kill the tab while being
     compiled or executed. Recording request start and completion separately
     from script evaluation distinguishes "died waiting for the network" from
     "died running what the network delivered". */
  try {
    if (window.PerformanceObserver) {
      new PerformanceObserver(function (list) {
        var es = list.getEntries();
        for (var i = 0; i < es.length; i++) {
          var e = es[i];
          var nm = String(e.name || '').split('/').pop().split('?')[0];
          if (!nm) continue;
          run.network.lastRequested = { name: nm, atMs: Math.round(e.startTime) };
          if (e.responseEnd) {
            run.network.lastCompleted = {
              name: nm,
              atMs: Math.round(e.responseEnd),
              ms: Math.round(e.duration),
              bytes: e.transferSize || null,
            };
          }
        }
        persist();
      }).observe({ type: 'resource', buffered: true });
    }
  } catch (_) {}

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
          var ph = phaseOf(name);
          run.scripts.push({ i: idx, name: name, atMs: Date.now() - t0, ok: true, phase: ph });
          if (ph !== 'BOOT') run.phase = ph;
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

  /* ── Service worker + connectivity lifecycle ─────────────────────────────
     controllerchange was shown to cause a reload (sw-register.js), but NOT that
     a Flight Mode toggle necessarily installs a new worker — controllerchange
     can fire for several reasons and the distinction decides the fix. These
     record which actually happened rather than inferring it:

       updatefound + new script URL  -> a genuine update installed
       controllerchange, no updatefound -> controller replaced, nothing new
       online/offline with neither   -> reconnect only; the reload is elsewhere */
  run.sw = { scriptURL: null, state: null, updatefound: false, controllerchange: false, events: [] };
  run.network = { online: navigator.onLine, transitions: [] };

  function swEvent(name, detail) {
    run.sw.events.push({ event: name, atMs: Date.now() - t0, detail: detail || null });
    stage('sw:' + name, detail);
  }

  try {
    if (navigator.serviceWorker) {
      const c = navigator.serviceWorker.controller;
      if (c) { run.sw.scriptURL = c.scriptURL; run.sw.state = c.state; }

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        run.sw.controllerchange = true;
        const n = navigator.serviceWorker.controller;
        swEvent('controllerchange', n ? n.scriptURL.split('/').pop() : 'none');
      });

      navigator.serviceWorker.getRegistration().then((reg) => {
        if (!reg) return;
        run.sw.state = (reg.active && reg.active.state) || null;
        reg.addEventListener('updatefound', () => {
          run.sw.updatefound = true;
          swEvent('updatefound', reg.installing ? reg.installing.scriptURL.split('/').pop() : null);
        });
      }).catch(() => {});
    }
  } catch (_) {}

  /* Connectivity transitions, stamped. If a reload follows an online event with
     no updatefound, the service worker did not update and the cause is
     something else — which is the question that cannot be answered by reading
     code. */
  window.addEventListener('online',  () => {
    run.network.online = true;
    run.network.transitions.push({ to: 'online', atMs: Date.now() - t0 });
    stage('network:online');
  });
  window.addEventListener('offline', () => {
    run.network.online = false;
    run.network.transitions.push({ to: 'offline', atMs: Date.now() - t0 });
    stage('network:offline');
  });

  /* ── Report ────────────────────────────────────────────────────────────── */
  window.sokoniCrashReport = function () {
    var prev = null;
    try { prev = JSON.parse(localStorage.getItem(PREV) || 'null'); } catch (_) {}

    console.log('%c SOKONI CRASH REPORT ', 'background:#ff3c3c;color:#fff;font-weight:bold');
    if (!prev) {
      console.log('  No incomplete previous run recorded.');
      console.log('  Reproduce the crash, reopen this page, then run sokoniCrashReport() again.');
    } else {
      console.log('  PREVIOUS RUN DIED IN PHASE: ' + (prev.phase || 'BOOT'));
      console.log('  last stage: ' + prev.lastStage);
      console.log('  sessionId: ' + (prev.sessionId || 'n/a') + '   iOS ' + (prev.iosVersion || '?'));
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

  /* ── Compare runs ────────────────────────────────────────────────────────
     Reading several JSON blobs by eye is where a pattern gets missed. This
     renders the recorded crashes as one table and applies the threshold agreed
     for this incident: three or more runs ending in the same phase is evidence
     worth acting on; a scatter across phases is not, and means either broader
     memory pressure or more than one failure mode.

     The verdict is deliberately conservative — it says "keep collecting" far
     more readily than "you have your answer", because acting on one anomalous
     run is how an investigation restarts from scratch. */
  window.sokoniCrashCompare = function () {
    var hist = [];
    try { hist = JSON.parse(localStorage.getItem(HIST) || '[]'); } catch (_) {}

    console.log('%c SOKONI CRASH COMPARISON ', 'background:#ff3c3c;color:#fff;font-weight:bold');
    if (!hist.length) {
      console.log('  No crashes recorded yet. Reproduce, reopen, then run this again.');
      return { runs: [], verdict: 'NO_DATA' };
    }

    var rows = hist.map(function (r, i) {
      var last = r.stages && r.stages.length ? r.stages[r.stages.length - 1] : null;
      return {
        run:       i + 1,
        mode:      r.standalone ? 'PWA' : 'Safari',
        ios:       r.iosVersion || '?',
        phase:     r.phase || 'BOOT',
        seq:       last ? last.seq : null,
        lastStage: r.lastStage,
        lastResource: (r.network && r.network.lastCompleted && r.network.lastCompleted.name) || null,
        durationMs: last ? (last.duration != null ? last.duration : last.started) : null,
        errors:    (r.errors && r.errors.length) || 0,
      };
    });
    console.table(rows);

    /* Which phase dominates, and by how much. */
    var byPhase = {};
    rows.forEach(function (r) { byPhase[r.phase] = (byPhase[r.phase] || 0) + 1; });
    var top = Object.keys(byPhase).sort(function (a, b) { return byPhase[b] - byPhase[a]; })[0];
    var topCount = byPhase[top];

    /* Same terminal sequence number across runs means the crash lands at the
       same instruction every time, not merely in the same broad phase. */
    var seqs = rows.map(function (r) { return r.seq; }).filter(function (s) { return s != null; });
    var seqStable = seqs.length > 1 && seqs.every(function (s) { return s === seqs[0]; });

    var verdict;
    if (topCount >= 3) {
      verdict = 'CONVERGED:' + top;
      console.log('%c  ' + topCount + ' of ' + rows.length + ' runs ended in ' + top +
                  ' — threshold met, investigate this subsystem ',
                  'background:#71ff00;color:#000;font-weight:bold');
      if (seqStable) console.log('  Every run stopped at seq ' + seqs[0] + ' — the crash is at a fixed point, not timing-dependent.');
    } else if (rows.length < 3) {
      verdict = 'INSUFFICIENT_DATA';
      console.log('  Only ' + rows.length + ' run(s). Collect at least 3 before changing code.');
    } else {
      verdict = 'SCATTERED';
      console.log('  Runs ended in different phases: ' + JSON.stringify(byPhase));
      console.log('  That suggests broader memory pressure or more than one failure mode.');
      console.log('  Collect more evidence rather than optimising a phase that only sometimes fails.');
    }

    console.log('\n  Full artifact — copy(JSON.stringify(sokoniCrashCompare.runs, null, 2))');
    window.sokoniCrashCompare.runs = hist;
    return { runs: rows, byPhase: byPhase, seqStable: seqStable, verdict: verdict };
  };

  window.sokoniCrashClear = function () {
    try { localStorage.removeItem(HIST); localStorage.removeItem(PREV); localStorage.removeItem(KEY); } catch (_) {}
    console.log('  crash history cleared');
  };

  /* ── On-screen tap diagnostic ────────────────────────────────────────────
     A merchant's phone has no DevTools, so a console-only diagnostic cannot be
     run where the fault actually occurs — the evidence stays unreachable on the
     one device that has it. Visiting the page with ?diag=tap renders the result
     on screen and copies it to the clipboard.

     This file already loads first on pos.html, so carrying it here needs no new
     script tag on a page that is otherwise frozen.

     It only runs when the parameter is present: no cost, no DOM, no listeners
     on a normal load. */
  function renderTapDiagnostic() {
    const sel  = new URLSearchParams(location.search).get('sel') || '.product-tile';
    const card = document.querySelector(sel);
    const lines = [];
    const say = (k, v) => lines.push(k + ': ' + v);

    say('url', location.pathname);
    say('selector', sel);

    if (!card) {
      say('VERDICT', 'NO ELEMENT MATCHES — nothing rendered, not an overlay problem');
    } else {
      const r = card.getBoundingClientRect();
      say('rect', Math.round(r.width) + 'x' + Math.round(r.height));
      if (!r.width || !r.height) {
        say('VERDICT', 'ZERO SIZE — occupies no pixels, a layout problem');
      } else {
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit) {
          say('VERDICT', 'NOTHING AT CENTRE — scrolled out of view');
        } else {
          let n = hit, id = null, d = 0;
          while (n && d < 12) { if (n.id) { id = n.id; break; } n = n.parentElement; d++; }
          const cs = getComputedStyle(hit);
          const reaches = hit === card || card.contains(hit);
          say('hit', hit.tagName.toLowerCase() + (hit.className ? '.' + String(hit.className).split(' ')[0] : ''));
          say('nearestId', id || '(none)');
          say('display', cs.display);
          say('pointerEvents', cs.pointerEvents);
          say('zIndex', cs.zIndex);
          say('position', cs.position);
          say('VERDICT', reaches ? 'REACHES TILE — not an overlay problem'
                                 : 'BLOCKED by ' + (id || hit.tagName.toLowerCase()));
        }
      }
    }
    /* Include the lifecycle decisions: if the banner ever showed, its record is
       here, and it answers whether a controllerchange happened at all. */
    try {
      const dec = JSON.parse(localStorage.getItem('sokoni_lifecycle_decisions') || '[]');
      say('lifecycleDecisions', dec.length ? dec.map(x => x.decision + '/' + x.cartItems).join(' ') : 'none');
    } catch (_) {}

    const text = lines.join('\n');
    console.log(text);

    const box = document.createElement('pre');
    box.textContent = text + '\n\n[tap to dismiss]';
    box.style.cssText = 'position:fixed;inset:8px;z-index:2147483647;overflow:auto;margin:0;' +
      'background:#050505;color:#71ff00;font:600 12px/1.5 ui-monospace,monospace;' +
      'padding:14px;border:2px solid #71ff00;border-radius:10px;white-space:pre-wrap';
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);

    try { navigator.clipboard && navigator.clipboard.writeText(text); } catch (_) {}
    return text;
  }
  window.sokoniTapDiag = renderTapDiagnostic;

  if (/[?&]diag=tap/.test(location.search)) {
    /* After load so the grid has rendered — running against an empty DOM would
       report NO ELEMENT and send the investigation somewhere false. */
    window.addEventListener('load', () => setTimeout(renderTapDiagnostic, 1200));
  }

  console.log('%c breadcrumbs armed — sokoniCrashReport() | sokoniCrashCompare() | sokoniTapDiag() ',
              'background:#71ff00;color:#000;font-weight:bold');
})();
