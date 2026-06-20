/**
 * SOKONI Alerts System v1.0
 *
 * - Toast notifications for WARN / ERROR / CRITICAL events
 * - Hooks into SokoniSecurity.audit() to monitor security patterns
 * - Auto-detects repeated failed logins and rate-limit hits
 * - Supports custom handlers (e.g. send to external monitoring)
 *
 * Load AFTER sokoni-security.js.
 */
const SokoniAlerts = (() => {
  'use strict';

  const SEVERITY = { DEBUG:0, INFO:1, WARN:2, ERROR:3, CRITICAL:4 };

  var _handlers       = [];
  var _toastContainer = null;
  var _failedLogins   = {};
  var _rateHits       = {};

  /* ── Toast container ─────────────────────────────────────── */
  function _container() {
    if (!_toastContainer || !document.body.contains(_toastContainer)) {
      _toastContainer = document.createElement('div');
      _toastContainer.id = '_skAlertBox';
      _toastContainer.style.cssText =
        'position:fixed;bottom:20px;right:20px;z-index:2147483640;' +
        'display:flex;flex-direction:column-reverse;gap:8px;' +
        'max-width:320px;pointer-events:none;';
      document.body.appendChild(_toastContainer);
      if (!document.getElementById('_skAlertCSS')) {
        var css = document.createElement('style');
        css.id = '_skAlertCSS';
        css.textContent =
          '@keyframes _skIn{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}';
        document.head.appendChild(css);
      }
    }
    return _toastContainer;
  }

  var _COLORS = {};
  _COLORS[SEVERITY.INFO]     = { bg:'#0d1f0d', border:'#71ff00', icon:'ⓘ' };
  _COLORS[SEVERITY.WARN]     = { bg:'#1f1700', border:'#ffaa00', icon:'⚠️' };
  _COLORS[SEVERITY.ERROR]    = { bg:'#1f0505', border:'#ff4444', icon:'✖' };
  _COLORS[SEVERITY.CRITICAL] = { bg:'#2a0000', border:'#ff0000', icon:'🚨' };

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function _toast(message, severity, ms) {
    if (severity < SEVERITY.WARN) return;
    ms = ms || (severity >= SEVERITY.CRITICAL ? 9000 : 5000);
    var c = _COLORS[severity] || _COLORS[SEVERITY.WARN];
    var el = document.createElement('div');
    el.style.cssText =
      'background:' + c.bg + ';border:1px solid ' + c.border + ';' +
      'border-radius:10px;padding:12px 14px;color:#fff;font-size:13px;' +
      'font-family:"Segoe UI",system-ui,sans-serif;line-height:1.45;' +
      'box-shadow:0 4px 20px rgba(0,0,0,0.45);animation:_skIn .3s ease;' +
      'cursor:pointer;pointer-events:all;';
    el.innerHTML = '<span style="margin-right:6px">' + c.icon + '</span>' + _esc(message);
    el.onclick = function() { el.remove(); };
    _container().appendChild(el);
    setTimeout(function() { if (el.parentNode) el.remove(); }, ms);
  }

  /* ── Core alert function ─────────────────────────────────── */
  function alert(message, severity, details) {
    severity = (typeof severity === 'number') ? severity : SEVERITY.WARN;
    var entry = {
      ts:       Date.now(),
      utc:      new Date().toISOString(),
      message:  message,
      severity: severity,
      details:  details || {}
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() { _toast(message, severity); }, { once:true });
    } else {
      _toast(message, severity);
    }

    /* Write to audit log (avoids infinite loop since audit() doesn't call alert()) */
    if (typeof window.SokoniSecurity !== 'undefined' && typeof SokoniSecurity.audit === 'function') {
      SokoniSecurity.audit('ALERT_' + _name(severity), { message:message, details:details });
    }

    _handlers.forEach(function(h) { try { h(entry); } catch(e) {} });
    return entry;
  }

  function _name(s) {
    return Object.keys(SEVERITY).find(function(k) { return SEVERITY[k] === s; }) || 'WARN';
  }

  /* ── Security pattern monitoring ────────────────────────── */
  function onSecurityEvent(action, details) {
    switch (action) {
      case 'LOGIN_FAILED':
        var em = (details && details.email) || 'unknown';
        _failedLogins[em] = (_failedLogins[em] || 0) + 1;
        if (_failedLogins[em] === 3) {
          warn('Multiple failed login attempts detected.', { email:em });
        } else if (_failedLogins[em] >= 5) {
          error('Account locked: too many failed logins.', { email:em });
          _failedLogins[em] = 0;
        }
        break;

      case 'RATE_LIMITED':
        var k = (details && details.action) || 'unknown';
        _rateHits[k] = (_rateHits[k] || 0) + 1;
        if (_rateHits[k] >= 3) {
          warn('Repeated rate-limit hits detected.', { key:k, count:_rateHits[k] });
        }
        break;

      case 'ACCESS_DENIED':
        if (details && details.reason === 'missing_role') {
          warn('Unauthorised page access attempted.', details);
        }
        break;
    }
  }

  /* ── Patch SokoniSecurity.audit when available ───────────── */
  var _patchTimer = setInterval(function() {
    if (typeof window.SokoniSecurity === 'undefined' || typeof SokoniSecurity.audit !== 'function') return;
    clearInterval(_patchTimer);
    var _orig = SokoniSecurity.audit.bind(SokoniSecurity);
    SokoniSecurity.audit = function(action, details) {
      var entry = _orig(action, details);
      onSecurityEvent(action, details);
      return entry;
    };
  }, 200);

  /* ── Convenience methods ─────────────────────────────────── */
  function info(m, d)     { return alert(m, SEVERITY.INFO,     d); }
  function warn(m, d)     { return alert(m, SEVERITY.WARN,     d); }
  function error(m, d)    { return alert(m, SEVERITY.ERROR,    d); }
  function critical(m, d) { return alert(m, SEVERITY.CRITICAL, d); }
  function addHandler(fn) { if (typeof fn === 'function') _handlers.push(fn); }

  return {
    SEVERITY: SEVERITY,
    alert:      alert,
    info:       info,
    warn:       warn,
    error:      error,
    critical:   critical,
    addHandler: addHandler,
  };
})();

window.SokoniAlerts = SokoniAlerts;
