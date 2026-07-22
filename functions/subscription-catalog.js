'use strict';

/**
 * SOKONI canonical subscription catalogue — the ONE place a commercial
 * entitlement is defined.
 *
 * WHY THIS EXISTS
 * An audit on 2026-07-22 found TEN plan catalogues, each internally consistent
 * and mutually contradictory. The entry tier granted 1, 3, 10, 20 or 50 listings
 * depending on which file was asked, under four different field names —
 * `listings` (343 uses), `maxListings` (20), `maxProducts` (19),
 * `listings_limit` (14).
 *
 * That produced three symptoms that looked unrelated: the dashboard showed 3
 * listings, the pricing page showed a different plan, and uploads stopped at 3.
 * Nothing was broken. Every subsystem was correct according to its own
 * catalogue; they simply disagreed. A page-by-page fix would have made four
 * screens agree and left the eleventh catalogue to contradict them later.
 *
 * FREE = 10 LISTINGS is a commercial decision, taken deliberately: it matches
 * the server-side catalogues already in use, and it gives a merchant enough
 * inventory to evaluate the platform before being asked to pay. The number
 * matters far less than every subsystem using the same one.
 *
 * CONTRACT
 * Servers import this module. Clients receive a resolved entitlement object and
 * render it — a client-side plan table can never be authoritative, because the
 * device holding it is the party the limit applies to.
 *
 * Adding an eleventh catalogue is prevented by scripts/test-subscription-
 * consistency.js, which gates the deploy.
 */

/* Incremented whenever an allowance, price or commission rate changes. Every
   resolved entitlement carries it, so a consumer can record which generation it
   acted on — during a migration that turns "these two screens disagree" into
   "this one resolved v1 and that one resolved v2". */
const CATALOG_VERSION = 1;

/* Every commercial entitlement lives on one object. Splitting listing limits
   from commission from feature flags is how ten catalogues happened: each new
   concern grew its own table rather than extending the existing one. */
const PLANS = Object.freeze({
  FREE: Object.freeze({
    id: 'FREE',
    label: 'Free',
    priceKES: 0,
    listingLimit: 10,
    commissionRate: 0.08,
    walletEnabled: false,
    premiumAnalytics: false,
    prioritySupport: false,
    multiBranch: false,
    staffSeats: 1,
  }),
  STARTER: Object.freeze({
    id: 'STARTER',
    label: 'Starter',
    priceKES: 99900,
    listingLimit: 100,
    commissionRate: 0.06,
    walletEnabled: true,
    premiumAnalytics: false,
    prioritySupport: false,
    multiBranch: false,
    staffSeats: 3,
  }),
  GROWTH: Object.freeze({
    id: 'GROWTH',
    label: 'Growth',
    priceKES: 249900,
    listingLimit: -1,            /* -1 is unlimited, everywhere, always */
    commissionRate: 0.05,
    walletEnabled: true,
    premiumAnalytics: true,
    prioritySupport: false,
    multiBranch: true,
    staffSeats: 10,
  }),
  ENTERPRISE: Object.freeze({
    id: 'ENTERPRISE',
    label: 'Enterprise',
    priceKES: 499900,
    listingLimit: -1,
    commissionRate: 0.03,
    walletEnabled: true,
    premiumAnalytics: true,
    prioritySupport: true,
    multiBranch: true,
    staffSeats: -1,
  }),
});

/* Legacy identifiers seen across the ten catalogues. Mapping them here rather
   than at each call site means a caller never has to know which vocabulary a
   given subsystem happened to use. */
const ALIASES = Object.freeze({
  free: 'FREE', basic: 'FREE', seller_free: 'FREE', provider_free: 'FREE',
  starter: 'STARTER', seller_basic: 'STARTER', provider_basic: 'STARTER',
  pro: 'GROWTH', growth: 'GROWTH', seller_pro: 'GROWTH', provider_pro: 'GROWTH',
  business: 'ENTERPRISE', enterprise: 'ENTERPRISE', seller_enterprise: 'ENTERPRISE',
});

/**
 * resolve(planId) — the entitlement a subsystem should act on.
 *
 * Unknown and missing plans resolve to FREE rather than throwing. A merchant
 * with a corrupt or unrecognised plan id must still be able to trade on the
 * free allowance; failing closed on an unknown string would take a shop offline
 * over a typo in a document.
 */
function resolve(planId) {
  const key = String(planId || '').trim();
  const canonical = PLANS[key.toUpperCase()] ? key.toUpperCase() : ALIASES[key.toLowerCase()];
  return PLANS[canonical] || PLANS.FREE;
}

/**
 * entitlementFor(subscription) — resolved entitlement plus live state.
 *
 * Status decides whether the plan applies at all. An expired or cancelled
 * subscription falls back to FREE entitlements without deleting anything the
 * merchant already created — growth is gated, operations continue.
 */
function entitlementFor(subscription) {
  const sub = subscription || {};
  const status = String(sub.status || 'none').toLowerCase();
  const entitled = ['active', 'trialing', 'grace'].includes(status);
  const plan = entitled ? resolve(sub.plan || sub.planId || sub.tier) : PLANS.FREE;

  return {
    plan:               plan.id,
    label:              plan.label,
    subscriptionStatus: entitled ? status.toUpperCase() : 'INACTIVE',
    listingLimit:       plan.listingLimit,
    commissionRate:     plan.commissionRate,
    staffSeats:         plan.staffSeats,
    /* Feature flags grouped rather than spread across the top level, so adding
       a capability is one line here instead of a new field every consumer must
       learn about — the drift that produced ten catalogues began exactly that
       way, with each new concern growing its own table. */
    features: {
      walletEnabled:    plan.walletEnabled,
      premiumAnalytics: plan.premiumAnalytics,
      prioritySupport:  plan.prioritySupport,
      multiBranch:      plan.multiBranch,
    },
    expiresAt:          sub.expiresAt || sub.currentPeriodEnd || null,
    /* Stamped so a consumer rendering a stale entitlement is detectable rather
       than merely wrong. The divergence that started this investigation was
       invisible because nothing said which catalogue an answer came from —
       every value looked equally authoritative.

       catalogVersion increments when pricing or allowances change, so a
       consumer can log which generation it resolved. During a migration that is
       the difference between "the dashboard is wrong" and "the dashboard
       resolved v1 while upload resolved v2". */
    catalogVersion:     CATALOG_VERSION,
    source:             'subscription-catalog',
    resolvedAt:         new Date().toISOString(),
  };
}

/** Convenience for the one question most callers actually ask. */
function listingLimitFor(subscription) {
  return entitlementFor(subscription).listingLimit;
}

module.exports = { PLANS, ALIASES, resolve, entitlementFor, listingLimitFor };
