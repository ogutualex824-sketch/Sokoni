'use strict';
/**
 * SOKONI Healthcare subscription plans — the ONE table for the Healthcare hub.
 * ============================================================================================
 * Three tiers, and only these three. A Healthcare account's commercial subscription is
 * clinic | hospital | enterprise; the five generic provider tiers (free_trial … enterprise)
 * remain for every OTHER provider role and are not authoritative here.
 *
 * THIS IS NOT AN ELEVENTH CATALOGUE. These plans already existed, inline, inside
 * universal-onboarding.js's PLANS map. Moving them here does not add a table — it gives the
 * one that existed an owner, a contract and a test. universal-onboarding imports from here,
 * so there is still exactly one definition.
 *
 * ── TWO CAPACITIES, NEVER ONE ──────────────────────────────────────────────────────────────
 * `doctors` and `services` are different things and conflating them caused a real defect.
 * The provider service guard reads `limits.listings`; the healthcare plans only carried
 * `limits.doctors`. Pointing that guard at a healthcare subscription gave:
 *
 *     Number({doctors: 5}.listings)        -> NaN
 *     (NaN !== -1 && activeCount >= NaN)   -> false        // the guard never fires
 *
 * A comparison against NaN is always false, so the cap did not error — it stopped existing.
 * Hence the invariant, enforced by provider-ops and asserted by the suite:
 *
 *     limits.doctors   = practitioner capacity (seats)
 *     limits.services  = publishable healthcare services
 *     limits.listings  = NEVER used for Healthcare. Not aliased, not defaulted.
 *
 * ── NO COMMISSION FIELD ────────────────────────────────────────────────────────────────────
 * These plans previously carried commission 0.03 / 0.02 / 0.01, which contradicted the
 * ratified Healthcare rate of 5% (ADR-015). A subscription buys CAPACITY and CAPABILITIES;
 * it does not buy a rate. commission-config.js owns the rate, keyed by hub, and
 * provider-hub.commissionArgsForHub selects it.
 *
 * subscription-catalog.js learned this first and says so in its own header: a table created
 * to end drift immediately introduced some, and "nothing ever read them … the table was dead
 * the day it was written." A commission field here would be read — by
 * subscription-core.getCommissionRate — which is worse than dead: it would be a second
 * authority that disagrees with the first.
 *
 * Owner decision, 2026-09-13: Clinic 10 services, Hospital 50, Enterprise unlimited.
 */

/* -1 is unlimited, everywhere, always — the platform-wide convention. */
const UNLIMITED = -1;

const PLANS = Object.freeze({
  clinic: Object.freeze({
    id: 'clinic',
    label: 'Clinic',
    priceCents: 249900,                    /* KES 2,499 / month */
    limits: Object.freeze({ doctors: 5, services: 10 }),
    capabilities: Object.freeze({
      stories: true,
      storiesAdvancedAnalytics: false,
      storiesStaffPublishing: false,
      shopRequestable: true,
    }),
  }),
  hospital: Object.freeze({
    id: 'hospital',
    label: 'Hospital',
    priceCents: 499900,                    /* KES 4,999 / month */
    limits: Object.freeze({ doctors: 20, services: 50 }),
    capabilities: Object.freeze({
      stories: true,
      storiesAdvancedAnalytics: true,
      storiesStaffPublishing: true,
      shopRequestable: true,
    }),
  }),
  enterprise: Object.freeze({
    id: 'enterprise',
    label: 'Enterprise',
    priceCents: 999900,                    /* KES 9,999 / month */
    limits: Object.freeze({ doctors: UNLIMITED, services: UNLIMITED }),
    capabilities: Object.freeze({
      stories: true,
      storiesAdvancedAnalytics: true,
      storiesStaffPublishing: true,
      shopRequestable: true,
    }),
  }),
});

const TIERS = Object.freeze(Object.keys(PLANS));

/* The hub key these plans belong to. Matches provider-hub.ROLE_TO_HUB's output and
   commission-config's RATES key, so one spelling reaches subscriptions and commission. */
const HUB = 'healthcare';

/** A tier id this table defines. Unknown ids are NOT coerced to a default: a healthcare
 *  account with an unrecognised tier must resolve to "no plan" and take the unsubscribed
 *  floor, never a tier nobody bought. */
function isHealthcareTier(tier) {
  return Object.hasOwn(PLANS, String(tier || ''));
}

/** resolve(tier) -> the plan, or null. Null is meaningful; do not default it away. */
function resolve(tier) {
  const key = String(tier || '').trim().toLowerCase();
  return Object.hasOwn(PLANS, key) ? PLANS[key] : null;
}

/**
 * The service ceiling for a resolved subscription.
 *
 * FAILS CLOSED. The unsubscribed floor is 1 — the same floor provider-ops has always applied
 * to a provider with no subscription document. A tier that cannot be resolved, or a plan
 * whose limit is missing or non-numeric, also returns the floor rather than NaN: the defect
 * this module exists to prevent is a cap that silently evaluates to "no cap".
 */
const UNSUBSCRIBED_SERVICE_FLOOR = 1;

function serviceLimitFor(tier) {
  const plan = resolve(tier);
  if (!plan) return UNSUBSCRIBED_SERVICE_FLOOR;
  const n = Number(plan.limits.services);
  if (!Number.isFinite(n)) return UNSUBSCRIBED_SERVICE_FLOOR;
  return n;
}

function doctorLimitFor(tier) {
  const plan = resolve(tier);
  if (!plan) return 0;                     /* no plan, no practitioner seats */
  const n = Number(plan.limits.doctors);
  return Number.isFinite(n) ? n : 0;
}

/* The shape universal-onboarding's client-facing plan list expects (tier/label/price/limits),
   derived from this table rather than restated. `commission` is deliberately ABSENT — a
   client that reads a rate from a plan is reading a number no money path consults. */
function clientPlanList() {
  return TIERS.map((t) => {
    const p = PLANS[t];
    return {
      tier: p.id,
      label: p.label,
      price: p.priceCents,
      limits: { doctors: p.limits.doctors, services: p.limits.services },
      features: featureLabels(p),
      popular: p.id === 'hospital',
    };
  });
}

/* Display strings only. Never read as flags — capabilities are the flags, and
   capability-authority.js is what reads them. */
function featureLabels(p) {
  const d = p.limits.doctors === UNLIMITED ? 'Unlimited doctors' : `${p.limits.doctors} doctors`;
  const s = p.limits.services === UNLIMITED ? 'unlimited services' : `${p.limits.services} services`;
  return [d, s, 'Appointments & bookings', 'Stories'];
}

module.exports = {
  PLANS, TIERS, HUB, UNLIMITED, UNSUBSCRIBED_SERVICE_FLOOR,
  resolve, isHealthcareTier, serviceLimitFor, doctorLimitFor, clientPlanList,
};
