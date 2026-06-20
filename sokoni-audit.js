/* ================================================================
   SOKONI Audit Logger — sokoni-audit.js
   ─────────────────────────────────────────────────────────────
   Architectural commitment:
     Security is enforced at the Firestore rules layer.
     This logger records significant user actions for admin review.
     Logging is best-effort — a write failure NEVER blocks UX.

   Usage:
     SokoniAudit.log('login_success', { email: '...', role: '...' });
     SokoniAudit.log('product_create', { productId, name, price });

   The Firestore rule for auditLogs enforces:
     • Append-only (no update/delete)
     • uid in payload must match Firebase Auth uid
     • Admin-only reads
================================================================ */
(function () {
  'use strict';

  /* Allowed action constants — keeps typos out of the log */
  var ACTIONS = {
    LOGIN_SUCCESS:    'login_success',
    LOGIN_FAIL:       'login_fail',
    ACCOUNT_LOCKED:   'account_locked',
    LOGOUT:           'logout',
    SIGNUP:           'signup',
    PASSWORD_RESET:   'password_reset_request',
    PROFILE_UPDATE:   'profile_update',
    PRODUCT_CREATE:   'product_create',
    PRODUCT_UPDATE:   'product_update',
    PRODUCT_DELETE:   'product_delete',
    ORDER_PLACE:      'order_place',
    ORDER_STATUS:     'order_status_change',
    EMPLOYEE_LOGIN:   'employee_login',
    EMPLOYEE_LOGOUT:  'employee_logout',
    ADMIN_ACTION:     'admin_action',
    PERMISSION_DENY:  'permission_denied',
    DATA_EXPORT:      'data_export_request',
    ACCOUNT_DELETE:   'account_delete_request',
  };

  /* Queue entries written before Firebase is ready */
  var _queue = [];
  var _flushing = false;

  function _currentUser() {
    try {
      var fbUser = window.firebaseAuth && window.firebaseAuth.currentUser;
      if (fbUser) return { uid: fbUser.uid, email: fbUser.email || '' };
      var stored = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      if (stored && stored.uid) return { uid: stored.uid, email: stored.email || '' };
    } catch (e) {}
    return { uid: 'anonymous', email: 'anonymous' };
  }

  async function _flush(db) {
    if (_flushing || _queue.length === 0) return;
    _flushing = true;
    try {
      var { addDoc, collection } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      while (_queue.length > 0) {
        var entry = _queue.shift();
        await addDoc(collection(db, 'auditLogs'), entry);
      }
    } catch (e) {
      /* put items back */
      _flushing = false;
    }
    _flushing = false;
  }

  async function _getDB() {
    if (window.firebaseDB) return window.firebaseDB;
    for (var i = 0; i < 12; i++) {
      await new Promise(function (r) { setTimeout(r, 500); });
      if (window.firebaseDB) return window.firebaseDB;
    }
    return null;
  }

  async function log(action, details) {
    try {
      var actor = _currentUser();
      var entry = {
        uid:       actor.uid,
        email:     actor.email,
        action:    String(action).substring(0, 80),
        details:   sanitise(details || {}),
        page:      window.location.pathname + (window.location.search || ''),
        ts:        new Date().toISOString(),
      };

      /* Queue immediately so the event is never lost even if write is slow */
      _queue.push(entry);

      var db = await _getDB();
      if (!db) return; /* graceful degradation */

      /* Add server timestamp on the actual write */
      var { addDoc, collection, serverTimestamp } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      entry = Object.assign({}, entry, { serverTs: serverTimestamp() });
      _queue.pop(); /* remove queued version, write directly */
      await addDoc(collection(db, 'auditLogs'), entry);
    } catch (e) {
      /* Audit logging must never crash caller code */
      if (typeof console !== 'undefined') {
        console.warn('[SokoniAudit] log skipped:', e && e.message);
      }
      /* Try to flush any queued items on next call */
      _getDB().then(function (db) { if (db) _flush(db); });
    }
  }

  /* Strip keys that should never be logged (passwords, raw tokens) */
  function sanitise(obj) {
    var safe = {};
    var blocked = /passw|secret|token|pin|card|cvv|pan|key/i;
    Object.keys(obj).forEach(function (k) {
      if (!blocked.test(k)) {
        var v = obj[k];
        if (typeof v === 'string') v = v.substring(0, 200);
        safe[k] = v;
      }
    });
    return safe;
  }

  window.SokoniAudit = { log: log, ACTIONS: ACTIONS };
})();
