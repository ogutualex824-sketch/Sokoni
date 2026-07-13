/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI PRODUCTION VALIDATION MODE  —  sokoni-validate.js

   Records what actually happened during a real-device session, and changes NOTHING
   about how the platform behaves.

   ── Why this exists ───────────────────────────────────────────────────────────
   Twice on this platform, a green report and reality disagreed:

     Push notifications  reported "sent successfully" → delivered to ZERO devices, for
                         months, with every dashboard green.
     Add Product form    measured "0px overflow, fits perfectly" → was falling off the
                         right edge of the user's screen.

   In both cases the instrument was measuring the wrong thing and reporting success. So
   this module has one rule, and it is the reason it exists:

       NOTHING IS "SENT" UNTIL SOMETHING OUTSIDE THIS PROCESS SAYS IT ARRIVED.

   A queue insert is not a delivery. A 200 from a provider is not a lock-screen
   notification. Those are recorded as `queued`, never as `delivered` — and the dashboard
   shows them 🟡, not 🟢, until a device acknowledges.

   ── OFF by default ────────────────────────────────────────────────────────────
   Enabled ONLY by ?validate=1 (or localStorage sokoni_validate=1). When off, this file
   defines a few no-ops and returns. It patches nothing, listens to nothing, writes
   nothing. It cannot affect a real customer.

   ── How it instruments 523 call sites without touching one ────────────────────
   Every Cloud Function call on the platform goes through
   firebase.functions().httpsCallable(name). In validation mode we wrap THAT — one seam —
   so every CF invocation is captured with its name, payload, result, error and elapsed
   time. No production code path is edited, so nothing can regress when validation is off.

   Usage
     https://mysokoni.co.ke/?validate=1     → mode on, trace id shown, banner visible
     https://mysokoni.co.ke/validation.html → the dashboard for this session
═════════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var doc = global.document;
  if (!doc || global.SokoniValidate) return;

  /* ── Is validation mode on? ───────────────────────────────────────────────── */
  var ON = false;
  try {
    var qp = new URLSearchParams(location.search);
    if (qp.get('validate') === '1') localStorage.setItem('sokoni_validate', '1');
    if (qp.get('validate') === '0') localStorage.removeItem('sokoni_validate');
    ON = localStorage.getItem('sokoni_validate') === '1';
  } catch (e) { ON = false; }

  if (!ON) {
    /* No-op surface, so instrumented code can call it unconditionally and cost nothing. */
    global.SokoniValidate = {
      on: false,
      step: function () {}, ok: function () {}, warn: function () {}, fail: function () {},
      traceId: null, events: function () { return []; },
    };
    return;
  }

  /* ── Correlation ──────────────────────────────────────────────────────────────
     ONE id ties the whole session together — every CF call, every payment step, every
     error. Without it, correlating a payment failure with the auth session that caused
     it means reading timestamps by eye. */
  var TRACE = 'v-' + Date.now().toString(36) + '-' +
              Math.floor(Math.random() * 1e6).toString(36);
  var T0 = performance.now();
  var KEY = 'sokoni_validate_trace';

  var events = [];
  try {
    var prior = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (prior && prior.traceId) { events = prior.events || []; }
  } catch (e) {}

  function persist() {
    try { sessionStorage.setItem(KEY, JSON.stringify({ traceId: TRACE, events: events.slice(-400) })); }
    catch (e) { /* storage full / private mode — the in-memory trace still works */ }
  }

  /* ── Device & environment (Mobile Diagnostics, §6) ────────────────────────── */
  function safeArea() {
    var probe = doc.createElement('div');
    probe.style.cssText =
      'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;' +
      'padding-top:env(safe-area-inset-top,0px);' +
      'padding-bottom:env(safe-area-inset-bottom,0px);' +
      'padding-left:env(safe-area-inset-left,0px);' +
      'padding-right:env(safe-area-inset-right,0px);';
    doc.body.appendChild(probe);
    var cs = getComputedStyle(probe);
    var out = {
      top:    cs.paddingTop, bottom: cs.paddingBottom,
      left:   cs.paddingLeft, right: cs.paddingRight,
    };
    probe.remove();
    return out;
  }

  function diagnostics() {
    var hdr = doc.getElementById('sk-top-nav');
    var de  = doc.documentElement;
    return {
      route:        location.pathname + location.search,
      viewport:     { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      safeArea:     doc.body ? safeArea() : null,
      headerHeight: hdr ? Math.round(hdr.getBoundingClientRect().bottom) : null,
      headerVar:    getComputedStyle(de).getPropertyValue('--sk-header-h').trim() || null,
      /* The bug my tools missed once. Report it every time, on every route. */
      horizontalOverflow: de.scrollWidth - innerWidth,
      scrollContainer: (function () {
        var m = doc.querySelector('#main,[data-scroll-root]');
        return m ? (m.id || 'data-scroll-root') : 'document';
      }()),
      standalone: !!(global.matchMedia && matchMedia('(display-mode: standalone)').matches) ||
                  global.navigator.standalone === true,
      ua: navigator.userAgent,
      online: navigator.onLine,
    };
  }

  /* ── The log ──────────────────────────────────────────────────────────────── */
  function record(module, step, status, data) {
    var e = {
      traceId:  TRACE,
      t:        new Date().toISOString(),
      elapsed:  Math.round(performance.now() - T0),
      module:   module,
      step:     step,
      status:   status,                 /* ok | queued | warn | fail | info */
      route:    location.pathname,
      uid:      (global.firebase && firebase.apps && firebase.apps.length &&
                 firebase.auth && firebase.auth().currentUser &&
                 firebase.auth().currentUser.uid) || null,
      data:     data || null,
    };
    events.push(e);
    persist();

    var tag = status === 'fail' ? '🔴' : status === 'warn' ? '🟡'
            : status === 'queued' ? '🟡' : status === 'ok' ? '🟢' : '·';
    /* Loud on purpose. A tester with Safari Web Inspector open should SEE the trace. */
    (status === 'fail' ? console.error : console.log)(
      '[VALIDATE ' + tag + '] ' + module + ' › ' + step + '  (+' + e.elapsed + 'ms)', data || '');

    try { global.dispatchEvent(new CustomEvent('sokoni-validate', { detail: e })); } catch (x) {}
    return e;
  }

  /* ── §1/§2/§5: instrument EVERY Cloud Function call at one seam ───────────── */
  function patchFunctions() {
    if (!global.firebase || !firebase.functions) return false;
    if (firebase.__skValidatePatched) return true;

    var origFunctions = firebase.functions.bind(firebase);

    firebase.functions = function () {
      var fns = origFunctions.apply(null, arguments);
      if (fns.__skPatched) return fns;
      fns.__skPatched = true;

      var origCallable = fns.httpsCallable.bind(fns);
      fns.httpsCallable = function (name, opts) {
        var call = origCallable(name, opts);
        return function (payload) {
          var t = performance.now();
          record('cloudFunctions', name, 'info', { phase: 'invoke', payload: redact(payload) });
          return call(payload).then(function (res) {
            record('cloudFunctions', name, 'ok', {
              ms: Math.round(performance.now() - t),
              result: redact(res && res.data),
            });
            inspect(name, res && res.data);
            return res;
          }).catch(function (err) {
            /* NEVER swallow. The full error object — code, message, details, stack. */
            record('cloudFunctions', name, 'fail', {
              ms: Math.round(performance.now() - t),
              code:    err && err.code,
              message: err && err.message,
              details: err && err.details,
              stack:   err && err.stack ? String(err.stack).split('\n').slice(0, 4) : null,
              payload: redact(payload),
            });
            throw err;                 /* rethrow — production behaviour is unchanged */
          });
        };
      };
      return fns;
    };
    firebase.__skValidatePatched = true;
    return true;
  }

  /* Never log a secret, a PIN, a card number or a token into a trace that gets shared. */
  var SECRET = /pin|password|secret|token|cvv|card|otp|key/i;
  function redact(o) {
    if (o == null || typeof o !== 'object') return o;
    var out = Array.isArray(o) ? [] : {};
    Object.keys(o).slice(0, 40).forEach(function (k) {
      if (SECRET.test(k)) { out[k] = '«redacted»'; return; }
      var v = o[k];
      out[k] = (v && typeof v === 'object') ? redact(v)
             : (typeof v === 'string' && v.length > 300) ? v.slice(0, 300) + '…' : v;
    });
    return out;
  }

  /* ── Recognise the steps that matter, from the CF results themselves ───────── */
  function inspect(name, data) {
    if (!data) return;

    /* §2 money path */
    if (/verifyIntasend|confirm|payment/i.test(name)) {
      if (data.verified === true || data.status === 'completed') {
        record('payment', 'provider verified payment', 'ok', redact(data));
      } else {
        record('payment', 'provider did NOT confirm', 'warn', redact(data));
      }
    }

    /* §5 purchase order — the delivery field is the whole point */
    if (/sendPurchaseOrder/i.test(name) && data.delivery) {
      var d = data.delivery;
      record('purchaseOrder', 'email ' + d.email, d.email === 'queued' ? 'queued' : 'fail', d);
      record('purchaseOrder', 'sms ' + d.sms,     d.sms === 'queued'   ? 'queued' : 'warn', d);
      record('purchaseOrder', 'QUEUED ≠ DELIVERED — confirm the PDF arrived in the inbox',
             'warn', { poNumber: data.poNumber });
    }

    /* §4 push — the lie we are here to stop telling */
    if (/notify|push/i.test(name)) {
      record('push', 'server accepted the notification', 'queued', redact(data));
      record('push', 'QUEUED ≠ DELIVERED — confirm it appeared on the lock screen',
             'warn', null);
    }
  }

  /* ── §3: authentication trace ─────────────────────────────────────────────── */
  function patchAuth() {
    if (!global.firebase || !firebase.auth || firebase.__skAuthPatched) return false;
    firebase.__skAuthPatched = true;

    record('auth', 'firebase initialized', 'ok', { apps: firebase.apps.length });

    try {
      firebase.auth().onAuthStateChanged(function (u) {
        if (!u) { record('auth', 'signed out / no user', 'info', null); return; }
        record('auth', 'auth state: signed in', 'ok', { uid: u.uid, email: u.email,
                                                        provider: (u.providerData[0] || {}).providerId });
        u.getIdTokenResult().then(function (tok) {
          record('auth', 'custom claims', 'ok', { claims: tok.claims });
        }).catch(function (e) {
          record('auth', 'claims lookup FAILED', 'fail', { code: e.code, message: e.message });
        });

        /* Firestore profile — the step that silently does not happen. */
        if (firebase.firestore) {
          firebase.firestore().collection('users').doc(u.uid).get()
            .then(function (s) {
              record('auth', 'firestore profile', s.exists ? 'ok' : 'fail',
                     s.exists ? { fields: Object.keys(s.data() || {}).length }
                              : { error: 'users/' + u.uid + ' DOES NOT EXIST' });
            })
            .catch(function (e) {
              record('auth', 'firestore profile read FAILED', 'fail',
                     { code: e.code, message: e.message });
            });
        }
      });

      /* getRedirectResult — the OAuth step that fails silently. */
      if (firebase.auth().getRedirectResult) {
        firebase.auth().getRedirectResult()
          .then(function (r) {
            if (r && r.user) record('auth', 'getRedirectResult returned a user', 'ok', { uid: r.user.uid });
            else             record('auth', 'getRedirectResult: no pending redirect', 'info', null);
          })
          .catch(function (e) {
            record('auth', 'getRedirectResult FAILED', 'fail',
                   { code: e.code, message: e.message, email: e.email });
          });
      }
    } catch (e) {
      record('auth', 'auth instrumentation failed', 'fail', { message: e.message });
    }
    return true;
  }

  /* ── §7: performance, from the real device ────────────────────────────────── */
  function perf() {
    if (!global.PerformanceObserver) return;
    var seen = {};

    var obs = function (type, fn) {
      try { new PerformanceObserver(fn).observe({ type: type, buffered: true }); }
      catch (e) {}
    };

    obs('paint', function (l) {
      l.getEntries().forEach(function (e) {
        if (e.name === 'first-contentful-paint' && !seen.fcp) {
          seen.fcp = 1;
          record('performance', 'FCP', e.startTime < 1800 ? 'ok' : 'warn',
                 { ms: Math.round(e.startTime), target: '<1800ms' });
        }
      });
    });

    obs('largest-contentful-paint', function (l) {
      var e = l.getEntries().pop(); if (!e) return;
      seen.lcp = Math.round(e.startTime);
    });

    obs('layout-shift', function (l) {
      l.getEntries().forEach(function (e) {
        if (!e.hadRecentInput) seen.cls = (seen.cls || 0) + e.value;
      });
    });

    obs('event', function (l) {
      l.getEntries().forEach(function (e) {
        if (e.duration > (seen.inp || 0)) seen.inp = Math.round(e.duration);
      });
    });

    /* Report the final values when the page is actually leaving — LCP and CLS are not
       final until then, and a number captured at load is a number that is wrong. */
    var reported = false;
    function flush() {
      if (reported) return; reported = true;
      if (seen.lcp) record('performance', 'LCP', seen.lcp < 2500 ? 'ok' : 'warn',
                           { ms: seen.lcp, target: '<2500ms' });
      if (seen.cls != null) record('performance', 'CLS', seen.cls < 0.1 ? 'ok' : 'warn',
                           { value: Number(seen.cls.toFixed(3)), target: '<0.1' });
      if (seen.inp) record('performance', 'INP', seen.inp < 200 ? 'ok' : 'warn',
                           { ms: seen.inp, target: '<200ms' });
      if (performance.memory) {
        record('performance', 'JS heap', 'info',
               { usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576) });
      }
    }
    addEventListener('pagehide', flush);       /* NOT unload — iOS Safari does not fire it */
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'hidden') flush();
    });
  }

  /* ── Service worker (§10) ─────────────────────────────────────────────────── */
  function sw() {
    if (!navigator.serviceWorker) {
      record('serviceWorker', 'not supported', 'warn', null);
      return;
    }
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) { record('serviceWorker', 'NO registration', 'fail', null); return; }
      record('serviceWorker', 'registered', 'ok', {
        scope: reg.scope,
        active: !!reg.active,
        waiting: !!reg.waiting,          /* a waiting SW = the user is on a stale build */
      });
      if (reg.waiting) {
        record('serviceWorker', 'a NEW worker is waiting — this session is running STALE code',
               'warn', null);
      }
    }).catch(function (e) {
      record('serviceWorker', 'registration lookup failed', 'fail', { message: e.message });
    });
  }

  /* ── Never swallow anything (§9) ──────────────────────────────────────────── */
  function errors() {
    addEventListener('error', function (e) {
      record('errors', 'uncaught exception', 'fail', {
        message: e.message, source: e.filename, line: e.lineno, col: e.colno,
        stack: e.error && e.error.stack ? String(e.error.stack).split('\n').slice(0, 5) : null,
      });
    });
    addEventListener('unhandledrejection', function (e) {
      var r = e.reason || {};
      record('errors', 'unhandled promise rejection', 'fail', {
        code: r.code, message: r.message || String(r),
        stack: r.stack ? String(r.stack).split('\n').slice(0, 5) : null,
      });
    });
    /* Failed network requests — a 4xx/5xx that a page swallowed still lands here. */
    var of = global.fetch;
    if (of) {
      global.fetch = function (input, init) {
        var url = (typeof input === 'string') ? input : (input && input.url) || '';
        var t = performance.now();
        return of.apply(this, arguments).then(function (res) {
          if (!res.ok) {
            record('network', 'HTTP ' + res.status, res.status >= 500 ? 'fail' : 'warn',
                   { url: String(url).slice(0, 160), ms: Math.round(performance.now() - t) });
          }
          return res;
        }).catch(function (err) {
          record('network', 'request FAILED', 'fail',
                 { url: String(url).slice(0, 160), message: err.message });
          throw err;
        });
      };
    }
  }

  /* ── Visible banner: the tester must never be unsure it is on ─────────────── */
  function banner() {
    if (doc.getElementById('sk-validate-banner')) return;
    var b = doc.createElement('div');
    b.id = 'sk-validate-banner';
    b.style.cssText = [
      'position:fixed', 'left:0', 'right:0',
      'bottom:calc(env(safe-area-inset-bottom,0px))',
      'z-index:2147483000',
      'background:#7b2d00', 'color:#fff',
      'font:700 11px/1.3 -apple-system,system-ui,sans-serif',
      'padding:6px 10px', 'display:flex', 'gap:8px',
      'align-items:center', 'justify-content:space-between',
    ].join(';');
    b.innerHTML =
      '<span>🔬 VALIDATION MODE · <code style="font-size:10px">' + TRACE + '</code></span>' +
      '<span><a href="/validation.html" style="color:#ffd28a;font-weight:800">Dashboard</a>' +
      ' · <a href="?validate=0" style="color:#ffd28a">off</a></span>';
    (doc.body || doc.documentElement).appendChild(b);
  }

  /* ── Public API ───────────────────────────────────────────────────────────── */
  global.SokoniValidate = {
    on: true,
    traceId: TRACE,
    step: function (m, s, d) { return record(m, s, 'info', d); },
    ok:   function (m, s, d) { return record(m, s, 'ok', d); },
    warn: function (m, s, d) { return record(m, s, 'warn', d); },
    fail: function (m, s, d) { return record(m, s, 'fail', d); },
    queued: function (m, s, d) { return record(m, s, 'queued', d); },
    events: function () { return events.slice(); },
    diagnostics: diagnostics,
    clear: function () { events = []; persist(); },
    export: function () { return JSON.stringify({ traceId: TRACE, events: events }, null, 2); },
  };

  /* ── Boot ─────────────────────────────────────────────────────────────────── */
  function boot() {
    banner();
    record('session', 'validation mode ON', 'info', diagnostics());
    errors();
    perf();
    sw();

    /* Firebase loads asynchronously; keep trying briefly rather than guessing a delay. */
    var tries = 0;
    (function wait() {
      var okF = patchFunctions();
      var okA = patchAuth();
      if ((okF && okA) || ++tries > 40) {
        if (!okF) record('cloudFunctions', 'firebase.functions never appeared — CF calls NOT traced', 'warn', null);
        return;
      }
      setTimeout(wait, 150);
    }());

    /* Re-run mobile diagnostics on rotate/resize — the values genuinely change. */
    addEventListener('resize', function () {
      clearTimeout(global.__skDiagT);
      global.__skDiagT = setTimeout(function () {
        record('mobile', 'viewport changed', 'info', diagnostics());
      }, 300);
    }, { passive: true });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

})(typeof window !== 'undefined' ? window : this);
