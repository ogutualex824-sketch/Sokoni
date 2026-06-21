/* ================================================================
   SOKONI PLATFORM — SHARED CONSTANTS  v1.0.0  |  2026-06-21
   functions/shared/constants.js

   SINGLE SOURCE OF TRUTH for all financial, role, and platform
   constants used across Cloud Functions.

   Usage:
     const { PLATFORM_FEE, VAT_RATE, ROLE_LEVELS } = require('../shared/constants');

   Rule: No CF file may hardcode these values inline.
   If a constant is not here and is used in >1 file, add it here.
================================================================ */
'use strict';

/* ── Financial ──────────────────────────────────────────────── */

/** Platform commission rate (10% of gross transaction value) */
const PLATFORM_FEE = 0.10;

/** Kenya VAT rate — standard rate per KRA (16%) */
const VAT_RATE = 0.16;

/** Withholding Tax rate on professional services */
const WHT_RATE = 0.05;

/** WHT threshold — payments below this are exempt from WHT (KES) */
const WHT_THRESHOLD = 24_000;

/** Digital Services Tax rate (1.5% DST) */
const DST_RATE = 0.015;

/** Minimum payout amount to a seller (KES) */
const MIN_PAYOUT_KES = 100;

/** Maximum STK Push amount per transaction (IntaSend / Daraja limit) */
const MAX_STK_AMOUNT_KES = 150_000;

/** Maximum refund window in days */
const REFUND_WINDOW_DAYS = 7;

/** Escrow auto-release after delivery confirmation (hours) */
const ESCROW_AUTO_RELEASE_HOURS = 48;

/* ── Subscription / SASOS ────────────────────────────────────── */

/** Grace period after payment failure before access is restricted (days) */
const GRACE_PERIOD_DAYS = 7;

/** Dunning retry schedule (days after initial failure) */
const DUNNING_DAYS = [1, 3, 7, 14];

/** Subscription trial period (days) */
const TRIAL_DAYS = 14;

/** SASOS plan tier order (lowest → highest) */
const TIER_ORDER = ['free', 'starter', 'basic', 'pro', 'business', 'enterprise'];

/** All 13 SASOS product verticals */
const SASOS_PRODUCTS = [
  'marketplace', 'smartpos', 'ai', 'delivery', 'logistics',
  'events', 'property', 'vehicles', 'advertising', 'business',
  'warehousing', 'finance', 'analytics',
];

/* ── Role Levels (8-role RBAC) ──────────────────────────────── */
const ROLE_LEVELS = {
  user:         10,
  seller:       20,
  business:     20,
  driver:       20,
  professional: 20,
  moderator:    50,
  admin:        80,
  superAdmin:   100,
};

/** Minimum role level required to access admin-only operations */
const ADMIN_LEVEL = 80;

/** Minimum role level required for super-admin operations */
const SUPER_ADMIN_LEVEL = 100;

/* ── Risk / Fraud ────────────────────────────────────────────── */

/** Risk score thresholds mapping score → action */
const RISK_THRESHOLDS = {
  ALLOW:        { min: 0,  max: 29,  action: 'allow' },
  MONITOR:      { min: 30, max: 49,  action: 'monitor' },
  STEP_UP:      { min: 50, max: 69,  action: 'step_up_mfa' },
  RESTRICT:     { min: 70, max: 84,  action: 'restrict' },
  MANUAL_REVIEW:{ min: 85, max: 94,  action: 'manual_review' },
  SUSPEND:      { min: 95, max: 100, action: 'suspend' },
};

/** Daily risk score decay toward 0 (points per day) */
const RISK_DECAY_RATE = 1;

/* ── Platform ────────────────────────────────────────────────── */

/** Maximum Firestore composite indexes allowed */
const MAX_FIRESTORE_INDEXES = 200;

/** Health heartbeat stale threshold (ms — 5 minutes) */
const HEALTH_STALE_MS = 300_000;

/** Platform service types */
const SERVICE_TYPES = ['platform', 'product', 'integration', 'infrastructure', 'ai'];

/** Storage quota per plan tier (bytes) */
const STORAGE_QUOTAS = {
  free:       100 * 1024 * 1024,        //  100 MB
  starter:    500 * 1024 * 1024,        //  500 MB
  basic:        1 * 1024 * 1024 * 1024, //    1 GB
  pro:          5 * 1024 * 1024 * 1024, //    5 GB
  business:    20 * 1024 * 1024 * 1024, //   20 GB
  enterprise: 100 * 1024 * 1024 * 1024, //  100 GB
};

/* ── Pagination ──────────────────────────────────────────────── */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE     = 100;
const MAX_BATCH_SIZE    = 500;

/* ── Timing ──────────────────────────────────────────────────── */
const MS_SECOND = 1_000;
const MS_MINUTE = 60_000;
const MS_HOUR   = 3_600_000;
const MS_DAY    = 86_400_000;
const MS_WEEK   = 604_800_000;

/* ── Kenya / Locale ──────────────────────────────────────────── */
const DEFAULT_CURRENCY  = 'KES';
const DEFAULT_LOCALE    = 'en-KE';
const DEFAULT_TIMEZONE  = 'Africa/Nairobi';
const KRA_VAT_THRESHOLD = 5_000_000; /* Annual turnover above which VAT registration is required */

/* ── Exports ─────────────────────────────────────────────────── */
module.exports = {
  /* Financial */
  PLATFORM_FEE, VAT_RATE, WHT_RATE, WHT_THRESHOLD, DST_RATE,
  MIN_PAYOUT_KES, MAX_STK_AMOUNT_KES, REFUND_WINDOW_DAYS,
  ESCROW_AUTO_RELEASE_HOURS,

  /* Subscription */
  GRACE_PERIOD_DAYS, DUNNING_DAYS, TRIAL_DAYS, TIER_ORDER, SASOS_PRODUCTS,

  /* Roles */
  ROLE_LEVELS, ADMIN_LEVEL, SUPER_ADMIN_LEVEL,

  /* Risk */
  RISK_THRESHOLDS, RISK_DECAY_RATE,

  /* Platform */
  MAX_FIRESTORE_INDEXES, HEALTH_STALE_MS, SERVICE_TYPES, STORAGE_QUOTAS,

  /* Pagination */
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_BATCH_SIZE,

  /* Timing */
  MS_SECOND, MS_MINUTE, MS_HOUR, MS_DAY, MS_WEEK,

  /* Locale */
  DEFAULT_CURRENCY, DEFAULT_LOCALE, DEFAULT_TIMEZONE, KRA_VAT_THRESHOLD,
};
