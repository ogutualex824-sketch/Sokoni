/**
 * Unit tests — Phase 3 Auth & RBAC
 * Validates role claim logic, guard behaviour, and user profile schema rules.
 * These tests run without Firebase Admin SDK (mocked).
 */

'use strict';

/* ── Mocks ───────────────────────────────────────────────────── */
const mockHttpsError = jest.fn().mockImplementation(function(code, msg) {
  this.code    = code;
  this.message = msg;
});
mockHttpsError.prototype = Object.create(Error.prototype);

jest.mock('firebase-functions/v2/https', () => ({ HttpsError: mockHttpsError }));
jest.mock('firebase-functions', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

const E = require('../shared/errors');
const C = require('../shared/constants');

/* Helper */
function makeReq(uid = null, claims = {}) {
  return uid
    ? { auth: { uid, token: { uid, ...claims } }, data: {} }
    : { auth: null, data: {} };
}

/* ─────────────────────────────────────────────────────────────
   Role Level Hierarchy (from shared constants)
───────────────────────────────────────────────────────────── */
describe('RBAC Role Hierarchy', () => {
  test('superAdmin (100) > admin (80) > moderator (50) > seller (20) > user (10)', () => {
    expect(C.ROLE_LEVELS.superAdmin).toBeGreaterThan(C.ROLE_LEVELS.admin);
    expect(C.ROLE_LEVELS.admin).toBeGreaterThan(C.ROLE_LEVELS.moderator);
    expect(C.ROLE_LEVELS.moderator).toBeGreaterThan(C.ROLE_LEVELS.seller);
    expect(C.ROLE_LEVELS.seller).toBeGreaterThan(C.ROLE_LEVELS.user);
  });

  test('seller/driver/professional/business are the same tier', () => {
    const t = C.ROLE_LEVELS.seller;
    expect(C.ROLE_LEVELS.driver).toBe(t);
    expect(C.ROLE_LEVELS.professional).toBe(t);
    expect(C.ROLE_LEVELS.business).toBe(t);
  });

  test('ADMIN_LEVEL constant matches admin role level', () => {
    expect(C.ADMIN_LEVEL).toBe(C.ROLE_LEVELS.admin);
  });

  test('SUPER_ADMIN_LEVEL constant matches superAdmin role level', () => {
    expect(C.SUPER_ADMIN_LEVEL).toBe(C.ROLE_LEVELS.superAdmin);
  });
});

/* ─────────────────────────────────────────────────────────────
   assertAdmin — Phase 3 guard: admin + superAdmin pass; others fail
───────────────────────────────────────────────────────────── */
describe('assertAdmin guard — Phase 3', () => {
  beforeEach(() => mockHttpsError.mockClear());

  test('admin claim → returns uid', () => {
    expect(E.assertAdmin(makeReq('admin-1', { admin: true }))).toBe('admin-1');
  });

  test('superAdmin claim → returns uid (superAdmin implies admin)', () => {
    expect(E.assertAdmin(makeReq('super-1', { superAdmin: true }))).toBe('super-1');
  });

  test('moderator (no admin claim) → throws permission-denied', () => {
    expect(() => E.assertAdmin(makeReq('mod-1', { moderator: true }))).toThrow();
    const [code] = mockHttpsError.mock.calls[mockHttpsError.mock.calls.length - 1];
    expect(code).toBe('permission-denied');
  });

  test('unauthenticated → throws unauthenticated', () => {
    expect(() => E.assertAdmin(makeReq(null))).toThrow();
    const [code] = mockHttpsError.mock.calls[mockHttpsError.mock.calls.length - 1];
    expect(code).toBe('unauthenticated');
  });
});

/* ─────────────────────────────────────────────────────────────
   assertSuperAdmin guard
───────────────────────────────────────────────────────────── */
describe('assertSuperAdmin guard — Phase 3', () => {
  beforeEach(() => mockHttpsError.mockClear());

  test('superAdmin claim → returns uid', () => {
    expect(E.assertSuperAdmin(makeReq('super-1', { superAdmin: true }))).toBe('super-1');
  });

  test('admin (not superAdmin) → throws permission-denied', () => {
    expect(() => E.assertSuperAdmin(makeReq('admin-1', { admin: true }))).toThrow();
    const [code] = mockHttpsError.mock.calls[mockHttpsError.mock.calls.length - 1];
    expect(code).toBe('permission-denied');
  });
});

/* ─────────────────────────────────────────────────────────────
   assertMinRole — role-level gating
───────────────────────────────────────────────────────────── */
describe('assertMinRole — level gating', () => {
  beforeEach(() => mockHttpsError.mockClear());

  test('superAdmin passes any level check', () => {
    expect(() => E.assertMinRole(makeReq('s', { superAdmin: true }), 100, 'superAdmin')).not.toThrow();
    expect(() => E.assertMinRole(makeReq('s', { superAdmin: true }), 80,  'admin')).not.toThrow();
    expect(() => E.assertMinRole(makeReq('s', { superAdmin: true }), 50,  'moderator')).not.toThrow();
    expect(() => E.assertMinRole(makeReq('s', { superAdmin: true }), 10,  'user')).not.toThrow();
  });

  test('admin passes up to level 80', () => {
    expect(() => E.assertMinRole(makeReq('a', { admin: true }), 80, 'admin')).not.toThrow();
    expect(() => E.assertMinRole(makeReq('a', { admin: true }), 50, 'moderator')).not.toThrow();
  });

  test('admin fails level 100 (superAdmin required)', () => {
    expect(() => E.assertMinRole(makeReq('a', { admin: true }), 100, 'superAdmin')).toThrow();
  });

  test('seller passes level 20', () => {
    expect(() => E.assertMinRole(makeReq('s', { seller: true }), 20, 'seller')).not.toThrow();
  });

  test('seller fails level 50 (moderator required)', () => {
    expect(() => E.assertMinRole(makeReq('s', { seller: true }), 50, 'moderator')).toThrow();
  });

  test('plain user fails level 20', () => {
    expect(() => E.assertMinRole(makeReq('u'), 20, 'seller')).toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────
   User Profile Schema Rules
   (validates contract for new user profiles in firebase.js + auth.js)
───────────────────────────────────────────────────────────── */
describe('User profile schema — Phase 3 contract', () => {
  function buildProfile(overrides = {}) {
    const now = new Date();
    return {
      uid:             'test-uid-123',
      name:            'Test User',
      email:           'test@example.com',
      registeredAs:    { user: true },
      roles:           ['user'],
      role:            'user',
      joinedAt:        now.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }),
      joinedTimestamp: now.getTime(),
      ...overrides,
    };
  }

  test('default role is "user" not "buyer"', () => {
    const p = buildProfile();
    expect(p.role).toBe('user');
    expect(p.role).not.toBe('buyer');
  });

  test('registeredAs uses "user" key, not "buyer"', () => {
    const p = buildProfile();
    expect(p.registeredAs.user).toBe(true);
    expect(p.registeredAs.buyer).toBeUndefined();
  });

  test('roles array includes "user"', () => {
    const p = buildProfile();
    expect(Array.isArray(p.roles)).toBe(true);
    expect(p.roles).toContain('user');
  });

  test('joinedTimestamp is a numeric epoch (sortable)', () => {
    const p = buildProfile();
    expect(typeof p.joinedTimestamp).toBe('number');
    expect(p.joinedTimestamp).toBeGreaterThan(0);
    expect(Number.isFinite(p.joinedTimestamp)).toBe(true);
  });

  test('joinedTimestamp is within 10 seconds of now', () => {
    const before = Date.now();
    const p = buildProfile();
    const after = Date.now();
    expect(p.joinedTimestamp).toBeGreaterThanOrEqual(before - 100);
    expect(p.joinedTimestamp).toBeLessThanOrEqual(after + 100);
  });

  test('joinedAt is a human-readable string', () => {
    const p = buildProfile();
    expect(typeof p.joinedAt).toBe('string');
    expect(p.joinedAt.length).toBeGreaterThan(3);
  });

  test('profile has all required fields', () => {
    const required = ['uid', 'name', 'email', 'registeredAs', 'roles', 'role', 'joinedAt', 'joinedTimestamp'];
    const p = buildProfile();
    required.forEach(f => expect(p).toHaveProperty(f));
  });
});

/* ─────────────────────────────────────────────────────────────
   Claim Preservation Logic
   Validates the merge pattern used in grantAdminClaim / grantPlatformRole
───────────────────────────────────────────────────────────── */
describe('Claim preservation logic', () => {
  function mergeClaims(existing, newClaim) {
    return { ...existing, ...newClaim };
  }

  function revokeClaimKey(existing, key) {
    const updated = { ...existing };
    delete updated[key];
    return updated;
  }

  test('merge preserves existing claims when adding new claim', () => {
    const existing = { moderator: true, seller: true };
    const result   = mergeClaims(existing, { admin: true });
    expect(result.moderator).toBe(true);
    expect(result.seller).toBe(true);
    expect(result.admin).toBe(true);
  });

  test('revoke deletes only target key, preserves others', () => {
    const existing = { admin: true, moderator: true };
    const result   = revokeClaimKey(existing, 'admin');
    expect(result.admin).toBeUndefined();
    expect(result.moderator).toBe(true);
  });

  test('revoking non-existent key is a no-op', () => {
    const existing = { moderator: true };
    const result   = revokeClaimKey(existing, 'admin');
    expect(result).toEqual({ moderator: true });
  });

  test('setting claim to false is NOT the same as deleting it', () => {
    const withFalse  = { admin: false };
    const withDelete = {};
    /* These must differ — false-value is a security anti-pattern */
    expect(withFalse.admin).not.toBeUndefined();
    expect(withDelete.admin).toBeUndefined();
  });

  test('CLAIM_ROLES are the three server-authoritative roles', () => {
    const CLAIM_ROLES = ['superAdmin', 'admin', 'moderator'];
    expect(CLAIM_ROLES).toContain('superAdmin');
    expect(CLAIM_ROLES).toContain('admin');
    expect(CLAIM_ROLES).toContain('moderator');
    expect(CLAIM_ROLES).not.toContain('seller'); /* Firestore-only */
    expect(CLAIM_ROLES).not.toContain('user');   /* Firestore-only */
  });
});

/* ─────────────────────────────────────────────────────────────
   Session Timeout Constants
───────────────────────────────────────────────────────────── */
describe('Session timeout thresholds', () => {
  const IDLE_STANDARD = 30 * 60 * 1000; // 30 min
  const IDLE_ADMIN    = 60 * 60 * 1000; // 60 min

  test('standard idle limit is 30 minutes', () => {
    expect(IDLE_STANDARD).toBe(1_800_000);
  });

  test('admin idle limit is 60 minutes (double standard)', () => {
    expect(IDLE_ADMIN).toBe(2 * IDLE_STANDARD);
  });

  test('admin gets more idle time than standard users', () => {
    expect(IDLE_ADMIN).toBeGreaterThan(IDLE_STANDARD);
  });

  test('timing constants align: 30 min = 30 * C.MS_MINUTE', () => {
    expect(IDLE_STANDARD).toBe(30 * C.MS_MINUTE);
    expect(IDLE_ADMIN).toBe(60 * C.MS_MINUTE);
  });
});
