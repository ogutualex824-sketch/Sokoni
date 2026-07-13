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
  /* Exposed READ-ONLY for admin dashboards and the client rate endpoint. Never mutate. */
  RATES: Object.freeze(RATES),
  ALIASES: Object.freeze(ALIASES),
};
