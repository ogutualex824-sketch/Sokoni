'use strict';
/**
 * SOKONI — BUSINESS SCOPE (pure core)
 * functions/shared/business-scope.js
 *
 * Answers ONE question: may this account trade PRODUCTS, SERVICES, or BOTH?
 *
 * A cyber café sells airtime and prints documents. A salon sells hair product
 * and cuts hair. A garage sells parts and fits them. Treating "seller" and
 * "provider" as mutually exclusive forces those businesses to keep two
 * accounts, two catalogues and two sets of books — and SOKONI cannot then tell
 * the tax authority what one business earned.
 *
 * ── WHY A NEW MODULE AND NOT A CHANGE TO resolveRole ───────────────────────
 *
 * `application-lifecycle.js:194 resolveRole()` returns ONE role — `{role, by}`
 * — and every downstream reader expects a scalar. Widening it to a set would
 * ripple through the whole approval path, and that file is under a standing
 * deployment blocker (it calls `setCustomUserClaims` on a release-only path;
 * see docs — it must not be deployed unfixed). Changing blocked code to add a
 * feature is how a blocker becomes permanent.
 *
 * So nothing here touches role resolution. This READS the registries approval
 * already writes, and reports what it finds.
 *
 * ── DUAL BUSINESS IS ALREADY STORABLE. NOTHING READS IT. ───────────────────
 *
 * Approval writes `sellers/{uid}` for a seller and `providers/{uid}` for a
 * provider — two collections, both keyed by the SAME uid. An account holding
 * both documents is already a dual business in storage. The gap was never the
 * schema; it was that no code ever asked the combined question.
 *
 * ── WHAT IS DELIBERATELY NOT CONSULTED ─────────────────────────────────────
 *
 * `businessType`, `category`, `hub` and friends are LABELS. They are
 * self-claimable — anyone can write `businessType: 'provider'` on their own
 * record — so a scope derived from them would be a scope anyone could grant
 * themselves. Scope comes from the REGISTRY DOCUMENTS an admin approval wrote,
 * and from nothing else.
 *
 * Nor is a SUBSCRIPTION consulted. capability-authority.js states the rule
 * plainly: a capability says what a plan permits, never who someone is. Scope
 * is an identity question and is not purchasable.
 *
 * ── PURE ───────────────────────────────────────────────────────────────────
 *
 * No Firestore, no clock, no network. The caller loads the two documents and
 * passes them in.
 */

/** The two things a SOKONI business can be authorized to trade. */
const SCOPE = Object.freeze({
  PRODUCTS: 'products',
  SERVICES: 'services',
});

/* A registry document authorizes trade only in these states. Anything else —
   suspended, pending, rejected, absent, or a status this module has never
   heard of — does NOT. Unknown is not active: a status we cannot interpret is
   exactly when to refuse, not when to assume goodwill. */
const LIVE_STATUSES = Object.freeze(['active', 'approved']);

function _isLive(doc) {
  if (!doc || typeof doc !== 'object') return false;
  /* An explicit deactivation beats a stale status string. `sellers` carries
     `active:false` on suspension in some paths and a status change in others,
     and a record that says both must be read the strict way. */
  if (doc.active === false) return false;
  if (doc.suspended === true) return false;
  const status = String(doc.status == null ? '' : doc.status).trim().toLowerCase();
  /* A registry doc with NO status at all predates the status field. Those are
     live — they were written by approval, which is the authority this module
     trusts — but only when nothing else contradicts it, which the two checks
     above have already established. */
  if (!status) return true;
  return LIVE_STATUSES.includes(status);
}

/**
 * Resolve what an account may trade.
 *
 * @param {object}  o
 * @param {object} [o.seller]    the `sellers/{uid}` document, or null
 * @param {object} [o.provider]  the `providers/{uid}` document, or null
 * @returns {{
 *   scopes: string[], sellsProducts: boolean, providesServices: boolean,
 *   isDual: boolean, isTrading: boolean, reasons: object
 * }}
 */
function resolveBusinessScope({ seller, provider } = {}) {
  const sellerLive   = _isLive(seller);
  const providerLive = _isLive(provider);

  const scopes = [];
  if (sellerLive)   scopes.push(SCOPE.PRODUCTS);
  if (providerLive) scopes.push(SCOPE.SERVICES);

  return {
    scopes,
    sellsProducts:    sellerLive,
    providesServices: providerLive,
    isDual:           sellerLive && providerLive,
    isTrading:        scopes.length > 0,
    /* WHY, not just WHAT. A merchant asking "why can't I add a service?"
       deserves an answer, and support cannot give one from a boolean. The
       distinction between "you never applied" and "your approval was
       suspended" is the entire content of that conversation. */
    reasons: {
      products: _reason(seller, sellerLive),
      services: _reason(provider, providerLive),
    },
  };
}

function _reason(doc, live) {
  if (live) return 'approved';
  if (!doc) return 'not_applied';
  if (doc.active === false || doc.suspended === true) return 'suspended';
  const status = String(doc.status == null ? '' : doc.status).trim().toLowerCase();
  if (!status) return 'suspended';
  if (status === 'pending' || status === 'submitted') return 'pending_review';
  if (status === 'rejected' || status === 'declined') return 'rejected';
  if (status === 'suspended') return 'suspended';
  /* A status this module does not recognise is reported AS ITSELF rather than
     bucketed into a familiar one. Mislabelling an unknown state as "suspended"
     would send support down the wrong path and hide an intake vocabulary that
     has drifted. */
  return 'unknown_status:' + status.slice(0, 32);
}

/**
 * May this account reach the unified merchant workspace (merchant-v2)?
 *
 * Any live scope qualifies — a services-only business needs the workspace just
 * as much as a shop. This is a SCOPE question and is not, by itself, an access
 * decision: the caller must still pass the account through the existing
 * merchant guard. Two guards already claim to be canonical
 * (merchant-authority.js and business-bootstrap._assertMerchantAccess) and a
 * third would be worse than either, so this deliberately answers "what may
 * they trade", never "is this request allowed".
 */
function canUseMerchantWorkspace(scope) {
  return !!(scope && scope.isTrading);
}

/**
 * Which catalogue kinds a till or workspace should offer.
 *
 * A products-only business must not be shown a service catalogue it cannot
 * legally bill for, and a services-only business must not be shown stock
 * management it has no use for. A dual business gets both, in one workspace,
 * on one set of books.
 */
function catalogueKindsFor(scope) {
  const kinds = [];
  if (scope && scope.sellsProducts)    kinds.push('product');
  if (scope && scope.providesServices) kinds.push('service');
  return kinds;
}

/**
 * Is this specific trade permitted?
 *
 * Used before a catalogue write or a till line, so a services-only business
 * cannot quietly start selling stock by posting a product row.
 */
function mayTrade(scope, kind) {
  if (kind === 'product') return !!(scope && scope.sellsProducts);
  if (kind === 'service') return !!(scope && scope.providesServices);
  return false;    /* an unrecognised kind is never permitted */
}

module.exports = {
  SCOPE, LIVE_STATUSES,
  resolveBusinessScope,
  canUseMerchantWorkspace,
  catalogueKindsFor,
  mayTrade,
};
