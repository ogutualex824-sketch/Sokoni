'use strict';
/**
 * SOKONI Redis Rate Limiter Middleware
 * functions/redis-rate-limiter.js  v1.0  (2026-07-06)
 *
 * Drop-in rate-limiting middleware for Cloud Functions.
 * Wraps RateLimitService from redis-service.js with opinionated
 * per-action configs, IP extraction, and HttpsError formatting.
 *
 * Usage (inside any callable CF):
 *   const { checkRateLimit, LIMITS } = require('./redis-rate-limiter');
 *
 *   exports.checkout = onCall(opts, async (req) => {
 *     await checkRateLimit(req, 'checkout');
 *     // ... normal handler code ...
 *   });
 *
 * When Redis is unavailable, ALL rate-limit checks pass transparently
 * so the platform never degrades due to missing Redis.
 */

const { HttpsError } = require('firebase-functions/v2/https');
const { RateLimitService, isFallback } = require('./redis-service');

/* ── Rate-limit profiles ─────────────────────────────────────── */
/**
 * Each entry:
 *   maxRequests  — allowed calls per window
 *   windowSeconds — rolling window in seconds
 *   byUid        — true = key on uid; false = key on IP
 *   errorMessage — user-facing message on limit hit
 */
const LIMITS = {
  /* Authentication — brute force protection */
  auth: {
    maxRequests: 10, windowSeconds: 60,
    byUid: false,
    errorMessage: 'Too many sign-in attempts. Please wait a minute.',
  },

  /* OTP / Phone verification */
  otp: {
    maxRequests: 5, windowSeconds: 300,
    byUid: false,
    errorMessage: 'Too many OTP requests. Please wait 5 minutes.',
  },

  /* Checkout — prevents cart-spam / abuse */
  checkout: {
    maxRequests: 20, windowSeconds: 60,
    byUid: true,
    errorMessage: 'Too many checkout requests. Please slow down.',
  },

  /* Payment initiation — higher-sensitivity */
  payment: {
    maxRequests: 5, windowSeconds: 60,
    byUid: true,
    errorMessage: 'Too many payment attempts. Please wait before retrying.',
  },

  /* AI endpoints — expensive per call */
  ai: {
    maxRequests: 30, windowSeconds: 3600,
    byUid: true,
    errorMessage: 'AI request limit reached. Your quota resets in 1 hour.',
  },

  /* Search — high volume, generous limits */
  search: {
    maxRequests: 120, windowSeconds: 60,
    byUid: false,
    errorMessage: 'Search rate limit exceeded. Please slow down.',
  },

  /* Inbound webhooks — per source IP */
  webhook: {
    maxRequests: 200, windowSeconds: 60,
    byUid: false,
    errorMessage: 'Webhook rate limit exceeded.',
  },

  /* Admin APIs — elevated but still guarded */
  admin: {
    maxRequests: 60, windowSeconds: 60,
    byUid: true,
    errorMessage: 'Admin API rate limit exceeded.',
  },

  /* Product upload / listing creation */
  listing: {
    maxRequests: 50, windowSeconds: 3600,
    byUid: true,
    errorMessage: 'Too many listings created. Please wait an hour.',
  },

  /* Review submission — prevent review bombing */
  review: {
    maxRequests: 10, windowSeconds: 3600,
    byUid: true,
    errorMessage: 'Review limit reached. You can submit 10 reviews per hour.',
  },

  /* POS operations — very generous for active terminals */
  pos: {
    maxRequests: 600, windowSeconds: 60,
    byUid: true,
    errorMessage: 'POS operation rate limit exceeded.',
  },

  /* Notification send */
  notification: {
    maxRequests: 100, windowSeconds: 60,
    byUid: true,
    errorMessage: 'Notification rate limit exceeded.',
  },

  /* Generic fallback */
  default: {
    maxRequests: 100, windowSeconds: 60,
    byUid: true,
    errorMessage: 'Rate limit exceeded. Please try again shortly.',
  },
};

/* ── IP extraction ───────────────────────────────────────────── */
function _extractIp(req) {
  try {
    return req.rawRequest?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
        || req.rawRequest?.headers?.['x-real-ip']
        || req.rawRequest?.connection?.remoteAddress
        || 'unknown';
  } catch { return 'unknown'; }
}

/* ── Main middleware ─────────────────────────────────────────── */
/**
 * Check rate limit for a callable Cloud Function request.
 *
 * @param {object}  req     — Firebase callable request (has .auth, .rawRequest)
 * @param {string}  action  — Key into LIMITS (e.g. 'checkout', 'payment')
 * @param {object}  [overrides] — Optional field overrides: { maxRequests, windowSeconds }
 * @throws {HttpsError} 'resource-exhausted' when limit exceeded
 */
async function checkRateLimit(req, action, overrides = {}) {
  /* Always pass when Redis is down — never block on infrastructure failure */
  if (isFallback()) return { allowed: true, fallback: true };

  const profile = { ...(LIMITS[action] || LIMITS.default), ...overrides };
  const uid = req.auth?.uid;
  const ip  = _extractIp(req);

  const identifier = profile.byUid
    ? (uid || ip)
    : ip;

  const result = await RateLimitService.check(
    identifier,
    action,
    profile.maxRequests,
    profile.windowSeconds,
  );

  if (result.fallback) return result;

  if (!result.allowed) {
    console.warn(JSON.stringify({
      severity: 'WARNING',
      message:  '[rate-limiter] Limit exceeded',
      action, identifier,
      count:     result.count,
      maxRequests: profile.maxRequests,
      windowSeconds: profile.windowSeconds,
      uid, ip,
    }));
    throw new HttpsError('resource-exhausted', profile.errorMessage);
  }

  return { allowed: true, remaining: result.remaining };
}

/**
 * Lightweight check that returns a result object instead of throwing.
 * Use when you want to handle limiting yourself.
 */
async function queryRateLimit(identifier, action, overrides = {}) {
  if (isFallback()) return { allowed: true, fallback: true };
  const profile = { ...(LIMITS[action] || LIMITS.default), ...overrides };
  return RateLimitService.check(identifier, action, profile.maxRequests, profile.windowSeconds);
}

/**
 * Wrap a callable handler with automatic rate limiting.
 * Returns a new async function with the same signature.
 *
 * @example
 *   exports.checkout = onCall(opts, withRateLimit('checkout', async (req) => {
 *     // handler code
 *   }));
 */
function withRateLimit(action, handler, overrides = {}) {
  return async function (req) {
    await checkRateLimit(req, action, overrides);
    return handler(req);
  };
}

module.exports = {
  checkRateLimit,
  queryRateLimit,
  withRateLimit,
  LIMITS,
};
