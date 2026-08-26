/* ================================================================
   SOKONI Fresh-Session Security Gate — sokoni-appcheck-gate.js

   INTENDED FRESH-VISIT ORDER (phone and laptop):

       fresh visit
         1) App Check / reCAPTCHA v3  — "Securing your session…"  (invisible)
         2) Human verification        — "I'm not a robot" reCAPTCHA v2 checkbox
                                         (Google shows the image challenge when its
                                          own risk assessment requires it)
         3) Login / Sign Up gate
         4) Normal authentication / OTP  (unchanged, in auth.js)

   A visitor with cleared cache / history / localStorage must NOT reach the
   Login/Sign Up gate before BOTH (1) App Check initialisation AND (2) the human
   verification have completed. The overlay blocks render (never the sign-in API
   calls) and lifts only when each stage passes.

   FAIL CLOSED
   -----------
   - App Check init threw (window.__sokoniAppCheckInitFailed === true) -> blocked.
   - App Check readiness signal never appears within the ceiling      -> blocked.
   - reCAPTCHA v2 fails to load / errors                              -> blocked.
   - The v2 token EXPIRES before use                                  -> reset,
     the box must be ticked again; the user cannot proceed meanwhile.
   A merely REJECTED/TIMED-OUT App Check *token* is NOT an init failure (iOS Safari
   under ITP rejects intermittently): the SDK initialised, so stage 1 passes. The
   sign-in API calls keep their own behaviour — this gate never blocks them.

   THE reCAPTCHA v2 KEYS
   ---------------------
   RECAPTCHA_V2_SITEKEY below is the PUBLIC site key of a reCAPTCHA **v2 "I'm not a
   robot"** key registered for this domain. It is DIFFERENT from the App Check v3
   key in firebase.js. Only the public site key lives here; the SECRET key never
   appears in client code (server-side verification, if added later, owns it).

   OPT-IN — set on <html>:
     data-appcheck-gate="app"   entry surfaces (homepage): after App Check + human
                                verification, reveal the app for a signed-in
                                visitor, else show the Login/Sign Up routing gate.
     data-appcheck-gate="form"  login/sign-up surfaces: after App Check + human
                                verification, reveal the form.

   NON-GOALS: does not weaken/bypass App Check, does not change Firestore rules,
   does not modify auth.js, does not replace login.html.
   ================================================================ */
(function () {
  'use strict';

  var MODE = document.documentElement.getAttribute('data-appcheck-gate');
  if (!MODE) return;                              /* opt-in only */
  if (window.self !== window.top) return;         /* never gate inside an iframe */

  /* ── Configuration ──────────────────────────────────────────────────────── */
  /* PUBLIC reCAPTCHA v2 "I'm not a robot" site key for this domain. MUST be a v2
     checkbox key — the App Check v3 key will NOT render a checkbox. Replace with
     the production v2 key registered for mysokoni.co.ke (and the preview domain).
     Value below is the PRODUCTION reCAPTCHA **Enterprise** checkbox site key (public),
     created in Google Cloud → Fraud Defense → reCAPTCHA, registered for mysokoni.co.ke
     and the preview host, challenge-security = Hard. Because it is an ENTERPRISE key it
     uses the enterprise API (grecaptcha.enterprise.render + enterprise.js), NOT the
     classic grecaptcha.render/api.js — a classic call against this key returns
     "Invalid domain for site key". Google decides when a visual image-selection
     challenge appears; this key is challenge-capable. Only the PUBLIC site key lives
     here — the secret / API credential never appears in client code. */
  var RECAPTCHA_V2_SITEKEY = '6LflPpotAAAAAHWtYPyEegVbPv3PLjcE_rp_UwKf';
  var HUMAN_VERIFIED_KEY = 'sk_human_verified';   /* per-session, so the box is asked once */
  var APPCHECK_CEILING_MS = 15000;
  var RECAPTCHA_CEILING_MS = 20000;
  var ACCENT = '#71ff00';
  var BG = '#050505';
  var _started = Date.now();
  var _resolved = false;
  var _widgetId = null;

  /* ── Blocking overlay, painted immediately ──────────────────────────────── */
  var host = document.createElement('div');
  host.id = 'sk-acg';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-label', 'Securing your session');
  host.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:' + BG + ';' +
    'display:flex;align-items:center;justify-content:center;' +
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
    'color:#fff;padding:24px;text-align:center;';
  host.innerHTML =
    '<style>' +
    '@keyframes skAcgSpin{to{transform:rotate(360deg)}}' +
    '@keyframes skAcgFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}' +
    '#sk-acg .sk-acg-card{max-width:360px;animation:skAcgFade .3s ease both}' +
    '#sk-acg .sk-acg-spin{width:46px;height:46px;margin:0 auto 18px;border-radius:50%;' +
    'border:3px solid rgba(255,255,255,.14);border-top-color:' + ACCENT + ';animation:skAcgSpin .9s linear infinite}' +
    '#sk-acg h1{font-size:16px;font-weight:800;margin:0 0 8px;letter-spacing:.01em}' +
    '#sk-acg p{font-size:13px;line-height:1.55;color:rgba(255,255,255,.66);margin:0}' +
    '#sk-acg #sk-acg-recaptcha{margin:18px auto 4px;display:flex;justify-content:center;min-height:78px}' +
    '#sk-acg .sk-acg-actions{margin-top:22px;display:flex;flex-direction:column;gap:10px}' +
    '#sk-acg .sk-acg-btn{display:block;min-height:48px;line-height:48px;border-radius:12px;' +
    'font-size:15px;font-weight:800;text-decoration:none;cursor:pointer;border:0;width:100%}' +
    '#sk-acg .sk-acg-btn.primary{background:' + ACCENT + ';color:#04140a}' +
    '#sk-acg .sk-acg-btn.ghost{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.24)}' +
    '</style>' +
    '<div class="sk-acg-card">' +
      '<div class="sk-acg-spin" aria-hidden="true"></div>' +
      '<h1 id="sk-acg-title">Securing your session…</h1>' +
      '<p id="sk-acg-msg">Verifying this is a safe connection before you continue.</p>' +
      '<div id="sk-acg-recaptcha" style="display:none"></div>' +
      '<div class="sk-acg-actions" id="sk-acg-actions"></div>' +
    '</div>';

  function mount() { if (!document.getElementById('sk-acg')) (document.body || document.documentElement).appendChild(host); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
  try { document.documentElement.appendChild(host); } catch (_) {}

  /* ── Small DOM helpers ──────────────────────────────────────────────────── */
  function setText(id, t) { var el = host.querySelector('#' + id); if (el) el.textContent = t; }
  function hideSpinner() { var s = host.querySelector('.sk-acg-spin'); if (s) s.style.display = 'none'; }
  function showSpinner() { var s = host.querySelector('.sk-acg-spin'); if (s) s.style.display = ''; }
  function setActions(items) {
    var box = host.querySelector('#sk-acg-actions'); if (!box) return;
    box.innerHTML = '';
    items.forEach(function (it) {
      var el = document.createElement(it.href ? 'a' : 'button');
      el.className = 'sk-acg-btn ' + (it.cls || 'ghost');
      el.textContent = it.label;
      if (it.href) el.setAttribute('href', it.href);
      if (it.onClick) el.addEventListener('click', it.onClick);
      box.appendChild(el);
    });
  }
  function recaptchaBox(show) { var b = host.querySelector('#sk-acg-recaptcha'); if (b) b.style.display = show ? 'flex' : 'none'; }

  /* ── Terminal outcomes ──────────────────────────────────────────────────── */
  function reveal() {
    if (_resolved) return; _resolved = true;
    host.style.transition = 'opacity .35s ease'; host.style.opacity = '0';
    setTimeout(function () { if (host.parentNode) host.parentNode.removeChild(host); }, 380);
  }
  function failClosed(msg) {
    _resolved = true;               /* overlay STAYS — the app is never revealed */
    hideSpinner(); recaptchaBox(false);
    setText('sk-acg-title', 'Security check unavailable');
    setText('sk-acg-msg', msg || 'We couldn’t complete the security check. Please refresh to try again.');
    setActions([{ label: 'Refresh', cls: 'primary', onClick: function () { location.reload(); } }]);
  }
  function showLoginGate() {
    _resolved = true;               /* overlay STAYS — it is now the Login/Sign Up gate */
    hideSpinner(); recaptchaBox(false);
    setText('sk-acg-title', 'Welcome to SOKONI');
    setText('sk-acg-msg', 'Log in or create an account to continue.');
    var next = encodeURIComponent(location.pathname + location.search);
    setActions([
      { label: 'Log In',  cls: 'primary', href: 'login.html?next=' + next },
      { label: 'Sign Up', cls: 'ghost',   href: 'signup.html?next=' + next },
    ]);
  }

  /* ── Stage 2: human verification (reCAPTCHA v2 checkbox) ─────────────────── */
  function humanVerify(next) {
    var already = false;
    try { already = sessionStorage.getItem(HUMAN_VERIFIED_KEY) === '1'; } catch (_) {}
    if (already) { next(); return; }               /* one human check per session */

    hideSpinner();
    setText('sk-acg-title', 'Verify you’re human');
    setText('sk-acg-msg', 'Tick the box to continue. You may be asked to complete a quick image check.');
    setActions([]);
    recaptchaBox(true);

    var done = false;
    function onSolved(token) {
      if (done || !token) return; done = true;
      try { sessionStorage.setItem(HUMAN_VERIFIED_KEY, '1'); } catch (_) {}
      recaptchaBox(false); showSpinner();
      setText('sk-acg-title', 'Verified'); setText('sk-acg-msg', 'One moment…');
      next();
    }
    function onExpired() {
      /* Token expired before it was used — force a fresh tick; cannot proceed. */
      try { var g = enterprise(); if (g && _widgetId !== null) g.reset(_widgetId); } catch (_) {}
      setText('sk-acg-msg', 'That check expired — please tick the box again to continue.');
    }
    function onError() {
      failClosed('The human-verification check could not be completed. Please refresh and try again.');
    }
    loadRecaptcha(onSolved, onExpired, onError);
  }

  /* The Enterprise namespace (grecaptcha.enterprise), or null until it is ready. */
  function enterprise() {
    return (window.grecaptcha && window.grecaptcha.enterprise &&
            typeof window.grecaptcha.enterprise.render === 'function')
      ? window.grecaptcha.enterprise : null;
  }

  function renderWidget(onSolved, onExpired, onError) {
    if (_widgetId !== null) return;
    var g = enterprise();
    if (!g) { onError(); return; }
    try {
      _widgetId = g.render(host.querySelector('#sk-acg-recaptcha'), {
        sitekey: RECAPTCHA_V2_SITEKEY,
        theme: 'dark',
        callback: onSolved,
        'expired-callback': onExpired,
        'error-callback': onError,
      });
    } catch (e) { onError(); }
  }

  function loadRecaptcha(onSolved, onExpired, onError) {
    var start = Date.now();
    /* ENTERPRISE key -> enterprise API. App Check loads the CLASSIC grecaptcha for its
       v3 provider; enterprise.js augments grecaptcha with the .enterprise namespace, so
       we wait for grecaptcha.enterprise.render specifically (not classic render). */
    if (enterprise()) { renderWidget(onSolved, onExpired, onError); return; }
    window.__skRecaptchaOnload = function () {
      var g = enterprise();
      if (g && typeof g.ready === 'function') { g.ready(function () { renderWidget(onSolved, onExpired, onError); }); }
      else renderWidget(onSolved, onExpired, onError);
    };
    if (!document.getElementById('sk-acg-recaptcha-api')) {
      var s = document.createElement('script');
      s.id = 'sk-acg-recaptcha-api';
      s.src = 'https://www.google.com/recaptcha/enterprise.js?onload=__skRecaptchaOnload&render=explicit';
      s.async = true; s.defer = true;
      s.onerror = function () { onError(); };      /* load failure -> fail closed */
      document.head.appendChild(s);
    }
    /* Ceiling: if the widget never renders (blocked, offline, key rejected), fail closed. */
    (function poll() {
      if (_widgetId !== null || _resolved) return;
      if (Date.now() - start > RECAPTCHA_CEILING_MS) { onError(); return; }
      if (enterprise()) { renderWidget(onSolved, onExpired, onError); return; }
      setTimeout(poll, 120);
    })();
  }

  /* ── After App Check init: route through human verification, then reveal ──── */
  function afterInit() {
    if (window.__sokoniAppCheckInitFailed === true) { failClosed(); return; }
    if (MODE === 'form') { humanVerify(reveal); return; }
    var loggedIn = false;
    try { loggedIn = localStorage.getItem('loggedIn') === 'true'; } catch (_) {}
    if (loggedIn) { reveal(); return; }            /* signed-in: not authenticating, no human check */
    humanVerify(showLoginGate);                    /* signed-out: human check BEFORE Login/Sign Up */
  }

  /* ── Stage 1: wait for App Check initialisation ─────────────────────────── */
  (function waitForReady() {
    if (_resolved) return;
    if (Date.now() - _started > APPCHECK_CEILING_MS) { failClosed('The security check did not start in time. Please refresh.'); return; }
    var ready = window.__sokoniAppCheckReady;
    if (ready && typeof ready.then === 'function') {
      var settled = false;
      var guard = setTimeout(function () { if (!settled) { settled = true; afterInit(); } },
        Math.max(0, APPCHECK_CEILING_MS - (Date.now() - _started)));
      ready.then(function () { if (!settled) { settled = true; clearTimeout(guard); afterInit(); } })
           .catch(function () { if (!settled) { settled = true; clearTimeout(guard); afterInit(); } });
      return;
    }
    setTimeout(waitForReady, 60);
  })();
})();
