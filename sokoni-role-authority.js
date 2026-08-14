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
     Never written to localStorage, sessionStorage, IndexedDB or a cookie, and
     never restored from any of them. That is the whole security property: there
     is no storage location an attacker can edit to appear approved. */
  var _approved = null;      /* null = not yet verified this load */
  var _verified = false;
  var _activeRole = BASELINE;
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
    try { document.dispatchEvent(new CustomEvent('sokoniActiveRoleChanged', { detail: { role: role } })); } catch (_) {}
    /* Kept for the existing UI, which reads sokoniUser for rendering. This is a
       MIRROR of an already-authorised decision, never the decision itself —
       nothing in this module ever reads it back. */
    try {
      var raw = localStorage.getItem('sokoniUser');
      if (raw) { var u = JSON.parse(raw); u.activeRole = role; localStorage.setItem('sokoniUser', JSON.stringify(u)); }
    } catch (_) {}
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
      try { window.location.replace(o.deniedUrl || '/profile'); } catch (_) {}
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
  var WORKSPACE_ROUTES = {
    'seller.html':   'seller',
    'driver.html':   'rider',
    'provider.html': 'provider',
    'landlord.html': 'landlord',
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
  try {
    if (window.SokoniAuthState && window.SokoniAuthState.whenResolved) {
      window.SokoniAuthState.whenResolved(_boot);
    } else {
      document.addEventListener('sokoniAuthReady', _boot, { once: true });
    }
  } catch (_) {}

  /* Re-apply declarative gates whenever authority changes, so a role revoked
     mid-session closes its UI without a reload. */
  try {
    document.addEventListener('sokoniRoleAuthorityReady', function () { applyDeclarativeGates(); });
  } catch (_) {}
})(window);
