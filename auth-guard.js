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

  /* Already authenticated — show page as normal */
  if (loggedIn && hasUser) return;

  /* Never bounce the auth pages themselves — that is a redirect loop.
     Matches with and without .html because cleanUrls:true strips it. */
  var path = (location.pathname || '').toLowerCase();
  if (/(^|\/)(login|signup|register|reset-password)(\.html)?$/.test(path)) return;

  /* Preserve the destination so login returns the user here. Only the
     path + query is kept — never an absolute URL, which would let an
     open-redirect be smuggled in via the address bar. */
  var next = location.pathname + location.search;
  var target = 'login.html?next=' + encodeURIComponent(next);

  /* replace(), not assign(): the protected page must not sit in history,
     or Back from login lands on it and bounces straight here again. */
  try { location.replace(target); } catch (e) { location.href = target; }
})();
