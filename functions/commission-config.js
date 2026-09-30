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
 * to use: the legacy seller-till path priced a KES 10,000 legal consultation at KES 500, the
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
  marketplace:      { pct: 5,   fixedKES: 0,    _was: 'hub 3% / category 10%; raised 3->5 on 2026-08-25' },
  food_delivery:    { pct: 5,   fixedKES: 0,    _was: 'hub restaurant 5% / category 8%' },
  property:         { pct: 2,   fixedKES: 0,    _was: 'hub 2% / category 3%' },
  vehicles:         { pct: 0,   fixedKES: 2000, _was: 'hub flat KES 2000 / category 5%' },
  healthcare:       { pct: 5,   fixedKES: 0,    _was: 'hub 5% / category 12%' },
  legal:            { pct: 5,   fixedKES: 0,    _was: 'hub 5% / category 12%' },
  events:           { pct: 5,   fixedKES: 0,    _was: 'hub entertainment 5% / category 10%' },
  hotel:            { pct: 5,   fixedKES: 0,    _was: 'hub bnb 5%' },
  digital_products: { pct: 10,  fixedKES: 0,    _was: 'hub digital 10% / category 20%' },

  /* ── POS / TILL — universal 5%, fixed, per completed sale ────────────────────────────
   * THE canonical POS/Till commercial rule, set 2026-09-06. Every business using SOKONI
   * POS or Till pays 5% of every completed sale — every merchant, every item, whether the
   * business is acting as a merchant or as a supplier. No seller-plan exceptions.
   *
   * WHY IT IS ITS OWN CATEGORY RATHER THAN AN ALIAS.
   * Until 2026-09-06 this was `pos: 'marketplace'` in ALIASES, so POS inherited the
   * marketplace rate. Both happened to be 5%, so it looked correct — but it was 5% BY
   * COINCIDENCE, not by rule. The moment marketplace moves to the seller-plan ladder
   * (FREE 15 / STARTER 10 / GROWTH 5 / ENTERPRISE 0), an aliased POS would have followed it
   * and a FREE merchant's till sale would have jumped to 15%. Separating them is what makes
   * "marketplace and POS/Till do not cross-contaminate" structural instead of aspirational.
   *
   * FIXED means fixed: see FIXED_RATE_CATEGORIES below. commissionRules, revenueConfig
   * overrides, subscription plan rates and plan adjustments are all bypassed for this
   * category, because "applies to every business, without exception" is not enforceable
   * while any per-seller override can still reach it. */
  pos:              { pct: 5,   fixedKES: 0,    _was: "ALIAS pos->marketplace until 2026-09-06; now its own fixed universal rule" },

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
  /* `product` is what checkout.html and the IntaSend webhook actually send as the
     category (`payData.meta?.category || "default"`). It matched nothing in RATES and
     nothing here, so every real sale resolved through RATES.default — 5% by accident.
     Verified 2026-08-25: all 11 live commissionLedger rows carry category "product"
     and commissionPct 5, written by webhookIntasend. Left unmapped, the rate would have
     silently CHANGED the moment anyone "corrected" the string to "marketplace".
     Mapping it deliberately is what makes the 5% intentional rather than incidental. */
  product: 'marketplace', products: 'marketplace',
  /* `pos` DELIBERATELY NOT ALIASED TO MARKETPLACE — see the `pos` entry in RATES.
     It was `pos: 'marketplace'` until 2026-09-06, which made every POS/Till sale inherit
     whatever the marketplace rate happened to be. That is exactly the coupling the
     universal POS/Till rule forbids. */
  shopping: 'marketplace', b2b: 'marketplace',
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

   ── NOT YET WIRED, AND WHY THE ALIAS IS STILL HERE ───────────────────────────────────────
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

const MARKETPLACE_PLAN_RATES = {
  seller_free:       { rateFraction: 0.15, floorExempt: false },
  seller_basic:      { rateFraction: 0.10, floorExempt: false },
  seller_pro:        { rateFraction: 0.05, floorExempt: false },
  /* Enterprise is genuinely zero. floorExempt is TRUE so MIN_COMMISSION_KES cannot turn an
     advertised 0% into KES 10 a sale — calling something 0% while charging a minimum is the
     kind of thing merchants dispute, and they would be right. */
  seller_enterprise: { rateFraction: 0,    floorExempt: true  },
};

/* A seller on no recognised plan is treated as Free — the HIGHEST rate, never the lowest.
   Every existing subscription document predates this ladder, so this fallback is the normal
   path, not an edge case: it must be the rate we are willing to charge everybody. */
const MARKETPLACE_DEFAULT_PLAN = 'seller_free';

/* ── PLAN IDENTITY IS NOT DECIDED HERE ─────────────────────────────────────────────────
   Plan ids and tier names are both in circulation (`seller_pro` the id, `pro` the tier,
   `GROWTH` the catalogue id), and `_resolveSellerPlan` returns whatever the subscription
   document happens to store. Accepting only one spelling silently sends paying sellers to
   the Free rate.

   This used to carry its OWN alias table, which mapped four spellings and deliberately left
   `starter` and `business` unmapped on the grounds that "nothing in the repo says which of
   its plans is which of ours". That was wrong on this lineage: subscription-catalog.js —
   the file that exists precisely to end the ten-catalogue vocabulary problem — answers it
   exactly, and has all along:

       free, basic, seller_free, provider_free, ai_free, trial  ->  FREE
       starter, seller_basic, provider_basic, ai_starter        ->  STARTER
       pro, growth, seller_pro, provider_pro, ai_pro            ->  GROWTH
       business, enterprise, seller_enterprise, ai_enterprise   ->  ENTERPRISE

   The cost of the second table was real and one-directional: every unmapped spelling was
   charged 15%. A Starter merchant paying KES 999/month was billed the Free rate, and a
   Business merchant paying KES 4,999/month was billed the Free rate — an OVERCHARGE on the
   two plans a merchant pays most for. The old comment reasoned only about the undercharge
   risk of guessing, which is why the overcharge it created went unremarked.

   So identity is resolved THROUGH the catalogue and the rungs below are keyed on canonical
   plans. One vocabulary authority; a new plan id registered there is priced here with no
   second edit. The dependency is one-way and cycle-free — subscription-catalog.js requires
   nothing, and states in its own header that commission is NOT defined there. Identity
   flows in; rates never flow out.

   OWNER RULING 2026-09-07 fixes the rungs by plan ORDER: "the free plan commission is 15%,
   the next 10%, the next 5%, then last is 0%". The catalogue is ordered FREE, STARTER,
   GROWTH, ENTERPRISE, so the ladder is that ruling applied to it — not an inference about
   what any individual plan name might mean.
   ═════════════════════════════════════════════════════════════════════════════════════ */
const _CATALOG = require('./subscription-catalog');

/* Canonical plan -> ladder rung. The rung keys are kept as the `seller_*` schedule ids
   because they name the RATE SCHEDULE, which is this file's own concern, and they are what
   ledger provenance has always recorded. */
const MARKETPLACE_CANONICAL_TO_RUNG = {
  FREE: 'seller_free', STARTER: 'seller_basic', GROWTH: 'seller_pro', ENTERPRISE: 'seller_enterprise',
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
  const raw = String(planIdOrTier == null ? '' : planIdOrTier).trim();
  /* A rung id passed straight through (`seller_pro`) is honoured first: this file owns the
     schedule, so its own key must never depend on the catalogue registering it. */
  let key = Object.prototype.hasOwnProperty.call(MARKETPLACE_PLAN_RATES, raw.toLowerCase())
    ? raw.toLowerCase()
    : null;
  if (key === null && raw !== '') {
    /* Catalogue identity. Looked up directly rather than through resolve(), because resolve()
       returns FREE for an unknown id — correct for entitlements (a typo must not take a shop
       offline) and wrong here, where "explicitly Free" and "unrecognised" must stay tellable
       apart. Both charge 15%; only one of them is a fact. */
    const canonical = _CATALOG.PLANS[raw.toUpperCase()]
      ? raw.toUpperCase()
      : _CATALOG.ALIASES[raw.toLowerCase()];
    if (canonical && MARKETPLACE_CANONICAL_TO_RUNG[canonical]) {
      key = MARKETPLACE_CANONICAL_TO_RUNG[canonical];
    }
  }
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

/* ── FIXED-RATE CATEGORIES ────────────────────────────────────────────────────────────────
 * Categories whose rate is a universal commercial rule and must NOT be modulated per seller.
 *
 * For these, calculateCommission() bypasses every override layer — commissionRules,
 * revenueConfig/{seller_*,hub_*,global}, the subscription absolute-rate compatibility mode,
 * and the plan adjustment step — and charges the rate defined here, exactly.
 *
 * This is a deliberately small and deliberately awkward power. It exists because
 * "5% for every business, without exception" is a COMMERCIAL INVARIANT, and an invariant that
 * any admin-written `revenueConfig/seller_<uid>` doc can quietly break is not an invariant.
 * Adding a category here removes an operator's ability to price it per seller, so it should
 * be done only for rules that are genuinely universal.
 *
 * It does NOT bypass MIN_COMMISSION_KES — the floor is a separate concern and still applies,
 * exactly as it does to marketplace sales. */
const FIXED_RATE_CATEGORIES = Object.freeze(['pos']);

/* Accepts a hub id, an alias, or a category, and resolves it the same way resolveRate does,
   so a caller passing hubId 'pos' and a caller passing category 'pos' get the same answer. */
function isFixedRateCategory(key) {
  const r = resolveRate(key);
  return r.matched === true && FIXED_RATE_CATEGORIES.indexOf(r.category) !== -1;
}

module.exports = {
  resolveRate,
  listCategories,
  categoryForHub,
  isFixedRateCategory,
  FIXED_RATE_CATEGORIES,
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
  MARKETPLACE_CANONICAL_TO_RUNG: Object.freeze(MARKETPLACE_CANONICAL_TO_RUNG),
  POS_PLAN_RATES: Object.freeze(POS_PLAN_RATES),
  POS_FLAT_RATE_FRACTION,
  /* Exposed READ-ONLY for admin dashboards and the client rate endpoint. Never mutate. */
  RATES: Object.freeze(RATES),
  ALIASES: Object.freeze(ALIASES),
  POS_PLAN_RATES: Object.freeze(POS_PLAN_RATES),
};
