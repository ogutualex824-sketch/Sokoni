/* ============================================================================
   SOKONI Zero Trust Client SDK  v1.0
   sokoni-zero-trust.js

   Every request verified. No implicit trust: users, devices, sessions,
   or internal services.

   Public API (window.SokoniZeroTrust):
     .init()                          — initialize on Firebase ready
     .guard(action, resource, ctx)    — ABAC gate; auto step-up on trigger
     .requireStepUp(action, reason)   — force step-up for high-sensitivity ops
     .getDeviceId()                   — stable browser fingerprint hash
     .getDeviceTrust()                — cached { score, trusted }
     .getSessionAgeMs()               — ms since last sign-in
     .getCachedRiskContext()          — current risk snapshot or null
     .invalidateCache()               — bust 5-min risk cache
     .refreshDeviceRegistration()     — re-register device with server
     .recordRiskSignal(type, data)    — write to securityEvents

   Server-side CFs used:
     evaluateAccessRequest            — ABAC decision engine
     triggerStepUpAuth                — initiate MFA challenge
     verifyStepUpAuth                 — verify MFA token
     registerDevice                   — device trust registration
     getSessionRiskScore              — session risk snapshot
   ============================================================================ */

(function (global) {
  'use strict';

  /* ── Constants ─────────────────────────────────────────────────────────── */
  var RISK_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 minutes
  var DEVICE_ID_KEY     = 'sokoni_zt_did';
  var DEVICE_TRUST_KEY  = 'sokoni_zt_dt';
  var SESSION_START_KEY = 'sokoni_zt_ss';

  /**
   * Operations that are classified as financial and must NEVER fail open.
   * When Firebase or the access-request CF is unreachable, any action whose
   * name OR resource appears in this set returns {allowed: false} so that
   * money-movement cannot proceed under degraded-infra or DDoS conditions.
   *
   * Extend this list whenever a new money-related action is added to the
   * platform — never remove entries.
   */
  var FINANCIAL_OPERATIONS = new Set([
    // actions
    'payment', 'pay', 'checkout', 'checkout_confirm', 'checkout_complete',
    'wallet', 'wallet_credit', 'wallet_debit', 'wallet_withdraw', 'wallet_transfer',
    'top_up', 'topup',
    'refund', 'refund_request', 'refund_approve',
    'payout', 'payout_request', 'payout_approve',
    'transfer', 'transfer_funds',
    'settlement', 'settle', 'settle_batch',
    'commission', 'commission_disburse',
    'subscription_charge', 'subscription_renew',
    'invoice_pay', 'invoice_settle',
    'escrow', 'escrow_release', 'escrow_fund',
    // resources
    'payments', 'wallets', 'payouts', 'settlements', 'commissions',
    'refunds', 'transfers', 'invoices', 'subscriptions', 'escrow',
    'financial', 'money', 'mpesa', 'intasend', 'banking',
  ]);

  /**
   * Returns true when either the action name or the resource name indicates a
   * financial operation that must not be allowed through on infra failure.
   *
   * @param {string} action
   * @param {string} resource
   * @returns {boolean}
   */
  function _isFinancialOp(action, resource) {
    if (!action && !resource) return false;
    var a = (action   || '').toLowerCase();
    var r = (resource || '').toLowerCase();
    // Exact-set membership check
    if (FINANCIAL_OPERATIONS.has(a) || FINANCIAL_OPERATIONS.has(r)) return true;
    // Substring check for compound action names (e.g. 'initiate_payment', 'wallet_balance')
    for (var term of FINANCIAL_OPERATIONS) {
      if (a.indexOf(term) !== -1 || r.indexOf(term) !== -1) return true;
    }
    return false;
  }

  /* ── Module state ──────────────────────────────────────────────────────── */
  var _deviceId          = null;
  var _riskCache         = null;
  var _riskCacheExpiry   = 0;
  var _initialized       = false;
  var _sessionStart      = Date.now();
  var _cf                = null;  // firebase.functions()
  var _db                = null;  // firebase.firestore()
  var _auth              = null;  // firebase.auth()
  var _stepUpModal       = null;
  var _stepUpResolve     = null;
  var _stepUpReject      = null;
  var _pendingStepUp     = false;

  /* ─────────────────────────────────────────────────────────────────────────
     DEVICE FINGERPRINTING
     Stable browser ID derived from ≥10 entropy sources, SHA-256 hashed.
     Raw signals never leave the device — only the hash is transmitted.
  ──────────────────────────────────────────────────────────────────────────*/
  function _buildSignals() {
    var s = [];
    var nav = navigator;

    // Navigator signals
    s.push(nav.userAgent         || '');
    s.push(nav.language          || '');
    s.push((nav.languages || []).join(','));
    s.push(nav.platform          || '');
    s.push(String(nav.hardwareConcurrency || 0));
    s.push(String(nav.deviceMemory       || 0));
    s.push(String(nav.maxTouchPoints     || 0));

    // Screen
    s.push([screen.width, screen.height, screen.colorDepth].join('x'));
    s.push(String(window.devicePixelRatio || 1));

    // Timezone
    try { s.push(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (_) { s.push(''); }

    // Canvas fingerprint (lightweight — last 48 chars of data URL)
    try {
      var cvs = document.createElement('canvas');
      cvs.width = 220; cvs.height = 44;
      var ctx = cvs.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f68';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('SOKONI✔', 2, 14);
      ctx.fillStyle = 'rgba(113,255,0,0.7)';
      ctx.fillText('SOKONI✔', 4, 17);
      s.push(cvs.toDataURL().slice(-48));
    } catch (_) { s.push('cvs_blocked'); }

    // WebGL renderer (high-entropy hardware signal)
    try {
      var gl = document.createElement('canvas').getContext('webgl')
              || document.createElement('canvas').getContext('experimental-webgl');
      if (gl) {
        var ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) s.push(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
      }
    } catch (_) {}

    // Audio context (subtle CPU/DSP variance)
    try {
      var Ac = window.AudioContext || window.webkitAudioContext;
      if (Ac) {
        var ac = new Ac();
        s.push(String(ac.sampleRate || 0));
        ac.close();
      }
    } catch (_) {}

    return s.join('||');
  }

  async function _fingerprintDevice() {
    var raw = _buildSignals();
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(buf)).map(function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  async function _getOrCreateDeviceId() {
    if (_deviceId) return _deviceId;
    try {
      var stored = localStorage.getItem(DEVICE_ID_KEY);
      if (stored && stored.length === 64) { _deviceId = stored; return _deviceId; }
    } catch (_) {}
    _deviceId = await _fingerprintDevice();
    try { localStorage.setItem(DEVICE_ID_KEY, _deviceId); } catch (_) {}
    return _deviceId;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     FIREBASE INTEGRATION
  ──────────────────────────────────────────────────────────────────────────*/
  function _getFirebase() {
    if (_cf && _db && _auth) return true;
    if (typeof firebase === 'undefined') return false;
    try {
      _cf   = firebase.functions();
      _db   = firebase.firestore();
      _auth = firebase.auth();
      return true;
    } catch (_) { return false; }
  }

  function _currentUser() {
    return (_auth && _auth.currentUser) || null;
  }

  function _callable(name) {
    return _cf.httpsCallable(name);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     DEVICE TRUST CACHE  (localStorage, not session-only)
  ──────────────────────────────────────────────────────────────────────────*/
  function _loadDeviceTrust() {
    try {
      var raw = localStorage.getItem(DEVICE_TRUST_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { score: 0, trusted: false, registeredAt: 0 };
  }

  function _saveDeviceTrust(trust) {
    try { localStorage.setItem(DEVICE_TRUST_KEY, JSON.stringify(trust)); } catch (_) {}
  }

  async function _registerDeviceWithServer() {
    if (!_getFirebase()) return;
    var user = _currentUser();
    if (!user) return;

    var deviceId = await _getOrCreateDeviceId();
    var ua = navigator.userAgent;
    var browser = 'Unknown', os = 'Unknown';

    if (ua.indexOf('Firefox')  > -1) browser = 'Firefox';
    else if (ua.indexOf('Edg/') > -1) browser = 'Edge';
    else if (ua.indexOf('Chrome') > -1) browser = 'Chrome';
    else if (ua.indexOf('Safari') > -1) browser = 'Safari';

    if (ua.indexOf('Windows NT') > -1) os = 'Windows';
    else if (ua.indexOf('Android') > -1) os = 'Android';
    else if (ua.indexOf('iPhone') > -1 || ua.indexOf('iPad') > -1) os = 'iOS';
    else if (ua.indexOf('Mac OS X') > -1) os = 'macOS';
    else if (ua.indexOf('Linux') > -1) os = 'Linux';

    try {
      var result = await _callable('registerDevice')({
        fingerprint: deviceId,
        userAgent:   ua,
        browserName: browser,
        os:          os,
        screenResolution: screen.width + 'x' + screen.height,
        timezone: (function () {
          try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ''; }
        })()
      });
      if (result.data && typeof result.data.trustScore === 'number') {
        _saveDeviceTrust({
          score:        result.data.trustScore,
          trusted:      result.data.trustScore >= 50,
          registeredAt: Date.now(),
          deviceId:     deviceId
        });
      }
    } catch (_) { /* non-blocking */ }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RISK CONTEXT CACHE  (5-min TTL, per-tab memory)
  ──────────────────────────────────────────────────────────────────────────*/
  function _invalidateRiskCache() {
    _riskCache       = null;
    _riskCacheExpiry = 0;
  }

  async function _fetchRiskContext() {
    var now = Date.now();
    if (_riskCache && now < _riskCacheExpiry) return _riskCache;
    if (!_getFirebase()) return { riskScore: 0, trustLevel: 'low' };

    var deviceId    = await _getOrCreateDeviceId();
    var deviceTrust = _loadDeviceTrust();

    try {
      var result = await _callable('getSessionRiskScore')({
        deviceId:         deviceId,
        deviceTrustScore: deviceTrust.score || 0
      });
      _riskCache       = result.data;
      _riskCacheExpiry = now + RISK_CACHE_TTL_MS;
      return _riskCache;
    } catch (_) {
      return { riskScore: 25, trustLevel: 'low' };
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RISK SIGNAL RECORDING
  ──────────────────────────────────────────────────────────────────────────*/
  async function _recordEvent(eventType, data) {
    if (!_db) return;
    var user = _currentUser();
    if (!user) return;
    try {
      await _db.collection('securityEvents').add(Object.assign({
        userId:    user.uid,
        eventType: eventType,
        deviceId:  _deviceId || null,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        source:    'sokoni-zero-trust-client',
        url:       window.location.pathname
      }, data));
    } catch (_) { /* non-blocking */ }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     STEP-UP AUTH MODAL
  ──────────────────────────────────────────────────────────────────────────*/
  var METHOD_META = {
    totp:    { icon: '📱', label: 'Authenticator App',       hint: 'Enter the 6-digit code from your authenticator app.' },
    sms:     { icon: '💬', label: 'SMS Code',                hint: 'Enter the code sent to your registered phone number.' },
    passkey: { icon: '🔑', label: 'Passkey / Security Key',  hint: 'Use your device passkey or hardware security key.' }
  };

  function _esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _buildModal() {
    if (_stepUpModal) return _stepUpModal;

    var overlay = document.createElement('div');
    overlay.id = 'szt-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'szt-title');

    var s = [
      'position:fixed;inset:0;z-index:2147483647',
      'display:flex;align-items:center;justify-content:center',
      'background:rgba(0,0,0,0.88)',
      'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)',
    ].join(';');
    overlay.style.cssText = s;

    overlay.innerHTML = [
      '<div id="szt-box" style="',
        'background:#111115;',
        'border:1px solid rgba(113,255,0,0.3);',
        'border-radius:18px;padding:32px 28px;',
        'max-width:420px;width:90%;',
        'box-shadow:0 24px 80px rgba(0,0,0,0.9);',
        'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;',
        'color:rgba(255,255,255,0.9);',
        'position:relative;',
      '">',

      /* Header */
      '<div style="text-align:center;margin-bottom:22px">',
        '<div id="szt-icon" style="font-size:38px;line-height:1;margin-bottom:10px">🔐</div>',
        '<div id="szt-title" style="font-size:18px;font-weight:700;color:#fff">Additional Verification</div>',
        '<div id="szt-reason" style="font-size:13px;color:rgba(255,255,255,0.5);margin-top:6px;line-height:1.5"></div>',
      '</div>',

      /* Method list */
      '<div id="szt-methods" style="display:flex;flex-direction:column;gap:10px;margin-bottom:6px"></div>',

      /* Code entry (hidden initially) */
      '<div id="szt-entry" style="display:none">',
        '<div id="szt-entry-hint" style="font-size:13px;color:rgba(255,255,255,0.55);margin-bottom:8px;line-height:1.5"></div>',
        '<input id="szt-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8"',
          ' placeholder="Enter code"',
          ' style="',
            'width:100%;box-sizing:border-box;padding:15px 16px;',
            'background:rgba(255,255,255,0.06);',
            'border:1px solid rgba(255,255,255,0.2);',
            'border-radius:12px;',
            'color:#fff;font-size:22px;text-align:center;letter-spacing:0.2em;',
            'outline:none;transition:border-color 0.2s;',
          '" />',
        '<div id="szt-err" role="alert" style="color:#f87171;font-size:13px;margin-top:7px;min-height:18px"></div>',
        '<button id="szt-verify" style="',
          'width:100%;margin-top:12px;padding:15px;',
          'background:#71ff00;color:#000;font-weight:700;font-size:15px;',
          'border:none;border-radius:12px;cursor:pointer;',
          'transition:opacity 0.2s;',
        '">Verify</button>',
      '</div>',

      /* Cancel */
      '<button id="szt-cancel" style="',
        'width:100%;margin-top:10px;padding:12px;',
        'background:transparent;color:rgba(255,255,255,0.4);font-size:14px;',
        'border:1px solid rgba(255,255,255,0.1);border-radius:12px;cursor:pointer;',
        'transition:color 0.2s,border-color 0.2s;',
      '">Cancel</button>',

      '</div>',
    ].join('');

    document.body.appendChild(overlay);
    _stepUpModal = overlay;

    overlay.querySelector('#szt-cancel').addEventListener('click', _cancelStepUp);

    /* Focus trap */
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') _cancelStepUp();
      if (e.key === 'Tab') {
        var focusable = overlay.querySelectorAll('button:not([disabled]),input');
        var arr = Array.prototype.slice.call(focusable);
        if (!arr.length) return;
        var idx = arr.indexOf(document.activeElement);
        if (e.shiftKey) {
          if (idx <= 0) { e.preventDefault(); arr[arr.length - 1].focus(); }
        } else {
          if (idx === arr.length - 1) { e.preventDefault(); arr[0].focus(); }
        }
      }
    });

    /* Code input focus style */
    var codeInput = overlay.querySelector('#szt-code');
    codeInput.addEventListener('focus', function () {
      codeInput.style.borderColor = 'rgba(113,255,0,0.6)';
    });
    codeInput.addEventListener('blur', function () {
      codeInput.style.borderColor = 'rgba(255,255,255,0.2)';
    });

    return overlay;
  }

  function _showStepUp(challenge) {
    var overlay = _buildModal();
    overlay.style.display = 'flex';
    overlay.querySelector('#szt-reason').textContent = challenge.reason || 'This action requires additional verification.';
    overlay.querySelector('#szt-err').textContent    = '';
    overlay.querySelector('#szt-entry').style.display   = 'none';
    overlay.querySelector('#szt-methods').style.display = 'flex';
    overlay.querySelector('#szt-methods').innerHTML     = '';

    var methods = challenge.methods || ['totp'];
    methods.forEach(function (method) {
      var meta = METHOD_META[method] || { icon: '🔒', label: method, hint: 'Enter the verification code.' };
      var btn  = document.createElement('button');
      btn.style.cssText = [
        'display:flex;align-items:center;gap:14px;padding:14px 16px',
        'background:rgba(255,255,255,0.04)',
        'border:1px solid rgba(255,255,255,0.1)',
        'border-radius:12px;cursor:pointer',
        'color:rgba(255,255,255,0.85)',
        'font-size:14px;text-align:left;width:100%',
        'transition:border-color 0.2s,background 0.2s',
      ].join(';');
      btn.innerHTML = '<span style="font-size:26px;flex-shrink:0">' + meta.icon + '</span>'
                    + '<div><div style="font-weight:600">' + _esc(meta.label) + '</div></div>';
      btn.addEventListener('mouseenter', function () {
        btn.style.borderColor = 'rgba(113,255,0,0.5)';
        btn.style.background  = 'rgba(113,255,0,0.06)';
      });
      btn.addEventListener('mouseleave', function () {
        btn.style.borderColor = 'rgba(255,255,255,0.1)';
        btn.style.background  = 'rgba(255,255,255,0.04)';
      });
      btn.addEventListener('click', function () {
        _startEntry(challenge, method, meta.hint);
      });
      overlay.querySelector('#szt-methods').appendChild(btn);
    });
  }

  function _startEntry(challenge, method, hint) {
    var overlay  = _stepUpModal;
    overlay.querySelector('#szt-methods').style.display  = 'none';
    var entry    = overlay.querySelector('#szt-entry');
    entry.style.display = 'block';
    overlay.querySelector('#szt-entry-hint').textContent = hint;
    var codeInput = overlay.querySelector('#szt-code');
    codeInput.value = '';
    codeInput.focus();

    var verifyBtn = overlay.querySelector('#szt-verify');
    var errEl     = overlay.querySelector('#szt-err');
    errEl.textContent = '';

    /* Remove previous listener by replacing button */
    var fresh = verifyBtn.cloneNode(true);
    verifyBtn.parentNode.replaceChild(fresh, verifyBtn);
    fresh.addEventListener('click', function () { _submitCode(challenge, method, fresh, errEl); });

    codeInput.onkeydown = function (e) {
      if (e.key === 'Enter') fresh.click();
    };
  }

  async function _submitCode(challenge, method, btn, errEl) {
    var code = (_stepUpModal.querySelector('#szt-code').value || '').trim();
    if (!code) { errEl.textContent = 'Please enter the verification code.'; return; }

    btn.disabled     = true;
    btn.textContent  = 'Verifying…';
    errEl.textContent = '';

    try {
      var result = await _callable('verifyStepUpAuth')({
        challengeId:        challenge.challengeId,
        method:             method,
        verificationToken:  code
      });

      if (result.data && result.data.verified) {
        _hideStepUp();
        _invalidateRiskCache();
        if (_stepUpResolve) _stepUpResolve({ verified: true, method: method });
      } else {
        errEl.textContent = 'Verification failed. Please try again.';
        btn.disabled    = false;
        btn.textContent = 'Verify';
      }
    } catch (err) {
      errEl.textContent = err.message || 'Verification failed. Please try again.';
      btn.disabled    = false;
      btn.textContent = 'Verify';
    }
  }

  function _cancelStepUp() {
    _hideStepUp();
    if (_stepUpReject) _stepUpReject(new Error('Step-up auth cancelled.'));
  }

  function _hideStepUp() {
    if (_stepUpModal) _stepUpModal.style.display = 'none';
    _stepUpResolve  = null;
    _stepUpReject   = null;
    _pendingStepUp  = false;
  }

  async function _requestStepUp(action, reason, methods) {
    if (_pendingStepUp) {
      return new Promise(function (_, reject) {
        reject(new Error('Step-up auth already in progress.'));
      });
    }
    _pendingStepUp = true;

    var result = await _callable('triggerStepUpAuth')({
      action:  action,
      reason:  reason
    });
    if (!result.data || !result.data.challengeId) {
      _pendingStepUp = false;
      throw new Error('Failed to initiate step-up authentication.');
    }

    var challenge = result.data;
    if (methods) challenge.methods = methods;
    challenge.reason = reason;

    return new Promise(function (resolve, reject) {
      _stepUpResolve = resolve;
      _stepUpReject  = reject;
      _showStepUp(challenge);
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PASSIVE RISK MONITORING
  ──────────────────────────────────────────────────────────────────────────*/
  function _setupPassiveMonitors() {
    /* Bust risk cache on visibility restore (tab switch) */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      _invalidateRiskCache();
    });

    /* Detect copy from password / sensitive fields */
    document.addEventListener('copy', function (e) {
      var el = e.target;
      if (!el) return;
      if (el.type === 'password' || el.dataset.sensitive) {
        _recordEvent('sensitive_field_copy', { field: el.name || el.id || 'unknown' });
      }
    });

    /* Detect rapid repeated form submissions */
    var _lastSubmit = 0;
    document.addEventListener('submit', function () {
      var now = Date.now();
      if (_lastSubmit && (now - _lastSubmit) < 1500) {
        _recordEvent('rapid_form_submit', { intervalMs: now - _lastSubmit });
        _invalidateRiskCache();
      }
      _lastSubmit = now;
    });

    /* Detect console open (devtools heuristic — high-value pages only) */
    if (/checkout|wallet|pay\b/.test(window.location.pathname)) {
      var _consoleCheck = 0;
      var _devtoolsOpen = false;
      setInterval(function () {
        var threshold = 160;
        if (window.outerWidth - window.innerWidth > threshold
            || window.outerHeight - window.innerHeight > threshold) {
          if (!_devtoolsOpen) {
            _devtoolsOpen = true;
            _recordEvent('devtools_open', { page: window.location.pathname });
            _invalidateRiskCache();
          }
        } else {
          _devtoolsOpen = false;
        }
      }, 5000);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
  ──────────────────────────────────────────────────────────────────────────*/
  var SokoniZeroTrust = {

    /**
     * Initialize the SDK.
     * Call once when Firebase is ready (e.g. from shared-header.js or app init).
     */
    init: function () {
      if (_initialized) return;
      _initialized = true;

      /* Restore session start from storage (survives same-tab reload) */
      try {
        var ss = parseInt(sessionStorage.getItem(SESSION_START_KEY) || '0', 10);
        if (ss > 0) _sessionStart = ss;
        else { sessionStorage.setItem(SESSION_START_KEY, String(_sessionStart)); }
      } catch (_) {}

      _getFirebase();

      /* Pre-compute device ID */
      _getOrCreateDeviceId();

      /* Register device and hook auth state */
      if (_auth) {
        _auth.onAuthStateChanged(function (user) {
          if (user) {
            _registerDeviceWithServer();
          } else {
            _invalidateRiskCache();
          }
        });
      }

      _setupPassiveMonitors();
    },

    /**
     * Primary access gate — call before any sensitive operation.
     *
     * @param {string} action    e.g. 'checkout', 'refund', 'delete_product', 'admin_action'
     * @param {string} resource  e.g. 'orders', 'payments', 'users', 'products'
     * @param {object} [context] extra attributes (transactionAmount, orderId, etc.)
     * @returns {Promise<{ allowed: boolean, riskScore: number, reason?: string, requiresStepUp?: boolean }>}
     */
    guard: async function (action, resource, context) {
      context = context || {};

      if (!_getFirebase()) {
        if (_isFinancialOp(action, resource)) {
          console.error('[SokoniZeroTrust] Firebase unavailable — blocking financial op (fail-safe):', action, resource);
          return { allowed: false, riskScore: 100, reason: 'authorization_service_unavailable' };
        }
        console.warn('[SokoniZeroTrust] Firebase unavailable — failing open for non-financial op:', action);
        return { allowed: true, riskScore: 0, failedOpen: true, reason: 'firebase_unavailable' };
      }

      var user = _currentUser();
      if (!user) {
        return { allowed: false, riskScore: 100, reason: 'unauthenticated' };
      }

      var deviceId    = await _getOrCreateDeviceId();
      var deviceTrust = _loadDeviceTrust();

      var payload = {
        userId:   user.uid,
        action:   action,
        resource: resource,
        context: Object.assign({
          deviceId:         deviceId,
          deviceTrustScore: deviceTrust.score  || 0,
          deviceTrusted:    deviceTrust.trusted || false,
          sessionAge:       this.getSessionAgeMs()
        }, context)
      };

      var decision;
      try {
        var result = await _callable('evaluateAccessRequest')(payload);
        decision = result.data;
      } catch (err) {
        if (err.code === 'unauthenticated' || err.code === 'permission-denied') {
          return { allowed: false, riskScore: 100, reason: err.message };
        }
        /* Financial ops must never be let through when the auth CF is unreachable */
        _recordEvent('guard_cf_error', { action: action, resource: resource, error: err.message });
        if (_isFinancialOp(action, resource)) {
          console.error('[SokoniZeroTrust] evaluateAccessRequest failed — blocking financial op (fail-safe):', action, resource, err.message);
          return { allowed: false, riskScore: 100, reason: 'authorization_service_unavailable' };
        }
        /* Fail open only for non-financial ops — never block a user for infra issues on low-risk actions */
        console.warn('[SokoniZeroTrust] evaluateAccessRequest failed — failing open for non-financial op:', err.message);
        return { allowed: true, riskScore: 25, failedOpen: true };
      }

      /* Step-up required */
      if (!decision.allowed && decision.requiresStepUp) {
        try {
          var stepUpResult = await _requestStepUp(
            action,
            decision.stepUpReason || ('Verification required for: ' + action),
            decision.stepUpMethods
          );
          if (stepUpResult.verified) {
            /* Re-evaluate with step-up proof */
            return this.guard(action, resource, Object.assign({}, context, {
              stepUpVerified: true,
              stepUpMethod:   stepUpResult.method
            }));
          }
        } catch (stepErr) {
          if (stepErr.message && stepErr.message.indexOf('cancelled') >= 0) {
            return { allowed: false, riskScore: decision.riskScore || 50, reason: 'step_up_cancelled' };
          }
          throw stepErr;
        }
      }

      if (!decision.allowed) {
        _recordEvent('access_denied', {
          action:    action,
          resource:  resource,
          riskScore: decision.riskScore,
          reason:    decision.reason
        });
      }

      return decision;
    },

    /**
     * Force step-up auth unconditionally (for high-sensitivity actions
     * like large transfers, admin operations, or password changes).
     */
    requireStepUp: async function (action, reason) {
      if (!_getFirebase()) throw new Error('[SokoniZeroTrust] Firebase not ready.');
      return _requestStepUp(action, reason);
    },

    /**
     * Get the stable device fingerprint hash (64-char hex string).
     * @returns {Promise<string>}
     */
    getDeviceId: async function () {
      return _getOrCreateDeviceId();
    },

    /**
     * Get locally cached device trust (no network call).
     * @returns {{ score: number, trusted: boolean, registeredAt: number }}
     */
    getDeviceTrust: function () {
      return _loadDeviceTrust();
    },

    /**
     * Milliseconds elapsed since the user's last sign-in.
     * Uses Firebase metadata; falls back to in-tab session start time.
     * @returns {number}
     */
    getSessionAgeMs: function () {
      var user = _currentUser();
      if (user && user.metadata && user.metadata.lastSignInTime) {
        var t = new Date(user.metadata.lastSignInTime).getTime();
        if (!isNaN(t)) return Date.now() - t;
      }
      return Date.now() - _sessionStart;
    },

    /**
     * Return the cached risk context without making a network call.
     * Returns null if expired or not yet fetched.
     * @returns {{ riskScore: number, trustLevel: string } | null}
     */
    getCachedRiskContext: function () {
      return (_riskCache && Date.now() < _riskCacheExpiry) ? _riskCache : null;
    },

    /**
     * Bust the 5-minute risk cache, forcing a fresh evaluation on the next guard().
     */
    invalidateCache: function () {
      _invalidateRiskCache();
    },

    /**
     * Re-register the current device with the server.
     * Trust score is updated in localStorage on success.
     */
    refreshDeviceRegistration: async function () {
      await _registerDeviceWithServer();
    },

    /**
     * Record a named risk signal to securityEvents.
     * Use for custom app-level signals (e.g. 'high_value_cart', 'promo_abuse_attempt').
     * @param {string} eventType
     * @param {object} [data]
     */
    recordRiskSignal: async function (eventType, data) {
      await _recordEvent(eventType, data || {});
    }
  };

  global.SokoniZeroTrust = SokoniZeroTrust;

})(typeof window !== 'undefined' ? window : this);
