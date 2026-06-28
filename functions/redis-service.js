'use strict';
/**
 * SOKONI Redis Service Layer
 * Core Redis client abstraction with automatic fallback to Firestore.
 * All methods return safe defaults on Redis unavailability — no errors bubble up.
 *
 * Key namespace: sokoni:{domain}:{...parts}
 * Client: ioredis (lazy-connected, TLS-aware)
 */

const { defineSecret } = require('firebase-functions/params');
const REDIS_URL = defineSecret('REDIS_URL');

let _client = null;
let _fallback = false;
let _lastError = null;

// ─── Client management ────────────────────────────────────────────────────────

function _getClient() {
  if (_fallback) return null;
  if (_client && _client.status === 'ready') return _client;

  const url = REDIS_URL.value();
  if (!url) { _fallback = true; return null; }

  const Redis = require('ioredis');

  _client = new Redis(url, {
    tls: url.startsWith('rediss://') ? { rejectUnauthorized: true } : undefined,
    lazyConnect: true,
    connectTimeout: 5000,
    commandTimeout: 3000,
    maxRetriesPerRequest: 2,
    retryStrategy(times) {
      if (times > 5) { _fallback = true; return null; }
      return Math.min(times * 300, 3000);
    },
    reconnectOnError(err) {
      return err.message.includes('READONLY');
    },
  });

  _client.on('error', (err) => {
    _lastError = err.message;
    console.error('[Redis] Error:', err.message);
  });
  _client.on('connect', () => {
    _fallback = false;
    _lastError = null;
  });
  _client.on('end', () => {
    _client = null;
  });

  return _client;
}

const P = 'sokoni:';
function _k(...parts) { return P + parts.join(':'); }

function isFallback() {
  return _fallback || !REDIS_URL.value() || !_getClient();
}

// ─── Generic Cache ────────────────────────────────────────────────────────────

async function cacheGet(key) {
  const r = _getClient(); if (!r) return null;
  try {
    const v = await r.get(_k('cache', key));
    return v ? JSON.parse(v) : null;
  } catch (e) { _lastError = e.message; return null; }
}

async function cacheSet(key, value, ttlSeconds = 300) {
  const r = _getClient(); if (!r) return false;
  try {
    await r.setex(_k('cache', key), ttlSeconds, JSON.stringify(value));
    return true;
  } catch (e) { _lastError = e.message; return false; }
}

async function cacheDel(key) {
  const r = _getClient(); if (!r) return false;
  try { await r.del(_k('cache', key)); return true; }
  catch (e) { return false; }
}

async function cacheGetOrSet(key, fetchFn, ttlSeconds = 300) {
  const cached = await cacheGet(key);
  if (cached !== null) return { data: cached, fromCache: true };
  const fresh = await fetchFn();
  if (fresh !== null && fresh !== undefined) await cacheSet(key, fresh, ttlSeconds);
  return { data: fresh, fromCache: false };
}

// ─── Session Management ───────────────────────────────────────────────────────

async function sessionCreate(uid, sessionId, data, ttlSeconds = 86400) {
  const r = _getClient(); if (!r) return false;
  try {
    const sessionKey = _k('session', uid, sessionId);
    const indexKey   = _k('sessions', uid);
    const pipe = r.pipeline();
    pipe.setex(sessionKey, ttlSeconds, JSON.stringify({ ...data, uid, sessionId, createdAt: Date.now() }));
    pipe.sadd(indexKey, sessionId);
    pipe.expire(indexKey, ttlSeconds);
    await pipe.exec();
    return true;
  } catch (e) { _lastError = e.message; return false; }
}

async function sessionGet(uid, sessionId) {
  const r = _getClient(); if (!r) return null;
  try {
    const v = await r.get(_k('session', uid, sessionId));
    return v ? JSON.parse(v) : null;
  } catch (e) { return null; }
}

async function sessionTouch(uid, sessionId, ttlSeconds = 86400) {
  const r = _getClient(); if (!r) return false;
  try {
    await r.expire(_k('session', uid, sessionId), ttlSeconds);
    return true;
  } catch (e) { return false; }
}

async function sessionRevoke(uid, sessionId) {
  const r = _getClient(); if (!r) return false;
  try {
    const pipe = r.pipeline();
    pipe.del(_k('session', uid, sessionId));
    pipe.srem(_k('sessions', uid), sessionId);
    await pipe.exec();
    return true;
  } catch (e) { return false; }
}

async function sessionRevokeAll(uid) {
  const r = _getClient(); if (!r) return 0;
  try {
    const ids = await r.smembers(_k('sessions', uid));
    if (!ids.length) return 0;
    const pipe = r.pipeline();
    ids.forEach(id => pipe.del(_k('session', uid, id)));
    pipe.del(_k('sessions', uid));
    await pipe.exec();
    return ids.length;
  } catch (e) { return 0; }
}

async function sessionList(uid) {
  const r = _getClient(); if (!r) return [];
  try {
    const ids = await r.smembers(_k('sessions', uid));
    if (!ids.length) return [];
    const pipe = r.pipeline();
    ids.forEach(id => pipe.get(_k('session', uid, id)));
    const results = await pipe.exec();
    const live = [];
    results.forEach(([err, val], i) => {
      if (!err && val) live.push(JSON.parse(val));
      else r.srem(_k('sessions', uid), ids[i]);
    });
    return live;
  } catch (e) { return []; }
}

// ─── Distributed Locks ────────────────────────────────────────────────────────

const _LUA_RELEASE = `
  if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
const _LUA_EXTEND = `
  if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("pexpire",KEYS[1],ARGV[2]) else return 0 end`;

async function lockAcquire(resource, lockId, ttlMs = 30000) {
  const r = _getClient();
  if (!r) return true; // Optimistic fallback — caller proceeds
  try {
    const result = await r.set(_k('lock', resource), lockId, 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch (e) { return true; }
}

async function lockRelease(resource, lockId) {
  const r = _getClient(); if (!r) return true;
  try {
    const result = await r.eval(_LUA_RELEASE, 1, _k('lock', resource), lockId);
    return result === 1;
  } catch (e) { return false; }
}

async function lockExtend(resource, lockId, ttlMs = 30000) {
  const r = _getClient(); if (!r) return true;
  try {
    const result = await r.eval(_LUA_EXTEND, 1, _k('lock', resource), lockId, String(ttlMs));
    return result === 1;
  } catch (e) { return false; }
}

// ─── Presence ─────────────────────────────────────────────────────────────────

const PRESENCE_TTL = 90; // seconds — heartbeat should be every 60s

async function presenceSet(role, uid, meta = {}) {
  const r = _getClient(); if (!r) return false;
  try {
    const pipe = r.pipeline();
    pipe.setex(_k('presence', role, uid), PRESENCE_TTL, JSON.stringify({ uid, role, ...meta, ts: Date.now() }));
    pipe.sadd(_k('presenceIdx', role), uid);
    await pipe.exec();
    return true;
  } catch (e) { return false; }
}

async function presenceRemove(role, uid) {
  const r = _getClient(); if (!r) return false;
  try {
    const pipe = r.pipeline();
    pipe.del(_k('presence', role, uid));
    pipe.srem(_k('presenceIdx', role), uid);
    await pipe.exec();
    return true;
  } catch (e) { return false; }
}

async function presenceGet(role) {
  const r = _getClient(); if (!r) return [];
  try {
    const uids = await r.smembers(_k('presenceIdx', role));
    if (!uids.length) return [];
    const pipe = r.pipeline();
    uids.forEach(uid => pipe.get(_k('presence', role, uid)));
    const results = await pipe.exec();
    const live = [];
    const stale = [];
    results.forEach(([err, val], i) => {
      if (!err && val) live.push(JSON.parse(val));
      else stale.push(uids[i]);
    });
    if (stale.length) r.srem(_k('presenceIdx', role), ...stale);
    return live;
  } catch (e) { return []; }
}

async function presenceGetAll() {
  const roles = ['buyer', 'seller', 'cashier', 'manager', 'rider', 'driver', 'admin', 'superAdmin', 'pos', 'printer', 'scanner'];
  const result = {};
  for (const role of roles) {
    const members = await presenceGet(role);
    result[role] = members.length;
  }
  return result;
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

async function rateLimit(identifier, action, maxRequests, windowMs) {
  const r = _getClient();
  if (!r) return { allowed: true, remaining: maxRequests, fallback: true };
  try {
    const key = _k('rate', action, identifier);
    const windowSec = Math.ceil(windowMs / 1000);
    const pipe = r.pipeline();
    pipe.incr(key);
    pipe.expire(key, windowSec);
    const [[, count]] = await pipe.exec();
    const allowed = count <= maxRequests;
    return { allowed, count, remaining: Math.max(0, maxRequests - count), resetIn: windowMs };
  } catch (e) { return { allowed: true, remaining: maxRequests, fallback: true }; }
}

// ─── Dashboard Metrics ────────────────────────────────────────────────────────

async function dashboardIncr(shopId, metric, by = 1) {
  const r = _getClient(); if (!r) return null;
  try {
    const key = _k('dashboard', shopId || 'platform', metric);
    const pipe = r.pipeline();
    pipe.incrby(key, by);
    pipe.expire(key, 86400);
    const [[, val]] = await pipe.exec();
    return val;
  } catch (e) { return null; }
}

async function dashboardGet(shopId) {
  const r = _getClient(); if (!r) return null;
  try {
    const prefix = _k('dashboard', shopId || 'platform');
    const keys = await r.keys(prefix + ':*');
    if (!keys.length) return {};
    const vals = await r.mget(...keys);
    const out = {};
    keys.forEach((k, i) => {
      const metric = k.split(':').slice(3).join(':');
      out[metric] = Number(vals[i] || 0);
    });
    return out;
  } catch (e) { return null; }
}

async function dashboardSet(shopId, metrics, ttlSeconds = 60) {
  const r = _getClient(); if (!r) return false;
  try {
    const pipe = r.pipeline();
    Object.entries(metrics).forEach(([k, v]) => {
      pipe.setex(_k('dashboard', shopId || 'platform', k), ttlSeconds, String(v));
    });
    await pipe.exec();
    return true;
  } catch (e) { return false; }
}

// ─── Payment Coordination ─────────────────────────────────────────────────────

async function paymentSetState(orderId, state, meta = {}, ttlSeconds = 900) {
  const r = _getClient(); if (!r) return false;
  try {
    const key = _k('payment', orderId);
    const prev = await r.get(key);
    const existing = prev ? JSON.parse(prev) : {};
    await r.setex(key, ttlSeconds, JSON.stringify({ ...existing, ...meta, state, orderId, updatedAt: Date.now() }));
    return true;
  } catch (e) { return false; }
}

async function paymentGetState(orderId) {
  const r = _getClient(); if (!r) return null;
  try {
    const v = await r.get(_k('payment', orderId));
    return v ? JSON.parse(v) : null;
  } catch (e) { return null; }
}

async function paymentLock(orderId, lockId, ttlMs = 60000) {
  return lockAcquire(`payment:${orderId}`, lockId, ttlMs);
}

async function paymentUnlock(orderId, lockId) {
  return lockRelease(`payment:${orderId}`, lockId);
}

// ─── SmartPOS Synchronization ─────────────────────────────────────────────────

async function posSetState(shopId, terminalId, state, ttlSeconds = 3600) {
  const r = _getClient(); if (!r) return false;
  try {
    const key = _k('pos', shopId, terminalId);
    const payload = JSON.stringify({ ...state, shopId, terminalId, updatedAt: Date.now() });
    const pipe = r.pipeline();
    pipe.setex(key, ttlSeconds, payload);
    pipe.publish(_k('pos:ch', shopId), JSON.stringify({ terminalId, type: 'state_update', ts: Date.now() }));
    await pipe.exec();
    return true;
  } catch (e) { return false; }
}

async function posGetState(shopId, terminalId) {
  const r = _getClient(); if (!r) return null;
  try {
    const v = await r.get(_k('pos', shopId, terminalId));
    return v ? JSON.parse(v) : null;
  } catch (e) { return null; }
}

async function posGetAllTerminals(shopId) {
  const r = _getClient(); if (!r) return [];
  try {
    const keys = await r.keys(_k('pos', shopId, '*'));
    if (!keys.length) return [];
    const vals = await r.mget(...keys);
    return vals.filter(Boolean).map(v => JSON.parse(v));
  } catch (e) { return []; }
}

async function posPublish(shopId, event) {
  const r = _getClient(); if (!r) return 0;
  try {
    return await r.publish(_k('pos:ch', shopId), JSON.stringify({ ...event, ts: Date.now() }));
  } catch (e) { return 0; }
}

// ─── Inventory Locking ────────────────────────────────────────────────────────

async function inventoryLock(productId, variantId, qty, lockId, ttlMs = 120000) {
  const r = _getClient();
  if (!r) return true; // Optimistic fallback
  try {
    const key = _k('inv:lock', productId, variantId || 'default');
    const result = await r.set(key, JSON.stringify({ lockId, qty, ts: Date.now() }), 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch (e) { return true; }
}

async function inventoryRelease(productId, variantId, lockId) {
  const r = _getClient(); if (!r) return true;
  try {
    const key = _k('inv:lock', productId, variantId || 'default');
    const current = await r.get(key);
    if (!current) return true;
    const data = JSON.parse(current);
    if (data.lockId !== lockId) return false;
    await r.del(key);
    return true;
  } catch (e) { return false; }
}

async function inventoryGetLock(productId, variantId) {
  const r = _getClient(); if (!r) return null;
  try {
    const v = await r.get(_k('inv:lock', productId, variantId || 'default'));
    return v ? JSON.parse(v) : null;
  } catch (e) { return null; }
}

// ─── Event Bus (Streams) ──────────────────────────────────────────────────────

async function eventPublish(stream, event) {
  const r = _getClient(); if (!r) return null;
  try {
    const key = _k('stream', stream);
    const id = await r.xadd(key, '*', 'data', JSON.stringify({ ...event, ts: Date.now() }));
    await r.xtrim(key, 'MAXLEN', '~', '10000');
    return id;
  } catch (e) { return null; }
}

async function eventRead(stream, lastId = '0-0', count = 100) {
  const r = _getClient(); if (!r) return [];
  try {
    const key = _k('stream', stream);
    const exists = await r.exists(key);
    if (!exists) return [];
    const results = await r.xread('COUNT', count, 'STREAMS', key, lastId);
    if (!results || !results[0]) return [];
    return results[0][1].map(([id, fields]) => ({
      id, data: JSON.parse(fields[1])
    }));
  } catch (e) { return []; }
}

async function eventGetLength(stream) {
  const r = _getClient(); if (!r) return 0;
  try { return await r.xlen(_k('stream', stream)); }
  catch (e) { return 0; }
}

// ─── Background Job Queue ─────────────────────────────────────────────────────

async function queuePush(queueName, job, priority = 'normal') {
  const r = _getClient(); if (!r) return false;
  try {
    const key = _k('queue', queueName);
    const score = priority === 'high' ? Date.now() - 1_000_000 : Date.now();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await r.zadd(key, score, JSON.stringify({ ...job, _id: id, _queuedAt: Date.now() }));
    return id;
  } catch (e) { return false; }
}

async function queuePop(queueName, count = 5) {
  const r = _getClient(); if (!r) return [];
  try {
    const key = _k('queue', queueName);
    const items = await r.zpopmin(key, count * 2); // ZADD stores value+score alternating
    const jobs = [];
    for (let i = 0; i < items.length; i += 2) {
      try { jobs.push(JSON.parse(items[i])); } catch (_) {}
    }
    return jobs;
  } catch (e) { return []; }
}

async function queueDepth(queueName) {
  const r = _getClient(); if (!r) return 0;
  try { return await r.zcard(_k('queue', queueName)); }
  catch (e) { return 0; }
}

async function queueDepthAll() {
  const queues = ['email', 'receipt', 'image', 'ai', 'report', 'bulk', 'notification', 'sms'];
  const r = _getClient(); if (!r) return {};
  try {
    const pipe = r.pipeline();
    queues.forEach(q => pipe.zcard(_k('queue', q)));
    const results = await pipe.exec();
    const out = {};
    queues.forEach((q, i) => { out[q] = results[i][1] || 0; });
    return out;
  } catch (e) { return {}; }
}

// ─── AI & Search Cache ────────────────────────────────────────────────────────

async function aiCacheGet(hash) {
  return cacheGet(`ai:${hash}`);
}

async function aiCacheSet(hash, response, ttlSeconds = 3600) {
  return cacheSet(`ai:${hash}`, response, ttlSeconds);
}

async function searchCacheGet(query) {
  return cacheGet(`search:${query.toLowerCase().trim()}`);
}

async function searchCacheSet(query, results, ttlSeconds = 300) {
  return cacheSet(`search:${query.toLowerCase().trim()}`, results, ttlSeconds);
}

// ─── Admin / Observability ────────────────────────────────────────────────────

async function adminInfo() {
  const r = _getClient();
  if (!r) return { status: 'unavailable', fallback: true, lastError: _lastError };
  try {
    const info = await r.info('all');
    const lines = info.split('\r\n');
    const get = key => {
      const l = lines.find(x => x.startsWith(key + ':'));
      return l ? l.split(':').slice(1).join(':').trim() : null;
    };
    const dbLine = get('db0') || '';
    const keyMatch = dbLine.match(/keys=(\d+)/);
    const queueDepths = await queueDepthAll();
    const presence = await presenceGetAll();
    return {
      status: 'connected',
      fallback: false,
      version: get('redis_version'),
      uptimeSeconds: Number(get('uptime_in_seconds')),
      connectedClients: Number(get('connected_clients')),
      memoryUsedHuman: get('used_memory_human'),
      memoryPeakHuman: get('used_memory_peak_human'),
      opsPerSec: Number(get('instantaneous_ops_per_sec')),
      totalKeys: keyMatch ? Number(keyMatch[1]) : 0,
      keyspaceHits: Number(get('keyspace_hits')),
      keyspaceMisses: Number(get('keyspace_misses')),
      hitRate: (() => {
        const hits = Number(get('keyspace_hits'));
        const misses = Number(get('keyspace_misses'));
        const total = hits + misses;
        return total > 0 ? Math.round((hits / total) * 100) : 0;
      })(),
      queueDepths,
      presence,
      lastError: _lastError,
    };
  } catch (e) {
    return { status: 'error', error: e.message, fallback: true };
  }
}

module.exports = {
  isFallback,
  // Cache
  cacheGet, cacheSet, cacheDel, cacheGetOrSet,
  // Sessions
  sessionCreate, sessionGet, sessionTouch, sessionRevoke, sessionRevokeAll, sessionList,
  // Locks
  lockAcquire, lockRelease, lockExtend,
  // Presence
  presenceSet, presenceRemove, presenceGet, presenceGetAll,
  // Rate limiting
  rateLimit,
  // Dashboard
  dashboardIncr, dashboardGet, dashboardSet,
  // Payment
  paymentSetState, paymentGetState, paymentLock, paymentUnlock,
  // POS Sync
  posSetState, posGetState, posGetAllTerminals, posPublish,
  // Inventory
  inventoryLock, inventoryRelease, inventoryGetLock,
  // Event Bus
  eventPublish, eventRead, eventGetLength,
  // Queue
  queuePush, queuePop, queueDepth, queueDepthAll,
  // Specialized cache
  aiCacheGet, aiCacheSet, searchCacheGet, searchCacheSet,
  // Admin
  adminInfo,
};
