'use strict';
/**
 * SOKONI Redis Layer — Cloud Functions
 * 28 onCall handlers + 1 dispatcher + 2 scheduled Cloud Functions.
 * All callables use enforceAppCheck: true.
 * All methods gracefully degrade when Redis is unavailable (fallback: true in response).
 *
 * DEPLOYMENT: index.js exports only `redisDispatch` + the 2 scheduled functions.
 * Client code calls `redisDispatch({op: 'redisXxx', ...data})` instead of
 * individual CF names — reducing 30 Cloud Run services to 3.
 */

const { onCall, HttpsError }  = require('firebase-functions/v2/https');
const { onSchedule }          = require('firebase-functions/v2/scheduler');
const admin                   = require('firebase-admin');
const R                       = require('./redis-service');
const { dispatch }            = require('./redis-jobs');

const { defineSecret } = require('firebase-functions/params');
const REDIS_URL_SECRET = defineSecret('REDIS_URL');
const sokoniAt         = require('./sokoni-at');

// VPC connector routes private-IP traffic (10.127.36.43 Memorystore) through the project VPC.
const _VPC = {
  vpcConnector:              'sokoni-redis-connector',
  vpcConnectorEgressSettings: 'PRIVATE_RANGES_ONLY',
};

const _CF_OPTS   = { enforceAppCheck: true, secrets: [REDIS_URL_SECRET], ..._VPC };
const _SCHED_OPTS = { timeZone: 'Africa/Nairobi', secrets: [REDIS_URL_SECRET, ...sokoniAt.secrets], ..._VPC };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _auth(req, require = true) {
  if (!req.auth) {
    if (require) throw new HttpsError('unauthenticated', 'Authentication required.');
    return null;
  }
  return req.auth;
}

function _san(s, max = 200) {
  if (typeof s !== 'string') return '';
  return s.replace(/[<>"'`]/g, '').trim().slice(0, max);
}

function _isAdmin(token) {
  return !!(token?.claims?.admin || token?.claims?.superAdmin);
}

// ─── Handlers (plain async functions — no CF overhead) ────────────────────────

async function _sessionCreate(req) {
  const auth = _auth(req);
  const { sessionId, role, deviceInfo } = req.data || {};
  if (!sessionId || typeof sessionId !== 'string') throw new HttpsError('invalid-argument', 'sessionId required.');
  const token = await admin.auth().verifyIdToken(auth.token.uid ? '' : auth.uid, true).catch(() => null)
    || { uid: auth.uid, claims: auth.token };
  const data = {
    uid: auth.uid,
    role: _san(role || 'buyer', 20),
    deviceInfo: {
      ua: _san(deviceInfo?.ua, 200),
      ip: _san(deviceInfo?.ip, 50),
      platform: _san(deviceInfo?.platform, 50),
    },
  };
  const ok = await R.sessionCreate(auth.uid, _san(sessionId, 64), data);
  return { ok, fallback: R.isFallback() };
}

async function _sessionGet(req) {
  const auth = _auth(req);
  const { sessionId } = req.data || {};
  if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId required.');
  const session = await R.sessionGet(auth.uid, _san(sessionId, 64));
  return { session, fallback: R.isFallback() };
}

async function _sessionRevoke(req) {
  const auth = _auth(req);
  const { sessionId, uid } = req.data || {};
  const targetUid = (_isAdmin(auth.token) && uid) ? uid : auth.uid;
  const ok = await R.sessionRevoke(targetUid, _san(sessionId, 64));
  return { ok, fallback: R.isFallback() };
}

async function _sessionRevokeAll(req) {
  const auth = _auth(req);
  const { uid } = req.data || {};
  const targetUid = (_isAdmin(auth.token) && uid) ? uid : auth.uid;
  const count = await R.sessionRevokeAll(targetUid);
  return { count, fallback: R.isFallback() };
}

async function _sessionList(req) {
  const auth = _auth(req);
  const { uid } = req.data || {};
  const targetUid = (_isAdmin(auth.token) && uid) ? uid : auth.uid;
  const sessions = await R.sessionList(targetUid);
  return { sessions, fallback: R.isFallback() };
}

async function _presenceHeartbeat(req) {
  const auth = _auth(req);
  const { role, meta } = req.data || {};
  const safeRole = _san(role || 'buyer', 20);
  const safeMeta = {
    shopId: _san(meta?.shopId, 50),
    terminalId: _san(meta?.terminalId, 50),
    page: _san(meta?.page, 100),
  };
  const ok = await R.presenceSet(safeRole, auth.uid, { uid: auth.uid, ...safeMeta });
  return { ok, fallback: R.isFallback() };
}

async function _presenceGet(req) {
  const auth = _auth(req);
  const { role } = req.data || {};
  if (role) {
    const members = await R.presenceGet(_san(role, 20));
    return { members, count: members.length, fallback: R.isFallback() };
  }
  if (!_isAdmin(auth.token)) throw new HttpsError('permission-denied', 'Admin required for all-role presence.');
  const all = await R.presenceGetAll();
  return { all, fallback: R.isFallback() };
}

async function _presenceRemove(req) {
  const auth = _auth(req);
  const { role } = req.data || {};
  const ok = await R.presenceRemove(_san(role || 'buyer', 20), auth.uid);
  return { ok, fallback: R.isFallback() };
}

async function _posSetState(req) {
  const auth = _auth(req);
  const { shopId, terminalId, state } = req.data || {};
  if (!shopId || !terminalId) throw new HttpsError('invalid-argument', 'shopId and terminalId required.');
  if (!_isAdmin(auth.token) && state?.operatorId !== auth.uid) {
    throw new HttpsError('permission-denied', 'Can only update your own terminal state.');
  }
  const safe = {
    cart: state?.cart || [],
    discount: Number(state?.discount) || 0,
    paymentStatus: _san(state?.paymentStatus, 20),
    operatorId: auth.uid,
    shiftId: _san(state?.shiftId, 50),
    receiptNo: _san(state?.receiptNo, 50),
  };
  const ok = await R.posSetState(_san(shopId, 50), _san(terminalId, 50), safe);
  return { ok, fallback: R.isFallback() };
}

async function _posGetState(req) {
  const auth = _auth(req);
  const { shopId, terminalId } = req.data || {};
  if (!shopId) throw new HttpsError('invalid-argument', 'shopId required.');
  if (terminalId) {
    const state = await R.posGetState(_san(shopId, 50), _san(terminalId, 50));
    return { state, fallback: R.isFallback() };
  }
  const terminals = await R.posGetAllTerminals(_san(shopId, 50));
  return { terminals, fallback: R.isFallback() };
}

async function _posPublish(req) {
  const auth = _auth(req);
  const { shopId, event } = req.data || {};
  if (!shopId || !event?.type) throw new HttpsError('invalid-argument', 'shopId and event.type required.');
  const safe = {
    type: _san(event.type, 50),
    terminalId: _san(event.terminalId, 50),
    payload: event.payload || {},
    uid: auth.uid,
  };
  const receivers = await R.posPublish(_san(shopId, 50), safe);
  await R.eventPublish('pos', { shopId, ...safe });
  return { receivers, fallback: R.isFallback() };
}

async function _inventoryLock(req) {
  const auth = _auth(req);
  const { productId, variantId, qty, lockId, ttlMs } = req.data || {};
  if (!productId || !lockId) throw new HttpsError('invalid-argument', 'productId and lockId required.');
  const ok = await R.inventoryLock(
    _san(productId, 50), _san(variantId || '', 50),
    Number(qty) || 1, _san(lockId, 64),
    Math.min(Number(ttlMs) || 120000, 300000)
  );
  return { ok, locked: ok, fallback: R.isFallback() };
}

async function _inventoryRelease(req) {
  const auth = _auth(req);
  const { productId, variantId, lockId } = req.data || {};
  if (!productId || !lockId) throw new HttpsError('invalid-argument', 'productId and lockId required.');
  const ok = await R.inventoryRelease(_san(productId, 50), _san(variantId || '', 50), _san(lockId, 64));
  return { ok, fallback: R.isFallback() };
}

async function _dashboardGet(req) {
  const auth = _auth(req);
  const { shopId } = req.data || {};
  const targetId = _isAdmin(auth.token) ? (shopId || 'platform') : (shopId || auth.uid);
  const metrics = await R.dashboardGet(_san(targetId, 50));
  return { metrics, fallback: R.isFallback() };
}

async function _dashboardSet(req) {
  const auth = _auth(req);
  const { shopId, metrics, ttl } = req.data || {};
  if (!metrics || typeof metrics !== 'object') throw new HttpsError('invalid-argument', 'metrics object required.');
  const safe = {};
  Object.entries(metrics).forEach(([k, v]) => {
    if (/^[a-zA-Z0-9_:]+$/.test(k) && (typeof v === 'number' || !isNaN(Number(v)))) safe[k] = Number(v);
  });
  const ok = await R.dashboardSet(_san(shopId || auth.uid, 50), safe, Math.min(Number(ttl) || 60, 3600));
  return { ok, fallback: R.isFallback() };
}

async function _dashboardIncr(req) {
  const auth = _auth(req);
  const { shopId, metric, by } = req.data || {};
  if (!metric || !/^[a-zA-Z0-9_:]+$/.test(metric)) throw new HttpsError('invalid-argument', 'Valid metric name required.');
  const val = await R.dashboardIncr(_san(shopId || auth.uid, 50), metric, Number(by) || 1);
  return { val, fallback: R.isFallback() };
}

async function _cacheGet(req) {
  _auth(req);
  const { key } = req.data || {};
  if (!key) throw new HttpsError('invalid-argument', 'key required.');
  const value = await R.cacheGet(_san(key, 200));
  return { value, hit: value !== null, fallback: R.isFallback() };
}

async function _cacheSet(req) {
  _auth(req);
  const { key, value, ttl } = req.data || {};
  if (!key || value === undefined) throw new HttpsError('invalid-argument', 'key and value required.');
  const ok = await R.cacheSet(_san(key, 200), value, Math.min(Number(ttl) || 300, 86400));
  return { ok, fallback: R.isFallback() };
}

async function _paymentLock(req) {
  const auth = _auth(req);
  const { orderId, lockId, ttlMs } = req.data || {};
  if (!orderId || !lockId) throw new HttpsError('invalid-argument', 'orderId and lockId required.');
  const ok = await R.paymentLock(_san(orderId, 100), _san(lockId, 64), Math.min(Number(ttlMs) || 60000, 180000));
  return { ok, acquired: ok, fallback: R.isFallback() };
}

async function _paymentUnlock(req) {
  const auth = _auth(req);
  const { orderId, lockId } = req.data || {};
  if (!orderId || !lockId) throw new HttpsError('invalid-argument', 'orderId and lockId required.');
  const ok = await R.paymentUnlock(_san(orderId, 100), _san(lockId, 64));
  return { ok, fallback: R.isFallback() };
}

async function _paymentSetState(req) {
  const auth = _auth(req);
  const { orderId, state, meta } = req.data || {};
  if (!orderId || !state) throw new HttpsError('invalid-argument', 'orderId and state required.');
  const validStates = ['pending', 'processing', 'completed', 'failed', 'refunded', 'expired'];
  if (!validStates.includes(state)) throw new HttpsError('invalid-argument', `state must be one of: ${validStates.join(', ')}`);
  const safeMeta = {
    provider: _san(meta?.provider, 30),
    reference: _san(meta?.reference, 100),
    amount: Number(meta?.amount) || 0,
    currency: _san(meta?.currency, 5),
    uid: auth.uid,
  };
  const ok = await R.paymentSetState(_san(orderId, 100), state, safeMeta);
  await R.eventPublish('payments', { type: `payment_${state}`, orderId, uid: auth.uid, ...safeMeta });
  return { ok, fallback: R.isFallback() };
}

async function _paymentGetState(req) {
  const auth = _auth(req);
  const { orderId } = req.data || {};
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId required.');
  const payment = await R.paymentGetState(_san(orderId, 100));
  if (payment && payment.uid !== auth.uid && !_isAdmin(auth.token)) {
    throw new HttpsError('permission-denied', 'Access denied.');
  }
  return { payment, fallback: R.isFallback() };
}

async function _eventPublish(req) {
  const auth = _auth(req);
  const { stream, event } = req.data || {};
  if (!stream || !event?.type) throw new HttpsError('invalid-argument', 'stream and event.type required.');
  const validStreams = ['orders', 'payments', 'inventory', 'riders', 'delivery', 'reviews', 'notifications', 'ai', 'pos'];
  if (!validStreams.includes(stream)) throw new HttpsError('invalid-argument', 'Invalid stream name.');
  const id = await R.eventPublish(_san(stream, 30), { ...event, uid: auth.uid });
  return { id, fallback: R.isFallback() };
}

async function _eventRead(req) {
  const auth = _auth(req);
  const { stream, lastId, count } = req.data || {};
  if (!stream) throw new HttpsError('invalid-argument', 'stream required.');
  if (!_isAdmin(auth.token)) throw new HttpsError('permission-denied', 'Admin required for event reading.');
  const events = await R.eventRead(_san(stream, 30), lastId || '0-0', Math.min(Number(count) || 50, 500));
  return { events, fallback: R.isFallback() };
}

async function _queuePush(req) {
  const auth = _auth(req);
  if (!_isAdmin(auth.token)) throw new HttpsError('permission-denied', 'Admin required.');
  const { queueName, job, priority } = req.data || {};
  if (!queueName || !job) throw new HttpsError('invalid-argument', 'queueName and job required.');
  const validQueues = ['email', 'receipt', 'image', 'ai', 'report', 'bulk', 'notification', 'sms'];
  if (!validQueues.includes(queueName)) throw new HttpsError('invalid-argument', 'Invalid queue name.');
  const id = await R.queuePush(_san(queueName, 30), { ...job, _requestedBy: auth.uid }, priority || 'normal');
  return { id, fallback: R.isFallback() };
}

async function _queueDepth(req) {
  const auth = _auth(req);
  if (!_isAdmin(auth.token)) throw new HttpsError('permission-denied', 'Admin required.');
  const { queueName } = req.data || {};
  if (queueName) {
    const depth = await R.queueDepth(_san(queueName, 30));
    return { depth, fallback: R.isFallback() };
  }
  const depths = await R.queueDepthAll();
  return { depths, fallback: R.isFallback() };
}

async function _rateCheck(req) {
  const auth = _auth(req);
  if (!_isAdmin(auth.token)) throw new HttpsError('permission-denied', 'Admin required.');
  const { identifier, action, maxRequests, windowMs } = req.data || {};
  if (!identifier || !action) throw new HttpsError('invalid-argument', 'identifier and action required.');
  const result = await R.rateLimit(
    _san(identifier, 100), _san(action, 50),
    Number(maxRequests) || 100, Number(windowMs) || 60000
  );
  return { ...result, fallback: R.isFallback() };
}

async function _adminMetrics(req) {
  const auth = _auth(req);
  if (!_isAdmin(auth.token)) throw new HttpsError('permission-denied', 'Admin required.');
  const info = await R.adminInfo();
  return info;
}

// ─── Handler registry (op name → handler) ────────────────────────────────────

const _H = {
  redisSessionCreate:      _sessionCreate,
  redisSessionGet:         _sessionGet,
  redisSessionRevoke:      _sessionRevoke,
  redisSessionRevokeAll:   _sessionRevokeAll,
  redisSessionList:        _sessionList,
  redisPresenceHeartbeat:  _presenceHeartbeat,
  redisPresenceGet:        _presenceGet,
  redisPresenceRemove:     _presenceRemove,
  redisPosSetState:        _posSetState,
  redisPosGetState:        _posGetState,
  redisPosPublish:         _posPublish,
  redisInventoryLock:      _inventoryLock,
  redisInventoryRelease:   _inventoryRelease,
  redisDashboardGet:       _dashboardGet,
  redisDashboardSet:       _dashboardSet,
  redisDashboardIncr:      _dashboardIncr,
  redisCacheGet:           _cacheGet,
  redisCacheSet:           _cacheSet,
  redisPaymentLock:        _paymentLock,
  redisPaymentUnlock:      _paymentUnlock,
  redisPaymentSetState:    _paymentSetState,
  redisPaymentGetState:    _paymentGetState,
  redisEventPublish:       _eventPublish,
  redisEventRead:          _eventRead,
  redisQueuePush:          _queuePush,
  redisQueueDepth:         _queueDepth,
  redisRateCheck:          _rateCheck,
  redisAdminMetrics:       _adminMetrics,
};

// ─── DISPATCHER — single Cloud Run service replacing 28 individual ones ───────

exports.redisDispatch = onCall({ ..._CF_OPTS, timeoutSeconds: 30 }, async (req) => {
  const op = req.data?.op;
  if (!op || typeof op !== 'string') throw new HttpsError('invalid-argument', '"op" field required.');
  const handler = _H[op];
  if (!handler) throw new HttpsError('not-found', `Unknown Redis operation: "${op}". Valid ops: ${Object.keys(_H).join(', ')}`);
  return handler(req);
});

// ─── SCHEDULED: Presence Cleanup ─────────────────────────────────────────────

exports.redisScheduledPresenceCleanup = onSchedule(
  { schedule: '*/5 * * * *', ..._SCHED_OPTS },
  async () => {
    const roles = ['buyer', 'seller', 'cashier', 'manager', 'rider', 'driver', 'admin', 'superAdmin', 'pos', 'printer', 'scanner'];
    let total = 0;
    for (const role of roles) {
      const members = await R.presenceGet(role);
      total += members.length;
    }
    console.log(JSON.stringify({ severity: 'INFO', message: `[Redis] Presence cleanup: ${total} live members` }));
  }
);

// ─── SCHEDULED: Queue Worker ──────────────────────────────────────────────────

exports.redisScheduledQueueWorker = onSchedule(
  { schedule: '* * * * *', ..._SCHED_OPTS },
  async () => {
    const queues = ['payment', 'receipt', 'email', 'notification', 'sms', 'ai', 'report', 'bulk'];
    const BATCH  = 10;
    let totalProcessed = 0;
    let totalFailed    = 0;

    for (const q of queues) {
      let jobs;
      try {
        jobs = await R.QueueService.pop(q, BATCH);
      } catch (err) {
        console.warn(JSON.stringify({ severity: 'WARNING', message: `[Redis Queue] Pop failed for ${q}`, error: err.message }));
        continue;
      }
      if (!jobs || !jobs.length) continue;

      console.log(JSON.stringify({ severity: 'INFO', message: `[Redis Queue] Processing ${jobs.length} ${q} jobs`, queue: q, count: jobs.length }));

      for (const job of jobs) {
        try {
          await dispatch(q, job);
          totalProcessed++;
        } catch (err) {
          totalFailed++;
          console.error(JSON.stringify({ severity: 'ERROR', message: `[Redis Queue] Job dispatch failed`, queue: q, jobId: job._id || job.id, error: err.message }));
        }
      }
    }

    console.log(JSON.stringify({ severity: 'INFO', message: `[Redis Queue] Worker cycle complete`, processed: totalProcessed, failed: totalFailed }));
  }
);
