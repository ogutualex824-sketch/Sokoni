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
  /* 5% per completed marketplace sale — the canonical commercial rule, set 2026-08-25.
     Subject to MIN_COMMISSION_KES below, which dominates small sales: a KES 97 order
     is charged KES 10 (10.3%), not KES 4.85. Any seller-facing copy that says a flat
     "5%" without the minimum is inaccurate under ~KES 200; legal.html and
     seller-terms.html disclose both. */
  /* ── OWNER-CONFIRMED SCHEDULE, 2026-09-28 ─────────────────────────────────────────────────────────────────────
     The owner replaced the previous schedule outright ("the rates currently in code are outdated"). Every entry
     that changed records its previous value in `_was`. POS keeps its 5% through its OWN key below — it no longer
     rides the marketplace alias, so raising online sales can never raise the till. */
  marketplace:      { pct: 15,  fixedKES: 0,    _was: 'owner schedule 2026-09-28: online product sales 15% (was 5%; the plan lane was already a flat 15%)' },
  food_delivery:    { pct: 15,  fixedKES: 0,    _was: 'owner schedule 2026-09-28: food ordered online 15% (was 5%)' },
  property:         { pct: 0,   fixedKES: 5000, _was: 'owner schedule 2026-09-28: property KES 5,000 flat (was hub 2% / category 3%)' },
  /* Car Hub vehicle SALE (owner 2026-10-03, via sokoni-f3): 2 % of the sale price, deducted from the seller's settlement.
     Replaces the KES 2,000 flat. Launch is marketplace-first (sales complete outside SOKONI), so this has NO live trigger
     until an online vehicle sale path exists — it is a configured rate, never a charge on listings. Listings are free;
     a dealer subscription is a separate product and never charged on the same sale unless the owner says so. */
  vehicles:         { pct: 2,   fixedKES: 0,    _was: 'owner 2026-10-03: 2% of the sale price (was KES 2,000 flat per sale)' },
  healthcare:       { pct: 5,   fixedKES: 0,    _was: 'owner 2026-10-03: every service booking 5%, healthcare included (was 12%, owner schedule 2026-09-28)' },
  /* Healthcare PRODUCT sales price as merchant online sales (owner: "same as merchant"). `pharmacy` — the only
     product-selling healthcare vocabulary in the codebase — resolves here instead of to healthcare bookings. */
  healthcare_products: { pct: 15, fixedKES: 0, _was: 'owner schedule 2026-09-28: healthcare product sales 15% (pharmacy was 5% via healthcare)' },
  legal:            { pct: 5,   fixedKES: 0,    _was: 'hub 5% / category 12%' },
  events:           { pct: 5,   fixedKES: 0,    _was: 'hub entertainment 5% / category 10%' },
  hotel:            { pct: 15,  fixedKES: 0,    _was: 'owner schedule 2026-09-28: BnB / hotel bookings 15% (was 5%)' },
  digital_products: { pct: 10,  fixedKES: 0,    _was: 'hub digital 10% / category 20%' },

  /* ── rates that were buried inside hub Cloud Functions as bare literals ──
   * These were never in any table. They were `const platformFeeRate = 0.03;` sitting in the
   * middle of a purchase handler, which is why no audit of the "commission tables" ever found
   * them. They are distinct products — a pay-per-view stream is not an event ticket is not a
   * venue booking — so they get their own categories rather than being flattened into `events`
   * and silently repriced. The values are exactly what those functions were charging. */
  event_tickets:    { pct: 5,   fixedKES: 0,    _was: 'owner schedule 2026-09-28: event tickets 5% (was 3%, event-hub.js `platformFeeRate = 0.03`)' },
  ppv:              { pct: 15,  fixedKES: 0,    _was: 'entertainment-hub.js:215 `listing.price * 0.15`' },
  // Owner decision 2026-09-27 (Entertainment convergence): artist, Entertainment service and venue
  // bookings pay 5 % — the service-provider lane — never the generic services / plan rates. Scoped to
  // bookings the SERVER classified as Entertainment (provider-hub.resolveProviderClassification).
  entertainment_bookings: { pct: 5, fixedKES: 0, _was: 'new 2026-09-27 — owner decision (was: provider plan rate 20/15/10/7/5 %)' },

  /* ── no hub counterpart, so no conflict: the existing category rate stands ── */
  services:         { pct: 5,   fixedKES: 0,    _was: 'owner schedule 2026-09-28: other service bookings 5% (was 15%)' },
  home_services:    { pct: 5,   fixedKES: 0,    _was: 'owner 2026-10-03: every service booking 5% (was 14%, owner schedule 2026-09-28)' },
  /* Car rental is a BOOKING of a vehicle — distinct from a vehicle SALE (`vehicles`, KES 2,000 flat). The car hub
     and car-rental pages already send category/hub 'car-rental'; before this it matched nothing and fell to default. */
  car_rental:       { pct: 5,   fixedKES: 0,    _was: 'owner 2026-10-03: car rental 5% like every service booking (was 16%, owner schedule 2026-09-28)' },
  /* POS / Till / Quick Charge: its own key, so it can never follow the marketplace rate through an alias. Same 5%
     as before; its 48-hour settlement term is preserved in index.js _is48hCommission. */
  pos:              { pct: 5,   fixedKES: 0,    _was: 'owner schedule 2026-09-28: POS / Till / Quick Charge 5% (unchanged; was via ALIASES.pos -> marketplace)' },
  /* Fitness Hub bookings (owner 2026-10-03: "5% commission per booking for the bookings"). Its own key and a FIXED-RATE
     category (below): a fitness booking is 5% on every provider plan — the provider ladder (Free 20% … Enterprise 5%)
     and admin overrides do not apply. Covers paid sessions, classes, consultations, packages and Quick Pay bookings.
     Owner 2026-10-03 (via sokoni-e3): memberships and packages pay the SAME 5% — price them with category 'fitness' too.
     Booking FEES, marketing and Marketplace equipment/clothing are separate products, not this row. */
  fitness:          { pct: 5,   fixedKES: 0,    _was: 'owner 2026-10-03: fitness bookings 5% per booking (was ALIASES.fitness -> services 5%, then the provider plan ladder 20–5%)' },
  education:        { pct: 15,  fixedKES: 0,    _was: 'category only' },
  jobs:             { pct: 15,  fixedKES: 0,    _was: 'category only' },
  classifieds:      { pct: 8,   fixedKES: 0,    _was: 'category only' },
  hub:              { pct: 17,  fixedKES: 0,    _was: 'owner schedule 2026-09-28: SOKONI delivery share 17–25% per quote, settled by delivery-quote-authority.js (SHARE_MIN_PCT 17 / SHARE_MAX_PCT 25); this row is the FLOOR for a consumer that resolves by category, never the per-delivery share (was 12% / 88% rider)' },

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
  /* `product` is what checkout.html and the IntaSend webhook actually send as the
     category (`payData.meta?.category || "default"`). It matched nothing in RATES and
     nothing here, so every real sale resolved through RATES.default — 5% by accident.
     Verified 2026-08-25: all 11 live commissionLedger rows carry category "product"
     and commissionPct 5, written by webhookIntasend. Left unmapped, the rate would have
     silently CHANGED the moment anyone "corrected" the string to "marketplace".
     Mapping it deliberately is what makes the 5% intentional rather than incidental. */
  product: 'marketplace', products: 'marketplace',
  shopping: 'marketplace', b2b: 'marketplace',
  till: 'pos', quick_charge: 'pos', quickcharge: 'pos',
  /* C2 — the same accident as `product`, on the one category where it inverts the
     commercial meaning. RATES has `subscriptions` (plural, pct 100: the full amount
     IS platform revenue, because SOKONI is the payee). subscriptions.html — the only
     sender — writes the SINGULAR, which matched neither RATES nor this table, so every
     subscription booked through RATES.default: 5% to SOKONI and 95% recorded as
     `providerNet` owed to nobody. A KES 999 plan reported ~KES 50 of revenue.
     Nothing paid that 95% out (commissionLedger is not a settlement authority, and
     C1 `659a350` stops the wallet credit), so this is under-reported revenue, not a
     leak. Mapping it deliberately, exactly as `product` was. */
  subscription: 'subscriptions',
  /* Owner decision 2026-09-27 (CHANGELOG 226): a Healthcare plan (healthcare_subscription —
     clinic / hospital / enterprise, priced by healthcare-plans.js) is paid TO SOKONI, so the
     whole amount is platform revenue — the same commercial meaning as `subscription` above,
     and the same accident it would otherwise repeat (RATES.default 5%, 95% "owed" to the
     subscriber). No new rate: it prices exactly as `subscriptions`. */
  healthcare_subscription: 'subscriptions',
  restaurant: 'food_delivery', food: 'food_delivery',
  insurance: 'services',
  /* fitness: its own fixed-rate row since 2026-10-03 (was an alias of services) */
  gym: 'fitness', fitness_hub: 'fitness', 'fitness-hub': 'fitness', personal_training: 'fitness',
  'car-rental': 'car_rental', car_hire: 'car_rental', 'car-hire': 'car_rental',
  pharmacy: 'healthcare_products',
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
/* SERVICE BOOKING categories (owner 2026-10-03: a flat 5 % "for all", the plan ladder retired). A subscription plan
   must never move these rates — not the provider ladder, and not a seller-plan discount (features.commission_discount_pct
   / revenueConfig/plan_adjustments) if that rollout is ever switched on. finos-utils skips the plan step for them and
   records planSkipped 'flat_booking_rate'. */
const FLAT_BOOKING_CATEGORIES = Object.freeze(['services', 'home_services', 'car_rental', 'healthcare', 'entertainment_bookings', 'fitness']);
function isFlatBookingCategory(key) {
  const r = resolveRate(key);
  return r.matched === true && FLAT_BOOKING_CATEGORIES.indexOf(r.category) !== -1;
}

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

/* ── FIXED-RATE CATEGORIES — the recorded POS decision is ABSOLUTE, not merely ladder-exempt ──
   Owner decisions 2026-09-06 (`932ee22`: POS "immune to per-seller overrides"), 2026-09-26
   (docs/CANONICAL_MONEY_VERSION_DECISIONS.md: "fixed-rate bypass of every override and plan
   adjustment, recorded as pricingSource 'fixed_rate_category'") and 2026-09-28 (`5db1540`: POS
   decoupled from online sales, flat 5% on every plan) say the same thing. A category listed here
   takes RATES[category] and nothing else: commissionRules, revenueConfig/{seller_,hub_,global},
   a subscription rate and revenueConfig/plan_adjustments are all bypassed by
   finos-utils.calculateCommission, which records that it did so (`fixedRateCategory`,
   `overrideIgnored`, `planSkipped: 'fixed_rate_category'`).

   The 2026-09-06 production lineage carried this guard. The 09-28 restructure kept the flat lane
   (POS_PLAN_RATES) but dropped the guard, which left POS ladder-exempt yet override-able through
   the finos-utils chain. Restored 2026-09-30 — docs/COMMERCIAL_CONVERGENCE_2026-09-30.md. */
/* 'fitness' added 2026-10-03 (owner: 5% per booking). Same absolute semantics as POS: RATES.fitness and nothing else. */
const FIXED_RATE_CATEGORIES = Object.freeze(['pos', 'fitness']);

/* Fixed lanes that carry NO platform minimum. Fitness is a provider BOOKING lane, and provider bookings never had the
   KES 10 floor (finos-utils: "a KES 20 booking at 20% charged KES 4"); the owner set "5% commission per booking", so a
   KES 100 session pays KES 5, not KES 10. POS keeps its floor (POS_PLAN_RATES.floorExempt false) — unchanged. */
const FIXED_RATE_FLOOR_EXEMPT = Object.freeze(['fitness']);
function isFloorExemptFixedCategory(key) {
  const r = resolveRate(key);
  return r.matched === true && FIXED_RATE_FLOOR_EXEMPT.indexOf(r.category) !== -1;
}

/* Accepts a hub id, an alias, or a category, and resolves it the same way resolveRate does,
   so a caller passing hubId 'pos' and a caller passing category 'till' get the same answer. */
function isFixedRateCategory(key) {
  const r = resolveRate(key);
  return r.matched === true && FIXED_RATE_CATEGORIES.indexOf(r.category) !== -1;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE POS LANE — an absolute, plan-keyed schedule inside this same authority
   ══════════════════════════════════════════════════════════════════════════════════════════
   AMENDMENT TO THE CONTRACT ABOVE, made deliberately and recorded here rather than by
   quietly editing the rule it qualifies:

     Marketplace plans continue to ADJUST the marketplace base rate and never replace it.
     POS is an INDEPENDENTLY DEFINED LANE. Its rates are ABSOLUTE lane rates and are NOT
     interpreted as discounts against the marketplace base.

   Why this does not reopen the defect that killed the legacy PLANS table: that table
   advertised absolute rates (free 15%, business 4%) as though they were MARKETPLACE rates,
   so when the base moved from ~15% to 3% the "discount" silently became a penalty. These
   rates are not relative to anything. They cannot drift when the marketplace base moves,
   because they never reference it.

   SINGLE SOURCE IS PRESERVED. This lives in commission-config.js — the one file
   scripts/verify-commission-single-source.js sanctions. It must NEVER be copied into
   sub-billing.js, which is not allow-listed, or into any client.

   ── NO COMMERCIAL CHANGE ON THIS LANE (owner ruling 2026-09-07) ──────────────────────────
   Live today, POS resolves through ALIASES to marketplace: 5% for every merchant. This lane
   now defines the SAME 5%, absolutely and plan-independently:

       Free        5%  ->  5%     unchanged
       Basic       5%  ->  5%     unchanged
       Pro         5%  ->  5%     unchanged
       Enterprise  5%  ->  5%     unchanged

   Nobody's POS bill moves. An earlier draft of this lane carried a 15/10/5/0 plan ladder and
   would have tripled the Free merchant's till commission; that ladder was countermanded and
   moved to the MARKETPLACE lane, where a subscription is buying something SOKONI actually
   provides — the order. See MARKETPLACE_PLAN_RATES below.

   ── SUPERSEDED 2026-09-28 (owner schedule) ────────────────────────────────────────────────
   The alias below is GONE. Raising online sales to 15% would have tripled every till sale through it, so POS now has
   its own `pos` key in RATES (5%, with `till` / `quick_charge` aliases) and index.js `_is48hCommission` treats the
   `pos` category as 48-hour, exactly as it did while POS resolved to marketplace. The settlement term is unchanged;
   only the coupling is removed. The history below is kept as the record of why the coupling existed.

   ── NOT YET WIRED, AND WHY THE ALIAS IS STILL HERE (historical) ─────────────────────────
   `pos: 'marketplace'` in ALIASES does TWO jobs, and only one of them is pricing:

     1. pricing            resolveRate('pos') -> marketplace 5%
     2. settlement term    index.js:4852 `_is48hCommission()` treats any hub resolving to
                           'marketplace' as subject to the 48-HOUR commission deadline;
                           everything else keeps MONTHLY invoicing.

   Removing the alias — or adding a `pos` key to RATES, since RATES is checked BEFORE
   ALIASES — would move POS from a 48-hour obligation to monthly billing as a side effect of
   a pricing change. That is a separate commercial decision and it is not made here.

   So this lane is exported for the resolver and is NOT reachable through resolveRate() yet.
   Live pricing and live settlement terms are unchanged by its presence. Breaking the alias
   is a deliberate follow-up that must decide the settlement term at the same time.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/* ── OWNER RULING 2026-09-07: POS IS FLAT 5%, AND IT IS PLAN-INDEPENDENT ────────────────
   This table previously carried a plan ladder (free 15 / basic 10 / pro 5 / enterprise 0)
   on the POS lane. That ladder was COUNTERMANDED and moved to where it belongs:

       MARKETPLACE (online orders)   plan ladder 15 / 10 / 5 / 0   -> MARKETPLACE_PLAN_RATES
       POS / TILL   (shop sales)     FLAT 5%, every plan           -> here

   The two are separate commercial products. A merchant's subscription buys them a better
   rate on the MARKETPLACE orders SOKONI brings them; it buys nothing on sales they made
   themselves in their own shop, where SOKONI provided the till and nothing else.

   The ladder was never wired on this lane (`pos-sale-commission.js` says "NOT INTEGRATED,
   NOT DEPLOYED. Nothing calls this."), so no live sale was ever charged by it and no
   migration is needed. It is corrected rather than deleted precisely because it was
   unreachable: a countermanded schedule left sitting in the sanctioned config file is a
   trap for whoever wires this lane next.

   FRACTIONS, not percentages: 0.05 is 5%. The platform carries three competing conventions
   (`pct: 5`, `commission_pct: 10`, `commission_discount_pct: 2`) and writing 5 where 0.05
   is meant charges 500%.

   This matches what POS is charged TODAY through `ALIASES.pos -> marketplace` (5%), so the
   lane and the live alias agree. That agreement is deliberate: while both exist, they must
   not be able to disagree about what a POS sale costs. */
const POS_FLAT_RATE_FRACTION = 0.05;

/* Kept as a map so the resolver's shape, provenance and callers are unchanged — but every
   plan resolves to the same rate, which is the point. Written explicitly rather than
   collapsed to a constant so that "Pro pays the same as Free at the till" is visible to
   anyone reading the schedule instead of implied by an absent table. */
const POS_PLAN_RATES = {
  seller_free:       { rateFraction: POS_FLAT_RATE_FRACTION, floorExempt: false },
  seller_basic:      { rateFraction: POS_FLAT_RATE_FRACTION, floorExempt: false },
  seller_pro:        { rateFraction: POS_FLAT_RATE_FRACTION, floorExempt: false },
  seller_enterprise: { rateFraction: POS_FLAT_RATE_FRACTION, floorExempt: false },
};

/* A merchant on no recognised plan is treated as Free. Under a flat schedule that is the
   same rate as every other plan, which is exactly why the fallback is stated rather than
   removed: if this lane ever becomes plan-keyed again, an unknown plan must resolve to the
   HIGHEST rate and never to a free pass. Undercharging is the failure that stays invisible
   until reconciliation. */
const POS_DEFAULT_PLAN = 'seller_free';

/**
 * Resolve the POS commission for a seller plan.
 *
 * Returns the rate AND the floor policy AND its provenance, so the arithmetic engine stays
 * deliberately dumb: `computeCommission()` never infers whether a zero rate should escape
 * the minimum, because this says so explicitly.
 *
 * `source` and `plan` are returned so a receipt, a merchant UI, a reconciliation or an audit
 * can explain WHY a particular sale was charged what it was — a rate with no provenance is
 * exactly what made nine disagreeing tables survivable for so long.
 *
 * @param {string} planId  e.g. 'seller_pro'
 * @returns {{rateFraction:number, floorExempt:boolean, source:string, plan:string,
 *            lane:string, matched:boolean, pct:number}}
 */
function resolvePosRate(planId) {
  const key = String(planId || '').trim().toLowerCase();
  const matched = Object.prototype.hasOwnProperty.call(POS_PLAN_RATES, key);
  const plan = matched ? key : POS_DEFAULT_PLAN;
  const r = POS_PLAN_RATES[plan];
  return {
    rateFraction: r.rateFraction,
    pct: r.rateFraction * 100,
    floorExempt: r.floorExempt,
    source: 'commission-config.POS_PLAN_RATES',
    plan,
    lane: 'pos',
    matched
  };
}


/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE MARKETPLACE LANE — absolute commission by seller plan   (owner ruling 2026-09-07)
   ══════════════════════════════════════════════════════════════════════════════════════════
   A SOKONI marketplace order is one SOKONI brought the merchant. What a subscription buys is
   a smaller cut of it:

       seller_free        15%
       seller_basic       10%
       seller_pro          5%
       seller_enterprise   0%

   POS AND TILL ARE NOT ON THIS LADDER. A till sale is one the merchant made themselves, in
   their own shop, to their own customer; SOKONI provided the till and nothing else, so it is
   FLAT 5% on every plan (POS_PLAN_RATES above). The two lanes are separate commercial
   products and must never be collapsed into one rate.

   ── WHY ABSOLUTE, WHEN THE FILE ABOVE WARNS ABOUT ABSOLUTE PLAN RATES ────────────────────
   The legacy PLANS table was lethal because it advertised absolute rates (free 15%,
   business 4%) while being APPLIED as a discount against a moving marketplace base. When the
   base fell to ~3% the "discount" silently became a penalty.

   These are absolute AND applied absolutely: `resolveMarketplaceRate` REPLACES the base
   rather than adjusting it, and nothing here references `RATES.marketplace`. They cannot
   drift when the base moves, because they never read it. That is the same reasoning the POS
   lane above already uses.

   `applyPlanAdjustment` (the discount mechanism) still exists and still governs every OTHER
   category — provider bookings, services, hubs. It is not replaced; it is simply not the
   authority for a marketplace seller sale.

   ── THE UNIT IS A FRACTION ───────────────────────────────────────────────────────────────
   0.15 is 15%. This file also speaks `pct` (whole numbers) in RATES, and sub-billing speaks
   `commission_discount_pct`. Writing 15 where 0.15 is meant charges 1500%. Both spellings
   are returned below so a caller cannot pick the wrong one by accident.

   ── SINGLE SOURCE ────────────────────────────────────────────────────────────────────────
   This lives in commission-config.js, the one file scripts/verify-commission-single-source.js
   sanctions. It must NEVER be copied into sub-billing.js, into a client, or into a second
   table. The platform once had NINE commission tables that disagreed.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/* ── CANONICAL MERCHANT PACKAGES (owner decision 2026-09-13) ───────────────────────────────
 * free / professional / business / enterprise at 16 / 12 / 8 / 4 percent.
 *
 * THIS IS A PRICE RISE AT EVERY TIER, and it is recorded as such rather than presented as a
 * restructure. The retired ladder was seller_free 15 / seller_basic 10 / seller_pro 5 /
 * seller_enterprise 0, so the change is +1 / +2 / +3 / +4 points, and Enterprise moves from
 * FREE to 4%. Anyone reconciling a historical settlement against these numbers will get a
 * different answer than the ledger holds; the ledger is right for its date.
 *
 * The `seller_*` vocabulary is retired as a CUSTOMER-FACING package name. It survives only in
 * MARKETPLACE_TIER_ALIASES below, so subscriptions already written with the old ids keep
 * resolving — a merchant must never fall to the Free rate because their stored tier used
 * yesterday's spelling.
 */
/* ── FLAT 15% ON EVERY PLAN  (owner decision 2026-09-22) ───────────────────────────────────
 * SUPERSEDES the 2026-09-13 ladder (free 16 / professional 12 / business 8 / enterprise 4),
 * which itself superseded seller_free 15 / basic 10 / pro 5 / enterprise 0.
 *
 * THIS IS A PRICE CHANGE IN BOTH DIRECTIONS, and it is recorded as such rather than presented
 * as a simplification:
 *
 *     free          16%  ->  15%     -1 point
 *     professional  12%  ->  15%     +3 points
 *     business       8%  ->  15%     +7 points
 *     enterprise     4%  ->  15%    +11 points
 *
 * Anyone reconciling a historical settlement against these numbers will get a different
 * answer than the ledger holds. The ledger is right for its date; this table is right from
 * its date. Neither is a bug.
 *
 * WHAT A SUBSCRIPTION NOW BUYS ON THIS LANE: nothing. The marketplace rate is no longer
 * plan-keyed. The shape is KEPT rather than collapsed to a scalar for the same reason the POS
 * lane keeps it — if the lane is ever made plan-keyed again, the structure and the
 * "unknown plan resolves to the HIGHEST rate" fallback are already here, and re-introducing
 * them under time pressure is how a free pass gets written by accident. That absence of a
 * plan discount is a COMMERCIAL fact the subscription surfaces should state; it is not this
 * file's job to hide it behind a table that still looks like a ladder.
 *
 * POS AND TILL ARE UNAFFECTED. The till resolves through resolvePosRate -> POS_PLAN_RATES ->
 * POS_FLAT_RATE_FRACTION (5%), which does not read this table. Verified: pos-sale-commission.js
 * calls CC.resolvePosRate(planId) and nothing else. (2026-09-22: `RATES.marketplace.pct` was left
 * at 5% because `ALIASES.pos = 'marketplace'` would have tripled every till commission. SUPERSEDED
 * 2026-09-28: POS has its own `pos` key, the alias is removed, and RATES.marketplace is 15% — the
 * same as this lane, so a seller-less marketplace call can no longer undercharge at 5%.) The two lanes stay
 * separate commercial products, which is the invariant this file has defended throughout.
 *
 * floorExempt stays FALSE everywhere: the invariant asserted elsewhere is "only a genuine 0%
 * rate is floor-exempt", and 15% is not zero. MIN_COMMISSION_KES still dominates small orders.
 */
const MARKETPLACE_FLAT_RATE_FRACTION = 0.15;

const MARKETPLACE_PLAN_RATES = {
  free:         { rateFraction: MARKETPLACE_FLAT_RATE_FRACTION, floorExempt: false },
  professional: { rateFraction: MARKETPLACE_FLAT_RATE_FRACTION, floorExempt: false },
  business:     { rateFraction: MARKETPLACE_FLAT_RATE_FRACTION, floorExempt: false },
  enterprise:   { rateFraction: MARKETPLACE_FLAT_RATE_FRACTION, floorExempt: false },
};

/* A seller on no recognised plan is treated as Free — the HIGHEST rate, never the lowest.
   Every existing subscription document predates this ladder, so this fallback is the normal
   path, not an edge case: it must be the rate we are willing to charge everybody. */
const MARKETPLACE_DEFAULT_PLAN = 'free';

/* Legacy spellings -> canonical package.
   Plan ids and tier names are both in circulation (`seller_pro` the id, `pro` the tier), and
   `_resolveSellerPlan` returns the TIER — so accepting only one spelling would silently send
   paying merchants to the Free rate. EVERY id any store may already hold must appear here.

   The `starter` / `business` mapping below is the COMMERCIAL decision of 2026-09-13, which is
   exactly what the previous version of this comment was waiting for: it declined to map them
   because nobody had decided, and a guess would have undercharged. Now decided. */
const MARKETPLACE_TIER_ALIASES = {
  /* the retired seller_* ladder, in order */
  seller_free: 'free', seller_basic: 'professional', seller_pro: 'business',
  seller_enterprise: 'enterprise',
  /* subscription-catalog spellings */
  starter: 'professional', growth: 'business',
  /* bare spellings seen across stores and pricing pages */
  basic: 'professional', pro: 'business',
  /* `free`, `professional`, `business` and `enterprise` need no alias — they ARE the keys.
     An unrecognised tier still falls to MARKETPLACE_DEFAULT_PLAN ('free'), which is now the
     HIGHEST rate at 16%: the fail-safe direction is unchanged, and an unknown spelling can
     never buy a discount. */
};

/**
 * Resolve the marketplace commission for a seller plan.
 *
 * Returns the rate, the floor policy AND the provenance, so the arithmetic engine stays
 * deliberately dumb: it never infers whether a zero rate should escape the minimum, because
 * this says so explicitly. A rate with no provenance is exactly what let nine disagreeing
 * tables survive for so long.
 *
 * @param {string} planIdOrTier  'seller_pro' or 'pro'
 */
function resolveMarketplaceRate(planIdOrTier) {
  const raw = String(planIdOrTier == null ? '' : planIdOrTier).trim().toLowerCase();
  const key = Object.prototype.hasOwnProperty.call(MARKETPLACE_PLAN_RATES, raw)
    ? raw
    : (MARKETPLACE_TIER_ALIASES[raw] || null);
  const matched = key !== null;
  const plan = matched ? key : MARKETPLACE_DEFAULT_PLAN;
  const r = MARKETPLACE_PLAN_RATES[plan];
  return {
    rateFraction: r.rateFraction,
    pct: r.rateFraction * 100,
    floorExempt: r.floorExempt,
    source: 'commission-config.MARKETPLACE_PLAN_RATES',
    plan,
    lane: 'marketplace',
    matched,
  };
}

/* Which RAW category labels are a marketplace SELLER sale, and therefore priced by the
   ladder above.

   Keyed on the RAW label the caller passed, NOT on the resolved category — because
   `ALIASES.pos = 'marketplace'` means a POS sale RESOLVES to the marketplace category. If
   this were keyed on the resolved value, POS would inherit the ladder and a Free merchant's
   till commission would triple. `pos` is deliberately absent from this set, and that absence
   is load-bearing. The alias itself must stay: it also decides the SETTLEMENT TERM
   (index.js `_is48hCommission`), and moving that is a separate decision. */
const MARKETPLACE_SELLER_CATEGORIES = Object.freeze(new Set([
  'marketplace', 'product', 'products', 'shopping', 'b2b',
]));

/** True when `rawCategory` is a marketplace seller sale priced by the plan ladder. */
function isMarketplaceSellerSale(rawCategory) {
  return MARKETPLACE_SELLER_CATEGORIES.has(String(rawCategory == null ? '' : rawCategory).trim().toLowerCase());
}

/** Every category name a caller may legitimately pass. Used by the drift guard and admin UIs. */
function listCategories() {
  return Object.keys(RATES);
}

/** Hub -> category, for callers that previously used finos-router's HUB_CATEGORY_MAP. */
function categoryForHub(hub) {
  return resolveRate(hub).category;
}

/* ── PROVIDER BOOKING LANE — plan-keyed, owner schedule 2026-09-28: 20 / 15 / 10 / 7 / 5 ──────
   A service-provider booking (hubId 'provider', the `subscriptionRole: 'provider'` path in
   finos-utils) is priced by the provider's PLAN. Before 2026-09-30 that ladder existed only in
   prose (finos-utils, provider-ops: "Free Trial 20%, Starter 15%, Professional 10%, Business 7%,
   Enterprise 5%") and in a subscription document's optional `commissionRate` field, while
   subscription-core fell back to a role default of 20%. This table is now the ONLY source.

   KEYED BY PLAN ID (sub-billing.js PLANS ids), never by display name — a label can be reworded,
   an id cannot. Unknown, inactive or absent plans resolve to the HIGHEST rate (provider_free),
   never the cheapest, exactly as the POS and marketplace lanes do.

   NOT A FLOOR LANE: the provider path never had the KES 10 minimum (a KES 20 booking at 20%
   charges KES 4), and introducing one here would be an unapproved repricing.

   `provider_basic` and `provider_pro` are legacy ids with no row in the owner schedule and
   ZERO production subscriptions. They resolve fail-closed to 20% and are flagged
   (`legacyUnmapped`) so a sale on them is visible; an owner mapping is required before either
   is sold again — see docs/COMMERCIAL_CONVERGENCE_2026-09-30.md. */
/* 2026-10-03 (owner): SERVICE BOOKINGS NO LONGER USE THIS TABLE — every service booking pays a flat 5 % (RATES.services /
   the fitness, healthcare and entertainment lanes), deducted from the provider at settlement; provider-hub.commissionArgsForHub
   no longer passes subscriptionRole. Kept (and still tested) only for any non-booking caller that names a provider plan; plans
   now unlock FEATURES (subscription-catalog), not a commission rate. */
const PROVIDER_PLAN_RATES = {
  provider_free: { pct: 20, floorExempt: true },   /* Free Trial     */
  starter:       { pct: 15, floorExempt: true },   /* Starter        */
  pro:           { pct: 10, floorExempt: true },   /* Professional   */
  business:      { pct: 7,  floorExempt: true },   /* Business       */
  enterprise:    { pct: 5,  floorExempt: true },   /* Enterprise     */
};
const PROVIDER_DEFAULT_PLAN = 'provider_free';   /* NO plan at all = Free — a known commercial state, not a fallback */

/* Historical spellings that are the SAME plan, mapped explicitly. `free_trial` is what every
   production providerSubscriptions document carries (5 of 5 on 2026-09-30) and is the Free Trial
   tier the schedule names at 20%. Nothing else is aliased: a spelling not listed here is refused. */
const PROVIDER_PLAN_ALIASES = Object.freeze({ free_trial: 'provider_free' });

/* RETIRED 2026-09-30 (owner). `provider_basic` (KES 999, tier basic) has no row in the schedule and
   no live dependency anywhere (0 production subscriptions, 0 intents, no checkout path);
   `provider_pro` (KES 2,499, "Provider Pro") is NOT the canonical `pro` (KES 1,499) — a different
   price is a different plan, so it is retired rather than aliased. Both stay in sub-billing.PLANS
   with isActive:false so a historical document still names something, but a booking on either is
   REFUSED here, never priced by a guess. */
const PROVIDER_RETIRED_IDS = Object.freeze(['provider_basic', 'provider_pro']);

function resolveProviderRate(planId) {
  const raw = String(planId == null ? '' : planId).trim().toLowerCase();
  const key = raw === '' ? PROVIDER_DEFAULT_PLAN : (PROVIDER_PLAN_ALIASES[raw] || raw);
  if (Object.prototype.hasOwnProperty.call(PROVIDER_PLAN_RATES, key)) {
    const r = PROVIDER_PLAN_RATES[key];
    return {
      ok: true, refused: false,
      pct: r.pct, rateFraction: r.pct / 100, floorExempt: r.floorExempt,
      plan: key, matched: true,
      aliasOf: raw !== '' && raw !== key ? raw : null,
      source: 'commission-config.PROVIDER_PLAN_RATES',
    };
  }
  /* FAIL CLOSED. An unknown or retired plan id is not priced at any rate; the caller must refuse
     the transaction (finos-utils rethrows; the payment is held, never settled on a guess). */
  return {
    ok: false, refused: true,
    reason: PROVIDER_RETIRED_IDS.indexOf(raw) !== -1 ? 'provider_plan_retired' : 'provider_plan_unknown',
    pct: null, rateFraction: null, floorExempt: true, plan: raw, matched: false, aliasOf: null,
    source: 'commission-config.PROVIDER_PLAN_RATES (refused)',
  };
}

module.exports = {
  resolveRate,
  listCategories,
  isFixedRateCategory,
  isFloorExemptFixedCategory,
  isFlatBookingCategory,
  FLAT_BOOKING_CATEGORIES,
  FIXED_RATE_FLOOR_EXEMPT,
  FIXED_RATE_CATEGORIES,
  resolveProviderRate,
  PROVIDER_PLAN_RATES: Object.freeze(PROVIDER_PLAN_RATES),
  PROVIDER_DEFAULT_PLAN,
  PROVIDER_PLAN_ALIASES,
  PROVIDER_RETIRED_IDS,
  categoryForHub,
  MIN_COMMISSION_KES,
  PLAN_ADJUSTMENTS_DOC,
  applyPlanAdjustment,
  planRolloutEnabled,
  PLAN_MIN_PCT,
  PLAN_MAX_DISCOUNT,
  resolvePosRate,
  POS_DEFAULT_PLAN,
  resolveMarketplaceRate,
  MARKETPLACE_DEFAULT_PLAN,
  isMarketplaceSellerSale,
  MARKETPLACE_SELLER_CATEGORIES,
  /* READ-ONLY for the client-snapshot generator and admin dashboards. Never mutate:
     these are the schedules, not a copy of them. */
  MARKETPLACE_PLAN_RATES: Object.freeze(MARKETPLACE_PLAN_RATES),
  POS_PLAN_RATES: Object.freeze(POS_PLAN_RATES),
  POS_FLAT_RATE_FRACTION,
  /* Exposed READ-ONLY for admin dashboards and the client rate endpoint. Never mutate. */
  RATES: Object.freeze(RATES),
  ALIASES: Object.freeze(ALIASES),
  POS_PLAN_RATES: Object.freeze(POS_PLAN_RATES),
};
