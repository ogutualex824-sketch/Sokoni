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

  /* ── THE AI FAMILY (from the production lineage, 2026-08-19) ─────────────────────────────
     These were absent, and their absence was not visible: resolve() falls back to FREE for an
     unknown id (correct — a typo must not take a shop offline), so a PAID ai_starter merchant
     silently received the free allowance while their subscription still reported ACTIVE.
     ai-subscriptions.js PLANS is the definition these mirror. Translated into the 2026-09-13
     package vocabulary: the production lineage mapped ai_starter → STARTER and ai_pro → GROWTH,
     which are the tiers PROFESSIONAL and BUSINESS replaced (see the retired spellings above). */
  ai_free: 'FREE', ai_starter: 'PROFESSIONAL', ai_pro: 'BUSINESS', ai_enterprise: 'ENTERPRISE',

  /* Written by business-bootstrap as the SmartPOS trial's `plan` field. It is a STATUS word
     sitting in a plan field; mapping it keeps it off the unknown path, and the trial's real
     allowance comes from its planId. */
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
  'FREE', 'PROFESSIONAL', 'BUSINESS', 'ENTERPRISE',
  /* retired tier ids still in circulation — mapped, never canonical */
  'starter', 'growth',
]);

/* Ids that do NOT resolve to a real plan — i.e. would land on FREE by accident
   rather than by intent. `expectFree` lists the ones that are legitimately free. */
function unmappedPlanIds(ids, expectFree) {
  const free = new Set((expectFree || []).map((s) => String(s).toLowerCase()));
  return (ids || []).filter((id) => {
    const key = String(id || '').trim();
    if (free.has(key.toLowerCase())) return false;
    const canonical = PLANS[key.toUpperCase()] ? key.toUpperCase() : ALIASES[key.toLowerCase()];
    return !canonical && !hubPlan(key);
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
    /* HUB entitlement (2026-10-03). Restaurant, hotel, pharmacy, driver, property, recruiter, freelancer,
       car-dealer and buyer plans live in sub-billing.js PLANS and used to fall straight through to the seller
       FREE allowance above — a paid Restaurant Pro read as FREE. null when the plan is not a hub plan. */
    hub:                hubEntitlementFor(sub, entitled),
    catalogVersion:     CATALOG_VERSION,
    source:             'subscription-catalog',
    resolvedAt:         new Date().toISOString(),
  };
}

/* ══ HUB PLANS (2026-10-03) ═══════════════════════════════════════════════════════════════════════════════
   ONE catalogue for every vertical. Prices, tiers and feature limits stay where they are configured —
   sub-billing.js PLANS (no second table). This layer answers the two questions a gate asks:
     hubEntitlementFor(subscription)            → what this hub plan grants (or the hub's FREE plan when lapsed)
     requireFeature(subscription, {hubType, feature, capability?, needed?})
                                                → { allowed:true, limit } | { allowed:false, upgradeRequired }
   upgradeRequired = { capability, feature, hubType, currentTier, minTier, minPlanId } — computed from the real
   plan table (the cheapest ACTIVE plan of that hub that satisfies the feature), never invented. minPlanId null
   means no plan offers it. An unknown feature is REFUSED (reason 'unknown_feature'), never silently allowed.

   CAPABILITIES are not plan features. FOOD_MENU / KITCHEN / DRINKS / CATERING / BAKERY
   (functions/shared/service-capabilities.js, feat/capability-engine-on-c7e26b6) say what a business IS, from its
   business type; plans say how much of it may be used. The caller names the capability whose feature it is
   gating; it is validated against that engine when present and echoed in upgradeRequired so merchant-v2 can show
   "Kitchen — upgrade to Restaurant Pro for KDS". No capability is ever granted here.

   Plans that are NOT hub plans here: seller_* (the catalogue's own seller path above), provider plans
   (PROVIDER_PLAN_RATES — commission, refused when unknown) and the generic ids business/pro/starter/enterprise. */
const _NOT_HUB = Object.freeze(new Set(['seller', 'service_provider', 'enterprise']));
/* billing hub → the capability engine's vertical, ONLY where that vertical exists. The rest keep their billing
   name until their vertical is defined — no guessed mapping. */
const HUB_VERTICAL = Object.freeze({ restaurant: 'food' });
const _ENTITLED = ['active', 'trialing', 'trial', 'grace'];
function _hubPlans() {
  try { return require('./sub-billing').PLANS || {}; } catch (_) { return {}; }   /* lazy: keeps this module light */
}
function _verticalOf(billingHub) { return HUB_VERTICAL[billingHub] || billingHub; }
function _view(pl) {
  return { planId: pl.id, billingHubType: pl.hubType, hubType: _verticalOf(pl.hubType), tier: pl.tier,
           name: pl.name, isActive: pl.isActive !== false, features: Object.assign({}, pl.features || {}) };
}
/** hubPlan(planId) — the hub plan behind an id, or null (seller/provider/generic ids are not hub plans). */
function hubPlan(planId) {
  const pl = _hubPlans()[String(planId || '').trim()];
  if (!pl || !pl.hubType || _NOT_HUB.has(pl.hubType)) return null;
  return _view(pl);
}
/** Active plans of one hub (accepts the vertical — 'food' — or the billing name — 'restaurant'), cheapest first. */
function hubPlansOf(hubType) {
  const want = String(hubType || '');
  return Object.values(_hubPlans())
    .filter((pl) => pl && pl.hubType && !_NOT_HUB.has(pl.hubType) && pl.isActive !== false && (pl.hubType === want || _verticalOf(pl.hubType) === want))
    .sort((a, b) => ((a.price && a.price.monthly) || 0) - ((b.price && b.price.monthly) || 0))
    .map(_view);
}
/** The plan a lapsed / absent subscription falls back to inside a hub: that hub's free plan (a KNOWN state). */
function _hubFree(hubType) { return hubPlansOf(hubType).find((v) => v.tier === 'free') || null; }
function hubEntitlementFor(subscription, entitledArg) {
  const sub = subscription || {};
  const hp = hubPlan(sub.plan || sub.planId || sub.tier);
  if (!hp) return null;
  const entitled = typeof entitledArg === 'boolean' ? entitledArg : _ENTITLED.includes(String(sub.status || 'none').toLowerCase());
  const eff = entitled ? hp : (_hubFree(hp.billingHubType) || Object.assign({}, hp, { tier: 'free', features: {} }));
  return Object.assign({}, eff, { subscribedPlanId: hp.planId, entitled });
}
function _satisfies(features, feature, needed) {
  if (!features || !(feature in features)) return null;          /* not defined on this plan */
  const v = features[feature];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === -1 || (needed == null ? v > 0 : Number(needed) <= v);
  return !!v;
}
/* Shape check only. The capability is ECHOED in upgradeRequired, never granted here, so validating it against the
   capability engine is not a security boundary. The engine (shared/service-capabilities.js) lives on another lineage,
   and the deploy require-closure gate refuses a module absent from the tree even behind try/catch — so this file no
   longer requires it (2026-10-03). */
function _capabilityOk(capability) {
  if (capability == null) return true;
  return /^[A-Z][A-Z_]+$/.test(String(capability));
}
/**
 * requireFeature(subscription, { hubType, feature, capability, needed })
 * subscription: the hub subscription doc (plan/planId + status), or null for "no subscription".
 */
function requireFeature(subscription, opts) {
  const o = opts || {};
  const hubType = String(o.hubType || '');
  const plans = hubPlansOf(hubType);
  if (!plans.length) return { allowed: false, reason: 'unknown_hub', hubType };
  if (!_capabilityOk(o.capability)) return { allowed: false, reason: 'unknown_capability', capability: o.capability };
  if (!plans.some((v) => o.feature in v.features)) return { allowed: false, reason: 'unknown_feature', feature: o.feature, hubType };
  let ent = hubEntitlementFor(subscription);
  /* a subscription to ANOTHER hub's plan grants nothing here; no subscription = this hub's free plan */
  if (!ent || (ent.billingHubType !== plans[0].billingHubType)) ent = Object.assign({}, _hubFree(hubType) || { tier: 'free', features: {} }, { entitled: false });
  const ok = _satisfies(ent.features, o.feature, o.needed);
  if (ok === true) return { allowed: true, limit: ent.features[o.feature], tier: ent.tier, planId: ent.planId || null };
  const min = plans.find((v) => _satisfies(v.features, o.feature, o.needed) === true) || null;
  return { allowed: false, reason: 'upgrade_required', upgradeRequired: {
    capability: o.capability || null, feature: o.feature, hubType: plans[0].hubType,
    currentTier: ent.tier || 'free', currentLimit: ent.features ? ent.features[o.feature] : undefined,
    minTier: min ? min.tier : null, minPlanId: min ? min.planId : null } };
}

/** Convenience for the one question most callers actually ask. */
function listingLimitFor(subscription) {
  return entitlementFor(subscription).listingLimit;
}

module.exports = { PLANS, ALIASES, KNOWN_PLAN_IDS, LIFECYCLE, STATUS_ALIASES,
                   lifecycleOf, isEntitled, resolve, entitlementFor,
                   listingLimitFor, unmappedPlanIds,
                   hubPlan, hubPlansOf, hubEntitlementFor, requireFeature, HUB_VERTICAL };
