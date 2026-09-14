'use strict';
/**
 * SOKONI — FREE ENTITLEMENT RESOLVER
 * functions/free-entitlement.js
 *
 * STATUS: **NOT INTEGRATED.** `sub-billing.js` still uses its own `|| {}` fallback; nothing
 * calls this yet. Wiring it is a separate, reviewable change to a live billing file.
 *
 * ── THE DEFECT SHAPE ────────────────────────────────────────────────────────────────
 * Four places in sub-billing.js downgrade an account with:
 *
 *     features: PLANS[`${hubType}_free`]?.features || {}
 *
 * `{}` is not the Free plan. Features are read per key, so an absent key is falsy — `{}`
 * denies EVERYTHING, which is stricter than Free and contradicts the stated policy of
 * reducing an account to Free rather than to nothing. And it is silent: no error, no flag,
 * nothing to alert on. The merchant simply finds their tools gone.
 *
 * Three hubTypes have no `_free` plan today — `enterprise`, `property_agent`,
 * `service_provider` — and one production subscription carries `hubType: null` with
 * `planId: 'starter'`, which is not in the catalogue at all. All four resolve to `{}`.
 *
 * ── WHY THIS DOES NOT INVENT A FALLBACK ─────────────────────────────────────────────
 * Free tiers are hub-SPECIFIC and share no keys: seller_free caps `listings_limit`,
 * buyer_free caps `wishlist_limit`, restaurant_free caps `menu_items`. The intersection
 * across all 11 free plans is EMPTY. There is no generic baseline to derive, so inventing
 * one would be making a product decision disguised as a bug fix — and a wrong entitlement
 * granted silently is the same class of defect as a wrong one denied silently.
 *
 * So this resolver does not guess. It reports precisely what it found, and
 * `scripts/verify-free-plan-coverage.js` fails the deploy when a hubType has no Free tier —
 * moving the gap from "silently strips a merchant in production" to "cannot ship".
 */

const { PLANS } = require('./sub-billing');

/* Deliberate, reviewable aliases for hubTypes that legitimately share another hub's Free
   tier. EMPTY on purpose: every entry is a product decision about what a merchant keeps when
   they stop paying, and adding one should require someone to say so. */
const HUB_FREE_ALIAS = {
  /* e.g. property_agent: 'seller'  — only with an explicit product decision */
};

/* FOUR outcomes, because two of them have different owners and different fixes.
 *
 * An earlier version returned a single GAP for both "this hub has no Free tier" and "we do
 * not know what hub this is". They look identical at the call site — no features, flagged —
 * but the remediation is not the same: the first needs a product decision about a tier, the
 * second needs someone to work out why a subscription has no identity. Collapsing them
 * routes both to whoever happens to read the alert first. */
const OUTCOME = {
  VALID_FREE:       'VALID_FREE',       /* a real `<hub>_free` plan was found              */
  ALIASED_FREE:     'ALIASED_FREE',     /* resolved through an explicit, reviewed alias    */
  MISSING_FREE:     'MISSING_FREE',     /* a KNOWN hub with no Free tier — define or alias */
  INVALID_IDENTITY: 'INVALID_IDENTITY'  /* no usable hubType — establish identity first    */
};

/* Every hubType the catalogue actually knows about. A hub in here with no `_free` plan is a
   MISSING tier; a hub that is not in here at all is an identity problem, not a tier problem. */
function knownHubTypes () {
  const s = new Set();
  Object.keys(PLANS).forEach((k) => { if (PLANS[k] && PLANS[k].hubType) s.add(PLANS[k].hubType); });
  return s;
}

/**
 * Resolve the Free entitlement for a hubType.
 *
 * ALWAYS returns an object. Never throws, because it runs inside expiry sweeps where a
 * throw would strand every subsequent subscription in the batch. It communicates failure in
 * the RESULT instead — a MISSING_FREE or INVALID_IDENTITY outcome with `catalogueGap:true` —
 * so a caller can decide,
 * log, alert, or skip, rather than receiving a bare `{}` indistinguishable from a real
 * (and legitimately sparse) Free tier.
 */
function resolveFreeEntitlement (hubType) {
  const hub = (typeof hubType === 'string' && hubType.trim()) ? hubType.trim() : null;

  if (!hub) {
    return {
      outcome: OUTCOME.INVALID_IDENTITY, catalogueGap: true,
      hubType: null, planId: null, features: {},
      reason: 'No hubType on the subscription, so no Free tier can be identified. ' +
              'One production row carries hubType:null with planId:"starter". ' +
              'Establish the account\'s identity before downgrading it.'
    };
  }

  const direct = PLANS[hub + '_free'];
  if (direct && direct.features) {
    return {
      outcome: OUTCOME.VALID_FREE, catalogueGap: false,
      hubType: hub, planId: hub + '_free', features: direct.features, reason: null
    };
  }

  const alias = HUB_FREE_ALIAS[hub];
  const aliased = alias ? PLANS[alias + '_free'] : null;
  if (aliased && aliased.features) {
    return {
      outcome: OUTCOME.ALIASED_FREE, catalogueGap: false,
      hubType: hub, planId: alias + '_free', features: aliased.features,
      reason: 'Resolved through the reviewed alias ' + hub + ' -> ' + alias
    };
  }

  /* A hub the catalogue has never heard of is not a missing TIER — it is a missing IDENTITY,
     and defining a Free plan for it would be answering the wrong question. */
  if (!knownHubTypes().has(hub)) {
    return {
      outcome: OUTCOME.INVALID_IDENTITY, catalogueGap: true,
      hubType: hub, planId: null, features: {},
      reason: '"' + hub + '" is not a hubType this catalogue defines any plan for. ' +
              'This is an identity problem, not a missing tier — do not define a Free plan ' +
              'for it until the account\'s real hub is established.'
    };
  }

  return {
    outcome: OUTCOME.MISSING_FREE, catalogueGap: true,
    hubType: hub, planId: null, features: {},
    reason: 'No "' + hub + '_free" plan exists and no reviewed alias is defined. ' +
            'Downgrading this account would remove every feature, which is stricter than ' +
            'Free. Define the tier or add an alias before expiring this hub.'
  };
}

/** Every hubType in the catalogue, and whether it can be downgraded safely. */
function auditCoverage () {
  const rows = Array.from(knownHubTypes()).sort().map((hub) => {
    const r = resolveFreeEntitlement(hub);
    return { hubType: hub, outcome: r.outcome, planId: r.planId, catalogueGap: r.catalogueGap };
  });
  const gaps = rows.filter((r) => r.catalogueGap);
  return {
    rows, gaps,
    missingTier: gaps.filter((r) => r.outcome === OUTCOME.MISSING_FREE),
    invalidIdentity: gaps.filter((r) => r.outcome === OUTCOME.INVALID_IDENTITY)
  };
}

module.exports = { OUTCOME, HUB_FREE_ALIAS, resolveFreeEntitlement, auditCoverage };
