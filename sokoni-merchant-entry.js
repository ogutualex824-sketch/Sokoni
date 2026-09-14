/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — MERCHANT ENTRY ROUTING
   ------------------------------------------------------------------------------
   ONE place that answers: where does this person go when they press "My Store",
   the business card, or "Start Selling"?

       auth.uid → canonical account → approval → destination

   Every public entry point calls this instead of hardcoding a URL, so the answer
   cannot drift between four pages.

   ── WHAT COUNTS AS APPROVED, AND WHY ─────────────────────────────────────────
   Two signals, both written ONLY by the server's approval path
   (functions/application-lifecycle.js → grantAccountRole), and NEITHER forgeable
   by a client. Verified against the LIVE ruleset:

     1. custom claim `seller === true`
        Claims are minted by the Admin SDK. A browser cannot write one at all.

     2. users/{uid}.roles contains 'seller'
        `noPrivilegeEscalation()` → `rolesUnchanged()` blocks `roles` from appearing
        in affectedKeys on update, and restricts it to ['buyer','user'] on create.
        So the client cannot grant itself a role.

   Either satisfies approval. Both are needed as alternatives because the claim path
   shipped later than the accounts it approves — sellers approved before it hold the
   role without the claim, and requiring the claim alone would send real merchants
   back to onboarding.

   ── WHAT IS DELIBERATELY NOT USED ────────────────────────────────────────────
     · `localStorage` of any kind, and any `?role=` / `?approved=` URL parameter —
       a routing authority a user can type is not an authority.
     · `sellers/{uid}.status` — the rules DELIBERATELY let an owner self-create that
       document; it IS the application. `status` is not in `noAdminFields()`, so an
       applicant can write `status:'active'` on themselves. Three accounts were
       measured holding exactly that with no role and no claim.
     · `users/{uid}.isSeller` — not covered by `noAdminFields()` or `rolesUnchanged()`,
       so a client CAN write it. It is a profile hint, not an authority.

   Routing is not a security boundary — Firestore rules are. This decides where a
   person is SENT; what they may then read or write is enforced server-side either
   way. But sending on a forgeable signal would still be wrong, so it does not.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ── THE CUTOVER GATE ───────────────────────────────────────────────────────
     merchant-v2.html is certified against a real seller (17/0) but is NOT yet on
     the release lineage and NOT deployed. Pointing production here before it ships
     would turn every "My Store" button into a 404.

     Flip this ONE constant at step 7 of the cutover, AFTER v2 is deployed and its
     production URL has been verified. Nothing else needs to change.

     ── CUT OVER. Verified on production 2026-09-07, not assumed ──────────────
     `curl -sL https://mysokoni.co.ke/merchant-v2` → 200, and the DEPLOYED
     `sokoni-merchant-entry.js` on production already reads `/merchant-v2`. This
     tree was the one lagging: it still said `/merchant`, so an approved merchant
     routed from a build made here would land in the v1 workspace instead of the
     Seller Hub. This aligns the constant with the destination production has
     already verified — it is catching up with live, not performing a cutover. */
  var MERCHANT_URL = '/merchant-v2';     /* ← Seller Hub. Matches deployed production. */
  var ONBOARD_URL  = '/offer';           /* seller intake */
  var PENDING_URL  = '/account-centre';  /* authenticated, not yet approved */
  var SIGNIN_URL   = '/login';

  var _cache = null;   /* { state, uid } — per page load; approval does not change mid-session */

  function _auth () {
    try { return global.firebaseAuth || null; } catch (e) { return null; }
  }

  /* Wait for auth to RESOLVE rather than sampling it. A single read right after load
     reports null for a signed-in user, which would route a merchant to sign-in. */
  function _user () {
    var a = _auth();
    if (!a) return Promise.resolve(null);
    if (a.currentUser) return Promise.resolve(a.currentUser);
    return new Promise(function (res) {
      var done = false;
      var finish = function (u) { if (!done) { done = true; res(u || null); } };
      var t = setTimeout(function () { finish(null); }, 8000);
      try {
        a.onAuthStateChanged(function (u) { clearTimeout(t); finish(u); });
      } catch (e) { clearTimeout(t); finish(null); }
    });
  }

  /* signal 1 — the custom claim. Cheap: it is already in the ID token. */
  function _claimSeller (user) {
    if (!user || !user.getIdTokenResult) return Promise.resolve(false);
    return user.getIdTokenResult()
      .then(function (r) { return !!(r && r.claims && r.claims.seller === true); })
      .catch(function () { return false; });
  }

  /* signal 2 — users/{uid}.roles, which the rules make un-self-grantable. */
  function _roleSeller (user) {
    if (!user) return Promise.resolve(false);
    var db = global.firebaseDB;
    if (!db) return Promise.resolve(false);
    return Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
    ]).then(function (mods) {
      var m = mods[0];
      return m.getDoc(m.doc(db, 'users', user.uid));
    }).then(function (snap) {
      if (!snap.exists()) return false;
      var d = snap.data() || {};
      var roles = d.roles;
      if (Array.isArray(roles)) return roles.indexOf('seller') >= 0;
      /* Some records carry roles as a map { seller:true }. Accept that shape too —
         it is the same server-written field, not a different authority. */
      if (roles && typeof roles === 'object') return roles.seller === true;
      return false;
    }).catch(function () { return false; });
  }

  /**
   * Resolve the caller's merchant-entry state.
   * @returns {Promise<{state:'signed-out'|'not-approved'|'approved', uid:?string,
   *                    via:?string, destination:string}>}
   */
  function resolve () {
    if (_cache) return Promise.resolve(_cache);
    return _user().then(function (user) {
      if (!user) {
        return (_cache = { state: 'signed-out', uid: null, via: null, destination: SIGNIN_URL });
      }
      return Promise.all([_claimSeller(user), _roleSeller(user)]).then(function (r) {
        var byClaim = r[0], byRole = r[1];
        if (byClaim || byRole) {
          return (_cache = {
            state: 'approved', uid: user.uid,
            via: byClaim ? 'claim' : 'users.roles',
            destination: MERCHANT_URL,
          });
        }
        return (_cache = { state: 'not-approved', uid: user.uid, via: null, destination: PENDING_URL });
      });
    });
  }

  /** Where should "My Store" / the business card go? */
  function store () {
    return resolve().then(function (r) {
      /* An authenticated non-seller pressing "My Store" has no store — send them to
         their account, not to a merchant workspace they cannot use. */
      return r.destination;
    });
  }

  /** Where should "Start Selling" go? Onboarding for anyone not already approved. */
  function startSelling () {
    return resolve().then(function (r) {
      if (r.state === 'approved') return MERCHANT_URL;   /* already selling — go to work */
      if (r.state === 'not-approved') return ONBOARD_URL; /* continue/begin intake */
      return ONBOARD_URL;  /* signed out: the intake page owns its own sign-in prompt */
    });
  }

  /** Navigate. Used by the public buttons so no page hardcodes a destination. */
  function go (which) {
    var p = which === 'sell' ? startSelling() : store();
    return p.then(function (url) { global.location.assign(url); return url; });
  }

  /* Bind every element that opts in, so a page needs no script of its own:
       <a data-merchant-entry="store">My Store</a>
       <a data-merchant-entry="sell">Start Selling</a>
     The href stays as a real, working fallback for no-JS and for middle-click. */
  function bind () {
    global.document.addEventListener('click', function (e) {
      var el = e.target.closest && e.target.closest('[data-merchant-entry]');
      if (!el) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;  /* let new-tab work */
      e.preventDefault();
      go(el.getAttribute('data-merchant-entry'));
    });
  }
  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', bind, { once: true });
    } else bind();
  }

  global.SokoniMerchantEntry = {
    resolve: resolve,
    store: store,
    startSelling: startSelling,
    go: go,
    /* Exposed for the routing gate test — never for callers to branch on. */
    _urls: { merchant: MERCHANT_URL, onboard: ONBOARD_URL, pending: PENDING_URL, signin: SIGNIN_URL },
  };
})(typeof window !== 'undefined' ? window : globalThis);
