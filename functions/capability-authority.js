'use strict';
/**
 * SOKONI Capability Authority — what a subscription lets an account DO.
 * ============================================================================================
 * One function, `capabilitiesFor(uid, { hub })`, resolving through subscription-core so this
 * reads every subscription store rather than becoming a sixth.
 *
 * ── THIS IS NOT THE ENTITLEMENT ENGINE ─────────────────────────────────────────────────────
 * functions/entitlement-engine.js already owns the word "entitlement" for a different thing:
 *
 *     one payment reference  =>  exactly one entitlements/{paymentRef}
 *
 * That is a payment→capability LEDGER — it answers "has this payment been honoured exactly
 * once". This module answers "what may this account do right now", which is a question about
 * a live subscription, not about a payment. Naming both "entitlement" is precisely the
 * conflation this work exists to remove, so the vocabulary is kept apart on purpose:
 *
 *     entitlement  = a payment has been honoured        (entitlement-engine.js)
 *     capability   = a subscription permits an action   (this file)
 *
 * ── EVERY KEY MUST HAVE A READER ───────────────────────────────────────────────────────────
 * Two feature tables in this repository were dead on arrival — subscription-catalog's
 * walletEnabled/premiumAnalytics/prioritySupport/multiBranch/staffSeats, and subscription-os's
 * MKT_PLANS — and both were found the same way: by asking who reads them rather than what they
 * look like. A capability key with no reader is a promise to a paying customer that nothing
 * keeps.
 *
 * So every key below names its consumer, and scripts/verify-capability-consumers.js FAILS if a
 * declared key has no reader outside this file. Adding a key is therefore a two-part change by
 * construction: declare it, and wire something to it.
 *
 * ── CAPABILITY IS NOT AUTHORITY ────────────────────────────────────────────────────────────
 * A capability says what a PLAN permits. It never says who someone is. Role, organisation
 * membership, professional verification and admin authority are decided elsewhere (the
 * application's admin-decided role, adminDecideProviderVerification, custom claims) and are
 * never purchasable. Nothing here grants a role, and nothing here should ever be consulted to
 * decide one.
 */

const subCore = require('./subscription-core');
const hcPlans = require('./healthcare-plans');

/**
 * Declared capability keys. `consumer` is documentation AND the guard's subject: the named
 * module must actually read the key, or scripts/verify-capability-consumers.js fails.
 */
const DECLARED = Object.freeze({
  stories: {
    describe: 'May publish Stories',
    consumer: 'functions/stories-capability.js',
  },
  storiesAdvancedAnalytics: {
    describe: 'Story analytics beyond the basic view',
    consumer: 'functions/stories-capability.js',
  },
  storiesStaffPublishing: {
    describe: 'Staff/organisation members may publish on the account\'s behalf',
    consumer: 'functions/stories-capability.js',
  },
  shopRequestable: {
    describe: 'May request a merchant Shop identity (POS/Till/inventory)',
    consumer: 'functions/provider-shop.js',
  },
  serviceLimit: {
    describe: 'Publishable healthcare services ceiling (-1 unlimited)',
    consumer: 'functions/provider-ops.js',
  },
  listingLimit: {
    describe: 'Merchant product listing ceiling (-1 unlimited)',
    consumer: 'functions/stories-capability.js',
  },
  storyAllowancePerWeek: {
    describe: 'Stories publishable per week (-1 unlimited, null = undecided)',
    consumer: 'functions/stories-capability.js',
  },
  videoCalling: {
    describe: 'SOKONI Connect video sessions (Enterprise package; org grant still required)',
    consumer: 'functions/connect-calls.js',
  },
  /* `videoVerification` IS NOT DECLARED HERE, and its absence is the point.
   *
   * A platform admin conducting an identity or merchant verification holds an authority that
   * is NOT purchasable and must never become a plan attribute — the moment it is declared as a
   * capability, some future branch resolves it from a subscription and Enterprise buys the
   * right to verify people. connect-authority.resolveVideoAccess takes `isPlatformAdmin` as a
   * decided custom claim on a separate branch that no capability set can reach. */
  /* `doctorLimit` IS NOT DECLARED HERE, and its absence is deliberate.
   *
   * The plans carry `limits.doctors` (Clinic 5, Hospital 20, Enterprise unlimited) and
   * healthcare-plans.doctorLimitFor() reads it, so the commercial value exists and is tested.
   * But nothing ENFORCES a practitioner seat count — there is no healthcare staff-seat
   * system yet — and scripts/verify-capability-consumers.js failed this key when it was
   * declared, which is exactly what that guard is for.
   *
   * Declaring it anyway would have made this module claim an authority it does not hold: the
   * same defect as subscription-catalog's five flags, which no one ever read. It is added the
   * day a seat check reads it, not before. */
});

const KEYS = Object.freeze(Object.keys(DECLARED));

/* The capability set for an account with no resolvable subscription.
 *
 * STORIES IS TRUE HERE, AND THAT IS DELIBERATE. Stories is a platform capability today —
 * firestore.rules grants `allow create: if isAuthed()`, with no plan, tier or role gate and
 * not even a seller check. Returning false for an unsubscribed account would make this module
 * claim an authority it does not hold and that the rules do not enforce, which is how a
 * "limit" that exists only in a dashboard gets mistaken for a real one. When a server-side
 * story ceiling is built, THIS is the line that changes, together with the rule. */
const UNSUBSCRIBED = Object.freeze({
  stories: true,
  storiesAdvancedAnalytics: false,
  storiesStaffPublishing: false,
  shopRequestable: false,
  serviceLimit: hcPlans.UNSUBSCRIBED_SERVICE_FLOOR,
  listingLimit: null,
  storyAllowancePerWeek: null,
  /* FALSE, and false is the only safe floor. Video is the strongest channel the platform has
     and the one whose misuse is least recoverable — a camera switched on cannot be un-seen. */
  videoCalling: false,
});

/* ── MERCHANT PACKAGES (owner decision 2026-09-13) ─────────────────────────────────────────
 * Stories is available on ALL FOUR packages — the differentiator is ALLOWANCE and advanced
 * functionality, never access. That is not a new policy: the live rule already grants
 * publishing to any authenticated user, so an Enterprise-only gate would be a restriction
 * being introduced rather than preserved.
 *
 * `storyAllowancePerWeek` is 1 for FREE (decided) and NULL for the paid packages (undecided).
 * Null is not "unlimited" and must never be rendered as a number — a guessed allowance would
 * become a real constraint the moment enforcement lands. Higher packages must exceed FREE,
 * which is a property the suite asserts once the values exist.
 *
 * listingLimit mirrors subscription-catalog rather than restating it: two tables of listing
 * limits is the exact divergence that file was created to end. */
const MERCHANT_STORY_ALLOWANCE = Object.freeze({
  FREE: 1,
  PROFESSIONAL: null,   /* TBD — must exceed FREE */
  BUSINESS: null,       /* TBD — must exceed PROFESSIONAL */
  ENTERPRISE: null,     /* TBD — highest */
});

/**
 * capabilitiesFor(uid, { hub }) -> { found, hub, tier, status, capabilities }
 *
 * `hub` selects the commercial vocabulary. 'healthcare' resolves the three Healthcare plans;
 * anything else returns the unsubscribed floor from this module, because no other hub has
 * declared capabilities yet — and inventing them here would recreate the dead-table defect
 * this file's header describes.
 *
 * FAILS CLOSED. An unreadable subscription yields UNSUBSCRIBED, never the capabilities of a
 * tier nobody has been shown to hold.
 */
async function capabilitiesFor(uid, opts = {}) {
  const hub = String((opts && opts.hub) || '').trim() || null;
  const base = { found: false, hub, tier: null, status: 'none', capabilities: { ...UNSUBSCRIBED } };
  if (!uid) return base;

  /* ── MERCHANT ────────────────────────────────────────────────────────────────────────────
   * Resolved through subscription-core with role 'merchant', which reads merchantSubscriptions
   * first and keeps the legacy stores beneath it — so a merchant on an old `subscriptions` row
   * resolves to the same package as one on the new store. The PLAN itself comes from
   * subscription-catalog via entitlementFor, which already owns expiry semantics: expired,
   * cancelled and past_due all fall to FREE without deleting anything. */
  if (hub === 'merchant') {
    let sub = null;
    try { sub = await subCore.resolveSubscription(uid, { role: 'merchant' }); }
    catch (_) { return base; }
    const catalog = require('./subscription-catalog');
    const ent = catalog.entitlementFor(sub && sub.found
      ? { plan: sub.tier, status: sub.status }
      : {});
    return {
      found: !!(sub && sub.found), hub, tier: ent.plan,
      status: sub && sub.found ? sub.status : 'none',
      capabilities: Object.freeze({
        stories: true,                               /* every package — never Enterprise-only */
        storiesAdvancedAnalytics: ent.features.premiumAnalytics === true,
        storiesStaffPublishing: ent.staffSeats === -1 || Number(ent.staffSeats) > 1,
        shopRequestable: false,                      /* merchants already have a shop identity */
        serviceLimit: hcPlans.UNSUBSCRIBED_SERVICE_FLOOR,   /* healthcare concept, not merchant */
        listingLimit: ent.listingLimit,
        storyAllowancePerWeek: Object.hasOwn(MERCHANT_STORY_ALLOWANCE, ent.plan)
          ? MERCHANT_STORY_ALLOWANCE[ent.plan] : null,
        /* ENTERPRISE ONLY — an owner decision, and the one capability where the gate is the
           product rather than an allowance. Resolved from `ent.plan` rather than from a
           feature flag on the catalogue, because subscription-catalog's five flags were dead
           on arrival and adding a sixth would repeat that exactly.

           `entitlementFor` has already applied expiry: an expired or cancelled Enterprise
           subscription resolves to FREE before it reaches this line, so video lapses with the
           plan without anything here knowing about dates. */
        videoCalling: ent.plan === 'ENTERPRISE',
      }),
    };
  }

  if (hub !== hcPlans.HUB) return base;

  let sub = null;
  try {
    sub = await subCore.resolveSubscription(uid, { role: hcPlans.HUB });
  } catch (_) {
    return base;                                   /* unreadable -> the floor */
  }
  if (!sub || !sub.found) return base;

  /* Only a LIVE subscription confers capability. An expired or cancelled plan falls back to
     the floor without deleting anything the account already created — growth is gated,
     operations continue. This mirrors subscription-catalog.entitlementFor's stance. */
  const live = ['active', 'trialing', 'grace'].includes(String(sub.status || '').toLowerCase());
  const plan = hcPlans.resolve(sub.tier);
  if (!live || !plan) {
    return { found: true, hub, tier: sub.tier || null, status: sub.status || 'none',
      capabilities: { ...UNSUBSCRIBED } };
  }

  return {
    found: true,
    hub,
    tier: plan.id,
    status: sub.status,
    capabilities: Object.freeze({
      stories:                  plan.capabilities.stories,
      storiesAdvancedAnalytics: plan.capabilities.storiesAdvancedAnalytics,
      storiesStaffPublishing:   plan.capabilities.storiesStaffPublishing,
      shopRequestable:          plan.capabilities.shopRequestable,
      serviceLimit:             hcPlans.serviceLimitFor(plan.id),
      /* The healthcare plans have not declared a video entitlement. Stated explicitly rather
         than left undefined so a reader sees a decision rather than an omission — and so the
         key is never absent from a capability set some consumer spreads into another. */
      videoCalling:             false,
    }),
  };
}

/** Convenience for a single boolean key. Never use it for a numeric limit — a limit of 0 is
 *  falsy and would read as "not permitted" when it means "permitted, zero of them". */
async function can(uid, key, opts = {}) {
  if (!Object.hasOwn(DECLARED, key)) {
    throw new Error(`capability-authority: "${key}" is not a declared capability.`);
  }
  const r = await capabilitiesFor(uid, opts);
  return r.capabilities[key] === true;
}

module.exports = { capabilitiesFor, can, DECLARED, KEYS, UNSUBSCRIBED };
