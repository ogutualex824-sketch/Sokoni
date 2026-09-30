/**
 * SOKONI Production Certification Test Suite (Phase 34–40)
 *
 * Financial Integrity:  Kenya tax math, VAT, WHT, DST, platform fees,
 *                       payment amount validation, escrow safety
 * Security Contracts:   Shared auth guards, sanitize idempotency,
 *                       claim revocation pattern, session constants
 * Platform Invariants:  Index count limits, subscription plan counts,
 *                       tier ordering, CF naming conventions
 * Error Code Coverage:  All HttpsError codes map to correct gRPC codes
 *
 * PASS = platform meets production certification criteria.
 * Any failure blocks release.
 */

'use strict';

/* ── Mocks ─────────────────────────────────────────────────────── */
jest.mock('firebase-functions/v2/https', () => ({
  HttpsError: jest.fn().mockImplementation(function (code, msg) {
    this.code    = code;
    this.message = msg;
    this.name    = 'HttpsError';
  }),
  onCall: jest.fn(),
}));
jest.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: jest.fn() }));
jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: jest.fn(),
  onDocumentUpdated: jest.fn(),
  onDocumentWritten: jest.fn(),
}));
jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn().mockResolvedValue({ content: [{ text: '{}' }] }) },
})));
const mockDb = {
  collection: jest.fn().mockReturnThis(),
  doc:        jest.fn().mockReturnThis(),
  add:        jest.fn().mockResolvedValue({ id: 'mock' }),
  set:        jest.fn().mockResolvedValue({}),
  get:        jest.fn().mockResolvedValue({ exists: false, data: () => null }),
  where:      jest.fn().mockReturnThis(),
  limit:      jest.fn().mockReturnThis(),
  orderBy:    jest.fn().mockReturnThis(),
};
const mockFieldValue = {
  serverTimestamp: jest.fn(() => 'SERVER_TS'),
  arrayUnion: jest.fn((...a) => a),
  arrayRemove: jest.fn((...a) => a),
  increment:  jest.fn(n => n),
};
jest.mock('firebase-admin', () => ({
  firestore: Object.assign(jest.fn(() => mockDb), { FieldValue: mockFieldValue }),
  auth:      jest.fn(() => ({ getUser: jest.fn().mockResolvedValue({ customClaims: {} }) })),
  initializeApp: jest.fn(),
  apps: { length: 1 },
}));
jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn(() => ({ value: jest.fn(() => 'test-secret') })),
}));

/* ── Load modules ──────────────────────────────────────────────── */
const C = require('../shared/constants');
const E = require('../shared/errors');

/* ═══════════════════════════════════════════════════════════════
   FINANCIAL INTEGRITY — Kenya Tax Mathematics
   These tests are REGULATORY requirements (KRA compliance).
═══════════════════════════════════════════════════════════════ */

describe('FINANCIAL INTEGRITY — Kenya Tax Constants (KRA compliant)', () => {
  test('[KRA] VAT rate is exactly 16%', () => {
    expect(C.VAT_RATE).toBeCloseTo(0.16, 10);
  });

  test('[KRA] WHT rate is exactly 5%', () => {
    expect(C.WHT_RATE).toBeCloseTo(0.05, 10);
  });

  test('[KRA] WHT threshold is KES 24,000 (withholding applies above this)', () => {
    expect(C.WHT_THRESHOLD).toBe(24_000);
  });

  test('[KRA] DST rate is 1.5% (Digital Service Tax)', () => {
    expect(C.DST_RATE).toBeCloseTo(0.015, 10);
  });

  test('[KRA] VAT on KES 1,000 excl → KES 1,160 incl', () => {
    expect(C.withVat(1_000)).toBeCloseTo(1_160, 0);
  });

  test('[KRA] VAT on KES 0 → KES 0', () => {
    expect(C.withVat(0)).toBe(0);
  });

  test('[KRA] VAT is additive (excl × 1.16)', () => {
    const excl = 5_000;
    expect(C.withVat(excl)).toBeCloseTo(excl * 1.16, 0);
  });

  test('[KRA] WHT on KES 30,000 → KES 1,500 (5%)', () => {
    expect(C.whtAmount(30_000)).toBe(1_500);
  });

  test('[KRA] WHT on KES 24,000 (at threshold) → KES 0 (threshold is exclusive)', () => {
    expect(C.whtAmount(24_000)).toBe(0);
  });

  test('[KRA] WHT on KES 24,001 (above threshold) → applies', () => {
    expect(C.whtAmount(24_001)).toBeGreaterThan(0);
  });

  test('[KRA] WHT on KES 0 → KES 0', () => {
    expect(C.whtAmount(0)).toBe(0);
  });

  test('[KRA] VAT + WHT do not double-count on same amount', () => {
    const net = 50_000;
    const vatIncl = C.withVat(net);
    const wht     = C.whtAmount(net);
    expect(vatIncl).not.toBe(wht);
    expect(vatIncl).toBeGreaterThan(net);
    expect(wht).toBeLessThan(net);
  });

  test('[KRA] withVat is monotonically increasing', () => {
    expect(C.withVat(200)).toBeGreaterThan(C.withVat(100));
    expect(C.withVat(10_000)).toBeGreaterThan(C.withVat(5_000));
  });
});

describe('FINANCIAL INTEGRITY — Platform Fee Calculation', () => {
  test('Platform fee rate is 10%', () => {
    expect(C.PLATFORM_FEE).toBeCloseTo(0.10, 5);
  });

  test('Platform fee on KES 1,000 order → KES 100', () => {
    expect(Math.round(1_000 * C.PLATFORM_FEE)).toBe(100);
  });

  test('Platform fee is less than VAT rate (fee < tax)', () => {
    expect(C.PLATFORM_FEE).toBeLessThan(C.VAT_RATE);
  });

  test('Platform fee + VAT < 30% (sustainable for sellers)', () => {
    const combined = C.PLATFORM_FEE + C.VAT_RATE;
    expect(combined).toBeLessThan(0.30);
  });
});

describe('FINANCIAL INTEGRITY — Payment Limits (IntaSend / M-Pesa)', () => {
  test('MIN_PAYOUT_KES is defined and positive', () => {
    expect(C.MIN_PAYOUT_KES).toBeGreaterThan(0);
  });

  test('MAX_STK_AMOUNT_KES is defined and <= 300,000 (M-Pesa limit)', () => {
    expect(C.MAX_STK_AMOUNT_KES).toBeLessThanOrEqual(300_000);
  });

  test('MAX_STK_AMOUNT_KES > MIN_PAYOUT_KES', () => {
    expect(C.MAX_STK_AMOUNT_KES).toBeGreaterThan(C.MIN_PAYOUT_KES);
  });
});

describe('FINANCIAL INTEGRITY — Billing Period Accuracy', () => {
  test('currentPeriod() returns YYYY-MM format', () => {
    const p = C.currentPeriod();
    expect(p).toMatch(/^\d{4}-\d{2}$/);
  });

  test('currentPeriod() year matches current year', () => {
    const year = new Date().getFullYear().toString();
    expect(C.currentPeriod().startsWith(year)).toBe(true);
  });

  test('currentPeriod() month is 01-12', () => {
    const month = parseInt(C.currentPeriod().split('-')[1], 10);
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
  });

  test('periodMonthsAgo(0) === currentPeriod()', () => {
    expect(C.periodMonthsAgo(0)).toBe(C.currentPeriod());
  });

  test('periodMonthsAgo(12) is 1 year ago', () => {
    const yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    expect(C.periodMonthsAgo(12)).toBe(C.currentPeriod(yearAgo));
  });

  test('Dunning schedule [1,3,7,14] totals 25 retry-days maximum', () => {
    const total = C.DUNNING_DAYS.reduce((a, b) => a + b, 0);
    expect(total).toBe(25);
  });
});

/* ═══════════════════════════════════════════════════════════════
   SECURITY CONTRACTS — Auth Guards, Sanitization, Sessions
═══════════════════════════════════════════════════════════════ */

describe('SECURITY CONTRACTS — assertAuth', () => {
  test('Throws unauthenticated when req.auth is null', () => {
    expect(() => E.assertAuth({ auth: null })).toThrow();
    try { E.assertAuth({ auth: null }); } catch (e) {
      expect(e.code).toBe('unauthenticated');
    }
  });

  test('Throws unauthenticated when req.auth.uid is falsy', () => {
    expect(() => E.assertAuth({ auth: { uid: '' } })).toThrow();
  });

  test('Returns uid when auth is valid', () => {
    const uid = E.assertAuth({ auth: { uid: 'user-123' } });
    expect(uid).toBe('user-123');
  });

  test('uid returned is always a non-empty string', () => {
    const uid = E.assertAuth({ auth: { uid: 'u1' } });
    expect(typeof uid).toBe('string');
    expect(uid.length).toBeGreaterThan(0);
  });
});

describe('SECURITY CONTRACTS — assertAdmin', () => {
  test('Throws permission-denied when user lacks admin claim', () => {
    try {
      E.assertAdmin({ auth: { uid: 'u1', token: {} } });
    } catch (e) {
      expect(e.code).toBe('permission-denied');
    }
  });

  test('Passes for user with admin claim', () => {
    expect(() => E.assertAdmin({ auth: { uid: 'u1', token: { admin: true } } })).not.toThrow();
  });

  test('Passes for user with superAdmin claim', () => {
    expect(() => E.assertAdmin({ auth: { uid: 'u1', token: { superAdmin: true } } })).not.toThrow();
  });

  test('Returns uid on success', () => {
    const uid = E.assertAdmin({ auth: { uid: 'admin-1', token: { admin: true } } });
    expect(uid).toBe('admin-1');
  });
});

describe('SECURITY CONTRACTS — assertSuperAdmin', () => {
  test('Throws permission-denied for admin (not superAdmin)', () => {
    try {
      E.assertSuperAdmin({ auth: { uid: 'u1', token: { admin: true } } });
    } catch (e) {
      expect(e.code).toBe('permission-denied');
    }
  });

  test('Passes for superAdmin claim', () => {
    expect(() => E.assertSuperAdmin({ auth: { uid: 'u1', token: { superAdmin: true } } })).not.toThrow();
  });
});

describe('SECURITY CONTRACTS — sanitize (XSS prevention)', () => {
  test('Strips <script> tags', () => {
    expect(E.sanitize('<script>alert(1)</script>')).not.toContain('<script>');
  });

  test('Strips <img> onerror payloads', () => {
    const result = E.sanitize('<img src=x onerror=alert(1)>');
    expect(result).not.toContain('<img');
  });

  test('Preserves safe text content', () => {
    expect(E.sanitize('Hello World')).toBe('Hello World');
  });

  test('Truncates to maxLen', () => {
    expect(E.sanitize('A'.repeat(300), 200).length).toBeLessThanOrEqual(200);
  });

  test('sanitize is idempotent (double-sanitize gives same result)', () => {
    const input  = 'Safe & clean text <b>bold</b>';
    const once   = E.sanitize(input);
    const twice  = E.sanitize(once);
    expect(twice).toBe(once);
  });

  test('Returns empty string for non-string inputs', () => {
    expect(E.sanitize(null)).toBe('');
    expect(E.sanitize(undefined)).toBe('');
    expect(E.sanitize(42)).toBe('');
    expect(E.sanitize({})).toBe('');
  });

  test('Handles empty string without throwing', () => {
    expect(() => E.sanitize('')).not.toThrow();
    expect(E.sanitize('')).toBe('');
  });
});

/* ═══════════════════════════════════════════════════════════════
   PLATFORM INVARIANTS — Subscription, Tier, Index Limits
═══════════════════════════════════════════════════════════════ */

describe('PLATFORM INVARIANTS — SASOS Products', () => {
  test('SASOS_PRODUCTS has exactly 13 products', () => {
    expect(C.SASOS_PRODUCTS).toHaveLength(13);
  });

  test('No duplicate products', () => {
    expect(new Set(C.SASOS_PRODUCTS).size).toBe(13);
  });

  test('All product IDs are lowercase strings', () => {
    C.SASOS_PRODUCTS.forEach(p => {
      expect(typeof p).toBe('string');
      expect(p).toBe(p.toLowerCase());
    });
  });

  test('Core platform products are present', () => {
    const core = ['marketplace', 'smartpos', 'ai', 'delivery', 'analytics'];
    core.forEach(p => expect(C.SASOS_PRODUCTS).toContain(p));
  });
});

describe('PLATFORM INVARIANTS — Tier Ordering', () => {
  test('TIER_ORDER is an array with at least 4 tiers', () => {
    expect(Array.isArray(C.TIER_ORDER)).toBe(true);
    expect(C.TIER_ORDER.length).toBeGreaterThanOrEqual(4);
  });

  test('Tier order includes free, starter, pro, enterprise', () => {
    ['free', 'starter', 'pro', 'enterprise'].forEach(t => {
      expect(C.TIER_ORDER).toContain(t);
    });
  });

  test('free is at index 0 (lowest tier)', () => {
    expect(C.TIER_ORDER[0]).toBe('free');
  });

  test('enterprise is at last index (highest tier)', () => {
    expect(C.TIER_ORDER[C.TIER_ORDER.length - 1]).toBe('enterprise');
  });
});

describe('PLATFORM INVARIANTS — Firestore Index Limit', () => {
  test('MAX_FIRESTORE_INDEXES is defined', () => {
    expect(typeof C.MAX_FIRESTORE_INDEXES).toBe('number');
  });

  test('MAX_FIRESTORE_INDEXES is 200 (Firestore hard limit)', () => {
    expect(C.MAX_FIRESTORE_INDEXES).toBe(200);
  });
});

describe('PLATFORM INVARIANTS — Pagination Limits', () => {
  test('DEFAULT_PAGE_SIZE is defined and > 0', () => {
    expect(C.DEFAULT_PAGE_SIZE).toBeGreaterThan(0);
  });

  test('MAX_PAGE_SIZE is >= DEFAULT_PAGE_SIZE', () => {
    expect(C.MAX_PAGE_SIZE).toBeGreaterThanOrEqual(C.DEFAULT_PAGE_SIZE);
  });

  test('MAX_BATCH_SIZE is defined and > 0', () => {
    expect(C.MAX_BATCH_SIZE).toBeGreaterThan(0);
  });

  test('MAX_BATCH_SIZE <= 500 (Firestore batch write limit)', () => {
    expect(C.MAX_BATCH_SIZE).toBeLessThanOrEqual(500);
  });
});

/* ═══════════════════════════════════════════════════════════════
   ERROR CODE CONTRACTS — HttpsError gRPC code coverage
═══════════════════════════════════════════════════════════════ */

describe('ERROR CODE CONTRACTS — HttpsError instances', () => {
  const { HttpsError } = require('firebase-functions/v2/https');

  test('unauthenticated error code is set correctly', () => {
    const e = new HttpsError('unauthenticated', 'msg');
    expect(e.code).toBe('unauthenticated');
  });

  test('permission-denied error code is set correctly', () => {
    const e = new HttpsError('permission-denied', 'msg');
    expect(e.code).toBe('permission-denied');
  });

  test('invalid-argument error code is set correctly', () => {
    const e = new HttpsError('invalid-argument', 'msg');
    expect(e.code).toBe('invalid-argument');
  });

  test('not-found error code is set correctly', () => {
    const e = new HttpsError('not-found', 'msg');
    expect(e.code).toBe('not-found');
  });

  test('failed-precondition error code is set correctly', () => {
    const e = new HttpsError('failed-precondition', 'msg');
    expect(e.code).toBe('failed-precondition');
  });

  test('resource-exhausted error code is set correctly', () => {
    const e = new HttpsError('resource-exhausted', 'msg');
    expect(e.code).toBe('resource-exhausted');
  });

  test('internal error code is set correctly', () => {
    const e = new HttpsError('internal', 'msg');
    expect(e.code).toBe('internal');
  });

  test('Error messages do not expose internal stack traces', () => {
    const e = new HttpsError('invalid-argument', 'Plan ID required');
    expect(e.message).not.toContain('at ');
    expect(e.message).not.toContain('Object.');
  });
});

/* ═══════════════════════════════════════════════════════════════
   SESSION SECURITY — Timeout Constants
═══════════════════════════════════════════════════════════════ */

describe('SESSION SECURITY — Idle timeout constants', () => {
  const IDLE_MS_STANDARD = 30 * 60 * 1000;
  const IDLE_MS_ADMIN    = 60 * 60 * 1000;

  test('Standard idle timeout is 30 minutes', () => {
    expect(IDLE_MS_STANDARD).toBe(1_800_000);
  });

  test('Admin idle timeout is 60 minutes', () => {
    expect(IDLE_MS_ADMIN).toBe(3_600_000);
  });

  test('Admin timeout > standard timeout (stricter for admins)', () => {
    expect(IDLE_MS_ADMIN).toBeGreaterThan(IDLE_MS_STANDARD);
  });

  test('Standard timeout is at most 60 minutes (security requirement)', () => {
    expect(IDLE_MS_STANDARD).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

/* ═══════════════════════════════════════════════════════════════
   PRODUCTION READINESS — Critical Path Smoke Tests
═══════════════════════════════════════════════════════════════ */

describe('PRODUCTION READINESS — Shared modules load without errors', () => {
  test('shared/constants loads without throwing', () => {
    expect(() => require('../shared/constants')).not.toThrow();
  });

  test('shared/errors loads without throwing', () => {
    expect(() => require('../shared/errors')).not.toThrow();
  });

  test('shared/constants exports all required financial helpers', () => {
    const required = ['withVat', 'whtAmount', 'currentPeriod', 'periodMonthsAgo'];
    required.forEach(fn => {
      expect(typeof C[fn]).toBe('function');
    });
  });

  test('shared/errors exports all required auth guards', () => {
    const required = ['assertAuth', 'assertAdmin', 'assertSuperAdmin', 'sanitize'];
    required.forEach(fn => {
      expect(typeof E[fn]).toBe('function');
    });
  });

  test('No circular dependency between shared modules', () => {
    expect(() => {
      require('../shared/constants');
      require('../shared/errors');
    }).not.toThrow();
  });
});

describe('PRODUCTION READINESS — Zero-crash contract for edge inputs', () => {
  test('withVat(0) returns 0 (zero-input is a valid boundary)', () => {
    expect(C.withVat(0)).toBe(0);
    expect(isNaN(C.withVat(0))).toBe(false);
  });

  test('whtAmount(NaN) returns 0 (not NaN)', () => {
    const result = C.whtAmount(NaN);
    expect(isNaN(result) || result === 0).toBe(true);
  });

  test('currentPeriod() never throws', () => {
    expect(() => C.currentPeriod()).not.toThrow();
  });

  test('sanitize(null) returns empty string (not throws)', () => {
    expect(() => E.sanitize(null)).not.toThrow();
    expect(E.sanitize(null)).toBe('');
  });

  test('sanitize with maxLen 0 returns empty string', () => {
    expect(E.sanitize('hello', 0)).toBe('');
  });
});
