'use strict';
/**
 * SOKONI COMMISSION CONFIGURATION — the single authoritative source of commission rates.
 * ============================================================================================
 * Every payment, webhook, settlement, refund, ledger entry, analytics report and invoice
 * obtains its effective rate from HERE, via finos-utils.calculateCommission(). Nothing else
 * may define a commission rate. scripts/verify-commission-single-source.js enforces that and
 * fails the deploy if a second table appears anywhere in the repository.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * There used to be three tables:
 *
 *   index.js       HUB_COMMISSION_DEFAULTS   keyed by HUB       marketplace 3%,  legal 5%
 *   finos-utils.js DEFAULT_COMMISSION_RATES  keyed by CATEGORY  marketplace 10%, legal 12%
 *   sokoni-pay.js  COMMISSION_RATES          keyed by HUB       legal 5% (shown to sellers)
 *
 * They disagreed, and which one applied depended on WHICH PAYMENT RAIL the customer happened
 * to use: the Daraja seller-till path priced a KES 10,000 legal consultation at KES 500, the
 * FinOS path at KES 1,200. Eight of nine overlapping hubs were priced differently. Nobody
 * chose that; it was an accident of two stacks growing separately.
 *
 * HOW THE CONFLICT WAS RESOLVED
 * -----------------------------
 * The HUB rates win. Two reasons, both evidential:
 *   1. They are the only rates ever actually charged in production. The FinOS category table
 *      settled at ZERO commission for its entire life because calculateCommission was called
 *      without its `db` argument (fixed 2026-07-13, commit f6efcf3). Nobody has ever been
 *      billed 12%.
 *   2. They are what sokoni-pay.js displays to sellers. Adopting the category rates would
 *      have been a silent price rise on people who were shown 5%.
 * Where a category had no hub counterpart there was no conflict, so its existing rate stands.
 * Each entry below records its provenance.
 *
 * ADDING A HUB
 * ------------
 * Add it to RATES (if it needs its own rate) or to ALIASES (if it prices like an existing
 * category). Do not create a table anywhere else — the drift guard will fail the build.
 */

/* Rates are a percentage of the gross order value. `fixedKES` is added on top and is used
 * where the platform charges a flat listing/transaction fee instead of a percentage. */
const RATES = {
  /* ── conflicts resolved to the HUB rate (the rate actually charged, and advertised) ── */
  marketplace:      { pct: 5,   fixedKES: 0,    _was: 'hub 3% / category 10%; base 3→5 2026-08-29 (seller commission policy)' },
  food_delivery:    { pct: 5,   fixedKES: 0,    _was: 'hub restaurant 5% / category 8%' },
  property:         { pct: 2,   fixedKES: 0,    _was: 'hub 2% / category 3%' },
  vehicles:         { pct: 0,   fixedKES: 2000, _was: 'hub flat KES 2000 / category 5%' },
  healthcare:       { pct: 5,   fixedKES: 0,    _was: 'hub 5% / category 12%' },
  legal:            { pct: 5,   fixedKES: 0,    _was: 'hub 5% / category 12%' },
  events:           { pct: 5,   fixedKES: 0,    _was: 'hub entertainment 5% / category 10%' },
  hotel:            { pct: 5,   fixedKES: 0,    _was: 'hub bnb 5%' },
  digital_products: { pct: 10,  fixedKES: 0,    _was: 'hub digital 10% / category 20%' },

  /* ── rates that were buried inside hub Cloud Functions as bare literals ──
   * These were never in any table. They were `const platformFeeRate = 0.03;` sitting in the
   * middle of a purchase handler, which is why no audit of the "commission tables" ever found
   * them. They are distinct products — a pay-per-view stream is not an event ticket is not a
   * venue booking — so they get their own categories rather than being flattened into `events`
   * and silently repriced. The values are exactly what those functions were charging. */
  event_tickets:    { pct: 3,   fixedKES: 0,    _was: 'event-hub.js:493 `const platformFeeRate = 0.03`' },
  ppv:              { pct: 15,  fixedKES: 0,    _was: 'entertainment-hub.js:215 `listing.price * 0.15`' },

  /* ── no hub counterpart, so no conflict: the existing category rate stands ── */
  services:         { pct: 15,  fixedKES: 0,    _was: 'category only' },
  education:        { pct: 15,  fixedKES: 0,    _was: 'category only' },
  jobs:             { pct: 15,  fixedKES: 0,    _was: 'category only' },
  classifieds:      { pct: 8,   fixedKES: 0,    _was: 'category only' },
  hub:              { pct: 12,  fixedKES: 0,    _was: 'delivery 12% platform / 88% rider — the rider-facing promise everywhere (was 8%, which paid riders 92% and contradicted the app)' },

  /* ── the platform keeps the whole amount: these are not marketplace sales ── */
  subscriptions:    { pct: 100, fixedKES: 0,    _was: 'category only — full amount is platform revenue' },
  advertising:      { pct: 100, fixedKES: 0,    _was: 'category only — full amount is platform revenue' },

  /* ── zero-rated ── */
  saas:             { pct: 0,   fixedKES: 0,    _was: 'hub 0%' },

  /* Applied when a hub/category is unknown. The HUB default (5%), not the category
     default (10%) — an unrecognised hub must not be charged double by accident. */
  default:          { pct: 5,   fixedKES: 0,    _was: 'hub default 5% / category default 10%' },
};

/* Hub and legacy names -> the category that prices them.
 * Merged from finos-router.js HUB_CATEGORY_MAP and index.js HUB_COMMISSION_DEFAULTS, which
 * used different vocabularies for the same hubs. Both vocabularies resolve here, so no caller
 * has to know which one it holds. */
const ALIASES = {
  shopping: 'marketplace', pos: 'marketplace', b2b: 'marketplace',
  restaurant: 'food_delivery', food: 'food_delivery',
  home_services: 'services', insurance: 'services', fitness: 'services',
  pharmacy: 'healthcare',
  property_agent: 'property',
  bnb: 'hotel',
  car_dealer: 'vehicles', car_hub: 'vehicles',
  entertainment: 'events', sports: 'events',
  freelancer: 'jobs', freelance: 'jobs',
  logistics: 'hub', delivery: 'hub', driver: 'hub',
  digital: 'digital_products', ai_services: 'digital_products',
};

/* Minimum commission on any non-zero-rated transaction, so a KES 20 sale does not cost more
 * to process than it earns. Was hardcoded as `const minKES = 10` inside index.js. */
const MIN_COMMISSION_KES = 10;

/* ══════════════════════════════════════════════════════════════════════════════════════════
   SUBSCRIPTION PLAN ADJUSTMENTS — CAPABILITY SHIPPED, POLICY OFF
   ══════════════════════════════════════════════════════════════════════════════════════════
   Engineering delivers capability. Business decides when capability becomes policy.

   The engine CAN apply subscription commission discounts. Whether it DOES is an operator
   decision, and the default is NO. A discount that activates itself because the code shipped
   is a pricing change nobody approved — and FINANCIAL_TRANSACTION_STANDARD.md is emphatic
   about what self-activating financial behaviour costs (see F6/P0-7: a fallback path that
   fired on a blank config value gave stock away in production).

   THE SWITCH IS OFF WHEN THE DOCUMENT IS ABSENT. Fail closed. Deleting the config, a failed
   read, an empty database, a fresh environment — every one of them means "no discounts",
   never "all discounts".

   A plan ADJUSTS the base rate; it never replaces it. That distinction is load-bearing: the
   legacy PLANS table advertised ABSOLUTE rates (free 15%, business 4%) from an era when the
   base was ~15%. Against today's 3% marketplace base, enforcing them would RAISE commission
   for every seller. The "discount" was a penalty.

   ── OPERATOR CONFIGURATION ───────────────────────────────────────────────────────────────
   revenueConfig/plan_adjustments:

     {
       "enabled": false,              // MASTER SWITCH. Absent or false => no adjustments, ever.
       "maxDiscountPct": 50,          // safety cap: no plan may discount more than this (%)
       "minEffectivePct": 0.5,        // safety floor: commission never falls below this (%)
       "allowZero": false,            // a plan may NOT drive commission to 0 unless this is true
       "plans": {
         "seller_pro":        { "enabled": true, "label": "Pro Plan Discount" },
         "seller_enterprise": { "enabled": true, "discountPct": 10 },
         "business":          { "enabled": true, "deltaPct": -1, "label": "Business Plan Discount" }
       }
     }

   PHASE 1 (now)  enabled:false            -> zero pricing change. Identical to today.
   PHASE 2 (dev)  enabled:true in staging  -> validate the whole money path.
   PHASE 3 (some) enabled:true + only the intended tiers listed in "plans".
   PHASE 4 (all)  every intended tier listed.

   Enabling, disabling, increasing, decreasing or suspending a discount requires NO deployment.

   ── PER-PLAN ADJUSTMENT, in precedence order ─────────────────────────────────────────────
     1. plans[tier].deltaPct     — explicit POINTS off the base (-1 turns 3% into 2%)
     2. plans[tier].discountPct  — explicit RELATIVE discount (10 turns 3% into 2.7%)
     3. the Subscription Engine's own features.commission_discount_pct, applied RELATIVELY

   (3) is the reason the discount is not defined here at all: sub-billing.js's plan catalog
   already carries commission_discount_pct (basic 2, pro 5, enterprise 10) and subscription-core
   surfaces it. Defining a second plan table would be the duplication the constitution forbids.

   RELATIVE, not points. Taken as points, a pro seller (5) on a 3% base would pay 3 - 5 = 0%,
   and enterprise (10) would go negative. The UI labels the field "Commission discount (%)".
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/* Safety limits. These are FLOORS on safety, not policy: an operator may tighten them via
   config, never loosen them past what is coded here. */
const PLAN_MIN_PCT      = 0.5;   /* commission never falls below this unless allowZero */
const PLAN_MAX_DISCOUNT = 50;    /* no plan may take more than half the commission */

/* The Firestore document that carries the whole policy. ONE doc, cached — not a read per plan,
   and not a read per payment. */
const PLAN_ADJUSTMENTS_DOC = 'plan_adjustments';   /* revenueConfig/plan_adjustments */

/** Is the plan-discount rollout switched on at all? Absent config => NO. Fail closed. */
function planRolloutEnabled(cfg) {
  return !!(cfg && cfg.enabled === true);
}

/**
 * Apply a seller's plan to a resolved base rate.
 *
 * @param {string} tier             plan tier, from the canonical Subscription Engine
 * @param {object} cfg              revenueConfig/plan_adjustments (or null)
 * @param {number} planDiscountPct  features.commission_discount_pct from the subscription
 * @param {number} baseRate         the rate that survived rules -> revenueConfig -> category
 * @returns {{rate, deltaPct, label, source, type, applied, skipped}}
 */
function applyPlanAdjustment(tier, cfg, planDiscountPct, baseRate) {
  const none = (skipped) => ({
    rate: baseRate, deltaPct: 0, label: null, source: 'none', type: null,
    applied: false, skipped: skipped || null,
  });

  /* SAFETY: the rollout switch. Off, absent, or unreadable => no adjustment. */
  if (!planRolloutEnabled(cfg)) return none('rollout_disabled');

  const t = String(tier || '').trim().toLowerCase();
  if (!t) return none('no_plan');
  if (!(baseRate > 0)) return none('no_base_rate');   /* nothing to discount */

  /* SAFETY: only tiers the operator has explicitly listed AND enabled. An unknown or
     unlisted plan gets nothing — that is what makes Phase 3 a limited rollout rather than
     an accidental general availability. */
  const plans = (cfg && cfg.plans) || {};
  const p = plans[t];
  if (!p || p.enabled !== true) return none('plan_not_enabled');

  const maxDiscount = Math.min(
    Number.isFinite(Number(cfg.maxDiscountPct)) ? Number(cfg.maxDiscountPct) : PLAN_MAX_DISCOUNT,
    PLAN_MAX_DISCOUNT);
  const floor = Number.isFinite(Number(cfg.minEffectivePct))
    ? Math.max(Number(cfg.minEffectivePct), 0)
    : PLAN_MIN_PCT;
  const allowZero = cfg.allowZero === true;
  const label = p.label || null;

  let rate = baseRate, type = null, source = null;

  const deltaPct = Number(p.deltaPct);
  const discountPct = Number(p.discountPct);
  const catalogPct = Number(planDiscountPct);

  if (Number.isFinite(deltaPct) && deltaPct !== 0) {
    /* 1. explicit POINTS off, by operator request */
    rate = baseRate + deltaPct;
    type = 'points';
    source = 'operator_delta';
  } else if (Number.isFinite(discountPct) && discountPct > 0) {
    /* 2. explicit RELATIVE discount, by operator request */
    rate = baseRate * (1 - Math.min(discountPct, maxDiscount) / 100);
    type = 'relative';
    source = 'operator_discount';
  } else if (Number.isFinite(catalogPct) && catalogPct > 0) {
    /* 3. the Subscription Engine's own plan catalog value, applied RELATIVELY */
    rate = baseRate * (1 - Math.min(catalogPct, maxDiscount) / 100);
    type = 'relative';
    source = 'subscription_plan';
  } else {
    return none('no_adjustment_configured');
  }

  /* ── SAFETY CLAMPS ──────────────────────────────────────────────────────────────────────
     A plan discounts. It never inverts commission, never exceeds the cap, and never reaches
     zero unless an operator has explicitly said zero is acceptable. */
  if (rate > baseRate) rate = baseRate;             /* a "discount" may not raise commission */
  const capFloor = baseRate * (1 - maxDiscount / 100);
  if (rate < capFloor) rate = capFloor;             /* cap: never discount more than maxDiscountPct */
  if (!allowZero && rate < floor) rate = floor;     /* floor: never zero unless configured */
  if (rate < 0) rate = 0;                           /* never negative, under any configuration */
  if (rate > 100) rate = 100;
  rate = Math.round(rate * 1000) / 1000;            /* 3dp — keeps 2.55% exact, no float dust */

  return {
    rate,
    deltaPct: Math.round((rate - baseRate) * 1000) / 1000,
    label,
    source,
    type,
    applied: rate !== baseRate,
    skipped: rate !== baseRate ? null : 'clamped_to_base',
  };
}


/**
 * Resolve the effective default rate for a hub OR a category name.
 * This is the ONLY function permitted to read RATES.
 *
 * @param {string} key hub or category (either vocabulary; case-insensitive)
 * @returns {{pct:number, fixedKES:number, category:string, matched:boolean}}
 */
function resolveRate(key) {
  const k = String(key || '').trim().toLowerCase();
  const category = RATES[k] ? k : (ALIASES[k] || null);
  if (!category || !RATES[category]) {
    return { ...RATES.default, category: 'default', matched: false };
  }
  const r = RATES[category];
  return { pct: r.pct, fixedKES: r.fixedKES, category, matched: true };
}

/** Every category name a caller may legitimately pass. Used by the drift guard and admin UIs. */
function listCategories() {
  return Object.keys(RATES);
}

/** Hub -> category, for callers that previously used finos-router's HUB_CATEGORY_MAP. */
function categoryForHub(hub) {
  return resolveRate(hub).category;
}

module.exports = {
  resolveRate,
  listCategories,
  categoryForHub,
  MIN_COMMISSION_KES,
  PLAN_ADJUSTMENTS_DOC,
  applyPlanAdjustment,
  planRolloutEnabled,
  PLAN_MIN_PCT,
  PLAN_MAX_DISCOUNT,
  /* Exposed READ-ONLY for admin dashboards and the client rate endpoint. Never mutate. */
  RATES: Object.freeze(RATES),
  ALIASES: Object.freeze(ALIASES),
};
