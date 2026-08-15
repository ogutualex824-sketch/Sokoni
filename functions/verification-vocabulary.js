/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI Verification Vocabulary — the ONE canonical facet list.

   Mirrors the role-vocabulary.js pattern deliberately: one list, imported by
   every writer and reader, never a second copy. Before this module the platform
   held THREE incompatible schemas for the same fact —

     · applicant/admin : display strings  ("Verified Business")   verification.html
     · badge renderer  : mixed slugs      (business, doctor, …)   sokoni-verifications.js
     · trust + profile : facet booleans   (businessVerified, …)   profile-engine.js

   — and no two agreed, which is why no badge could ever render. The third shape
   was the only structurally correct one: verification is MULTI-FACET. A merchant
   can hold business + kra + identity simultaneously, which a single `type` field
   cannot express. Facets win; display strings live in client label maps and never
   enter Firestore.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/* The 10 canonical facets. `merchantVerified` folded into `business` — a merchant
   IS a business identity, and two names for one fact is how the original
   divergence started. */
const FACETS = Object.freeze([
  'identity',
  'business',
  'professional',
  'driver',
  'doctor',
  'lawyer',
  'property_agent',
  'kra',
  'address',
  'bank',
]);

const _FACET_SET = new Set(FACETS);

/* Which canonical role (role-vocabulary.js) may REQUEST which facet.
   Server-authoritative: the caller's requested facet is validated against their
   APPROVED CLAIMS, never against users.roles or any client-supplied field —
   those are writable by the account holder and would re-open the forged-badge
   class this whole contract exists to close.

   null = open to any authenticated account, because the facet verifies an
   attribute of the PERSON rather than a commercial role. */
const FACET_ELIGIBILITY = Object.freeze({
  identity:       null,
  address:        null,
  bank:           null,
  business:       Object.freeze(['seller', 'provider', 'landlord']),
  kra:            Object.freeze(['seller', 'provider', 'landlord']),
  professional:   Object.freeze(['provider', 'mechanic']),
  driver:         Object.freeze(['rider']),
  doctor:         Object.freeze(['health']),
  lawyer:         Object.freeze(['legal']),
  property_agent: Object.freeze(['landlord']),
});

/* Expiry POLICY per facet. Deliberately NOT a duration: no arbitrary period is
   invented here. The admin supplies expiresAt from the evidence in front of
   them; this table only says whether a decision is allowed to omit it.

     none                     — never expires
     required                 — a decision MUST carry expiresAt
     required_if_credentialed — licence-backed; expected where the credential has a date
     required_if_applicable   — expected where the registration carries one
     from_evidence            — taken from the document being verified */
const FACET_EXPIRY = Object.freeze({
  identity:       'none',
  business:       'none',
  address:        'none',
  bank:           'none',
  driver:         'required',
  professional:   'required_if_credentialed',
  doctor:         'required_if_credentialed',
  lawyer:         'required_if_credentialed',
  property_agent: 'required_if_applicable',
  kra:            'from_evidence',
});

/* Presentation ONLY. The public projection always returns the COMPLETE set of
   active facets; this orders them so a compact surface that can show a single
   badge picks deterministically. It must never become a storage decision — a
   provider who is both a doctor and a business is BOTH, and the data says so. */
const BADGE_PRECEDENCE = Object.freeze([
  'doctor',
  'lawyer',
  'property_agent',
  'driver',
  'business',
  'professional',
  'kra',
  'identity',
  'address',
  'bank',
]);

/* Facet lifecycle states. `revoked` is first-class: the previous flow could mark
   a request rejected while leaving an approved badge in place, because it had no
   way to express "this was true and no longer is". */
const FACET_STATES = Object.freeze(['pending', 'approved', 'rejected', 'revoked', 'expired']);

/** Is this a canonical facet slug? */
function isFacet(f) {
  return _FACET_SET.has(String(f || '').trim().toLowerCase());
}

/** Normalise a caller-supplied facet, or null if it is not canonical. */
function canonicalFacet(f) {
  const v = String(f == null ? '' : f).trim().toLowerCase();
  return _FACET_SET.has(v) ? v : null;
}

/**
 * May an account holding `approvedRoles` request `facet`?
 * `approvedRoles` MUST come from verified custom claims.
 */
function isEligible(facet, approvedRoles) {
  const f = canonicalFacet(facet);
  if (!f) return false;
  const allowed = FACET_ELIGIBILITY[f];
  if (allowed === null) return true;              /* open to any account */
  const held = new Set(Array.isArray(approvedRoles) ? approvedRoles : []);
  return allowed.some(r => held.has(r));
}

/** Does a decision on this facet have to carry an expiresAt? */
function expiryRequired(facet) {
  return FACET_EXPIRY[canonicalFacet(facet)] === 'required';
}

/**
 * The active facets of a canonical verifications/{uid} document.
 * A facet counts as currently verified iff it is approved AND not past expiry.
 * Returns a Set of facet slugs. Tolerates a missing/!malformed document.
 */
function activeFacets(verif, nowMs) {
  const out = new Set();
  const facets = (verif && verif.facets) || {};
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  for (const [facet, rec] of Object.entries(facets)) {
    if (!_FACET_SET.has(facet)) continue;         /* unknown slug never counts */
    if (!rec || rec.state !== 'approved') continue;
    const exp = rec.expiresAt;
    if (exp) {
      const ms = exp.toMillis ? exp.toMillis()
               : exp._seconds ? exp._seconds * 1000
               : new Date(exp).getTime();
      if (!isNaN(ms) && ms <= now) continue;      /* expired — not verified */
    }
    out.add(facet);
  }
  return out;
}

/** The single badge to show where only one fits. null when nothing is active. */
function primaryBadge(activeSet) {
  const s = activeSet instanceof Set ? activeSet : new Set(activeSet || []);
  return BADGE_PRECEDENCE.find(f => s.has(f)) || null;
}

module.exports = {
  FACETS,
  FACET_ELIGIBILITY,
  FACET_EXPIRY,
  FACET_STATES,
  BADGE_PRECEDENCE,
  isFacet,
  canonicalFacet,
  isEligible,
  expiryRequired,
  activeFacets,
  primaryBadge,
};
