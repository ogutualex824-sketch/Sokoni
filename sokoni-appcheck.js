/* sokoni-appcheck.js — Firebase App Check (compat SDK pages)
   Loaded after firebase-app-check-compat.js on every compat-SDK page.
   firebase.js (modular) initialises App Check independently. */
(function () {
  'use strict';
  var SITE_KEY = '6Lf93TktAAAAAIqCj8l3YM3dIoS1MIXpilsdnsxj';

  var _done = false;

  /* Canonical web-app config (public by design — same values as firebase.js).
     Prefer a page-provided config when one exists so nothing is overridden. */
  var FB_CONFIG = (window.SOKONI_CONFIG && window.SOKONI_CONFIG.firebase) || window.firebaseConfig || {
    apiKey:            'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE',
    authDomain: 'auth.mysokoni.co.ke',
    projectId:         'sokoni-aeb26',
    storageBucket:     'sokoni-aeb26.firebasestorage.app',
    messagingSenderId: '24799054989',
    appId:             '1:24799054989:web:e1cf6ca8c281bf1abf26c4',
    measurementId:     'G-QT32H65TJS'
  };

  /* Ensure the compat DEFAULT app exists before any page code runs.
     Many compat pages call firebase.auth()/firestore() in an inline script but
     never call initializeApp() themselves — that throws
     "No Firebase App '[DEFAULT]'" and the auth listener is never registered.
     This script is loaded immediately after the compat SDK and before those
     inline scripts, so creating the default app here fixes them all.
     Guarded: if a page already created it, this is a no-op. */
  function _ensureApp() {
    if (typeof firebase === 'undefined' || typeof firebase.initializeApp !== 'function') return;
    try {
      if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(FB_CONFIG);
    } catch (e) {
      console.warn('[SOKONI AppCheck] compat init:', e.message);
    }
  }

  /* Returns true once activation is settled (success or hard failure) so the
     caller can stop retrying. Returns false while we are still waiting for a
     compat Firebase app to exist. */
  function _activate() {
    if (_done) return true;
    if (typeof firebase === 'undefined' || typeof firebase.appCheck !== 'function') return true; /* compat App Check SDK absent — nothing to do */

    /* The compat default app is initialised by inline page scripts that run AFTER
       this file. Calling appCheck() first throws "No Firebase App '[DEFAULT]'",
       leaving compat Firestore/Functions calls with no App Check token. Wait. */
    if (!firebase.apps || !firebase.apps.length) return false;

    _done = true;
    try {
      firebase.appCheck().activate(
        new firebase.appCheck.ReCaptchaV3Provider(SITE_KEY),
        true /* isTokenAutoRefreshEnabled */
      );
      _probe();
    } catch (e) {
      console.warn('[SOKONI AppCheck]', e.message);
    }
    return true;
  }

  /* One-shot health probe — runs exactly once, never retries, so an invalid
     pinned token can never spin the browser. Developer-friendly detail on
     localhost; a generic, internals-free message in production. */
  function _probe() {
    try {
      firebase.appCheck().getToken(/* forceRefresh */ false)
        .then(function () { if (IS_LOCALHOST) console.info('[SOKONI] App Check OK — token exchanged.'); })
        .catch(function (err) {
          if (!IS_LOCALHOST) {
            console.error('[SOKONI] Security verification failed. Please refresh and try again.');
            return;
          }
          console.error('[SOKONI] App Check FAILED — Firebase Auth will not work until fixed.' +
            '\nreason: ' + (err && (err.code || err.message)) +
            (pinned
              ? '\nThe pinned debug token is INVALID or NOT REGISTERED:\n  ' + pinned +
                '\nFix: register it in Firebase Console, or clear it and re-bootstrap:' +
                '\n  localStorage.removeItem(\'' + DEBUG_KEY + '\')  // then reload'
              : '\nNo token pinned — expected first-run 403. Register the token printed above, then pin it.') +
            '\nTroubleshooting: docs/APP_CHECK.md');
        });
    } catch (_) { /* getToken unsupported on this compat build — ignore */ }
  }

  /* Debug token for localhost — must be set before activate().
     Production sends no debug token and attests via reCAPTCHA v3.
     The token must already be registered in Firebase Console; pin it once with
       localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', '<uuid-from-console>')
     The `true` fallback mints an unregistered token (403), which blocks Firebase
     Auth entirely — it exists only to print a token to register on first run.
     Kept in lock-step with the modular path in firebase.js. */
  var IS_LOCALHOST = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]';
  var DEBUG_KEY = 'SOKONI_APPCHECK_DEBUG_TOKEN';
  var pinned = null;

  if (IS_LOCALHOST) {
    try { pinned = localStorage.getItem(DEBUG_KEY); } catch (_) {}
    /* A pinned token is used verbatim and never regenerated or overwritten.
       `true` is a first-run bootstrap only: it mints a throwaway token that is
       NOT registered, so it will 403 until registered and pinned. */
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = pinned || true;
    if (!pinned) {
      console.warn('[SOKONI] App Check — FIRST-RUN BOOTSTRAP (no pinned debug token).' +
        '\nFirebase prints a TEMPORARY token below. It is not registered, so App Check' +
        '\nreturns 403 and Firebase Auth will fail until you:' +
        '\n  1. Register it: Firebase Console -> App Check -> Manage debug tokens.' +
        '\n  2. Pin it: localStorage.setItem(\'' + DEBUG_KEY + '\', \'<that-token>\')' +
        '\nSee docs/APP_CHECK.md');
    }
  }

  /* Create the compat default app (no-op if the page already made one), then
     activate App Check against it — both before any inline page script runs. */
  _ensureApp();

  /* Try immediately (covers pages that init the compat app before this script).
     Otherwise poll briefly until the inline page script calls initializeApp(),
     so App Check is activated before the first Firestore/Functions call.
     Bounded so a page without a compat app never leaves a timer running. */
  if (!_activate()) {
    var waited = 0;
    var timer = setInterval(function () {
      waited += 50;
      if (_activate() || waited >= 5000) clearInterval(timer);
    }, 50);
    document.addEventListener('DOMContentLoaded', function () { _activate(); });
  }
})();
