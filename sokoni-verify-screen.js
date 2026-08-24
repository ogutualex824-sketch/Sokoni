/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — Email verification screen  (Auth Slice 4)
   ------------------------------------------------------------------------------
   The screen a password account sees when Slice 3's gate holds it. It talks to
   authDispatch (Slice 2) and to nothing else: it has no idea what the code is, cannot
   compute one, and cannot decide that anybody is verified.

   THE ONE RULE THIS FILE EXISTS TO KEEP
   -------------------------------------
   Success is never claimed from a response alone. `emailChallengeVerify` returning
   ok:true means the SERVER marked the Auth record — so before this screen says a single
   reassuring word, it calls user.reload() and re-reads emailVerified from the refreshed
   token. If that flag is not true, the user is told it did not complete, however
   encouraging the response looked. A verification screen that says "Verified!" and then
   drops you back at the gate is worse than one that says nothing.

   WHY STATUS IS CALLED BEFORE ISSUE
   ---------------------------------
   Opening the screen does not automatically send mail. The model enforces a 60s resend
   cooldown and a ceiling of 5 sends per challenge; auto-issuing on every open would burn
   that budget on refreshes and back-buttons, and the user would be told to wait for a
   cooldown they never asked to start. So the screen asks `emailChallengeStatus` what is
   already true — verified? a live challenge? when may we resend? — and only issues when
   there is nothing to resume.

   REUSED, NOT REBUILT
   -------------------
   The six-digit entry is `SokoniOtp` — the same component the phone OTP flow mounts, which
   exists because three pages had each grown their own grid. The mail goes out through
   email-service. The rate limits are the shared limiter's. This slice adds a screen.

   SLICE BOUNDARY
   --------------
   No session transition work: on success the page navigates, so firebase.js's
   onAuthStateChanged runs again from scratch and builds the session by its normal path.
   Deciding what a live session should do the moment verification lands mid-flight is
   Slice 5, and is deliberately not attempted here.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var OP = 'authDispatch';

  /* Server reason codes → what a person is told. Anything unrecognised falls through to a
     neutral failure rather than leaking a raw code, and never to a success. */
  var COPY = {
    'bad-input':      'That code does not look right. Enter the 6 digits from the email.',
    'bad-code':       'That code is not correct.',
    'expired':        'That code has expired. Send a new one.',
    'consumed':       'That code has already been used. Send a new one.',
    'not-found':      'That code is no longer valid. Send a new one.',
    'max-attempts':   'Too many incorrect attempts. Send a new code to try again.',
    'cooldown':       'Please wait before requesting another code.',
    'max-sends':      'You have requested several codes. Wait a few minutes, or sign in again later.',
    'no-email':       'This account has no email address on file. Contact support.',
    'mismatch':       'Your email address changed. Send a new code.',
  };

  function _copy(reason, fallback) {
    return COPY[reason] || fallback || 'That did not work. Please try again.';
  }

  /* ── the one call this screen makes ────────────────────────────────────────── */
  function _call(op, data) {
    var payload = data || {};
    payload.op = op;
    if (typeof global.sokoniCallable === 'function') {
      return global.sokoniCallable(OP)(payload).then(function (r) { return r && r.data; });
    }
    /* firebase.js publishes sokoniCallable; if it has not run yet, load the SDK the same
       way the rest of the app does rather than inventing a second transport. */
    return import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js')
      .then(function (m) {
        var fns = m.getFunctions(global.firebaseApp, 'us-central1');
        return m.httpsCallable(fns, OP)(payload);
      })
      .then(function (r) { return r && r.data; });
  }

  /* ── view ──────────────────────────────────────────────────────────────────── */
  var S = {
    host: null, card: null, otp: null, user: null, next: null,
    busy: false, tick: null, canResendAt: 0, destroyed: false,
  };

  function _el(id) { try { return global.document.getElementById(id); } catch (e) { return null; } }

  function _msg(text, kind) {
    var m = _el('skvMsg');
    if (!m) return;
    m.textContent = text || '';
    m.className = 'auth-msg ' + (kind || 'info');
    m.style.display = text ? 'block' : 'none';
  }

  /* Every network call passes through here, so "in flight" cannot be forgotten at one
     call site and leave the buttons live for a double submit. */
  function _busy(on, label) {
    S.busy = !!on;
    var v = _el('skvVerifyBtn'), r = _el('skvResendBtn');
    if (v) { v.disabled = !!on; v.textContent = on && label ? label : 'Verify →'; }
    if (r) r.disabled = !!on || Date.now() < S.canResendAt;
    if (S.otp && S.otp.error) S.otp.error(false);
  }

  function _renderCooldown() {
    var r = _el('skvResendBtn'), t = _el('skvTimer');
    var left = Math.max(0, S.canResendAt - Date.now());
    if (t) t.textContent = left > 0 ? 'You can request another code in ' + Math.ceil(left / 1000) + 's' : '';
    if (r) r.disabled = S.busy || left > 0;
    if (left <= 0 && S.tick) { clearInterval(S.tick); S.tick = null; }
  }

  function _startCooldown(ms) {
    S.canResendAt = Date.now() + (Number(ms) || 0);
    if (S.tick) clearInterval(S.tick);
    if (S.canResendAt > Date.now()) {
      S.tick = setInterval(_renderCooldown, 1000);
      /* Node has no unref on browser timers; guard so tests can exit. */
      if (S.tick && typeof S.tick.unref === 'function') S.tick.unref();
    }
    _renderCooldown();
  }

  var TEMPLATE =
    '<div class="skv-wrap">' +
      '<h2 class="auth-title">Confirm your email</h2>' +
      '<p class="auth-sub" id="skvSub">Enter the 6-digit code we sent you.</p>' +
      '<div id="skvMsg" class="auth-msg" style="display:none"></div>' +
      '<div id="skvOtp"></div>' +
      '<button type="button" class="auth-btn" id="skvVerifyBtn">Verify →</button>' +
      '<p class="otp-resend-row">' +
        '<span id="skvTimer"></span>' +
        '<button type="button" id="skvResendBtn" class="skv-link">Send a new code</button>' +
      '</p>' +
      '<p class="auth-switch">' +
        '<button type="button" id="skvBackBtn" class="skv-link">Use a different account</button>' +
      '</p>' +
    '</div>';

  /* ── actions ───────────────────────────────────────────────────────────────── */

  function _issue(isResend) {
    if (S.busy) return Promise.resolve();
    _busy(true, 'Sending…');
    _msg('', 'info');
    return _call('emailChallengeIssue')
      .then(function (res) {
        _busy(false);
        if (!res) { _msg('Could not reach the server. Check your connection and try again.', 'error'); return; }

        if (res.alreadyVerified) return _complete();

        if (!res.ok) {
          _msg(_copy(res.reason), 'error');
          if (res.retryAfterMs) _startCooldown(res.retryAfterMs);
          return;
        }

        /* delivered:false means the code exists but the mail did not leave. Saying
           "check your inbox" here would send the user to wait for something that is not
           coming — the honest move is to say so and let them retry. */
        if (res.delivered === false) {
          _msg('We could not send the email just now' +
               (res.deliveryError ? ' (' + res.deliveryError + ')' : '') +
               '. You can request another code.', 'error');
        } else {
          _msg(isResend ? 'A new code is on its way.' : '', 'info');
          var sub = _el('skvSub');
          if (sub && res.emailHint) sub.textContent = 'Enter the 6-digit code we sent to ' + res.emailHint + '.';
        }
        _startCooldown(res.cooldownMs);
        if (S.otp) { S.otp.clear(); S.otp.focus(); }
      })
      .catch(function (e) {
        _busy(false);
        _msg(_friendly(e), 'error');
      });
  }

  function _verify() {
    if (S.busy) return Promise.resolve();
    var code = S.otp ? String(S.otp.value() || '') : '';
    if (!/^\d{4,8}$/.test(code)) {
      if (S.otp && S.otp.error) S.otp.error(true);
      _msg('Enter the 6 digits from the email.', 'error');
      return Promise.resolve();
    }
    /* The orbit carries the verification state; without this call the cinematic
       layer never leaves idle on a real page. Verification itself is untouched. */
    if (S.otp && S.otp.state) { S.otp.error(false); S.otp.state('verifying'); }
    _busy(true, 'Verifying…');
    _msg('', 'info');
    return _call('emailChallengeVerify', { code: code })
      .then(function (res) {
        if (!res) { _busy(false); _msg('Could not reach the server. Try again.', 'error'); return; }

        if (!res.ok) {
          _busy(false);
          if (S.otp) { if (S.otp.state) S.otp.state(null);
                       if (S.otp.error) S.otp.error(true); S.otp.clear(); S.otp.focus(); }
          var extra = (typeof res.attemptsRemaining === 'number' && res.attemptsRemaining > 0 &&
                       res.reason === 'bad-code')
            ? ' ' + res.attemptsRemaining + ' attempt' + (res.attemptsRemaining === 1 ? '' : 's') + ' left.'
            : '';
          _msg(_copy(res.reason) + extra, 'error');
          return;
        }
        /* Success state on the ORBIT — but _complete() still PROVES the claim
           against a refreshed token before anything is promised to the user, so
           this shows verification of the CODE, not of the entitlement. */
        if (S.otp && S.otp.state) S.otp.state('verified');
        return _complete();
      })
      .catch(function (e) {
        if (S.otp && S.otp.state) S.otp.state(null);
        _busy(false);
        _msg(_friendly(e), 'error');
      });
  }

  /* ── completion — the only place success may be claimed ────────────────────── */
  function _complete() {
    /* The server said it marked the record. PROVE it against a refreshed token before
       telling the user anything, because the alternative is a green message followed by
       the gate refusing them again — a false success, and the defect class this platform
       has a standing rule about. */
    _busy(true, 'Confirming…');
    return Promise.resolve()
      .then(function () { return S.user && S.user.reload && S.user.reload(); })
      .then(function () {
        var verified = !!(S.user && S.user.emailVerified === true);
        if (!verified) {
          _busy(false);
          _msg('That did not complete. Please request a new code and try again.', 'error');
          return false;
        }
        /* Tell the other tabs, and only now — after the refreshed token agreed. An
           announcement made on the response alone would release tabs for an account that
           is not actually verified, turning one tab's false success into several. */
        try {
          if (global.SokoniVerifyGate && global.SokoniVerifyGate.announce) {
            global.SokoniVerifyGate.announce('verified', S.user && S.user.uid);
          }
        } catch (e) { }

        _msg('Email confirmed. Taking you through…', 'success');
        _navigate();
        return true;
      })
      .catch(function () {
        _busy(false);
        /* Could not confirm — so do not claim. */
        _msg('We could not confirm that just now. Check your connection and try again.', 'error');
        return false;
      });
  }

  /* Navigating re-runs firebase.js's onAuthStateChanged from a clean load, which builds
     the application session by its ordinary path. Deliberately not a live in-page
     transition: that is Slice 5. */
  function _navigate() {
    var target = S.next || 'index.html';
    if (typeof global.SokoniVerifyScreen._navigateOverride === 'function') {
      return global.SokoniVerifyScreen._navigateOverride(target);
    }
    try { global.location.replace(target); }
    catch (e) { try { global.location.href = target; } catch (e2) { } }
  }

  function _friendly(e) {
    var code = (e && (e.code || e.message)) || '';
    if (/app-?check|unauthenticated/i.test(code)) return 'Your session expired. Sign in again.';
    if (/resource-exhausted|rate/i.test(code)) return 'Too many attempts. Wait a minute and try again.';
    if (/unavailable|network|internal/i.test(code)) return 'Could not reach the server. Check your connection.';
    return 'Something went wrong. Please try again.';
  }

  /* Back path. A true "change my email address" needs a server op that does not exist —
     changing the address on the Auth record is not something this screen may do, and
     adding it was not part of this slice. What it offers instead is honest and complete:
     leave this account. Signing out is what makes the next login a clean one rather than
     returning to the same held session. */
  function _back() {
    _busy(true, 'Signing out…');
    Promise.resolve()
      .then(function () {
        if (global.SokoniAuth && global.SokoniAuth.signOut) return global.SokoniAuth.signOut();
        if (global.firebaseAuth && global.firebaseAuth.signOut) return global.firebaseAuth.signOut();
      })
      .catch(function () { })
      .then(function () {
        try { global.sessionStorage.removeItem('sokoniVerifyPending'); } catch (e) { }
        try { global.location.replace('login.html'); } catch (e) { }
      });
  }

  /* ── open ──────────────────────────────────────────────────────────────────── */
  function open(opts) {
    opts = opts || {};
    S.user = opts.user || (global.firebaseAuth && global.firebaseAuth.currentUser) || null;
    S.next = opts.next || null;
    S.destroyed = false;

    var host = opts.mount || _el('skvMount');
    if (!host || !S.user) return Promise.resolve(false);
    S.host = host;

    host.innerHTML = TEMPLATE;
    host.style.display = 'block';

    /* Take over the card with ONE class rather than making the caller enumerate which
       elements to hide — an enumeration silently goes stale the next time a field is
       added to the login form, leaving a password box floating under the code entry. */
    try {
      S.card = host.closest ? host.closest('.auth-card') : null;
      if (S.card) S.card.classList.add('skv-active');
    } catch (e) { S.card = null; }

    if (global.SokoniOtp && global.SokoniOtp.mount) {
      S.otp = global.SokoniOtp.mount('#skvOtp', {
        length: 6,
        orbit: true,
        label: 'Verification code',
        /* The subtitle carries the state here. Its idle text is captured on the
           first transition rather than hard-coded, because it is rewritten with
           the email hint once that resolves — restoring a literal would wipe it. */
        onState: function (st) {
          var sub = document.getElementById('skvSub');
          if (!sub) return;
          if (S._subIdle == null) S._subIdle = sub.textContent;
          sub.textContent = st === 'verifying' ? 'Verifying…' :
                            st === 'verified'  ? '✓ Verified' : S._subIdle;
        },
        onComplete: function () { _verify(); },
      });
    }

    var v = _el('skvVerifyBtn'); if (v) v.onclick = function () { _verify(); };
    var r = _el('skvResendBtn'); if (r) r.onclick = function () { _issue(true); };
    var b = _el('skvBackBtn');   if (b) b.onclick = function () { _back(); };

    /* Ask what is already true before spending a send. */
    _busy(true, 'Checking…');
    return _call('emailChallengeStatus')
      .then(function (st) {
        _busy(false);
        if (!st) { _msg('Could not reach the server. Reload and try again.', 'error'); return false; }

        /* Awaited. Returning before the proof-and-navigate finishes would let a caller
           believe the screen had settled while it was still deciding — and the test that
           caught this saw open() resolve with the user still sitting on the card. */
        if (st.emailVerified) return _complete().then(function () { return true; });

        var sub = _el('skvSub');
        if (sub && st.emailHint) sub.textContent = 'Enter the 6-digit code we sent to ' + st.emailHint + '.';

        var live = st.challenge && !st.challenge.expired && !st.challenge.consumed &&
                   (st.challenge.attemptsRemaining == null || st.challenge.attemptsRemaining > 0);

        if (live) {
          /* Resume rather than resend — the code already in their inbox still works. */
          var wait = (st.challenge.canResendAt || 0) - Date.now();
          _startCooldown(wait > 0 ? wait : 0);
          _msg('', 'info');
          if (S.otp) S.otp.focus();
          return true;
        }
        return _issue(false).then(function () { return true; });
      })
      .catch(function (e) {
        _busy(false);
        _msg(_friendly(e), 'error');
        return false;
      });
  }

  /* Auth Slice 5 — the screen must not outlive the session it was opened for.

     Two ways that happens: the user signs out (here or in another tab), or a different
     account signs in. In both cases the code entry on screen belongs to somebody who is
     no longer there, and a code typed into it would be verified against whoever IS there.
     firebase.js calls this from onAuthStateChanged, so the screen follows the same
     authoritative signal as the gate rather than keeping its own idea of who is present. */
  function onAuthChange(user) {
    if (!S.host) return false;                       /* not open — nothing to tear down */
    var sameUser = user && S.user && user.uid === S.user.uid;
    if (sameUser) return false;
    destroy();
    try {
      S.host.innerHTML = '';
      S.host.style.display = 'none';
    } catch (e) { }
    S.user = null; S.host = null;
    return true;
  }

  function destroy() {
    S.destroyed = true;
    try { if (S.card) S.card.classList.remove('skv-active'); } catch (e) { }
    S.card = null;
    if (S.tick) { clearInterval(S.tick); S.tick = null; }
    if (S.otp && S.otp.destroy) { try { S.otp.destroy(); } catch (e) { } }
    S.otp = null;
  }

  /* ══ LANDING  (Finding 1 from the auth-flow review) ═══════════════════════════
     The gate redirects a held user off a protected page to login.html?verify=1&next=…,
     sets sokoniVerifyPending, and dispatches sokoniVerificationRequired. Until now nothing
     consumed any of the three: the user arrived at an ordinary login form, still signed in
     to Firebase, with no explanation, and had to retype the password they had just used.

     THE TRIGGER IS THE EVENT, NOT THE MARKER OR THE URL
     ---------------------------------------------------
     sokoniVerificationRequired is dispatched by the gate only AFTER an authoritative
     evaluation — which for an unverified account includes a server refresh of
     emailVerified. So reacting to it is reacting to Firebase's answer.

     The marker and ?verify=1 are NOT evidence and are never treated as any. Somebody who
     writes sokoniVerifyPending by hand, or types ?verify=1, gets nothing: the reconciler
     below re-runs enforce(), which asks Firebase again, and opens the screen only if the
     gate says gated. A forged marker cannot produce a challenge, and — more importantly —
     could never have produced a session anyway, because this file cannot create one.

     WHY THERE IS A RECONCILER AS WELL AS A LISTENER
     -----------------------------------------------
     On login.html this script is a classic tag and firebase.js is a module, so the
     listener is always registered before auth resolves. The reconciler covers the case
     where that ordering does not hold — a slow module, a bfcache restore, a page that
     loads the screen late. It re-derives rather than trusting what it finds. */
  function _nextFromUrl() {
    var raw = '';
    try {
      var m = /[?&]next=([^&]*)/.exec(global.location.search || '');
      if (m) raw = decodeURIComponent(m[1]);
    } catch (e) { raw = ''; }
    if (!raw) return null;
    /* Sanitised by auth.js's single copy of the rule. If that helper is not present the
       destination is DROPPED rather than used unchecked — the safe direction, and it keeps
       the open-redirect guard from being copied into this file. */
    try {
      if (typeof global._sokoniLoginRedirect === 'function') {
        return global._sokoniLoginRedirect(true, raw);
      }
    } catch (e) { }
    return null;
  }

  function _landIfHeld(user) {
    if (S.host) return Promise.resolve(false);          /* already open — do not restart */
    if (!user) return Promise.resolve(false);
    var mount = _el('skvMount');
    if (!mount) return Promise.resolve(false);          /* page has no screen to show */
    return open({ user: user, mount: mount, next: _nextFromUrl() });
  }

  function _installLanding() {
    try {
      global.document.addEventListener('sokoniVerificationRequired', function () {
        var u = (global.firebaseAuth && global.firebaseAuth.currentUser) || null;
        _landIfHeld(u);
      });
    } catch (e) { }

    /* One late reconciliation, once auth has had a chance to resolve. It re-derives via
       enforce() — the marker only decides whether it is worth asking, never the answer. */
    function reconcile() {
      if (S.host) return;
      if (!isPending()) return;
      var u = (global.firebaseAuth && global.firebaseAuth.currentUser) || null;
      if (!u) { clearPendingIfAny(); return; }
      var gate = global.SokoniVerifyGate;
      if (!gate || !gate.enforce) return;
      gate.enforce(u, { redirect: false }).then(function (res) {
        if (res && res.gated) _landIfHeld(u);
      }).catch(function () { });
    }
    function clearPendingIfAny() {
      /* Signed out, so the marker belongs to a session that no longer exists. */
      try { global.SokoniVerifyGate && global.SokoniVerifyGate.clearPending(); } catch (e) { }
    }
    /* WHEN to reconcile. Not at parse time: this script is a classic tag and firebase.js
       is a module, so at the moment this runs `firebaseAuth` does not exist yet and a
       reconciliation would look at nothing and conclude nothing. The first version did
       exactly that on a page whose readyState was already 'complete', which made the
       reconciler decorative — the suite caught it.

       So it hangs off the signals that mean "Firebase is up": sokoniFirebaseReady, which
       firebase.js dispatches, and window load as a backstop for a page that loaded the SDK
       before this script. Both are idempotent — reconcile() returns immediately once the
       screen is open. */
    try {
      global.document.addEventListener('sokoniFirebaseReady', reconcile);
    } catch (e) { }
    try {
      global.addEventListener('load', reconcile);
    } catch (e) { }
    try {
      if (global.__sokoniFirebaseReady) reconcile();   /* already up — reconcile now */
    } catch (e) { }
  }

  function isPending() {
    try {
      return !!(global.SokoniVerifyGate && global.SokoniVerifyGate.isPending());
    } catch (e) { return false; }
  }

  /* Only where a mount exists — i.e. login.html and signup.html. Everywhere else this file
     is not loaded at all, and the gate's redirect is what applies. */
  try {
    if (global.document && global.document.getElementById) _installLanding();
  } catch (e) { }

  global.SokoniVerifyScreen = {
    open: open,
    destroy: destroy,
    onAuthChange: onAuthChange,
    /* exposed for the suite */
    _landIfHeld: _landIfHeld, _nextFromUrl: _nextFromUrl,
    /* exposed for the suite; not part of the page contract */
    _state: S, _copy: _copy, _call: _call, _verify: _verify, _issue: _issue,
    _complete: _complete, _back: _back,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.SokoniVerifyScreen;

})(typeof window !== 'undefined' ? window : globalThis);
