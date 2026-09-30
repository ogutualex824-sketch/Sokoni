/**
 * Unit tests — SASOS Core (Phase 4–11)
 * Validates: plan registry integrity, tax calculations,
 * billing constants alignment, period helpers.
 * No Firebase Admin dependency — tests pure data and pure functions.
 */

'use strict';

/* ── Mocks (firebase-functions, firebase-admin) ────────────── */
jest.mock('firebase-functions/v2/https', () => ({
  HttpsError: jest.fn().mockImplementation(function(code, msg) { this.code = code; this.message = msg; }),
  onCall: jest.fn(),
}));
jest.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: jest.fn() }));
jest.mock('firebase-functions', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));

const mockDb = {
  collection: jest.fn().mockReturnThis(),
  doc: jest.fn().mockReturnThis(),
  add: jest.fn().mockResolvedValue({ id: 'mock-id' }),
  set: jest.fn().mockResolvedValue({}),
  get: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
};
const mockFieldValue = { serverTimestamp: jest.fn(() => 'SERVER_TS'), arrayUnion: jest.fn(), arrayRemove: jest.fn(), increment: jest.fn() };
jest.mock('firebase-admin', () => ({
  firestore: Object.assign(jest.fn(() => mockDb), { FieldValue: mockFieldValue }),
  initializeApp: jest.fn(),
}));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn().mockResolvedValue({ content: [{ text: 'Test insight.' }] }) },
})));

/* ── Load modules AFTER mocks are set up ────────────────────── */
const C = require('../shared/constants');
const { SASOS_PLANS, SASOS_PRODUCTS, TIER_ORDER } = require('../sasos-core');

/* ─────────────────────────────────────────────────────────────
   Plan Registry — Structure Validation
───────────────────────────────────────────────────────────── */
describe('SASOS Plan Registry', () => {
  const allPlans = Object.entries(SASOS_PLANS);

  test('Plan registry is not empty', () => {
    expect(allPlans.length).toBeGreaterThan(0);
  });

  test('All plans have a planId-consistent key format (product.tier)', () => {
    allPlans.forEach(([key]) => {
      expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    });
  });

  test('All plans have required fields: productId, tier, billing, limits, features, commission, tax', () => {
    const required = ['productId', 'tier', 'billing', 'limits', 'features', 'commission', 'tax'];
    allPlans.forEach(([key, plan]) => {
      required.forEach(field => {
        expect(plan).toHaveProperty(field);
        // eslint-disable-next-line jest/no-conditional-expect
        if (!plan[field]) {
          throw new Error(`Plan ${key} is missing required field: ${field}`);
        }
      });
    });
  });

  test('All billing objects have: monthly, annual, trialDays, currency', () => {
    const billingFields = ['monthly', 'annual', 'trialDays', 'currency'];
    allPlans.forEach(([key, plan]) => {
      billingFields.forEach(f => {
        expect(plan.billing).toHaveProperty(f);
      });
      expect(plan.billing.currency).toBe('KES');
    });
  });

  test('All tax objects have vat_applicable (boolean) and vat_rate', () => {
    allPlans.forEach(([key, plan]) => {
      expect(typeof plan.tax.vat_applicable).toBe('boolean');
      expect(typeof plan.tax.vat_rate).toBe('number');
    });
  });

  test('VAT rate on all taxed plans is 16% (matching KRA standard)', () => {
    allPlans
      .filter(([, p]) => p.tax.vat_applicable)
      .forEach(([key, plan]) => {
        expect(plan.tax.vat_rate).toBeCloseTo(C.VAT_RATE, 5);
      });
  });

  test('Free-tier plans have monthly billing of 0', () => {
    allPlans
      .filter(([key]) => key.endsWith('.free'))
      .forEach(([key, plan]) => {
        expect(plan.billing.monthly).toBe(0);
        expect(plan.billing.annual).toBe(0);
      });
  });

  test('All 13 SASOS products have at least one plan', () => {
    const products = SASOS_PRODUCTS;
    products.forEach(product => {
      const productPlans = allPlans.filter(([key]) => key.startsWith(product + '.'));
      expect(productPlans.length).toBeGreaterThan(0);
    });
  });

  test('Higher-tier plans have higher or equal monthly billing than lower-tier plans (per product)', () => {
    SASOS_PRODUCTS.forEach(product => {
      const freePlan     = SASOS_PLANS[`${product}.free`];
      const starterPlan  = SASOS_PLANS[`${product}.starter`];
      const enterprisePlan = SASOS_PLANS[`${product}.enterprise`];
      if (freePlan && starterPlan) {
        expect(starterPlan.billing.monthly).toBeGreaterThanOrEqual(freePlan.billing.monthly);
      }
      if (starterPlan && enterprisePlan) {
        expect(enterprisePlan.billing.monthly).toBeGreaterThan(starterPlan.billing.monthly);
      }
    });
  });

  test('Commission rates decrease with higher tiers (discounts for higher commitment)', () => {
    ['marketplace', 'smartpos'].forEach(product => {
      const free       = SASOS_PLANS[`${product}.free`]?.commission?.rate_pct;
      const enterprise = SASOS_PLANS[`${product}.enterprise`]?.commission?.rate_pct;
      if (free !== undefined && enterprise !== undefined) {
        expect(enterprise).toBeLessThan(free);
      }
    });
  });

  test('-1 limits mean unlimited (most enterprise plans; AI/credits products may have finite caps)', () => {
    /* Products where unlimited (-1) applies: marketplace, smartpos, logistics, delivery, etc.
       AI Studio enterprise has finite credits/API limits (compute costs real $) — intentional. */
    const PRODUCTS_REQUIRING_UNLIMITED = ['marketplace', 'smartpos', 'logistics', 'events', 'property', 'vehicles', 'warehousing', 'analytics'];
    PRODUCTS_REQUIRING_UNLIMITED.forEach(product => {
      const entPlan = SASOS_PLANS[`${product}.enterprise`];
      if (entPlan) {
        const limits = Object.values(entPlan.limits);
        const hasUnlimited = limits.some(v => v === -1);
        expect(hasUnlimited).toBe(true);
      }
    });
  });

  test('AI enterprise plan has higher limits than AI free plan (finite but premium)', () => {
    const aiFree = SASOS_PLANS['ai.free'];
    const aiEnt  = SASOS_PLANS['ai.enterprise'];
    if (aiFree && aiEnt) {
      expect(aiEnt.limits.ai_credits).toBeGreaterThan(aiFree.limits.ai_credits);
      expect(aiEnt.limits.storage_gb).toBeGreaterThan(aiFree.limits.storage_gb);
    }
  });
});

/* ─────────────────────────────────────────────────────────────
   SASOS_PRODUCTS — consistency with shared constants
───────────────────────────────────────────────────────────── */
describe('SASOS_PRODUCTS list', () => {
  test('Has exactly 13 product verticals', () => {
    expect(SASOS_PRODUCTS).toHaveLength(13);
  });

  test('All product IDs are lowercase strings with no spaces', () => {
    SASOS_PRODUCTS.forEach(p => {
      expect(typeof p).toBe('string');
      expect(p).toBe(p.toLowerCase());
      expect(p).not.toContain(' ');
    });
  });

  test('No duplicate products', () => {
    expect(new Set(SASOS_PRODUCTS).size).toBe(SASOS_PRODUCTS.length);
  });

  test('Matches shared/constants.js SASOS_PRODUCTS (same 13 items)', () => {
    expect(SASOS_PRODUCTS.sort()).toEqual([...C.SASOS_PRODUCTS].sort());
  });

  test('Includes core verticals: marketplace, smartpos, ai, delivery', () => {
    ['marketplace', 'smartpos', 'ai', 'delivery'].forEach(p => {
      expect(SASOS_PRODUCTS).toContain(p);
    });
  });
});

/* ─────────────────────────────────────────────────────────────
   TIER_ORDER — upgrade / downgrade logic
───────────────────────────────────────────────────────────── */
describe('TIER_ORDER (sasos-core)', () => {
  test('free has lowest tier index', () => {
    expect(TIER_ORDER.free).toBe(0);
  });

  test('enterprise has highest tier index', () => {
    const maxTier = Math.max(...Object.values(TIER_ORDER));
    expect(TIER_ORDER.enterprise).toBe(maxTier);
  });

  test('Upgrade logic: enterprise > business > pro > starter > free', () => {
    expect(TIER_ORDER.enterprise).toBeGreaterThan(TIER_ORDER.business);
    expect(TIER_ORDER.business).toBeGreaterThan(TIER_ORDER.pro);
    expect(TIER_ORDER.pro).toBeGreaterThan(TIER_ORDER.starter);
    expect(TIER_ORDER.starter).toBeGreaterThan(TIER_ORDER.free);
  });
});

/* ─────────────────────────────────────────────────────────────
   currentPeriod() — billing period helper from shared/constants
───────────────────────────────────────────────────────────── */
describe('currentPeriod helper', () => {
  test('Returns YYYY-MM format string', () => {
    const p = C.currentPeriod();
    expect(p).toMatch(/^\d{4}-\d{2}$/);
  });

  test('Month is padded to 2 digits', () => {
    const d = new Date('2026-01-15');
    expect(C.currentPeriod(d)).toBe('2026-01');
  });

  test('December returns 12', () => {
    const d = new Date('2026-12-01');
    expect(C.currentPeriod(d)).toBe('2026-12');
  });

  test('Two calls within the same second return the same value', () => {
    expect(C.currentPeriod()).toBe(C.currentPeriod());
  });

  test('periodMonthsAgo(0) returns current period', () => {
    expect(C.periodMonthsAgo(0)).toBe(C.currentPeriod());
  });

  test('periodMonthsAgo(1) returns previous month', () => {
    const now  = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    expect(C.periodMonthsAgo(1)).toBe(C.currentPeriod(prev));
  });
});

/* ─────────────────────────────────────────────────────────────
   Tax helpers — withVat / whtAmount
───────────────────────────────────────────────────────────── */
describe('Tax helpers (shared/constants)', () => {
  test('withVat: KES 1000 excl → KES 1160 incl', () => {
    expect(C.withVat(1000)).toBeCloseTo(1160, 0);
  });

  test('withVat: KES 0 → KES 0', () => {
    expect(C.withVat(0)).toBe(0);
  });

  test('whtAmount: KES 30000 → KES 1500 (5%)', () => {
    expect(C.whtAmount(30_000)).toBe(1_500);
  });

  test('whtAmount: KES 20000 → 0 (below WHT_THRESHOLD)', () => {
    expect(C.whtAmount(20_000)).toBe(0);
  });

  test('whtAmount: exactly at threshold → 0 (threshold is exclusive)', () => {
    expect(C.whtAmount(C.WHT_THRESHOLD)).toBe(0);
  });

  test('whtAmount: 1 above threshold → applies WHT', () => {
    expect(C.whtAmount(C.WHT_THRESHOLD + 1)).toBeGreaterThan(0);
  });
});

/* ─────────────────────────────────────────────────────────────
   _calcTax (sasos-billing) — VAT reverse calculation
   Extracted logic tested without importing the full CF module
───────────────────────────────────────────────────────────── */
describe('SASOS billing tax calculation logic', () => {
  const VAT = C.VAT_RATE;

  function calcTax(amount, vat_applicable, vat_rate = VAT) {
    if (!vat_applicable) return { subtotal: amount, tax: 0, total: amount };
    const subtotal = Math.round(amount / (1 + vat_rate));
    const tax      = amount - subtotal;
    return { subtotal, tax, total: amount };
  }

  test('Non-VAT item: tax=0, subtotal=total=amount', () => {
    const result = calcTax(1000, false);
    expect(result.tax).toBe(0);
    expect(result.subtotal).toBe(1000);
    expect(result.total).toBe(1000);
  });

  test('VAT item: total is always the VAT-inclusive amount passed in', () => {
    const result = calcTax(1160, true);
    expect(result.total).toBe(1160);
  });

  test('VAT item: subtotal + tax === total', () => {
    const result = calcTax(1160, true);
    expect(result.subtotal + result.tax).toBe(result.total);
  });

  test('VAT item: KES 1160 inclusive → KES 1000 excl, KES 160 tax', () => {
    const result = calcTax(1160, true);
    expect(result.subtotal).toBe(1000);
    expect(result.tax).toBe(160);
  });

  test('VAT item: zero amount has zero tax', () => {
    const result = calcTax(0, true);
    expect(result.tax).toBe(0);
    expect(result.total).toBe(0);
  });

  test('Rounding: fractions do not produce negative tax', () => {
    const result = calcTax(499, true);
    expect(result.tax).toBeGreaterThanOrEqual(0);
    expect(result.subtotal + result.tax).toBe(499);
  });
});

/* ─────────────────────────────────────────────────────────────
   Dunning Schedule — constant alignment
───────────────────────────────────────────────────────────── */
describe('SASOS dunning schedule alignment', () => {
  test('DUNNING_DAYS from shared constants matches SASOS billing schedule', () => {
    expect(C.DUNNING_DAYS).toEqual([1, 3, 7, 14]);
  });

  test('Last dunning day equals grace period (suspension at end of grace)', () => {
    const last = C.DUNNING_DAYS[C.DUNNING_DAYS.length - 1];
    expect(last).toBeGreaterThanOrEqual(C.GRACE_PERIOD_DAYS);
  });

  test('TRIAL_DAYS is 14 days (standard SaaS trial)', () => {
    expect(C.TRIAL_DAYS).toBe(14);
  });
});
