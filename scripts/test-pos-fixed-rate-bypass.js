#!/usr/bin/env node
'use strict';
/* ============================================================================
   POS FIXED-RATE BYPASS — the recorded POS decision, exercised through the real resolver
   ----------------------------------------------------------------------------
   Decision under test (owner, 2026-09-06 · 2026-09-26 · 2026-09-28): a POS / Till / Quick
   Charge sale is priced by commission-config.RATES.pos and NOTHING else. commissionRules,
   revenueConfig/{seller_,hub_,global}, a subscription plan rate and plan adjustments are all
   bypassed — and the bypass is recorded on the result so a ledger row can explain itself.

   This calls finos-utils.calculateCommission (the function webhookIntasend / FinOS use) with a
   stub Firestore that OFFERS every override, then checks the override did not bite for POS and
   DID bite for a marketplace sale — the same stub, the same rule, two categories. It also
   counts the revenueConfig reads so the bypass is proven to skip them, not merely ignore them.

   Pure, no network. Usage: node scripts/test-pos-fixed-rate-bypass.js
   ============================================================================ */
const path = require('path');
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:1';
const ROOT = path.resolve(__dirname, '..');
const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-fixed-rate-test' });
const CC = require(path.join(ROOT, 'functions', 'commission-config'));
const FU = require(path.join(ROOT, 'functions', 'finos-utils'));

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else    { fail++; console.log(`  FAIL  ${label}${detail ? '  -> ' + JSON.stringify(detail) : ''}`); }
};

/* ── stub Firestore: offers a matching commissionRule AND revenueConfig overrides ─────── */
function makeDb({ rule, sellerPct = 1, globalPct = 1, planAdj = false } = {}) {
  const reads = { revenueConfig: [], commissionRules: 0 };
  const snap = (exists, data) => ({ exists, data: () => data, id: data && data.id });
  return {
    _reads: reads,
    collection(name) {
      if (name === 'commissionRules') {
        let holidayQuery = false;
        return {
          where(f, _op, v) { if (f === 'type' && v === 'commission_holiday') holidayQuery = true; return this; },
          async get() {
            reads.commissionRules++;
            /* the holiday query must see no holiday — this stub offers overrides, not campaigns */
            const docs = (rule && !holidayQuery) ? [{ id: rule.id, data: () => rule }] : [];
            return { docs, empty: docs.length === 0 };
          },
        };
      }
      if (name === 'revenueConfig') {
        return {
          doc(id) {
            return {
              async get() {
                reads.revenueConfig.push(id);
                if (id === 'plan_adjustments') return planAdj ? snap(true, { enabled: true }) : snap(false, null);
                if (id.startsWith('seller_')) return sellerPct == null ? snap(false, null) : snap(true, { commissionPct: sellerPct });
                if (id === 'global')          return globalPct == null ? snap(false, null) : snap(true, { defaultCommissionPct: globalPct });
                return snap(false, null);
              },
            };
          },
        };
      }
      if (name === 'subscriptions' || name === 'users') {
        return { doc() { return { async get() { return snap(false, null); } }; },
                 where() { return this; }, limit() { return this; },
                 async get() { return { docs: [], empty: true }; } };
      }
      return { doc() { return { async get() { return snap(false, null); } }; },
               where() { return this; }, async get() { return { docs: [], empty: true }; } };
    },
  };
}

const RULE = { id: 'rule_seller_all', entityId: 'seller_A', category: 'all', rate: 1, isActive: true, type: 'percentage' };

(async () => {
  console.log('POS fixed-rate bypass — decision exercised through finos-utils.calculateCommission\n');

  /* S1 — the authority states the decision */
  /* Exactly the OWNER-DECIDED fixed lanes: pos (2026-09-06/26/28) and fitness (2026-10-03, "5% commission per booking"). */
  ck('S1  FIXED_RATE_CATEGORIES is exactly the owner-decided lanes [pos, fitness]', JSON.stringify(CC.FIXED_RATE_CATEGORIES) === '["pos","fitness"]', CC.FIXED_RATE_CATEGORIES);
  ck('S1  isFixedRateCategory: pos / till / quick_charge true; marketplace / product / services false',
     ['pos', 'till', 'quick_charge', 'quickcharge'].every(CC.isFixedRateCategory)
     && !['marketplace', 'product', 'services', 'hub', 'default', 'no_such'].some(CC.isFixedRateCategory));
  ck('S1  RATES.pos is 5% with no flat fee', CC.RATES.pos.pct === 5 && CC.RATES.pos.fixedKES === 0, CC.RATES.pos);

  /* S2 — POS with a matching commissionRule (1%) and revenueConfig overrides (1%) still pays 5% */
  {
    const db = makeDb({ rule: RULE });
    const r = await FU.calculateCommission(db, { orderAmountCents: 1000000, category: 'pos', sellerId: 'seller_A', hubId: 'pos' });
    ck('S2  POS KES 10,000 with rule + revenueConfig offering 1%: commission is KES 500 (5%)', r.commissionCents === 50000 && r.effectiveRate === 5, r);
    ck('S2  result records the bypass: fixedRateCategory=true, overrideIgnored=true', r.fixedRateCategory === true && r.overrideIgnored === true, r);
    ck('S2  provenance: ruleId / ruleSource / pricingSource name fixed_rate_category',
       r.ruleId === 'fixed_rate_category' && r.ruleSource === 'fixed_rate_category' && /^fixed_rate_category/.test(r.pricingSource), r);
    ck('S2  planSkipped = fixed_rate_category (no plan adjustment considered)', r.planSkipped === 'fixed_rate_category', r);
    ck('S2  revenueConfig seller_/hub_/global were NOT read for POS (bypass skips the lookups)',
       !db._reads.revenueConfig.some((id) => /^(seller_|hub_|global$)/.test(id)), db._reads);
    ck('S2  sellerNet = gross − commission', r.sellerNetCents === 1000000 - 50000, r);
  }

  /* S3 — the alias path is identical: category "till" */
  {
    const db = makeDb({ rule: RULE });
    const r = await FU.calculateCommission(db, { orderAmountCents: 1000000, category: 'till', sellerId: 'seller_A' });
    ck('S3  category "till" prices exactly as "pos" (5%, bypass recorded)', r.commissionCents === 50000 && r.fixedRateCategory === true && r.category === 'pos', r);
  }

  /* S4 — the SAME rule bites a marketplace sale: the bypass is category-scoped, not a dead override system */
  {
    const db = makeDb({ rule: RULE });
    const r = await FU.calculateCommission(db, { orderAmountCents: 1000000, category: 'marketplace', sellerId: 'seller_A' });
    ck('S4  marketplace with the same rule: rule rate (1%) applies, KES 100', r.commissionCents === 10000 && r.effectiveRate === 1, r);
    ck('S4  marketplace result: fixedRateCategory=false, overrideIgnored=false, ruleId=rule id', r.fixedRateCategory === false && r.overrideIgnored === false && r.ruleId === RULE.id, r);
  }

  /* S5 — no rule, revenueConfig only: marketplace honours it, POS does not */
  {
    const dbM = makeDb({ rule: null, sellerPct: 2 });
    const m = await FU.calculateCommission(dbM, { orderAmountCents: 1000000, category: 'marketplace', sellerId: 'seller_A' });
    ck('S5  marketplace with revenueConfig/seller_A commissionPct 2: KES 200, source revenue_config', m.commissionCents === 20000 && m.ruleSource === 'revenue_config', m);
    const dbP = makeDb({ rule: null, sellerPct: 2 });
    const p = await FU.calculateCommission(dbP, { orderAmountCents: 1000000, category: 'pos', sellerId: 'seller_A' });
    ck('S5  POS with the same revenueConfig: still KES 500, overrideIgnored=false (no rule existed)', p.commissionCents === 50000 && p.overrideIgnored === false && p.fixedRateCategory === true, p);
  }

  /* S6 — a subscription role cannot re-price POS either */
  {
    const db = makeDb({ rule: null });
    const r = await FU.calculateCommission(db, { orderAmountCents: 1000000, category: 'pos', sellerId: 'seller_A', subscriptionRole: 'provider' });
    ck('S6  POS with subscriptionRole=provider: 5%, pricing not "subscription_plan_rate"', r.commissionCents === 50000 && !/subscription/.test(r.pricingSource), r);
  }

  /* S7 — the platform minimum still applies on the POS lane (POS_PLAN_RATES.floorExempt is false) */
  {
    const db = makeDb({ rule: null });
    const r = await FU.calculateCommission(db, { orderAmountCents: 10000, category: 'pos', sellerId: 'seller_A' });
    ck(`S7  POS KES 100: 5% = KES 5 is floored to the KES ${CC.MIN_COMMISSION_KES} minimum`, r.commissionCents === CC.MIN_COMMISSION_KES * 100, r);
  }

  /* S8 — the two other 2026-09-28 rows this change corrected */
  {
    const prop = CC.resolveRate('property');
    ck('S8  property: KES 5,000 flat, 0% (owner schedule 2026-09-28)', prop.pct === 0 && prop.fixedKES === 5000 && prop.matched, prop);
    const db = makeDb({ rule: null, sellerPct: null, globalPct: null });   /* no overrides at all */
    const r = await FU.calculateCommission(db, { orderAmountCents: 100000000, category: 'property', sellerId: 'seller_A' });
    ck('S8  property KES 1,000,000 sale: commission is exactly KES 5,000', r.commissionCents === 500000 && r.effectiveRate === 0, r);
    const hub = CC.resolveRate('delivery');
    ck('S8  delivery / logistics / driver resolve to the 17% floor of the 17–25% share, not 12%',
       hub.pct === 17 && CC.resolveRate('logistics').pct === 17 && CC.resolveRate('driver').pct === 17, hub);
    let DQ = null; try { DQ = require(path.join(ROOT, 'functions', 'delivery-quote-authority')); } catch (_) {}
    ck('S8  the floor equals delivery-quote-authority.SHARE_MIN_PCT (one number, two places, kept equal)', DQ && DQ.SHARE_MIN_PCT === hub.pct, DQ && { SHARE_MIN_PCT: DQ.SHARE_MIN_PCT });
  }

  /* ── FITNESS (owner 2026-10-03: "5% commission per booking for the bookings") ── same lane semantics as POS,
     plus NO platform minimum (provider bookings never had one). */
  ck('F1  RATES.fitness is 5% flat; gym / fitness-hub / personal_training resolve to it; services is NOT fixed',
     CC.RATES.fitness.pct === 5 && CC.RATES.fitness.fixedKES === 0 && ['fitness', 'gym', 'fitness-hub', 'personal_training'].every(CC.isFixedRateCategory) && !CC.isFixedRateCategory('services'));
  {
    const db = makeDb({ rule: RULE });
    const r = await FU.calculateCommission(db, { orderAmountCents: 150000, category: 'fitness', sellerId: 'seller_A', subscriptionRole: 'provider' });
    ck('F2  KES 1,500 fitness booking with rule 1% + revenueConfig 1% + provider plan: KES 75 (5%), bypass recorded',
       r.commissionCents === 7500 && r.effectiveRate === 5 && r.fixedRateCategory === true && r.overrideIgnored === true && !/subscription/.test(r.pricingSource), r);
    ck('F2  revenueConfig not read for fitness', !db._reads.revenueConfig.some((id) => /^(seller_|hub_|global$)/.test(id)), db._reads);
  }
  {
    const db = makeDb({ rule: null });
    const r = await FU.calculateCommission(db, { orderAmountCents: 10000, category: 'fitness', sellerId: 'trainer_A' });
    ck('F3  KES 100 fitness session: exactly KES 5 (5%) — no KES 10 floor', r.commissionCents === 500, r);
    const g = await FU.calculateCommission(makeDb({ rule: null }), { orderAmountCents: 200000, category: 'gym', sellerId: 'gym_B' });
    ck('F3  alias "gym" KES 2,000 → KES 100, category fitness', g.commissionCents === 10000 && g.category === 'fitness', g);
  }
  {
    const r = await FU.calculateCommission(makeDb({ rule: RULE }), { orderAmountCents: 1000000, category: 'services', sellerId: 'svc_C' });
    ck('F4  control: a generic "services" booking still honours the admin rule (1%) — fitness is scoped, not global', r.commissionCents === 10000 && r.fixedRateCategory === false, r);
    const p = await FU.calculateCommission(makeDb({ rule: null }), { orderAmountCents: 10000, category: 'pos', sellerId: 'seller_A' });
    ck('F4  control: POS keeps its KES 10 floor (only fitness is floor-exempt)', p.commissionCents === CC.MIN_COMMISSION_KES * 100, p);
  }

  /* ── FLAT SERVICE BOOKINGS (owner 2026-10-03): no plan may move them, even with plan discounts switched ON ── */
  ck('B1  every service-booking category is flat (services, home services, car rental, healthcare, entertainment, fitness); marketplace is not',
     ['services', 'home_services', 'car-rental', 'healthcare', 'entertainment_bookings', 'fitness', 'gym'].every(CC.isFlatBookingCategory) && !['marketplace', 'product', 'pos'].some(CC.isFlatBookingCategory));
  for (const cat of ['services', 'home_services', 'healthcare', 'car-rental']) {
    const r = await FU.calculateCommission(makeDb({ rule: null, sellerPct: null, globalPct: null, planAdj: true }), { orderAmountCents: 100000, category: cat, sellerId: 'prov_X', skipMinimum: true });
    ck('B2  ' + cat + ' with plan discounts ROLLED OUT: still KES 50 (5%), planSkipped flat_booking_rate', r.commissionCents === 5000 && r.planSkipped === 'flat_booking_rate' && r.planApplied !== true, r);
  }
  /* B3 control is B1's negative half (marketplace / product / pos are NOT flat). A runtime marketplace call with the rollout
     ON would reach the real Subscription Engine (Firestore) — not available offline, so it is not exercised here. */

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
