/* ============================================================================
   SOKONI — durable, FAIL-CLOSED rate limiter for sensitive callables (2026-10-01)
   ----------------------------------------------------------------------------
   Why a new one: the existing limiters (index.js checkRateLimitDurable, redis-rate-limiter.js)
   FAIL OPEN on any transaction error — under burst contention, exactly when a limit matters,
   they let the request through. For password reset, data-rights intake and similar routes the
   right answer to "cannot enforce the limit" is to refuse.

   limit(db, admin, { bucket, key, max, windowSec, collection })
     → resolves when allowed; throws HttpsError('resource-exhausted', …, {code:'RATE_LIMITED',
       retryAfterSeconds}) when over; throws HttpsError('unavailable', …, {code:
       'RATE_LIMIT_UNAVAILABLE'}) if the limiter itself cannot run (fail closed).
   clientKey(rawRequest) → pseudonymised key from the RIGHT-MOST X-Forwarded-For entry (the
       address Google's front end saw; entries to its left are client-supplied).
   ============================================================================ */
'use strict';
const crypto = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function clientKey(rawRequest) {
  const h = rawRequest && rawRequest.headers ? rawRequest.headers['x-forwarded-for'] : '';
  const parts = String(h || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = parts.length ? parts[parts.length - 1] : ((rawRequest && rawRequest.ip) || 'unknown');
  return sha('ip|' + ip).slice(0, 32);
}

async function limit(db, admin, { bucket, key, max, windowSec, collection = 'rateLimitsStrict', now = Date.now(), logger = null }) {
  const ref = db.collection(collection).doc(bucket + '_' + key);
  let res;
  try {
    res = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : null;
      const inWindow = d && typeof d.windowStartMs === 'number' && now - d.windowStartMs < windowSec * 1000;
      const start = inWindow ? d.windowStartMs : now;
      const count = inWindow ? Number(d.count || 0) : 0;
      if (count >= max) return { ok: false, retryAfter: Math.ceil((start + windowSec * 1000 - now) / 1000) };
      tx.set(ref, { windowStartMs: start, count: count + 1, expiresAt: admin.firestore.Timestamp.fromMillis(start + windowSec * 1000 + 86400000) });
      return { ok: true };
    });
  } catch (e) {
    if (logger) logger.error('[limit] limiter unavailable — refusing (fail closed)', { bucket, error: e.message });
    throw new HttpsError('unavailable', 'This service is temporarily unavailable. Please try again in a few minutes.', { code: 'RATE_LIMIT_UNAVAILABLE' });
  }
  if (!res.ok) {
    if (logger) logger.warn('[limit] rate limited', { bucket, rateLimited: true });
    throw new HttpsError('resource-exhausted', 'Too many attempts. Please wait and try again.', { code: 'RATE_LIMITED', retryAfterSeconds: Math.max(1, res.retryAfter) });
  }
}

module.exports = { limit, clientKey, sha };
