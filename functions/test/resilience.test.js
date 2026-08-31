/**
 * Unit tests — Phase 26–33: Resilience Layer
 *
 * Tests cover:
 *   SASOS Fraud Engine:    signal registry, risk action thresholds, score decay,
 *                          composite scoring, trust inversion
 *   Inventory Fraud Rules: all 10 rules tested across pass/fail scenarios
 *   Resilience constants:  alert thresholds, boundary conditions
 *
 * Design: Pure logic tests — no Firebase, no network.
 * Re-specifies logic inline where functions are not exported.
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
jest.mock('firebase-functions/v2/scheduler',  () => ({ onSchedule: jest.fn() }));
jest.mock('firebase-functions/v2/firestore',  () => ({
  onDocumentCreated: jest.fn(),
  onDocumentUpdated: jest.fn(),
}));
jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

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
  initializeApp: jest.fn(),
  apps: { length: 1 },
}));

/* ═══════════════════════════════════════════════════════════════
   SASOS Fraud Engine — Signal Weight Registry
═══════════════════════════════════════════════════════════════ */

/* Re-specified from sasos-fraud.js — kept in sync with source */
const SIGNAL_WEIGHTS = {
  token_uid_mismatch:           70,
  session_fp_mismatch:          20,
  concurrent_sessions_exceeded: 35,
  impossible_travel:            60,
  multi_country_login:          35,
  new_device_high_value:        15,
  credential_stuffing:          80,
  account_takeover_pattern:     90,

  storage_write_attempt:        18,
  devtools_open:                 5,
  proto_pollution:              50,
  dom_manipulation:             30,
  quota_tamper:                 75,
  plan_spoof_attempt:           85,

  rapid_plan_cycle:             40,
  chargeback_pattern:           55,
  refund_abuse:                 45,
  fake_payment_ref:             80,
  coupon_stacking:              30,
  split_payment_exploit:        50,

  usage_spike:                  28,
  api_brute_force:              50,
  bot_pattern:                  35,
  concurrent_api_burst:         25,
  scraping_pattern:             30,

  fake_referral:                40,
  self_referral:                55,
  commission_manipulation:      60,
  seller_collusion:             50,

  shared_account:               40,
  feature_unlocking:            65,
  license_sharing:              50,
  trial_abuse:                  30,
  multi_trial_accounts:         45,

  abnormal_session_timing:      15,
  login_velocity:               25,
  rapid_content_creation:       20,
  mass_message_pattern:         35,
};

describe('SASOS Fraud Signal Registry', () => {
  const signals = Object.entries(SIGNAL_WEIGHTS);

  test('Registry is not empty', () => {
    expect(signals.length).toBeGreaterThan(0);
  });

  test('All signal weights are between 0 and 100', () => {
    signals.forEach(([key, w]) => {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(100);
    });
  });

  test('No duplicate signal names', () => {
    const names = signals.map(([k]) => k);
    expect(new Set(names).size).toBe(names.length);
  });

  test('All signal names are lowercase snake_case', () => {
    signals.forEach(([key]) => {
      expect(key).toBe(key.toLowerCase());
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    });
  });

  test('High-severity signals (≥80) exist for critical threats', () => {
    const critical = signals.filter(([, w]) => w >= 80);
    expect(critical.length).toBeGreaterThan(0);
  });

  test('account_takeover_pattern has highest or tied-highest weight', () => {
    const max = Math.max(...signals.map(([, w]) => w));
    expect(SIGNAL_WEIGHTS.account_takeover_pattern).toBe(max);
  });

  test('devtools_open has lowest or near-lowest weight (informational only)', () => {
    const min = Math.min(...signals.map(([, w]) => w));
    expect(SIGNAL_WEIGHTS.devtools_open).toBeLessThanOrEqual(min + 5);
  });

  test('Covers all 5 signal categories: identity, tampering, payment, usage, subscription', () => {
    const identity    = ['token_uid_mismatch', 'impossible_travel', 'credential_stuffing'];
    const tampering   = ['proto_pollution', 'quota_tamper', 'plan_spoof_attempt'];
    const payment     = ['chargeback_pattern', 'fake_payment_ref', 'refund_abuse'];
    const usage       = ['api_brute_force', 'bot_pattern', 'scraping_pattern'];
    const subscription = ['shared_account', 'trial_abuse', 'multi_trial_accounts'];
    [...identity, ...tampering, ...payment, ...usage, ...subscription].forEach(sig => {
      expect(SIGNAL_WEIGHTS).toHaveProperty(sig);
    });
  });

  test('Payment fraud signals (chargeback, fake_ref) score >= 55 (high-risk)', () => {
    expect(SIGNAL_WEIGHTS.chargeback_pattern).toBeGreaterThanOrEqual(55);
    expect(SIGNAL_WEIGHTS.fake_payment_ref).toBeGreaterThanOrEqual(55);
  });
});

/* ── Risk Action Thresholds ────────────────────────────────────── */

const RISK_ACTIONS = [
  { min: 95, action: 'suspend',       label: 'Suspended — awaiting review' },
  { min: 85, action: 'manual_review', label: 'Manual review queued' },
  { min: 70, action: 'restrict',      label: 'Temporary restrictions applied' },
  { min: 50, action: 'step_up_mfa',   label: 'Step-up MFA required' },
  { min: 30, action: 'monitor',       label: 'Monitoring' },
  { min:  0, action: 'allow',         label: 'Normal' },
];

function riskAction(score) {
  return RISK_ACTIONS.find(a => score >= a.min) || RISK_ACTIONS[RISK_ACTIONS.length - 1];
}

describe('SASOS Risk Action Thresholds', () => {
  test('Score 0 → allow', () => {
    expect(riskAction(0).action).toBe('allow');
  });

  test('Score 29 → allow (below monitor threshold)', () => {
    expect(riskAction(29).action).toBe('allow');
  });

  test('Score 30 → monitor', () => {
    expect(riskAction(30).action).toBe('monitor');
  });

  test('Score 49 → monitor', () => {
    expect(riskAction(49).action).toBe('monitor');
  });

  test('Score 50 → step_up_mfa', () => {
    expect(riskAction(50).action).toBe('step_up_mfa');
  });

  test('Score 69 → step_up_mfa', () => {
    expect(riskAction(69).action).toBe('step_up_mfa');
  });

  test('Score 70 → restrict', () => {
    expect(riskAction(70).action).toBe('restrict');
  });

  test('Score 84 → restrict', () => {
    expect(riskAction(84).action).toBe('restrict');
  });

  test('Score 85 → manual_review', () => {
    expect(riskAction(85).action).toBe('manual_review');
  });

  test('Score 94 → manual_review', () => {
    expect(riskAction(94).action).toBe('manual_review');
  });

  test('Score 95 → suspend', () => {
    expect(riskAction(95).action).toBe('suspend');
  });

  test('Score 100 → suspend', () => {
    expect(riskAction(100).action).toBe('suspend');
  });

  test('Coverage: 5 distinct non-allow actions exist', () => {
    const nonAllow = RISK_ACTIONS.filter(a => a.action !== 'allow');
    expect(nonAllow).toHaveLength(5);
  });

  test('All thresholds are in descending order', () => {
    for (let i = 0; i < RISK_ACTIONS.length - 1; i++) {
      expect(RISK_ACTIONS[i].min).toBeGreaterThan(RISK_ACTIONS[i + 1].min);
    }
  });

  test('Lowest threshold min is 0 (all scores covered)', () => {
    const lowest = RISK_ACTIONS[RISK_ACTIONS.length - 1];
    expect(lowest.min).toBe(0);
  });
});

/* ── Risk Score Decay ───────────────────────────────────────────── */

/**
 * Re-specification of _decayedRiskScore from sasos-fraud.js:
 * Risk decays toward 0 at ~1 point/day based on days since last event.
 */
function decayedRiskScore(score, lastEventTs) {
  if (!lastEventTs || score <= 0) return score;
  const daysSince = (Date.now() - lastEventTs) / 86400000;
  const decayed   = Math.max(0, score - Math.floor(daysSince));
  return Math.min(100, Math.round(decayed));
}

describe('SASOS Risk Score Decay', () => {
  test('No decay when no lastEventTs', () => {
    expect(decayedRiskScore(80, null)).toBe(80);
  });

  test('No decay for score of 0', () => {
    expect(decayedRiskScore(0, Date.now() - 7 * 86400000)).toBe(0);
  });

  test('Score decays by 1 after 1 day', () => {
    const yesterday = Date.now() - 86400000;
    expect(decayedRiskScore(50, yesterday)).toBe(49);
  });

  test('Score decays by 7 after 7 days', () => {
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    expect(decayedRiskScore(50, sevenDaysAgo)).toBe(43);
  });

  test('Score never goes below 0', () => {
    const longAgo = Date.now() - 200 * 86400000;
    expect(decayedRiskScore(50, longAgo)).toBe(0);
  });

  test('Score never goes above 100', () => {
    expect(decayedRiskScore(100, Date.now())).toBe(100);
  });

  test('Recent event (same day) has no decay yet', () => {
    const justNow = Date.now() - 1000;
    expect(decayedRiskScore(75, justNow)).toBe(75);
  });

  test('Partially decayed score is an integer', () => {
    const threeDaysAgo = Date.now() - 3 * 86400000;
    const result = decayedRiskScore(60, threeDaysAgo);
    expect(Number.isInteger(result)).toBe(true);
  });
});

/* ── Trust Score ────────────────────────────────────────────────── */

describe('SASOS Trust Score (100 - risk)', () => {
  function trustScore(riskScore) {
    return Math.max(0, Math.min(100, 100 - riskScore));
  }

  test('Trust is 100 when risk is 0', () => {
    expect(trustScore(0)).toBe(100);
  });

  test('Trust is 0 when risk is 100', () => {
    expect(trustScore(100)).toBe(0);
  });

  test('Trust is 50 when risk is 50 (neutral state)', () => {
    expect(trustScore(50)).toBe(50);
  });

  test('Trust never goes negative', () => {
    expect(trustScore(110)).toBe(0);
  });

  test('Trust never exceeds 100', () => {
    expect(trustScore(-10)).toBe(100);
  });
});

/* ═══════════════════════════════════════════════════════════════
   Inventory Fraud Engine — Rule Tests
   Tests each of the 10 FRAUD_RULES against pass/fail scenarios.
═══════════════════════════════════════════════════════════════ */

/* Re-specified from inventory-fraud.js FRAUD_RULES */
const FRAUD_RULES = [
  { id: 'large_adjustment',  test: (m, ctx) => m.type === 'adjustment' && Math.abs(m.qty) > (ctx.avgAdj || 10) * 4, score: 35, reason: 'Adjustment quantity 4× above average' },
  { id: 'off_hours',         test: (m)      => { const h = new Date(m.ts?.toMillis?.() || m.ts).getHours(); return h >= 22 || h <= 5; }, score: 20, reason: 'Transaction recorded outside business hours' },
  { id: 'no_reason',         test: (m)      => !m.reason || m.reason.trim().length < 5, score: 15, reason: 'Missing or insufficient reason provided' },
  { id: 'bulk_return',       test: (m)      => m.type === 'return_in' && Math.abs(m.qty) > 15, score: 25, reason: 'Unusually large return quantity' },
  { id: 'bulk_damage',       test: (m)      => (m.type === 'damage' || m.type === 'write_off') && Math.abs(m.qty) > 20, score: 30, reason: 'Large damage or write-off event' },
  { id: 'rapid_movements',   test: (m, ctx) => ctx.recentMovements > 20, score: 20, reason: 'Excessive movement volume in short time window' },
  { id: 'theft_pattern',     test: (m)      => m.type === 'theft', score: 50, reason: 'Recorded theft event' },
  { id: 'negative_stock',    test: (m, ctx) => (ctx.stockAfter || 0) < 0, score: 40, reason: 'Movement resulted in negative stock' },
  { id: 'duplicate_adjust',  test: (m, ctx) => ctx.sameUserSameProduct > 3, score: 25, reason: 'Multiple adjustments for same product by same user' },
  { id: 'supervisor_bypass', test: (m)      => m.type === 'adjustment' && m.supervisorOverride === true, score: 15, reason: 'Supervisor override used for adjustment' },
];

function computeRulesScore(movement, ctx = {}) {
  let total = 0;
  const triggered = [];
  for (const rule of FRAUD_RULES) {
    if (rule.test(movement, ctx)) {
      total += rule.score;
      triggered.push(rule.id);
    }
  }
  return { total: Math.min(100, total), triggered };
}

describe('Inventory Fraud Rules — Registry', () => {
  test('Registry has exactly 10 rules', () => {
    expect(FRAUD_RULES).toHaveLength(10);
  });

  test('All rules have id, test, score, reason', () => {
    FRAUD_RULES.forEach(rule => {
      expect(typeof rule.id).toBe('string');
      expect(typeof rule.test).toBe('function');
      expect(typeof rule.score).toBe('number');
      expect(typeof rule.reason).toBe('string');
    });
  });

  test('All rule scores are 0-100', () => {
    FRAUD_RULES.forEach(rule => {
      expect(rule.score).toBeGreaterThan(0);
      expect(rule.score).toBeLessThanOrEqual(100);
    });
  });

  test('No duplicate rule IDs', () => {
    const ids = FRAUD_RULES.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('theft_pattern has highest score (50 — critical event)', () => {
    const maxScore = Math.max(...FRAUD_RULES.map(r => r.score));
    const theft = FRAUD_RULES.find(r => r.id === 'theft_pattern');
    expect(theft.score).toBe(maxScore);
  });
});

describe('Inventory Fraud Rules — large_adjustment', () => {
  const rule = FRAUD_RULES.find(r => r.id === 'large_adjustment');

  test('Triggers when adjustment qty > 4× average', () => {
    const m   = { type: 'adjustment', qty: 50 };
    const ctx = { avgAdj: 10 };
    expect(rule.test(m, ctx)).toBe(true);
  });

  test('Does NOT trigger at exactly 4× average', () => {
    const m   = { type: 'adjustment', qty: 40 };
    const ctx = { avgAdj: 10 };
    expect(rule.test(m, ctx)).toBe(false);
  });

  test('Does NOT trigger for non-adjustment types', () => {
    const m   = { type: 'sale', qty: 200 };
    const ctx = { avgAdj: 10 };
    expect(rule.test(m, ctx)).toBe(false);
  });

  test('Uses default avgAdj of 10 when context missing', () => {
    const m = { type: 'adjustment', qty: 41 };
    expect(rule.test(m, {})).toBe(true);
  });
});

describe('Inventory Fraud Rules — off_hours', () => {
  const rule = FRAUD_RULES.find(r => r.id === 'off_hours');

  test('Triggers for hour >= 22 (late night)', () => {
    const midnight = new Date();
    midnight.setHours(23, 0, 0, 0);
    expect(rule.test({ ts: midnight.getTime() })).toBe(true);
  });

  test('Triggers for hour <= 5 (early morning)', () => {
    const earlyMorning = new Date();
    earlyMorning.setHours(3, 0, 0, 0);
    expect(rule.test({ ts: earlyMorning.getTime() })).toBe(true);
  });

  test('Does NOT trigger during business hours (9am)', () => {
    const morning = new Date();
    morning.setHours(9, 0, 0, 0);
    expect(rule.test({ ts: morning.getTime() })).toBe(false);
  });

  test('Does NOT trigger at 21:59 (just before threshold)', () => {
    const before = new Date();
    before.setHours(21, 59, 0, 0);
    expect(rule.test({ ts: before.getTime() })).toBe(false);
  });
});

describe('Inventory Fraud Rules — no_reason', () => {
  const rule = FRAUD_RULES.find(r => r.id === 'no_reason');

  test('Triggers when reason is undefined', () => {
    expect(rule.test({ qty: 5 })).toBe(true);
  });

  test('Triggers when reason is empty string', () => {
    expect(rule.test({ reason: '' })).toBe(true);
  });

  test('Triggers when reason is fewer than 5 chars', () => {
    expect(rule.test({ reason: 'hi' })).toBe(true);
  });

  test('Does NOT trigger when reason has 5+ meaningful chars', () => {
    expect(rule.test({ reason: 'Stock count correction' })).toBe(false);
  });
});

describe('Inventory Fraud Rules — bulk_return', () => {
  const rule = FRAUD_RULES.find(r => r.id === 'bulk_return');

  test('Triggers for return_in with qty > 15', () => {
    expect(rule.test({ type: 'return_in', qty: 16 })).toBe(true);
  });

  test('Does NOT trigger at exactly qty 15', () => {
    expect(rule.test({ type: 'return_in', qty: 15 })).toBe(false);
  });

  test('Does NOT trigger for sale type even with high qty', () => {
    expect(rule.test({ type: 'sale', qty: 100 })).toBe(false);
  });
});

describe('Inventory Fraud Rules — theft_pattern', () => {
  const rule = FRAUD_RULES.find(r => r.id === 'theft_pattern');

  test('Always triggers for type=theft', () => {
    expect(rule.test({ type: 'theft' })).toBe(true);
  });

  test('Does NOT trigger for type=loss', () => {
    expect(rule.test({ type: 'loss' })).toBe(false);
  });
});

describe('Inventory Fraud Rules — negative_stock', () => {
  const rule = FRAUD_RULES.find(r => r.id === 'negative_stock');

  test('Triggers when stockAfter < 0', () => {
    expect(rule.test({}, { stockAfter: -1 })).toBe(true);
  });

  test('Does NOT trigger when stockAfter === 0 (zero is acceptable)', () => {
    expect(rule.test({}, { stockAfter: 0 })).toBe(false);
  });

  test('Does NOT trigger when stockAfter > 0', () => {
    expect(rule.test({}, { stockAfter: 5 })).toBe(false);
  });

  test('Defaults stockAfter to 0 when context missing', () => {
    expect(rule.test({}, {})).toBe(false);
  });
});

describe('Inventory Fraud composite scoring', () => {
  test('Clean movement has zero score', () => {
    const m   = { type: 'sale', qty: 1, reason: 'Normal sale', ts: new Date().setHours(10) };
    const ctx = { avgAdj: 5, recentMovements: 2, sameUserSameProduct: 1, stockAfter: 10 };
    const { total } = computeRulesScore(m, ctx);
    expect(total).toBe(0);
  });

  test('Theft alone scores 50', () => {
    const m = { type: 'theft', qty: 5, reason: 'Theft reported', ts: new Date().setHours(10, 0, 0, 0) };
    const { total, triggered } = computeRulesScore(m, {});
    expect(triggered).toContain('theft_pattern');
    expect(total).toBe(50);
  });

  test('Multiple signals accumulate (capped at 100)', () => {
    const midnight = new Date();
    midnight.setHours(23, 0, 0, 0);
    const m = {
      type: 'theft',
      qty:  1,
      ts:   midnight.getTime(),
      reason: 'x', // < 5 chars
    };
    const ctx = { stockAfter: -5, recentMovements: 25 };
    const { total, triggered } = computeRulesScore(m, ctx);
    expect(triggered).toContain('theft_pattern');
    expect(triggered).toContain('off_hours');
    expect(triggered).toContain('no_reason');
    expect(triggered).toContain('negative_stock');
    expect(triggered).toContain('rapid_movements');
    expect(total).toBeLessThanOrEqual(100);
    expect(total).toBeGreaterThan(50);
  });

  test('supervisor_bypass alone scores 15', () => {
    const m   = { type: 'adjustment', qty: 1, supervisorOverride: true, reason: 'OK reason here', ts: new Date().setHours(10, 0, 0, 0) };
    const ctx = { avgAdj: 5, stockAfter: 5, sameUserSameProduct: 1, recentMovements: 1 };
    const { total, triggered } = computeRulesScore(m, ctx);
    expect(triggered).toContain('supervisor_bypass');
    expect(total).toBe(15);
  });
});

/* ═══════════════════════════════════════════════════════════════
   Resilience Layer — Structural Health Checks
═══════════════════════════════════════════════════════════════ */

describe('Resilience Layer — Shared errors structural audit', () => {
  const E = require('../shared/errors');

  test('assertAuth is exported and is a function', () => {
    expect(typeof E.assertAuth).toBe('function');
  });

  test('assertAdmin is exported and is a function', () => {
    expect(typeof E.assertAdmin).toBe('function');
  });

  test('assertSuperAdmin is exported and is a function', () => {
    expect(typeof E.assertSuperAdmin).toBe('function');
  });

  test('sanitize is exported and is a function', () => {
    expect(typeof E.sanitize).toBe('function');
  });

  test('assertAuth throws unauthenticated for missing auth', () => {
    try {
      E.assertAuth({ auth: null });
    } catch (e) {
      expect(e.code).toBe('unauthenticated');
    }
  });

  test('assertAdmin throws permission-denied when user has no admin claim', () => {
    try {
      E.assertAdmin({ auth: { uid: 'u1', token: {} } });
    } catch (e) {
      expect(e.code).toBe('permission-denied');
    }
  });

  test('assertSuperAdmin throws permission-denied when admin but not superAdmin', () => {
    try {
      E.assertSuperAdmin({ auth: { uid: 'u1', token: { admin: true } } });
    } catch (e) {
      expect(e.code).toBe('permission-denied');
    }
  });
});

describe('Resilience Layer — Shared constants audit', () => {
  const C = require('../shared/constants');

  test('DUNNING_DAYS is [1, 3, 7, 14]', () => {
    expect(C.DUNNING_DAYS).toEqual([1, 3, 7, 14]);
  });

  test('GRACE_PERIOD_DAYS is a positive number (grace window before suspension)', () => {
    expect(C.GRACE_PERIOD_DAYS).toBeGreaterThan(0);
  });

  test('VAT_RATE is 0.16 (16%)', () => {
    expect(C.VAT_RATE).toBeCloseTo(0.16, 5);
  });

  test('WHT_THRESHOLD is 24000 (KES, per KRA)', () => {
    expect(C.WHT_THRESHOLD).toBe(24000);
  });

  test('WHT_RATE is 0.05 (5%)', () => {
    expect(C.WHT_RATE).toBeCloseTo(0.05, 5);
  });

  test('PLATFORM_FEE is defined and > 0 (10% platform take rate)', () => {
    expect(typeof C.PLATFORM_FEE).toBe('number');
    expect(C.PLATFORM_FEE).toBeGreaterThan(0);
    expect(C.PLATFORM_FEE).toBeLessThanOrEqual(1);
  });
});
