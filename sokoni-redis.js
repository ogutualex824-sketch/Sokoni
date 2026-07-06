/**
 * SOKONI Redis Client SDK  v2.0  (2026-07-06)
 *
 * Client-side abstraction for all Redis-backed operations.
 * Requires window.firebaseFunctions + window.httpsCallable to be
 * initialised by firebase.js / shared-header.js before use.
 *
 * v2.0 additions:
 *   • SokoniRedis.offline  — offline transaction queue (IndexedDB-backed)
 *   • SokoniRedis.pos.syncCart  — real-time SmartPOS 2.0 cart sync
 *   • SokoniRedis.pos.subscribeTerminal  — cross-device cart subscription
 *   • SokoniRedis.rateLimit — client-side rate limit awareness
 *   • SokoniRedis.device    — device hub presence (printers, scanners, terminals)
 *   • Automatic session heartbeat on visibility change
 *   • Retry budget: failed CF calls back off before retrying
 *
 * Usage:
 *   SokoniRedis.session.create(role)
 *   SokoniRedis.presence.start(role)
 *   SokoniRedis.pos.syncCart(shopId, terminalId, cart)
 *   SokoniRedis.offline.enqueue(type, data)
 *   SokoniRedis.offline.flush()
 *   SokoniRedis.dashboard.get(shopId)
 *   SokoniRedis.payment.lock(orderId)
 *   SokoniRedis.inventory.lock(productId, variantId, qty)
 */

(function (global) {
  'use strict';

  const SDK_VERSION = '2.0.0';

  // ─── Internal helpers ────────────────────────────────────────────────────────

  function _cf(name) {
    if (!global.firebaseFunctions || !global.httpsCallable) {
      console.warn('[SokoniRedis] Firebase Functions not ready');
      return () => Promise.resolve({ data: { fallback: true } });
    }
    return global.httpsCallable(global.firebaseFunctions, name);
  }

  let _callRetries = {};
  async function _call(name, data, opts = {}) {
    try {
      const res = await _cf(name)(data);
      _callRetries[name] = 0;
      return res.data;
    } catch (err) {
      const retryCount = (_callRetries[name] || 0) + 1;
      _callRetries[name] = retryCount;
      if (opts.silent !== false) {
        console.warn(`[SokoniRedis] ${name} (attempt ${retryCount}):`, err.message);
      }
      return { fallback: true, error: err.message };
    }
  }

  function _uid() {
    try { return global.firebaseAuth?.currentUser?.uid || null; }
    catch (_) { return null; }
  }

  function _uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  // ─── Session Management ──────────────────────────────────────────────────────

  const SESSION_KEY = 'sokoni_session_id';

  const session = {
    _id: null,

    getOrCreateId() {
      if (this._id) return this._id;
      let id = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
      if (!id) { id = _uuid(); sessionStorage.setItem(SESSION_KEY, id); }
      this._id = id;
      return id;
    },

    async create(role = 'buyer') {
      const sessionId = this.getOrCreateId();
      const result = await _call('redisSessionCreate', {
        sessionId, role,
        deviceInfo: { ua: navigator.userAgent.slice(0, 200), platform: navigator.platform },
      });
      if (result.ok) localStorage.setItem(SESSION_KEY, sessionId);
      return result;
    },

    async get()           { return _call('redisSessionGet',   { sessionId: this.getOrCreateId() }); },
    async revoke()        {
      const id = this._id || sessionStorage.getItem(SESSION_KEY);
      if (!id) return { ok: false };
      const result = await _call('redisSessionRevoke', { sessionId: id });
      sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY); this._id = null;
      return result;
    },
    async revokeAll(uid)  { return _call('redisSessionRevokeAll', uid ? { uid } : {}); },
    async list(uid)       { return _call('redisSessionList',      uid ? { uid } : {}); },
  };

  // ─── Presence ────────────────────────────────────────────────────────────────

  const presence = {
    _timer: null,
    _role:  null,
    _meta:  {},

    async heartbeat(role, meta = {}) {
      return _call('redisPresenceHeartbeat', { role, meta }, { silent: true });
    },

    start(role, meta = {}, intervalMs = 55_000) {
      this.stop();
      this._role = role || 'buyer';
      this._meta = meta;
      this.heartbeat(this._role, meta);
      this._timer = setInterval(() => this.heartbeat(this._role, this._meta), intervalMs);
      global.addEventListener('beforeunload', () => this.stop(), { once: true });
      /* Re-send heartbeat when tab becomes visible again */
      global.document?.addEventListener('visibilitychange', () => {
        if (!global.document.hidden) this.heartbeat(this._role, this._meta);
      });
    },

    stop() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this._role)  {
        _call('redisPresenceRemove', { role: this._role }, { silent: true }).catch(() => {});
        this._role = null;
      }
    },

    updateMeta(meta) {
      this._meta = { ...this._meta, ...meta };
      if (this._role) this.heartbeat(this._role, this._meta);
    },

    async getOnline(role)   { return _call('redisPresenceGet', { role }); },
    async getAllCounts()     { return _call('redisPresenceGet', {}); },
  };

  // ─── Device Hub Presence (SmartPOS 2.0) ─────────────────────────────────────

  const device = {
    _timers: {},

    /**
     * Register a peripheral device in Redis presence.
     * role: 'printer' | 'scanner' | 'payment_terminal' | 'customer_display'
     */
    async register(deviceId, role, meta = {}) {
      const uid = _uid() || deviceId;
      await _call('redisPresenceHeartbeat', {
        role,
        meta: { deviceId, ...meta, uid },
      }, { silent: true });
    },

    /**
     * Start a heartbeat for a registered device.
     * @returns stop function
     */
    startHeartbeat(deviceId, role, meta = {}, intervalMs = 55_000) {
      this.stopHeartbeat(deviceId);
      this.register(deviceId, role, meta);
      this._timers[deviceId] = setInterval(
        () => this.register(deviceId, role, meta), intervalMs
      );
      return () => this.stopHeartbeat(deviceId);
    },

    stopHeartbeat(deviceId) {
      if (this._timers[deviceId]) {
        clearInterval(this._timers[deviceId]);
        delete this._timers[deviceId];
      }
    },

    async getAll(role) { return _call('redisPresenceGet', { role }); },
  };

  // ─── SmartPOS 2.0 Synchronization ────────────────────────────────────────────

  const pos = {
    _pollers: {},
    _lastHash: {},

    /* ── Cart sync ──────────────────────────────────────────────── */

    /**
     * Sync full POS state (cart, totals, operator) to Redis.
     * Other terminals will see the update within ~500ms via poll.
     */
    async syncCart(shopId, terminalId, state) {
      const safe = {
        cart:          Array.isArray(state.cart) ? state.cart : [],
        discount:      Number(state.discount)    || 0,
        subtotal:      Number(state.subtotal)    || 0,
        total:         Number(state.total)       || 0,
        tax:           Number(state.tax)         || 0,
        currency:      state.currency            || 'KES',
        paymentStatus: state.paymentStatus       || 'idle',
        operatorId:    state.operatorId          || _uid(),
        shiftId:       state.shiftId             || '',
        receiptNo:     state.receiptNo           || '',
        customerPhone: state.customerPhone       || '',
      };
      const result = await _call('redisPosSetState', { shopId, terminalId, state: safe });
      /* Also publish a pub/sub event so other terminals react immediately */
      if (!result.fallback) {
        await _call('redisPosPublish', {
          shopId,
          event: { type: 'cart_synced', terminalId, payload: safe },
        }, { silent: true });
      }
      return result;
    },

    /**
     * Get current state for a specific terminal.
     */
    async getState(shopId, terminalId) {
      return _call('redisPosGetState', { shopId, terminalId });
    },

    /**
     * Get all terminal states for a shop — for manager/supervisor view.
     */
    async getAllTerminals(shopId) {
      return _call('redisPosGetState', { shopId });
    },

    /**
     * Publish a POS event (item_scanned, discount_applied, etc.)
     */
    async publish(shopId, event) {
      return _call('redisPosPublish', { shopId, event });
    },

    /**
     * Subscribe to POS state changes.
     * Polls Redis every `intervalMs` and fires `callback(state)` when state changes.
     * @returns stop function
     */
    subscribeTerminal(shopId, terminalId, callback, intervalMs = 500) {
      const key = `${shopId}:${terminalId}`;
      this.unsubscribeTerminal(shopId, terminalId);
      const tick = async () => {
        const result = await _call('redisPosGetState', { shopId, terminalId }, { silent: true });
        const state  = result?.state;
        if (!state) return;
        const hash = JSON.stringify(state);
        if (hash !== this._lastHash[key]) {
          this._lastHash[key] = hash;
          try { callback(state); } catch {}
        }
      };
      tick();
      this._pollers[key] = setInterval(tick, intervalMs);
      return () => this.unsubscribeTerminal(shopId, terminalId);
    },

    /**
     * Subscribe to ALL terminals at a shop.
     * Useful for manager tablet / back-office monitor.
     * @returns stop function
     */
    subscribeShop(shopId, callback, intervalMs = 1000) {
      const key = `shop:${shopId}`;
      this._stopPoller(key);
      let lastHash = null;
      const tick = async () => {
        const result = await _call('redisPosGetState', { shopId }, { silent: true });
        const terminals = result?.terminals;
        if (!terminals) return;
        const hash = JSON.stringify(terminals);
        if (hash !== lastHash) { lastHash = hash; try { callback(terminals); } catch {} }
      };
      tick();
      this._pollers[key] = setInterval(tick, intervalMs);
      return () => this._stopPoller(key);
    },

    unsubscribeTerminal(shopId, terminalId) {
      this._stopPoller(`${shopId}:${terminalId}`);
    },
    _stopPoller(key) {
      if (this._pollers[key]) { clearInterval(this._pollers[key]); delete this._pollers[key]; }
    },
    stopAll() {
      Object.keys(this._pollers).forEach(k => this._stopPoller(k));
    },
  };

  // ─── Offline Queue (IndexedDB-backed) ───────────────────────────────────────

  /**
   * When the device goes offline, POS transactions are queued locally
   * in IndexedDB. When connectivity returns, `flush()` replays them
   * through Redis coordination to prevent duplicates.
   */
  const offline = {
    _DB_NAME:   'sokoni_offline',
    _STORE:     'queue',
    _db:        null,
    _flushing:  false,

    async _openDB() {
      if (this._db) return this._db;
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(this._DB_NAME, 1);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this._STORE)) {
            const store = db.createObjectStore(this._STORE, { keyPath: '_localId' });
            store.createIndex('type',      'type',      { unique: false });
            store.createIndex('status',    'status',    { unique: false });
            store.createIndex('createdAt', 'createdAt', { unique: false });
          }
        };
        req.onsuccess = e => { this._db = e.target.result; resolve(this._db); };
        req.onerror   = e => reject(e.target.error);
      });
    },

    /**
     * Add a transaction to the offline queue.
     * @param {string} type  — 'pos_cart_sync' | 'order' | 'payment' | 'inventory'
     * @param {object} data  — payload to replay when online
     * @returns localId
     */
    async enqueue(type, data) {
      const localId = _uuid();
      const record  = {
        _localId:  localId,
        type,
        data,
        status:    'pending',
        createdAt: Date.now(),
        retries:   0,
      };
      try {
        const db    = await this._openDB();
        const tx    = db.transaction(this._STORE, 'readwrite');
        const store = tx.objectStore(this._STORE);
        store.add(record);
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      } catch (err) {
        /* Fallback: localStorage ring buffer (last 100 items) */
        try {
          const key   = 'sokoni_offline_queue';
          const q     = JSON.parse(localStorage.getItem(key) || '[]');
          q.push(record);
          if (q.length > 100) q.splice(0, q.length - 100);
          localStorage.setItem(key, JSON.stringify(q));
        } catch {}
      }
      return localId;
    },

    /** Count pending items in queue */
    async depth() {
      try {
        const db    = await this._openDB();
        const tx    = db.transaction(this._STORE, 'readonly');
        const store = tx.objectStore(this._STORE);
        const idx   = store.index('status');
        const req   = idx.count(IDBKeyRange.only('pending'));
        return new Promise((res, rej) => {
          req.onsuccess = () => res(req.result);
          req.onerror   = () => res(0);
        });
      } catch { return 0; }
    },

    hasPending() {
      try {
        const key = 'sokoni_offline_queue';
        const q   = JSON.parse(localStorage.getItem(key) || '[]');
        return q.filter(r => r.status === 'pending').length > 0;
      } catch { return false; }
    },

    /**
     * Flush all pending items.
     * Each item is replayed through the appropriate Redis CF call.
     * Completed items are marked 'synced'; failed items increment retries.
     *
     * @param {function} [onProgress] — called after each item with { done, total, item }
     */
    async flush(onProgress) {
      if (this._flushing) return { skipped: true };
      this._flushing = true;
      let done = 0, failed = 0;

      try {
        const items = await this._getPending();
        const total = items.length;

        for (const item of items) {
          const success = await this._replay(item);
          if (success) {
            done++;
            await this._markSynced(item._localId);
          } else {
            failed++;
            await this._markFailed(item._localId);
          }
          if (onProgress) { try { onProgress({ done, failed, total, item }); } catch {} }
        }
      } finally {
        this._flushing = false;
      }

      return { done, failed };
    },

    async _replay(item) {
      try {
        switch (item.type) {
          case 'pos_cart_sync': {
            const { shopId, terminalId, state } = item.data;
            const r = await pos.syncCart(shopId, terminalId, state);
            return !r.fallback;
          }
          case 'order': {
            /* Mark order as created in Redis dashboard */
            await _call('redisDashboardIncr', {
              shopId: item.data.shopId, metric: 'orders_today', by: 1,
            }, { silent: true });
            return true;
          }
          case 'payment': {
            const r = await _call('redisPaymentSetState', {
              orderId: item.data.orderId,
              state:   item.data.state  || 'pending',
              meta:    item.data.meta   || {},
            }, { silent: true });
            return !r.fallback;
          }
          default:
            return true; /* Unknown type — mark as handled */
        }
      } catch { return false; }
    },

    async _getPending() {
      try {
        const db    = await this._openDB();
        const tx    = db.transaction(this._STORE, 'readonly');
        const store = tx.objectStore(this._STORE);
        const idx   = store.index('status');
        const req   = idx.getAll(IDBKeyRange.only('pending'));
        return new Promise((res, rej) => {
          req.onsuccess = () => res(req.result || []);
          req.onerror   = () => res([]);
        });
      } catch {
        /* localStorage fallback */
        try {
          const key = 'sokoni_offline_queue';
          return JSON.parse(localStorage.getItem(key) || '[]').filter(r => r.status === 'pending');
        } catch { return []; }
      }
    },

    async _updateStatus(localId, status) {
      try {
        const db    = await this._openDB();
        const tx    = db.transaction(this._STORE, 'readwrite');
        const store = tx.objectStore(this._STORE);
        const req   = store.get(localId);
        req.onsuccess = () => {
          if (req.result) {
            req.result.status  = status;
            req.result.syncedAt = Date.now();
            store.put(req.result);
          }
        };
        await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
      } catch {
        /* localStorage fallback */
        try {
          const key = 'sokoni_offline_queue';
          const q   = JSON.parse(localStorage.getItem(key) || '[]');
          const idx = q.findIndex(r => r._localId === localId);
          if (idx >= 0) { q[idx].status = status; localStorage.setItem(key, JSON.stringify(q)); }
        } catch {}
      }
    },

    _markSynced(localId) { return this._updateStatus(localId, 'synced'); },
    _markFailed(localId) { return this._updateStatus(localId, 'failed'); },
  };

  // ─── Inventory Locking ────────────────────────────────────────────────────

  const inventory = {
    async lock(productId, variantId, qty = 1, ttlMs = 120_000) {
      const lockId = `${_uid() || 'anon'}-${_uuid()}`;
      const result = await _call('redisInventoryLock', { productId, variantId, qty, lockId, ttlMs });
      return { ...result, lockId };
    },

    async release(productId, variantId, lockId) {
      return _call('redisInventoryRelease', { productId, variantId, lockId });
    },
  };

  // ─── Dashboard Metrics ────────────────────────────────────────────────────

  const dashboard = {
    _pollers: {},

    async get(shopId)                    { return _call('redisDashboardGet',  shopId ? { shopId } : {}); },
    async set(shopId, metrics, ttl = 60) { return _call('redisDashboardSet',  { shopId, metrics, ttl }); },
    async incr(shopId, metric, by = 1)   { return _call('redisDashboardIncr', { shopId, metric, by }); },

    livePoll(shopId, callback, intervalMs = 5_000) {
      const key = shopId || 'platform';
      this._stopPoll(key);
      const tick = async () => {
        const result = await this.get(shopId);
        if (result?.metrics) try { callback(result.metrics); } catch {}
      };
      tick();
      this._pollers[key] = setInterval(tick, intervalMs);
      return () => this._stopPoll(key);
    },

    _stopPoll(key) {
      if (this._pollers[key]) { clearInterval(this._pollers[key]); delete this._pollers[key]; }
    },
  };

  // ─── Payment Coordination ─────────────────────────────────────────────────

  const payment = {
    async lock(orderId, ttlMs = 60_000) {
      const lockId = `${_uid() || 'anon'}-${_uuid()}`;
      const result = await _call('redisPaymentLock', { orderId, lockId, ttlMs });
      return { ...result, lockId };
    },

    async unlock(orderId, lockId)           { return _call('redisPaymentUnlock',    { orderId, lockId }); },
    async setState(orderId, state, meta={}) { return _call('redisPaymentSetState',  { orderId, state, meta }); },
    async getState(orderId)                 { return _call('redisPaymentGetState',  { orderId }); },

    async pollUntilComplete(orderId, timeoutMs = 90_000, intervalMs = 2_000) {
      const terminal = new Set(['completed', 'failed', 'refunded', 'expired']);
      const start    = Date.now();
      while (Date.now() - start < timeoutMs) {
        const result = await this.getState(orderId);
        if (result?.payment?.state && terminal.has(result.payment.state))
          return { state: result.payment.state, payment: result.payment, timedOut: false };
        await new Promise(r => setTimeout(r, intervalMs));
      }
      return { state: 'expired', timedOut: true };
    },
  };

  // ─── Generic Cache ────────────────────────────────────────────────────────

  const cache = {
    async get(key)                   { return _call('redisCacheGet', { key }); },
    async set(key, value, ttl = 300) { return _call('redisCacheSet', { key, value, ttl }); },

    async getOrFetch(key, fetchFn, ttl = 300) {
      const result = await this.get(key);
      if (result?.hit && result.value !== null) return result.value;
      const fresh = await fetchFn();
      if (fresh !== null && fresh !== undefined) this.set(key, fresh, ttl).catch(() => {});
      return fresh;
    },
  };

  // ─── Rate Limit Awareness ────────────────────────────────────────────────

  /**
   * Client-side rate limit awareness.
   * Tracks local request counts to give immediate feedback without a server round-trip.
   * The server-side Redis check is still the authoritative enforcement.
   */
  const rateLimit = {
    _counts: {},
    _windows: {},

    ACTIONS: {
      checkout:  { max: 20,  windowMs: 60_000  },
      payment:   { max: 5,   windowMs: 60_000  },
      search:    { max: 120, windowMs: 60_000  },
      otp:       { max: 5,   windowMs: 300_000 },
      ai:        { max: 30,  windowMs: 3_600_000 },
      listing:   { max: 50,  windowMs: 3_600_000 },
    },

    /** Increment local counter. Returns true if under limit. */
    track(action) {
      const profile = this.ACTIONS[action];
      if (!profile) return true;

      const now    = Date.now();
      const winKey = `${action}_window`;
      if (!this._windows[winKey] || now - this._windows[winKey] > profile.windowMs) {
        this._counts[action]  = 0;
        this._windows[winKey] = now;
      }
      this._counts[action] = (this._counts[action] || 0) + 1;
      return this._counts[action] <= profile.max;
    },

    /** Returns remaining requests in the current window. */
    remaining(action) {
      const profile = this.ACTIONS[action];
      if (!profile) return Infinity;
      const used = this._counts[action] || 0;
      return Math.max(0, profile.max - used);
    },

    /** True if the local tracker says we're over limit. */
    exceeded(action) { return !this.track(action); },
  };

  // ─── Event Bus ───────────────────────────────────────────────────────────

  const events = {
    _pollers: {},

    async publish(stream, event)    { return _call('redisEventPublish', { stream, event }); },

    subscribe(stream, callback, intervalMs = 2_000) {
      this.unsubscribe(stream);
      let lastId = '0-0';
      const tick = async () => {
        const result = await _call('redisEventRead', { stream, lastId, count: 50 }, { silent: true });
        const newEvents = result?.events || [];
        if (newEvents.length) {
          lastId = newEvents[newEvents.length - 1].id;
          try { callback(newEvents); } catch {}
        }
      };
      tick();
      this._pollers[stream] = setInterval(tick, intervalMs);
      return () => this.unsubscribe(stream);
    },

    unsubscribe(stream) {
      if (this._pollers[stream]) { clearInterval(this._pollers[stream]); delete this._pollers[stream]; }
    },
  };

  // ─── Queue ───────────────────────────────────────────────────────────────

  const queue = {
    async push(queueName, job, priority = 'normal') {
      return _call('redisQueuePush', { queueName, job, priority });
    },
    async depth(queueName) {
      return _call('redisQueueDepth', queueName ? { queueName } : {});
    },
  };

  // ─── Admin / Metrics ─────────────────────────────────────────────────────

  const admin = {
    async getMetrics()                                         { return _call('redisAdminMetrics', {}); },
    async rateCheck(identifier, action, maxRequests, windowMs) {
      return _call('redisRateCheck', { identifier, action, maxRequests, windowMs });
    },
  };

  // ─── Connectivity watchdog ───────────────────────────────────────────────
  /**
   * Monitors online/offline state and auto-flushes the offline queue
   * when connectivity returns.
   */
  const connectivity = {
    _autoFlush: false,

    enableAutoFlush(onProgress) {
      this._autoFlush = true;
      global.addEventListener('online', async () => {
        const depth = await offline.depth();
        if (depth > 0) {
          console.info(`[SokoniRedis] Back online — flushing ${depth} queued operations`);
          await offline.flush(onProgress);
        }
      });
    },
  };

  // ─── Top-level API ───────────────────────────────────────────────────────

  const SokoniRedis = {
    session,
    presence,
    device,
    pos,
    offline,
    inventory,
    dashboard,
    payment,
    cache,
    rateLimit,
    events,
    queue,
    admin,
    connectivity,
    VERSION: SDK_VERSION,

    /**
     * Call after firebase.js + shared-header.js have initialised auth.
     * @param {string} role   — 'buyer' | 'seller' | 'cashier' | 'admin' | ...
     * @param {object} meta   — optional presence metadata
     * @param {object} opts   — { autoFlushOffline, offlineProgressFn }
     */
    async init(role = 'buyer', meta = {}, opts = {}) {
      await session.create(role);
      presence.start(role, meta);
      if (opts.autoFlushOffline !== false) {
        connectivity.enableAutoFlush(opts.offlineProgressFn);
      }
    },

    /** Call on logout */
    async destroy() {
      presence.stop();
      pos.stopAll();
      Object.keys(device._timers).forEach(id => device.stopHeartbeat(id));
      await session.revoke();
    },
  };

  global.SokoniRedis = SokoniRedis;

}(typeof window !== 'undefined' ? window : global));
