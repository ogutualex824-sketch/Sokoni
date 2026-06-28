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

  /* Debug token for localhost — must be set before activate() */
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    try { self.FIREBASE_APPCHECK_DEBUG_TOKEN = true; } catch (_) {}
  }

  /* Run immediately — compat scripts are synchronous so firebase is ready */
  _activate();
})();
