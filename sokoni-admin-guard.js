/* ============================================================================
   SOKONI Admin Guard — sokoni-admin-guard.js
   ============================================================================
   ONE authorization gate for every platform-admin surface.

   WHY THIS EXISTS
   ---------------
   The 2026-08-25 admin routing audit (docs/ADMIN_ROUTING_NAVIGATION_AUDIT.md)
   found that admin authorization was re-implemented per page, and that ten
   consoles — admin-os, enterprise-ops, ops-center, ops-dashboard,
   admin-feedback, beta-control, beta-dashboard, minishop-admin, pos-staff-ops,
   reliability-center — had NO client gate at all. Thirteen more denied an
   unauthorized user to `/` or `/index.html`, dumping a platform administrator
   into the customer marketplace.

   Both defects are the same root cause: no shared gate, so every page invented
   its own and some invented none. This file is that shared gate.

   WHAT THIS IS AND IS NOT
   -----------------------
   This is a CLIENT gate. It is NOT the security boundary and must never be
   treated as one. The real boundary is Firestore rules + Cloud Function guards,
   both of which derive authority from Firebase custom claims. This module
   exists to stop an unauthorized user from *rendering* an admin console and to
   route them somewhere honest — not to protect data. A page that relies on
   this file alone for data protection is still broken.

   WHY IT DOES NOT REDIRECT ON DENIAL
   ----------------------------------
   The audit's finding was that denial redirects sent admins to the marketplace.
   The fix is not a better redirect target — it is to stop bouncing people
   silently. A signed-in user who lacks the claim gets an explicit "no access"
   panel naming the workspace they DO have, with a link to it. A signed-OUT user
   is sent to login with ?next= preserved, because that is a resumable trip.

   There is deliberately NO generic index.html fallback. When the requested
   workspace is known, an unexplained bounce to the marketplace is a defect.

   USAGE
   -----
     <html data-admin-guard="admin">          <!-- or "superAdmin" / "moderator" -->
     <script src="/sokoni-admin-guard.js"></script>

   Place the script tag in <head>. The guard paints a blocking overlay
   immediately and only removes it once the claim is verified.

   Pages may await verification:
     window.SokoniAdminGuard.verified.then(({ user, claims }) => { ... });
   or listen for:
     document.addEventListener('sokoni:admin-verified', e => { ... });

   WHY IT POLLS FOR THE FIREBASE SHIM
   ----------------------------------
   firebase.js is a DEFERRED ES module that installs the window.firebase compat
   shim. A classic script can run before it, and the shim is installed just
   AFTER the sokoniFirebaseReady event fires — so listening for that event alone
   races and the splash hangs forever. super-admin.html documents this exact
   bug. Poll for the shim itself.
   ========================================================================== */
(function () {
  'use strict';

  var REQUIRED = (document.documentElement.getAttribute('data-admin-guard') || '').trim();
  if (!REQUIRED) return;   /* page did not opt in — do nothing */

  /* Roles that satisfy a requirement. superAdmin satisfies everything below it;
     this mirrors firestore.rules isAdmin(), which accepts admin OR superAdmin.
     Kept explicit rather than clever — a wrong entry here silently widens a
     privilege boundary. */
  var SATISFIES = {
    superAdmin: ['superAdmin'],
    admin:      ['admin', 'superAdmin'],
    moderator:  ['moderator', 'admin', 'superAdmin']
  };
  var ACCEPTED = SATISFIES[REQUIRED] || ['superAdmin'];

  /* Where a signed-in NON-admin actually belongs. Order matters: the first
     claim the user holds wins. Every destination here is a real page in the
     repo — an invented one would just relocate the bug. */
  var WORKSPACES = [
    { claim: 'seller',   label: 'Seller Dashboard',   href: 'seller.html'   },
    { claim: 'provider', label: 'Provider Workspace', href: 'provider.html' },
    { claim: 'driver',   label: 'Driver Dashboard',   href: 'driver.html'   }
  ];

  var PAGE = (location.pathname.split('/').pop() || '').replace(/\.html$/, '') || 'admin';

  /* ── blocking overlay ──────────────────────────────────────────────────── */
  var overlay;
  /* Set once the gate reaches a terminal state. Without it there is a RACE that
     locks out legitimate admins: this script defers paint() to DOMContentLoaded,
     but firebase can resolve BEFORE that fires. runGate() then removes an overlay
     that does not exist yet, DOMContentLoaded paints it afterwards, and nothing
     ever takes it down — a verified admin stares at "Verifying access…" forever.
     Caught by the ADMIN+correct-PIN case in the merchant-pipeline J2 matrix;
     every DENY case passed while the page was in fact unusable for everyone. */
  var settled = false;

  function paint(html) {
    if (settled) return;          /* already granted — never re-cover the page */
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'sokoniAdminGuard';
      overlay.setAttribute('role', 'status');
      overlay.setAttribute('aria-live', 'polite');
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;' +
        'justify-content:center;padding:24px;background:#0b0d0b;color:#fff;' +
        'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;';
      (document.body || document.documentElement).appendChild(overlay);
    }
    overlay.innerHTML = html;
  }

  /* body may not exist yet when this runs in <head>. */
  function ready(fn) {
    if (document.body) { fn(); return; }
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  ready(function () {
    paint('<div><div style="font-size:14px;opacity:.75;">Verifying access…</div></div>');
  });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function deny(claims) {
    var here = [];
    for (var i = 0; i < WORKSPACES.length; i++) {
      if (claims && claims[WORKSPACES[i].claim] === true) { here.push(WORKSPACES[i]); }
    }
    /* No elevated claim at all — a customer. Their workspace genuinely IS the
       marketplace, so linking there is correct here and only here. */
    if (!here.length) {
      here.push({ label: 'My Account', href: 'account-centre.html' });
    }

    var links = here.map(function (w) {
      return '<a href="' + esc(w.href) + '" style="display:inline-flex;align-items:center;' +
             'justify-content:center;min-height:44px;padding:0 22px;margin:6px;border-radius:12px;' +
             'background:#71ff00;color:#000;font-weight:800;font-size:14px;text-decoration:none;">' +
             esc(w.label) + '</a>';
    }).join('');

    ready(function () {
      paint(
        '<div style="max-width:420px;">' +
          '<div style="font-size:34px;line-height:1;margin-bottom:14px;">&#128274;</div>' +
          '<h1 style="font-size:19px;font-weight:800;margin:0 0 10px;">Admin access required</h1>' +
          '<p style="font-size:14px;line-height:1.55;opacity:.72;margin:0 0 20px;">' +
            'Your account is signed in, but it does not hold the ' +
            '<strong>' + esc(REQUIRED) + '</strong> role needed for this console.' +
          '</p>' +
          '<div>' + links + '</div>' +
        '</div>'
      );
    });
  }

  function toLogin(reason) {
    /* Path + query only — never an absolute URL, which would let an
       open-redirect be smuggled in. Same rule auth-guard.js follows. */
    var next = location.pathname + location.search;
    location.replace('login.html?next=' + encodeURIComponent(next) +
                     (reason ? '&error=' + encodeURIComponent(reason) : ''));
  }

  var _resolve, _reject;
  var verified = new Promise(function (res, rej) { _resolve = res; _reject = rej; });
  /* Never let an unhandled rejection surface as a console error on a page that
     is already showing the user a correct denial panel. */
  verified.catch(function () {});

  window.SokoniAdminGuard = {
    required: REQUIRED,
    verified: verified,
    page: PAGE
  };

  function runGate() {
    window.firebase.auth().onAuthStateChanged(async function (user) {
      if (!user) { toLogin(''); return; }
      try {
        /* forceRefresh: a claim granted after this session's token was minted is
           invisible until refresh. Skipping this is why admin gates read stale
           tokens before d366c30. */
        var res    = await user.getIdTokenResult(true);
        var claims = res.claims || {};

        var ok = ACCEPTED.some(function (c) { return claims[c] === true; });
        if (!ok) { deny(claims); _reject(new Error('insufficient_privileges')); return; }

        /* settled FIRST, so a paint() still queued on DOMContentLoaded becomes a
           no-op instead of re-covering a page we have already granted. */
        settled = true;
        if (overlay && overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
        overlay = null;

        /* Dismiss the page's OWN pre-guard auth overlay.
           Several consoles paint a blocking "verifying access" panel and hide it
           inside their inline gate's success path. Once that inline gate defers
           to this guard (returning early to avoid racing its redirect), nothing
           hides the panel — it stays up and covers the admin chrome. Observed on
           finos-admin and sfos-monitor, where #auth-gate sat over the hamburger
           and the drawer could not be opened at any width below 1024px.

           STRICTLY these two ids. #mp-gate and similar SECOND-FACTOR prompts
           (merchant-pipeline's PIN) must NOT be dismissed here — a verified admin
           claim is exactly what makes the second factor meaningful, and clearing
           it would silently remove a security control. */
        /* Deferred through ready(): onAuthStateChanged can fire BEFORE
           DOMContentLoaded, in which case #auth-gate does not exist yet and a
           direct lookup silently finds nothing — the first version of this fix
           did exactly that and the gate stayed up. Same race that made the
           guard's own overlay stick. */
        ready(function () {
          ['auth-gate', 'authGate'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) { el.style.setProperty('display', 'none', 'important'); }
          });
        });

        _resolve({ user: user, claims: claims });
        document.dispatchEvent(new CustomEvent('sokoni:admin-verified', {
          detail: { user: user, claims: claims }
        }));
      } catch (err) {
        console.error('[AdminGuard] claim check failed:', err);
        toLogin('auth_check_failed');
      }
    });
  }

  /* Poll for the compat shim — see header note. ~7.5s ceiling, then fail
     CLOSED with an honest message rather than revealing the console. */
  var tries = 0;
  (function wait() {
    if (window.firebase && typeof window.firebase.auth === 'function' && window.firebaseAuth) {
      runGate(); return;
    }
    if (++tries > 250) {
      console.error('[AdminGuard] Firebase not ready — gate aborted, page kept closed');
      ready(function () {
        paint('<div style="max-width:380px;"><h1 style="font-size:17px;font-weight:800;margin:0 0 10px;">' +
              'Could not verify access</h1><p style="font-size:14px;opacity:.72;line-height:1.55;">' +
              'Authentication did not load. Please refresh the page.</p></div>');
      });
      _reject(new Error('firebase_unavailable'));
      return;
    }
    setTimeout(wait, 30);
  })();
})();
