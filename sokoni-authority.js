/* ============================================================================
   SokoniAuthority — the client's ONLY source of merchant entitlements.

   WHY THIS EXISTS (production incident, 2026-07-24)
   A merchant on a paid STARTER plan was shown a 10-product limit while the
   upload engine correctly accepted 13. The upload guard asked the server;
   the display did not. It read users/{uid}.subscription.seller — a document the
   IntaSend payment webhook never wrote — found nothing, and fell back to a
   hard-coded free allowance.

   Four client files each carried their own plan table, every one of them
   hard-coding 10 for the free tier:
       sokoni-subscription.js     FREE_DEFAULTS.listings_limit
       sokoni-revenue.js          PLANS.free.maxListings
       subscription-billing.html  listings_limit default
       sokoni-subscriptions.js    PLANS listings

   None of them could see a subscription, so all of them agreed on the wrong
   answer — which is why the bug looked consistent rather than flaky.

   USE THIS INSTEAD. No screen may compute an upload limit.

       const ent = await SokoniAuthority.getMerchantEntitlements();
       // { active, plan, uploadLimit, uploadsUsed, uploadsRemaining,
       //   premium, expiresAt }

   uploadLimit === -1 means unlimited; uploadsRemaining is -1 to match, so a
   caller never subtracts against a sentinel.

   Live updates: the server materialises entitlements/{uid} on every
   subscription change, so this module refreshes and emits
   'sokoni:entitlements-changed' rather than making screens poll.
============================================================================ */
(function (root) {
  'use strict';

  var CACHE_KEY = 'sokoni_entitlements_v1';
  var TTL_MS    = 5 * 60 * 1000;   /* short: a plan change must surface fast */

  var _mem   = null;               /* in-memory copy, authoritative for this tab */
  var _at    = 0;
  var _unsub = null;
  var _inflight = null;

  function _now() { return Date.now(); }

  function _readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.at || (_now() - o.at) > TTL_MS) return null;
      return o.ent || null;
    } catch (_) { return null; }
  }

  function _writeCache(ent) {
    _mem = ent; _at = _now();
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: _at, ent: ent })); } catch (_) {}
  }

  /* Every cache this module owns, cleared together. A partial clear is how a
     stale entitlement survives a plan change and reintroduces the incident. */
  function invalidate() {
    _mem = null; _at = 0;
    try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
    try { sessionStorage.removeItem(CACHE_KEY); } catch (_) {}
  }

  function _emit(ent) {
    try {
      document.dispatchEvent(new CustomEvent('sokoni:entitlements-changed', { detail: ent }));
    } catch (_) {}
  }

  function _uid() {
    try {
      if (root.firebaseAuth && root.firebaseAuth.currentUser) return root.firebaseAuth.currentUser.uid;
      var u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      return (u && u.uid) || null;
    } catch (_) { return null; }
  }

  /* The server decides. This never computes a limit from a local table — that
     is the entire point of the module. */
  async function _fetch(uid) {
    var fns = root.firebaseFunctions ||
              (root.firebase && root.firebase.functions && root.firebase.functions());
    if (!fns) throw new Error('functions-unavailable');
    var mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    var res = await mod.httpsCallable(fns, 'getMerchantEntitlements')(uid ? { uid: uid } : {});
    return (res && res.data) || null;
  }

  /**
   * getMerchantEntitlements(opts)
   *   opts.force  — bypass the cache (use after a payment returns)
   *   opts.uid    — admin/support only; the server rejects reading another
   *                 merchant unless the caller holds an admin claim
   *
   * Returns null when the answer is genuinely unknown (signed out, offline,
   * server unreachable). Callers MUST treat null as "unknown" and not as
   * "free tier" — inventing a free allowance on the client is the failure this
   * module exists to prevent.
   */
  async function getMerchantEntitlements(opts) {
    opts = opts || {};
    if (!opts.force) {
      if (_mem && (_now() - _at) < TTL_MS) return _mem;
      var cached = _readCache();
      if (cached) { _mem = cached; _at = _now(); return cached; }
    }
    if (_inflight) return _inflight;          /* collapse concurrent callers */

    _inflight = (async function () {
      try {
        var ent = await _fetch(opts.uid);
        if (ent) { _writeCache(ent); _emit(ent); }
        return ent;
      } catch (_) {
        return null;                          /* unknown — never a guess */
      } finally {
        _inflight = null;
      }
    })();
    return _inflight;
  }

  /* Live refresh. entitlements/{uid} is materialised server-side on every
     subscription change, so a paid upgrade reaches an open dashboard without a
     reload and without any screen recomputing anything. */
  function watch() {
    var uid = _uid();
    if (!uid || !root.firebaseDB || _unsub) return;
    try {
      _unsub = root.firebaseDB.collection('entitlements').doc(uid)
        .onSnapshot(function (snap) {
          if (!snap.exists) return;
          var d = snap.data() || {};
          var ent = {
            active: !!d.active, plan: d.plan,
            uploadLimit: d.uploadLimit, uploadsUsed: d.uploadsUsed,
            uploadsRemaining: d.uploadsRemaining, premium: !!d.premium,
            expiresAt: d.expiresAt || null,
          };
          _writeCache(ent); _emit(ent);
        }, function () { /* listener errors are non-fatal */ });
    } catch (_) {}
  }

  function stop() { try { if (_unsub) _unsub(); } catch (_) {} _unsub = null; }

  root.SokoniAuthority = {
    getMerchantEntitlements: getMerchantEntitlements,
    invalidate: invalidate,
    watch: watch,
    stop: stop,
    /* Convenience for guards. Returns null when unknown, never a fabricated
       allowance, so a caller must decide explicitly what to do. */
    canUpload: async function () {
      var e = await getMerchantEntitlements();
      if (!e) return null;
      return e.uploadLimit === -1 || e.uploadsUsed < e.uploadLimit;
    },
  };
}(typeof window !== 'undefined' ? window : this));
