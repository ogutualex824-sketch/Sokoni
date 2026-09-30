/* ============================================================================
   SOKONI — Idle Script Loader
   ----------------------------------------------------------------------------
   `defer` stops a script BLOCKING THE PARSER, but the browser still downloads it
   and executes it before the page settles. On the homepage that meant ~158KB of
   JavaScript — the payment SDK, the recommendations engine and Inspiq — parsed
   and run on the main thread for features nothing on screen uses yet. Measured
   2026-08-01: TBT 538ms across 14 long tasks against a 200ms budget.

   This moves those modules to whichever comes FIRST:
     • the browser going idle (requestIdleCallback), or
     • the user's first real interaction.

   Loading on interaction as well as idle is the part that makes this safe. A
   pure idle loader is a gamble that nobody taps before idle fires; here, the
   first pointerdown/keydown/touchstart pulls the modules in immediately, so a
   fast tapper gets them sooner rather than not at all.

   ── What must NOT be listed here ────────────────────────────────────────────
   Anything the page calls during load. sokoni-social.js is referenced 11 times
   inline in index.html, so it stays a normal deferred script — lazy-loading it
   would leave those references undefined. Verify with a reference count before
   adding a module:
       grep -c "SokoniPay" index.html    → 0 means safe

   ── Usage ───────────────────────────────────────────────────────────────────
     <script src="sokoni-lazy.js" defer
             data-lazy="sokoni-pay.js,sokoni-recommendations.js"></script>

   Scripts load in the order given, with the same `defer` semantics they had
   before, and each is loaded at most once even if several pages list it.
   ========================================================================== */
(function () {
  'use strict';

  var loaded = (window.__sokoniLazyLoaded = window.__sokoniLazyLoaded || {});
  var fired = false;

  /* ── Readiness contract ─────────────────────────────────────────────────────
     A page that lists a module here has, by definition, code that wants to call
     it later. Before this contract that code had two bad options: assume the
     module was present at DOMContentLoaded (it never is — that is the point of
     this loader) or poll for it. Measured on production 2026-09-30: the home
     page's recommendations loader took the first option and bailed with
     "module not loaded" on every visit, and the Edit Interests button called
     `InspIQ` before a first tap had loaded it.

     Each script now resolves a promise when it has EXECUTED (its onload), and
     the loader dispatches `sokoni:lazy-loaded` with `{ src }` per script plus
     `sokoni:lazy-complete` once every listed script has settled. A failed load
     settles too (`ok:false`) so a waiter is never left hanging.

       SokoniLazy.load()              start loading now (a user intent, e.g. a tap)
       SokoniLazy.whenLoaded(src)     Promise<boolean> — true when executed, false on error
       SokoniLazy.isLoaded(src)       synchronous check                                    */
  var settled = (window.__sokoniLazySettled = window.__sokoniLazySettled || {});
  var waiters = {};
  var pending = 0;

  function key(src) { return String(src || '').replace(/^\.?\//, '').split('?')[0]; }

  function settle(src, ok) {
    var k = key(src);
    settled[k] = ok ? 'ok' : 'error';
    (waiters[k] || []).forEach(function (r) { try { r(!!ok); } catch (_) {} });
    waiters[k] = [];
    try { window.dispatchEvent(new CustomEvent('sokoni:lazy-loaded', { detail: { src: k, ok: !!ok } })); } catch (_) {}
    pending = Math.max(0, pending - 1);
    if (pending === 0) {
      try { window.dispatchEvent(new CustomEvent('sokoni:lazy-complete', { detail: { loaded: Object.keys(settled) } })); } catch (_) {}
    }
  }

  function whenLoaded(src) {
    var k = key(src);
    if (settled[k]) return Promise.resolve(settled[k] === 'ok');
    return new Promise(function (resolve) { (waiters[k] = waiters[k] || []).push(resolve); });
  }

  function isLoaded(src) { return settled[key(src)] === 'ok'; }

  function loadOne(src) {
    if (!src || loaded[src]) return;
    loaded[src] = true;
    pending++;
    var s = document.createElement('script');
    s.src = src;
    s.async = false;          /* preserve relative execution order */
    s.defer = true;
    s.onload = function () { settle(src, true); };
    /* A lazy module failing must never take the page with it — it was optional
       by definition, which is why it is in this list. */
    s.onerror = function () {
      if (window.console && console.warn) console.warn('[SokoniLazy] failed to load ' + src);
      settle(src, false);
    };
    document.head.appendChild(s);
  }

  function run() {
    if (fired) return;
    fired = true;
    teardown();
    var list = [];
    /* Collect from every tag that declares a list, so pages can add their own. */
    var tags = document.querySelectorAll('script[data-lazy]');
    for (var i = 0; i < tags.length; i++) {
      var v = tags[i].getAttribute('data-lazy') || '';
      v.split(',').forEach(function (x) {
        x = x.trim();
        if (x) list.push(x);
      });
    }
    list.forEach(loadOne);
  }

  window.SokoniLazy = { load: run, whenLoaded: whenLoaded, isLoaded: isLoaded };

  var EVENTS = ['pointerdown', 'touchstart', 'keydown', 'scroll'];
  function teardown() {
    EVENTS.forEach(function (e) {
      window.removeEventListener(e, run, { passive: true, capture: true });
    });
  }
  EVENTS.forEach(function (e) {
    window.addEventListener(e, run, { passive: true, capture: true });
  });

  /* Idle path. requestIdleCallback is unavailable on Safari < 16.4 — which is a
     large share of the iPhone traffic this is meant to help — so the timeout
     fallback is load-bearing, not decorative. */
  function scheduleIdle() {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 4000 });
    } else {
      setTimeout(run, 2500);
    }
  }

  if (document.readyState === 'complete') scheduleIdle();
  else window.addEventListener('load', scheduleIdle, { once: true });
})();
