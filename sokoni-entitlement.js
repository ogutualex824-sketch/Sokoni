/* ================================================================
   SOKONI — Universal Entitlement Service  v1.0.0

   Zero-trust architecture — one engine governs ALL Sokoni products:
     Marketplace · SmartPOS · AI Studio · Delivery · Logistics
     Events · Property · Vehicles · Advertising · Business · Warehousing

   Flow:
     User → Firebase Auth → verifyEntitlement CF
          → HMAC-signed Token (15-min TTL) → Feature Granted / Denied

   Anti-piracy guarantees:
     Subscription Spoofing   → server validates plan, not localStorage
     Token Forgery           → HMAC-SHA256; invalid sig → instant denial
     API Abuse               → every call requires valid token + uid match
     Session Hijacking       → session fingerprint mismatch → forced reauth
     Credit Manipulation     → credits calculated server-side only
     Storage Manipulation    → quotas enforced server-side only
     App Modification        → server verifies entitlement on every op
     APK Bypass              → no feature flag in client code; all from server

   Pattern: IIFE → window.SokoniEntitlement
   Requires: window.firebaseApp (from firebase.js)
================================================================ */
(function (global) {
  'use strict';

  const VERSION = '1.0.0';

  /* ── Universal product registry ─────────────────────────────── */
  const PRODUCTS = {
    ai:          { name: 'AI Studio',       subPage: '/ai-subscriptions.html'               },
    marketplace: { name: 'Marketplace',     subPage: '/subscriptions.html'                  },
    pos:         { name: 'SmartPOS',        subPage: '/subscriptions.html?tab=pos'          },
    logistics:   { name: 'Logistics',       subPage: '/subscriptions.html?tab=logistics'    },
    events:      { name: 'Events Hub',      subPage: '/subscriptions.html?tab=events'       },
    property:    { name: 'Property',        subPage: '/subscriptions.html?tab=property'     },
    vehicles:    { name: 'Car Hub',         subPage: '/subscriptions.html?tab=vehicles'     },
    advertising: { name: 'Advertising',     subPage: '/subscriptions.html?tab=ads'          },
    business:    { name: 'Business Pages',  subPage: '/subscriptions.html?tab=business'     },
    warehousing: { name: 'Warehousing',     subPage: '/subscriptions.html?tab=warehouse'    },
    delivery:    { name: 'Delivery',        subPage: '/subscriptions.html?tab=delivery'     },
  };

  /* ── Signed token cache ─────────────────────────────────────── */
  /* Token is an opaque server-signed blob. Client stores + forwards;
     never inspects it for permission decisions.                    */
  let _token    = null;    // { raw: string, claims: object, exp: number }
  let _fetching = null;    // dedup promise — prevents concurrent token fetches
  const TOKEN_SAFE_MS = 13 * 60 * 1000; // refresh 2 min before 15-min server TTL

  /* ── Per-token feature result cache ─────────────────────────── */
  const _cache = new Map(); // `${product}:${feature}` → result object

  /* ── Session fingerprint — hijack / token-theft detection ────── */
  const SESSION_FP = (() => {
    try {
      const n = global.navigator;
      const raw = [
        n.language, n.platform, screen.width, screen.height,
        n.hardwareConcurrency, new Date().getTimezoneOffset(),
      ].join('|');
      return btoa(raw).slice(0, 24);
    } catch { return 'fp_unavailable'; }
  })();

  /* ── Fraud signal buffer ────────────────────────────────────── */
  /* Signals collected passively; sent server-side on next call.    */
  const _signals = [];
  function _emit(type, data) {
    _signals.push({ type, ts: Date.now(), ...(data || {}) });
    if (_signals.length > 60) _signals.shift();
  }

  /* ── Anti-tamper passive monitoring ─────────────────────────── */
  (function _installTamperWatchers() {
    /* 1. Detect DevTools via toString trap */
    const _dt = /./;
    _dt.toString = function () { _emit('devtools_open'); return ''; };
    try { console.log('%c', _dt); } catch { /* ignore */ }

    /* 2. Watch localStorage/sessionStorage writes for spoofing attempts */
    if (typeof Storage !== 'undefined') {
      const _orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (/(plan|subscription|credits|entitlement|quota)/i.test(k)) {
          _emit('storage_write', { key: k });
        }
        return _orig.call(this, k, v);
      };
    }

    /* 3. Detect __proto__ / prototype pollution attempts */
    try {
      const sentinel = {};
      Object.freeze(sentinel);
      if (sentinel.constructor !== Object) _emit('proto_pollution');
    } catch { /* ignore */ }
  })();

  /* ── Idle session management ─────────────────────────────────── */
  /* Force token refresh if tab was hidden >30 minutes              */
  let _hiddenAt = 0;
  global.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      _hiddenAt = Date.now();
    } else if (_hiddenAt) {
      const idleMs = Date.now() - _hiddenAt;
      if (idleMs > 30 * 60 * 1000) {
        invalidate();
        _emit('session_resumed_idle', { idleMs });
      }
      _hiddenAt = 0;
    }
  });

  /* ── Firebase Functions helper ───────────────────────────────── */
  let _fnsCache = null;
  async function _fns() {
    if (_fnsCache) return _fnsCache;
    const { getFunctions } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    _fnsCache = getFunctions(global.firebaseApp, 'us-central1');
    return _fnsCache;
  }

  async function _call(name, data) {
    const { httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    const fn = httpsCallable(await _fns(), name, { timeout: 15000 });
    return (await fn(data)).data;
  }

  /* ── Token lifecycle ─────────────────────────────────────────── */
  async function _refreshToken() {
    if (_fetching) return _fetching;
    _fetching = _call('generateEntitlementToken', {
      sessionFp: SESSION_FP,
      signals:   _signals.splice(0, 10),     // drain + send
    }).then(r => {
      _token    = { raw: r.token, claims: r.claims, exp: Date.now() + TOKEN_SAFE_MS };
      _fetching = null;
      _cache.clear();
      return _token;
    }).catch(e => {
      _fetching = null;
      throw e;
    });
    return _fetching;
  }

  async function _getToken(force = false) {
    if (!force && _token && _token.exp > Date.now() + 30_000) return _token;
    return _refreshToken();
  }

  /* ================================================================
     verify(product, feature)

     The primary zero-trust gate.
     Calls the server CF `verifyEntitlement` on every operation.
     Result cached for the lifetime of the current token (≤13 min).

     Returns:
       { allowed: true,  remaining, plan, product, feature }
       { allowed: false, reason, upgradeUrl?, creditCost?, offline? }
  ================================================================ */
  async function verify(product, feature) {
    if (!PRODUCTS[product]) throw new Error(`Unknown product: "${product}"`);

    const key = `${product}:${feature}`;
    if (_cache.has(key) && _token?.exp > Date.now() + 30_000) {
      return _cache.get(key);
    }

    try {
      const tok    = await _getToken();
      const result = await _call('verifyEntitlement', {
        product,
        feature,
        token:     tok.raw,
        sessionFp: SESSION_FP,
      });

      /* Server may push a refreshed token when ours is near expiry */
      if (result.refreshedToken) {
        _token = { raw: result.refreshedToken, claims: result.refreshedClaims, exp: Date.now() + TOKEN_SAFE_MS };
        _cache.clear();
      }

      _cache.set(key, result);
      return result;
    } catch (e) {
      /* Graceful offline degradation — deny with message, never silently allow */
      const offline = { allowed: false, offline: true, product, feature,
        reason: 'Cannot verify access. Check your connection and try again.' };
      return offline;
    }
  }

  /* ================================================================
     gate(product, feature, label)

     Convenience wrapper: verify() + show upgrade/denial modal.
     Returns true if the feature is allowed; false if blocked.
     Usage:
       if (!await SokoniEntitlement.gate('ai', 'removeBackground', 'Background Removal')) return;
  ================================================================ */
  async function gate(product, feature, label) {
    const r = await verify(product, feature);
    if (!r.allowed) {
      _showModal(r, label || feature);
      return false;
    }
    return true;
  }

  /* ================================================================
     getAll()
     Returns the full entitlement claims from the cached server token.
     Use for rendering "what can this user access?" UI states.
     Never use this to make security decisions — always use verify().
  ================================================================ */
  async function getAll() {
    const tok = await _getToken();
    return tok.claims || {};
  }

  /* ================================================================
     invalidate()
     Clears cached token and feature results.
     Call after any subscription change (upgrade / downgrade / cancel).
  ================================================================ */
  function invalidate() {
    _token = null;
    _cache.clear();
  }

  /* ── Upgrade / denial modal ──────────────────────────────────── */
  function _showModal(result, label) {
    document.getElementById('_ent_dlg')?.remove();

    const prod    = PRODUCTS[result.product || ''] || {};
    const destUrl = result.upgradeUrl || prod.subPage || '/subscriptions.html';

    const el = document.createElement('div');
    el.id    = '_ent_dlg';
    el.innerHTML = `
<style>
#_ent_dlg{position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:100002;display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system}
#_ent_box{background:#111;border:1px solid rgba(113,255,0,.18);border-radius:16px;max-width:390px;width:100%;padding:28px;color:#fff;text-align:center}
#_ent_box h3{font-size:18px;font-weight:800;color:#71ff00;margin:12px 0 8px}
#_ent_box p{font-size:13px;color:rgba(255,255,255,.5);line-height:1.65;margin-bottom:20px}
._eb{display:block;width:100%;padding:13px;border-radius:10px;border:none;cursor:pointer;font-size:14px;font-weight:800;margin-top:10px;transition:.15s}
._ep{background:#71ff00;color:#000}._ep:hover{background:#5de600}
._es{background:rgba(255,255,255,.07);color:rgba(255,255,255,.6)}._es:hover{background:rgba(255,255,255,.12)}
</style>
<div id="_ent_box">
  <div style="font-size:40px">🔒</div>
  <h3>${_esc(label)} Requires Upgrade</h3>
  <p>${_esc(result.reason || 'This feature is not available on your current plan.')}</p>
  ${result.creditCost ? `<p style="font-size:12px;color:#71ff00;margin-top:-10px">Or use ${result.creditCost} AI Credits to unlock once.</p>` : ''}
  <button class="_eb _ep" id="_ent_up">View Plans</button>
  <button class="_eb _es" id="_ent_cl">Not now</button>
</div>`;

    document.body.appendChild(el);
    const close = () => el.remove();
    document.getElementById('_ent_cl').onclick = close;
    el.addEventListener('click', e => { if (e.target === el) close(); });
    document.getElementById('_ent_up').onclick = () => { close(); location.href = destUrl; };
  }

  /* ── Financial change proposal helpers ───────────────────────── */
  /* Admins propose; a different admin approves. Client surface only. */
  async function proposeFinancialChange(type, payload, summary) {
    return _call('proposeFinancialChange', { type, payload, summary });
  }

  async function approveFinancialChange(proposalId) {
    return _call('approveFinancialChange', { proposalId });
  }

  /* ── Subscription change helpers ─────────────────────────────── */
  async function upgrade(product, newPlan, billing, paymentRef) {
    const r = await _call('processSubscriptionChange', { action: 'upgrade', product, newPlan, billing, paymentRef });
    invalidate();
    return r;
  }

  async function downgrade(product, newPlan, billing) {
    const r = await _call('processSubscriptionChange', { action: 'downgrade', product, newPlan, billing });
    invalidate();
    return r;
  }

  async function cancel(product) {
    const r = await _call('processSubscriptionChange', { action: 'cancel', product });
    invalidate();
    return r;
  }

  /* ── XSS-safe escaper ────────────────────────────────────────── */
  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ── Public API ─────────────────────────────────────────────── */
  global.SokoniEntitlement = {
    VERSION,
    PRODUCTS,
    /* Zero-trust core */
    verify,
    gate,
    getAll,
    invalidate,
    /* Fraud signal injection (from other modules) */
    collectSignal: _emit,
    getSessionFp:  () => SESSION_FP,
    /* Financial security layer */
    proposeFinancialChange,
    approveFinancialChange,
    /* Subscription actions */
    upgrade,
    downgrade,
    cancel,
  };

  global.dispatchEvent(new CustomEvent('sokoniEntitlementReady'));

})(window);
