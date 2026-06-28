'use strict';
/**
 * SOKONI Redis Service Layer
 *
 * Provides named service objects for all Redis-backed operations.
 * Application code imports specific services rather than touching Redis directly.
 *
 *   const { CacheService, SessionService, LockService } = require('./redis-service');
 *
 * Firestore remains the single source of truth. Redis is used for:
 *   - Low-latency caching (search, AI, dashboard metrics)
 *   - Active session tracking
 *   - Distributed coordination (locks, inventory reservation)
 *   - Live presence (online sellers, riders, POS devices)
 *   - Rate-limiting counters
 *   - Event bus (Redis Streams)
 *   - Background job queues
 *   - SmartPOS real-time state sync
 *
 * All methods return safe defaults when Redis is unavailable.
 * The caller never needs to handle connection errors.
 *
 * @module redis-service
 */

const { defineSecret } = require('firebase-functions/params');
const REDIS_URL = defineSecret('REDIS_URL');

// ─── TTL Constants ────────────────────────────────────────────────────────────
/**
 * Centralised TTL table. All Redis keys use these constants.
 * Time in seconds unless suffixed _MS (milliseconds).
 */
const TTL = {
  // Presence: must expire faster than heartbeat period to detect stale devices.
  // Client heartbeats every 60s; key expires after 90s → 30s grace window.
  PRESENCE:             90,

  // Sessions: 24h default; 30 days for "remember me" flows.
  SESSION:              86_400,
  SESSION_EXTENDED:  2_592_000,

  // Search results: fresh enough for fast UX, short enough to reflect inventory changes.
  SEARCH:               300,      // 5 min

  // Dashboard counters: soft real-time; Firestore is authoritative for exact figures.
  DASHBOARD:             60,      // 1 min

  // AI responses: expensive to generate; safe to cache when prompt is stable.
  AI:                 3_600,      // 1 h

  // POS terminal state: clears after one shift's inactivity.
  POS:                3_600,      // 1 h

  // Payment coordination window: STK push / webhook must arrive within this window.
  PAYMENT:              900,      // 15 min

  // Distributed lock TTLs (milliseconds).
  LOCK_MS:           30_000,      // 30 s default
  INVENTORY_LOCK_MS: 120_000,     // 2 min — survives slow checkout flows

  // Rate-limit windows.
  RATE_SHORT:            60,      // 1 min  — auth / OTP
  RATE_MEDIUM:          900,      // 15 min — payments / checkout
  RATE_LONG:          3_600,      // 1 h    — AI / search

  // Event stream: retain last N entries per stream.
  STREAM_MAX:        10_000,

  // Generic cache fallback when caller does not specify.
  CACHE_DEFAULT:        300,      // 5 min
};

// ─── Key Schema ───────────────────────────────────────────────────────────────
/**
 * All keys follow the pattern:  sokoni:{domain}:{...parts}
 *
 * Domain catalogue:
 *   cache:*                — generic cache entries
 *   session:{uid}:{sid}    — individual session data
 *   sessions:{uid}         — SET of session IDs for a user
 *   lock:{resource}        — distributed lock
 *   presence:{role}:{uid}  — live presence record
 *   presenceIdx:{role}     — SET of UIDs for a role
 *   dashboard:{shopId}:{m} — metric counter
 *   payment:{orderId}      — payment state machine
 *   pos:{shopId}:{tid}     — POS terminal state
 *   pos:ch:{shopId}        — POS pub/sub channel
 *   inv:lock:{pid}:{vid}   — inventory reservation
 *   stream:{name}          — Redis Stream (event bus)
 *   queue:{name}           — Sorted Set job queue
 *   rate:{action}:{id}     — rate-limit counter
 *   stats:*                — internal operational counters
 */
const NS = 'sokoni:';
function _k(...parts) { return NS + parts.join(':'); }

// ─── Client management ────────────────────────────────────────────────────────

let _client = null;
let _fallback = false;
let _lastError = null;
let _errorCount = 0;
let _errorWindow = 0; // timestamp of first error in current window

function _getClient() {
  if (_fallback) return null;
  if (_client && _client.status === 'ready') return _client;

  const url = REDIS_URL.value();
  if (!url) { _fallback = true; return null; }

  const Redis = require('ioredis');
  _client = new Redis(url, {
    tls: url.startsWith('rediss://') ? { rejectUnauthorized: true } : undefined,
    lazyConnect:    true,
    connectTimeout: 5_000,
    commandTimeout: 3_000,
    maxRetriesPerRequest: 2,
    retryStrategy(attempts) {
      if (attempts > 5) { _fallback = true; return null; }
      return Math.min(attempts * 300, 3_000);
    },
    reconnectOnError: err => err.message.includes('READONLY'),
  });

  _client.on('error', err => {
    _lastError = err.message;
    _errorCount++;
    const now = Date.now();
    if (now - _errorWindow > 60_000) { _errorCount = 1; _errorWindow = now; }
    console.error(JSON.stringify({ severity: 'ERROR', message: '[Redis]', error: err.message }));
  });
  _client.on('connect', () => { _fallback = false; _lastError = null; });
  _client.on('end',     () => { _client = null; });

  return _client;
}

/** Returns true when Redis is unavailable. Callers use this to decide fallback behaviour. */
function isFallback() {
  return _fallback || !REDIS_URL.value() || !_getClient();
}

// ─── Scan helper (non-blocking alternative to KEYS) ──────────────────────────

async function _scanCount(pattern) {
  const r = _getClient(); if (!r) return 0;
  let cursor = '0'; let count = 0;
  try {
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', '200');
      cursor = next; count += keys.length;
    } while (cursor !== '0');
  } catch (_) {}
  return count;
}

// ─── CacheService ─────────────────────────────────────────────────────────────

async function cacheGet(key) {
  const r = _getClient(); if (!r) return null;
  try { const v = await r.get(_k('cache', key)); return v ? JSON.parse(v) : null; }
  catch (e) { _lastError = e.message; return null; }
}

async function cacheSet(key, value, ttlSeconds = TTL.CACHE_DEFAULT) {
  const r = _getClient(); if (!r) return false;
  try { await r.setex(_k('cache', key), ttlSeconds, JSON.stringify(value)); return true; }
  catch (e) { _lastError = e.message; return false; }
}

async function cacheDel(key) {
  const r = _getClient(); if (!r) return false;
  try { await r.del(_k('cache', key)); return true; } catch (_) { return false; }
}

async function cacheGetOrSet(key, fetchFn, ttlSeconds = TTL.CACHE_DEFAULT) {
  const cached = await cacheGet(key);
  if (cached !== null) return { data: cached, fromCache: true };
  const fresh = await fetchFn();
  if (fresh != null) await cacheSet(key, fresh, ttlSeconds);
  return { data: fresh, fromCache: false };
}

async function aiCacheGet(promptHash)                        { return cacheGet(`ai:${promptHash}`); }
async function aiCacheSet(promptHash, resp, ttl = TTL.AI)   { return cacheSet(`ai:${promptHash}`, resp, ttl); }
async function searchCacheGet(query)                         { return cacheGet(`search:${query.toLowerCase().trim()}`); }
async function searchCacheSet(query, res, ttl = TTL.SEARCH)  { return cacheSet(`search:${query.toLowerCase().trim()}`, res, ttl); }

const CacheService = {
  get:         cacheGet,
  set:         cacheSet,
  del:         cacheDel,
  getOrSet:    cacheGetOrSet,
  aiGet:       aiCacheGet,
  aiSet:       aiCacheSet,
  searchGet:   searchCacheGet,
  searchSet:   searchCacheSet,
};

// ─── SessionService ───────────────────────────────────────────────────────────

async function sessionCreate(uid, sessionId, data, ttl = TTL.SESSION) {
  const r = _getClient(); if (!r) return false;
  try {
    const pipe = r.pipeline();
    pipe.setex(_k('session', uid, sessionId), ttl, JSON.stringify({ ...data, uid, sessionId, createdAt: Date.now() }));
    pipe.sadd(_k('sessions', uid), sessionId);
    pipe.expire(_k('sessions', uid), ttl);
    await pipe.exec();
    return true;
  } catch (e) { _lastError = e.message; return false; }
}

async function sessionGet(uid, sessionId) {
  const r = _getClient(); if (!r) return null;
  try { const v = await r.get(_k('session', uid, sessionId)); return v ? JSON.parse(v) : null; }
  catch (_) { return null; }
}

async function sessionTouch(uid, sessionId, ttl = TTL.SESSION) {
  const r = _getClient(); if (!r) return false;
  try { await r.expire(_k('session', uid, sessionId), ttl); return true; }
  catch (_) { return false; }
}

async function sessionRevoke(uid, sessionId) {
  const r = _getClient(); if (!r) return false;
  try {
    const pipe = r.pipeline();
    pipe.del(_k('session', uid, sessionId));
    pipe.srem(_k('sessions', uid), sessionId);
    await pipe.exec(); return true;
  } catch (_) { return false; }
}

async function sessionRevokeAll(uid) {
  const r = _getClient(); if (!r) return 0;
  try {
    const ids = await r.smembers(_k('sessions', uid));
    if (!ids.length) return 0;
    const pipe = r.pipeline();
    ids.forEach(id => pipe.del(_k('session', uid, id)));
    pipe.del(_k('sessions', uid));
    await pipe.exec(); return ids.length;
  } catch (_) { return 0; }
}

async function sessionList(uid) {
  const r = _getClient(); if (!r) return [];
  try {
    const ids = await r.smembers(_k('sessions', uid));
    if (!ids.length) return [];
    const pipe = r.pipeline();
    ids.forEach(id => pipe.get(_k('session', uid, id)));
    const res = await pipe.exec();
    const live = [];
    res.forEach(([err, val], i) => {
      if (!err && val) live.push(JSON.parse(val));
      else r.srem(_k('sessions', uid), ids[i]);
    });
    return live;
  } catch (_) { return []; }
}

const SessionService = {
  create:     sessionCreate,
  get:        sessionGet,
  touch:      sessionTouch,
  revoke:     sessionRevoke,
  revokeAll:  sessionRevokeAll,
  list:       sessionList,
};

// ─── LockService ──────────────────────────────────────────────────────────────

const _LUA_RELEASE = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
const _LUA_EXTEND  = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("pexpire",KEYS[1],ARGV[2]) else return 0 end`;

async function lockAcquire(resource, lockId, ttlMs = TTL.LOCK_MS) {
  const r = _getClient(); if (!r) return true; // fail-open
  try { return (await r.set(_k('lock', resource), lockId, 'PX', ttlMs, 'NX')) === 'OK'; }
  catch (_) { return true; }
}

async function lockRelease(resource, lockId) {
  const r = _getClient(); if (!r) return true;
  try { return (await r.eval(_LUA_RELEASE, 1, _k('lock', resource), lockId)) === 1; }
  catch (_) { return false; }
}

async function lockExtend(resource, lockId, ttlMs = TTL.LOCK_MS) {
  const r = _getClient(); if (!r) return true;
  try { return (await r.eval(_LUA_EXTEND, 1, _k('lock', resource), lockId, String(ttlMs))) === 1; }
  catch (_) { return false; }
}

const LockService = {
  acquire: lockAcquire,
  release: lockRelease,
  extend:  lockExtend,
};

// ─── PresenceService ──────────────────────────────────────────────────────────

async function presenceSet(role, uid, meta = {}) {
  const r = _getClient(); if (!r) return false;
  try {
    const pipe = r.pipeline();
    pipe.setex(_k('presence', role, uid), TTL.PRESENCE, JSON.stringify({ uid, role, ...meta, ts: Date.now() }));
    pipe.sadd(_k('presenceIdx', role), uid);
    await pipe.exec(); return true;
  } catch (_) { return false; }
}

async function presenceRemove(role, uid) {
  const r = _getClient(); if (!r) return false;
  try {
    const pipe = r.pipeline();
    pipe.del(_k('presence', role, uid));
    pipe.srem(_k('presenceIdx', role), uid);
    await pipe.exec(); return true;
  } catch (_) { return false; }
}

async function presenceGet(role) {
  const r = _getClient(); if (!r) return [];
  try {
    const uids = await r.smembers(_k('presenceIdx', role));
    if (!uids.length) return [];
    const pipe = r.pipeline();
    uids.forEach(uid => pipe.get(_k('presence', role, uid)));
    const res = await pipe.exec();
    const live = []; const stale = [];
    res.forEach(([err, val], i) => {
      if (!err && val) live.push(JSON.parse(val)); else stale.push(uids[i]);
    });
    if (stale.length) r.srem(_k('presenceIdx', role), ...stale);
    return live;
  } catch (_) { return []; }
}

async function presenceGetAll() {
  const roles = ['buyer','seller','cashier','manager','rider','driver','admin','superAdmin','pos','printer','scanner'];
  const result = {};
  for (const role of roles) result[role] = (await presenceGet(role)).length;
  return result;
}

const PresenceService = {
  set:    presenceSet,
  remove: presenceRemove,
  get:    presenceGet,
  getAll: presenceGetAll,
};

// ─── RateLimitService ─────────────────────────────────────────────────────────

async function rateLimit(identifier, action, maxRequests, windowSeconds) {
  const r = _getClient();
  if (!r) return { allowed: true, remaining: maxRequests, fallback: true };
  try {
    const key = _k('rate', action, identifier);
    const pipe = r.pipeline();
    pipe.incr(key);
    pipe.expire(key, windowSeconds);
    const [[, count]] = await pipe.exec();
    return { allowed: count <= maxRequests, count, remaining: Math.max(0, maxRequests - count) };
  } catch (_) { return { allowed: true, remaining: maxRequests, fallback: true }; }
}

const RateLimitService = {
  check: rateLimit,
};

// ─── DashboardService ─────────────────────────────────────────────────────────

async function dashboardIncr(shopId, metric, by = 1) {
  const r = _getClient(); if (!r) return null;
  try {
    const pipe = r.pipeline();
    pipe.incrby(_k('dashboard', shopId || 'platform', metric), by);
    pipe.expire(_k('dashboard', shopId || 'platform', metric), TTL.DASHBOARD);
    const [[, val]] = await pipe.exec(); return val;
  } catch (_) { return null; }
}

async function dashboardGet(shopId) {
  const r = _getClient(); if (!r) return null;
  try {
    const prefix = _k('dashboard', shopId || 'platform');
    const keys = await r.keys(prefix + ':*');
    if (!keys.length) return {};
    const vals = await r.mget(...keys);
    const out = {};
    keys.forEach((k, i) => { out[k.split(':').slice(3).join(':')] = Number(vals[i] || 0); });
    return out;
  } catch (_) { return null; }
}

async function dashboardSet(shopId, metrics, ttl = TTL.DASHBOARD) {
  const r = _getClient(); if (!r) return false;
  try {
    const pipe = r.pipeline();
    Object.entries(metrics).forEach(([k, v]) => {
      pipe.setex(_k('dashboard', shopId || 'platform', k), ttl, String(v));
    });
    await pipe.exec(); return true;
  } catch (_) { return false; }
}

const DashboardService = {
  incr: dashboardIncr,
  get:  dashboardGet,
  set:  dashboardSet,
};

// ─── PaymentService ───────────────────────────────────────────────────────────

async function paymentSetState(orderId, state, meta = {}) {
  const r = _getClient(); if (!r) return false;
  try {
    const key = _k('payment', orderId);
    const prev = await r.get(key);
    const existing = prev ? JSON.parse(prev) : {};
    await r.setex(key, TTL.PAYMENT, JSON.stringify({ ...existing, ...meta, state, orderId, updatedAt: Date.now() }));
    return true;
  } catch (_) { return false; }
}

async function paymentGetState(orderId) {
  const r = _getClient(); if (!r) return null;
  try { const v = await r.get(_k('payment', orderId)); return v ? JSON.parse(v) : null; }
  catch (_) { return null; }
}

async function paymentLock(orderId, lockId, ttlMs = 60_000) {
  return lockAcquire(`payment:${orderId}`, lockId, ttlMs);
}
async function paymentUnlock(orderId, lockId) {
  return lockRelease(`payment:${orderId}`, lockId);
}

const PaymentService = {
  setState: paymentSetState,
  getState: paymentGetState,
  lock:     paymentLock,
  unlock:   paymentUnlock,
};

// ─── POSService ───────────────────────────────────────────────────────────────

async function posSetState(shopId, terminalId, state) {
  const r = _getClient(); if (!r) return false;
  try {
    const payload = JSON.stringify({ ...state, shopId, terminalId, updatedAt: Date.now() });
    const pipe = r.pipeline();
    pipe.setex(_k('pos', shopId, terminalId), TTL.POS, payload);
    pipe.publish(_k('pos:ch', shopId), JSON.stringify({ terminalId, type: 'state_update', ts: Date.now() }));
    await pipe.exec(); return true;
  } catch (_) { return false; }
}

async function posGetState(shopId, terminalId) {
  const r = _getClient(); if (!r) return null;
  try { const v = await r.get(_k('pos', shopId, terminalId)); return v ? JSON.parse(v) : null; }
  catch (_) { return null; }
}

async function posGetAllTerminals(shopId) {
  const r = _getClient(); if (!r) return [];
  try {
    const keys = await r.keys(_k('pos', shopId, '*'));
    if (!keys.length) return [];
    const vals = await r.mget(...keys);
    return vals.filter(Boolean).map(v => JSON.parse(v));
  } catch (_) { return []; }
}

async function posPublish(shopId, event) {
  const r = _getClient(); if (!r) return 0;
  try { return await r.publish(_k('pos:ch', shopId), JSON.stringify({ ...event, ts: Date.now() })); }
  catch (_) { return 0; }
}

const POSService = {
  setState:       posSetState,
  getState:       posGetState,
  getAllTerminals: posGetAllTerminals,
  publish:        posPublish,
};

// ─── InventoryService ─────────────────────────────────────────────────────────

async function inventoryLock(productId, variantId, qty, lockId, ttlMs = TTL.INVENTORY_LOCK_MS) {
  const r = _getClient(); if (!r) return true; // fail-open
  try {
    const key = _k('inv:lock', productId, variantId || 'default');
    return (await r.set(key, JSON.stringify({ lockId, qty, ts: Date.now() }), 'PX', ttlMs, 'NX')) === 'OK';
  } catch (_) { return true; }
}

async function inventoryRelease(productId, variantId, lockId) {
  const r = _getClient(); if (!r) return true;
  try {
    const key = _k('inv:lock', productId, variantId || 'default');
    const raw = await r.get(key);
    if (!raw) return true;
    const data = JSON.parse(raw);
    if (data.lockId !== lockId) return false;
    await r.del(key); return true;
  } catch (_) { return false; }
}

async function inventoryGetLock(productId, variantId) {
  const r = _getClient(); if (!r) return null;
  try { const v = await r.get(_k('inv:lock', productId, variantId || 'default')); return v ? JSON.parse(v) : null; }
  catch (_) { return null; }
}

const InventoryService = {
  lock:    inventoryLock,
  release: inventoryRelease,
  getLock: inventoryGetLock,
};

// ─── EventBusService ──────────────────────────────────────────────────────────

async function eventPublish(stream, event) {
  const r = _getClient(); if (!r) return null;
  try {
    const key = _k('stream', stream);
    const id = await r.xadd(key, '*', 'data', JSON.stringify({ ...event, ts: Date.now() }));
    await r.xtrim(key, 'MAXLEN', '~', String(TTL.STREAM_MAX));
    return id;
  } catch (_) { return null; }
}

async function eventRead(stream, lastId = '0-0', count = 100) {
  const r = _getClient(); if (!r) return [];
  try {
    const key = _k('stream', stream);
    if (!await r.exists(key)) return [];
    const res = await r.xread('COUNT', count, 'STREAMS', key, lastId);
    if (!res || !res[0]) return [];
    return res[0][1].map(([id, fields]) => ({ id, data: JSON.parse(fields[1]) }));
  } catch (_) { return []; }
}

async function eventGetLength(stream) {
  const r = _getClient(); if (!r) return 0;
  try { return await r.xlen(_k('stream', stream)); }
  catch (_) { return 0; }
}

const EventBusService = {
  publish:   eventPublish,
  read:      eventRead,
  getLength: eventGetLength,
};

// ─── QueueService ─────────────────────────────────────────────────────────────

async function queuePush(queueName, job, priority = 'normal') {
  const r = _getClient(); if (!r) return false;
  try {
    const score = priority === 'high' ? Date.now() - 1_000_000 : Date.now();
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await r.zadd(_k('queue', queueName), score, JSON.stringify({ ...job, _id: id, _queuedAt: Date.now() }));
    return id;
  } catch (_) { return false; }
}

async function queuePop(queueName, count = 5) {
  const r = _getClient(); if (!r) return [];
  try {
    const items = await r.zpopmin(_k('queue', queueName), count * 2);
    const jobs = [];
    for (let i = 0; i < items.length; i += 2) {
      try { jobs.push(JSON.parse(items[i])); } catch (_) {}
    }
    return jobs;
  } catch (_) { return []; }
}

async function queueDepth(queueName) {
  const r = _getClient(); if (!r) return 0;
  try { return await r.zcard(_k('queue', queueName)); }
  catch (_) { return 0; }
}

async function queueDepthAll() {
  const names = ['email','receipt','image','ai','report','bulk','notification','sms'];
  const r = _getClient(); if (!r) return {};
  try {
    const pipe = r.pipeline();
    names.forEach(n => pipe.zcard(_k('queue', n)));
    const res = await pipe.exec();
    const out = {};
    names.forEach((n, i) => { out[n] = res[i][1] || 0; });
    return out;
  } catch (_) { return {}; }
}

const QueueService = {
  push:     queuePush,
  pop:      queuePop,
  depth:    queueDepth,
  depthAll: queueDepthAll,
};

// ─── Admin / Observability ────────────────────────────────────────────────────

async function adminInfo() {
  const r = _getClient();
  if (!r) return { status: 'unavailable', fallback: true, lastError: _lastError, errorCount: _errorCount };

  try {
    const [info, slowlogLen] = await Promise.all([
      r.info('all'),
      r.slowlog('len').catch(() => 0),
    ]);

    const lines = info.split('\r\n');
    const get = key => {
      const l = lines.find(x => x.startsWith(key + ':'));
      return l ? l.split(':').slice(1).join(':').trim() : null;
    };

    const [activeLocks, activeSessions, activePosTerminals, queueDepths, presence] = await Promise.all([
      _scanCount(_k('lock', '*')),
      _scanCount(_k('session', '*', '*')),
      _scanCount(_k('pos', '*', '*')),
      queueDepthAll(),
      presenceGetAll(),
    ]);

    const hits   = Number(get('keyspace_hits')   || 0);
    const misses = Number(get('keyspace_misses') || 0);
    const total  = hits + misses;
    const dbLine = get('db0') || '';
    const keyMatch = dbLine.match(/keys=(\d+)/);

    return {
      status:            'connected',
      fallback:          false,
      version:           get('redis_version'),
      uptimeSeconds:     Number(get('uptime_in_seconds') || 0),
      connectedClients:  Number(get('connected_clients') || 0),
      memoryUsedHuman:   get('used_memory_human'),
      memoryPeakHuman:   get('used_memory_peak_human'),
      opsPerSec:         Number(get('instantaneous_ops_per_sec') || 0),
      totalKeys:         keyMatch ? Number(keyMatch[1]) : 0,
      keyspaceHits:      hits,
      keyspaceMisses:    misses,
      hitRate:           total > 0 ? Math.round((hits / total) * 100) : 0,
      // Operational counts
      activeLocks,
      activeSessions,
      activePosTerminals,
      slowlogLen:        Number(slowlogLen || 0),
      errorCount:        _errorCount,
      // Queues + presence
      queueDepths,
      presence,
      lastError:         _lastError,
    };
  } catch (e) {
    return { status: 'error', error: e.message, fallback: true };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Named service objects — preferred API for application code
  CacheService,
  SessionService,
  LockService,
  PresenceService,
  RateLimitService,
  DashboardService,
  PaymentService,
  POSService,
  InventoryService,
  EventBusService,
  QueueService,

  // Constants
  TTL,

  // Utilities
  isFallback,
  adminInfo,

  // Flat exports for backward compatibility with redis-layer.js
  cacheGet, cacheSet, cacheDel, cacheGetOrSet, aiCacheGet, aiCacheSet, searchCacheGet, searchCacheSet,
  sessionCreate, sessionGet, sessionTouch, sessionRevoke, sessionRevokeAll, sessionList,
  lockAcquire, lockRelease, lockExtend,
  presenceSet, presenceRemove, presenceGet, presenceGetAll,
  rateLimit,
  dashboardIncr, dashboardGet, dashboardSet,
  paymentSetState, paymentGetState, paymentLock, paymentUnlock,
  posSetState, posGetState, posGetAllTerminals, posPublish,
  inventoryLock, inventoryRelease, inventoryGetLock,
  eventPublish, eventRead, eventGetLength,
  queuePush, queuePop, queueDepth, queueDepthAll,
};
