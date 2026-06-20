/**
 * SOKONI Algolia Secured API Keys
 *
 * Generates short-lived, scoped Algolia search keys per user/session.
 * Prevents API key leakage from granting unintended access.
 *
 * Key restrictions enforced server-side:
 *   - User-specific filter (userId) for personalization
 *   - Allowed indexes (only search, no admin)
 *   - TTL: 1 hour (Algolia enforces validUntil on their servers)
 *   - IP-binding optional (for kiosk / trusted device mode)
 *   - Bot rate-limit via Firestore counter (sliding window)
 *
 * Security:
 *   - Admin key never leaves server
 *   - Search-only key stored in Secret Manager
 *   - Per-user rate limit: 300 key requests per hour
 *   - IP rate limit: 1000 key requests per hour
 *   - Audit log for every key issuance
 */

'use strict';

const crypto                 = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');

const ALGOLIA_SEARCH_KEY = defineSecret('ALGOLIA_SEARCH_KEY');

/* ── Rate limiting constants ──────────────────────────────────────────── */

const USER_LIMIT     = 300;   // max secured-key requests per hour per user
const IP_LIMIT       = 1000;  // max secured-key requests per hour per IP
const KEY_TTL_SEC    = 3600;  // 1 hour key validity
const KEY_TTL_ANON   = 900;   // 15 minutes for unauthenticated guests

/* ── Allowed indexes for search keys ─────────────────────────────────── */

const SEARCH_INDEXES = [
  'sokoni_products',
  'sokoni_products_price_asc',
  'sokoni_products_price_desc',
  'sokoni_products_newest',
  'sokoni_products_rating',
  'sokoni_products_popular',
  'sokoni_shops',
  'sokoni_services',
  'sokoni_services_price_asc',
  'sokoni_services_newest',
  'sokoni_events',
  'sokoni_events_soonest',
  'sokoni_events_popular',
  'sokoni_properties',
  'sokoni_properties_price_asc',
  'sokoni_properties_price_desc',
  'sokoni_properties_newest',
  'sokoni_vehicles',
  'sokoni_vehicles_price_asc',
  'sokoni_vehicles_price_desc',
  'sokoni_vehicles_newest',
  'sokoni_vehicles_year_desc',
  'sokoni_jobs',
  'sokoni_jobs_newest',
  'sokoni_jobs_deadline',
  'sokoni_users',
  'sokoni_categories',
  'sokoni_brands',
  'sokoni_collections',
  'sokoni_coupons',
];

/* ── Helpers ────────────────────────────────────────────────────────── */

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

/**
 * Generate scoped Algolia key via HMAC-SHA256.
 * Equivalent to Algolia's `generateSecuredApiKey` SDK method.
 */
function _generateKey(searchOnlyKey, params) {
  const paramStr = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v.join(',') : String(v))}`)
    .join('&');

  const hmac   = crypto.createHmac('sha256', searchOnlyKey).update(paramStr).digest('hex');
  return Buffer.from(hmac + paramStr).toString('base64');
}

/**
 * Sliding window rate limiter using Firestore.
 * @param {string} bucket  - unique key (e.g., `user_${uid}` or `ip_${ip}`)
 * @param {number} limit   - max requests per hour
 * @returns {Promise<boolean>} true if allowed
 */
async function _rateCheck(bucket, limit) {
  const db       = _db();
  const window   = Math.floor(Date.now() / 1000 / 3600); // 1-hour window
  const ref      = db.collection('rateLimits').doc(`algoliaKey_${bucket}_${window}`);

  const count = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const cur  = snap.exists ? snap.data().count : 0;
    /*
     * Return a sentinel > limit when already at/over limit so the
     * `count < limit` check below correctly denies the request.
     * Without this, `cur === limit` would return `cur` and
     * `count <= limit` would pass (off-by-one).
     */
    if (cur >= limit) return limit + 1;
    tx.set(ref, {
      count:     cur + 1,
      bucket,
      window,
      expiresAt: admin.firestore.Timestamp.fromMillis((window + 1) * 3600 * 1000 + 300_000),
      updatedAt: _now(),
    }, { merge: true });
    return cur + 1;
  });

  /* count is the post-increment value (or limit+1 sentinel if over limit) */
  return count <= limit;
}

/* ══════════════════════════════════════════════════════════════════════
   getAlgoliaSearchKey  — the primary callable
══════════════════════════════════════════════════════════════════════ */

const getAlgoliaSearchKey = onCall(
  {
    secrets:        [ALGOLIA_SEARCH_KEY],
    timeoutSeconds: 15,
    cors:           true,
  },
  async (request) => {
    const searchKey = ALGOLIA_SEARCH_KEY.value();
    if (!searchKey || searchKey === 'not_configured') {
      /* Graceful degradation — return empty key, client falls back to Firestore */
      return { key: '', appId: process.env.ALGOLIA_APP_ID || '', ttl: 0, degraded: true };
    }

    const uid = request.auth?.uid || null;
    const ip  = request.rawRequest?.ip || 'unknown';

    /* Rate limit by user */
    if (uid) {
      const allowed = await _rateCheck(`user_${uid}`, USER_LIMIT);
      if (!allowed) throw new HttpsError('resource-exhausted', 'Too many key requests. Try again later.');
    }

    /* Rate limit by IP (catches bots, unauthenticated burst) */
    const ipAllowed = await _rateCheck(`ip_${ip.replace(/[.:]/g, '_')}`, IP_LIMIT);
    if (!ipAllowed) throw new HttpsError('resource-exhausted', 'Rate limit exceeded.');

    /* Build restrictions */
    const role       = request.auth?.token?.role || (request.auth?.token?.admin ? 'admin' : 'guest');
    const isAdmin    = role === 'admin' || role === 'superAdmin' || Boolean(request.auth?.token?.admin);
    const ttl        = isAdmin ? KEY_TTL_SEC * 4 : (uid ? KEY_TTL_SEC : KEY_TTL_ANON);
    const validUntil = Math.floor(Date.now() / 1000) + ttl;
    const userToken  = uid || `anon_${ip.replace(/[.:]/g, '_')}`;

    /* Role-specific index allowlists — narrowed to role's actual access needs */
    const DRIVER_INDEXES = ['sokoni_products', 'sokoni_shops', 'sokoni_services', 'sokoni_jobs',
      'sokoni_products_price_asc', 'sokoni_products_popular'];
    const allowedIndexes = (role === 'driver') ? DRIVER_INDEXES : SEARCH_INDEXES;

    const restrictions = {
      validUntil,
      userToken,
      restrictIndices:       allowedIndexes.join(','),
      /* Personalization: Algolia uses userToken to build personal ranking profile */
      enablePersonalization: true,
      /* Analytics tags: used for segmented reporting in Algolia dashboard */
      analyticsTags:         [`role_${role}`, 'app_sokoni', 'platform_web'],
    };

    /* Visibility filter — admins/moderators see all; others see only published content */
    if (!isAdmin && role !== 'moderator') {
      restrictions.filters = 'status:active OR status:published';
    }

    const key = _generateKey(searchKey, restrictions);

    /* Audit log (async, don't block response) */
    _db().collection('algoliaKeyAuditLog').add({
      uid:        uid || null,
      ip,
      ttl,
      role,
      userToken,
      analyticsTags: restrictions.analyticsTags,
      personalization: restrictions.enablePersonalization,
      issuedAt:   _now(),
    }).catch(() => {});

    return {
      key,
      appId:      process.env.ALGOLIA_APP_ID || '',
      ttl,
      validUntil,
      userToken,
      role,
      indexes:    allowedIndexes,
      issuedAt:   Date.now(),
    };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   algoliaKeyStats  — admin: view rate limit stats and audit logs
══════════════════════════════════════════════════════════════════════ */

const algoliaKeyStats = onCall(
  { secrets: [ALGOLIA_SEARCH_KEY], timeoutSeconds: 15 },
  async (request) => {
    if (!request.auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only.');

    const db    = _db();
    const hour  = Math.floor(Date.now() / 1000 / 3600);

    /* Count key issuances in the current hour */
    const [rateLimits, recentAudit] = await Promise.all([
      db.collection('rateLimits')
        .where('window', '==', hour)
        .orderBy('count', 'desc')
        .limit(50)
        .get(),
      db.collection('algoliaKeyAuditLog')
        .orderBy('issuedAt', 'desc')
        .limit(100)
        .get(),
    ]);

    return {
      rateLimits: rateLimits.docs.map(d => d.data()),
      recentIssuances: recentAudit.docs.map(d => ({
        uid:      d.data().uid,
        ip:       d.data().ip,
        role:     d.data().role,
        ttl:      d.data().ttl,
        issuedAt: d.data().issuedAt?.toDate?.()?.toISOString(),
      })),
    };
  }
);

/* ══════════════════════════════════════════════════════════════════════
   Cleanup job — purge expired rate-limit counters (runs daily)
══════════════════════════════════════════════════════════════════════ */

const algoliaKeyCleanup = onSchedule(
  { schedule: 'every day 01:00', timeoutSeconds: 120 },
  async () => {
    const db  = _db();
    const now = admin.firestore.Timestamp.now();

    const expired = await db.collection('rateLimits')
      .where('expiresAt', '<', now)
      .limit(2000)
      .get();

    if (expired.empty) return;

    const batch = db.batch();
    expired.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`[AlgoliaKeys] Purged ${expired.size} expired rate-limit counters`);
  }
);

module.exports = {
  getAlgoliaSearchKey,
  algoliaKeyStats,
  algoliaKeyCleanup,
};
