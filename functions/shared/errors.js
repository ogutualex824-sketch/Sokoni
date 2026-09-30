/* ================================================================
   SOKONI PLATFORM — SHARED ERROR HANDLING  v1.0.0  |  2026-06-21
   functions/shared/errors.js

   Standardized error factory for all Cloud Functions.
   Ensures consistent error codes, messages, and HTTP status mapping
   across every CF in the platform.

   Usage:
     const { AppError, assertAuth, assertAdmin, assertSuperAdmin,
             assertInput, wrapCF } = require('../shared/errors');

     // Inside a CF:
     const uid = assertAuth(req);
     assertInput(req.data.amount > 0, 'amount must be positive');
     throw new AppError('payment/insufficient-balance', 'Insufficient wallet balance.');

     // Wrap entire CF body for automatic error handling:
     return wrapCF(async () => {
       ...
     });
================================================================ */
'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const { logger }     = require('firebase-functions');

/* ── HttpsError code mapping ─────────────────────────────────── */
/*
  Firebase HttpsError codes:
    cancelled, unknown, invalid-argument, deadline-exceeded,
    not-found, already-exists, permission-denied, resource-exhausted,
    failed-precondition, aborted, out-of-range, unimplemented,
    internal, unavailable, data-loss, unauthenticated
*/

/* ── SOKONI Error Namespace → HttpsError code map ──────────────
   Application errors use the format: "domain/slug"
   e.g. "payment/duplicate", "subscription/not-found", "auth/expired"
────────────────────────────────────────────────────────────── */
const ERROR_CODE_MAP = {
  /* Auth */
  'auth/unauthenticated':      'unauthenticated',
  'auth/permission-denied':    'permission-denied',
  'auth/token-expired':        'unauthenticated',
  'auth/insufficient-role':    'permission-denied',
  'auth/account-suspended':    'permission-denied',
  'auth/account-restricted':   'permission-denied',

  /* Input */
  'input/invalid':             'invalid-argument',
  'input/missing-required':    'invalid-argument',
  'input/out-of-range':        'out-of-range',
  'input/too-large':           'invalid-argument',

  /* Payments */
  'payment/duplicate':         'already-exists',
  'payment/invalid-amount':    'invalid-argument',
  'payment/insufficient-balance': 'failed-precondition',
  'payment/provider-error':    'unavailable',
  'payment/currency-mismatch': 'invalid-argument',
  'payment/expired':           'deadline-exceeded',

  /* Subscription */
  'subscription/not-found':    'not-found',
  'subscription/already-active': 'already-exists',
  'subscription/plan-not-found': 'not-found',
  'subscription/suspended':    'permission-denied',
  'subscription/downgrade-pending': 'failed-precondition',

  /* Entitlement */
  'entitlement/feature-gated': 'permission-denied',
  'entitlement/quota-exceeded': 'resource-exhausted',
  'entitlement/credits-insufficient': 'resource-exhausted',
  'entitlement/storage-full':  'resource-exhausted',

  /* Billing */
  'billing/idempotency-conflict': 'already-exists',
  'billing/invoice-not-found': 'not-found',
  'billing/refund-window-expired': 'failed-precondition',

  /* Enterprise */
  'enterprise/org-not-found':  'not-found',
  'enterprise/seat-limit-reached': 'resource-exhausted',
  'enterprise/invite-expired': 'deadline-exceeded',
  'enterprise/not-org-member': 'permission-denied',
  'enterprise/dual-approval-required': 'failed-precondition',

  /* Fraud */
  'fraud/account-suspended':   'permission-denied',
  'fraud/risk-too-high':       'permission-denied',

  /* Platform */
  'platform/service-not-found': 'not-found',
  'platform/event-invalid-type': 'invalid-argument',
  'platform/replay-not-found': 'not-found',

  /* General */
  'resource/not-found':        'not-found',
  'resource/conflict':         'already-exists',
  'resource/rate-limited':     'resource-exhausted',
  'server/internal':           'internal',
  'server/unavailable':        'unavailable',
};

/* ── AppError ───────────────────────────────────────────────── */
class AppError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name    = 'AppError';
    this.appCode = code;
    this.details = details;
  }

  /** Convert to Firebase HttpsError for CF response */
  toHttpsError() {
    const httpsCode = ERROR_CODE_MAP[this.appCode] || 'internal';
    return new HttpsError(httpsCode, this.message, {
      appCode: this.appCode,
      ...this.details,
    });
  }
}

/* ── Auth Guards ────────────────────────────────────────────── */

/**
 * Assert caller is authenticated. Returns uid.
 * @param {object} req — CF v2 request object
 * @returns {string} uid
 */
function assertAuth(req) {
  if (!req.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  return req.auth.uid;
}

/**
 * Assert caller has admin or superAdmin claim. Returns uid.
 */
function assertAdmin(req) {
  const uid = assertAuth(req);
  if (!req.auth.token?.admin && !req.auth.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Admin access required.');
  }
  return uid;
}

/**
 * Assert caller has superAdmin claim. Returns uid.
 */
function assertSuperAdmin(req) {
  const uid = assertAuth(req);
  if (!req.auth.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Super-admin access required.');
  }
  return uid;
}

/**
 * Assert caller has a minimum role level.
 * @param {object} req
 * @param {number} minLevel — from ROLE_LEVELS constant
 * @param {string} roleName — for error message
 */
function assertMinRole(req, minLevel, roleName) {
  assertAuth(req);
  const token = req.auth.token || {};
  const levels = { user:10, seller:20, business:20, driver:20, professional:20, moderator:50, admin:80, superAdmin:100 };
  const userLevel = token.superAdmin ? 100 : token.admin ? 80 : token.moderator ? 50 :
    (token.seller || token.business || token.driver || token.professional) ? 20 : 10;
  if (userLevel < minLevel) {
    throw new HttpsError('permission-denied', `${roleName || 'higher-level'} access required.`);
  }
  return req.auth.uid;
}

/**
 * Assert caller owns the resource (uid matches resource owner).
 * Admins bypass ownership check.
 */
function assertOwner(req, ownerUid) {
  const uid = assertAuth(req);
  const isAdmin = req.auth.token?.admin || req.auth.token?.superAdmin;
  if (!isAdmin && uid !== ownerUid) {
    throw new HttpsError('permission-denied', 'Access denied — not the resource owner.');
  }
  return uid;
}

/* ── Input Validation ────────────────────────────────────────── */

/**
 * Assert a condition is true; throw invalid-argument if not.
 * @param {boolean} condition
 * @param {string}  message
 */
function assertInput(condition, message) {
  if (!condition) throw new HttpsError('invalid-argument', message);
}

/**
 * Assert a required field is present and non-empty.
 */
function assertRequired(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    throw new HttpsError('invalid-argument', `${fieldName} is required.`);
  }
}

/**
 * Assert a number is within a valid range.
 */
function assertRange(value, min, max, fieldName) {
  if (typeof value !== 'number' || value < min || value > max) {
    throw new HttpsError('out-of-range', `${fieldName} must be between ${min} and ${max}.`);
  }
}

/**
 * Sanitize a string — strips HTML tags, trims, limits length.
 * @param {*}      value — raw input
 * @param {number} maxLen — character limit
 * @returns {string}
 */
function sanitize(value, maxLen = 200) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
}

/**
 * Sanitize and validate a Kenyan phone number (254XXXXXXXXX format).
 * @param {*} phone
 * @returns {string} normalized phone
 */
function sanitizePhone(phone) {
  const s = String(phone || '').replace(/\D/g, '');
  /* Normalize: 07XX → 2547XX, 011XX → 25411XX */
  const normalized = s.startsWith('0') ? '254' + s.slice(1) : s;
  if (!/^254\d{9}$/.test(normalized)) {
    throw new HttpsError('invalid-argument', 'Invalid Kenyan phone number. Use format: 2547XXXXXXXX');
  }
  return normalized;
}

/**
 * Sanitize a positive integer amount (KES cents or whole KES).
 * @param {*}      value
 * @param {string} fieldName
 * @param {number} max
 * @returns {number}
 */
function sanitizeAmount(value, fieldName = 'amount', max = 10_000_000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new HttpsError('invalid-argument', `${fieldName} must be a positive number.`);
  }
  if (n > max) {
    throw new HttpsError('out-of-range', `${fieldName} exceeds maximum of ${max}.`);
  }
  return Math.round(n * 100) / 100; /* 2 decimal places */
}

/* ── CF Wrapper ──────────────────────────────────────────────── */

/**
 * Wraps a CF handler to catch AppError and unknown errors uniformly.
 * Logs all server errors before converting to HttpsError.
 *
 * Usage:
 *   return wrapCF(req, async () => { ... });
 */
async function wrapCF(req, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpsError) throw err;   /* Already formatted */
    if (err instanceof AppError) throw err.toHttpsError();

    /* Unknown error — log full detail server-side, return generic message */
    logger.error('[CF Error]', {
      uid:     req?.auth?.uid || 'unauthenticated',
      name:    err?.name,
      message: err?.message,
      stack:   err?.stack,
    });
    throw new HttpsError('internal', 'An internal error occurred. Please try again.');
  }
}

/* ── Exports ─────────────────────────────────────────────────── */
module.exports = {
  AppError,
  assertAuth,
  assertAdmin,
  assertSuperAdmin,
  assertMinRole,
  assertOwner,
  assertInput,
  assertRequired,
  assertRange,
  sanitize,
  sanitizePhone,
  sanitizeAmount,
  wrapCF,
  ERROR_CODE_MAP,
};
