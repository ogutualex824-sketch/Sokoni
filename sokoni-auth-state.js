/* ============================================================================
   SOKONI — Canonical Authentication State  (sokoni-auth-state.js)

   THE single source of truth for "who is signed in". Every consumer —
   permissions, guards, bootstrap, profile, seller/wallet dashboards — depends on
   this abstraction instead of reading window.firebaseAuth.currentUser directly.
   If App Check, token refresh, or init behaviour changes, only this file changes.

   THE INVARIANT
     Authentication state is authoritative ONLY AFTER Firebase Auth initialization
     has completed (the first onAuthStateChanged has fired). Before that, NO
     consumer may conclude "logged out".

   WHY THIS EXISTS
   sokoni-permissions.js used to do `if (window.firebaseAuth) return false;` —
   concluding logged-out the instant the firebaseAuth object existed, which is
   synchronous, long before `currentUser` resolves (and longer still while App
   Check intermittently delays the token exchange on this project). Guarded pages
   (seller/driver/provider/landlord/admin) then redirected to login.html?next=…,
   login bounced back on the cached loggedIn flag, and the two looped — the
   timing-dependent "page keeps reloading" that never reproduced on a fast desktop.

   Load this EARLY (before permissions/guards) on any authenticated page. It reads
   firebase.js's readiness contract (waitForFirebaseReady) + the live auth
   listener; it never writes, never redirects, never throws.
   ============================================================================ */
(function () {
  'use strict';

  var _resolved = false;      /* has the first onAuthStateChanged fired?          */
  var _session  = null;       /* canonical session after resolution, or null      */
  var _waiters  = [];         /* whenResolved() callbacks                          */

  function _cachedUser() {
    try { return JSON.parse(localStorage.getItem('sokoniUser') || 'null'); } catch (e) { return null; }
  }
  function _cachedLoggedIn() {
    try { return localStorage.getItem('loggedIn') === 'true'; } catch (e) { return false; }
  }

  /* Build a session from the verified Firebase user, enriched with cached profile
     fields (roles/name) that live in the users doc, not the auth token. */
  function _sessionFromUser(user) {
    if (!user) return null;
    var c = _cachedUser() || {};
    return {
      uid:         user.uid,
      email:       user.email || c.email || null,
      displayName: user.displayName || c.name || c.displayName || null,
      phoneNumber: user.phoneNumber || c.phoneNumber || null,
      roles:       Array.isArray(c.roles) ? c.roles.slice() : [],
      emailVerified: !!user.emailVerified,
      resolved:    true,
    };
  }

  /* Optimistic session for the pre-resolution paint window: trust the cached
     session so the UI does not flash the login screen while Firebase resolves.
     Flagged resolved:false so a consumer that needs certainty can wait. */
  function _optimisticSession() {
    if (!_cachedLoggedIn()) return null;
    var c = _cachedUser();
    if (!c || !(c.uid || c.email || c.name)) return null;
    return {
      uid: c.uid || null, email: c.email || null,
      displayName: c.name || c.displayName || null, phoneNumber: c.phoneNumber || null,
      roles: Array.isArray(c.roles) ? c.roles.slice() : [],
      emailVerified: !!c.emailVerified, resolved: false,
    };
  }

  function _markResolved(user) {
    _resolved = true;
    _session = _sessionFromUser(user);
    var ws = _waiters; _waiters = [];
    ws.forEach(function (cb) { try { cb(_session); } catch (e) {} });
  }

  /* ── Hook Firebase's authoritative resolution ─────────────────────────────── */
  function _hook() {
    if (typeof window.waitForFirebaseReady !== 'function') { setTimeout(_hook, 200); return; }
    window.waitForFirebaseReady(function () {
      /* firebaseAuth now exists; the FIRST onAuthStateChanged tells us the real
         user (or null). That is the moment auth becomes authoritative. */
      if (window.firebaseSDK && typeof window.firebaseSDK.onAuthStateChanged === 'function') {
        window.firebaseSDK.onAuthStateChanged(function (u) { _markResolved(u); });
      } else if (window.firebaseAuth) {
        _markResolved(window.firebaseAuth.currentUser);   /* fallback */
      } else {
        _markResolved(null);
      }
    });
    /* Absolute backstop: never leave the app "resolving" forever. If Firebase
       never reports in (offline cold start), resolve from cache after 12s so
       consumers stop waiting — matching firebase.js's own 12s App Check ceiling. */
    setTimeout(function () {
      if (_resolved) return;
      var u = window.firebaseAuth && window.firebaseAuth.currentUser;
      if (u) { _markResolved(u); }
      else {
        /* Do NOT fabricate a logout on timeout — resolve to the optimistic
           cached session so a slow network cannot sign the user out. */
        _resolved = true; _session = _optimisticSession();
        var ws = _waiters; _waiters = []; ws.forEach(function (cb) { try { cb(_session); } catch (e) {} });
      }
    }, 12000);
  }
  _hook();

  /* ── Public API ───────────────────────────────────────────────────────────── */
  window.SokoniAuthState = {
    /* True once Firebase Auth has reported in (authoritative). */
    isResolved: function () { return _resolved; },

    /* The canonical session, or null. Before resolution returns an OPTIMISTIC
       session from cache (resolved:false) so the UI paints logged-in; after
       resolution returns the verified session (resolved:true) or null. */
    getCurrentSession: function () { return _resolved ? _session : _optimisticSession(); },

    /* The one auth decision every consumer should use. NEVER returns false while
       auth is still resolving — only once resolution has confirmed no user. */
    isLoggedIn: function () {
      if (_resolved) return !!_session;
      return !!_optimisticSession();
    },

    /* Resolve when auth is authoritative. Immediate if already resolved. */
    whenResolved: function (cb) {
      if (typeof cb !== 'function') return;
      if (_resolved) { try { cb(_session); } catch (e) {} } else { _waiters.push(cb); }
    },
  };

  /* Promise form for async consumers. */
  window.SokoniAuthState.ready = new Promise(function (resolve) {
    window.SokoniAuthState.whenResolved(resolve);
  });
})();
