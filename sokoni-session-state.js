/**
 * SOKONI Session State Manager v1.0
 *
 * Tracks and restores session context: last page, active role, active business.
 * Lightweight — writes to localStorage only, zero network calls.
 *
 * API (window.SokoniSessionState):
 *   .saveContext(opts?)     — called automatically on every non-auth page load
 *   .getContext()           — returns full saved context object
 *   .getLastPage()          — returns last non-auth page URL or null (>7 days = null)
 *   .setRole(role)          — update active role without refreshing the page
 *   .setBusiness(biz)       — update active business context
 *   .clearContext()         — wipe on logout
 */
(function (win) {
  'use strict';

  var LS_KEY    = 'sokoniSessionCtx';
  var MAX_AGE   = 7 * 24 * 60 * 60 * 1000; // 7 days

  /* Pages that must not be tracked as "last visited" */
  var SKIP = {
    'login.html': 1, 'signup.html': 1, 'register.html': 1,
    'join.html': 1, 'logout.html': 1,
  };

  /* ── Helpers ──────────────────────────────────────────────────────── */
  function _get() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (_) { return {}; }
  }

  function _set(data) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (_) {}
  }

  function _currentPage() {
    return (location.pathname.split('/').pop() || 'index.html')
      .toLowerCase().split('?')[0].split('#')[0];
  }

  function _firstRole() {
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || '{}');
      if (Array.isArray(u.roles) && u.roles.length) return u.roles[0];
    } catch (_) {}
    return null;
  }

  /* ── Public API ───────────────────────────────────────────────────── */

  /** Save current page + optional role/business overrides */
  function saveContext(opts) {
    var pg = _currentPage();
    if (SKIP[pg]) return;

    var prev = _get();
    var role = (opts && opts.role) || prev.lastRole || _firstRole();
    var biz  = (opts && opts.business) || prev.lastBusiness || null;

    _set(Object.assign({}, prev, {
      lastPage:     location.pathname + location.search + location.hash,
      lastPageName: pg,
      lastRole:     role,
      lastBusiness: biz,
      savedAt:      Date.now(),
    }));
  }

  /** Return full context (empty object if nothing saved) */
  function getContext() { return _get(); }

  /**
   * Return last non-auth page URL, or null if:
   *   • nothing was saved
   *   • context is older than 7 days
   *   • the saved page is itself an auth page
   */
  function getLastPage() {
    var ctx = _get();
    if (!ctx.lastPage) return null;
    if (ctx.savedAt && (Date.now() - ctx.savedAt) > MAX_AGE) return null;
    if (SKIP[ctx.lastPageName]) return null;
    return ctx.lastPage;
  }

  /** Update just the active role (e.g. after role switcher) */
  function setRole(role) {
    _set(Object.assign(_get(), { lastRole: role }));
  }

  /** Update just the active business context */
  function setBusiness(biz) {
    _set(Object.assign(_get(), { lastBusiness: biz }));
  }

  /** Clear context on logout */
  function clearContext() {
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
  }

  /* ── Auto-save on every qualifying page load ──────────────────────── */
  function _autoSave() {
    /* Delay 800 ms so that firebase.js / auth.js can write sokoniUser first */
    setTimeout(saveContext, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoSave, { once: true });
  } else {
    _autoSave();
  }

  /* Listen for auth events to refresh context with correct role */
  document.addEventListener('sokoniAuthReady', function (e) {
    var role = e.detail && e.detail.role;
    if (role) setRole(role);
  });

  /* Expose globally */
  win.SokoniSessionState = {
    saveContext:  saveContext,
    getContext:   getContext,
    getLastPage:  getLastPage,
    setRole:      setRole,
    setBusiness:  setBusiness,
    clearContext: clearContext,
  };

}(window));
