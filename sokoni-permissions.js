/**
 * SOKONI CENTRALIZED PERMISSION SYSTEM  v1.0
 *
 * 8-Role RBAC with Firebase custom claims as authoritative source.
 * Replaces the old localStorage-only access-control.js with a
 * claim-backed, hierarchical system while staying backward-compatible
 * with any code that still calls SokoniAccessControl.
 *
 * Role hierarchy (highest privilege first):
 *   superAdmin > admin > moderator > professional|business|driver|seller > user
 *
 * Authoritative source  : Firebase ID token custom claims (server-set)
 * Performance cache     : sessionStorage + in-memory (TTL 5 min)
 * Fallback / sync path  : localStorage sokoniUser.roles array
 *
 * Usage (any page):
 *   await SokoniPermissions.init();
 *   if (SokoniPermissions.can('moderateContent')) { … }
 *   if (SokoniPermissions.hasRole('admin'))        { … }
 */

(function (window) {
  "use strict";

  /* ══════════════════════════════════════════════════════════════
     1. ROLE & PERMISSION DEFINITIONS
  ══════════════════════════════════════════════════════════════ */

  const ROLES = {
    user:         { level: 10, label: "User",         description: "Browse, buy, and book on SOKONI" },
    seller:       { level: 20, label: "Seller",       description: "Sell products and manage a store" },
    business:     { level: 20, label: "Business",     description: "Business account — B2B, landlords, property" },
    driver:       { level: 20, label: "Driver",       description: "Ride-hailing and delivery driver" },
    professional: { level: 20, label: "Professional", description: "Licensed service provider (healthcare, legal, mechanic…)" },
    moderator:    { level: 50, label: "Moderator",    description: "Content moderation and dispute management" },
    admin:        { level: 80, label: "Admin",        description: "Platform administration" },
    superAdmin:   { level: 100, label: "Super Admin", description: "Full platform control including admin management" },
  };

  /* Permission → minimum role level required */
  const PERMISSIONS = {
    /* Browsing & buying — any authenticated user */
    browseProducts:     10,
    placeOrder:         10,
    bookService:        10,
    writeReview:        10,
    sendMessage:        10,
    trackOrder:         10,

    /* Seller-specific */
    manageListing:      20,
    manageProducts:     20,
    viewSalesAnalytics: 20,
    manageStore:        20,

    /* Driver-specific */
    acceptRides:        20,
    acceptDeliveries:   20,
    updateDelivery:     20,

    /* Professional-specific */
    offerServices:      20,
    manageBookings:     20,
    viewEarnings:       20,

    /* Business-specific */
    manageProperties:   20,
    postB2BListings:    20,

    /* Moderation (moderator+) */
    reviewFlags:        50,
    resolveDisputes:    50,
    moderateContent:    50,
    viewAuditLogs:      50,
    suspendContent:     50,

    /* Admin (admin+) */
    manageUsers:        80,
    approveVerifications: 80,
    viewRevenueData:    80,
    manageAdmins:       80,
    configPlatform:     80,
    viewAllOrders:      80,
    banUser:            80,

    /* Super admin only */
    grantAdminRoles:    100,
    revokeClaims:       100,
    deleteAuditLogs:    100,
  };

  /* Legacy role name aliases (access-control.js compatibility) */
  const LEGACY_ROLE_MAP = {
    buyer:    "user",
    delivery: "driver",
    landlord: "business",
    mechanic: "professional",
    healthcare: "professional",
    legal:    "professional",
  };

  /* ══════════════════════════════════════════════════════════════
     2. CACHE
  ══════════════════════════════════════════════════════════════ */

  const CACHE_KEY   = "sokoniPermCache";
  const CACHE_TTL   = 5 * 60 * 1000; // 5 minutes

  let _memCache = null; // { roles, level, claimsVerified, ts }

  function _readCache() {
    if (_memCache && Date.now() - _memCache.ts < CACHE_TTL) return _memCache;
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (Date.now() - c.ts < CACHE_TTL) {
          _memCache = c;
          return c;
        }
      }
    } catch (_) {}
    return null;
  }

  function _writeCache(data) {
    data.ts = Date.now();
    _memCache = data;
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (_) {}
  }

  function _clearCache() {
    _memCache = null;
    try { sessionStorage.removeItem(CACHE_KEY); } catch (_) {}
  }

  /* ══════════════════════════════════════════════════════════════
     3. ROLE RESOLUTION
  ══════════════════════════════════════════════════════════════ */

  function _normaliseRole(r) {
    return LEGACY_ROLE_MAP[r] || (ROLES[r] ? r : null);
  }

  function _roleLevel(roleSet) {
    return roleSet.reduce((max, r) => {
      const def = ROLES[_normaliseRole(r)];
      return def ? Math.max(max, def.level) : max;
    }, 0);
  }

  /**
   * Build the canonical role set from localStorage (sync, no await).
   * Used for the initial synchronous render pass before claims arrive.
   */
  function _rolesFromLocalStorage() {
    try {
      const raw = localStorage.getItem("sokoniUser");
      if (!raw) return ["user"];
      const u = JSON.parse(raw);
      const roles = new Set(["user"]);

      // Legacy registeredAs map
      if (u.registeredAs) {
        Object.entries(u.registeredAs).forEach(([k, v]) => {
          if (v) {
            const norm = _normaliseRole(k);
            if (norm) roles.add(norm);
          }
        });
      }

      // New roles array
      if (Array.isArray(u.roles)) {
        u.roles.forEach(r => { const n = _normaliseRole(r); if (n) roles.add(n); });
      }

      // role field
      if (u.role) {
        const n = _normaliseRole(u.role);
        if (n) roles.add(n);
      }

      return Array.from(roles);
    } catch (_) {
      return ["user"];
    }
  }

  /**
   * Fetch Firebase ID token claims and merge with Firestore roles.
   * Returns the resolved role set (async).
   */
  async function _rolesFromFirebase() {
    const auth = window.firebaseAuth;
    if (!auth || !auth.currentUser) return null;

    try {
      const result = await auth.currentUser.getIdTokenResult(false);
      const claims = result.claims || {};

      const roles = new Set(["user"]);

      // Custom claim roles (server-authoritative)
      if (claims.superAdmin === true) roles.add("superAdmin");
      if (claims.admin      === true) roles.add("admin");
      if (claims.moderator  === true) roles.add("moderator");

      // Firestore user doc roles (platform-managed)
      const db = window.firebaseDB;
      if (db) {
        try {
          const { getDoc, doc } = await import(
            "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
          );
          const snap = await getDoc(doc(db, "users", auth.currentUser.uid));
          if (snap.exists()) {
            const data = snap.data();
            // registeredAs map
            if (data.registeredAs) {
              Object.entries(data.registeredAs).forEach(([k, v]) => {
                if (v) { const n = _normaliseRole(k); if (n) roles.add(n); }
              });
            }
            // roles array
            if (Array.isArray(data.roles)) {
              data.roles.forEach(r => { const n = _normaliseRole(r); if (n) roles.add(n); });
            }
            // seller flag
            if (data.isSeller) roles.add("seller");
            if (data.isDriver) roles.add("driver");
          }
        } catch (_) {}
      }

      return Array.from(roles);
    } catch (err) {
      console.warn("[Permissions] Firebase claim fetch failed:", err.message);
      return null;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     4. PUBLIC API
  ══════════════════════════════════════════════════════════════ */

  let _initialized = false;
  let _initPromise  = null;
  let _currentRoles = ["user"];
  let _claimsVerified = false;

  /* ── Elevation guard ──────────────────────────────────────────────────
     _currentRoles can be populated from three places: the sessionStorage
     cache, the localStorage sync pass, and the Firebase ID token. Only the
     last is authoritative — the other two are attacker-writable.

     The cache path is the sharp edge: _readCache() parses sessionStorage
     without validation and init() RETURNS EARLY on a hit, so a forged entry
     carrying {roles:["superAdmin"], claimsVerified:true} elevated the client
     without Firebase ever being consulted. Reading claimsVerified back out of
     that same cache cannot detect it, because the attacker sets that field too.

     _verifiedThisLoad is therefore in-memory ONLY and is never serialised,
     read back, or restorable from any storage. It becomes true solely when
     _rolesFromFirebase() succeeds against a signed ID token in this page load.

     Elevated permissions (moderator and above) now require it. Baseline and
     seller-tier roles still resolve from cache so first paint stays fast —
     those are product surfaces, not administrative power, and gating them on
     an await would regress rendering for every ordinary user. */
  let _verifiedThisLoad = false;
  const ELEVATED_LEVEL = 50; /* moderator(50), admin(80), superAdmin(100) */

  async function init() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      // 1. Try cache first — for IMMEDIATE RENDER ONLY.
      //    This used to return early, which meant a warm (or forged) cache
      //    skipped Firebase entirely. The cache may now seed the role set for
      //    a fast first paint, but it can never stand in for verification:
      //    _verifiedThisLoad stays false until a signed token is read below,
      //    so elevated permissions remain denied until then.
      const cached = _readCache();
      if (cached) {
        _currentRoles   = cached.roles;
        _claimsVerified = cached.claimsVerified;
        _initialized    = true;
        _filterNav();
        /* fall through — do NOT return; verification still has to happen */
      }

      // 2. Synchronous pass from localStorage (for immediate render)
      if (!cached) {
        _currentRoles = _rolesFromLocalStorage();
        _initialized  = true;
        _filterNav();
      }

      // 3. Async verification from Firebase (upgrades or downgrades roles)
      const firebaseRoles = await _rolesFromFirebase();
      if (firebaseRoles) {
        _currentRoles     = firebaseRoles;
        _claimsVerified   = true;
        /* The only assignment of this flag anywhere. It is in-memory, never
           serialised, and therefore not forgeable from any storage. */
        _verifiedThisLoad = true;

        // Update localStorage so other scripts stay in sync
        try {
          const raw = localStorage.getItem("sokoniUser");
          if (raw) {
            const u = JSON.parse(raw);
            u.roles = firebaseRoles;
            // Update registeredAs to match resolved roles
            const ra = {};
            firebaseRoles.forEach(r => { ra[r] = true; });
            u.registeredAs = { ...u.registeredAs, ...ra };
            localStorage.setItem("sokoniUser", JSON.stringify(u));
          }
        } catch (_) {}

        _writeCache({ roles: _currentRoles, level: _roleLevel(_currentRoles), claimsVerified: true });
        _filterNav();
        // Emit event so pages can react to role refresh
        document.dispatchEvent(new CustomEvent("sokoniRolesReady", { detail: { roles: _currentRoles } }));
      }
    })();
    return _initPromise;
  }

  /* ── RE-VERIFICATION AFTER AUTH RESOLVES ────────────────────────────────────
     init() caches _initPromise on first call, and _run() below fires it at
     DOMContentLoaded. Firebase resolves currentUser asynchronously AFTER that, so
     _rolesFromFirebase() bails on `!auth.currentUser` and returns null — leaving
     _claimsVerified and _verifiedThisLoad false for the rest of the page load, with
     the failed outcome cached.

     Nothing depended on that until F4 gave requireAdminContext() a real
     isVerified() check. Then it became a hard lockout: every administrator, on
     every administrative surface, got "Could not verify your access" regardless of
     their claims. The guard was correct to fail closed; the state it consulted was
     simply never allowed to become true.

     This re-runs ONLY the verification step, and only upgrades — it can set
     verified true, never false, so it cannot be used to widen anything. A caller
     that has waited for a real currentUser calls this before asking about roles. */
  async function reverify() {
    if (_verifiedThisLoad) return true;
    const firebaseRoles = await _rolesFromFirebase();
    if (!firebaseRoles) return false;
    _currentRoles     = firebaseRoles;
    _claimsVerified   = true;
    _verifiedThisLoad = true;
    try { _writeCache({ roles: _currentRoles, level: _roleLevel(_currentRoles), claimsVerified: true }); }
    catch (_) {}
    try { _filterNav(); } catch (_) {}
    try {
      document.dispatchEvent(new CustomEvent('sokoniRolesReady', { detail: { roles: _currentRoles } }));
    } catch (_) {}
    return true;
  }

  function hasRole(role) {
    const norm = _normaliseRole(role) || role;
    if (!_currentRoles.includes(norm)) return false;
    /* An elevated role asserted only by cache is not an elevated role. */
    const def = ROLES[norm];
    if (def && def.level >= ELEVATED_LEVEL && !_verifiedThisLoad) return false;
    return true;
  }

  function hasAnyRole(rolesArray) {
    return rolesArray.some(r => hasRole(r));
  }

  /* ── THE ADMINISTRATIVE DESTINATION ───────────────────────────────────────
     Where an administrator's Home goes. It lives HERE, beside the authority that already
     decides administrative access, and deliberately NOT in SokoniRoleAuthority: that file
     records why in its own vocabulary comment — `admin` and `staff` are canonical roles
     server-side but are NOT workspace roles, and duplicating administrative access there
     would create a second path to the same privilege. This repository has already paid for
     that shape: eight independent role->destination maps once gave three different answers
     for one role.

     So `admin` and `superAdmin` are NOT added to CANONICAL_ROLES or WORKSPACE_HUBS, are not
     offered by the role switcher, and cannot be selected as an `activeRole`. This function
     adds a DESTINATION next to an existing decision; it grants nothing.

     It routes through hasRole(), which refuses an elevated role asserted only by cache —
     so a forged localStorage role resolves to null here, not to admin.html. Super Admin wins
     over Admin when both claims are present, because the higher surface can reach the lower
     one and not the reverse. */
  function adminHomeFor() {
    if (hasRole('superAdmin')) return 'super-admin.html';
    if (hasRole('admin'))      return 'admin-os.html';   /* canonical admin console (was legacy admin.html) */
    return null;
  }

  function hasAllRoles(rolesArray) {
    return rolesArray.every(r => hasRole(r));
  }

  function can(permission) {
    const minLevel = PERMISSIONS[permission];
    if (minLevel === undefined) {
      console.warn("[Permissions] Unknown permission:", permission);
      return false;
    }
    /* Fail securely: an elevated permission is granted only from a signed
       token verified during this page load, never from cached JSON. */
    if (minLevel >= ELEVATED_LEVEL && !_verifiedThisLoad) return false;
    return _roleLevel(_currentRoles) >= minLevel;
  }

  function getRoles() { return [..._currentRoles]; }

  function getLevel() { return _roleLevel(_currentRoles); }

  function isLoggedIn() {
    /* Canonical, resolution-aware source of truth (sokoni-auth-state.js). */
    if (window.SokoniAuthState) return window.SokoniAuthState.isLoggedIn();
    /* Standalone fallback (module not loaded on this page).
       BUGFIX 2026-07-26: this used to do `if (window.firebaseAuth) return false;`
       — concluding LOGGED-OUT the instant the firebaseAuth object existed, which
       is synchronous and happens long before currentUser resolves (and longer
       while App Check delays the token exchange). guardCurrentPage() then bounced
       seller/driver/provider/landlord/admin pages to login.html?next=…, login
       bounced back on the cached loggedIn flag, and the two looped — the
       timing-dependent "page keeps reloading". Never conclude logged-out merely
       because the auth OBJECT exists; trust the verified currentUser, else the
       cached flag until a resolver confirms otherwise. A real sign-out clears it. */
    if (window.firebaseAuth && window.firebaseAuth.currentUser) return true;
    return localStorage.getItem("loggedIn") === "true";
  }

  function isVerified() { return _claimsVerified; }

  /* ══════════════════════════════════════════════════════════════
     5. NAVIGATION FILTERING
  ══════════════════════════════════════════════════════════════ */

  function _filterNav() {
    // [data-require-role="seller,admin"] — hide if user lacks all listed roles.
    // NEVER hide the structural roots (html/body): a page that mistakenly puts a PAGE-level
    // data-require-role on <html> (e.g. dispatch.html) would otherwise blank the whole document
    // for a non-matching role. Page-level access is enforced by GUARDED_ROUTES/guardCurrentPage,
    // not by hiding <html>. This keeps one bad attribute from blanking a merchant module.
    document.querySelectorAll("[data-require-role]").forEach(el => {
      if (el === document.documentElement || el === document.body) return;
      const required = el.getAttribute("data-require-role").split(",").map(s => s.trim());
      el.style.display = hasAnyRole(required) ? "" : "none";
    });

    // [data-require-perm="manageProducts"] — hide if user lacks that permission
    document.querySelectorAll("[data-require-perm]").forEach(el => {
      el.style.display = can(el.getAttribute("data-require-perm")) ? "" : "none";
    });

    // [data-require-min-level="50"] — hide below level
    document.querySelectorAll("[data-require-min-level]").forEach(el => {
      const minLvl = parseInt(el.getAttribute("data-require-min-level"), 10);
      el.style.display = (getLevel() >= minLvl) ? "" : "none";
    });

    // Legacy: [data-role-required="seller"] (access-control.js compatibility)
    document.querySelectorAll("[data-role-required]").forEach(el => {
      const required = el.getAttribute("data-role-required").split(",").map(s => s.trim());
      el.style.display = hasAnyRole(required) ? "" : "none";
    });
  }

  /* ══════════════════════════════════════════════════════════════
     6. ROUTE GUARD
  ══════════════════════════════════════════════════════════════ */

  const GUARDED_ROUTES = {
    "monitor.html":             { role: "admin",        redirect: "login.html" },
    "admin.html":               { role: "admin",        redirect: "login.html" },
    "verification-admin.html":  { role: "moderator",    redirect: "login.html" },
    "seller.html":              { role: "seller",       redirect: "profile.html" },
    "driver.html":              { role: "driver",       redirect: "profile.html" },
    "provider.html":            { role: "professional", redirect: "profile.html" },
    "landlord.html":            { role: "business",     redirect: "profile.html" },
  };

  async function guardCurrentPage() {
    await init();
    const page = window.location.pathname.split("/").pop() || "index.html";
    const guard = GUARDED_ROUTES[page];
    if (!guard) return true;

    /* Hosted inside the merchant shell, a redirect here navigates the PANEL, not the tab —
       so seller.html briefly missing its role rendered profile.html (and an unauthenticated
       moment rendered login.html) INSIDE the merchant OS, under the previous module's title.
       That looks exactly like "the button opened the wrong page".

       The shell owns access control: it refuses a route before mounting it, using each route's
       declared role in sokoni-merchant-routes.js. So in-shell we report upward and let the
       shell decide, rather than silently replacing the module with another page. Standalone
       pages keep the original redirect behaviour unchanged. */
    const inShell = (window.SokoniInShell && window.SokoniInShell.inShell) === true;

    if (!isLoggedIn()) {
      if (inShell) { _reportGuardToShell(page, 'unauthenticated'); return false; }
      window.location.href = `login.html?next=${encodeURIComponent(window.location.href)}`;
      return false;
    }
    if (!hasRole(guard.role)) {
      if (inShell) { _reportGuardToShell(page, 'missing-role:' + guard.role); return false; }
      window.location.href = guard.redirect;
      return false;
    }
    return true;
  }

  /* Tell the host shell why this module refused to run, so it can show one honest message
     instead of the merchant seeing an unrelated page appear inside their dashboard. */
  function _reportGuardToShell(page, reason) {
    console.warn(`[sokoni-permissions] in-shell guard: ${page} blocked (${reason}) — not redirecting the panel.`);
    try {
      window.parent.postMessage({ __sokoniModule: true, action: 'accessBlocked', page, reason },
                                window.location.origin);
    } catch (_) {}
  }

  /* ══════════════════════════════════════════════════════════════
     7. ADMIN UI HELPERS
  ══════════════════════════════════════════════════════════════ */

  function showAccessDenied(requiredRole) {
    const def = ROLES[requiredRole] || { label: requiredRole };
    const modal = document.createElement("div");
    modal.className = "sokoni-access-modal";
    modal.innerHTML = `
      <div class="sokoni-access-modal-content">
        <div class="sokoni-access-modal-icon">🔒</div>
        <h2>Access Restricted</h2>
        <p>You need the <strong>${def.label}</strong> role to access this section.</p>
        <div class="sokoni-access-modal-actions">
          <button onclick="window.location.href='profile.html'" class="sokoni-btn-primary">My Profile</button>
          <button onclick="window.history.back()" class="sokoni-btn-secondary">Go Back</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add("show"), 80);
  }

  /* ══════════════════════════════════════════════════════════════
     8. BACKWARD-COMPATIBLE SokoniAccessControl ADAPTER
  ══════════════════════════════════════════════════════════════ */

  const MANAGEMENT_PAGES = {
    "seller.html":     "seller",
    "ministore.html":  "seller",
    "bnb-manage.html": "seller",
    "healthcare.html": "professional",
    "driver.html":     "driver",
    "delivery.html":   "driver",
    "landlord.html":   "business",
    "legal-hub.html":  "professional",
    "property.html":   "business",
    "monitor.html":    "admin",
    "admin.html":      "admin",
  };

  const SokoniAccessControl = {
    ROLE_DEFINITIONS:   Object.fromEntries(
      Object.entries(ROLES).map(([k, v]) => [k, { label: v.label, description: v.description, icon: "" }])
    ),
    MANAGEMENT_PAGES,
    getCurrentUser:          () => { try { return JSON.parse(localStorage.getItem("sokoniUser")); } catch (_) { return null; } },
    getUserRoles:            () => ({ roles: _currentRoles, registeredAs: Object.fromEntries(_currentRoles.map(r => [r, true])) }),
    hasRole,
    hasAnyRole,
    isLoggedIn,
    getRoleStatus:           () => Object.fromEntries(_currentRoles.map(r => [r, true])),
    getPageName:             () => window.location.pathname.split("/").pop() || "index.html",
    isManagementPage:        (p) => !!(MANAGEMENT_PAGES[p || (window.location.pathname.split("/").pop())]),
    getRequiredRoleForPage:  (p) => MANAGEMENT_PAGES[p || (window.location.pathname.split("/").pop())] || null,
    canManagePage:           (p) => { const r = MANAGEMENT_PAGES[p || (window.location.pathname.split("/").pop())]; return r ? hasRole(r) : true; },
    getMissingRole:          (p) => MANAGEMENT_PAGES[p || (window.location.pathname.split("/").pop())] || null,
    registerUserRole:        (role) => {
      const n = _normaliseRole(role) || role;
      /* Privileged roles must only arrive via Firebase ID-token claims — never from JS calls */
      const _privileged = ['admin','superAdmin','moderator'];
      if (_privileged.includes(n)) { console.warn('[Permissions] Privileged role "' + n + '" cannot be self-assigned.'); return; }
      if (!_currentRoles.includes(n)) _currentRoles.push(n);
      _clearCache();
    },
    unregisterUserRole:      (role) => { _currentRoles = _currentRoles.filter(r => r !== role && _normaliseRole(r) !== role); _clearCache(); },
    toggleRole:              (role) => { hasRole(role) ? SokoniAccessControl.unregisterUserRole(role) : SokoniAccessControl.registerUserRole(role); },
    filterNavigationItems:   _filterNav,
    showRoleSelectionModal:  () => {},
    showRoleRegistrationPrompt: (r) => showAccessDenied(r),
  };

  /* ══════════════════════════════════════════════════════════════
     9. AUTO-INIT
  ══════════════════════════════════════════════════════════════ */

  const _run = () => { init().then(_filterNav); };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _run);
  } else {
    _run();
  }

  /* ══════════════════════════════════════════════════════════════
     9b. THE ADMINISTRATIVE CONTEXT
  ══════════════════════════════════════════════════════════════

     Holding the admin claim says what the account MAY do. It does not say what the
     account is DOING. Before this, all three administrative surfaces gated on the
     claim alone, so an administrator who switched to Buyer kept full admin access —
     the workspace they were acting in and the surface they could open disagreed.

     activeRole cannot express this. SokoniRoleAuthority deliberately excludes `admin`
     and `superAdmin` from CANONICAL_ROLES (see its vocabulary comment, and
     adminHomeFor above), because administrative access already has an owner and a
     second path to it is how this repository previously ended up with three answers
     for one role. So the administrative context lives HERE, beside that owner, as its
     own state:

         activeRole    which WORKSPACE the account is acting in   (SokoniRoleAuthority)
         adminContext  which ADMIN surface the account has entered (this file)

     They are mutually exclusive by construction: selecting any workspace role clears
     the administrative context (listener at the end of this block).

     WHAT THIS IS AND IS NOT. The claim is the authority; this is a context selector.
     Every read re-checks hasRole(), which refuses an elevated role asserted only by
     cache, so the sessionStorage mirror below cannot grant anything the token does not
     already carry — forging it gets an administrator the surface their own claim
     already allows, and gets everyone else nothing. It is the same relationship
     activeRole has with claims, and it is NOT a substitute for the server: Firestore
     rules and the admin callables remain the boundary that actually protects data. */

  var _adminContext = null;
  var ADMIN_CTX_KEY = 'sokoniAdminContext';

  function _adminCtxMirror(v) {
    try {
      if (v) sessionStorage.setItem(ADMIN_CTX_KEY, v);
      else sessionStorage.removeItem(ADMIN_CTX_KEY);
    } catch (_) {}
  }

  /* Entering requires a VERIFIED claim, not a cached one — hasRole() enforces that
     for elevated roles. Returns a reason so a caller can say why rather than
     presenting a dead button. */
  function enterAdminContext(role) {
    var r = role === 'superAdmin' ? 'superAdmin' : 'admin';
    if (!isLoggedIn())            return { ok: false, reason: 'signed-out' };
    /* _verifiedForElevated, not isVerified: a cached claimsVerified is not a token.
       hasRole() below already refuses on the same flag, so without this the refusal
       came back as 'no-claim' — telling an administrator their account does not carry
       the role, when the truth was that nothing had been checked yet. */
    if (!_verifiedForElevated()) return { ok: false, reason: 'not-verified' };
    /* A Super Admin entering the Admin surface holds `superAdmin`, and need not also
       hold `admin` — the same direction requireAdminContext() accepts. Resolving it
       here keeps the two functions from disagreeing, which is how an Enter button
       ends up refusing an account the gate would have admitted. */
    if (!hasRole(r) && r === 'admin' && hasRole('superAdmin')) r = 'superAdmin';
    if (!hasRole(r))      return { ok: false, reason: 'no-claim' };
    _adminContext = r;
    _adminCtxMirror(r);
    try {
      document.dispatchEvent(new CustomEvent('sokoniAdminContextChanged',
        { detail: { context: r } }));
    } catch (_) {}
    return { ok: true, context: r };
  }

  /* An elevated decision may only be made once THIS load has read a signed token.
     isVerified() is not that test: it returns _claimsVerified, which _readCache()
     sets true straight from the sessionStorage cache. _verifiedThisLoad is the
     in-memory flag that only a real token can set, and it is what hasRole() already
     consults for elevated roles. Naming it here so the three administrative
     functions below ask the same question in the same words. */
  function _verifiedForElevated() { return _verifiedThisLoad; }

  /* The mirror is only ever a HINT for surviving a reload. It is re-validated against
     hasRole() on every read, and dropped if the claim is genuinely gone.

     "NOT VERIFIED YET" IS UNKNOWN — IT IS NOT "UNAUTHORIZED".
     ────────────────────────────────────────────────────────────────────────────
     This used to run the hasRole() check unconditionally. hasRole() refuses an
     elevated role while _verifiedThisLoad is false — which is every load until the
     token round-trips, and a returning user reaches this line with _claimsVerified
     ALREADY true from the five-minute cache. In that window the accessor concluded
     "not authorized" and did what it does with an unauthorized context: cleared it
     and erased its sessionStorage mirror.

     So an accessor destroyed the state it was asked to report, purely because it was
     asked early. Measured on production: with a context of 'admin' in place and the
     admin claim genuinely held, an early call left the mirror null.

     It now answers in three states rather than two:

         not verified yet          -> null, and CHANGE NOTHING     (pending/unknown)
         verified + authorized     -> the context
         verified + unauthorized   -> null, and clear it           (the real revocation)

     Returning null while pending is the same contract callers already handle — the
     menus mark nothing as current, which is correct for "we do not know yet" — while
     the destructive branch now runs only on a fact rather than on a race. */
  function getAdminContext() {
    if (!_adminContext) {
      try { _adminContext = sessionStorage.getItem(ADMIN_CTX_KEY) || null; } catch (_) {}
    }
    if (!_adminContext) return null;
    if (!_verifiedForElevated()) return null;      /* pending: report nothing, destroy nothing */
    if (!hasRole(_adminContext)) { _adminContext = null; _adminCtxMirror(null); return null; }
    return _adminContext;
  }

  function clearAdminContext() {
    if (!_adminContext) { try { _adminContext = sessionStorage.getItem(ADMIN_CTX_KEY) || null; } catch (_) {} }
    if (!_adminContext) return;
    _adminContext = null;
    _adminCtxMirror(null);
    try {
      document.dispatchEvent(new CustomEvent('sokoniAdminContextChanged',
        { detail: { context: null } }));
    } catch (_) {}
  }

  /* THE administrative page decision. `superAdmin` satisfies an `admin` requirement —
     the higher surface reaches the lower one and not the reverse, matching
     adminHomeFor() — while `admin` never satisfies `superAdmin`. */
  function requireAdminContext(required) {
    var need = required === 'superAdmin' ? 'superAdmin' : 'admin';
    if (!isLoggedIn())            return { ok: false, reason: 'signed-out' };
    /* Same flag as getAdminContext() and enterAdminContext(). Were this left on
       isVerified(), a warm cache would carry the decision past this line, find a
       null (pending) context below, and deny with 'context-not-entered' — offering
       an Enter button for a context the account had in fact already entered. */
    if (!_verifiedForElevated()) return { ok: false, reason: 'not-verified' };
    var ctx = getAdminContext();
    var claimed = hasRole(need) || (need === 'admin' && hasRole('superAdmin'));
    if (!claimed) return { ok: false, reason: 'no-claim', need: need };
    if (!ctx)     return { ok: false, reason: 'context-not-entered', need: need, canEnter: true };
    if (ctx !== need && !(need === 'admin' && ctx === 'superAdmin')) {
      return { ok: false, reason: 'wrong-context', need: need, context: ctx, canEnter: true };
    }
    return { ok: true, context: ctx, need: need };
  }

  /* Mutual exclusion. Choosing a workspace role IS leaving the administrative surface;
     without this the two states drift and an administrator acting as Buyer would still
     open admin.html, which is the defect this block exists to close. */
  document.addEventListener('sokoniActiveRoleChanged', function () { clearAdminContext(); });

  /* ══════════════════════════════════════════════════════════════
     10. EXPORTS
  ══════════════════════════════════════════════════════════════ */

  const SokoniPermissions = {
    init, guardCurrentPage,
    hasRole, hasAnyRole, hasAllRoles, can,
    adminHomeFor,
    enterAdminContext, getAdminContext, clearAdminContext, requireAdminContext,
    reverify,
    getRoles, getLevel, isLoggedIn, isVerified,
    showAccessDenied,
    clearCache: _clearCache,
    ROLES, PERMISSIONS,
  };

  window.SokoniPermissions  = SokoniPermissions;
  window.SokoniAccessControl = SokoniAccessControl; // backward compat

  /* ── Inline modal CSS (only injected once) ── */
  if (!document.getElementById("sokoni-perm-css")) {
    const s = document.createElement("style");
    s.id = "sokoni-perm-css";
    s.textContent = `
      .sokoni-access-modal{position:fixed;inset:0;background:rgba(0,0,0,.82);display:flex;
        align-items:center;justify-content:center;padding:24px;z-index:var(--sk-z-sheet,100010);
        opacity:0;transition:opacity .25s}
      .sokoni-access-modal.show{opacity:1}
      .sokoni-access-modal-content{background:#111;border:1px solid rgba(113,255,0,.3);
        border-radius:14px;padding:40px 32px;max-width:400px;width:100%;text-align:center;
        color:#fff;animation:perm-up .3s}
      @keyframes perm-up{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}
      .sokoni-access-modal-icon{font-size:48px;margin-bottom:14px}
      .sokoni-access-modal-content h2{color:#71ff00;margin:0 0 10px;font-size:22px}
      .sokoni-access-modal-content p{color:#bbb;font-size:14px;margin:0 0 22px}
      .sokoni-access-modal-actions{display:flex;gap:10px}
      .sokoni-btn-primary{flex:1;background:#71ff00;color:#000;border:none;padding:12px;
        border-radius:7px;font-weight:700;cursor:pointer;font-size:14px}
      .sokoni-btn-secondary{flex:1;background:transparent;border:1px solid rgba(113,255,0,.35);
        color:#71ff00;padding:12px;border-radius:7px;font-weight:600;cursor:pointer;font-size:14px}
      @media(max-width:480px){.sokoni-access-modal-actions{flex-direction:column}}
    `;
    document.head.appendChild(s);
  }

})(window);
