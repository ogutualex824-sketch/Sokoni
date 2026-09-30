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
const CATALOG_VERSION = 1;

/* ── THE ONE SUBSCRIPTION LIFECYCLE ─────────────────────────────────────────
   Every SOKONI package moves through these states and no vertical invents its
   own. Seller packaging, seller basic, hotel, accommodation, restaurant,
   mechanic, pharmacy, services and the AI plans all use this vocabulary, so a
   new vertical inherits billing rather than reimplementing it.

   ENTITLED is the only question a consumer should ask. A screen must never ask
   "is this merchant on seller_basic" — it asks what they are entitled to do. */
const LIFECYCLE = Object.freeze({
  FREE:                 { entitled: false, label: "Free" },
  TRIALING:             { entitled: true,  label: "Trial" },
  PENDING_PAYMENT:      { entitled: false, label: "Awaiting payment" },
  PROCESSING:           { entitled: false, label: "Payment processing" },
  ACTIVE:               { entitled: true,  label: "Active" },
  GRACE:                { entitled: true,  label: "Payment overdue" },
  CANCEL_AT_PERIOD_END: { entitled: true,  label: "Active until period end" },
  EXPIRED:              { entitled: false, label: "Expired" },
  CANCELLED:            { entitled: false, label: "Cancelled" },
});

/* Legacy status spellings seen in the stores, mapped to the lifecycle. A status
   nobody defined resolves to FREE rather than silently entitling anyone. */
const STATUS_ALIASES = Object.freeze({
  active: "ACTIVE", trialing: "TRIALING", trial: "TRIALING", grace: "GRACE",
  past_due: "GRACE", pending: "PENDING_PAYMENT", pending_payment: "PENDING_PAYMENT",
  processing: "PROCESSING", expired: "EXPIRED", cancelled: "CANCELLED",
  canceled: "CANCELLED", cancel_at_period_end: "CANCEL_AT_PERIOD_END",
  none: "FREE", free: "FREE", superseded: "EXPIRED", revoked: "CANCELLED",
});

function lifecycleOf(status) {
  const key = STATUS_ALIASES[String(status || "").toLowerCase()] || "FREE";
  return { state: key, ...LIFECYCLE[key] };
}
function isEntitled(status) { return lifecycleOf(status).entitled; }

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
    listingLimit: 10,
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
const ALIASES = Object.freeze({
  free: 'FREE', basic: 'FREE', seller_free: 'FREE', provider_free: 'FREE',
  starter: 'STARTER', seller_basic: 'STARTER', provider_basic: 'STARTER',
  pro: 'GROWTH', growth: 'GROWTH', seller_pro: 'GROWTH', provider_pro: 'GROWTH',
  business: 'ENTERPRISE', enterprise: 'ENTERPRISE', seller_enterprise: 'ENTERPRISE',

  /* ── THE AI FAMILY ────────────────────────────────────────────────────────
     These were absent, and their absence was not visible: resolve() falls back
     to FREE for an unknown id (correct — a typo must not take a shop offline),
     so a PAID ai_starter merchant silently received the free allowance of 10
     while their subscription still reported ACTIVE. A paid plan resolving to
     FREE looks exactly like a free plan, which is why it went unnoticed.
     ai-subscriptions.js:31 is the definition these mirror. */
  ai_free: 'FREE', ai_starter: 'STARTER', ai_pro: 'GROWTH', ai_enterprise: 'ENTERPRISE',

  /* Written by business-bootstrap as the SmartPOS trial's `plan` field. It is a
     STATUS word sitting in a plan field; mapping it keeps it off the unknown
     path, and the trial's real allowance comes from its planId. */
  trial: 'FREE',
});

/* Every plan id known to be written by any subsystem. A new catalogue that
   forgets to register here fails `unmappedPlanIds()` in the suite rather than
   quietly resolving its paying customers to FREE — which is precisely the defect
   the AI family caused. Keep this list SORTED BY SOURCE and complete. */
const KNOWN_PLAN_IDS = Object.freeze([
  /* sub-billing.js PLANS */
  'seller_free', 'seller_basic', 'seller_pro', 'seller_enterprise',
  /* ai-subscriptions.js PLANS */
  'ai_free', 'ai_starter', 'ai_pro', 'ai_enterprise',
  /* entitlement-adapters.js VALID_PLANS + index.js validPlans */
  'free', 'starter', 'pro', 'business',
  /* business-bootstrap.js trial document */
  'trial',
  /* this catalogue's own ids */
  'FREE', 'STARTER', 'GROWTH', 'ENTERPRISE',
]);

/* Ids that do NOT resolve to a real plan — i.e. would land on FREE by accident
   rather than by intent. `expectFree` lists the ones that are legitimately free. */
function unmappedPlanIds(ids, expectFree) {
  const free = new Set((expectFree || []).map((s) => String(s).toLowerCase()));
  return (ids || []).filter((id) => {
    const key = String(id || '').trim();
    if (free.has(key.toLowerCase())) return false;
    const canonical = PLANS[key.toUpperCase()] ? key.toUpperCase() : ALIASES[key.toLowerCase()];
    return !canonical;
  });
}

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
  /* 'trial' is ai-subscriptions.js's spelling of 'trialing' (see its status
     queries). Treating it as unentitled meant every AI trial silently received
     the FREE allowance — the trial existed and bought nothing. */
  const entitled = ['active', 'trialing', 'trial', 'grace'].includes(status);
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

module.exports = { PLANS, ALIASES, KNOWN_PLAN_IDS, LIFECYCLE, STATUS_ALIASES,
                   lifecycleOf, isEntitled, resolve, entitlementFor,
                   listingLimitFor, unmappedPlanIds };
