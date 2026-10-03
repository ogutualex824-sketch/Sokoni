'use strict';
/**
 * SOKONI — THE PUBLIC "VERIFIED" BADGE ON A PROVIDER  (Tech Hub slice 4P, 2026-10-03, sokoni-b2)
 * ===================================================================================================================
 * Separate states, never collapsed:
 *   APPLICATION APPROVAL   applications/{id} → applicationDecide → providers/{uid}.status   (may LIST the provider)
 *   VERIFICATION           verifications/{uid}.facets  ← verificationDecide / verificationRevoke ONLY (admin, audited
 *                          to adminLog, expiry-aware) — identity, business, professional, kra, …
 *   PUBLIC BADGE           providers/{uid}.verified — a PROJECTION of the facets, written only by the server:
 *                            verified ⇔ the `identity` facet is active (approved, not expired, not revoked)
 *                          (providers.html tells customers the badge means "completed SOKONI identity verification").
 *
 * The projection also snapshots the name it verified (`verifiedName`). The badge is valid only while the listing still
 * carries that name: renaming a verified listing drops the badge until an admin re-decides (re-verification), while
 * phone / bio / price edits leave it alone. Listings verified before this projection existed carry no verifiedName and
 * keep their legacy flag (reported as `legacy` to AdminOS) until an admin decision projects them.
 *
 * Pure: no I/O.
 */
const V = require('../verification-vocabulary');

const BADGE_FACET = 'identity';

const _name = (p) => String((p && (p.name || p.businessName)) || '').trim();

/** The badge fields to write onto providers/{uid}, from the canonical facets document. */
function computeBadge(verificationsDoc, providerDoc, nowMs) {
  const active = V.activeFacets(verificationsDoc || {}, nowMs);
  const verified = active.has(BADGE_FACET);
  return {
    verified,
    verifiedFacets: [...active].sort(),
    verifiedName: verified ? _name(providerDoc) : null,
    verificationReviewRequired: false,
  };
}

/** Is the badge on this providers/{uid} record currently valid to SHOW? (server indexers and the web use the same rule) */
function badgeValid(providerDoc) {
  const p = providerDoc || {};
  if (p.verified !== true) return false;
  if (p.verificationReviewRequired === true) return false;
  if (p.verifiedName == null) return true;                 /* legacy (pre-projection) flag — reported, not hidden */
  return p.verifiedName === _name(p);
}

/** AdminOS label for the badge state. */
function badgeState(providerDoc) {
  const p = providerDoc || {};
  if (p.verified !== true) return p.verificationReviewRequired ? 're_review_required' : 'not_verified';
  if (p.verifiedName == null) return 'legacy';
  return badgeValid(p) ? 'verified' : 're_review_required';
}

module.exports = { BADGE_FACET, computeBadge, badgeValid, badgeState };
