/* SOKONI — Identity Guard  v1.0
 *
 * Closes cross-account data leakage on AUTHENTICATED OWNER pages.
 *
 * The problem (audited 2026-07-27): owner pages (profile, account-centre, wallet,
 * my-orders, seller) bind their profile / wallet / listings / orders loads to the
 * CACHED `sokoniUser.uid` captured at DOMContentLoaded, and never assert that it
 * equals the LIVE authenticated uid. firebase.js only corrects that cache
 * asynchronously (after an awaited getDoc), so on an account switch or a
 * slow-profile-fetch race the PREVIOUS account's cache can drive the loads and
 * paint another user's wallet / listings / orders.
 *
 * The guard resolves the authoritative live uid (resolution-aware, via
 * SokoniAuthState, falling back to firebaseAuth) and, if the cached identity
 * belongs to a DIFFERENT account, purges every user-specific cache and reloads so
 * every load on the page rebinds to the correct uid. firebase.js repopulates the
 * cache with the live user on reload, so it converges in one hop (loop-broken via
 * a per-uid sessionStorage marker). No live user → do nothing; the page's own
 * auth-gate handles the signed-out case.
 *
 * Include on every authenticated owner page (after sokoni-auth-state.js). Exposes
 * window.SokoniIdentity for pages that want to read the authoritative uid directly.
 */
(function () {
  'use strict';

  /* Non-user infra keys that survive a purge — same allow-list as sokoniSignOut. */
  var LS_KEEP = /theme|darkmode|consent|cookie|appcheck|debug|install|onboard|dismiss|locale|printer|hardware/i;

  function cachedUser() {
    try { return JSON.parse(localStorage.getItem('sokoniUser') || 'null'); } catch (_) { return null; }
  }

  function liveUid() {
    try {
      var AS = window.SokoniAuthState;
      if (AS && AS.isResolved && AS.isResolved()) {
        var s = AS.getCurrentSession && AS.getCurrentSession();
        if (s && s.uid) return s.uid;
      }
      if (window.firebaseAuth && window.firebaseAuth.currentUser) return window.firebaseAuth.currentUser.uid;
    } catch (_) {}
    return null;
  }

  function purgeUserCaches() {
    ['localStorage', 'sessionStorage'].forEach(function (name) {
      try {
        var store = window[name]; if (!store) return;
        Object.keys(store).forEach(function (k) {
          if (!LS_KEEP.test(k)) { try { store.removeItem(k); } catch (_) {} }
        });
      } catch (_) {}
    });
  }

  /* If the cached identity is a DIFFERENT account than the live user, the cache is
     stale/cross-account: purge it and reload so every data-load rebinds to `uid`. */
  function reconcile(uid) {
    if (!uid) return;                                  /* no live user — auth-gate owns that */
    var c = cachedUser();
    if (c && c.uid && c.uid !== uid) {
      var mark = '_sokIdReloaded_' + uid;
      try { if (sessionStorage.getItem(mark)) return; sessionStorage.setItem(mark, '1'); } catch (_) {}
      purgeUserCaches();
      /* The live session is valid — we're switching which account's cache drives
         the page, NOT logging out. Keep the session flag so the reload doesn't
         bounce a genuinely signed-in user through login. */
      try { localStorage.setItem('loggedIn', 'true'); } catch (_) {}
      try { location.reload(); } catch (_) {}
    }
  }

  function run() {
    var AS = window.SokoniAuthState;
    if (AS && AS.ready && typeof AS.ready.then === 'function') {
      AS.ready.then(function (s) { reconcile(s && s.uid); });
    } else {
      document.addEventListener('sokoniAuthReady', function (e) { reconcile(e && e.detail && e.detail.uid); });
    }
  }
  run();

  window.SokoniIdentity = {
    /* Authoritative live uid (or null before auth resolves). */
    uid: liveUid,
    /* Resolve with the authoritative live uid (or null). Use this to key owner loads. */
    ready: function () {
      return new Promise(function (res) {
        var AS = window.SokoniAuthState;
        if (AS && AS.ready && typeof AS.ready.then === 'function') AS.ready.then(function (s) { res((s && s.uid) || null); });
        else if (liveUid()) res(liveUid());
        else document.addEventListener('sokoniAuthReady', function (e) { res((e && e.detail && e.detail.uid) || null); }, { once: true });
      });
    },
    /* True iff the cached identity matches the live user (or there is no cache). */
    cacheMatchesLive: function () { var c = cachedUser(), u = liveUid(); return !c || !c.uid || !u || c.uid === u; },
    purgeUserCaches: purgeUserCaches
  };
})();
