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
  const uid = String(providerId || '').trim();
  if (!uid) return DEFAULT_HUB;

  let snap;
  try {
    snap = await db.collection('applications').where('uid', '==', uid).limit(10).get();
  } catch (_) {
    return DEFAULT_HUB;                      /* see fail-soft note above */
  }
  if (!snap || snap.empty) return DEFAULT_HUB;

  const apps = snap.docs.map((d) => d.data() || {});
  /* A DECIDED application is the account's standing classification; an undecided one is only
     what the applicant ASKED for. Pricing on a pending request would let an applicant choose
     their own rate simply by applying — so an undecided application is never allowed to move
     a provider off the default, only a decided one is. */
  const decided = apps.find((a) =>
    ['approved', 'active', 'verified'].includes(String(a.status || '').toLowerCase()));
  if (!decided) return DEFAULT_HUB;

  const role = String(decided.role || '').trim().toLowerCase();
  return ROLE_TO_HUB[role] || DEFAULT_HUB;
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
  return { category: 'services', hubId: 'provider', subscriptionRole: 'provider' };
}

module.exports = { resolveProviderHub, commissionArgsForHub, ROLE_TO_HUB, DEFAULT_HUB };
