/* ============================================================================
   SOKONI — Role Authority  (sokoni-role-authority.js)          Roles Phase 4

   THE single client answer to "which roles has the SERVER granted this account,
   and which one is it acting as". The client counterpart of
   functions/role-vocabulary.js — the same canonical vocabulary, never a second one.

   THE INVARIANT
     A role is authoritative ONLY when it comes from a verified Firebase ID token.
     localStorage and sessionStorage are NEVER authoritative here. Not as a
     fallback, not for first paint, not "just for the workspace switcher".

   WHY THIS EXISTS SEPARATELY FROM sokoni-permissions.js
   sokoni-permissions.js is the 8-role RBAC hierarchy (superAdmin > admin >
   moderator > … > user) that gates ADMINISTRATIVE surfaces. It deliberately lets
   seller/provider/driver-tier roles resolve from cache for fast first paint, and
   requires verification only for moderator-and-above (`_verifiedThisLoad`). That
   trade is right for rendering a nav bar; it is wrong for deciding whether someone
   may enter a seller workspace, because the cache is attacker-writable.

   This module makes no such trade. `_approved` is in-memory only, is never
   serialised, and is populated solely by a verified token in THIS page load.
   A forged `sokoniUser.roles` or a forged permissions cache changes nothing here.

   NOT sokoni-workspace.js. That module is the EMPLOYMENT layer — one person,
   many businesses, membership-based. A "role workspace" is a different axis
   entirely (am I acting as a seller or as a rider), and conflating the two would
   break the multi-business model. They coexist; neither owns the other.

   Exposed as:  window.SokoniRoleAuthority
   Events on document:
     sokoniRoleAuthorityReady   — verification completed (detail = {approved, activeRole})
     sokoniActiveRoleChanged    — the acting role changed (detail = {role})
   ========================================================================== */
(function (window) {
  'use strict';

  /* ── Canonical vocabulary ───────────────────────────────────────────────────
     Mirrors CANONICAL_ROLES in functions/role-vocabulary.js. `admin` and `staff`
     are canonical roles server-side but are NOT workspace roles — administrative
     access is sokoni-permissions.js's job, and duplicating it here would create a
     second path to the same privilege. */
  var CANONICAL = ['buyer', 'seller', 'provider', 'mechanic', 'rider',
                   'health', 'legal', 'landlord', 'tenant'];

  /* Legacy claim names that mean a canonical role. Phase 2's grantAccountRole
     writes the canonical claim AND keeps the legacy one, so these are only
     consulted when the canonical claim is absent — an older token minted before
     Phase 2 still resolves correctly instead of silently losing the role. */
  var LEGACY_CLAIM = { driver: 'rider', healthcare: 'health', lawyer: 'legal',
                       merchant: 'seller', vendor: 'seller' };

  /* buyer is the baseline every account holds. It is the role revocation demotes
     to, and the one selection that never needs a claim. */
  var BASELINE = 'buyer';

  /* Refresh failures that mean the SESSION is no longer valid, as opposed to the
     network being unreachable. These drop the caller to baseline; everything else
     preserves the last verified set. See the catch in refresh(). */
  var AUTH_INVALID = /unauthenticated|token-expired|user-token-expired|user-disabled|user-not-found|invalid-user-token|requires-recent-login/i;

  /* Where each role's approval-provisioned profile lives. These are the
     collections functions/application-lifecycle.js actually writes; a role with no
     uid-keyed profile of its own maps to null rather than to a guess. */
  var PROFILE_PATH = {
    seller:   'sellers',
    provider: 'providers',
    mechanic: 'mechanics',          /* uid-keyed, ALONGSIDE legacy mechanics/{docId} */
    rider:    'drivers',
    health:   'healthProviders',
    legal:    'legalProviders',     /* authority; `lawyers` is its search projection */
    landlord: 'landlordProfiles',
    tenant:   'tenantProfiles',     /* PRIVATE — owner-or-admin read, never indexed */
    buyer:    null,
  };

  /* Firestore is loaded lazily so a page that never switches roles never pays for
     the SDK. Behind a seam because a hard-coded URL import cannot be exercised in a
     test runner — without this, the SUCCESS path of setActiveRole/fetchRoleProfile
     could only ever be inferred from the rules, never actually run. Test-only
     override; production always uses the real loader. */
  var _fsLoader = function () {
    return import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  };

  /* ── State. In-memory ONLY. ─────────────────────────────────────────────────
     ENTITLEMENT (`_approved`, `_verified`) is never written to localStorage,
     sessionStorage, IndexedDB or a cookie, and never restored from any of them.
     That is the whole security property: there is no storage location an attacker
     can edit to appear approved.

     `_activeRole` is deliberately NOT covered by that rule, and the distinction is
     the point. It is not an entitlement — it is a SELECTION among roles the signed
     claims have already approved, and it is re-validated against `_approved` on
     every restore (see _restoreActiveRole) and on every refresh. Editing the mirror
     can therefore only ever pick a role the token already grants; it cannot add one.
     A forged `activeRole:'seller'` on an account without the seller claim is
     discarded, exactly as an unapproved setActiveRole call is refused.

     The rule previously read "never restored from any of them" without that split,
     which stated a stronger invariant than the security property requires — and
     under it `activeRole` was written to users/{uid} but never read back, so the
     acting role silently reset to buyer on every page load. */
  var _approved = null;      /* null = not yet verified this load */
  var _verified = false;
  var _activeRole = BASELINE;
  /* True once the acting role has been decided this load — by an explicit
     setActiveRole, by a revoke demotion, or by a restore. Keeps a later refresh()
     from re-seeding over a choice already made in this page load. */
  var _activeSelected = false;
  var _lastError = null;
  var _readyPromise = null;

  function _canonical(role) {
    var r = String(role == null ? '' : role).trim().toLowerCase();
    if (CANONICAL.indexOf(r) > -1) return r;
    return LEGACY_CLAIM[r] || null;
  }

  /* ── Approved-role discovery ────────────────────────────────────────────────
     Reads the DECODED CLAIMS of a signed ID token. A claim is signed by Firebase
     and cannot be forged by the client; the user document can be influenced by the
     client, which is exactly why users.roles is not consulted here. */
  function _rolesFromClaims(claims) {
    var out = [BASELINE];
    if (!claims) return out;
    CANONICAL.forEach(function (r) {
      if (claims[r] === true && out.indexOf(r) < 0) out.push(r);
    });
    /* Legacy claims only fill a gap the canonical claim did not already cover. */
    Object.keys(LEGACY_CLAIM).forEach(function (legacy) {
      var c = LEGACY_CLAIM[legacy];
      if (claims[legacy] === true && out.indexOf(c) < 0) out.push(c);
    });
    return out;
  }

  function _authUser() {
    try {
      if (window.firebaseAuth && window.firebaseAuth.currentUser) return window.firebaseAuth.currentUser;
    } catch (_) {}
    try {
      var s = window.SokoniAuthState && window.SokoniAuthState.getCurrentSession();
      if (s && s.user && typeof s.user.getIdTokenResult === 'function') return s.user;
    } catch (_) {}
    return null;
  }

  /* ── ID-token refresh ───────────────────────────────────────────────────────
     `force` sends getIdTokenResult(true), which round-trips to Firebase and picks
     up claims minted since sign-in — the ONLY way a newly approved role becomes
     visible without signing out. A revoked role disappears by the same path,
     because the approved set is rebuilt from the new claims rather than merged.

     FAILURE IS SAFE AND EXPLICIT. A refresh can fail for reasons that have nothing
     to do with entitlement (offline, App Check delay, clock skew). On failure the
     module does NOT fall back to stored roles and does NOT invent a set: it keeps
     whatever was last VERIFIED in this page load, or the baseline if nothing was.
     Callers can see `verified:false` and `error` and decide, instead of being
     handed a guess that looks authoritative. */
  function refresh(force) {
    _readyPromise = (async function () {
      var user = _authUser();
      if (!user) {
        /* Signed out is a real answer, not a failure: baseline only. */
        _approved = [BASELINE];
        _verified = false;
        _lastError = null;
        return _snapshot();
      }
      try {
        var res = await user.getIdTokenResult(force !== false);
        _approved = _rolesFromClaims(res && res.claims);
        _verified = true;
        _lastError = null;
        /* Claims are known, so the acting role persisted by the last switch can now
           be re-adopted — and validated against them. Runs before the revoke check
           below, which then covers the restored role too. */
        _restoreActiveRole();
        /* The acting role must remain inside the approved set. A role that has
           just been revoked cannot stay selected. */
        if (_approved.indexOf(_activeRole) < 0) _setActiveLocal(BASELINE);
      } catch (err) {
        _lastError = (err && (err.code || err.message)) || 'token-refresh-failed';
        /* Not every failure means the same thing, and treating them alike is a
           security bug in one direction and a usability bug in the other.

           A TRANSIENT failure (offline, App Check delay, backend blip) says
           nothing about entitlement — demoting on it would sign a legitimately
           approved user out of their own workspace on a bad connection. Keep the
           set that was last VERIFIED in this page load.

           An AUTH-INVALIDATING failure says the session itself is no longer good:
           the token is expired or revoked, or the account is disabled or gone.
           That is a statement about entitlement, so it drops to baseline
           immediately rather than coasting on roles proven by a session that has
           since died. */
        if (AUTH_INVALID.test(_lastError) || _approved == null) {
          _approved = [BASELINE];
          _verified = false;
          if (_activeRole !== BASELINE) _setActiveLocal(BASELINE);
        }
      }
      try {
        document.dispatchEvent(new CustomEvent('sokoniRoleAuthorityReady', { detail: _snapshot() }));
      } catch (_) {}
      return _snapshot();
    })();
    return _readyPromise;
  }

  function ready() { return _readyPromise || refresh(false); }

  function _snapshot() {
    return {
      approved: (_approved || [BASELINE]).slice(),
      activeRole: _activeRole,
      verified: _verified,
      error: _lastError,
    };
  }

  /* ── Queries. All answer from claims, never from storage. ─────────────────── */
  function getApprovedRoles() { return (_approved || [BASELINE]).slice(); }
  function isVerified() { return _verified; }

  function isApproved(role) {
    var r = _canonical(role);
    if (!r) return false;
    if (r === BASELINE) return true;
    /* Unverified means UNKNOWN, and unknown is not approval. */
    if (!_verified || _approved == null) return false;
    return _approved.indexOf(r) > -1;
  }

  function getActiveRole() { return _activeRole; }

  function _setActiveLocal(role) {
    _activeRole = role;
    _activeSelected = true;
    try { document.dispatchEvent(new CustomEvent('sokoniActiveRoleChanged', { detail: { role: role } })); } catch (_) {}
    /* Kept for the existing UI, which reads sokoniUser for rendering. This is a
       MIRROR of an already-authorised decision, never the decision itself. It is
       read back exactly once per load, by _restoreActiveRole, and only to re-pick a
       role the claims already approve — never to establish entitlement. */
    try {
      var raw = localStorage.getItem('sokoniUser');
      if (raw) { var u = JSON.parse(raw); u.activeRole = role; localStorage.setItem('sokoniUser', JSON.stringify(u)); }
    } catch (_) {}
  }

  /* ── Restoring the acting role ───────────────────────────────────────────────
     setActiveRole persists to users/{uid}.activeRole, but nothing read it back, so
     `_activeRole` began every page load at the baseline. The account was still
     approved for its roles — entitlement was never the problem — but the ACTING
     role silently reverted to buyer on each load, and any surface that asks the
     authority "who am I right now" answered buyer with full confidence. The header's
     role line prefers the authority over the mirror precisely because the authority
     is meant to be the truer of the two; that reasoning only holds once the
     authority actually knows.

     Restores from the local mirror rather than a getDoc: the mirror is written on
     every successful switch and costs no read on a path that runs on page load
     across the app, where one getDoc per signed-in user per page is real spend for
     a value the client already has.

     The restore is SAFE because it is a selection, not a grant. `_approved` comes
     from signed claims and is never sourced here; a mirror value that names a role
     outside the approved set is discarded, so tampering can only ever re-pick a
     role the token already carries. Returns quietly if a choice was already made
     this load, so a token refresh cannot re-seed over a live switch. */
  function _restoreActiveRole() {
    if (_activeSelected) return;
    if (!_verified || _approved == null) return;
    try {
      var raw = localStorage.getItem('sokoniUser');
      if (!raw) return;
      var u = JSON.parse(raw);
      var r = _canonical(u && u.activeRole);
      if (!r || r === _activeRole) return;
      if (_approved.indexOf(r) < 0) return;   /* not approved — discard, do not adopt */
      _activeRole = r;
      _activeSelected = true;
    } catch (_) { /* unparseable mirror — keep the baseline */ }
  }

  /* ── activeRole persistence ─────────────────────────────────────────────────
     Persisted straight to users/{uid}.activeRole. That IS the server-authorized
     path: the live rule activeRoleApproved() permits the write only when the
     caller's own claim grants the role (or it is the baseline), so the server has
     the final say whatever the client believes.

     The local check below is a courtesy, not the control — it turns a guaranteed
     permission-denied into an immediate, honest refusal. Removing it would change
     nothing about what can actually be persisted. */
  async function setActiveRole(role) {
    var r = _canonical(role);
    if (!r) return { ok: false, reason: 'unknown-role' };
    await ready();
    if (!isApproved(r)) return { ok: false, reason: _verified ? 'not-approved' : 'not-verified' };

    var user = _authUser();
    if (!user) return { ok: false, reason: 'signed-out' };

    try {
      var m = await _fsLoader();
      var db = window.firebaseDB;
      if (!db) return { ok: false, reason: 'db-unavailable' };
      await m.setDoc(m.doc(db, 'users', user.uid), { activeRole: r }, { merge: true });
      _setActiveLocal(r);
      return { ok: true, role: r };
    } catch (err) {
      var code = (err && err.code) || '';
      /* The rule refused. Do NOT retry and do NOT switch locally — the local view
         must not claim a role the server just declined. */
      if (/permission-denied/.test(code)) return { ok: false, reason: 'rejected-by-server' };
      return { ok: false, reason: code || 'write-failed' };
    }
  }

  /* ── Per-role profiles ──────────────────────────────────────────────────────
     The path only; fetching stays with the surface that owns the data. Returns
     null for a role with no uid-keyed profile, so a caller cannot construct a
     plausible-looking path for a collection that does not exist. */
  function getProfilePath(role, uid) {
    var r = _canonical(role);
    if (!r) return null;
    var col = PROFILE_PATH[r];
    if (!col) return null;
    var id = uid || (_authUser() && _authUser().uid);
    return id ? { collection: col, id: id, path: col + '/' + id } : null;
  }

  /* A tenant profile is personal data: owner-or-admin read, never indexed. */
  function isPrivateRole(role) { return _canonical(role) === 'tenant'; }

  /* Read the caller's OWN approval-provisioned profile.
     Deliberately uid-scoped with no argument for whose: landlordProfiles and
     tenantProfiles are owner-or-admin read, so a call for anyone else would be
     denied by the rules anyway — offering the parameter would only invite a
     caller to write code that fails in production.

     Returns {exists:false} rather than throwing when the document is absent: a
     role can be approved a moment before its profile projection lands, and an
     empty profile is a state to render, not an error to swallow. */
  async function fetchRoleProfile(role) {
    var r = _canonical(role);
    if (!r) return { ok: false, reason: 'unknown-role' };
    await ready();
    if (!isApproved(r)) return { ok: false, reason: _verified ? 'not-approved' : 'not-verified' };
    var loc = getProfilePath(r);
    if (!loc) return { ok: false, reason: 'no-profile-for-role' };
    try {
      var m = await _fsLoader();
      var db = window.firebaseDB;
      if (!db) return { ok: false, reason: 'db-unavailable' };
      var snap = await m.getDoc(m.doc(db, loc.collection, loc.id));
      return { ok: true, exists: snap.exists(), data: snap.exists() ? snap.data() : null, path: loc.path };
    } catch (err) {
      var code = (err && err.code) || '';
      if (/permission-denied/.test(code)) return { ok: false, reason: 'denied' };
      return { ok: false, reason: code || 'read-failed' };
    }
  }

  /* ── Workspace isolation ────────────────────────────────────────────────────
     A workspace is entered on the strength of a CLAIM. Editing sokoniUser.roles,
     the permissions cache, or any other client state changes nothing: this waits
     for verification and then asks the claim set.

     Deliberately fails CLOSED on an unverified token. A workspace is a privileged
     surface; if we cannot prove entitlement we do not grant it. That is the
     opposite trade from first-paint rendering, and intentionally so. */
  async function canEnterWorkspace(role) {
    await ready();
    return isApproved(role);
  }

  /* NOT-APPROVED and CANNOT-VERIFY are different answers and must not share a
     consequence.

       not-approved  the token was read and the role is genuinely absent. Sending
                     them somewhere useful is correct.
       not-verified  we could not read a token at all — offline, App Check delay,
                     mid-refresh. We do NOT know whether they are approved, and
                     bouncing on "don't know" is how the redirect loop in
                     sokoni-auth-state.js's header comment happened: a guarded page
                     redirected on a timing artefact, login bounced back on the
                     cached flag, and the two ping-ponged.

     So an unverifiable session is reported, never redirected. That is not a hole:
     the Firestore rules are the security boundary and they deny the DATA
     regardless. This guard is UX — it puts an unauthorised person somewhere
     sensible instead of on an empty dashboard. Failing it closed for someone we
     merely could not classify would lock out legitimate users on a bad connection
     while protecting nothing the rules were not already protecting. */
  async function guardWorkspace(role, opts) {
    var o = opts || {};
    await ready();
    var canonical = _canonical(role);
    if (isApproved(role)) return { ok: true, role: canonical };

    var reason = _verified ? 'not-approved' : 'not-verified';
    if (typeof o.onDenied === 'function') { try { o.onDenied(reason); } catch (_) {} }
    if (reason === 'not-approved' && o.redirect !== false) {
      /* Send them to the role's application (where they can actually get approved),
         not a generic page — falling back to /profile for a role with no intake. */
      var dest = o.deniedUrl || APPLICATION_ROUTES[canonical] || '/profile';
      try { window.location.replace(dest); } catch (_) {}
    }
    return { ok: false, reason: reason };
  }

  /* ── Declarative gating ─────────────────────────────────────────────────────
     The claim-verified counterpart of sokoni-permissions.js's [data-require-role],
     which resolves from the attacker-writable cache. Hides an element until the
     TOKEN says the role is held:

       <div data-require-approved-role="landlord"> … management UI … </div>

     Hidden until proven otherwise, so a slow token cannot flash privileged UI.
     Never applied to <html>/<body> — blanking a whole document over one attribute
     is the failure mode _filterNav() already had to guard against. */
  function applyDeclarativeGates(root) {
    var scope = root || document;
    var nodes;
    try { nodes = scope.querySelectorAll('[data-require-approved-role]'); } catch (_) { return; }
    Array.prototype.forEach.call(nodes, function (el) {
      if (el === document.documentElement || el === document.body) return;
      var wanted = (el.getAttribute('data-require-approved-role') || '')
        .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var ok = wanted.some(function (r) { return isApproved(r); });
      el.style.display = ok ? '' : 'none';
      el.setAttribute('data-approved-gate', ok ? 'open' : 'closed');
    });
  }

  /* ── Canonical workspace routes ─────────────────────────────────────────────
     sokoni-permissions.js's GUARDED_ROUTES maps these same pages onto the OLD
     8-role vocabulary, where landlord collapses to `business` and health/legal
     both collapse to `professional` — the exact collapse Phases 1-2 removed on the
     server. This registry is the canonical one. It is deliberately SHORT: only
     true workspaces appear. Public hubs (healthcare, legal-hub, car-hub, property)
     stay browsable by everyone — gating them would break public browsing, which
     CLAUDE.md requires. Management UI inside a hub uses the declarative attribute
     above instead. */
  /* Role -> the workspace that role enters. The inverse of WORKSPACE_ROUTES below, which
     answers "which role does this page require"; this answers "where does this role go".

     Every destination here is one already in use by the Profile switcher's ROLES[].hub —
     nothing is invented. It lives HERE rather than in profile.html so the Profile switcher
     and the header switcher route identically; two copies is how they drift.

     `admin` is deliberately absent, for the same reason it is absent from CANONICAL: it is
     not a workspace role, and giving it an acting context here would be the second path to
     administrative privilege this module exists to avoid. sokoni-permissions.js remains the
     admin authority. */
  var WORKSPACE_HUBS = {
    buyer:    'index.html',
    seller:   'merchant.html',
    provider: 'providers.html',
    rider:    'driver.html',
    mechanic: 'car-hub.html',
    health:   'healthcare.html',
    legal:    'legal-hub.html',
    landlord: 'landlord.html',
    tenant:   'property.html',
  };

  /* The destination for a role, or null when the role has no workspace. Returns null for a
     role the account does not hold: routing is a consequence of an authorised switch, never
     a way to reach a workspace without one. */
  function hubFor(role) {
    var r = _canonical(role);
    if (!r || !isApproved(r)) return null;
    return WORKSPACE_HUBS[r] || null;
  }

  var WORKSPACE_ROUTES = {
    'seller.html':   'seller',
    'driver.html':   'rider',
    'provider.html': 'provider',
    'landlord.html': 'landlord',
    'provider-dashboard.html': 'provider',
    'rider-dashboard.html':    'rider',
  };
  /* Where an AUTHENTICATED-but-not-approved user is sent per role: the role's own
     application/authorization flow ("Buyer -> X -> X application"). Falls back to
     /profile for any role without a dedicated intake. Canonical keys (driver -> rider). */
  var APPLICATION_ROUTES = {
    seller:   'onboarding-seller.html',
    provider: 'provider-onboarding.html',
    rider:    'onboarding-driver.html',
    landlord: 'onboarding-landlord.html',
  };

  async function guardPage(opts) {
    var page = (window.location.pathname.split('/').pop() || 'index.html');
    if (page && page.indexOf('.') < 0) page = page + '.html';   /* cleanUrls */
    var role = WORKSPACE_ROUTES[page];
    if (!role) return { ok: true, role: null, guarded: false };
    var res = await guardWorkspace(role, opts);
    res.guarded = true;
    return res;
  }

  window.SokoniRoleAuthority = {
    CANONICAL_ROLES: CANONICAL.slice(),
    BASELINE_ROLE: BASELINE,
    refresh: refresh,
    ready: ready,
    getApprovedRoles: getApprovedRoles,
    isApproved: isApproved,
    isVerified: isVerified,
    getActiveRole: getActiveRole,
    setActiveRole: setActiveRole,
    getProfilePath: getProfilePath,
    fetchRoleProfile: fetchRoleProfile,
    isPrivateRole: isPrivateRole,
    canEnterWorkspace: canEnterWorkspace,
    guardWorkspace: guardWorkspace,
    guardPage: guardPage,
    applyDeclarativeGates: applyDeclarativeGates,
    WORKSPACE_ROUTES: WORKSPACE_ROUTES,
    WORKSPACE_HUBS:   WORKSPACE_HUBS,
    hubFor:           hubFor,
    getSnapshot: _snapshot,
    /* Exposed for tests and for consumers that need to normalise a legacy value. */
    canonicalise: _canonical,
    /* TEST ONLY. Swaps the Firestore loader so the write/read paths can be exercised. */
    __setFirestoreLoader: function (fn) { _fsLoader = fn; },
  };

  /* Verify as soon as auth is authoritative. Not on script load — before the first
     onAuthStateChanged there is no token to read, and concluding "no roles" then
     would be the same class of bug sokoni-auth-state.js exists to prevent. */
  function _boot() {
    refresh(false).then(function () {
      applyDeclarativeGates();
      /* Guard the page only where a workspace route is declared. Everything else
         is a no-op, so loading this module can never gate a public page. */
      guardPage();
    });
  }
  /* A {once:true} listener only fires for an event that has not happened yet.
     firebase.js is a DEFERRED module and this is a CLASSIC script, so the ordering
     is not fixed: when sokoniAuthReady was published before this file registered,
     _boot never ran, refresh() never happened, and the authority stayed
     _verified=false with _approved=[buyer] for the whole page load.

     That is the state behind the original symptom. With isVerified() false the
     header falls back to sokoniUser.role while the switcher falls back to
     detail.role, and those two mirrors disagree — Driver on the left, Buyer in the
     dropdown, from one unverified authority rather than from two bad readers.

     firebase.js already records that the event fired. Read the flag as well as
     listening, so a late loader catches up instead of waiting forever. */
  var _booted = false;
  function _bootOnce() { if (_booted) return; _booted = true; _boot(); }

  /* Every trigger, none of them exclusive.

     The first version of this put the flag check and the catch-up poll in ELSE
     branches, so when SokoniAuthState existed — it does, on profile.html and
     elsewhere — that branch ran alone with no fallback behind it. And
     whenResolved() legitimately fires EARLY with an optimistic, signed-out session
     (its own timeout path), which makes refresh() settle on _approved=[buyer],
     _verified=false. In that branch nothing ever retried.

     An unverified authority is precisely the state that lets the header and the
     switcher fall back to two different mirrors and disagree. So: try every
     trigger, let _bootOnce()'s idempotence sort out which one wins, and keep
     watching until the authority has actually seen a user. */
  try {
    if (window.SokoniAuthState && window.SokoniAuthState.whenResolved) {
      window.SokoniAuthState.whenResolved(_bootOnce);
    }
    if (window.__sokoniAuthReady === true) _bootOnce();
    document.addEventListener('sokoniAuthReady', _bootOnce, { once: true });

    /* THE CONVERGENCE WATCH.
       Runs regardless of which trigger fired, and asks the only question that
       matters: is there a real user that the authority has not yet verified
       against? Bounded to ~10s so a genuinely signed-out session stops rather than
       polling forever, and it can only ever cause a re-verification — it never
       demotes, so it cannot widen or narrow entitlement on its own. */
    var _n = 0;
    (function _converge() {
      try {
        if (window.__sokoniAuthReady === true && !_booted) _bootOnce();
        if (_authUser() && !_verified) refresh(true);
        else if (_verified) return;                  /* settled — stop watching */
      } catch (_) {}
      if (++_n > 330) return;                        /* ~10s */
      setTimeout(_converge, 30);
    }());
  } catch (_) {}

  /* Re-verify when the SESSION changes, not only once per load. A token refresh
     that adds or removes a claim must reach the UI without a reload — otherwise a
     revoked role keeps its workspace open until the user happens to navigate. */
  try {
    document.addEventListener('sokoniAuthReady', function () {
      if (_booted) refresh(true);
    });
  } catch (_) {}

  /* Re-apply declarative gates whenever authority changes, so a role revoked
     mid-session closes its UI without a reload. */
  try {
    document.addEventListener('sokoniRoleAuthorityReady', function () { applyDeclarativeGates(); });
  } catch (_) {}
})(window);
