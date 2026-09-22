/* ══════════════════════════════════════════════════════════════════════════
   SOKONI DEVICE BUS — sokoni-device-bus.js
   Device identity, scoped subscriptions and cross-channel de-duplication.

   ── WHY THIS IS NOT CALLED sokoni-realtime.js ────────────────────────────
   `realtime.js` (v1.0) already exists and already upgrades one-time fetches to
   onSnapshot for the product grid, hubs, order status and bookings. It is
   injected by security.js behind the guard
       document.querySelector('script[src*="realtime"]')
   which is a SUBSTRING test. A file named sokoni-realtime.js loading first
   would therefore satisfy that guard and SILENTLY SUPPRESS realtime.js, taking
   the live product grid down with it. The name is load-bearing; do not rename
   this file to anything containing "realtime".

   ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
   This is NOT a sixth realtime system. The audit found the estate already has
   the pieces and they are mostly sound:

     287 onSnapshot listeners across 105 files   live state, per page
     functions/notify.js                          ONE backend sender
     sokoni-notif-engine.js                       prefs, queue, dedupe, grouping
     sokoni-notif-center.js                       the bell + drawer UI
     shared-header.js                             injects both, site-wide
     pos-session-manager.js                       posSessions/{id} + deviceId
     sokoni-sync.js                               localStorage <-> Firestore

   What was missing is the SEAM between them: a stable device identity outside
   POS, a place to register and tear down listeners, and one answer to "have we
   already shown this event?" that every channel agrees on. This file is that
   seam and nothing more. Where a capability already exists it is DELEGATED TO,
   never reimplemented.

   ── THE THREE LAYERS, KEPT APART ─────────────────────────────────────────
     1 AUTHORITATIVE STATE   Firestore. The source of truth
     2 SYNCHRONISATION       clients subscribe and converge WITHOUT a refresh
     3 NOTIFICATION          a signal that something changed

   A notification is NOT synchronisation. Showing a toast on the other phone
   while its list still holds stale rows is the failure this module exists to
   prevent: `subscribe()` converges state, and the notification is only the
   user's cue that it happened.

   ── RELEVANCE IS NOT IDENTITY ────────────────────────────────────────────
   Being the same signed-in uid does NOT make an event relevant to a device.
   Every subscription must carry its authorisation scope, and this module will
   REFUSE an unscoped subscription to a known tenant-scoped collection rather
   than let a page subscribe to a global one. Realtime does not mean broadcast.

   ── DEDUPLICATION ────────────────────────────────────────────────────────
   One sale can arrive as a Firestore snapshot, a service-worker message and a
   push. The user must see ONE notification. `seen()` delegates to
   SokoniNotifEngine's existing `sk_notif_seen` store so all channels consult
   the same record — a second store would just be a second opinion.

   Exposes: window.SokoniDeviceBus
   ══════════════════════════════════════════════════════════════════════════ */
(function (w) {
  'use strict';
  if (w.SokoniDeviceBus) return;

  var LS_DEVICE = 'sk_device_id';
  var CHANNEL   = 'sokoni-realtime';

  /* ── DEVICE vs SESSION ──────────────────────────────────────────────────
     device : stable across reloads and tabs on this browser/machine
     session: this tab, this load

     Both are needed. Without a device id, the same user on a phone and a
     laptop is indistinguishable and every write looks like it came from
     "them". Without a session id, two tabs on one machine cannot tell each
     other apart. Neither is an identity claim: authorisation still comes from
     auth.uid and the business/shop chain. These only answer "which screen". */
  /* MEMOISED. Without the in-memory cache, a browser with storage blocked
     (private mode, cleared site data, embedded webview) regenerates a NEW id
     on every call — so the same device reads as a different device several
     times within one page, and echo suppression breaks in exactly the
     conditions where it is hardest to debug. The cache makes the id stable
     for the load even when nothing can be persisted; persistence is an
     upgrade, not a precondition. */
  var _deviceId = null;
  var DEVICE_RE = /^dev_[a-z0-9]{4,}_[a-z0-9]{4,}$/;

  function _mintDeviceId () {
    return 'dev_' + Date.now().toString(36) + '_' +
           Math.random().toString(36).slice(2, 10);
  }

  function deviceId () {
    if (_deviceId) return _deviceId;
    var v = null;
    try { v = w.localStorage && w.localStorage.getItem(LS_DEVICE); } catch (e) { /* blocked */ }

    /* VALIDATE, do not trust. localStorage is writable by anything running on
       the origin and survives partial writes, so the stored value can come back
       as "", "undefined", "[object Object]" or arbitrary text. An unvalidated
       read would propagate that as a device identity — and because it is
       non-empty, the regenerate branch would never fire, so the corruption
       would be permanent for that browser. */
    if (typeof v !== 'string' || !DEVICE_RE.test(v)) {
      if (v) {
        /* Corrupt rather than absent: replace it, and say so. Silently
           overwriting would hide a storage problem worth knowing about. */
        try { w.console && w.console.warn &&
              w.console.warn('[device-bus] discarding malformed device id'); } catch (e) {}
      }
      v = _mintDeviceId();
      try { w.localStorage && w.localStorage.setItem(LS_DEVICE, v); } catch (e) {
        /* Storage blocked: the id lives for this load only. Echo suppression
           degrades across reloads; authorisation never depended on this. */
      }
    }
    _deviceId = v;
    return v;
  }

  var _sessionId = 'ses_' + Date.now().toString(36) + '_' +
                   Math.random().toString(36).slice(2, 8);

  /* ── SCOPED SUBSCRIPTION REGISTRY ───────────────────────────────────────
     A listener that is never torn down is a leak that also costs reads. Every
     subscription is registered under a scope, and leaving that scope detaches
     it. Duplicate keys are collapsed so two components asking for the same
     data share one listener rather than paying twice. */
  var _subs = Object.create(null);

  /* Collections that are tenant-scoped. Subscribing to one of these without a
     constraint would hand the client another merchant's rows, so it is
     refused rather than trimmed client-side — a client-side filter still
     TRANSFERS the data and still needs the read permission. */
  var TENANT_SCOPED = [
    'orders', 'products', 'payments', 'inventory', 'posSales', 'posPayments',
    'shopEmployees', 'deliveries', 'packageRequests', 'refundRequests',
    'notifications', 'conversations', 'messages', 'businesses', 'shops',
    'payouts', 'commissionLedger', 'posSessions',
  ];

  function subscribe (opts) {
    opts = opts || {};
    var key   = opts.key;
    var scope = opts.scope || 'global';
    var attach = opts.attach;

    if (!key)           throw new Error('SokoniDeviceBus.subscribe: key is required');
    if (typeof attach !== 'function')
      throw new Error('SokoniDeviceBus.subscribe: attach() is required');

    /* REFUSE, do not silently widen. An unscoped listener on a tenant
       collection is a data-leak vector, and the caller must say what scopes
       it — not be quietly given everything. */
    if (opts.collection && TENANT_SCOPED.indexOf(opts.collection) !== -1 && !opts.scopedBy) {
      throw new Error(
        'SokoniDeviceBus.subscribe: "' + opts.collection + '" is tenant-scoped. ' +
        'Pass scopedBy (e.g. sellerUid / businessId / shopId / participant uid). ' +
        'Refusing an unscoped subscription.');
    }

    if (_subs[key]) { _subs[key].refs++; return _subs[key].detach; }

    var off = attach();
    if (typeof off !== 'function') {
      /* A listener we cannot detach is worse than none: it outlives its page
         and keeps billing reads. Fail loudly at wire-up, not in production. */
      throw new Error('SokoniDeviceBus.subscribe: attach() must return an ' +
                      'unsubscribe function (got ' + typeof off + ')');
    }

    var rec = { key: key, scope: scope, refs: 1, off: off,
                collection: opts.collection || null, owner: opts.owner || null,
                scopedBy: opts.scopedBy || null,
                cardinality: opts.cardinality || null };
    rec.detach = function () {
      if (--rec.refs > 0) return;
      try { rec.off(); } catch (e) { /* already gone */ }
      delete _subs[key];
    };
    _subs[key] = rec;
    return rec.detach;
  }

  function release (scope) {
    Object.keys(_subs).forEach(function (k) {
      if (scope && _subs[k].scope !== scope) return;
      try { _subs[k].off(); } catch (e) { /* already gone */ }
      delete _subs[k];
    });
  }

  function active () {
    return Object.keys(_subs).map(function (k) {
      return { key: k, scope: _subs[k].scope, refs: _subs[k].refs };
    });
  }

  /* ── CROSS-CHANNEL DEDUPE ───────────────────────────────────────────────
     Delegates to the engine's existing store. A local fallback exists only
     for pages that load this file without the engine; it is deliberately the
     same key, so the two never disagree about what has been seen. */
  var LS_SEEN = 'sk_notif_seen';

  /* IN-MEMORY MIRROR. When storage is blocked, a purely localStorage-backed
     dedupe returns false every time — so the ONE case that most needs
     deduplication (a sale arriving as snapshot + SW message + push, within
     seconds) delivers three copies. The mirror keeps dedupe correct for the
     life of the page regardless of storage; persistence only extends it
     across reloads. */
  var _seenMem = Object.create(null);

  function seen (id) {
    if (!id) return false;
    if (_seenMem[id]) return true;
    var E = w.SokoniNotifEngine;
    if (E && E.Queue && typeof E.Queue.isDuplicate === 'function') {
      return !!E.Queue.isDuplicate(id);
    }
    try {
      var m = JSON.parse(w.localStorage.getItem(LS_SEEN) || '{}');
      return !!m[id];
    } catch (e) { return false; }
  }

  function markSeen (id) {
    if (!id) return;
    _seenMem[id] = Date.now();
    var E = w.SokoniNotifEngine;
    if (E && E.Queue && typeof E.Queue.markSeen === 'function') {
      E.Queue.markSeen(id); return;
    }
    try {
      var m = JSON.parse(w.localStorage.getItem(LS_SEEN) || '{}');
      m[id] = Date.now();
      w.localStorage.setItem(LS_SEEN, JSON.stringify(m));
    } catch (e) { /* storage blocked: the mirror above still holds the page */ }
  }

  /** True the FIRST time an id is presented, false every time after. */
  function claim (id) {
    if (!id) return true;          /* no id: cannot dedupe, so let it through */
    if (seen(id)) return false;
    markSeen(id);
    return true;
  }

  /* ── EVENT IDENTITY ─────────────────────────────────────────────────────
     The dedupe key must identify the EVENT, never the entity.

     Keying on an order id would collapse "order placed", "order paid" and
     "order delivered" into a single notification, because all three concern
     the same order — the user would be told once and then never again. Keying
     on nothing at all delivers the same transition four times, once per
     channel.

     eventKey() composes type + entity + a discriminator (a status, a version,
     a timestamp) so that the SAME transition arriving by four routes produces
     one key, and two DIFFERENT transitions on the same entity produce two. */
  function eventKey (e) {
    if (!e) return null;
    if (typeof e === 'string') return e;
    var type = e.type || e.kind || '';
    var ent  = e.entity || e.id || e.docId || '';
    var disc = e.at || e.version || e.status || e.updatedAt || '';
    if (!type && !ent) return null;
    /* A key with no discriminator can only ever fire once per entity. That is
       almost always a bug, so it is refused rather than silently swallowing
       every later transition. */
    if (!disc) {
      throw new Error('SokoniDeviceBus.eventKey: a discriminator (at/version/' +
        'status) is required — keying on "' + type + ':' + ent + '" alone would ' +
        'suppress every later event for the same entity.');
    }
    return String(type) + ':' + String(ent) + ':' + String(disc);
  }

  /** Present an event at most once, whichever channel delivers it first. */
  function notifyOnce (event, present) {
    var k = eventKey(event);
    if (!claim(k)) return false;
    if (typeof present === 'function') present();
    return true;
  }

  /* ── SAME-DEVICE TAB FAN-OUT ────────────────────────────────────────────
     Two tabs on one machine should not each run a full listener set for the
     same cheap signal. BroadcastChannel is same-origin and same-device only —
     it is NOT a substitute for Firestore across devices, and is used only to
     keep sibling tabs consistent. */
  var _bc = null;
  try { if (w.BroadcastChannel) _bc = new w.BroadcastChannel(CHANNEL); } catch (e) { _bc = null; }

  function broadcast (type, payload) {
    if (!_bc) return false;
    try {
      _bc.postMessage({ type: type, payload: payload,
                        from: _sessionId, device: deviceId(), at: Date.now() });
      return true;
    } catch (e) { return false; }
  }

  var _handlers = Object.create(null);
  function on (type, fn) {
    (_handlers[type] = _handlers[type] || []).push(fn);
    return function () {
      _handlers[type] = (_handlers[type] || []).filter(function (f) { return f !== fn; });
    };
  }
  if (_bc) {
    _bc.onmessage = function (ev) {
      var d = ev && ev.data;
      if (!d || d.from === _sessionId) return;   /* never echo to ourselves */
      (_handlers[d.type] || []).forEach(function (fn) {
        try { fn(d.payload, d); } catch (e) { /* one bad handler must not stop the rest */ }
      });
    };
  }

  /* ── RECONNECT ──────────────────────────────────────────────────────────
     A device that was offline missed the transient events entirely. It must
     NOT try to replay them — it re-reads authoritative state, which is what
     onSnapshot already does on reattach. This hook exists so pages that also
     hold derived state can recompute it. Notifications are deduped separately
     by id, so reconciling state cannot double-notify. */
  function onReconnect (fn) {
    var h = function () { if (w.navigator.onLine) { try { fn(); } catch (e) {} } };
    w.addEventListener('online', h);
    return function () { w.removeEventListener('online', h); };
  }

  /* Leaving the page detaches everything. Without this, a SPA-style shell that
     swaps panels accumulates listeners for the life of the tab. */
  w.addEventListener('pagehide', function () { release(); });

  /* ── LISTENER LEDGER ────────────────────────────────────────────────────
     Every subscription records what it watches, who owns it, what scopes it
     and when it is torn down. Without this, "does this page already listen to
     orders?" is unanswerable except by reading 105 files, and the honest
     answer to a performance question becomes a guess. `inventory()` is the
     read-out. */
  function inventory () {
    return Object.keys(_subs).map(function (k) {
      var r = _subs[k];
      return {
        key: k,
        collection: r.collection || '(unrecorded)',
        owner: r.owner || '(unrecorded)',
        scope: r.scope,
        scopedBy: r.scopedBy || null,
        refs: r.refs,
        cardinality: r.cardinality || 'unbounded?',
        lifecycle: 'released on pagehide or release("' + r.scope + '")',
        coveredByExisting: r.refs > 1,
      };
    });
  }

  w.SokoniDeviceBus = {
    deviceId: deviceId,
    sessionId: function () { return _sessionId; },
    subscribe: subscribe,
    release: release,
    active: active,
    inventory: inventory,
    eventKey: eventKey,
    notifyOnce: notifyOnce,
    seen: seen,
    markSeen: markSeen,
    claim: claim,
    broadcast: broadcast,
    on: on,
    onReconnect: onReconnect,
    TENANT_SCOPED: TENANT_SCOPED,
  };
})(window);
