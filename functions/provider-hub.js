'use strict';
/**
 * SOKONI — which HUB a provider booking belongs to, and what that means for commission.
 * ============================================================================================
 * A service booking for a plumber and a service booking for a doctor run through the SAME
 * machinery (bookingCreateService -> createPaymentIntent -> IntaSend -> paid_held -> Phase C
 * settlement). They differ in exactly one respect: the commercial rate the platform charges.
 *
 * Healthcare is 5% (owner decision, recorded in ADR-015 and already carried by
 * commission-config.RATES.healthcare). Every other provider booking is priced by the
 * provider's SUBSCRIPTION PLAN — Free Trial 20% ... Enterprise 5% — through the engine's
 * `subscriptionRole` compatibility mode. This module is the single place that difference is
 * expressed, so the two calculateCommission call sites in provider-ops.js cannot drift apart.
 *
 * IT IS NOT A SECOND COMMISSION CALCULATOR. It computes no rate and no amount. It selects
 * which INPUTS the one canonical engine (finos-utils.calculateCommission, over the one
 * canonical table commission-config.RATES) is called with. commissionRules and revenueConfig
 * still outrank everything returned here, so platform governance is unaffected.
 *
 * WHY THE HUB IS NOT READ FROM `providers/{uid}.category`
 * ------------------------------------------------------
 * That field looks like the obvious discriminator and is the wrong one. It is written from
 * `draft.profile.category` at publish (provider-onboarding.js) through `_san()`, which caps
 * length and strips angle brackets — it does NOT validate against SERVICE_CATEGORIES, which
 * is only ever SERVED to the client (providerGetCatalogue), never used to check what comes
 * back. The field is therefore provider-settable free text.
 *
 * Pricing on it would mean any provider could type "Healthcare" into their own profile and
 * move themselves from their plan rate — up to 20% — down to 5%. That is a self-serve
 * discount on live money, and it would have been introduced BY this convergence.
 *
 * The authority-bearing signal is the role on the provider's DECIDED application: an admin
 * sets it through applicationDecide, the applicant cannot. That is the same signal OB-6 used
 * to pick a provider's legal agreements (provider-onboarding._agreementRoleFor), and it is
 * resolved here the same way, for the same reason.
 *
 * WHY IT IS SNAPSHOTTED ONTO THE BOOKING
 * --------------------------------------
 * docs/BOOKING_PAYMENT_CONTRACT.md invariant 2: the amount derives exclusively from the
 * server-minted snapshot taken at booking creation. `price`, `fee` and `deposit` already
 * work that way, so a later rate-card edit cannot reprice a booking that is already paid.
 * The hub is the same kind of input and gets the same treatment: stamped once at creation as
 * `commissionHub`, read at settlement. It is deliberately NOT the booking's `hubType`, which
 * is client-supplied (`_san(d.hubType, 40)`) and descriptive only. A provider reclassified months later does not retroactively reprice
 * bookings that were taken under the old classification — and settlement performs no extra
 * read to find out.
 */

const ROLE_TO_HUB = {
  /* `health` is the role-authority spelling (ROLE_KEY.health) carried on applications/{id};
     `healthcare` is the commission-config / hub spelling. This alias is DELIBERATELY separate
     from legal-agreements.ROLE_ALIASES, which maps the same role onto the legal CATALOGUE key.
     They agree today by coincidence of naming, not by contract: renaming a legal catalogue
     entry must never silently reprice money, so the two tables stay independent. */
  health: 'healthcare',
};

/* The hub a booking is priced under when the provider has no hub-specific classification.
   `provider` is the generic services hub — the plan-priced path every existing booking
   takes today, and the value that keeps this change a no-op for them. */
const DEFAULT_HUB = 'provider';

/**
 * Resolve the commercial hub for a provider from their DECIDED application role.
 *
 * Fail-soft by design: this runs inside booking creation, and a provider whose application
 * cannot be read must still be bookable. An unreadable or absent application resolves to
 * DEFAULT_HUB — the provider's own plan rate, which is the HIGHER charge for every plan
 * below Enterprise. A lookup failure can therefore never hand out the cheaper healthcare
 * rate; it can only fall back to what the platform already charges.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} providerId
 * @returns {Promise<string>} hub key, e.g. 'healthcare' | 'provider'
 */
async function resolveProviderHub(db, providerId) {
  return (await resolveProviderClassification(db, providerId)).hub;
}

/**
 * The provider's commercial hub AND Entertainment class, from the DECIDED application only (never the
 * self-editable providerProfiles.category — a provider could otherwise re-file themselves into a
 * cheaper lane). { hub: 'healthcare' | 'entertainment' | 'provider', entClass: 'ARTIST' | 'SERVICE' | null }.
 * Entertainment (owner decision 2026-09-27): a decided `provider` application whose category is a
 * performer / Entertainment service type (shared/ent-booking-identity.classifyApplication).
 */
/**
 * The commercial lane a DECIDED application implies — the classification this module has always applied, as a
 * pure function so it can be STAMPED once, at approval (application-lifecycle.projectProvider →
 * providers/{uid}.business.lane, CHANGELOG 236) instead of being re-derived at every booking from fields the
 * provider could still edit after approval.
 */
function classifyDecidedApplication(decided) {
  const out = { hub: DEFAULT_HUB, entClass: null };
  if (!decided) return out;
  const role = String(decided.role || '').trim().toLowerCase();
  if (ROLE_TO_HUB[role]) return { hub: ROLE_TO_HUB[role], entClass: null };
  const entClass = require('./shared/ent-booking-identity').classifyApplication(decided);
  if (entClass) return { hub: 'entertainment', entClass };
  /* SPORTS COACH (owner 2026-10-03): a decided application whose category is a coach type books on the provider engine
     and is priced sports_coaching (flat 5%). Read from the DECIDED application only — frozen once decided. */
  if (isCoachApplication(decided)) return { hub: 'sports_coaching', entClass: null };
  return out;
}

const COACH_TYPES = Object.freeze(new Set(['coach', 'sports-coach', 'sports_coach', 'sports coach', 'sports-trainer', 'sports_trainer']));
function isCoachApplication(app) {
  const cands = [app && app.subcategory, app && app.category, app && app.businessCategory].concat(Array.isArray(app && app.categories) ? app.categories : []);
  return cands.some((c) => COACH_TYPES.has(String(c || '').trim().toLowerCase()));
}

const _LANE_HUBS = ['healthcare', 'entertainment', 'sports_coaching', DEFAULT_HUB];
const _millis = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (typeof v === 'number' ? v : (v ? Date.parse(v) || 0 : 0)));

async function resolveProviderClassification(db, providerId) {
  const out = { hub: DEFAULT_HUB, entClass: null };
  const uid = String(providerId || '').trim();
  if (!uid) return out;

  /* 1 — the lane STAMPED at approval (CHANGELOG 236): server-written, rule-protected, frozen. */
  try {
    const p = await db.collection('providers').doc(uid).get();
    const lane = p.exists && p.data() && p.data().business && p.data().business.lane;
    if (lane && _LANE_HUBS.includes(lane.hub)) {
      return { hub: lane.hub, entClass: lane.hub === 'entertainment' && (lane.entClass === 'ARTIST' || lane.entClass === 'SERVICE') ? lane.entClass : null };
    }
  } catch (_) { /* fall through to the legacy derivation — same fail-soft stance as below */ }

  /* 2 — LEGACY (approved before CHANGELOG 236, no stamp): derive from the decided application, as before. The
     application's classification fields are frozen once decided (firestore.rules), and the MOST RECENTLY
     decided application wins — the read order is no longer what decides a price. */
  let snap;
  try {
    snap = await db.collection('applications').where('uid', '==', uid).limit(10).get();
  } catch (_) {
    return out;                              /* see fail-soft note above */
  }
  if (!snap || snap.empty) return out;

  const apps = snap.docs.map((d) => d.data() || {});
  /* A DECIDED application is the account's standing classification; an undecided one is only
     what the applicant ASKED for. Pricing on a pending request would let an applicant choose
     their own rate simply by applying — so an undecided application is never allowed to move
     a provider off the default, only a decided one is. */
  const decided = apps
    .filter((a) => ['approved', 'active', 'verified'].includes(String(a.status || '').toLowerCase()))
    .sort((a, b) => _millis(b.decidedAt || b.updatedAt) - _millis(a.decidedAt || a.updatedAt))[0];
  if (!decided) return out;
  return classifyDecidedApplication(decided);
}

/**
 * The calculateCommission inputs for a hub. The ONE place the healthcare rate is selected.
 *
 * Healthcare:
 *   category/hubId 'healthcare' -> commission-config.RATES.healthcare = 5%, and lets an admin
 *   target healthcare specifically through commissionRules/revenueConfig (hub_healthcare).
 *
 *   `subscriptionRole` is deliberately OMITTED. Passing it would put the engine in
 *   compatibility mode, where the provider's plan rate is ABSOLUTE and outranks the category
 *   table — a Free Trial healthcare provider would be charged 20%, not the approved 5%.
 *
 *   `skipMinimum` is deliberately PASSED. The KES 10 platform floor is suppressed for
 *   plan-priced bookings via the engine's `usingSubRate` flag; dropping subscriptionRole also
 *   drops that suppression, which would newly apply a floor to small healthcare bookings
 *   (a KES 100 consultation at 5% = KES 5 -> KES 10, a 100% increase). The provider booking
 *   path has never had a floor. This keeps the convergence a rate change only — exactly the
 *   reason the engine exposes the flag (see finos-utils.js, "COMPATIBILITY: suppress the
 *   platform minimum").
 *
 * Everything else: byte-identical to what provider-ops.js passed before this module existed.
 *
 * @param {string|null|undefined} hub
 * @returns {{category: string, hubId: string, subscriptionRole?: string, skipMinimum?: boolean}}
 */
function commissionArgsForHub(hub) {
  if (String(hub || '') === 'healthcare') {
    return { category: 'healthcare', hubId: 'healthcare', skipMinimum: true };
  }
  /* Entertainment bookings: a flat 5 % (RATES.entertainment_bookings), NOT the plan rate — so no
     subscriptionRole (which would make the plan rate absolute), and no KES 10 floor (same reason as
     healthcare above: this lane never had one). */
  if (String(hub || '') === 'entertainment') {
    return { category: 'entertainment_bookings', hubId: 'entertainment', skipMinimum: true };
  }
  /* Sports coaching (owner 2026-10-03): the explicit sports_coaching row — flat 5 %, no subscriptionRole, no floor. */
  if (String(hub || '') === 'sports_coaching') {
    return { category: 'sports_coaching', hubId: 'sports', skipMinimum: true };
  }
  /* Fitness bookings / memberships: the fixed 5 % fitness lane (commission-config FIXED_RATE_CATEGORIES, floor-exempt). */
  if (String(hub || '') === 'fitness') {
    return { category: 'fitness', hubId: 'fitness', skipMinimum: true };
  }
  /* EVERY OTHER SERVICE BOOKING — owner 2026-10-03: "SOKONI takes 5% of the service amount, paid by the provider
     (deducted at settlement) … charged once per booking, from commercial config", and it REPLACES the plan ladder
     (asked and answered: "Yes, flat 5% for all"). So NO subscriptionRole (which made the plan rate — Free 20 % …
     Enterprise 5 % — absolute) and no KES 10 floor (this lane never had one). The rate is RATES.services (5 %); an
     admin can still adjust it through commissionRules / revenueConfig(hub_provider) like every other category.
     Plans now unlock features only (subscription-catalog), never a commission rate. */
  return { category: 'services', hubId: 'provider', skipMinimum: true };
}

/* ── Per-BOOKING lane (marketing, owner 2026-10-03; field contract with sokoni-b2 9319925) ──────────────────────────────
   Marketing is decided from the BOOKING's own server snapshot, never the provider's current approval and never the client
   hubType: lane = marketing_services iff booking.serviceHub === 'marketing' AND serviceCategory is a taxonomy id
   (shared/marketing-taxonomy.js, byte-identical with b2's line). Approval was checked by bookingCreateService at booking time;
   a later category change must NOT rewrite a historical booking's commission. A 'marketing' booking whose category is missing
   or unknown is REFUSED (category_unpriced) — never the 5 % services default. Every other booking → commissionArgsForHub. */
function commissionArgsForBooking(booking) {
  const b = booking || {};
  if (b.serviceHub === 'marketing') {
    if (require('./shared/marketing-taxonomy').isArea(String(b.serviceCategory || ''))) {
      return { category: 'marketing_services', hubId: 'marketing', skipMinimum: true };
    }
    const e = new Error('This marketing service has no priced category.'); e.code = 'category_unpriced'; throw e;
  }
  return commissionArgsForHub(b.commissionHub);
}

module.exports = { resolveProviderHub, resolveProviderClassification, classifyDecidedApplication, commissionArgsForHub, commissionArgsForBooking, isCoachApplication, ROLE_TO_HUB, DEFAULT_HUB };
