'use strict';

/* ================================================================
   SOKONI API Gateway v1.0
   functions/api-gateway.js  |  2026-07-08

   Centralized entry point for all SOKONI API traffic.
   Implements a full middleware pipeline:
     1. CORS                — origin allowlist
     2. Rate Limiting       — per-IP + per-UID sliding window (Firestore)
     3. Authentication      — Firebase ID token verification
     4. API Versioning      — /api/v{N}/... parsing
     5. Request Validation  — Content-Type + 1 MB body cap
     6. Request Logging     — async fire-and-forget to _gwRequestLog
     7. Routing             — maps paths to handlers / upstream CFs
     8. Response Transform  — standard { success, version, requestId, data } envelope
     9. Performance Headers — X-Response-Time, X-Request-ID, Cache-Control

   Exports:
     sokoniAPIGateway  — onRequest  — public entry point
     gwGetMetrics      — onCall     — gateway analytics (admin only)
     gwManageRateLimit — onCall     — rate limit CRUD (admin only)
================================================================ */

const functions      = require('firebase-functions/v2');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const admin          = require('firebase-admin');
const crypto         = require('crypto');
const https          = require('https');
const { URL }        = require('url');
const { FieldValue } = require('firebase-admin/firestore');

if (!admin.apps.length) admin.initializeApp();

const db     = () => admin.firestore();
const logger = functions.logger;

/* ── Region & project ───────────────────────────────────────────── */
const REGION     = 'us-central1';
const PROJECT_ID = 'sokoni-aeb26';
const CF_BASE    = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net`;

/* ── CORS ─────────────────────────────────────────────────────────
   Order matters: most-specific first.
   mysokoni.co.ke origins are production; localhost variants are dev. */
const ALLOWED_ORIGINS = new Set([
  'https://mysokoni.co.ke',
  'https://www.mysokoni.co.ke',
  'https://app.mysokoni.co.ke',
  'http://localhost:3000',
  'http://localhost:5000',
]);

/* ── Rate limits: requests per 15-minute sliding window ───────────
   Anonymous callers are identified by IP.
   Authenticated callers are identified by UID.
   Admin callers get a much larger allowance.                       */
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

const RATE_LIMITS = {
  anonymous:     100,
  authenticated: 1000,
  admin:         5000,
};

/* ── Supported API versions ───────────────────────────────────── */
const SUPPORTED_VERSIONS = new Set(['v1', 'v2']);

const V2_FEATURES = [
  'streaming',
  'batch-requests',
  'graphql',
  'websocket',
  'edge-caching',
  'compression',
  'priority-routing',
  'webhook-events',
];

/* ── Request body cap ─────────────────────────────────────────── */
const BODY_SIZE_LIMIT_BYTES = 1 * 1024 * 1024; // 1 MB

/* ═══════════════════════════════════════════════════════════════
   UTILITY HELPERS
═══════════════════════════════════════════════════════════════ */

function _genRequestId() {
  return 'gw_' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
}

/** Extract real client IP, respecting Cloud Run's X-Forwarded-For chain. */
function _clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'] || '';
  return forwarded.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

/** Derive auth tier from verified token claims. */
function _tierFromToken(token) {
  if (!token) return 'anonymous';
  if (token.admin === true || token.superAdmin === true) return 'admin';
  return 'authenticated';
}

/** Derive display role from token for response context. */
function _roleFromToken(token) {
  if (!token) return 'anonymous';
  if (token.superAdmin)   return 'superAdmin';
  if (token.admin)        return 'admin';
  if (token.moderator)    return 'moderator';
  if (token.seller)       return 'seller';
  if (token.business)     return 'business';
  if (token.driver)       return 'driver';
  if (token.professional) return 'professional';
  return 'user';
}

/* ═══════════════════════════════════════════════════════════════
   MIDDLEWARE 1 — CORS
   Returns false and sends response if this was a preflight.
   Returns true if processing should continue.
═══════════════════════════════════════════════════════════════ */
function _applyCors(req, res) {
  const origin  = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.has(origin);

  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Request-ID, X-Firebase-AppCheck');
  res.set('Access-Control-Max-Age', '86400');

  if (allowed) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
  } else {
    /* Non-allowlisted origins receive the primary origin in the header
       (browser will block the request — this is intentional). */
    res.set('Access-Control-Allow-Origin', 'https://mysokoni.co.ke');
  }

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return false; // preflight handled
  }
  return true; // continue processing
}

/* ═══════════════════════════════════════════════════════════════
   MIDDLEWARE 2 — RATE LIMITING
   Sliding window via Firestore transaction.
   Documents in _gwRateLimit/{tier}:{encodedKey} store:
     windowStart (ms), count, ip, tier, expiresAt (TTL marker)
═══════════════════════════════════════════════════════════════ */

/**
 * @param {string} key    — encoded IP or UID
 * @param {string} tier   — 'anonymous' | 'authenticated' | 'admin'
 * @param {string} ip     — for audit
 * @returns {{ allowed: boolean, remaining: number, retryAfter: number, limit: number }}
 */
async function _checkRateLimit(key, tier, ip) {
  const firestore = db();
  const limit     = RATE_LIMITS[tier] ?? RATE_LIMITS.anonymous;
  const docId     = `${tier}:${Buffer.from(key).toString('base64url')}`;
  const docRef    = firestore.collection('_gwRateLimit').doc(docId);

  /* ── Check whitelist / blacklist first ──────────────────────── */
  try {
    const cfgSnap = await firestore.collection('_gwRateLimitConfig').doc(key).get();
    if (cfgSnap.exists) {
      const cfg = cfgSnap.data();
      if (cfg.blacklisted === true) {
        return { allowed: false, remaining: 0, retryAfter: 3600, limit, blacklisted: true };
      }
      if (cfg.whitelisted === true) {
        return { allowed: true, remaining: limit, retryAfter: 0, limit };
      }
    }
  } catch (e) {
    /* Config read failure is non-fatal — continue with standard rate check */
    logger.warn('[gateway] _gwRateLimitConfig read failed', { key, error: e.message });
  }

  /* ── Sliding window transaction ─────────────────────────────── */
  const result = await firestore.runTransaction(async tx => {
    const snap = await tx.get(docRef);
    const now  = Date.now();

    if (!snap.exists || (now - (snap.data().windowStart || 0)) >= RATE_WINDOW_MS) {
      /* Start a fresh window */
      const data = {
        windowStart: now,
        count: 1,
        ip,
        tier,
        expiresAt: admin.firestore.Timestamp.fromMillis(now + RATE_WINDOW_MS + 120_000),
      };
      tx.set(docRef, data);
      return { count: 1, windowStart: now };
    }

    const prev     = snap.data();
    const newCount = (prev.count || 0) + 1;
    tx.update(docRef, {
      count:     newCount,
      expiresAt: admin.firestore.Timestamp.fromMillis(prev.windowStart + RATE_WINDOW_MS + 120_000),
    });
    return { count: newCount, windowStart: prev.windowStart };
  });

  const remaining  = Math.max(0, limit - result.count);
  const resetMs    = result.windowStart + RATE_WINDOW_MS;
  const retryAfter = result.count > limit
    ? Math.max(1, Math.ceil((resetMs - Date.now()) / 1000))
    : 0;

  return { allowed: result.count <= limit, remaining, retryAfter, limit };
}

/* ═══════════════════════════════════════════════════════════════
   MIDDLEWARE 3 — AUTHENTICATION
   Verifies Firebase ID token from Authorization: Bearer header.
   Missing token → anonymous session (uid=null, role='anonymous').
   Invalid token → 401 error.
═══════════════════════════════════════════════════════════════ */
async function _verifyAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { uid: null, role: 'anonymous', tier: 'anonymous', token: null };
  }

  const idToken = authHeader.slice(7).trim();
  if (!idToken) {
    return { uid: null, role: 'anonymous', tier: 'anonymous', token: null };
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return {
      uid:   decoded.uid,
      role:  _roleFromToken(decoded),
      tier:  _tierFromToken(decoded),
      token: decoded,
    };
  } catch (err) {
    return { authError: 'Invalid or expired authorization token.' };
  }
}

/* ═══════════════════════════════════════════════════════════════
   MIDDLEWARE 4 — API VERSIONING
   Parses /api/v{N}/{rest} from the request path.
   Defaults to v1 if path is /api/{rest} with no version prefix.
   Returns { version, routePath } or { unsupported } on bad version.
═══════════════════════════════════════════════════════════════ */
function _parseVersion(path) {
  /* Explicit version: /api/v1/..., /api/v2/... */
  const vMatch = path.match(/^\/api\/(v\d+)(\/.*)?$/i);
  if (vMatch) {
    const version   = vMatch[1].toLowerCase();
    const routePath = vMatch[2] || '/';
    if (!SUPPORTED_VERSIONS.has(version)) {
      return { version: null, routePath: null, unsupported: version };
    }
    return { version, routePath };
  }

  /* No version prefix — default to v1: /api/... */
  const apiMatch = path.match(/^\/api(\/.*)?$/i);
  if (apiMatch) {
    return { version: 'v1', routePath: apiMatch[1] || '/' };
  }

  return { version: null, routePath: null };
}

/* ═══════════════════════════════════════════════════════════════
   MIDDLEWARE 5 — REQUEST VALIDATION
   Enforces Content-Type on write methods.
   Enforces 1 MB body cap via Content-Length header.
═══════════════════════════════════════════════════════════════ */
function _validateRequest(req) {
  const method = req.method.toUpperCase();

  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    const validCt = ct.includes('application/json')
      || ct.includes('multipart/form-data')
      || ct.includes('application/x-www-form-urlencoded');

    if (!validCt) {
      return {
        valid: false,
        error: 'Content-Type must be application/json (or multipart/form-data) for write operations.',
      };
    }

    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (!isNaN(contentLength) && contentLength > BODY_SIZE_LIMIT_BYTES) {
      return { valid: false, error: 'Request body exceeds the 1 MB limit.' };
    }
  }

  return { valid: true };
}

/* ═══════════════════════════════════════════════════════════════
   MIDDLEWARE 6 — REQUEST LOGGING
   Fire-and-forget write to _gwRequestLog/{requestId}.
   Never blocks the response pipeline.
═══════════════════════════════════════════════════════════════ */
function _logRequest({ requestId, req, uid, version, startTime, responseTimeMs, statusCode }) {
  db().collection('_gwRequestLog').doc(requestId).set({
    requestId,
    path:           req.path,
    method:         req.method,
    uid:            uid || null,
    ip:             _clientIp(req),
    userAgent:      (req.headers['user-agent'] || '').slice(0, 300),
    version:        version || 'v1',
    timestamp:      FieldValue.serverTimestamp(),
    startTime,
    responseTimeMs: responseTimeMs || null,
    statusCode:     statusCode || null,
  }).catch(err => {
    logger.warn('[gateway] request log write failed', { requestId, error: err.message });
  });
}

/* ═══════════════════════════════════════════════════════════════
   RESPONSE HELPERS
   All responses are wrapped in the standard envelope.
═══════════════════════════════════════════════════════════════ */
function _success(res, data, { version, requestId, startTime, status = 200, cacheControl }) {
  const responseTimeMs = Date.now() - startTime;
  res.set('X-Response-Time', `${responseTimeMs}ms`);
  res.set('X-Request-ID', requestId);
  if (cacheControl) res.set('Cache-Control', cacheControl);
  return res.status(status).json({ success: true, version, requestId, data });
}

function _error(res, httpStatus, code, message, { version = 'v1', requestId, startTime }) {
  const responseTimeMs = Date.now() - startTime;
  res.set('X-Response-Time', `${responseTimeMs}ms`);
  res.set('X-Request-ID', requestId);
  res.set('Cache-Control', 'no-store');
  return res.status(httpStatus).json({
    success: false,
    version,
    requestId,
    error: { code, message },
  });
}

/* ═══════════════════════════════════════════════════════════════
   UPSTREAM PROXY HELPER
   Forwards the request to another Cloud Function's HTTP endpoint.
   Propagates the Authorization header so the downstream CF can
   authenticate the original caller.
═══════════════════════════════════════════════════════════════ */
async function _proxyToFunction(functionName, req) {
  return new Promise((resolve, reject) => {
    try {
      const targetUrl = `${CF_BASE}/${functionName}`;
      const u         = new URL(targetUrl);
      const method    = req.method.toUpperCase();
      const hasBody   = ['POST', 'PUT', 'PATCH'].includes(method);
      const bodyStr   = hasBody ? JSON.stringify(req.body || {}) : null;

      const headers = {
        'Content-Type'     : 'application/json',
        'User-Agent'       : 'SOKONI-Gateway/1.0',
        'X-Forwarded-For'  : _clientIp(req),
        'X-Gateway-Origin' : 'sokoniAPIGateway',
      };
      if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
      if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

      /* Append original query string */
      const queryStr = new URLSearchParams(req.query || {}).toString();
      const path     = u.pathname + (queryStr ? `?${queryStr}` : '');

      const proxyReq = https.request(
        { hostname: u.hostname, port: 443, path, method, headers },
        proxyRes => {
          let raw = '';
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', c => { raw += c; });
          proxyRes.on('end', () => {
            let body;
            try { body = JSON.parse(raw); } catch { body = { raw: raw.slice(0, 1024) }; }
            resolve({ statusCode: proxyRes.statusCode || 200, body });
          });
        }
      );

      proxyReq.setTimeout(15_000, () => {
        proxyReq.destroy(new Error('Upstream request timed out'));
      });
      proxyReq.on('error', reject);

      if (bodyStr) proxyReq.write(bodyStr);
      proxyReq.end();
    } catch (err) {
      reject(err);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   MIDDLEWARE 7 — ROUTE HANDLERS
═══════════════════════════════════════════════════════════════ */
async function _handleRoute(req, res, { routePath, version, requestId, auth, startTime }) {
  const method   = req.method.toUpperCase();
  const isAuthed = !!auth.uid;

  /* ── v1 routes ─────────────────────────────────────────────── */
  if (version === 'v1') {

    /* GET /api/v1/health */
    if (method === 'GET' && routePath === '/health') {
      return _success(res,
        { status: 'ok', version: 'v1', region: REGION, timestamp: new Date().toISOString() },
        { version, requestId, startTime, cacheControl: 'no-store' }
      );
    }

    /* GET /api/v1/search → proxy to sokoniSearch CF */
    if (method === 'GET' && routePath === '/search') {
      try {
        const upstream = await _proxyToFunction('sokoniSearch', req);
        return _success(res, upstream.body,
          { version, requestId, startTime, status: upstream.statusCode,
            cacheControl: 'public, max-age=30, s-maxage=60' }
        );
      } catch (err) {
        logger.error('[gateway] sokoniSearch proxy error', { requestId, error: err.message });
        return _error(res, 503, 'gateway/upstream-unavailable',
          'Search service is temporarily unavailable. Please try again.',
          { version, requestId, startTime }
        );
      }
    }

    /* POST /api/v1/orders → proxy to createOrder CF (auth required) */
    if (method === 'POST' && routePath === '/orders') {
      if (!isAuthed) {
        return _error(res, 401, 'auth/unauthenticated',
          'Authentication is required to create orders.',
          { version, requestId, startTime }
        );
      }
      try {
        const upstream = await _proxyToFunction('createOrder', req);
        return _success(res, upstream.body,
          { version, requestId, startTime, status: upstream.statusCode,
            cacheControl: 'no-store' }
        );
      } catch (err) {
        logger.error('[gateway] createOrder proxy error', { requestId, error: err.message });
        return _error(res, 503, 'gateway/upstream-unavailable',
          'Order service is temporarily unavailable. Please try again.',
          { version, requestId, startTime }
        );
      }
    }

    /* GET /api/v1/products → serve from Firestore with pagination */
    if (method === 'GET' && routePath === '/products') {
      try {
        const { category, limit: qLimit, cursor } = req.query || {};
        const pageSize = Math.min(Math.max(1, parseInt(qLimit || '24', 10)), 100);

        let query = db().collection('products')
          .where('status', '==', 'active')
          .orderBy('createdAt', 'desc')
          .limit(pageSize + 1);

        if (category) query = query.where('category', '==', category);

        if (cursor) {
          const cursorDoc = await db().collection('products').doc(cursor).get();
          if (cursorDoc.exists) query = query.startAfter(cursorDoc);
        }

        const snap    = await query.get();
        const hasMore = snap.size > pageSize;
        const items   = snap.docs.slice(0, pageSize).map(d => {
          const data = d.data();
          return {
            id:       d.id,
            name:     data.name     || '',
            slug:     data.slug     || d.id,
            price:    data.price    ?? null,
            currency: data.currency || 'KES',
            category: data.category || null,
            images:   Array.isArray(data.images) ? data.images.slice(0, 5) : [],
            shopId:   data.shopId   || null,
            rating:   data.rating   ?? null,
            inStock:  data.inStock  !== false,
          };
        });

        return _success(res,
          { products: items, hasMore, nextCursor: hasMore ? snap.docs[pageSize - 1].id : null },
          { version, requestId, startTime, cacheControl: 'public, max-age=60, s-maxage=300' }
        );
      } catch (err) {
        logger.error('[gateway] products Firestore error', { requestId, error: err.message });
        return _error(res, 500, 'gateway/internal-error',
          'Failed to fetch products.',
          { version, requestId, startTime }
        );
      }
    }
  }

  /* ── v2 routes ─────────────────────────────────────────────── */
  if (version === 'v2') {

    /* GET /api/v2/health */
    if (method === 'GET' && routePath === '/health') {
      return _success(res,
        { status: 'ok', version: 'v2', features: V2_FEATURES,
          region: REGION, timestamp: new Date().toISOString() },
        { version, requestId, startTime, cacheControl: 'no-store' }
      );
    }
  }

  /* ── 404 fallback ──────────────────────────────────────────── */
  return _error(res, 404, 'gateway/route-not-found',
    `Route not found: ${method} ${routePath}`,
    { version, requestId, startTime }
  );
}

/* ═══════════════════════════════════════════════════════════════
   sokoniAPIGateway — onRequest — PUBLIC ENTRY POINT
   This is the only public-facing HTTP endpoint in the file.
   Every other export is an admin-only onCall function.
═══════════════════════════════════════════════════════════════ */
exports.sokoniAPIGateway = onRequest(
  {
    region:         REGION,
    timeoutSeconds: 60,
    memory:         '512MiB',
    minInstances:   0,
    cors:           false, // Manual CORS — see _applyCors()
  },
  async (req, res) => {
    const startTime = Date.now();
    const requestId = _genRequestId();

    /* Base headers — set immediately so they appear even on early exits */
    res.set('X-Request-ID', requestId);
    res.set('X-Powered-By', 'SOKONI-Gateway/1.0');

    let auth    = { uid: null, role: 'anonymous', tier: 'anonymous', token: null };
    let version = 'v1';

    try {
      /* ── 1. CORS ────────────────────────────────────────────── */
      if (!_applyCors(req, res)) return; // preflight handled

      /* ── 3. Auth (before rate limiting to know the tier) ────── */
      const authResult = await _verifyAuth(req);
      if (authResult.authError) {
        return _error(res, 401, 'auth/invalid-token', authResult.authError,
          { version, requestId, startTime });
      }
      auth = authResult;

      /* ── 2. Rate limiting ───────────────────────────────────── */
      const ip    = _clientIp(req);
      const tier  = auth.tier;

      /* Always enforce IP-based anonymous limit as the floor */
      const ipKey  = `ip:${ip}`;
      const uidKey = auth.uid ? `uid:${auth.uid}` : null;

      const [ipRl, uidRl] = await Promise.all([
        _checkRateLimit(ipKey, 'anonymous', ip),
        uidKey ? _checkRateLimit(uidKey, tier, ip) : Promise.resolve({ allowed: true, remaining: RATE_LIMITS[tier], retryAfter: 0, limit: RATE_LIMITS[tier] }),
      ]);

      /* Enforce most-restrictive limit (IP blacklist takes precedence) */
      const blocked = ipRl.blacklisted ? ipRl : (!ipRl.allowed ? ipRl : (!uidRl.allowed ? uidRl : null));
      if (blocked) {
        res.set('Retry-After',          String(blocked.retryAfter));
        res.set('X-RateLimit-Limit',    String(blocked.limit));
        res.set('X-RateLimit-Remaining','0');
        res.set('X-RateLimit-Reset',
          String(Math.floor(Date.now() / 1000) + blocked.retryAfter));
        return _error(res, 429, 'gateway/rate-limit-exceeded',
          'Too many requests. Please slow down and try again later.',
          { version, requestId, startTime });
      }

      /* Expose rate limit status to caller */
      const activeRl = uidKey ? uidRl : ipRl;
      res.set('X-RateLimit-Limit',     String(activeRl.limit));
      res.set('X-RateLimit-Remaining', String(activeRl.remaining));

      /* ── 4. API versioning ──────────────────────────────────── */
      const parsed = _parseVersion(req.path);
      if (!parsed.version) {
        const msg = parsed.unsupported
          ? `API version '${parsed.unsupported}' is not supported. Supported: v1, v2.`
          : 'Invalid API path. Expected /api/v1/... or /api/v2/...';
        return _error(res, 404, 'gateway/version-not-found', msg,
          { version, requestId, startTime });
      }
      version = parsed.version;

      /* ── 5. Request validation ──────────────────────────────── */
      const validation = _validateRequest(req);
      if (!validation.valid) {
        return _error(res, 400, 'gateway/invalid-request', validation.error,
          { version, requestId, startTime });
      }

      /* ── 6. Request logging (async fire-and-forget) ─────────── */
      /* Log is written after routing so we can capture responseTimeMs. */
      /* See bottom of try-block for the actual log write. */

      /* ── 7–9. Routing → response ────────────────────────────── */
      const result = await _handleRoute(req, res, {
        routePath: parsed.routePath,
        version,
        requestId,
        auth,
        startTime,
      });

      /* ── 6. Log with final response time ────────────────────── */
      _logRequest({
        requestId, req,
        uid:           auth.uid,
        version,
        startTime,
        responseTimeMs: Date.now() - startTime,
        statusCode:     res.statusCode,
      });

      return result;

    } catch (err) {
      logger.error('[gateway] Unhandled exception', {
        requestId,
        error:   err.message,
        stack:   err.stack,
        path:    req.path,
        method:  req.method,
      });
      _logRequest({ requestId, req, uid: auth.uid, version, startTime,
        responseTimeMs: Date.now() - startTime, statusCode: 500 });
      return _error(res, 500, 'gateway/internal-error',
        'An internal error occurred. Please try again.',
        { version, requestId, startTime });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   gwGetMetrics — onCall — admin only
   Gateway analytics for the last 24 hours.

   Returns:
     totalRequests       — count of logged requests
     byRoute             — top 20 routes by request count
     byVersion           — requests split by API version
     byAuthLevel         — anonymous vs authenticated split
     p95ResponseTimes    — P95 latency per route (ms)
     rateLimitHits       — count of docs currently over their limit
     topIps              — top 10 IPs by request count
     generatedAt         — ISO timestamp
═══════════════════════════════════════════════════════════════ */
exports.gwGetMetrics = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: true },
  async req => {
    if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) {
      throw new HttpsError('permission-denied', 'Admin access required.');
    }

    const firestore = db();
    const since24h  = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
    const since1h   = admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);

    /* Parallel: request logs + active rate-limit docs */
    const [logsSnap, rlSnap] = await Promise.all([
      firestore.collection('_gwRequestLog')
        .where('timestamp', '>=', since24h)
        .orderBy('timestamp', 'desc')
        .limit(5000) // cap to avoid OOM
        .get(),
      firestore.collection('_gwRateLimit')
        .where('expiresAt', '>=', admin.firestore.Timestamp.now())
        .limit(500)
        .get(),
    ]);

    /* ── Aggregate logs ──────────────────────────────────────── */
    const byRoute      = {};
    const byVersion    = {};
    const byAuth       = { anonymous: 0, authenticated: 0, admin: 0 };
    const topIpMap     = {};
    const rtByRoute    = {}; // route → responseTimeMs[]
    const recentErrors = { '4xx': 0, '5xx': 0 };

    for (const doc of logsSnap.docs) {
      const d    = doc.data();
      const route = `${(d.method || 'GET').toUpperCase()} ${d.path || '/'}`;

      byRoute[route]   = (byRoute[route] || 0) + 1;
      byVersion[d.version || 'v1'] = (byVersion[d.version || 'v1'] || 0) + 1;

      const authLevel = !d.uid ? 'anonymous' : 'authenticated';
      byAuth[authLevel]++;

      const ip = d.ip || '';
      if (ip && ip !== 'unknown') {
        topIpMap[ip] = (topIpMap[ip] || 0) + 1;
      }

      if (d.responseTimeMs) {
        if (!rtByRoute[route]) rtByRoute[route] = [];
        rtByRoute[route].push(d.responseTimeMs);
      }

      if (d.statusCode) {
        if (d.statusCode >= 400 && d.statusCode < 500) recentErrors['4xx']++;
        if (d.statusCode >= 500)                        recentErrors['5xx']++;
      }
    }

    /* ── P95 per route ───────────────────────────────────────── */
    const p95ByRoute = {};
    for (const [route, times] of Object.entries(rtByRoute)) {
      if (times.length === 0) continue;
      const sorted = [...times].sort((a, b) => a - b);
      const idx    = Math.max(0, Math.floor(sorted.length * 0.95) - 1);
      p95ByRoute[route] = sorted[idx];
    }

    /* ── Rate-limit hits ─────────────────────────────────────── */
    let rateLimitHits = 0;
    for (const doc of rlSnap.docs) {
      const d     = doc.data();
      const tier  = d.tier || 'anonymous';
      const limit = RATE_LIMITS[tier] ?? RATE_LIMITS.anonymous;
      if ((d.count || 0) > limit) rateLimitHits++;
    }

    /* ── Top IPs ─────────────────────────────────────────────── */
    const topIps = Object.entries(topIpMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ip, count]) => ({ ip, count }));

    return {
      period:       '24h',
      totalRequests: logsSnap.size,
      byRoute: Object.entries(byRoute)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([route, count]) => ({ route, count })),
      byVersion,
      byAuthLevel:          byAuth,
      statusCodeBreakdown:  recentErrors,
      p95ResponseTimesByRoute: p95ByRoute,
      rateLimitHitsActive:     rateLimitHits,
      topIpsByRequestCount:    topIps,
      generatedAt:             new Date().toISOString(),
    };
  }
);

/* ═══════════════════════════════════════════════════════════════
   gwManageRateLimit — onCall — admin only
   Manage per-key rate limiting policies.

   Actions:
     whitelist — permanently exempt an IP or UID from limits
     blacklist — block all requests from an IP or UID
     reset     — clear current window counters for a key
═══════════════════════════════════════════════════════════════ */
exports.gwManageRateLimit = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: true },
  async req => {
    if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) {
      throw new HttpsError('permission-denied', 'Admin access required.');
    }

    const { action, key, type } = req.data || {};
    if (!action || typeof action !== 'string') {
      throw new HttpsError('invalid-argument', '"action" is required (whitelist | blacklist | reset).');
    }
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      throw new HttpsError('invalid-argument', '"key" is required (an IP address or UID).');
    }

    const firestore = db();
    const normalKey = key.trim();
    const configRef = firestore.collection('_gwRateLimitConfig').doc(normalKey);
    const callerUid = req.auth.uid;
    const now       = FieldValue.serverTimestamp();

    switch (action) {

      case 'whitelist': {
        if (!['ip', 'uid'].includes(type)) {
          throw new HttpsError('invalid-argument', '"type" must be "ip" or "uid" for whitelist action.');
        }
        await configRef.set({
          key:         normalKey,
          type,
          whitelisted: true,
          blacklisted: false,
          updatedBy:   callerUid,
          updatedAt:   now,
        }, { merge: true });

        logger.info('[gateway] Rate limit whitelist applied', { key: normalKey, type, by: callerUid });
        return { success: true, action: 'whitelist', key: normalKey, type };
      }

      case 'blacklist': {
        await configRef.set({
          key:         normalKey,
          blacklisted: true,
          whitelisted: false,
          updatedBy:   callerUid,
          updatedAt:   now,
        }, { merge: true });

        logger.info('[gateway] Rate limit blacklist applied', { key: normalKey, by: callerUid });
        return { success: true, action: 'blacklist', key: normalKey };
      }

      case 'reset': {
        /* Delete all rate-limit window documents for this key (all tier variants) */
        const batch     = firestore.batch();
        const encodedKey = Buffer.from(normalKey).toString('base64url');
        const tiers     = ['anonymous', 'authenticated', 'admin'];
        const prefixes  = ['ip', 'uid'];

        /* Tier-based keys (standard pattern) */
        for (const tier of tiers) {
          batch.delete(firestore.collection('_gwRateLimit').doc(`${tier}:${encodedKey}`));
        }
        /* Prefix-based keys (direct lookup variants) */
        for (const pfx of prefixes) {
          const encoded = Buffer.from(`${pfx}:${normalKey}`).toString('base64url');
          for (const tier of tiers) {
            batch.delete(firestore.collection('_gwRateLimit').doc(`${tier}:${encoded}`));
          }
        }

        await batch.commit();
        logger.info('[gateway] Rate limit reset', { key: normalKey, by: callerUid });
        return { success: true, action: 'reset', key: normalKey };
      }

      default:
        throw new HttpsError('invalid-argument',
          `Unknown action "${action}". Supported actions: whitelist, blacklist, reset.`);
    }
  }
);
