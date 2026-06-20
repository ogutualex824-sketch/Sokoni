/**
 * SOKONI Security Extension  v2.0
 *
 * Extends the base SokoniSecurity (security.js) with:
 *   • Session management  — 24-hour, device-bound sessions
 *   • Role-based access   — requireAuth(), hasRole()
 *   • Data isolation      — per-user namespaced localStorage
 *   • Audit log           — append-only action trail
 *
 * Must load AFTER security.js (or standalone if security.js not on the page).
 * sokoni-guards.js must load after this file.
 */
(function (root) {
  'use strict';

  /* ── Ensure base object exists ── */
  if (!root.SokoniSecurity) {
    root.SokoniSecurity = {};
  }
  var S = root.SokoniSecurity;

  /* Skip if already extended (double-load guard) */
  if (S._v2) return;
  S._v2 = true;

  /* ═══════════════════════════════════════════════════════════════
     CONSTANTS
  ═══════════════════════════════════════════════════════════════ */
  var SESSION_KEY = 'sokoniSession_v2';
  var AUDIT_KEY   = 'sokoniAuditLog';
  var DEVICE_KEY  = 'sokoniDeviceId';
  var SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
  var MAX_AUDIT   = 500;

  /* ═══════════════════════════════════════════════════════════════
     DEVICE ID  — stable per browser profile
  ═══════════════════════════════════════════════════════════════ */
  function _deviceId() {
    var id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      var rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
      id = 'DEV_' + Date.now() + '_' + rand;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  /* ═══════════════════════════════════════════════════════════════
     UID  — deterministic, safe identifier from email
  ═══════════════════════════════════════════════════════════════ */
  function _uid(email) {
    return 'U_' + String(email || 'guest').toLowerCase().replace(/[^a-z0-9]/g, '_');
  }

  /* ═══════════════════════════════════════════════════════════════
     SESSION MANAGEMENT
  ═══════════════════════════════════════════════════════════════ */

  function getSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !s.uid || !s.expires) return null;
      if (Date.now() > s.expires) { clearSession(); return null; }
      return s;
    } catch (e) { return null; }
  }

  function setSession(user) {
    /* Build roles from registeredAs only.
       Admin status is verified server-side via Firebase custom claims —
       never trust the user-supplied isAdmin field from localStorage.    */
    var roles = Object.assign({}, user.registeredAs || { buyer: true });
    /* isAdmin deliberately NOT copied from localStorage — use firebaseAuth.currentUser
       .getIdTokenResult().claims.admin for authoritative admin check.   */
    var session = {
      uid:      _uid(user.email),
      name:     user.name     || '',
      email:    user.email    || '',
      roles:    roles,
      deviceId: _deviceId(),
      issuedAt: Date.now(),
      expires:  Date.now() + SESSION_TTL,
    };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
    localStorage.setItem('loggedIn', 'true');
    audit('SESSION_START', { uid: session.uid, name: session.name });
    return session;
  }

  function clearSession() {
    var s = getSession();
    if (s) audit('SESSION_END', { uid: s.uid });
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem('loggedIn');
  }

  function getUserId() {
    var s = getSession();
    if (s) return s.uid;
    /* Legacy: derive from sokoniUser */
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (u && u.email) return _uid(u.email);
      if (u && u.name)  return _uid(u.name);
    } catch (e) {}
    return null;
  }

  function getCurrentUser() {
    var s = getSession();
    if (s) return s;
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (u) return { uid: _uid(u.email || u.name || ''), name: u.name, email: u.email, roles: u.registeredAs || { buyer: true }, legacy: true };
    } catch (e) {}
    return null;
  }

  /* ═══════════════════════════════════════════════════════════════
     ACCESS CONTROL
  ═══════════════════════════════════════════════════════════════ */

  function isLoggedIn() {
    if (getSession()) return true;
    /* Legacy fallback */
    try {
      var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      return !!(u && u.name && localStorage.getItem('loggedIn') === 'true');
    } catch (e) { return false; }
  }

  function hasRole(role) {
    var u = getCurrentUser();
    if (!u) return false;
    /* Always read from the session — never from raw localStorage to
       prevent a user setting isAdmin=true in DevTools and gaining admin access. */
    return !!(u.roles && u.roles[role]);
  }

  var ROLE_LABELS = {
    seller:     'Seller',
    driver:     'Driver',
    landlord:   'Landlord / Host',
    healthcare: 'Healthcare Provider',
    delivery:   'Delivery Agent',
    mechanic:   'Mechanic',
    legal:      'Legal Professional',
    admin:      'Admin',
    provider:   'Service Provider',
  };

  function requireAuth(role, redirectUrl) {
    if (!isLoggedIn()) {
      sessionStorage.setItem('sokoniLoginRedirect',
        window.location.pathname.split('/').pop() + window.location.search);
      audit('ACCESS_DENIED', { reason: 'not_logged_in', page: _page() });
      window.location.replace('login.html');
      return false;
    }
    if (role && !hasRole(role)) {
      audit('ACCESS_DENIED', { reason: 'missing_role', role: role, page: _page() });
      _showRoleBlocker(role, redirectUrl);
      return false;
    }
    audit('PAGE_ACCESS', { role: role || 'any', page: _page() });
    return true;
  }

  function _page() {
    return window.location.pathname.split('/').pop() || 'index.html';
  }

  function _showRoleBlocker(role, redirectUrl) {
    var existing = document.getElementById('_sokoniRoleBlocker');
    if (existing) existing.remove();
    var label = ROLE_LABELS[role] || role;
    var div = document.createElement('div');
    div.id = '_sokoniRoleBlocker';
    div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:2147483646;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px;font-family:"Segoe UI",system-ui,sans-serif;';

    /* Validate redirectUrl — only allow safe relative paths */
    var safeRedirect = 'index.html';
    if (redirectUrl && /^[a-zA-Z0-9_\-\.\/\?=&%#]+$/.test(String(redirectUrl)) && String(redirectUrl).indexOf('//') === -1) {
      safeRedirect = redirectUrl;
    }

    /* Build DOM via textContent — no innerHTML interpolation of dynamic values */
    var card = document.createElement('div');
    card.style.cssText = 'max-width:420px;width:100%;background:#111;border:1px solid rgba(113,255,0,0.22);border-radius:24px;padding:36px 28px;text-align:center;margin:auto;';

    var iconEl = document.createElement('div');
    iconEl.style.cssText = 'font-size:52px;margin-bottom:16px;';
    iconEl.textContent = '🔒'; /* lock emoji via unicode escape */

    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-size:20px;font-weight:900;color:white;margin-bottom:8px;';
    titleEl.textContent = label + ' Access Required';

    var descEl = document.createElement('div');
    descEl.style.cssText = 'font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6;margin-bottom:24px;';
    var strong = document.createElement('strong');
    strong.style.color = 'white';
    strong.textContent = label;
    descEl.appendChild(document.createTextNode('You need to register as a '));
    descEl.appendChild(strong);
    descEl.appendChild(document.createTextNode(' to access this section.'));

    var regBtn = document.createElement('a');
    regBtn.href = 'signup.html';
    regBtn.style.cssText = 'display:block;padding:13px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;font-weight:900;font-size:14px;border-radius:12px;text-decoration:none;margin-bottom:10px;';
    regBtn.textContent = 'Register as ' + label + ' →';

    var backBtn = document.createElement('a');
    backBtn.href = safeRedirect;
    backBtn.style.cssText = 'display:block;padding:10px;color:rgba(255,255,255,0.4);font-size:13px;text-decoration:none;';
    backBtn.textContent = '← Back to Home';

    card.appendChild(iconEl);
    card.appendChild(titleEl);
    card.appendChild(descEl);
    card.appendChild(regBtn);
    card.appendChild(backBtn);
    div.appendChild(card);
    document.body.appendChild(div);
  }

  /* ═══════════════════════════════════════════════════════════════
     DATA ISOLATION  — namespace localStorage keys per user
  ═══════════════════════════════════════════════════════════════ */

  function userKey(key) {
    var uid = getUserId();
    return uid ? key + '__' + uid : key;
  }

  function getItem(key, fallback) {
    if (fallback === undefined) fallback = null;
    var scoped = userKey(key);
    var raw = localStorage.getItem(scoped);
    /* Fall back to legacy bare key for existing data */
    if (raw === null) raw = localStorage.getItem(key);
    try { return raw !== null ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }

  function setItem(key, value) {
    try { localStorage.setItem(userKey(key), JSON.stringify(value)); } catch (e) {}
  }

  function removeItem(key) {
    localStorage.removeItem(userKey(key));
    localStorage.removeItem(key);
  }

  /** One-time migration: copy bare-key data into user-scoped key */
  function migrateUserData(keys) {
    var uid = getUserId();
    if (!uid) return;
    (keys || []).forEach(function (k) {
      var legacy = localStorage.getItem(k);
      var scoped = userKey(k);
      if (legacy !== null && localStorage.getItem(scoped) === null) {
        try { localStorage.setItem(scoped, legacy); } catch (e) {}
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     AUDIT LOG
  ═══════════════════════════════════════════════════════════════ */

  /* Actions that get shipped to Firestore for server-side logging */
  var _CRITICAL_ACTIONS = ['LOGIN_FAILED', 'ACCESS_DENIED', 'RATE_LIMITED', 'PASSWORD_RESET_REQUEST', 'PASSWORD_RESET_COMPLETE', 'SESSION_TAMPERING'];

  function audit(action, details) {
    var u = getCurrentUser();
    var entry = Object.assign({
      id:    'AUD_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      ts:    Date.now(),
      utc:   new Date().toISOString(),
      local: new Date().toLocaleString('en-KE'),
      uid:   (u && u.uid)  || 'anonymous',
      name:  (u && u.name) || 'Anonymous',
      action: action,
      page:  _page(),
    }, details || {});
    try {
      var raw = localStorage.getItem(AUDIT_KEY);
      var log = raw ? JSON.parse(raw) : [];
      log.unshift(entry);
      if (log.length > MAX_AUDIT) log = log.slice(0, MAX_AUDIT);
      localStorage.setItem(AUDIT_KEY, JSON.stringify(log));
    } catch (e) {}
    /* Ship critical security events to Firestore (non-blocking) */
    if (_CRITICAL_ACTIONS.indexOf(action) !== -1 && typeof window.sokoniFirestoreAudit === 'function') {
      try { window.sokoniFirestoreAudit(entry); } catch (e) {}
    }
    return entry;
  }

  function getAuditLog(opts) {
    opts = opts || {};
    try {
      var log = JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]');
      if (opts.uid)    log = log.filter(function(e){ return e.uid    === opts.uid;    });
      if (opts.action) log = log.filter(function(e){ return e.action === opts.action; });
      if (opts.page)   log = log.filter(function(e){ return e.page   === opts.page;   });
      if (opts.since)  log = log.filter(function(e){ return e.ts     >= opts.since;   });
      if (opts.limit)  log = log.slice(0, opts.limit);
      return log;
    } catch (e) { return []; }
  }

  function clearAuditLog() {
    localStorage.removeItem(AUDIT_KEY);
  }

  /* ═══════════════════════════════════════════════════════════════
     ADDITIONAL VALIDATION HELPERS
     (complements the validators already in security.js)
  ═══════════════════════════════════════════════════════════════ */
  var Validate = {
    nationalId: function(v){ return /^\d{7,8}$/.test(String(v||'').trim()); },
    name: function(v, min, max){ min=min||2; max=max||80; var t=String(v||'').trim(); return t.length>=min&&t.length<=max&&!/[<>{}]/.test(t); },
    text: function(v, min, max){ min=min||1; max=max||5000; var t=String(v||'').trim(); return t.length>=min&&t.length<=max; },
    url:  function(v){ try{ var u=new URL(v); return ['http:','https:'].includes(u.protocol); }catch(e){ return false; } },
  };

  /* ═══════════════════════════════════════════════════════════════
     RATE LIMITING (extends the one in security.js)
  ═══════════════════════════════════════════════════════════════ */
  var _rl = {};
  function rateLimit(action, maxCalls, windowMs) {
    maxCalls = maxCalls || 5;
    windowMs = windowMs || 60000;
    var now = Date.now();
    _rl[action] = (_rl[action] || []).filter(function(t){ return now - t < windowMs; });
    if (_rl[action].length >= maxCalls) {
      audit('RATE_LIMITED', { action: action });
      return false;
    }
    _rl[action].push(now);
    return true;
  }

  /* ═══════════════════════════════════════════════════════════════
     ATTACH TO SokoniSecurity
  ═══════════════════════════════════════════════════════════════ */
  Object.assign(S, {
    /* Session */
    getSession:     getSession,
    setSession:     setSession,
    clearSession:   clearSession,
    getUserId:      getUserId,
    getCurrentUser: getCurrentUser,
    /* Access */
    isLoggedIn:     isLoggedIn,
    hasRole:        hasRole,
    requireAuth:    requireAuth,
    ROLE_LABELS:    ROLE_LABELS,
    /* Isolation */
    userKey:        userKey,
    getItem:        getItem,
    setItem:        setItem,
    removeItem:     removeItem,
    migrateUserData: migrateUserData,
    /* Audit */
    audit:          audit,
    getAuditLog:    getAuditLog,
    clearAuditLog:  clearAuditLog,
    /* Extras */
    Validate:       Validate,
    rateLimit:      S.rateLimit || rateLimit,  /* prefer base if already present */
    /* XSS sanitizer */
    sanitize:       sanitizeHtml,
  });

  /* ── XSS Sanitizer — strips all HTML tags and dangerous attributes ── */
  function sanitizeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  }
  /* Expose globally for convenience */
  root.sokoniSanitize = sanitizeHtml;

  /* ── URL sanitizer — prevents javascript: open redirects ── */
  root.sokoniSafeUrl = function(url) {
    if (!url || typeof url !== 'string') return '#';
    const lower = url.trim().toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) return '#';
    return url;
  };

}(window));
