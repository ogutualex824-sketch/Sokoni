'use strict';
/**
 * SOKONI Connect — the call-surface policy (Gate C3-A).
 * ============================================================================================
 * A PRODUCT policy, not an authority. It answers exactly one question:
 *
 *     does this business surface EXPOSE a Call action for this anchor?
 *
 * and never:
 *
 *     is this call authorized?
 *
 * ── WHY IT IS A SEPARATE FILE ──────────────────────────────────────────────────────────────
 * `connect-authority.js` is frozen and answers "may these two parties communicate". That is a
 * security question with a security answer. "Which screens carry a Call button" is a product
 * question, and folding it into the authority would make a UI decision into an authorization
 * one — after which relaxing a button becomes relaxing a permission.
 *
 * So this module is DELIBERATELY NARROWER than the authority and may be narrowed or widened
 * without touching it. `rider → seller` is the worked example: the authority permits it (a
 * rider may call the merchant about a delivery), and this policy does not surface it, because
 * the product has not decided that screen exists yet. Widening it later is a product change
 * that needs no security review; the authority already said yes.
 *
 * A VISIBLE BUTTON MEANS "this surface lets you REQUEST a call". It never means the call is
 * authorized. The server decides that, every time, and would refuse a request this module
 * happened to allow.
 *
 * ── LIFECYCLE IS NOT RESTATED HERE ─────────────────────────────────────────────────────────
 * There is no list of order or delivery statuses in this file. Connect already maps a business
 * lifecycle word onto one of the authority's relationship states, and this policy consumes
 * THAT:
 *
 *     business lifecycle  ->  relationship state  ->  surface eligibility  ->  authorization
 *
 * A second table of order statuses inside Connect is exactly the drift the platform has paid
 * for before, and it would silently disagree with the first the day someone adds a status.
 *
 * ── PURITY ─────────────────────────────────────────────────────────────────────────────────
 * No Firestore, no clock, no network, no require. Every input is an argument.
 */

/* The surfaces that carry a Call button, as decided by the product.
 *
 * Keyed `anchorType:callerRole:targetRole`. ORDER MATTERS here, unlike the authority's pairs:
 * a surface is a screen somebody is looking at, and "the seller's order page has a Call
 * button" is a different statement from "the buyer's does". */
const CALL_SURFACES = Object.freeze({
  order: Object.freeze(['buyer:seller', 'seller:buyer']),
  delivery: Object.freeze([
    'buyer:rider',
    'rider:buyer',
    'seller:rider',
    /* `rider:seller` is ABSENT and that is not an oversight — see the header. The authority
       permits it; no screen offers it yet. */
  ]),
  supply: Object.freeze(['seller:supplier']),
  support: Object.freeze(['buyer:admin', 'admin:buyer']),
  /* booking — ADDED 2026-09-27 (owner decision, Entertainment convergence: "MESSAGE · CALL where
     provisioned" from the booking conversation). A product widening only: the authority has always
     permitted voice on `booking`, so no security review changes (see the test's own note). */
  booking: Object.freeze(['buyer:provider', 'provider:buyer']),
  /* `inquiry` carries NO call surface.
     An enquiry is capped at chat by the authority itself, so a Call button there would be a
     button that is always refused — worse than a missing one, because it teaches people the
     product is broken. A PUBLIC enquiry's call starts only as a REQUEST the provider answers
     (ent-enquiries.js); its voice leg needs a Connect relationship the authority does not have. */
});

/* Only a live relationship carries a Call button. `closed` and `cancelled` keep their history
   and lose their telephone — the authority already refuses voice on both, so surfacing a
   button would again be a button that is always refused. `unknown` is refused for the reason
   it exists: an unrecognised lifecycle word must close a call button, never open one. */
const ELIGIBLE_RELATIONSHIP_STATES = Object.freeze(['active']);

/**
 * callSurfaceFor({ anchorType, callerRole, targetRole, relationshipState }) -> { show, reason }
 *
 * FAILS CLOSED on every unknown. `show: false` is never an error and never blocks anything —
 * it means the screen does not offer the action. The caller can still reach the callable
 * directly, and the server will still decide.
 */
function callSurfaceFor(input) {
  const i = input || {};
  const anchorType = String(i.anchorType || '');
  const callerRole = String(i.callerRole || '');
  const targetRole = String(i.targetRole || '');
  const state = String(i.relationshipState || '');

  if (!Object.hasOwn(CALL_SURFACES, anchorType)) {
    return _no('no_call_surface_for_anchor');
  }
  if (!callerRole || !targetRole) return _no('roles_required');
  if (callerRole === targetRole) return _no('self_call');
  if (!ELIGIBLE_RELATIONSHIP_STATES.includes(state)) {
    return _no('relationship_not_live');
  }
  if (!CALL_SURFACES[anchorType].includes(callerRole + ':' + targetRole)) {
    return _no('surface_not_offered');
  }
  return {
    show: true,
    reason: 'surface_offers_call',
    /* Said in the answer so a consumer cannot read `show:true` as permission. */
    authorizes: false,
  };
}

function _no(reason) { return { show: false, reason, authorizes: false }; }

/** Every surface this policy offers, as `anchorType:caller:target`. Used by the suite to prove
 *  the policy is a SUBSET of what the authority permits — a surface the authority would refuse
 *  is a button that is always refused. */
function allSurfaces() {
  const out = [];
  Object.keys(CALL_SURFACES).forEach((a) => {
    CALL_SURFACES[a].forEach((p) => out.push(a + ':' + p));
  });
  return out;
}

module.exports = {
  CALL_SURFACES,
  ELIGIBLE_RELATIONSHIP_STATES,
  callSurfaceFor,
  allSurfaces,
};
