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
  marketplace:      { pct: 3,   fixedKES: 0,    _was: 'hub 3% / category 10%' },
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
  hub:              { pct: 8,   fixedKES: 0,    _was: 'hub delivery 8% = category 8% (agreed)' },

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
   SUBSCRIPTION PLAN ADJUSTMENTS
   ══════════════════════════════════════════════════════════════════════════════════════════
   A plan adjusts the BASE rate. It does not replace it.

   That distinction is load-bearing. sokoni-pay.js PLANS advertised ABSOLUTE plan rates
   (free 15%, starter 10%, pro 7%, business 4%) which the server never enforced — they are
   left over from an older pricing model where the base was ~10-15%. The consolidated base for
   marketplace is 3%. Enforcing those absolute numbers as written would RAISE commission for
   every seller on the platform: a free seller would jump 3% -> 15%, and even a Business seller
   would go 3% -> 4%. The "discount" was a penalty.

   So a plan is modelled as a DELTA on whatever base survives rules/revenueConfig/category —
   which is also exactly what the sprint brief describes: "Marketplace, Base 3%, Business Plan
   Discount, Final 2%".

   DEFAULTS ARE ZERO, DELIBERATELY. The brief says "do not change existing commission
   percentages unless required by configuration". Shipping a non-zero default would silently
   reprice every seller on the platform the moment this deploys. The mechanism ships enabled;
   the discounts ship OFF, and an operator turns them on by writing:

     revenueConfig/plan_adjustments = {
       business: { deltaPct: -1, label: "Business Plan Discount" },
       pro:      { deltaPct: -0.5, label: "Pro Plan Discount" },
     }

   ...which requires no code change, and supports plans that do not exist yet (an unknown tier
   simply has no adjustment). Firestore wins over this file; this file is the safe default.

   deltaPct  — percentage POINTS added to the base. Negative = discount. -1 turns 3% into 2%.
   minPct    — floor for this plan, so a discount can never drive commission below it.
   label     — the human reason shown to the seller ("Business Plan Discount").
   ══════════════════════════════════════════════════════════════════════════════════════════ */
const PLAN_ADJUSTMENTS = {
  free:     { deltaPct: 0, minPct: 0, label: 'Free Plan' },
  starter:  { deltaPct: 0, minPct: 0, label: 'Starter Plan' },
  pro:      { deltaPct: 0, minPct: 0, label: 'Pro Plan' },
  business: { deltaPct: 0, minPct: 0, label: 'Business Plan' },
};

/* Floor for any plan-discounted rate. A plan may reduce commission; it may never make the
   platform pay to process a sale. Overridable per-plan via minPct. */
const PLAN_MIN_PCT = 0.5;

/* The Firestore document that overrides the table above. One doc, not one per plan, so the
   engine costs ONE cached read rather than a read per plan. */
const PLAN_ADJUSTMENTS_DOC = 'plan_adjustments';   /* revenueConfig/plan_adjustments */

/**
 * Apply a seller's plan to a resolved base rate.
 *
 * THE DISCOUNT IS NOT DEFINED HERE. It comes from the canonical Subscription Engine — the plan
 * catalog in sub-billing.js already carries `features.commission_discount_pct` (seller_basic 2,
 * seller_pro 5, seller_enterprise 10, enterprise 15) and subscription-core surfaces it in the
 * canonical `features` map. Nothing has ever read it. Defining a second plan table here would
 * be exactly the duplication the constitution forbids, so this function CONSUMES that value.
 *
 * SEMANTICS: commission_discount_pct is RELATIVE — "15% off your commission", which is how the
 * UI labels it ("Commission discount (%)", plans.html:204).
 *
 * It is not points off. That reading is a trap, and the same trap the absolute plan rates were:
 * the values were authored when the base was ~15%. Taken as points against today's consolidated
 * 3% marketplace base, a `pro` seller would pay 3 - 5 = 0%, and enterprise would go negative.
 * A plan must never be able to zero out commission by arithmetic accident, so:
 *
 *     effective = base * (1 - discountPct/100)      floored at minPct
 *
 *     Marketplace base 3%, enterprise plan (15% off) -> 2.55%
 *
 * An operator who genuinely wants points-off can say so explicitly with `deltaPct` in
 * revenueConfig/plan_adjustments, which overrides the plan catalog. Both forms are supported;
 * only one is the default, and it is the safe one.
 *
 * @param {string}  tier        the plan tier from the Subscription Engine
 * @param {object}  overrides   revenueConfig/plan_adjustments payload (or null)
 * @param {number}  planDiscountPct  features.commission_discount_pct from the subscription
 * @param {number}  baseRate    the rate that survived rules -> revenueConfig -> category
 * @returns {{rate:number, deltaPct:number, label:string|null, source:string, applied:boolean}}
 */
function applyPlanAdjustment(tier, overrides, planDiscountPct, baseRate) {
  const none = { rate: baseRate, deltaPct: 0, label: null, source: 'none', applied: false };
  const t = String(tier || '').trim().toLowerCase();
  if (!t || !(baseRate > 0)) return none;

  const ov = (overrides && overrides[t]) || null;
  const file = PLAN_ADJUSTMENTS[t] || null;
  /* Careful: Number(null) is 0, which IS finite — so `Number.isFinite(ov && ov.minPct)` would
     wave a null `ov` straight through and then dereference it. Read each source explicitly. */
  const ovMin   = ov   && Number(ov.minPct);
  const fileMin = file && Number(file.minPct);
  const floor = Number.isFinite(ovMin) && ovMin > 0 ? ovMin
              : Number.isFinite(fileMin) && fileMin > 0 ? fileMin
              : PLAN_MIN_PCT;
  const label = (ov && ov.label) || (file && file.label) || null;

  let rate = baseRate, deltaPct = 0, source = 'none';

  /* 1. An explicit operator override wins over everything. Points off, by request. */
  const ovDelta = ov && Number(ov.deltaPct);
  if (Number.isFinite(ovDelta) && ovDelta !== 0) {
    rate = baseRate + ovDelta;
    deltaPct = ovDelta;
    source = 'revenue_config_plan';
  } else {
    /* 2. Otherwise the plan catalog's own discount, applied RELATIVELY. */
    const disc = Number(planDiscountPct);
    if (Number.isFinite(disc) && disc > 0) {
      rate = baseRate * (1 - disc / 100);
      deltaPct = rate - baseRate;              /* record the actual points moved, for audit */
      source = 'subscription_plan';
    }
  }

  if (source === 'none') return none;

  /* Validate. A plan discounts; it never inverts. */
  if (rate < floor) rate = floor;
  if (rate < 0) rate = 0;
  if (rate > 100) rate = 100;
  rate = Math.round(rate * 1000) / 1000;       /* 3dp — keeps 2.55% exact, avoids float dust */

  return {
    rate,
    deltaPct: Math.round((rate - baseRate) * 1000) / 1000,
    label,
    source,
    applied: rate !== baseRate,
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
  PLAN_MIN_PCT,
  PLAN_ADJUSTMENTS: Object.freeze(PLAN_ADJUSTMENTS),
  /* Exposed READ-ONLY for admin dashboards and the client rate endpoint. Never mutate. */
  RATES: Object.freeze(RATES),
  ALIASES: Object.freeze(ALIASES),
};
