/**
 * SOKONI Typesense Secured Keys
 *
 * Generates short-lived scoped search keys per-user.
 *
 * Key format (Typesense spec):
 *   Base64( HMAC-SHA256_hex(JSON.stringify(params), searchOnlyKey) + JSON.stringify(params) )
 *
 * Restrictions applied per user role:
 *   Guest     → filter_by: "status:=active", 15min TTL, 500 RPH
 *   Buyer     → filter_by: "status:=active OR status:=published", 1hr TTL, 1000 RPH
 *   Seller    → no extra filter, 1hr TTL, 2000 RPH
 *   Admin     → no filter, 4hr TTL, 10 000 RPH (for preview/testing)
 *
 * Rate limits:
 *   Per-user:  sliding window stored in `tsRateLimits/{uid}`
 *   Per-IP:    stored in `tsRateLimits/ip_{ip}`
 *   Audit log: `tsKeyAuditLog/{autoId}` for compliance
 */

'use strict';

const { onSchedule }               = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError }       = require('firebase-functions/v2/https');
const { defineSecret }             = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { TypesenseClient }          = require('./typesense-client');

const TYPESENSE_ADMIN_KEY  = defineSecret('TYPESENSE_ADMIN_KEY');
const TYPESENSE_SEARCH_KEY = defineSecret('TYPESENSE_SEARCH_KEY');

const RATE_LIMIT_COL  = 'tsRateLimits';
const AUDIT_LOG_COL   = 'tsKeyAuditLog';
const WINDOW_SECONDS  = 3600; /* 1-hour sliding window */

/* All 25 searchable collection names */
const ALL_COLLECTIONS = [
  'sokoni_products', 'sokoni_shops',    'sokoni_services',
  'sokoni_events',   'sokoni_properties','sokoni_vehicles',
  'sokoni_jobs',     'sokoni_users',    'sokoni_categories',
  'sokoni_brands',   'sokoni_collections','sokoni_coupons',
  /* v2 additions */
  'sokoni_hotels',   'sokoni_restaurants','sokoni_sports',
  'sokoni_healthcare','sokoni_education','sokoni_professionals',
  'sokoni_reviews',  'sokoni_support',  'sokoni_faq',
  'sokoni_blog',     'sokoni_announcements','sokoni_tourism',
  'sokoni_entertainment',
];

/* Per-role configuration */
const ROLE_CONFIG = {
  guest: {
    ttlSeconds:    900,   /* 15 min */
    rateLimit:     500,
    filterBy:      'status:=active',
    collections:   ALL_COLLECTIONS.filter(c => c !== 'sokoni_users'),
  },
  buyer: {
    ttlSeconds:    3600,  /* 1 hr */
    rateLimit:     1000,
    filterBy:      'status:=active',
    collections:   ALL_COLLECTIONS,
  },
  seller: {
    ttlSeconds:    3600,
    rateLimit:     2000,
    filterBy:      null,  /* no filter restriction */
    collections:   ALL_COLLECTIONS,
  },
  provider: {
    ttlSeconds:    3600,
    rateLimit:     2000,
    filterBy:      null,
    collections:   ALL_COLLECTIONS,
  },
  driver: {
    ttlSeconds:    1800,
    rateLimit:     1000,
    filterBy:      'status:=active',
    collections:   ['sokoni_products', 'sokoni_shops', 'sokoni_services'],
  },
  moderator: {
    ttlSeconds:    3600,
    rateLimit:     5000,
    filterBy:      null,
    collections:   ALL_COLLECTIONS,
  },
  admin: {
    ttlSeconds:    14400, /* 4 hrs */
    rateLimit:     10_000,
    filterBy:      null,
    collections:   ALL_COLLECTIONS,
  },
  superAdmin: {
    ttlSeconds:    14400,
    rateLimit:     10_000,
    filterBy:      null,
    collections:   ALL_COLLECTIONS,
  },
};

/* ── HMAC scoped key generation ─────────────────────────────────── */

const crypto = require('crypto');

function _generateScopedKey(searchOnlyKey, params) {
  const paramsJson = JSON.stringify(params);
  const hmac       = crypto.createHmac('sha256', searchOnlyKey).update(paramsJson).digest('hex');
  return Buffer.from(hmac + paramsJson).toString('base64');
}

/* ── Sliding window rate limiter (Firestore transaction) ─────────── */

async function _rateCheck(db, bucket, limitPerHour) {
  const ref        = db.collection(RATE_LIMIT_COL).doc(bucket);
  const windowSec  = WINDOW_SECONDS;
  const now        = Math.floor(Date.now() / 1000);
  const windowStart = now - windowSec;

  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : { count: 0, windowStart: now, expiresAt: now + windowSec };

    /* Reset window if expired */
    if (data.windowStart < windowStart) {
      tx.set(ref, { count: 1, windowStart: now, expiresAt: now + windowSec });
      return { allowed: true, remaining: limitPerHour - 1 };
    }

    if (data.count >= limitPerHour) {
      return { allowed: false, remaining: 0 };
    }

    tx.update(ref, { count: FieldValue.increment(1), expiresAt: now + windowSec });
    return { allowed: true, remaining: limitPerHour - data.count - 1 };
  });
}

/* ── Audit log write ─────────────────────────────────────────────── */

async function _writeAuditLog(db, { uid, role, ip, collections, filterBy, ttl, issuedAt }) {
  await db.collection(AUDIT_LOG_COL).add({
    uid,
    role,
    ip:          ip || null,
    collections,
    filterBy:    filterBy || null,
    ttlSeconds:  ttl,
    issuedAt:    FieldValue.serverTimestamp(),
    expiresAt:   new Date(issuedAt + ttl * 1000),
  });
}

/* ═══════════════════════════════════════════════════════════════════
   GET TYPESENSE SEARCH KEY — Client callable
════════════════════════════════════════════════════════════════════ */

exports.getTypesenseSearchKey = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY, TYPESENSE_SEARCH_KEY],
    timeoutSeconds: 15,
    memory:         '256MiB',
  },
  async ({ auth, rawRequest }) => {
    const searchKey = TYPESENSE_SEARCH_KEY.value();
    if (!searchKey || searchKey === 'not_configured') {
      throw new HttpsError('unavailable', 'Typesense search key not configured');
    }

    const db       = getFirestore();
    const uid      = auth?.uid || null;
    const role     = (auth?.token?.role || (uid ? 'buyer' : 'guest'));
    const config   = ROLE_CONFIG[role] || ROLE_CONFIG.guest;
    const ip       = rawRequest?.ip || rawRequest?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || null;
    const issuedAt = Date.now();

    /* Rate check per user */
    if (uid) {
      const userCheck = await _rateCheck(db, `user_${uid}`, config.rateLimit);
      if (!userCheck.allowed) {
        throw new HttpsError('resource-exhausted', 'Search rate limit exceeded. Try again in an hour.');
      }
    }

    /* Rate check per IP (bot/scraper protection) */
    if (ip) {
      const ipLimit = role === 'admin' || role === 'superAdmin' ? 50_000 : 2000;
      const ipCheck = await _rateCheck(db, `ip_${ip.replace(/\./g, '_')}`, ipLimit);
      if (!ipCheck.allowed) {
        throw new HttpsError('resource-exhausted', 'Too many requests from your network.');
      }
    }

    /* Build scoped key params */
    const expiresAt = Math.floor(issuedAt / 1000) + config.ttlSeconds;
    const params = {
      filter_by:          config.filterBy || undefined,
      expires_at:         expiresAt,
      collection:         config.collections,
      search_cutoff_ms:   200,
    };
    /* Remove undefined keys so JSON.stringify output is deterministic */
    Object.keys(params).forEach(k => { if (params[k] === undefined) delete params[k]; });

    const scopedKey = _generateScopedKey(searchKey, params);

    /* Audit log (non-blocking) */
    _writeAuditLog(db, {
      uid:         uid || 'guest',
      role,
      ip,
      collections: config.collections,
      filterBy:    config.filterBy,
      ttl:         config.ttlSeconds,
      issuedAt,
    }).catch(console.error);

    return {
      key:         scopedKey,
      expiresAt,
      collections: config.collections,
      ttlSeconds:  config.ttlSeconds,
    };
  }
);

/* ═══════════════════════════════════════════════════════════════════
   KEY STATS — Admin callable
════════════════════════════════════════════════════════════════════ */

exports.typesenseKeyStats = onCall(
  { secrets: [TYPESENSE_ADMIN_KEY] },
  async ({ auth }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const db = getFirestore();

    /* Rate limit counts */
    const rateLimitSnap = await db.collection(RATE_LIMIT_COL)
      .orderBy('count', 'desc').limit(100).get();
    const rateLimits = rateLimitSnap.docs.map(d => ({ bucket: d.id, ...d.data() }));

    /* Recent audit entries */
    const auditSnap = await db.collection(AUDIT_LOG_COL)
      .orderBy('issuedAt', 'desc').limit(100).get();
    const auditLog = auditSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    return { rateLimits, auditLog };
  }
);

/* ═══════════════════════════════════════════════════════════════════
   CLEANUP — Daily, remove expired rate limit docs
════════════════════════════════════════════════════════════════════ */

exports.typesenseKeyCleanup = onSchedule(
  { schedule: 'every day 01:30', timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const db       = getFirestore();
    const nowSec   = Math.floor(Date.now() / 1000);

    /* Expired rate limit windows */
    const rlSnap = await db.collection(RATE_LIMIT_COL)
      .where('expiresAt', '<', nowSec)
      .limit(500).get();

    if (!rlSnap.empty) {
      const batch = db.batch();
      rlSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    /* Audit log entries older than 90 days */
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    const auditSnap = await db.collection(AUDIT_LOG_COL)
      .where('issuedAt', '<', cutoff)
      .limit(1000).get();

    if (!auditSnap.empty) {
      for (const chunk of _chunk(auditSnap.docs, 500)) {
        const batch = db.batch();
        chunk.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }

    console.log(`[Typesense Key Cleanup] Removed ${rlSnap.size} rate-limit docs, ${auditSnap.size} audit entries.`);
  }
);

function _chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
