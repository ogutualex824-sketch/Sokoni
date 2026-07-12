/* sokoni-appcheck.js — Firebase App Check (compat SDK pages)
   Loaded after firebase-app-check-compat.js on every compat-SDK page.
   firebase.js (modular) initialises App Check independently. */
(function () {
  'use strict';
  var SITE_KEY = '6Lf93TktAAAAAIqCj8l3YM3dIoS1MIXpilsdnsxj';

  function _activate() {
    if (typeof firebase === 'undefined' || typeof firebase.appCheck !== 'function') return;
    try {
      firebase.appCheck().activate(
        new firebase.appCheck.ReCaptchaV3Provider(SITE_KEY),
        true /* isTokenAutoRefreshEnabled */
      );
    } catch (e) {
      console.warn('[SOKONI AppCheck]', e.message);
    }
  }

  /* Debug token for localhost — must be set before activate().
     Production sends no debug token and attests via reCAPTCHA v3.
     The token must already be registered in Firebase Console; pin it once with
       localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', '<uuid-from-console>')
     The `true` fallback mints an unregistered token (403), which blocks Firebase
     Auth entirely — it exists only to print a token to register on first run.
     Kept in lock-step with the modular path in firebase.js. */
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]') {
    try {
      var pinned = localStorage.getItem('SOKONI_APPCHECK_DEBUG_TOKEN');
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = pinned || true;
    } catch (_) {
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
  }

  /* Run immediately — compat scripts are synchronous so firebase is ready */
  _activate();
})();
