/**
 * SOKONI Workspace Identity SDK v1.0
 *
 * "One Person. One Account. Unlimited Businesses."
 *
 * Manages the employment layer on top of personal SOKONI accounts:
 *   • Cache workspace memberships in localStorage (sokoniWorkspaces)
 *   • Real-time Firestore listener for instant permission revocation
 *   • switchTo(businessId) for zero-logout workspace switching
 *   • hasPermission(perm) for server-mirrored client-side checks
 *   • Clock-in / clock-out for shift tracking
 *
 * Exposed as:  window.SokoniWorkspace
 * Events dispatched on document:
 *   sokoniWorkspacesUpdated  — memberships refreshed from Firestore
 *   sokoniWorkspaceChanged   — active workspace switched (detail = membership | null)
 */
(function (win) {
  'use strict';

  /* ── Constants ──────────────────────────────────────────────────────── */
  var LS_WORKSPACES = 'sokoniWorkspaces';
  var LS_ACTIVE     = 'sokoniActiveWorkspace';
  var FB_SDK        = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
  var FB_FN_SDK     = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';

  /** Canonical permission keys (mirrors server constants in workforce-identity.js) */
  var PERMISSIONS = {
    VIEW_PRODUCTS:   'view_products',
    MANAGE_PRODUCTS: 'manage_products',
    POS:             'pos',
    INVENTORY:       'inventory',
    REFUNDS:         'refunds',
    DISCOUNTS:       'discounts',
    FINANCE:         'finance',
    PAYROLL:         'payroll',
    REPORTS:         'reports',
    CUSTOMERS:       'customers',
    BOOKINGS:        'bookings',
    DRIVERS:         'drivers',
    DELIVERIES:      'deliveries',
    BRANCHES:        'branches',
    USERS:           'users',
    ANALYTICS:       'analytics',
    SETTINGS:        'settings',
  };

  /** Default permission sets by role (mirrors server ROLE_PERMISSIONS) */
  var ROLE_PERMISSIONS = {
    owner:            Object.values(PERMISSIONS),
    manager:          ['view_products','manage_products','pos','inventory','refunds','discounts','reports','customers','bookings','drivers','deliveries','branches','users','analytics'],
    supervisor:       ['view_products','manage_products','pos','inventory','refunds','discounts','reports','customers','analytics'],
    cashier:          ['pos','view_products','customers','refunds'],
    inventory_officer:['view_products','manage_products','inventory','reports'],
    accountant:       ['finance','payroll','reports','analytics'],
    driver:           ['drivers','deliveries'],
    receptionist:     ['bookings','customers','view_products'],
    waiter:           ['pos','bookings','customers','view_products'],
    security:         ['customers'],
    cleaner:          [],
  };

  /* ── localStorage helpers ───────────────────────────────────────────── */
  function _getWorkspaces() {
    try { return JSON.parse(localStorage.getItem(LS_WORKSPACES) || '[]'); } catch (_) { return []; }
  }
  function _setWorkspaces(arr) {
    try { localStorage.setItem(LS_WORKSPACES, JSON.stringify(arr)); } catch (_) {}
  }
  function _getActiveId() {
    return localStorage.getItem(LS_ACTIVE) || null;
  }
  function _setActiveId(id) {
    if (id) { try { localStorage.setItem(LS_ACTIVE, id); } catch (_) {} }
    else     { try { localStorage.removeItem(LS_ACTIVE); } catch (_) {} }
  }

  /* ── Public: read ───────────────────────────────────────────────────── */

  /** All active workspace memberships from cache */
  function getWorkspaces() { return _getWorkspaces(); }

  /** Active workspace object, or null when in personal mode */
  function getActiveWorkspace() {
    var id = _getActiveId();
    if (!id) return null;
    return _getWorkspaces().find(function (w) { return w.businessId === id; }) || null;
  }

  /** Check if the active workspace grants a specific permission */
  function hasPermission(perm) {
    var ws = getActiveWorkspace();
    if (!ws) return false;
    if (ws.role === 'owner') return true;
    return Array.isArray(ws.permissions) && ws.permissions.includes(perm);
  }

  /** Human-readable display name for a role slug */
  function roleName(role) {
    var MAP = {
      owner:'Owner', manager:'Manager', supervisor:'Supervisor',
      cashier:'Cashier', inventory_officer:'Inventory Officer',
      accountant:'Accountant', driver:'Driver', receptionist:'Receptionist',
      waiter:'Waiter', security:'Security', cleaner:'Cleaner',
    };
    return MAP[role] || (role ? role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g,' ') : 'Staff');
  }

  /* ── Branding ───────────────────────────────────────────────────────── */

  /**
   * Apply workspace brand colors as CSS custom properties on :root.
   * Falls back to transparent/defaults when no brand color is set.
   */
  function applyBranding(ws) {
    try {
      var r = document.documentElement;
      if (!ws || !ws.brandColor) {
        r.style.removeProperty('--ws-brand');
        r.style.removeProperty('--ws-accent');
        r.style.removeProperty('--ws-brand-dim');
        r.style.removeProperty('--ws-brand-mid');
      } else {
        var color  = ws.brandColor;
        var accent = ws.brandAccent || color;
        r.style.setProperty('--ws-brand',     color);
        r.style.setProperty('--ws-accent',    accent);
        r.style.setProperty('--ws-brand-dim', color.slice(0, 7) + '14');
        r.style.setProperty('--ws-brand-mid', color.slice(0, 7) + '2e');
      }
      document.dispatchEvent(new CustomEvent('sokoniWorkspaceBrandingApplied', {
        bubbles: true,
        detail:  { ws: ws || null },
      }));
    } catch (_) {}
  }

  /* ── Public: switch ─────────────────────────────────────────────────── */

  /**
   * Switch to a different workspace (or back to personal mode).
   * Instant — no page reload. Dispatches sokoniWorkspaceChanged.
   * @param {string|null} businessId  — pass null or 'personal' for personal mode
   */
  function switchTo(businessId) {
    var isPersonal = !businessId || businessId === 'personal';
    var ws = null;

    if (!isPersonal) {
      ws = _getWorkspaces().find(function (w) { return w.businessId === businessId; });
      if (!ws) { console.warn('[SokoniWorkspace] Unknown businessId:', businessId); return; }
    }

    _setActiveId(isPersonal ? null : businessId);

    /* Sync into sokoniUser so the nav engine and other readers see the active workspace */
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || '{}');
      u.activeWorkspace    = ws || null;
      u.activeBusinessId   = isPersonal ? null : businessId;
      u.activeBusinessName = ws ? ws.businessName : null;
      u.activeBusinessLogo = ws ? (ws.businessLogo || '') : null;
      u.activeBranchId     = ws ? (ws.activeBranchId   || null) : null;
      u.activeBranchName   = ws ? (ws.activeBranchName || null) : null;
      /* activeRole is DELIBERATELY not written here.

         It is SokoniRoleAuthority's mirror of the acting PERSONAL role, whose vocabulary is
         CANONICAL = buyer|seller|provider|mechanic|rider|health|legal|landlord|tenant. A
         workspace role is a different vocabulary entirely — owner|manager|cashier|… — so
         `u.activeRole = ws.role` wrote a non-canonical value into RA's mirror, and the
         personal branch reset the acting role to roles[0], silently discarding a switch the
         authority had persisted to users/{uid}.activeRole. Either way the mirror and the
         server disagreed and no sokoniActiveRoleChanged fired.

         Workspace membership and acting role are orthogonal: entering a workspace does not
         change who you are acting as personally. The workspace role remains available on
         u.activeWorkspace.role. If a workspace ever must change the acting role, it has to
         go through RA.setActiveRole so entitlement is validated and the event fires. */
      localStorage.setItem('sokoniUser', JSON.stringify(u));
    } catch (_) {}

    applyBranding(ws);

    document.dispatchEvent(new CustomEvent('sokoniWorkspaceChanged', {
      bubbles: true,
      detail:  ws || null,
    }));
  }

  /* ── Branch switching ───────────────────────────────────────────────── */

  /**
   * Switch to a different branch within the active workspace.
   * Updates localStorage and re-dispatches sokoniWorkspaceChanged.
   */
  function setActiveBranch(branchId, branchName) {
    var ws = getActiveWorkspace();
    if (!ws) { console.warn('[SokoniWorkspace] No active workspace.'); return; }

    var workspaces = _getWorkspaces().map(function (w) {
      if (w.businessId === ws.businessId) {
        return Object.assign({}, w, {
          activeBranchId:   branchId   || null,
          activeBranchName: branchName || null,
        });
      }
      return w;
    });
    _setWorkspaces(workspaces);

    var updated = workspaces.find(function (w) { return w.businessId === ws.businessId; }) || ws;
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || '{}');
      u.activeBranchId   = branchId   || null;
      u.activeBranchName = branchName || null;
      localStorage.setItem('sokoniUser', JSON.stringify(u));
    } catch (_) {}

    document.dispatchEvent(new CustomEvent('sokoniWorkspaceChanged', {
      bubbles: true,
      detail:  updated,
    }));
  }

  /* ── Firestore watcher ──────────────────────────────────────────────── */
  var _unsub = null;

  /**
   * Load all active workspace memberships for `uid` from Firestore and
   * start a real-time listener. When a membership is revoked (status ≠ 'active')
   * the employee's UI updates instantly without a page reload.
   */
  async function loadAndWatch(uid) {
    if (_unsub) { _unsub(); _unsub = null; }
    if (!uid) return;

    try {
      var fbModule = await import('./firebase.js');
      var db       = fbModule.db;
      var fsModule = await import(FB_SDK);
      var collection = fsModule.collection;
      var query      = fsModule.query;
      var where      = fsModule.where;
      var onSnapshot = fsModule.onSnapshot;

      var q = query(
        collection(db, 'workspaceMemberships'),
        where('uid', '==', uid),
        where('status', '==', 'active')
      );

      _unsub = onSnapshot(q, function (snap) {
        var workspaces = snap.docs.map(function (d) {
          var data = d.data();
          return Object.assign({}, data, {
            membershipId: d.id,
            addedAt: data.addedAt && data.addedAt.seconds ? data.addedAt.seconds * 1000 : Date.now(),
            startDate: data.startDate && data.startDate.seconds ? data.startDate.seconds * 1000 : null,
          });
        });

        _setWorkspaces(workspaces);
        document.dispatchEvent(new CustomEvent('sokoniWorkspacesUpdated', {
          bubbles: true,
          detail:  { workspaces: workspaces },
        }));

        /* If the currently-active workspace was just revoked, fall back to personal mode */
        var activeId = _getActiveId();
        if (activeId && !workspaces.find(function (w) { return w.businessId === activeId; })) {
          _setActiveId(null);
          document.dispatchEvent(new CustomEvent('sokoniWorkspaceChanged', {
            bubbles: true,
            detail:  null,
          }));
        }

      }, function (err) {
        /* This used to be a bare console.warn, so a permission-denied read
           looked identical to "this person has no jobs" — the business
           switcher rendered empty and nothing said why. A denied read is a
           configuration fault, not an empty result, and must not be
           indistinguishable from one. */
        if (err && err.code === 'permission-denied') {
          console.error(
            '[SokoniWorkspace] DENIED reading workspaceMemberships. The business ' +
            'switcher will be empty. This is a Firestore rules problem, not an ' +
            'absence of memberships.\n' +
            '  uid: ' + uid + '\n' +
            '  The query filters on uid and status; the rule must allow a read ' +
            'where resource.data.uid == request.auth.uid.');
        } else {
          console.error('[SokoniWorkspace] workspaceMemberships subscription failed: ' +
            (err && (err.code || err.message)));
        }
        /* Tell the UI the list is unknown rather than empty, so it can show a
           problem state instead of silently implying no employment. */
        try {
          window.dispatchEvent(new CustomEvent('sokoni:workspaces-unavailable', {
            detail: { reason: (err && err.code) || 'unknown' }
          }));
        } catch (_) {}
      });

    } catch (e) {
      console.warn('[SokoniWorkspace] loadAndWatch error:', e.message);
    }
  }

  /** Stop the real-time listener (call on logout) */
  function stopWatch() {
    if (_unsub) { _unsub(); _unsub = null; }
  }

  /** Wipe localStorage entries and stop watcher (call on logout) */
  function clear() {
    stopWatch();
    try { localStorage.removeItem(LS_WORKSPACES); } catch (_) {}
    try { localStorage.removeItem(LS_ACTIVE); } catch (_) {}
  }

  /* ── Clock-in / Clock-out ───────────────────────────────────────────── */

  /**
   * Record clock-in for the active workspace.
   * Returns the shift session document ID.
   */
  async function clockIn() {
    var ws = getActiveWorkspace();
    if (!ws) throw new Error('No active workspace. Switch to a business first.');

    var fnModule = await import(FB_FN_SDK);
    var getFunctions  = fnModule.getFunctions;
    var httpsCallable = fnModule.httpsCallable;
    var fns = getFunctions();
    var fn  = httpsCallable(fns, 'wfClockIn');

    var result = await fn({
      membershipId: ws.membershipId,
      businessId:   ws.businessId,
      branchId:     ws.activeBranchId || null,
    });

    /* Update local state */
    var workspaces = _getWorkspaces();
    workspaces = workspaces.map(function (w) {
      if (w.businessId === ws.businessId) {
        return Object.assign({}, w, { clockedIn: true, clockedInAt: Date.now(), shiftSessionId: result.data.sessionId });
      }
      return w;
    });
    _setWorkspaces(workspaces);

    return result.data.sessionId;
  }

  /** Record a break start within the active shift */
  async function clockBreak() {
    var ws = getActiveWorkspace();
    if (!ws) throw new Error('No active workspace.');
    if (!ws.clockedIn) throw new Error('Not clocked in.');
    if (ws.onBreak) throw new Error('Already on break.');

    var fnModule = await import(FB_FN_SDK);
    var getFunctions  = fnModule.getFunctions;
    var httpsCallable = fnModule.httpsCallable;
    var fns = getFunctions();
    var fn  = httpsCallable(fns, 'wfClockBreak');

    await fn({
      membershipId:   ws.membershipId,
      businessId:     ws.businessId,
      shiftSessionId: ws.shiftSessionId || null,
    });

    var workspaces = _getWorkspaces();
    workspaces = workspaces.map(function (w) {
      if (w.businessId === ws.businessId) return Object.assign({}, w, { onBreak: true, breakStartedAt: Date.now() });
      return w;
    });
    _setWorkspaces(workspaces);
    return true;
  }

  /** Record break end and resume the shift */
  async function clockResume() {
    var ws = getActiveWorkspace();
    if (!ws) throw new Error('No active workspace.');
    if (!ws.onBreak) throw new Error('Not on break.');

    var fnModule = await import(FB_FN_SDK);
    var getFunctions  = fnModule.getFunctions;
    var httpsCallable = fnModule.httpsCallable;
    var fns = getFunctions();
    var fn  = httpsCallable(fns, 'wfClockResume');

    var result = await fn({
      membershipId:   ws.membershipId,
      businessId:     ws.businessId,
      shiftSessionId: ws.shiftSessionId || null,
    });

    var workspaces = _getWorkspaces();
    workspaces = workspaces.map(function (w) {
      if (w.businessId === ws.businessId) return Object.assign({}, w, { onBreak: false, breakStartedAt: null });
      return w;
    });
    _setWorkspaces(workspaces);
    return result.data;
  }

  /**
   * Record clock-out for the active workspace.
   * Returns hours worked.
   */
  async function clockOut() {
    var ws = getActiveWorkspace();
    if (!ws) throw new Error('No active workspace.');
    if (!ws.clockedIn) throw new Error('Not clocked in.');

    var fnModule = await import(FB_FN_SDK);
    var getFunctions  = fnModule.getFunctions;
    var httpsCallable = fnModule.httpsCallable;
    var fns = getFunctions();
    var fn  = httpsCallable(fns, 'wfClockOut');

    var result = await fn({
      membershipId:   ws.membershipId,
      businessId:     ws.businessId,
      shiftSessionId: ws.shiftSessionId || null,
    });

    /* Update local state */
    var workspaces = _getWorkspaces();
    workspaces = workspaces.map(function (w) {
      if (w.businessId === ws.businessId) {
        return Object.assign({}, w, { clockedIn: false, clockedInAt: null, shiftSessionId: null });
      }
      return w;
    });
    _setWorkspaces(workspaces);

    return result.data;
  }

  /* ── Auto-boot ──────────────────────────────────────────────────────── */

  /* Start watching when auth resolves */
  document.addEventListener('sokoniAuthReady', function (e) {
    var uid = e.detail && e.detail.uid;
    if (uid) loadAndWatch(uid);
  });

  /* Clear on sign-out */
  document.addEventListener('sokoniSignedOut', clear);

  /* ── Expose ─────────────────────────────────────────────────────────── */
  win.SokoniWorkspace = {
    PERMISSIONS:        PERMISSIONS,
    ROLE_PERMISSIONS:   ROLE_PERMISSIONS,
    getWorkspaces:      getWorkspaces,
    getActiveWorkspace: getActiveWorkspace,
    hasPermission:      hasPermission,
    roleName:           roleName,
    switchTo:           switchTo,
    setActiveBranch:    setActiveBranch,
    applyBranding:      applyBranding,
    loadAndWatch:       loadAndWatch,
    stopWatch:          stopWatch,
    clear:              clear,
    clockIn:            clockIn,
    clockBreak:         clockBreak,
    clockResume:        clockResume,
    clockOut:           clockOut,
  };

}(window));
