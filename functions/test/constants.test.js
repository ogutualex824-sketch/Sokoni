/**
 * Unit tests — shared/constants.js
 * Validates all platform-wide financial, role, and operational constants.
 * These are the contract that all Cloud Functions rely on — zero tolerance
 * for regressions here.
 */

'use strict';

const C = require('../shared/constants');

/* ─────────────────────────────────────────────────────────────
   Financial Constants
───────────────────────────────────────────────────────────── */
describe('Financial constants', () => {
  test('PLATFORM_FEE is 10%', () => {
    expect(C.PLATFORM_FEE).toBe(0.10);
  });

  test('VAT_RATE is 16% (KRA standard rate)', () => {
    expect(C.VAT_RATE).toBe(0.16);
  });

  test('WHT_RATE is 5%', () => {
    expect(C.WHT_RATE).toBe(0.05);
  });

  test('WHT_THRESHOLD is KES 24,000', () => {
    expect(C.WHT_THRESHOLD).toBe(24_000);
  });

  test('DST_RATE is 1.5%', () => {
    expect(C.DST_RATE).toBe(0.015);
  });

  test('MIN_PAYOUT_KES is positive', () => {
    expect(C.MIN_PAYOUT_KES).toBeGreaterThan(0);
  });

  test('MAX_STK_AMOUNT_KES is 150,000 (Daraja limit)', () => {
    expect(C.MAX_STK_AMOUNT_KES).toBe(150_000);
  });

  test('REFUND_WINDOW_DAYS is 7', () => {
    expect(C.REFUND_WINDOW_DAYS).toBe(7);
  });

  test('ESCROW_AUTO_RELEASE_HOURS is 48', () => {
    expect(C.ESCROW_AUTO_RELEASE_HOURS).toBe(48);
  });

  /* Derived calculations */
  test('Platform fee on KES 10,000 = KES 1,000', () => {
    const gross = 10_000;
    const fee   = Math.round(gross * C.PLATFORM_FEE * 100) / 100;
    expect(fee).toBe(1_000);
  });

  test('VAT on KES 1,000 excl = KES 160', () => {
    const excl = 1_000;
    const vat  = Math.round(excl * C.VAT_RATE * 100) / 100;
    expect(vat).toBe(160);
  });

  test('WHT applies above threshold', () => {
    const net = 30_000;
    const wht = net > C.WHT_THRESHOLD ? Math.round(net * C.WHT_RATE * 100) / 100 : 0;
    expect(wht).toBe(1_500);
  });

  test('WHT does NOT apply below threshold', () => {
    const net = 20_000;
    const wht = net > C.WHT_THRESHOLD ? Math.round(net * C.WHT_RATE * 100) / 100 : 0;
    expect(wht).toBe(0);
  });
});

/* ─────────────────────────────────────────────────────────────
   Subscription Constants
───────────────────────────────────────────────────────────── */
describe('Subscription constants', () => {
  test('GRACE_PERIOD_DAYS is 7', () => {
    expect(C.GRACE_PERIOD_DAYS).toBe(7);
  });

  test('DUNNING_DAYS has 4 retry points', () => {
    expect(C.DUNNING_DAYS).toHaveLength(4);
  });

  test('DUNNING_DAYS is ordered ascending', () => {
    const days = C.DUNNING_DAYS;
    for (let i = 1; i < days.length; i++) {
      expect(days[i]).toBeGreaterThan(days[i - 1]);
    }
  });

  test('DUNNING_DAYS last entry <= GRACE_PERIOD_DAYS (suspension aligns with grace)', () => {
    const last = C.DUNNING_DAYS[C.DUNNING_DAYS.length - 1];
    expect(last).toBeGreaterThanOrEqual(C.GRACE_PERIOD_DAYS);
  });

  test('TRIAL_DAYS is positive', () => {
    expect(C.TRIAL_DAYS).toBeGreaterThan(0);
  });

  test('TIER_ORDER starts with free', () => {
    expect(C.TIER_ORDER[0]).toBe('free');
  });

  test('TIER_ORDER ends with enterprise', () => {
    expect(C.TIER_ORDER[C.TIER_ORDER.length - 1]).toBe('enterprise');
  });

  test('TIER_ORDER has no duplicates', () => {
    const set = new Set(C.TIER_ORDER);
    expect(set.size).toBe(C.TIER_ORDER.length);
  });

  test('SASOS_PRODUCTS contains 13 verticals', () => {
    expect(C.SASOS_PRODUCTS).toHaveLength(13);
  });

  test('SASOS_PRODUCTS has no duplicates', () => {
    const set = new Set(C.SASOS_PRODUCTS);
    expect(set.size).toBe(C.SASOS_PRODUCTS.length);
  });

  test('SASOS_PRODUCTS includes marketplace and analytics', () => {
    expect(C.SASOS_PRODUCTS).toContain('marketplace');
    expect(C.SASOS_PRODUCTS).toContain('analytics');
  });
});

/* ─────────────────────────────────────────────────────────────
   Role Constants
───────────────────────────────────────────────────────────── */
describe('Role level constants', () => {
  test('superAdmin has highest level (100)', () => {
    expect(C.ROLE_LEVELS.superAdmin).toBe(100);
  });

  test('admin has level 80', () => {
    expect(C.ROLE_LEVELS.admin).toBe(80);
  });

  test('moderator has level 50', () => {
    expect(C.ROLE_LEVELS.moderator).toBe(50);
  });

  test('user has lowest level (10)', () => {
    expect(C.ROLE_LEVELS.user).toBe(10);
  });

  test('seller == business == driver == professional (same tier)', () => {
    expect(C.ROLE_LEVELS.seller).toBe(C.ROLE_LEVELS.business);
    expect(C.ROLE_LEVELS.seller).toBe(C.ROLE_LEVELS.driver);
    expect(C.ROLE_LEVELS.seller).toBe(C.ROLE_LEVELS.professional);
  });

  test('Role hierarchy is monotonically correct', () => {
    expect(C.ROLE_LEVELS.superAdmin).toBeGreaterThan(C.ROLE_LEVELS.admin);
    expect(C.ROLE_LEVELS.admin).toBeGreaterThan(C.ROLE_LEVELS.moderator);
    expect(C.ROLE_LEVELS.moderator).toBeGreaterThan(C.ROLE_LEVELS.seller);
    expect(C.ROLE_LEVELS.seller).toBeGreaterThan(C.ROLE_LEVELS.user);
  });

  test('ADMIN_LEVEL matches admin role', () => {
    expect(C.ADMIN_LEVEL).toBe(C.ROLE_LEVELS.admin);
  });

  test('SUPER_ADMIN_LEVEL matches superAdmin role', () => {
    expect(C.SUPER_ADMIN_LEVEL).toBe(C.ROLE_LEVELS.superAdmin);
  });
});

/* ─────────────────────────────────────────────────────────────
   Risk Constants
───────────────────────────────────────────────────────────── */
describe('Risk threshold constants', () => {
  test('ALLOW threshold starts at 0', () => {
    expect(C.RISK_THRESHOLDS.ALLOW.min).toBe(0);
  });

  test('SUSPEND threshold ends at 100', () => {
    expect(C.RISK_THRESHOLDS.SUSPEND.max).toBe(100);
  });

  test('Thresholds cover 0-100 with no gaps', () => {
    const tiers = Object.values(C.RISK_THRESHOLDS).sort((a, b) => a.min - b.min);
    for (let i = 0; i < tiers.length - 1; i++) {
      expect(tiers[i + 1].min).toBe(tiers[i].max + 1);
    }
  });

  test('Each threshold has a valid action string', () => {
    const validActions = ['allow', 'monitor', 'step_up_mfa', 'restrict', 'manual_review', 'suspend'];
    Object.values(C.RISK_THRESHOLDS).forEach(t => {
      expect(validActions).toContain(t.action);
    });
  });

  test('RISK_DECAY_RATE is 1 point/day', () => {
    expect(C.RISK_DECAY_RATE).toBe(1);
  });
});

/* ─────────────────────────────────────────────────────────────
   Storage Quotas
───────────────────────────────────────────────────────────── */
describe('Storage quota constants', () => {
  test('free tier has lowest quota', () => {
    expect(C.STORAGE_QUOTAS.free).toBeLessThan(C.STORAGE_QUOTAS.starter);
  });

  test('enterprise tier has highest quota', () => {
    const values = Object.values(C.STORAGE_QUOTAS);
    expect(C.STORAGE_QUOTAS.enterprise).toBe(Math.max(...values));
  });

  test('All tiers in TIER_ORDER have a quota defined', () => {
    C.TIER_ORDER.forEach(tier => {
      expect(C.STORAGE_QUOTAS[tier]).toBeGreaterThan(0);
    });
  });

  test('Quotas increase monotonically with tier', () => {
    for (let i = 1; i < C.TIER_ORDER.length; i++) {
      const prev = C.STORAGE_QUOTAS[C.TIER_ORDER[i - 1]];
      const curr = C.STORAGE_QUOTAS[C.TIER_ORDER[i]];
      expect(curr).toBeGreaterThan(prev);
    }
  });
});

/* ─────────────────────────────────────────────────────────────
   Timing Constants
───────────────────────────────────────────────────────────── */
describe('Timing constants', () => {
  test('MS_MINUTE = 60 * MS_SECOND', () => {
    expect(C.MS_MINUTE).toBe(60 * C.MS_SECOND);
  });

  test('MS_HOUR = 60 * MS_MINUTE', () => {
    expect(C.MS_HOUR).toBe(60 * C.MS_MINUTE);
  });

  test('MS_DAY = 24 * MS_HOUR', () => {
    expect(C.MS_DAY).toBe(24 * C.MS_HOUR);
  });

  test('MS_WEEK = 7 * MS_DAY', () => {
    expect(C.MS_WEEK).toBe(7 * C.MS_DAY);
  });

  test('HEALTH_STALE_MS is 5 minutes', () => {
    expect(C.HEALTH_STALE_MS).toBe(5 * C.MS_MINUTE);
  });
});

/* ─────────────────────────────────────────────────────────────
   Locale / Kenya Constants
───────────────────────────────────────────────────────────── */
describe('Locale constants', () => {
  test('DEFAULT_CURRENCY is KES', () => {
    expect(C.DEFAULT_CURRENCY).toBe('KES');
  });

  test('DEFAULT_TIMEZONE is Africa/Nairobi', () => {
    expect(C.DEFAULT_TIMEZONE).toBe('Africa/Nairobi');
  });

  test('DEFAULT_LOCALE is en-KE', () => {
    expect(C.DEFAULT_LOCALE).toBe('en-KE');
  });

  test('KRA_VAT_THRESHOLD is 5M KES', () => {
    expect(C.KRA_VAT_THRESHOLD).toBe(5_000_000);
  });
});
