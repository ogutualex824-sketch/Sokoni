/**
 * SOKONI Redis Client SDK
 * Client-side abstraction for all Redis-backed operations.
 * Requires window.firebaseFunctions + window.httpsCallable to be initialised
 * by firebase.js / shared-header.js before use.
 *
 * Usage:
 *   SokoniRedis.session.create(role)
 *   SokoniRedis.presence.start(role)
 *   SokoniRedis.pos.poll(shopId, terminalId, cb)
 *   SokoniRedis.dashboard.get(shopId)
 *   SokoniRedis.payment.lock(orderId)
 *   SokoniRedis.inventory.lock(productId, variantId, qty)
 */

(function (global) {
  'use strict';

  // ─── Internal helpers ────────────────────────────────────────────────────────

  function _cf(name) {
    if (!global.firebaseFunctions || !global.httpsCallable) {
      console.warn('[SokoniRedis] Firebase Functions not ready');
      return () => Promise.resolve({ data: { fallback: true } });
    }
    return global.httpsCallable(global.firebaseFunctions, name);
  }

  function _call(name, data) {
    return _cf(name)(data).then(r => r.data).catch(err => {
      console.warn(`[SokoniRedis] ${name} error:`, err.message);
      return { fallback: true, error: err.message };
    });
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
      if (!id) {
        id = _uuid();
        sessionStorage.setItem(SESSION_KEY, id);
      }
      this._id = id;
      return id;
    },

    async create(role = 'buyer') {
      const sessionId = this.getOrCreateId();
      const result = await _call('redisSessionCreate', {
        sessionId,
        role,
        deviceInfo: {
          ua: navigator.userAgent.slice(0, 200),
          platform: navigator.platform,
        },
      });
      if (result.ok) localStorage.setItem(SESSION_KEY, sessionId);
      return result;
    },

    async get() {
      const sessionId = this.getOrCreateId();
      return _call('redisSessionGet', { sessionId });
    },

    async revoke() {
      const sessionId = this._id || sessionStorage.getItem(SESSION_KEY);
      if (!sessionId) return { ok: false };
      const result = await _call('redisSessionRevoke', { sessionId });
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_KEY);
      this._id = null;
      return result;
    },

    async revokeAll(uid) {
      return _call('redisSessionRevokeAll', uid ? { uid } : {});
    },

    async list(uid) {
      return _call('redisSessionList', uid ? { uid } : {});
    },
  };

  // ─── Presence ────────────────────────────────────────────────────────────────

  const presence = {
    _timer: null,
    _role: null,

    async heartbeat(role, meta = {}) {
      return _call('redisPresenceHeartbeat', { role, meta });
    },

    start(role, meta = {}, intervalMs = 60000) {
      this.stop();
      this._role = role || 'buyer';
      this.heartbeat(this._role, meta);
      this._timer = setInterval(() => this.heartbeat(this._role, meta), intervalMs);
      // Remove on page unload
      global.addEventListener('beforeunload', () => this.stop());
    },

    stop() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this._role) {
        _call('redisPresenceRemove', { role: this._role }).catch(() => {});
        this._role = null;
      }
    },

    async getOnline(role) {
      return _call('redisPresenceGet', { role });
    },

    async getAllCounts() {
      return _call('redisPresenceGet', {});
    },
  };

  // ─── SmartPOS Synchronization ─────────────────────────────────────────────

  const pos = {
    _pollers: {},

    async setState(shopId, terminalId, state) {
      return _call('redisPosSetState', { shopId, terminalId, state });
    },

    async getState(shopId, terminalId) {
      return _call('redisPosGetState', { shopId, terminalId });
    },

    async getAllTerminals(shopId) {
      return _call('redisPosGetState', { shopId });
    },

    async publish(shopId, event) {
      return _call('redisPosPublish', { shopId, event });
    },

    /**
     * Poll for POS state changes at `intervalMs` (default 500ms).
     * Calls `callback(state)` whenever state changes.
     * Returns a stop function.
     */
    poll(shopId, terminalId, callback, intervalMs = 500) {
      const key = `${shopId}:${terminalId}`;
      this.stopPoll(key);
      let last = null;
      const tick = async () => {
        const result = await _call('redisPosGetState', { shopId, terminalId });
        const state = result?.state;
        if (state && JSON.stringify(state) !== last) {
          last = JSON.stringify(state);
          callback(state);
        }
      };
      tick();
      this._pollers[key] = setInterval(tick, intervalMs);
      return () => this.stopPoll(key);
    },

    stopPoll(key) {
      if (this._pollers[key]) { clearInterval(this._pollers[key]); delete this._pollers[key]; }
    },

    stopAll() {
      Object.keys(this._pollers).forEach(k => this.stopPoll(k));
    },
  };

  // ─── Inventory Locking ────────────────────────────────────────────────────

  const inventory = {
    async lock(productId, variantId, qty = 1, ttlMs = 120000) {
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

    async get(shopId) {
      return _call('redisDashboardGet', shopId ? { shopId } : {});
    },

    async set(shopId, metrics, ttl = 60) {
      return _call('redisDashboardSet', { shopId, metrics, ttl });
    },

    async incr(shopId, metric, by = 1) {
      return _call('redisDashboardIncr', { shopId, metric, by });
    },

    /**
     * Live-poll dashboard metrics. Calls `callback(metrics)` on every update.
     * Returns a stop function.
     */
    livePoll(shopId, callback, intervalMs = 5000) {
      const key = shopId || 'platform';
      this.stopPoll(key);
      const tick = async () => {
        const result = await this.get(shopId);
        if (result?.metrics) callback(result.metrics);
      };
      tick();
      this._pollers[key] = setInterval(tick, intervalMs);
      return () => this.stopPoll(key);
    },

    stopPoll(key) {
      if (this._pollers[key]) { clearInterval(this._pollers[key]); delete this._pollers[key]; }
    },
  };

  // ─── Payment Coordination ─────────────────────────────────────────────────

  const payment = {
    async lock(orderId, ttlMs = 60000) {
      const lockId = `${_uid() || 'anon'}-${_uuid()}`;
      const result = await _call('redisPaymentLock', { orderId, lockId, ttlMs });
      return { ...result, lockId };
    },

    async unlock(orderId, lockId) {
      return _call('redisPaymentUnlock', { orderId, lockId });
    },

    async setState(orderId, state, meta = {}) {
      return _call('redisPaymentSetState', { orderId, state, meta });
    },

    async getState(orderId) {
      return _call('redisPaymentGetState', { orderId });
    },

    /**
     * Poll until payment reaches a terminal state or timeout.
     * @returns {Promise<{state, timedOut}>}
     */
    async pollUntilComplete(orderId, timeoutMs = 90000, intervalMs = 2000) {
      const terminal = new Set(['completed', 'failed', 'refunded', 'expired']);
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const result = await this.getState(orderId);
        if (result?.payment?.state && terminal.has(result.payment.state)) {
          return { state: result.payment.state, payment: result.payment, timedOut: false };
        }
        await new Promise(r => setTimeout(r, intervalMs));
      }
      return { state: 'expired', timedOut: true };
    },
  };

  // ─── Generic Cache ────────────────────────────────────────────────────────

  const cache = {
    async get(key) {
      return _call('redisCacheGet', { key });
    },

    async set(key, value, ttl = 300) {
      return _call('redisCacheSet', { key, value, ttl });
    },

    async getOrFetch(key, fetchFn, ttl = 300) {
      const result = await this.get(key);
      if (result?.hit && result.value !== null) return result.value;
      const fresh = await fetchFn();
      if (fresh !== null && fresh !== undefined) this.set(key, fresh, ttl).catch(() => {});
      return fresh;
    },
  };

  // ─── Event Bus ───────────────────────────────────────────────────────────

  const events = {
    _pollers: {},

    async publish(stream, event) {
      return _call('redisEventPublish', { stream, event });
    },

    /**
     * Poll a stream for new events. Calls `callback(events[])` on new events.
     * Returns a stop function.
     */
    subscribe(stream, callback, intervalMs = 2000) {
      this.unsubscribe(stream);
      let lastId = '0-0';
      const tick = async () => {
        const result = await _call('redisEventRead', { stream, lastId, count: 50 });
        const newEvents = result?.events || [];
        if (newEvents.length) {
          lastId = newEvents[newEvents.length - 1].id;
          callback(newEvents);
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
    async getMetrics() {
      return _call('redisAdminMetrics', {});
    },

    async rateCheck(identifier, action, maxRequests, windowMs) {
      return _call('redisRateCheck', { identifier, action, maxRequests, windowMs });
    },
  };

  // ─── Export ──────────────────────────────────────────────────────────────

  global.SokoniRedis = {
    session,
    presence,
    pos,
    inventory,
    dashboard,
    payment,
    cache,
    events,
    queue,
    admin,

    /** Call after firebase.js + shared-header.js have initialised auth */
    async init(role = 'buyer', meta = {}) {
      await session.create(role);
      presence.start(role, meta);
    },

    /** Call on logout */
    async destroy() {
      presence.stop();
      pos.stopAll();
      await session.revoke();
    },
  };

}(typeof window !== 'undefined' ? window : global));
