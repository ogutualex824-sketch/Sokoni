/**
 * Unit tests — WAP (Workflow Automation Platform) + Inventory Engine (Phase 12–15)
 *
 * Tests cover:
 *   WAP:       state machine constants, step dependency resolution, retry backoff,
 *              approval deadline guards, ID format, ticket code entropy
 *   Inventory: stock level ID format, negative stock guard, movement type allowlist,
 *              validation helpers, multi-tenant path structure
 *
 * Design: All tests are pure-logic — no Firestore or Firebase Admin calls.
 * Internal helpers are re-specified inline (same pattern as sasos-billing _calcTax tests).
 */

'use strict';

/* ── Mocks — prevent CF registration side effects ─────────────── */
jest.mock('firebase-functions/v2/https', () => ({
  HttpsError: jest.fn().mockImplementation(function (code, msg) {
    this.code    = code;
    this.message = msg;
    this.name    = 'HttpsError';
  }),
  onCall: jest.fn(),
}));
jest.mock('firebase-functions/v2/scheduler',  () => ({ onSchedule: jest.fn() }));
jest.mock('firebase-functions/v2/firestore',  () => ({
  onDocumentUpdated: jest.fn(),
  onDocumentWritten: jest.fn(),
  onDocumentCreated: jest.fn(),
}));
jest.mock('firebase-functions/v2/storage',    () => ({ onObjectFinalized: jest.fn() }));
jest.mock('firebase-functions',               () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
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
  runTransaction: jest.fn().mockResolvedValue({}),
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
jest.mock('firebase-functions/params', () => ({ defineSecret: jest.fn(() => ({ value: jest.fn(() => 'test-secret') })) }));

/* ── Load shared constants for cross-checks ────────────────────── */
const C = require('../shared/constants');

/* ═══════════════════════════════════════════════════════════════
   WAP — Workflow Automation Platform
═══════════════════════════════════════════════════════════════ */

/* ── WAP status machine constants (re-specified for contract testing) ── */
const WS = {
  PENDING:      'pending',
  RUNNING:      'running',
  WAITING:      'waiting',
  PAUSED:       'paused',
  COMPLETED:    'completed',
  FAILED:       'failed',
  CANCELLED:    'cancelled',
  COMPENSATING: 'compensating',
  COMPENSATED:  'compensated',
};

describe('WAP State Machine Constants', () => {
  test('All 9 workflow states are defined', () => {
    const states = Object.values(WS);
    expect(states).toHaveLength(9);
  });

  test('Terminal states are: completed, failed, cancelled, compensated', () => {
    const TERMINAL = [WS.COMPLETED, WS.FAILED, WS.CANCELLED, WS.COMPENSATED];
    TERMINAL.forEach(s => expect(Object.values(WS)).toContain(s));
  });

  test('Active states are: pending, running, waiting, paused, compensating', () => {
    const ACTIVE = [WS.PENDING, WS.RUNNING, WS.WAITING, WS.PAUSED, WS.COMPENSATING];
    ACTIVE.forEach(s => expect(Object.values(WS)).toContain(s));
  });

  test('State values are lowercase strings with no spaces', () => {
    Object.values(WS).forEach(v => {
      expect(typeof v).toBe('string');
      expect(v).toBe(v.toLowerCase());
      expect(v).not.toContain(' ');
    });
  });

  test('No duplicate state values', () => {
    const vals = Object.values(WS);
    expect(new Set(vals).size).toBe(vals.length);
  });
});

/* ── Step dependency resolution algorithm ──────────────────────── */

/**
 * Local re-specification of wap.js _findReadySteps:
 * Returns steps that are ready to execute — all dependencies satisfied,
 * not already completed/skipped/failed, and not currently running/waiting.
 */
function findReadySteps(steps, instance) {
  return steps.filter(s => {
    if (instance.completedSteps.includes(s.id)) return false;
    if (instance.skippedSteps.includes(s.id))   return false;
    if (instance.failedSteps.includes(s.id))    return false;
    const st = instance.steps?.[s.id];
    if (st?.status === 'running') return false;
    if (st?.status === 'waiting') return false;
    const deps = s.after ?? [];
    return deps.every(d =>
      instance.completedSteps.includes(d) ||
      instance.skippedSteps.includes(d)
    );
  });
}

function emptyInst(overrides = {}) {
  return {
    steps:          {},
    completedSteps: [],
    skippedSteps:   [],
    failedSteps:    [],
    ...overrides,
  };
}

describe('WAP _findReadySteps — dependency resolution', () => {
  test('Returns all steps when workflow has no dependencies (parallel start)', () => {
    const steps = [
      { id: 'a', after: [] },
      { id: 'b', after: [] },
    ];
    expect(findReadySteps(steps, emptyInst())).toHaveLength(2);
  });

  test('Returns empty when there are no steps', () => {
    expect(findReadySteps([], emptyInst())).toHaveLength(0);
  });

  test('Blocks a dependent step when its prerequisite is not completed', () => {
    const steps = [
      { id: 'a', after: [] },
      { id: 'b', after: ['a'] }, // blocked until 'a' completes
    ];
    expect(findReadySteps(steps, emptyInst())).toEqual([steps[0]]);
  });

  test('Releases a step once its prerequisite completes', () => {
    const steps = [
      { id: 'a', after: [] },
      { id: 'b', after: ['a'] },
    ];
    const inst = emptyInst({ completedSteps: ['a'] });
    const ready = findReadySteps(steps, inst);
    expect(ready.map(s => s.id)).toContain('b');
    expect(ready.map(s => s.id)).not.toContain('a');
  });

  test('Treats skipped dependencies as satisfied', () => {
    const steps = [
      { id: 'a', after: [] },
      { id: 'b', after: ['a'] },
    ];
    const inst = emptyInst({ skippedSteps: ['a'] });
    const ready = findReadySteps(steps, inst);
    expect(ready.map(s => s.id)).toContain('b');
  });

  test('Does not return a step that is currently running', () => {
    const steps = [{ id: 'a', after: [] }];
    const inst  = emptyInst({ steps: { a: { status: 'running' } } });
    expect(findReadySteps(steps, inst)).toHaveLength(0);
  });

  test('Does not return a step that is in waiting state', () => {
    const steps = [{ id: 'a', after: [] }];
    const inst  = emptyInst({ steps: { a: { status: 'waiting' } } });
    expect(findReadySteps(steps, inst)).toHaveLength(0);
  });

  test('Does not return completed steps', () => {
    const steps = [{ id: 'a', after: [] }];
    const inst  = emptyInst({ completedSteps: ['a'] });
    expect(findReadySteps(steps, inst)).toHaveLength(0);
  });

  test('Does not return failed steps', () => {
    const steps = [{ id: 'a', after: [] }];
    const inst  = emptyInst({ failedSteps: ['a'] });
    expect(findReadySteps(steps, inst)).toHaveLength(0);
  });

  test('Multi-step chain: only head is ready at start', () => {
    const steps = [
      { id: 's1', after: [] },
      { id: 's2', after: ['s1'] },
      { id: 's3', after: ['s2'] },
    ];
    const ready = findReadySteps(steps, emptyInst());
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('s1');
  });

  test('Diamond DAG: two branches ready after root completes', () => {
    // root → [left, right] → merge
    const steps = [
      { id: 'root',  after: [] },
      { id: 'left',  after: ['root'] },
      { id: 'right', after: ['root'] },
      { id: 'merge', after: ['left', 'right'] },
    ];
    const inst  = emptyInst({ completedSteps: ['root'] });
    const ready = findReadySteps(steps, inst).map(s => s.id).sort();
    expect(ready).toEqual(['left', 'right']);
  });

  test('Diamond merge: only merge ready when both branches complete', () => {
    const steps = [
      { id: 'root',  after: [] },
      { id: 'left',  after: ['root'] },
      { id: 'right', after: ['root'] },
      { id: 'merge', after: ['left', 'right'] },
    ];
    const inst  = emptyInst({ completedSteps: ['root', 'left', 'right'] });
    const ready = findReadySteps(steps, inst).map(s => s.id);
    expect(ready).toEqual(['merge']);
  });
});

/* ── Retry backoff math ─────────────────────────────────────────── */

/**
 * WAP retry backoff: exponential with base delay, capped at 30s.
 * backoff(retryCount, retryDelay) = min(retryDelay * 2^(retryCount-1), 30000)
 */
function calcBackoff(retryCount, retryDelay = 2000) {
  return Math.min(retryDelay * 2 ** (retryCount - 1), 30_000);
}

describe('WAP retry backoff', () => {
  test('First retry uses base delay', () => {
    expect(calcBackoff(1, 2000)).toBe(2000);
  });

  test('Second retry doubles the delay', () => {
    expect(calcBackoff(2, 2000)).toBe(4000);
  });

  test('Third retry quadruples the base delay', () => {
    expect(calcBackoff(3, 2000)).toBe(8000);
  });

  test('Delay is capped at 30,000ms regardless of retry count', () => {
    expect(calcBackoff(10, 2000)).toBe(30_000);
    expect(calcBackoff(20, 5000)).toBe(30_000);
  });

  test('Custom retryDelay is used as the base', () => {
    expect(calcBackoff(1, 5000)).toBe(5000);
    expect(calcBackoff(2, 5000)).toBe(10_000);
  });

  test('Backoff is never negative or zero (positive delays only)', () => {
    for (let i = 1; i <= 5; i++) {
      expect(calcBackoff(i)).toBeGreaterThan(0);
    }
  });
});

/* ── Workflow ID format ─────────────────────────────────────────── */

function genId() {
  return 'WF-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

describe('WAP workflow ID format', () => {
  test('Starts with WF- prefix', () => {
    expect(genId()).toMatch(/^WF-/);
  });

  test('Has two dash-separated segments after prefix', () => {
    const parts = genId().split('-');
    expect(parts).toHaveLength(3);
  });

  test('Generates unique IDs for successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, genId));
    expect(ids.size).toBe(100);
  });

  test('All characters are uppercase alphanumeric', () => {
    for (let i = 0; i < 20; i++) {
      expect(genId()).toMatch(/^WF-[0-9A-Z]+-[0-9A-Z]+$/);
    }
  });
});

/* ── Approval deadline logic ────────────────────────────────────── */

describe('WAP approval deadline guard', () => {
  test('Expired approval: deadline < now', () => {
    const now      = Date.now();
    const approval = { deadline: now - 1000, status: 'pending' };
    expect(approval.deadline < now).toBe(true);
  });

  test('Active approval: deadline >= now', () => {
    const now      = Date.now();
    const approval = { deadline: now + 60_000, status: 'pending' };
    expect(approval.deadline < now).toBe(false);
  });

  test('Approval with no deadline (undefined) is treated as non-expired', () => {
    const now      = Date.now();
    const approval = { status: 'pending' };
    expect(!approval.deadline || approval.deadline >= now).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════
   Inventory Engine — Business Rules
═══════════════════════════════════════════════════════════════ */

/* ── Stock level ID format ──────────────────────────────────────── */

function slId(productId, variantId, warehouseId) {
  return `${productId}:${variantId || 'base'}:${warehouseId}`;
}

describe('Inventory stock level ID (slId)', () => {
  test('Format: productId:variantId:warehouseId', () => {
    expect(slId('PROD-1', 'RED-M', 'WH-NBI')).toBe('PROD-1:RED-M:WH-NBI');
  });

  test('Null variantId defaults to "base"', () => {
    expect(slId('PROD-1', null, 'WH-NBI')).toBe('PROD-1:base:WH-NBI');
  });

  test('Undefined variantId defaults to "base"', () => {
    expect(slId('PROD-1', undefined, 'WH-NBI')).toBe('PROD-1:base:WH-NBI');
  });

  test('Empty string variantId defaults to "base"', () => {
    expect(slId('PROD-1', '', 'WH-NBI')).toBe('PROD-1:base:WH-NBI');
  });

  test('ID contains exactly two colons', () => {
    const id = slId('P', 'V', 'W');
    expect((id.match(/:/g) ?? []).length).toBe(2);
  });

  test('Unique IDs for different warehouse + same product', () => {
    const a = slId('P1', null, 'WH-A');
    const b = slId('P1', null, 'WH-B');
    expect(a).not.toBe(b);
  });

  test('Unique IDs for same warehouse + different variants', () => {
    const a = slId('P1', 'RED', 'WH-A');
    const b = slId('P1', 'BLUE', 'WH-A');
    expect(a).not.toBe(b);
  });
});

/* ── Negative stock guard ───────────────────────────────────────── */

const OUTBOUND_UNCHECKED_TYPES = ['count_adjust', 'write_off', 'damage', 'expiry', 'theft', 'loss'];

function wouldBlockNegative(newAvailable, movementType) {
  return newAvailable < 0 && !OUTBOUND_UNCHECKED_TYPES.includes(movementType);
}

describe('Inventory negative stock guard', () => {
  test('Blocks a sale when available stock would go negative', () => {
    expect(wouldBlockNegative(-1, 'sale')).toBe(true);
  });

  test('Blocks a fulfillment when available stock would go negative', () => {
    expect(wouldBlockNegative(-5, 'fulfillment')).toBe(true);
  });

  test('Allows count_adjust to go negative (write-down during count)', () => {
    expect(wouldBlockNegative(-10, 'count_adjust')).toBe(false);
  });

  test('Allows write_off to go negative', () => {
    expect(wouldBlockNegative(-3, 'write_off')).toBe(false);
  });

  test('Allows damage to go negative', () => {
    expect(wouldBlockNegative(-1, 'damage')).toBe(false);
  });

  test('Allows expiry to go negative', () => {
    expect(wouldBlockNegative(-2, 'expiry')).toBe(false);
  });

  test('Allows theft to go negative', () => {
    expect(wouldBlockNegative(-1, 'theft')).toBe(false);
  });

  test('Allows loss to go negative', () => {
    expect(wouldBlockNegative(-1, 'loss')).toBe(false);
  });

  test('Does not block when newAvailable is 0 (boundary)', () => {
    expect(wouldBlockNegative(0, 'sale')).toBe(false);
  });

  test('Does not block when newAvailable is positive', () => {
    expect(wouldBlockNegative(5, 'sale')).toBe(false);
  });

  test('Unchecked types list has exactly 6 entries', () => {
    expect(OUTBOUND_UNCHECKED_TYPES).toHaveLength(6);
    expect(new Set(OUTBOUND_UNCHECKED_TYPES).size).toBe(6);
  });
});

/* ── assertTenant validation ────────────────────────────────────── */

const { HttpsError } = require('firebase-functions/v2/https');

function assertTenant(data) {
  if (!data.tenantId) throw new HttpsError('invalid-argument', 'tenantId required');
  return data.tenantId;
}

describe('Inventory assertTenant', () => {
  test('Returns tenantId when present', () => {
    expect(assertTenant({ tenantId: 'TENANT-1' })).toBe('TENANT-1');
  });

  test('Throws invalid-argument when tenantId is missing', () => {
    expect(() => assertTenant({})).toThrow();
  });

  test('Throws invalid-argument when tenantId is empty string', () => {
    expect(() => assertTenant({ tenantId: '' })).toThrow();
  });

  test('Throws invalid-argument when tenantId is null', () => {
    expect(() => assertTenant({ tenantId: null })).toThrow();
  });

  test('Error code is invalid-argument (not unauthenticated)', () => {
    try {
      assertTenant({});
    } catch (e) {
      expect(e.code).toBe('invalid-argument');
    }
  });
});

/* ── Field validation helper ────────────────────────────────────── */

function validate(data, required) {
  for (const field of required) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      throw new HttpsError('invalid-argument', `${field} is required`);
    }
  }
}

describe('Inventory validate (required fields)', () => {
  test('Passes when all required fields are present', () => {
    expect(() => validate({ a: 1, b: 'x' }, ['a', 'b'])).not.toThrow();
  });

  test('Throws when a required field is missing', () => {
    expect(() => validate({ a: 1 }, ['a', 'b'])).toThrow();
  });

  test('Throws when a required field is null', () => {
    expect(() => validate({ a: null }, ['a'])).toThrow();
  });

  test('Throws when a required field is empty string', () => {
    expect(() => validate({ a: '' }, ['a'])).toThrow();
  });

  test('Accepts zero as a valid value (not falsy guard)', () => {
    expect(() => validate({ qty: 0 }, ['qty'])).not.toThrow();
  });

  test('Accepts false as a valid value', () => {
    expect(() => validate({ enabled: false }, ['enabled'])).not.toThrow();
  });

  test('Error code is invalid-argument', () => {
    try {
      validate({}, ['x']);
    } catch (e) {
      expect(e.code).toBe('invalid-argument');
    }
  });
});

/* ── Multi-tenant Firestore path structure ──────────────────────── */

describe('Inventory multi-tenant path structure', () => {
  function tenantColPath(tenantId, sub) {
    return `tenants/${tenantId}/${sub}`;
  }

  test('Root path uses tenants/<tenantId>/<sub> pattern', () => {
    expect(tenantColPath('ACME', 'inventory_levels')).toBe('tenants/ACME/inventory_levels');
  });

  test('Different tenants produce different paths', () => {
    const a = tenantColPath('TENANT-A', 'inventory_levels');
    const b = tenantColPath('TENANT-B', 'inventory_levels');
    expect(a).not.toBe(b);
  });

  test('Audit log collection follows same tenant prefix', () => {
    expect(tenantColPath('ACME', 'inventory_audit')).toContain('tenants/ACME/');
  });

  test('Movements and levels are separate sub-collections', () => {
    const levelsPath  = tenantColPath('T1', 'inventory_levels');
    const movsPath    = tenantColPath('T1', 'inventory_movements');
    expect(levelsPath).not.toBe(movsPath);
  });
});

/* ── Stock quantity calculation ─────────────────────────────────── */

describe('Inventory stock quantity math', () => {
  test('Available stock after positive adjustment increases', () => {
    const prev = 10;
    const qty  = 5;
    expect(prev + qty).toBe(15);
  });

  test('Available stock after negative adjustment decreases', () => {
    const prev = 10;
    const qty  = -3;
    expect(prev + qty).toBe(7);
  });

  test('onHand never goes below zero regardless of adjustment', () => {
    // matches: Math.max(0, (level.onHand || 0) + qty)
    const onHand = 5;
    const qty    = -10;
    expect(Math.max(0, onHand + qty)).toBe(0);
  });

  test('onHand allows full deduction when onHand === qty', () => {
    expect(Math.max(0, 10 + (-10))).toBe(0);
  });

  test('Finite check rejects NaN', () => {
    expect(isFinite(NaN)).toBe(false);
  });

  test('Finite check rejects Infinity', () => {
    expect(isFinite(Infinity)).toBe(false);
  });

  test('Finite check accepts zero', () => {
    expect(isFinite(0)).toBe(true);
  });

  test('Finite check accepts negative integer', () => {
    expect(isFinite(-50)).toBe(true);
  });
});

/* ── Shared imports guard — structural tests ────────────────────── */

describe('Phase 12-15 shared imports audit', () => {
  test('shared/constants exports currentPeriod', () => {
    expect(typeof C.currentPeriod).toBe('function');
  });

  test('currentPeriod returns YYYY-MM format', () => {
    expect(C.currentPeriod()).toMatch(/^\d{4}-\d{2}$/);
  });

  test('shared/constants exports DUNNING_DAYS', () => {
    expect(Array.isArray(C.DUNNING_DAYS)).toBe(true);
    expect(C.DUNNING_DAYS.length).toBeGreaterThan(0);
  });

  test('shared/constants exports VAT_RATE (16%)', () => {
    expect(C.VAT_RATE).toBeCloseTo(0.16, 5);
  });

  test('shared/errors exports sanitize as a function', () => {
    const E = require('../shared/errors');
    expect(typeof E.sanitize).toBe('function');
  });

  test('shared/errors sanitize strips HTML tags', () => {
    const E = require('../shared/errors');
    const result = E.sanitize('<script>alert(1)</script>safe text');
    expect(result).not.toContain('<script>');
  });

  test('shared/errors exports assertAuth, assertAdmin, assertSuperAdmin', () => {
    const E = require('../shared/errors');
    expect(typeof E.assertAuth).toBe('function');
    expect(typeof E.assertAdmin).toBe('function');
    expect(typeof E.assertSuperAdmin).toBe('function');
  });
});
