/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — Email verification gate  (Auth Slice 3: login-path gate)
   ------------------------------------------------------------------------------
   ONE rule, ONE choke point: a password account whose Firebase Auth record says
   emailVerified === false does not get an application session.

   WHAT "AUTHORITATIVE" MEANS HERE
   -------------------------------
   The decision is made from the Firebase Auth User object and nothing else — never
   localStorage, never the cached `sokoniUser` profile blob, never a `verified` flag
   the client could write. `emailVerified` on that object comes from the ID token,
   which is signed by Firebase and set by the Admin SDK in authDispatch
   (Slice 2). There is no client call that can turn it true.

   WHY THE RELOAD, AND WHY ONLY SOMETIMES
   --------------------------------------
   A cached token can be stale, so `false` is not trustworthy on its own — the user
   may have just verified in another tab or on another device. Before denying anyone
   we call user.reload() and re-read the flag from the server.

   `true` needs no reload. The flag only ever moves false → true (nothing in the
   platform un-verifies an account), so a cached `true` cannot be a stale `false`.
   That asymmetry is what keeps the gate free: verified users — everybody, almost
   always — pay no network round trip on any page load. The cost falls only on the
   accounts actually being gated.

   If the reload FAILS (offline, App Check hiccup) we keep the gate closed. That
   cannot lock out a verified user, because a verified user short-circuits above and
   never reaches the reload at all.

   WHAT THIS GATE IS AND IS NOT
   ----------------------------
   It is an ACCESS gate: it decides whether the app grants a session and renders.
   It is not, and must not be mistaken for, data protection. A tampered client can
   lie to itself about any client-side value. Data stays protected where it always
   was — Firestore rules, App Check, and the server-side checks in Cloud Functions,
   all of which read the real token rather than anything this file computes. Nothing
   here weakens any of them; the gate only ever REMOVES access.

   WHY THE FIREBASE SESSION IS DELIBERATELY LEFT ALIVE
   ---------------------------------------------------
   Being gated is not being signed out. The challenge in Slice 2 is an authenticated
   onCall — issuing and verifying a code needs request.auth.uid. Signing the user out
   of Firebase would make verification impossible. So there are two distinct things:

     Firebase session      alive   — required to run the challenge
     application session   DENIED  — no `loggedIn`, no SokoniSecurity session,
                                     no cached profile, no protected page

   "Enter verification challenge state" is exactly that split.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* Informational only — what Slice 4's screen reads to know whose challenge to show.
     sessionStorage, not localStorage, precisely so it can never look like a durable
     session. NOTHING in this file, or anywhere else, may treat it as authority: the
     gate re-derives its answer from Firebase Auth on every single evaluation. */
  var PENDING_KEY = 'sokoniVerifyPending';

  /* The auth surfaces themselves are never gated — sending login.html to login.html
     is an infinite redirect. Matches with and without .html because cleanUrls:true
     strips the extension in production. */
  var AUTH_PAGE = /(^|\/)(login|signup|register|reset-password|verify-email)(\.html)?$/;

  function _providerIds(user) {
    var out = [], pd = (user && user.providerData) || [];
    for (var i = 0; i < pd.length; i++) {
      if (pd[i] && pd[i].providerId) out.push(pd[i].providerId);
    }
    return out;
  }

  /* ── the rule ───────────────────────────────────────────────────────────────
     Pure and synchronous, so it can be reasoned about and tested on its own.

     Only PASSWORD accounts are in scope. That is not a softening — it is what the
     requirement says ("successful password authentication"), and the other providers
     already carry their own proof of identity:

       google.com / facebook.com / apple.com   the provider asserts the address, and
                                               returns emailVerified true with it
       phone                                   the SMS *is* the factor, and such an
                                               account frequently has no email at all

     A phone account is therefore excluded explicitly rather than by accident: it has
     emailVerified false forever, so without this line the gate would trap every phone
     user in a challenge for an address they do not have. firebase.js has always
     treated phone as verified (`user.emailVerified || isPhone`); this agrees with it.

     An account with a password AND a federated provider linked is still gated when
     the flag is false. That combination is rare — Google returns verified addresses —
     and if it does occur the address genuinely has not been proven for this account,
     which is the case the gate exists for. It is asserted in the suite rather than
     left as an accident of ordering. */
  function needsVerification(user) {
    if (!user) return false;
    if (user.emailVerified === true) return false;   /* authoritative, and terminal */
    var ids = _providerIds(user);
    if (ids.indexOf('phone') !== -1) return false;   /* SMS is the factor */
    if (!user.email) return false;                   /* nothing to verify against */
    return ids.indexOf('password') !== -1;           /* password accounts only */
  }

  /* One in-flight server refresh at a time.

     enforce() is called FROM onAuthStateChanged, and reload() refreshes the current user —
     which, depending on SDK version, can itself notify auth-state listeners. Without a
     guard that is a loop: listener → reload → listener → reload, a refresh storm against
     Firebase that only ever hits the accounts being gated, i.e. the ones least able to
     report it. Sharing a single promise makes a re-entrant call JOIN the refresh already
     running instead of starting another. Cheap, and it removes the question entirely
     rather than relying on which SDK version is loaded.

     Keyed by uid. An account switch fires sign-out then sign-in, so two different users
     can in principle overlap here by a hair; sharing one promise across them would hand
     the second user a verdict without ever refreshing them. That can only ever fail
     CLOSED — a stale `true` short-circuits before this function is reached, so the only
     flag that arrives here is `false` — but "wrong for a safe reason" is still wrong, and
     the key costs one comparison. */
  var _refreshing = null, _refreshUid = null;

  function _refresh(user) {
    var uid = user && user.uid;
    if (_refreshing && _refreshUid === uid) return _refreshing;
    var p = Promise.resolve()
      .then(function () { return user.reload && user.reload(); })
      /* Offline or App Check refusal: keep the gate closed. A verified user never
         reaches this line, so failing closed cannot lock anybody out. */
      .catch(function () { })
      /* Only the CURRENT in-flight refresh may clear the slot; an older one finishing
         late must not wipe a newer user's. */
      .then(function () { if (_refreshing === p) { _refreshing = null; _refreshUid = null; } });
    _refreshing = p; _refreshUid = uid;
    return p;
  }

  /* ── evaluate ───────────────────────────────────────────────────────────────
     The rule plus the server refresh. Returns a verdict; changes nothing. */
  function evaluate(user, opts) {
    opts = opts || {};
    if (!user)                    return Promise.resolve({ gated: false, reason: 'no-user' });
    if (user.emailVerified === true) return Promise.resolve({ gated: false, reason: 'verified' });
    if (!needsVerification(user)) return Promise.resolve({ gated: false, reason: 'not-applicable' });

    var reload = opts.reload === false ? Promise.resolve() : _refresh(user);

    return reload.then(function () {
      if (!needsVerification(user)) return { gated: false, reason: 'verified-on-reload' };
      return { gated: true, reason: 'email-unverified', uid: user.uid, email: user.email };
    });
  }

  /* ── denial ─────────────────────────────────────────────────────────────────
     Every representation of an application session, removed together.

     `loggedIn` is what auth-guard.js reads synchronously in <head>, so clearing it is
     what makes a later direct navigation bounce before the page paints. The
     SokoniSecurity session and the cached profile go with it: leaving either behind
     lets some other surface reconstruct a plausible-looking session out of stale
     cache. The Firebase session is untouched — see the header. */
  function denyAppSession() {
    try { global.localStorage.removeItem('loggedIn'); } catch (e) { }
    try { global.localStorage.removeItem('sokoniUser'); } catch (e) { }
    try {
      if (global.SokoniSecurity && global.SokoniSecurity.clearSession) {
        global.SokoniSecurity.clearSession();
      }
    } catch (e) { }
  }

  function markPending(res) {
    try {
      global.sessionStorage.setItem(PENDING_KEY, JSON.stringify({
        uid: res.uid || null, reason: res.reason || 'email-unverified', at: Date.now(),
      }));
    } catch (e) { }
  }
  function clearPending() {
    try { global.sessionStorage.removeItem(PENDING_KEY); } catch (e) { }
  }
  function isPending() {
    try { return !!global.sessionStorage.getItem(PENDING_KEY); } catch (e) { return false; }
  }

  function _path() {
    try { return (global.location.pathname || '').toLowerCase(); } catch (e) { return ''; }
  }
  function isAuthPage(p) { return AUTH_PAGE.test(p == null ? _path() : String(p).toLowerCase()); }

  function isProtectedPage(doc) {
    try {
      var d = doc || global.document;
      return !!d && d.documentElement.dataset.requireAuth === 'true';
    } catch (e) { return false; }
  }

  /* Only the path and query are carried, never an absolute URL — the same discipline
     auth-guard.js uses, so the address bar cannot smuggle in an open redirect. */
  function _redirect() {
    var next = '';
    try { next = global.location.pathname + global.location.search; } catch (e) { }
    var target = 'login.html?verify=1&next=' + encodeURIComponent(next);
    try { global.location.replace(target); }
    catch (e) { try { global.location.href = target; } catch (e2) { } }
    return target;
  }

  /* ── enforce ────────────────────────────────────────────────────────────────
     Evaluate, then act. Called from the two places a session can begin: the login
     path in auth.js, and the onAuthStateChanged handler in firebase.js that runs on
     every page load and every token refresh. The second is what makes refresh and
     direct navigation stay gated — the gate is not something the login path sets and
     later surfaces trust, it is re-derived from Firebase Auth every time.

     A gated user is denied EVERYWHERE (no session anywhere) but only REDIRECTED off
     pages that ask for auth. Bouncing someone off the public homepage would be a
     worse experience than the gate needs, and grants nothing. */
  function enforce(user, opts) {
    opts = opts || {};
    return evaluate(user, opts).then(function (res) {
      if (!res.gated) { clearPending(); return res; }

      denyAppSession();
      markPending(res);

      try {
        global.document && global.document.dispatchEvent(
          new global.CustomEvent('sokoniVerificationRequired', {
            detail: { uid: res.uid || null, reason: res.reason },
          }));
      } catch (e) { }

      if (opts.redirect !== false && isProtectedPage() && !isAuthPage()) {
        res.redirectedTo = _redirect();
      }
      return res;
    });
  }

  var API = {
    PENDING_KEY: PENDING_KEY,
    needsVerification: needsVerification,
    evaluate: evaluate,
    enforce: enforce,
    denyAppSession: denyAppSession,
    isPending: isPending,
    clearPending: clearPending,
    isAuthPage: isAuthPage,
    isProtectedPage: isProtectedPage,
  };

  global.SokoniVerifyGate = API;

  /* Node reads this same shipped file so the suite tests what ships, not a copy. */
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof window !== 'undefined' ? window : globalThis);
