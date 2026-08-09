/* ================================================================
   SOKONI Auth Guard — auth-guard.js
   Runs synchronously in <head> on every page that has
   data-require-auth="true" on <html>.

   If the user is authenticated (localStorage), the page loads normally.
   If not, we send them to login.html — THE single login surface.

   WHY THIS NO LONGER RENDERS ITS OWN SIGN-IN CARD
   -----------------------------------------------
   This file used to inject an inline overlay (#sokoni-auth-gate) with its
   own email + password form. That produced TWO different login screens:

     1. this overlay — email/password ONLY, no Google, no phone, no
        social sign-in, plus a "Full login page" link, and
     2. login.html — the real, complete login page.

   A visitor with a fresh browser hit the small one first and had to click
   through to the big one to use Google. Two login surfaces also meant two
   places to keep correct: the overlay silently lacked every provider added
   to login.html since it was written.

   Redirecting removes the duplicate outright. login.html already handles
   the return trip: auth.js captures ?next= into sokoniLoginRedirect and
   every post-login path honours it, so the user lands back where they were.
================================================================ */
(function () {
  'use strict';
  if (document.documentElement.dataset.requireAuth !== 'true') return;

  var loggedIn = localStorage.getItem('loggedIn') === 'true';
  var hasUser = false;
  try { hasUser = !!JSON.parse(localStorage.getItem('sokoniUser') || 'null'); } catch (e) {}

  /* Never bounce the auth pages themselves — that is a redirect loop.
     Matches with and without .html because cleanUrls:true strips it. */
  var path = (location.pathname || '').toLowerCase();
  if (/(^|\/)(login|signup|register|reset-password)(\.html)?$/.test(path)) return;

  /* Preserve the destination so login returns the user here. Only the
     path + query is kept — never an absolute URL, which would let an
     open-redirect be smuggled in via the address bar. */
  var next = location.pathname + location.search;
  var target = 'login.html?next=' + encodeURIComponent(next);

  /* Already authenticated — show page as normal.
     BUGFIX 2026-07-26: this required BOTH loggedIn AND a cached sokoniUser. But
     sokoniUser is a PROFILE CACHE, not the session — it is legitimately absent for
     a new account, a cleared cache, or when App Check blocks the Firestore read
     that populates it. Requiring it bounced a genuinely-logged-in user to
     login.html, which (auth.js keys only on loggedIn) bounced them right back:
     the profile↔login loop. The session flag alone is authoritative here;
     SokoniAuthState/firebase resolve the real user and the bootstrap repairs the
     missing cache. Gating a session on profile metadata is exactly the class of
     bug that broke isLoggedIn() (the u.name requirement). */
  if (loggedIn) return;

  /* If the browser has a valid Firebase session but the local cache is stale,
     wait briefly for the auth bootstrap to restore it. This avoids redirecting
     an actually-signed-in user to login when the auth state has not been
     materialized yet. */
  var _redirectTimer = null;
  /* Am I a module hosted inside the SOKONI app shell (same-origin iframe)?
     Computed inline rather than via SokoniInShell so this guard keeps working on pages that
     do not load the boundary helper — an auth guard must never depend on another script. */
  function _hostedInShell() {
      try {
          if (!window.parent || window.parent === window) return false;
          /* Same-origin read; throws for a cross-origin parent, which is NOT our shell. */
          var pp = (window.parent.location.pathname || '').toLowerCase();
          return /(^|\/)merchant(\.html)?$/.test(pp) || !!window.parent.SokoniShell;
      } catch (e) { return false; }
  }

  function _doRedirect() {
      if (window.__sokoniAuthReady) return;
      _logRedirect();

      /* HOSTED MODULE: replacing location here navigates the PANEL, not the tab — the merchant
         ends up staring at a login form embedded inside their dashboard, under the previous
         module's title. That is how Products "opened login.html".

         This does NOT weaken the guard. Authentication is still enforced, just at the frame that
         owns it: the shell loads this same auth-guard at the top level, so an unauthenticated
         visitor is sent to the real login flow before any module mounts. Here we only refuse to
         render and tell the shell why. Data remains protected by Firestore rules regardless. */
      if (_hostedInShell()) {
          try {
              window.parent.postMessage({ __sokoniModule: true, action: 'authRequired',
                                          page: path, next: next }, window.location.origin);
          } catch (e) {}
          return;
      }

      try { location.replace(target); } catch (e) { location.href = target; }
  }
  function _cancelRedirect() {
      if (_redirectTimer) { clearTimeout(_redirectTimer); _redirectTimer = null; }
  }
  function _logRedirect() {
      try {
          console.warn('[SOKONI AUTH REDIRECT]', { page: path, loggedIn: loggedIn, hasUser: hasUser, reason: 'auth-guard→login' });
          var _log = JSON.parse(localStorage.getItem('sk_auth_redirects') || '[]');
          _log.push({ t: Date.now(), page: path, loggedIn: loggedIn, hasUser: hasUser, reason: 'auth-guard→login' });
          while (_log.length > 25) _log.shift();
          localStorage.setItem('sk_auth_redirects', JSON.stringify(_log));
      } catch (e) {}
  }
  document.addEventListener('sokoniAuthReady', function() {
      _cancelRedirect();
  });
  if (window.__sokoniAuthReady) return;
  if (window.__sokoniFirebaseReady) {
      _redirectTimer = setTimeout(_doRedirect, 4000);
  } else {
      _redirectTimer = setTimeout(_doRedirect, 10000);
      document.addEventListener('sokoniFirebaseReady', function() {
          if (_redirectTimer) { clearTimeout(_redirectTimer); _redirectTimer = null; }
          if (window.__sokoniAuthReady) return;
          _redirectTimer = setTimeout(_doRedirect, 4000);
      }, { once: true });
  }

})();
