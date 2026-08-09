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
    if (!isLoggedIn()) { window.location.href = `login.html?next=${encodeURIComponent(window.location.href)}`; return false; }
    if (!hasRole(guard.role)) { window.location.href = guard.redirect; return false; }
    return true;
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
     10. EXPORTS
  ══════════════════════════════════════════════════════════════ */

  const SokoniPermissions = {
    init, guardCurrentPage,
    hasRole, hasAnyRole, hasAllRoles, can,
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
