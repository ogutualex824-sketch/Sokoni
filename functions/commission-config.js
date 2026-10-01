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
  /* 3% — the historical differentiated BASE, restored by owner decision 2026-08-30.
     This is the base a seller's subscription package then DISCOUNTS; it is not a flat
     charge. Marketplace money comes from category rate + package economics, which is why
     flattening it to 5% removed the package layer's whole purpose.
     History: 3% at the consolidation (9eb6a0f); raised 3→5 by 33fa804 (2026-08-28) and
     960ac72 (2026-08-29); RESTORED to 3 here. The 5% is live today, so this is a deliberate
     rate cut on the marketplace base and must be approved as one. POS is unaffected — it has
     its own 5% and does not read this value. */
  marketplace:      { pct: 5,   fixedKES: 0,    _was: 'hub 3% / category 10%; PACKAGE-GOVERNED from 2026-08-30 — this value is the FREE-tier equivalent and is overridden per seller by PACKAGE_RATES' },
  food_delivery:    { pct: 5,   fixedKES: 0,    _was: 'hub restaurant 5% / category 8%' },
  property:         { pct: 2,   fixedKES: 0,    _was: 'hub 2% / category 3%' },
  vehicles:         { pct: 0,   fixedKES: 2000, _was: 'hub flat KES 2000 / category 5%' },
  healthcare:       { pct: 5,   fixedKES: 0,    _was: 'hub 5% / category 12%' },
  legal:            { pct: 5,   fixedKES: 0,    _was: 'hub 5% / category 12%' },
  events:           { pct: 5,   fixedKES: 0,    _was: 'hub entertainment 5% / category 10%' },
  hotel:            { pct: 5,   fixedKES: 0,    _was: 'hub bnb 5%' },
  digital_products: { pct: 10,  fixedKES: 0,    _was: 'hub digital 10% / category 20%' },

  /* ── POS / merchant shop sales — its OWN authority, not marketplace's ──────────────
   * STRICTLY 5% of every COMPLETED POS sale, whatever the tender. Cash, M-PESA via the
   * seller's Daraja till, card — all 5%. The RAIL does not determine the rate: Daraja is
   * how M-PESA POS money is collected, not what makes a sale a POS sale.
   *
   * Until now `pos` was an ALIAS of `marketplace`, so POS silently charged the marketplace
   * rate — live evidence: a KES 3,500 till sale booked KES 105, i.e. 3%. Changing the
   * marketplace rate moved POS with it, and deleting the alias would have dropped POS into
   * the 5% `default` arm, which is a different rule that merely shares a number.
   *
   * POS must never inherit marketplace, and must never reach 5% via `default`. A recorded
   * rate of 5% with category `default` is a FAILURE, not a pass — which is why the ledger
   * records the resolved category alongside the percentage. */
  pos:              { pct: 5,   fixedKES: 0,    _was: 'ALIASED to marketplace (3%) until 2026-08-30 — POS had no rate of its own' },

  /* ── rates that were buried inside hub Cloud Functions as bare literals ──
   * These were never in any table. They were `const platformFeeRate = 0.03;` sitting in the
   * middle of a purchase handler, which is why no audit of the "commission tables" ever found
   * them. They are distinct products — a pay-per-view stream is not an event ticket is not a
   * venue booking — so they get their own categories rather than being flattened into `events`
   * and silently repriced. The values are exactly what those functions were charging. */
  event_tickets:    { pct: 3,   fixedKES: 0,    _was: 'event-hub.js:493 `const platformFeeRate = 0.03`' },
  ppv:              { pct: 15,  fixedKES: 0,    _was: 'entertainment-hub.js:215 `listing.price * 0.15`' },

  /* ── no hub counterpart, so no conflict: the existing category rate stands ── */
  services:         { pct: 5,   fixedKES: 0,    _was: 'category only 15%; PACKAGE-GOVERNED from 2026-08-30 — FREE-tier equivalent, overridden per seller by PACKAGE_RATES' },
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
  /* `pos` is NO LONGER an alias — it has its own RATES entry at 5%. Re-adding it here
     would silently reprice every POS sale to the marketplace rate. */
  shopping: 'marketplace', b2b: 'marketplace',

  /* ── live category vocabulary, mapped explicitly ───────────────────────────────────
   * These are the labels production callers actually emit. Until now none of them
   * matched a key, so every live transaction fell through to `default` 5% — the
   * marketplace 3% rate had never priced anything. `subscription` (singular) was the
   * costliest: `subscriptions` is 100% platform revenue, so a 5% charge paid out 95% of
   * platform money to the provider.
   * Mapped here rather than left to `default`, because with the fail-closed check below
   * an unmapped label now REFUSES to price instead of guessing. */
  product: 'marketplace',        /* a product order IS a marketplace sale. Live callers emit
                                    this label and it matched nothing, so every marketplace
                                    order was priced by the default arm instead of by the
                                    marketplace rate — which is why the differentiated
                                    schedule never reached a transaction. */

  /* HISTORICAL SUBSCRIPTION POLICY, restored — not invented. `subscriptions` (plural) has
     been 100% since the consolidation (9eb6a0f): "category only — full amount is platform
     revenue". Live callers emit the SINGULAR label, which matched nothing, so a merchant's
     KES 484.02 "SOKONI Starter Plan" payment was priced at ~5% and 95% of SOKONI's OWN
     subscription revenue was booked as owed to a "provider" that is SOKONI. The
     singular/plural gap is the defect; the policy itself was never in doubt. */
  subscription: 'subscriptions',

  /* DELIBERATELY NOT MAPPED — each needs a commercial decision, and guessing would move money:
   *
   *   'subscription'  live: providerName "SOKONI Starter Plan", KES 484.02, cut 24 (~5%).
   *                   This is a merchant paying SOKONI, so 95% is currently booked as owed to
   *                   a "provider" that IS SOKONI. The authority `subscriptions` is 100%
   *                   ("full amount is platform revenue") and fits definitionally — but that
   *                   is 5% -> 100%, so it is confirmed, not assumed.
   *
   *   'hair-beauty'   live: providerName "Shave 'n' Trims", KES 194, cut 10 (the KES 10 floor).
   *                   provider.html:753 classifies it "Barber / Salon" under hub services.html,
   *                   so `services` is the categorically correct home — but `services` is 15%,
   *                   tripling the charge. A category decision and a price decision are not the
   *                   same decision.
   *
   * Until each is decided they resolve to nothing and FAIL CLOSED, which is the point: a
   * transaction nobody can authoritatively price must not be priced by accident. */
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
   SELLER PACKAGE COMMISSION — ABSOLUTE TAKE RATES (locked 2026-08-30)
   ══════════════════════════════════════════════════════════════════════════════════════════
   These are the rates SOKONI CHARGES, not discounts applied to a base. A Pro seller pays 3%,
   full stop — not "3% off something". The distinction is load-bearing and has been got wrong
   in both directions before:

     - the ANCIENT model held absolute rates (free 15% / business 4%) from an era when the
       base was ~15%; re-applying those against a small base would RAISE commission, so the
       "discount" became a penalty;
     - the INTERIM model made them relative discounts on a 3% base, producing 2.94 / 2.85 /
       2.70 — nobody's intended commercial rates.

   The seller pays their package rate. A seller with no package, or whose subscription is not
   active, pays the FREE rate — never zero, never the raw category rate.

   POS IS NOT HERE, BY DESIGN. A POS sale is an in-shop merchant sale at a flat 5%; a package
   buys better MARKETPLACE economics and must not reach the till. finos-utils excludes `pos`
   from this layer on the RESOLVED category, so no alias can route around it. */
const PACKAGE_RATES = {
  free:       5,
  basic:      4,
  pro:        3,
  enterprise: 2,
};

/* Tier names the Subscription Engine may return, normalised onto the four package rates.
   sub-billing.js ships seller_free / seller_basic / seller_pro / seller_enterprise as well as
   the bare names, and an unrecognised tier must fall to FREE rather than to nothing. */
const PACKAGE_TIER_ALIASES = {
  seller_free: 'free', seller_basic: 'basic', seller_pro: 'pro', seller_enterprise: 'enterprise',
  starter: 'basic', business: 'pro', none: 'free', trial: 'free',
};

/* Categories whose commission is set by the seller's package rather than by a flat category
   rate. Everything else keeps its own differentiated rate (food_delivery, digital_products,
   education, jobs, classifieds, vehicles, hub, subscriptions...). */
const PACKAGE_CATEGORIES = ['marketplace', 'services'];

/** The absolute take rate for a package tier. Unknown/absent/inactive => the FREE rate. */
function packageRate(tier) {
  const t = String(tier || '').trim().toLowerCase();
  const key = PACKAGE_RATES[t] !== undefined ? t : (PACKAGE_TIER_ALIASES[t] || 'free');
  const pct = PACKAGE_RATES[key];
  return { pct: pct !== undefined ? pct : PACKAGE_RATES.free, tier: key };
}

/** Is this category priced by the seller's package? */
function isPackageCategory(category) {
  return PACKAGE_CATEGORIES.indexOf(String(category || '').trim().toLowerCase()) !== -1;
}

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
  PACKAGE_RATES, PACKAGE_CATEGORIES, packageRate, isPackageCategory,
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
