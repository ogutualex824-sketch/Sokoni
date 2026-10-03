'use strict';
/**
 * RESTRICTED CATEGORIES — the ONE server definition of what SOKONI does not sell (owner 2026-10-03).
 *
 * Restricted goods and services are refused at EVERY commercial step: listing, checkout, booking/order creation, quote
 * acceptance, payment authorization and provider category approval. A hidden UI is not a control; every gate consumes
 * isRestricted(). A restricted category is NEVER mapped to a normal commission row to make a transaction work —
 * commission-config refuses it (category_restricted). Admin / Super Admin may SEE legacy records for moderation; nothing
 * here makes them commercially active.
 *
 * Classes (explicit, not the bare word "adult"):
 *   vape      — vapes, e-cigarettes, e-liquids, pods
 *   tobacco   — tobacco and nicotine: cigarettes, cigars, shisha/hookah tobacco, snuff, nicotine pouches
 *   alcohol   — beer, wine, spirits, liquor
 *   adult     — adult sexual products and services, adult entertainment, anything SOKONI classifies adult-restricted
 *
 * FAIL CLOSED ON AMBIGUITY: a category is restricted when ANY normalised token of it (split on - _ / & space , .) is a
 * restricted token, or when the whole normalised string is a restricted alias. So "vape-pods", "Beer & Wine",
 * "adult/sexual-wellness" are all refused; an applicant cannot bypass the list by re-spelling or combining words.
 */
const CLASSES = Object.freeze({
  vape: ['vape', 'vapes', 'vaping', 'vaporizer', 'vaporiser', 'e-cigarette', 'e-cigarettes', 'ecigarette', 'ecig', 'e-cig', 'eliquid', 'e-liquid', 'ejuice', 'e-juice', 'pods', 'disposable-vape'],
  tobacco: ['tobacco', 'cigarette', 'cigarettes', 'cigar', 'cigars', 'cigarillo', 'shisha', 'hookah', 'snuff', 'nicotine', 'nicotine-pouch', 'nicotine-pouches', 'rolling-papers', 'kuber', 'miraa-tobacco'],
  alcohol: ['alcohol', 'alcoholic', 'liquor', 'liquors', 'spirits', 'beer', 'beers', 'wine', 'wines', 'whisky', 'whiskey', 'vodka', 'gin', 'rum', 'brandy', 'tequila', 'champagne', 'cider', 'chang\'aa', 'changaa', 'busaa'],
  adult: ['adult', 'adults-only', 'adult-only', 'adult-products', 'adult-entertainment', 'adult-content', 'sexual-wellness', 'sex', 'sex-toys', 'sextoys', 'erotic', 'erotica', 'porn', 'pornography', 'xxx', 'escort', 'escorts', 'lingerie-adult', 'fetish'],
});
/* tokens that would false-positive as single words inside ordinary categories are matched only as WHOLE aliases */
const WHOLE_ONLY = new Set(['pods', 'gin', 'rum', 'sex', 'xxx', 'kuber']);
const ALIAS_TO_CLASS = new Map();
for (const [cls, list] of Object.entries(CLASSES)) for (const a of list) ALIAS_TO_CLASS.set(a, cls);

const _norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * classify(categoryLike) → { restricted:boolean, class:string|null, matched:string|null }
 * Accepts a string or an object carrying category / subcategory / categories / hubType / businessCategory — every field
 * is checked; ANY restricted field restricts the whole thing.
 */
function classify(categoryLike) {
  const vals = [];
  if (categoryLike && typeof categoryLike === 'object') {
    for (const k of ['category', 'subcategory', 'subCategory', 'businessCategory', 'hubType', 'serviceCategory', 'productType']) if (categoryLike[k] != null) vals.push(categoryLike[k]);
    for (const k of ['categories', 'tags', 'requestedCategories']) if (Array.isArray(categoryLike[k])) vals.push(...categoryLike[k]);
  } else vals.push(categoryLike);
  for (const raw of vals) {
    const s = _norm(raw); if (!s) continue;
    const whole = s.replace(/ /g, '-');
    if (ALIAS_TO_CLASS.has(whole)) return { restricted: true, class: ALIAS_TO_CLASS.get(whole), matched: whole };
    for (const tok of s.split(/[\s\-_/&,.+|]+/).filter(Boolean)) {
      if (WHOLE_ONLY.has(tok)) continue;
      if (ALIAS_TO_CLASS.has(tok)) return { restricted: true, class: ALIAS_TO_CLASS.get(tok), matched: tok };
    }
  }
  return { restricted: false, class: null, matched: null };
}

const isRestricted = (categoryLike) => classify(categoryLike).restricted;

/** Throwing guard for server gates: code 'category_restricted'. */
function assertNotRestricted(categoryLike, what) {
  const c = classify(categoryLike);
  if (c.restricted) {
    const e = new Error(`${what || 'This item'} is in a category SOKONI does not sell (${c.class}).`);
    e.code = 'category_restricted'; e.restrictedClass = c.class; throw e;
  }
}

module.exports = { CLASSES, classify, isRestricted, assertNotRestricted };
