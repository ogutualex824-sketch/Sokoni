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

/* Incremented whenever an allowance or price changes. NOT commission — that
   lives in commission-config.js and versions independently. Every resolved
   entitlement carries this, so a consumer can record which generation it acted
   on — during a migration that turns "these two screens disagree" into "this
   one resolved v1 and that one resolved v2". */
/* 3 — canonical merchant packages free/professional/business/enterprise, and FREE 100 -> 50
   (owner decision 2026-09-13). v2 was the 10 -> 100 merchant-beta raise (2026-09-07).

   Bumped because this file's own contract says it increments when pricing or ALLOWANCES
   change: every productCounters document records the catalogVersion that produced its
   ceiling, so a counter still showing 10 is self-explaining ("resolved from v1 before the
   change") rather than the start of an investigation. Production currently holds 11 counters
   at maxProducts 10 — i.e. still on v1 — which is precisely the signal this field exists to
   give. */
const CATALOG_VERSION = 3;

/* COMMISSION IS NOT DEFINED HERE — functions/commission-config.js owns it.
 *
 * This file originally carried a commissionRate per plan: 8/6/5/3 percent. It
 * was written on the reasoning stated below, that splitting concerns across
 * tables is how ten catalogues happened. That reasoning was wrong for this
 * field, and the result was a file created to end drift which immediately
 * introduced some: commission-config resolves marketplace at 3% flat, and these
 * numbers agreed with it on exactly one tier.
 *
 * Nothing ever read them. product-limit is the only consumer of this module and
 * takes listingLimit alone — so the table was dead the day it was written,
 * which is the same defect as MKT_PLANS in subscription-os and was found the
 * same way, by asking who reads it rather than what it looks like.
 *
 * It also escaped the commission guard, which skips files under functions/ on
 * the grounds that "the server may resolve plans". A single source of truth for
 * listings does not get to become a second one for commission.
 *
 * A consumer needing a rate calls commission-config.resolveRate(category).
 */

/* Every LISTING entitlement lives on one object. Splitting listing limits from
   feature flags is how ten catalogues happened: each new concern grew its own
   table rather than extending the existing one. */
const PLANS = Object.freeze({
  FREE: Object.freeze({
    id: 'FREE',
    label: 'Free',
    priceKES: 0,
    /* 50 — the canonical FREE allowance (owner decision 2026-09-13). Previously 100 (the
       2026-09-07 merchant-beta ruling), and 10 before that.

       THE PREVIOUS COMMENT'S WARNING CAME TRUE. It said the 10 -> 100 raise was "NOT
       RETROACTIVE ON ITS OWN … existing documents keep maxProducts:10 until syncLimit() runs",
       and the backfill never ran: production holds 11 productCounters at 10 and one at 100.
       So the LIVED allowance is 10 for almost every merchant while the catalogue says 100.

       Against that reality, 50 is a RISE for the 11 merchants on 10 and a cut only against a
       number they were never actually given. Either way the backfill is still owed —
       scripts/backfill-product-counters.js, or the next subscription change per account —
       and it should run BEFORE anyone reasons about this number again.

       SAFE FOR EXISTING MERCHANTS EITHER WAY. product-limit's grandfatheredFloor is a FLOOR,
       not an override, so a merchant already holding more than 50 keeps what they hold; this
       cannot delete or hide a listing. */
    listingLimit: 50,
    walletEnabled: false,
    premiumAnalytics: false,
    prioritySupport: false,
    multiBranch: false,
    staffSeats: 1,
  }),
  PROFESSIONAL: Object.freeze({
    id: 'PROFESSIONAL',
    label: 'Professional',
    priceKES: 99900,
    listingLimit: 100,
    walletEnabled: true,
    premiumAnalytics: false,
    prioritySupport: false,
    multiBranch: false,
    staffSeats: 3,
  }),
  BUSINESS: Object.freeze({
    id: 'BUSINESS',
    label: 'Business',
    priceKES: 249900,
    listingLimit: -1,            /* -1 is unlimited, everywhere, always */
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
/* CANONICAL PACKAGES ARE free / professional / business / enterprise (2026-09-13). The
   STARTER and GROWTH ids they replace MUST stay mapped here: `resolve()` falls back to FREE
   for anything it cannot place, so a stale alias is not an error — it is a silent downgrade
   of every merchant whose stored tier still uses the old spelling.

   These deliberately mirror commission-config.MARKETPLACE_TIER_ALIASES one-for-one. Two
   alias tables that disagree would put a merchant on one package for their listing limit and
   another for their commission, which is the exact class of divergence this file exists to
   end — so if either changes, both change. */
const ALIASES = Object.freeze({
  /* retired seller_* ladder */
  seller_free: 'FREE', seller_basic: 'PROFESSIONAL', seller_pro: 'BUSINESS',
  seller_enterprise: 'ENTERPRISE',
  /* retired catalogue spellings */
  starter: 'PROFESSIONAL', growth: 'BUSINESS',
  /* bare spellings in circulation */
  free: 'FREE', basic: 'PROFESSIONAL', pro: 'BUSINESS',
  /* provider hub ids — unchanged mapping, this catalogue is not the provider authority */
  provider_free: 'FREE', provider_basic: 'PROFESSIONAL', provider_pro: 'BUSINESS',
  /* `professional`, `business` and `enterprise` need no alias — they ARE the keys, matched
     case-insensitively by resolve(). */
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
